import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNativeComposeOwned,
  mergeNativeComposeNetworkPolicies,
  NativeComposeOwnershipError,
  type NativeComposeOwnershipOptions,
  type NativeComposeOwnershipRefusal,
  nativeComposeOwnershipRefusal,
  observeNativeComposeStartupOwned,
  observeSavedNativeComposeOwned,
} from "../src/lib/native-compose-ownership.ts";
import { restoreEnv } from "./helpers/env.ts";

const PROJECT = "hack-fixture-instance";
const OWNER = "0".repeat(32);
const GENERATION = "a".repeat(32);
const PENDING = "b".repeat(32);
const ID = "c".repeat(64);
const NETWORK_ID = "d".repeat(64);
const VOLUME = "hack-21-hack-fixture-instance-4-data";
const CREATED = "2026-10-08T00:00:00.123456789Z";
const REBORN = "2026-10-08T00:00:01.123456789Z";
const CANARY = "synthetic-private-env-image-canary";
const options: NativeComposeOwnershipOptions = {
  composeProject: PROJECT,
  runtimeIdentity: PROJECT,
  ownerToken: OWNER,
  generationIds: [GENERATION, PENDING],
  expectedServices: ["web", "install"],
  expectedVolumes: [{ name: VOLUME, storage: "data" }],
  expectedNetwork: `${PROJECT}_default`,
};
type Fixture = {
  container?: Record<string, unknown>[];
  volume?: Record<string, unknown>[];
  network?: Record<string, unknown>[];
  mode?: string;
};
let root: string;
let path: string | undefined;
beforeEach(async () => {
  path = process.env.PATH;
  root = await mkdtemp(join(tmpdir(), "native-compose-ownership-"));
  process.env.PATH = root;
  await Bun.write(
    join(root, "docker"),
    `#!${process.execPath}
import {appendFileSync, existsSync, readFileSync, writeFileSync} from "node:fs";
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
appendFileSync(root + "/commands", JSON.stringify(args) + "\\n");
const fixture = JSON.parse(readFileSync(root + "/fixture.json", "utf8"));
const [kind, action] = args;
if (!["container","volume","network"].includes(kind) || !["ls","inspect"].includes(action) || !args.includes("--format")) {
 writeFileSync(root + "/mutated", "unexpected engine mutation"); process.exit(99);
}
if (fixture.mode === "hang") { writeFileSync(root + "/started", String(process.pid)); await Bun.sleep(60_000); }
if (fixture.mode === "descendant") {
 const child = Bun.spawn([process.execPath, "-e", 'await Bun.sleep(60_000)'], {stdout: "inherit", stderr: "inherit"});
 writeFileSync(root + "/descendant", String(child.pid)); process.exit(0);
}
if (fixture.mode === "fail") { console.error(${JSON.stringify(CANARY)}); process.exit(23); }
if (fixture.mode === "stderr-overflow") { await Bun.write(Bun.stderr, "x".repeat(17 * 1024)); process.exit(0); }
if (fixture.mode === "overflow") { await Bun.write(Bun.stdout, "x".repeat(9 * 1024 * 1024)); process.exit(0); }
if (fixture.mode === "malformed") { console.log(${JSON.stringify(CANARY)}); process.exit(0); }
if (action === "ls") {
 if (fixture.mode === "cumulative") { const name = "x".repeat(1536 * 1024); await Bun.write(Bun.stdout, JSON.stringify({id: kind === "volume" ? name : "f".repeat(64), name, project: "foreign"}) + "\\n"); process.exit(0); }
 let count = 0; const counter = root + "/lists-" + kind;
 if (existsSync(counter)) count = Number(readFileSync(counter, "utf8"));
 writeFileSync(counter, String(count + 1));
 const rows = (fixture[kind] ?? []).map(row => ({id: row.id, name: kind === "container" ? row.name.replace(/^\\//, "") : row.name, project: row.project ?? ""}));
 if (fixture.mode === "inventory-change" && kind === "container" && count > 0) rows.push({id: "e".repeat(64), name: ${JSON.stringify(`${PROJECT}-web-1`)}, project: "foreign"});
 for (const row of rows) console.log(JSON.stringify(row));
} else {
 const selected = args.slice(args.indexOf("--format") + 2);
 const rows = fixture[kind] ?? [];
 if (fixture.mode === "vanished") process.exit(1);
 const counter = root + "/inspects-" + kind;
 const count = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
 writeFileSync(counter, String(count + 1));
 if (fixture.mode === "endpoint-drift" && kind === "container" && count > 0) {
   rows[0].networks[Object.keys(rows[0].networks)[0]].NetworkID = "f".repeat(64);
 }
 if (fixture.mode === "restart-member-transition" && kind === "container" && count > 0) {
   rows[0].state = "running";
 }
 if (fixture.mode === "restart-member-transition" && kind === "network" && count > 0) {
   rows[0].containers[${JSON.stringify(ID)}] = {};
 }
 const order = fixture.mode === "volume-order" && kind === "volume" && count > 0 ? [...selected].reverse() : selected;
 for (const id of order) { const row = rows.find(row => row.id === id); if (!row) process.exit(1); console.log(JSON.stringify(row)); }
 if (fixture.mode === "volume-rebirth" && kind === "volume" && count === 0) {
   fixture.volume[0].createdAt = ${JSON.stringify(REBORN)};
   writeFileSync(root + "/fixture.json", JSON.stringify(fixture));
 }
}
`
  );
  await chmod(join(root, "docker"), 0o700);
});
afterEach(async () => {
  restoreEnv("PATH", path);
  await rm(root, { recursive: true, force: true });
});
function owned(): Fixture {
  return {
    container: [
      {
        id: ID,
        name: `/${PROJECT}-web-1`,
        project: PROJECT,
        version: "1",
        instance: PROJECT,
        owner: OWNER,
        generation: GENERATION,
        service: "web",
        oneoff: "False",
        state: "running",
        exitCode: 0,
        health: "healthy",
        networks: {
          [`${PROJECT}_default`]: {
            NetworkID: NETWORK_ID,
            Aliases: [`${PROJECT}-web-1`, "web"],
          },
        },
      },
    ],
    volume: [
      {
        id: VOLUME,
        name: VOLUME,
        project: PROJECT,
        version: "1",
        instance: PROJECT,
        owner: OWNER,
        storage: "data",
        createdAt: CREATED,
      },
    ],
    network: [
      {
        id: NETWORK_ID,
        name: `${PROJECT}_default`,
        project: PROJECT,
        version: "1",
        instance: PROJECT,
        owner: OWNER,
        driver: "bridge",
        internal: false,
        containers: { [ID]: { Name: `${PROJECT}-web-1` } },
      },
    ],
  };
}
async function prepare(value: Fixture): Promise<void> {
  await Promise.all(
    ["container", "volume", "network"].flatMap((kind) =>
      ["lists", "inspects"].map((query) =>
        rm(join(root, `${query}-${kind}`), { force: true })
      )
    )
  );
  await Bun.write(join(root, "fixture.json"), JSON.stringify(value));
}
async function commands(): Promise<string[][]> {
  return (await readFile(join(root, "commands"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
async function expectRefusal(
  opts = options,
  code = "E_NATIVE_COMPOSE_OWNERSHIP",
  reason?: NativeComposeOwnershipRefusal
) {
  try {
    await assertNativeComposeOwned(opts);
    throw new Error("unexpected probe success");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(NativeComposeOwnershipError);
    expect(error).toMatchObject({ code });
    if (reason !== undefined) {
      expect(nativeComposeOwnershipRefusal(error)).toBe(reason);
    }
    expect(String(error)).not.toContain(CANARY);
    expect(JSON.stringify(error)).not.toContain(CANARY);
  }
  expect(await Bun.file(join(root, "mutated")).exists()).toBe(false);
}

test("ownership refusal diagnostics cannot be forged, copied or obtained through getters", () => {
  let issued: unknown;
  try {
    mergeNativeComposeNetworkPolicies({
      proposed: [],
      retained: [
        [{ name: "fixture_default", driver: "bridge", internal: false }],
      ],
    });
  } catch (error: unknown) {
    issued = error;
  }
  expect(issued).toBeInstanceOf(NativeComposeOwnershipError);
  if (!(issued instanceof NativeComposeOwnershipError)) {
    throw new Error("Missing owner-issued refusal");
  }
  expect(nativeComposeOwnershipRefusal(issued)).toBe("bridge-policy");
  expect(issued).toMatchObject({ code: "E_NATIVE_COMPOSE_NETWORK_TRANSITION" });
  expect(String(issued)).toBe(
    "NativeComposeOwnershipError: Native Compose network topology changed. Run hack down for this instance before applying the change; values omitted."
  );
  expect(JSON.parse(JSON.stringify(issued))).toEqual({
    code: "E_NATIVE_COMPOSE_NETWORK_TRANSITION",
    name: "NativeComposeOwnershipError",
  });
  const clone = { ...issued, reason: "bridge-policy", secret: CANARY };
  let getters = 0;
  const accessor = Object.defineProperty({}, "reason", {
    get() {
      getters += 1;
      throw new Error(CANARY);
    },
  });
  const proxy = new Proxy(
    {},
    {
      get() {
        getters += 1;
        throw new Error(CANARY);
      },
    }
  );
  for (const candidate of [
    new NativeComposeOwnershipError("E_NATIVE_COMPOSE_OWNERSHIP"),
    clone,
    Object.create(issued),
    accessor,
    proxy,
    null,
    undefined,
    CANARY,
    1,
  ]) {
    expect(nativeComposeOwnershipRefusal(candidate)).toBeUndefined();
  }
  expect(getters).toBe(0);
});

test("selected on-failure restart is unready until two stable owned scans", async () => {
  const fixture = owned();
  const container = fixture.container?.[0];
  const network = fixture.network?.[0];
  if (!(container && network)) {
    throw new Error("Missing owned retry fixture");
  }
  container.state = "restarting";
  network.containers = {};
  await prepare(fixture);
  expect(await observeNativeComposeStartupOwned(options, ["web"])).toBeNull();
  // The same observation must never authorize effect or finalization ownership.
  await expectRefusal(options, "E_NATIVE_COMPOSE_OWNERSHIP", "topology");
  fixture.mode = "restart-member-transition";
  await prepare(fixture);
  await expectRefusal(options);
  await prepare(fixture);
  expect(await observeNativeComposeStartupOwned(options, ["web"])).toBeNull();
  expect(
    (await observeNativeComposeStartupOwned(options, ["web"]))?.containers[0]
  ).toMatchObject({ id: ID, state: "running" });
  expect((await assertNativeComposeOwned(options)).containers[0]).toMatchObject(
    {
      id: ID,
      state: "running",
    }
  );
  expect(await Bun.file(join(root, "mutated")).exists()).toBe(false);
});

test("restart observation keeps foreign and incomplete endpoint shapes fenced", async () => {
  for (const change of [
    "wrong-service",
    "running",
    "wrong-id",
    "empty-id",
    "alias-drift",
    "empty-aliases",
    "foreign-owner",
    "foreign-generation",
    "foreign-member",
    "extra-attachment",
    "ingress",
  ]) {
    const fixture = owned();
    const container = fixture.container?.[0];
    const network = fixture.network?.[0];
    if (!(container && network)) {
      throw new Error("Missing owned retry fixture");
    }
    container.state = change === "running" ? "running" : "restarting";
    network.containers =
      change === "foreign-member" ? { ["f".repeat(64)]: {} } : {};
    let selection = options;
    if (change === "wrong-id" || change === "empty-id") {
      container.networks = {
        [`${PROJECT}_default`]: {
          NetworkID: change === "wrong-id" ? "f".repeat(64) : "",
          Aliases: [`${PROJECT}-web-1`, "web"],
        },
      };
    } else if (change === "alias-drift" || change === "empty-aliases") {
      container.networks = {
        [`${PROJECT}_default`]: {
          NetworkID: NETWORK_ID,
          Aliases:
            change === "alias-drift" ? [`${PROJECT}-web-1`, "foreign"] : [],
        },
      };
    } else if (change === "extra-attachment") {
      (container.networks as Record<string, unknown>).foreign = {
        NetworkID: "f".repeat(64),
        Aliases: ["foreign"],
      };
    } else if (change === "foreign-owner") {
      network.owner = "f".repeat(32);
    } else if (change === "foreign-generation") {
      container.generation = "f".repeat(32);
    } else if (change === "ingress") {
      (container.networks as Record<string, unknown>)["hack-dev"] = {
        NetworkID: "e".repeat(64),
        Aliases: [`${PROJECT}-web-1`, "web"],
      };
      selection = {
        ...options,
        expectedWorkloadNetworks: [
          {
            generationId: GENERATION,
            service: "web",
            networks: [
              { name: `${PROJECT}_default`, aliases: [] },
              { name: "hack-dev", aliases: [], externalId: "e".repeat(64) },
            ],
          },
        ],
      };
    }
    await prepare(fixture);
    await expect(
      observeNativeComposeStartupOwned(
        selection,
        change === "wrong-service" ? ["install"] : ["web"]
      )
    ).rejects.toBeInstanceOf(NativeComposeOwnershipError);
  }
  expect(await Bun.file(join(root, "mutated")).exists()).toBe(false);
});
test("owned resources yield only bounded readiness observations and exact read-only queries", async () => {
  await prepare(owned());
  expect(await assertNativeComposeOwned(options)).toEqual({
    containers: [
      {
        id: ID,
        name: `${PROJECT}-web-1`,
        generationId: GENERATION,
        service: "web",
        state: "running",
        exitCode: 0,
        health: "healthy",
        oneoff: false,
      },
    ],
    volumes: [{ name: VOLUME, storage: "data", createdAt: CREATED }],
    networks: [{ id: NETWORK_ID, name: `${PROJECT}_default` }],
  });
  for (const args of await commands()) {
    expect(["ls", "inspect"]).toContain(args[1] ?? "");
    expect(args).toContain("--format");
    const format = args[args.indexOf("--format") + 1] ?? "";
    expect(format).not.toContain(".Config.Env");
    expect(format).not.toContain(".Config.Image");
    expect(format).not.toContain("{{json .}}");
    if (args[1] === "inspect" && args[0] !== "volume") {
      expect(args.at(-1)).toMatch(/^[a-f0-9]{64}$/);
    }
  }
  expect(await Bun.file(join(root, "mutated")).exists()).toBe(false);
});
test("empty fresh inventory passes and unrelated foreign resources are not inspected", async () => {
  await prepare({
    container: [{ id: ID, name: "/other-web-1", project: "other" }],
  });
  expect(await assertNativeComposeOwned(options)).toEqual({
    containers: [],
    volumes: [],
    networks: [],
  });
  expect((await commands()).every((args) => args[1] === "ls")).toBe(true);
});
test("fully completed real queries never signal an exited process group", async () => {
  await prepare(owned());
  const signals = spyOn(process, "kill").mockImplementation(() => true);
  try {
    expect((await assertNativeComposeOwned(options)).containers).toHaveLength(
      1
    );
    expect(await commands()).toHaveLength(12);
    expect(signals).not.toHaveBeenCalled();
  } finally {
    signals.mockRestore();
  }
});
test("oneoffs and successful jobs use receipt-selected generations and explicit state", async () => {
  const fixture = owned();
  fixture.container = [
    {
      id: ID,
      name: `/${PROJECT}-install-run-random`,
      project: PROJECT,
      version: "1",
      instance: PROJECT,
      owner: OWNER,
      generation: PENDING,
      service: "install",
      oneoff: "True",
      state: "exited",
      exitCode: 0,
      health: null,
      networks: {
        [`${PROJECT}_default`]: {
          NetworkID: NETWORK_ID,
          Aliases: [`${PROJECT}-install-run-random`],
        },
      },
    },
  ];
  await prepare(fixture);
  expect((await assertNativeComposeOwned(options)).containers).toEqual([
    {
      id: ID,
      name: `${PROJECT}-install-run-random`,
      generationId: PENDING,
      service: "install",
      state: "exited",
      exitCode: 0,
      health: null,
      oneoff: true,
    },
  ]);
});
test("mixed receipt-selected generations remain distinct in sanitized observations", async () => {
  const fixture = owned();
  const [current] = fixture.container ?? [];
  if (!current) {
    throw new Error("Missing fixture resource");
  }
  const pendingId = "e".repeat(64);
  fixture.container = [
    current,
    {
      ...current,
      id: pendingId,
      name: `/${PROJECT}-web-run-pending`,
      generation: PENDING,
      oneoff: "True",
      state: "exited",
      health: null,
      networks: {
        [`${PROJECT}_default`]: {
          NetworkID: NETWORK_ID,
          Aliases: [`${PROJECT}-web-run-pending`],
        },
      },
    },
  ];
  await prepare(fixture);
  const { containers } = await assertNativeComposeOwned(options);
  expect(containers).toMatchObject([
    {
      id: ID,
      name: `${PROJECT}-web-1`,
      generationId: GENERATION,
      service: "web",
      oneoff: false,
    },
    {
      id: pendingId,
      name: `${PROJECT}-web-run-pending`,
      generationId: PENDING,
      service: "web",
      oneoff: true,
    },
  ]);
});
test("same-name foreign containers, volumes and networks refuse even without a project label", async () => {
  for (const kind of ["container", "volume", "network"] as const) {
    const fixture = owned();
    const [row] = fixture[kind] ?? [];
    if (!row) {
      throw new Error("Missing fixture resource");
    }
    row.project = null;
    row.instance = "foreign";
    await prepare(fixture);
    await expectRefusal();
  }
});
test("old or missing owner tokens never adopt same-instance resources", async () => {
  for (const kind of ["container", "volume", "network"] as const) {
    for (const owner of ["f".repeat(32), null]) {
      const fixture = owned();
      const [row] = fixture[kind] ?? [];
      if (!row) {
        throw new Error("Missing fixture resource");
      }
      row.owner = owner;
      await prepare(fixture);
      await expectRefusal(
        options,
        "E_NATIVE_COMPOSE_OWNERSHIP",
        "resource-label"
      );
    }
  }
});
test("unsolicited raw inspect fields are rejected without disclosing private values", async () => {
  const fixture = owned();
  const [row] = fixture.container ?? [];
  if (!row) {
    throw new Error("Missing fixture resource");
  }
  row.Config = { Env: [CANARY], Image: CANARY };
  await prepare(fixture);
  await expectRefusal(options, "E_NATIVE_COMPOSE_OWNERSHIP", "unknown");
});
test("every project container is checked, including unknown services and stale or absent generation", async () => {
  for (const fields of [
    { generation: "f".repeat(32) },
    { generation: null },
    { service: "unknown" },
    { version: null },
    { instance: "foreign" },
    { oneoff: null },
    { state: CANARY },
    { health: CANARY },
    { exitCode: -1 },
  ]) {
    const fixture = owned();
    fixture.container = [
      {
        id: ID,
        name: "/otherwise-unexpected-name",
        project: PROJECT,
        version: "1",
        instance: PROJECT,
        owner: OWNER,
        generation: GENERATION,
        service: "web",
        oneoff: "False",
        state: "running",
        exitCode: 0,
        health: null,
        networks: {
          [`${PROJECT}_default`]: {
            NetworkID: NETWORK_ID,
            Aliases: ["otherwise-unexpected-name", "web"],
          },
        },
        ...fields,
      },
    ];
    await prepare(fixture);
    const reason =
      "generation" in fields
        ? "generation"
        : "state" in fields || "health" in fields || "exitCode" in fields
          ? "state"
          : "resource-label";
    await expectRefusal(options, "E_NATIVE_COMPOSE_OWNERSHIP", reason);
  }
});
test("persistent storage must match exact generated name and logical storage ownership", async () => {
  const fixture = owned();
  fixture.volume = [
    {
      id: VOLUME,
      name: VOLUME,
      project: PROJECT,
      version: "1",
      instance: PROJECT,
      owner: OWNER,
      storage: "wrong",
      createdAt: CREATED,
    },
  ];
  await prepare(fixture);
  await expectRefusal();
  await prepare(owned());
  await expectRefusal({ ...options, expectedVolumes: [] });
  await expectRefusal({ ...options, expectedNetwork: "another-default" });
});
test("retained volume policy requires exact presence and birth while cold inventory stays admissible", async () => {
  const retained: NativeComposeOwnershipOptions = {
    ...options,
    expectedVolumes: [
      { name: VOLUME, storage: "data", mustExist: true, createdAt: CREATED },
    ],
  };
  await prepare(owned());
  expect((await assertNativeComposeOwned(retained)).volumes).toEqual([
    { name: VOLUME, storage: "data", createdAt: CREATED },
  ]);
  await prepare({});
  await expectRefusal(retained, "E_NATIVE_COMPOSE_OWNERSHIP", "volume-birth");
  // Legacy history can require presence without inventing a prior birth.
  await expectRefusal({
    ...options,
    expectedVolumes: [{ name: VOLUME, storage: "data", mustExist: true }],
  });
  expect((await assertNativeComposeOwned(options)).volumes).toEqual([]);
  const replaced = owned();
  const volume = replaced.volume?.[0];
  if (!volume) {
    throw new Error("Missing volume fixture");
  }
  volume.createdAt = REBORN;
  await prepare(replaced);
  await expectRefusal(retained, "E_NATIVE_COMPOSE_OWNERSHIP", "volume-birth");
});
test.each([
  null,
  "",
  "0",
  CANARY,
  "2026-10-08 00:00:00",
])("volume creation facts refuse malformed %j without exposing values", async (createdAt) => {
  const fixture = owned();
  const volume = fixture.volume?.[0];
  if (!volume) {
    throw new Error("Missing volume fixture");
  }
  volume.createdAt = createdAt;
  await prepare(fixture);
  await expectRefusal();
});
test("a same-name same-label volume replacement between inspections refuses before effect authority", async () => {
  await prepare({ ...owned(), mode: "volume-rebirth" });
  await expectRefusal({
    ...options,
    expectedVolumes: [
      { name: VOLUME, storage: "data", mustExist: true, createdAt: CREATED },
    ],
  });
});
test("stable volume births tolerate reordered complete inspect rows", async () => {
  const fixture = owned();
  const volume = fixture.volume?.[0];
  if (!volume) {
    throw new Error("Missing volume fixture");
  }
  fixture.volume = [
    volume,
    {
      ...volume,
      id: `${VOLUME}-archive`,
      name: `${VOLUME}-archive`,
      storage: "archive",
    },
  ];
  fixture.mode = "volume-order";
  await prepare(fixture);
  const result = await assertNativeComposeOwned({
    ...options,
    expectedVolumes: [
      { name: VOLUME, storage: "data", createdAt: CREATED },
      { name: `${VOLUME}-archive`, storage: "archive", createdAt: CREATED },
    ],
  });
  expect(
    [...result.volumes].sort((left, right) =>
      left.name.localeCompare(right.name)
    )
  ).toEqual([
    { name: VOLUME, storage: "data", createdAt: CREATED },
    { name: `${VOLUME}-archive`, storage: "archive", createdAt: CREATED },
  ]);
});
test("vanished resources and changed selected inventory refuse without retry or mutation", async () => {
  for (const mode of ["vanished", "inventory-change"]) {
    await prepare({ ...owned(), mode });
    await expectRefusal(
      options,
      mode === "vanished"
        ? "E_NATIVE_COMPOSE_PROBE"
        : "E_NATIVE_COMPOSE_OWNERSHIP",
      mode === "vanished" ? undefined : "cross-scan-drift"
    );
  }
});
test("daemon failures and malformed replies are fixed and redacted", async () => {
  for (const mode of ["fail", "malformed"]) {
    await prepare({ mode });
    await expectRefusal(options, "E_NATIVE_COMPOSE_PROBE");
  }
});
test("stream budgets are enforced while the child writes stdout or stderr", async () => {
  for (const mode of ["overflow", "stderr-overflow", "cumulative"]) {
    await prepare({ mode });
    await expectRefusal(options, "E_NATIVE_COMPOSE_PROBE_BUDGET");
  }
});
test("inspect argv batching does not cap the number of owned resources", async () => {
  const container = Array.from({ length: 300 }, (_, index) => ({
    id: index.toString(16).padStart(64, "0"),
    name: `/${PROJECT}-web-run-${index}`,
    project: PROJECT,
    version: "1",
    instance: PROJECT,
    owner: OWNER,
    generation: GENERATION,
    service: "web",
    oneoff: "True",
    state: "exited",
    exitCode: 0,
    health: null,
    networks: {
      [`${PROJECT}_default`]: {
        NetworkID: NETWORK_ID,
        Aliases: [`${PROJECT}-web-run-${index}`],
      },
    },
  }));
  const fixture = owned();
  fixture.container = container;
  const [network] = fixture.network ?? [];
  if (!network) {
    throw new Error("Missing owned network fixture");
  }
  network.containers = {};
  await prepare(fixture);
  expect((await assertNativeComposeOwned(options)).containers).toHaveLength(
    300
  );
  const inspected = (await commands()).filter((args) => args[1] === "inspect");
  expect(inspected.filter((args) => args[0] === "container")).toHaveLength(4);
  for (const args of inspected) {
    const ids = args.slice(args.indexOf("--format") + 2);
    expect(
      ids.reduce((size, id) => size + Buffer.byteLength(id) + 1, 0)
    ).toBeLessThanOrEqual(16 * 1024);
  }
});
test("a real hanging process times out and its inherited-pipe descendant is killed", async () => {
  for (const mode of ["hang", "descendant"]) {
    await prepare({ mode });
    await expectRefusal(
      { ...options, timeoutMs: 500 },
      "E_NATIVE_COMPOSE_PROBE_TIMEOUT"
    );
    const pid = Number(
      await readFile(
        join(root, mode === "hang" ? "started" : "descendant"),
        "utf8"
      )
    );
    await Bun.sleep(50);
    expect(() => process.kill(pid, 0)).toThrow();
  }
});
test("abort before spawn and during a real read-only query refuses and reaps the child", async () => {
  await prepare({ mode: "hang" });
  await expectRefusal(
    { ...options, signal: AbortSignal.abort() },
    "E_NATIVE_COMPOSE_PROBE_CANCELLED"
  );
  expect(await Bun.file(join(root, "commands")).exists()).toBe(false);
  const controller = new AbortController();
  const attempt = assertNativeComposeOwned({
    ...options,
    signal: controller.signal,
  });
  const deadline = Date.now() + 2000;
  while (
    !(await Bun.file(join(root, "started")).exists()) &&
    Date.now() < deadline
  ) {
    await Bun.sleep(5);
  }
  controller.abort();
  expect(await Bun.file(join(root, "started")).exists()).toBe(true);
  try {
    await attempt;
    throw new Error("unexpected probe success");
  } catch (error: unknown) {
    expect(error).toMatchObject({ code: "E_NATIVE_COMPOSE_PROBE_CANCELLED" });
  }
  const pid = Number(await readFile(join(root, "started"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});
test("invalid or conflicting selection refuses before Docker discovery/spawn", async () => {
  for (const invalid of [
    { composeProject: "--malicious" },
    { generationIds: [CANARY] },
    { expectedServices: ["web", "web"] },
    {
      expectedVolumes: [
        { name: VOLUME, storage: "data" },
        { name: VOLUME, storage: "other" },
      ],
    },
  ]) {
    await expectRefusal({ ...options, ...invalid });
  }
  expect(await Bun.file(join(root, "commands")).exists()).toBe(false);
});

const CUSTOM = `hack-net-${PROJECT.length}-${PROJECT}-4-data`;
function customOwned() {
  const fixture = owned();
  const container = fixture.container?.[0];
  const network = fixture.network?.[0];
  if (!(container && network)) {
    throw new Error("Missing owned fixture");
  }
  container.networks = {
    [CUSTOM]: {
      NetworkID: NETWORK_ID,
      Aliases: [`${PROJECT}-web-1`, "web", "db-query"],
    },
  };
  network.name = CUSTOM;
  network.internal = true;
  const { expectedNetwork: _legacy, ...base } = options;
  const selection: NativeComposeOwnershipOptions = {
    ...base,
    expectedNetworks: [{ name: CUSTOM, driver: "bridge", internal: true }],
    expectedWorkloadNetworks: [
      {
        generationId: GENERATION,
        service: "web",
        networks: [{ name: CUSTOM, aliases: ["db-query"] }],
      },
    ],
  };
  return { fixture, selection, container, network };
}

test("custom-only bridge topology validates exact policy, generation and aliases without adding default", async () => {
  const { fixture, selection } = customOwned();
  await prepare(fixture);
  const observed = await assertNativeComposeOwned(selection);
  expect(observed.networks).toEqual([{ id: NETWORK_ID, name: CUSTOM }]);
  expect(observed.containers[0]).toMatchObject({
    generationId: GENERATION,
    service: "web",
    state: "running",
    health: "healthy",
  });
  expect(JSON.stringify(observed)).not.toContain("db-query");
  expect(await Bun.file(join(root, "mutated")).exists()).toBe(false);
});

test("custom bridge driver, internal flag, aliases, generation and unexpected endpoint drift refuse", async () => {
  for (const change of [
    "driver",
    "internal",
    "alias",
    "generation",
    "extra",
    "missing",
    "reverse-missing",
    "foreign-member",
    "endpoint-drift",
  ]) {
    const { fixture, selection, container, network } = customOwned();
    if (change === "driver") {
      network.driver = "host";
    }
    if (change === "internal") {
      network.internal = false;
    }
    if (change === "alias") {
      container.networks = {
        [CUSTOM]: {
          NetworkID: NETWORK_ID,
          Aliases: [`${PROJECT}-web-1`, "web", "unrequested"],
        },
      };
    }
    if (change === "generation") {
      container.generation = PENDING;
    }
    if (change === "extra") {
      container.networks = {
        [CUSTOM]: {
          NetworkID: NETWORK_ID,
          Aliases: [`${PROJECT}-web-1`, "web", "db-query"],
        },
        foreign: { NetworkID: "f".repeat(64), Aliases: ["web"] },
      };
    }
    if (change === "missing") {
      container.networks = {};
    }
    if (change === "reverse-missing") {
      network.containers = {};
    }
    if (change === "foreign-member") {
      network.containers = { [ID]: {}, ["f".repeat(64)]: {} };
    }
    if (change === "endpoint-drift") {
      fixture.mode = change;
    }
    await prepare(fixture);
    const reason =
      change === "driver" || change === "internal"
        ? "bridge-policy"
        : change === "alias" || change === "endpoint-drift"
          ? "endpoint"
          : "topology";
    await expectRefusal(selection, "E_NATIVE_COMPOSE_OWNERSHIP", reason);
    expect(await Bun.file(join(root, "mutated")).exists()).toBe(false);
  }
});

test("unexpected same-project bridges and foreign expected custom names are not silently reused", async () => {
  const { fixture, selection, network } = customOwned();
  fixture.network?.push({
    ...network,
    id: "e".repeat(64),
    name: `${PROJECT}-extra`,
  });
  await prepare(fixture);
  await expectRefusal(selection);
  fixture.network?.pop();
  network.project = "foreign";
  await prepare(fixture);
  await expectRefusal(selection);
});

test("separately pinned ingress must match exact endpoint ID and receives no missing-network recovery waiver", async () => {
  const { fixture, selection, container } = customOwned();
  const ingressId = "e".repeat(64);
  const endpoints = {
    [CUSTOM]: {
      NetworkID: NETWORK_ID,
      Aliases: [`${PROJECT}-web-1`, "web", "db-query"],
    },
    "hack-dev": { NetworkID: ingressId, Aliases: [`${PROJECT}-web-1`, "web"] },
  };
  container.networks = endpoints;
  const routed: NativeComposeOwnershipOptions = {
    ...selection,
    expectedWorkloadNetworks: [
      {
        generationId: GENERATION,
        service: "web",
        networks: [
          { name: CUSTOM, aliases: ["db-query"] },
          { name: "hack-dev", aliases: [], externalId: ingressId },
        ],
      },
    ],
  };
  await prepare(fixture);
  expect((await assertNativeComposeOwned(routed)).containers).toHaveLength(1);
  endpoints["hack-dev"].NetworkID = "f".repeat(64);
  await prepare(fixture);
  await expectRefusal(routed);
  container.state = "exited";
  container.networks = {
    [CUSTOM]: { NetworkID: "", Aliases: null },
    "hack-dev": { NetworkID: "", Aliases: null },
  };
  fixture.network = [];
  await prepare(fixture);
  await expectRefusal({ ...routed, recovery: "down" });
});

test("explicit down recovery can inspect stopped known containers after their owned bridge is absent", async () => {
  const { fixture, selection, container } = customOwned();
  container.state = "exited";
  container.networks = { [CUSTOM]: { NetworkID: "", Aliases: null } };
  fixture.network = [];
  await prepare(fixture);
  await expectRefusal(selection);
  expect(
    (await assertNativeComposeOwned({ ...selection, recovery: "down" }))
      .containers[0]
  ).toMatchObject({ id: ID, generationId: GENERATION, state: "exited" });
  for (const state of ["running", "paused", "restarting"]) {
    container.state = state;
    await prepare(fixture);
    await expectRefusal({ ...selection, recovery: "down" });
  }
  container.state = "exited";
  container.networks = { foreign: { NetworkID: "", Aliases: null } };
  await prepare(fixture);
  await expectRefusal({ ...selection, recovery: "down" });
  container.networks = { [CUSTOM]: { NetworkID: "", Aliases: null } };
  fixture.network = [{ ...customOwned().network, project: "foreign" }];
  await prepare(fixture);
  await expectRefusal({ ...selection, recovery: "down" });
  expect(await Bun.file(join(root, "mutated")).exists()).toBe(false);
});

test("absent owned bridge recovery refuses an unbound nonempty network ID", async () => {
  for (const aliases of [null, [`${PROJECT}-web-1`, "web", "db-query"]]) {
    const { fixture, selection, container } = customOwned();
    container.state = "exited";
    container.networks = {
      [CUSTOM]: { NetworkID: "f".repeat(64), Aliases: aliases },
    };
    fixture.network = [];
    await prepare(fixture);
    await expectRefusal({ ...selection, recovery: "down" });
  }
  expect(await Bun.file(join(root, "mutated")).exists()).toBe(false);
});

test("ownership options are captured before awaits so caller alias and generation mutations cannot retarget proof", async () => {
  const { fixture, selection } = customOwned();
  await prepare(fixture);
  const aliases = ["db-query"];
  const generations = [GENERATION];
  const mutable = {
    ...selection,
    generationIds: generations,
    expectedWorkloadNetworks: [
      {
        generationId: GENERATION,
        service: "web",
        networks: [{ name: CUSTOM, aliases }],
      },
    ],
  };
  const spawn = Bun.spawn.bind(Bun);
  const observed = spyOn(Bun, "spawn").mockImplementation(((
    ...args: unknown[]
  ) => {
    const child = Reflect.apply(spawn, Bun, args);
    if (Array.isArray(args[0]) && args[0][0] === join(root, "docker")) {
      aliases.splice(0, aliases.length, "unrequested");
      generations.splice(0, generations.length, PENDING);
    }
    return child;
  }) as typeof Bun.spawn);
  try {
    expect(
      (await assertNativeComposeOwned(mutable)).containers[0]?.generationId
    ).toBe(GENERATION);
  } finally {
    observed.mockRestore();
  }
});

test("saved down recovery admits created empty endpoints only on freshly verified owned bridges", async () => {
  const { fixture, selection, container, network } = customOwned();
  container.state = "created";
  container.networks = { [CUSTOM]: { NetworkID: "", Aliases: null } };
  network.containers = {};
  await prepare(fixture);
  await expectRefusal(selection);
  expect(
    (await assertNativeComposeOwned({ ...selection, recovery: "down" }))
      .containers[0]
  ).toMatchObject({ id: ID, generationId: GENERATION, state: "created" });
  container.networks = {
    [CUSTOM]: {
      NetworkID: "",
      Aliases: [`${PROJECT}-web-1`, "web", "db-query"],
    },
  };
  await prepare(fixture);
  expect(
    (await assertNativeComposeOwned({ ...selection, recovery: "down" }))
      .containers[0]
  ).toMatchObject({ id: ID, state: "created" });
  container.networks = { [CUSTOM]: { NetworkID: "", Aliases: null } };
  for (const change of [
    "wrong-id",
    "alias-drift",
    "running",
    "foreign-bridge",
    "ingress",
  ]) {
    const attempt = structuredClone(fixture);
    const row = attempt.container?.[0];
    const bridge = attempt.network?.[0];
    if (!(row && bridge)) {
      throw new Error("Missing created fixture");
    }
    if (change === "wrong-id") {
      row.networks = { [CUSTOM]: { NetworkID: "f".repeat(64), Aliases: null } };
    }
    if (change === "alias-drift") {
      row.networks = { [CUSTOM]: { NetworkID: "", Aliases: ["unrequested"] } };
    }
    if (change === "running") {
      row.state = "running";
    }
    if (change === "foreign-bridge") {
      bridge.owner = "f".repeat(32);
    }
    const recovery: NativeComposeOwnershipOptions = {
      ...selection,
      recovery: "down",
    };
    if (change === "ingress") {
      row.networks = {
        [CUSTOM]: { NetworkID: "", Aliases: null },
        "hack-dev": { NetworkID: "", Aliases: null },
      };
      await prepare(attempt);
      await expectRefusal({
        ...recovery,
        expectedWorkloadNetworks: [
          {
            generationId: GENERATION,
            service: "web",
            networks: [
              { name: CUSTOM, aliases: ["db-query"] },
              { name: "hack-dev", aliases: [], externalId: "e".repeat(64) },
            ],
          },
        ],
      });
    } else {
      await prepare(attempt);
      await expectRefusal(recovery);
    }
  }
  expect(await Bun.file(join(root, "mutated")).exists()).toBe(false);
});

test("saved read observes a created unrealized endpoint without authorizing ordinary effects", async () => {
  const { fixture, selection, container, network } = customOwned();
  container.state = "created";
  container.networks = {
    [CUSTOM]: {
      NetworkID: "",
      Aliases: [`${PROJECT}-web-1`, "web", "db-query"],
    },
  };
  network.containers = {};
  await prepare(fixture);
  expect(
    (await observeSavedNativeComposeOwned(selection)).containers[0]
  ).toMatchObject({
    id: ID,
    state: "created",
  });
  await expectRefusal(selection);
  expect(await Bun.file(join(root, "mutated")).exists()).toBe(false);
});

function interruptedReplacement(): Fixture {
  const fixture = owned();
  const predecessor = fixture.container?.[0];
  if (!predecessor) {
    throw new Error("Missing replacement predecessor");
  }
  fixture.container?.push({
    ...structuredClone(predecessor),
    id: "e".repeat(64),
    name: `/${ID.slice(0, 12)}_${PROJECT}-web-1`,
    generation: PENDING,
    state: "created",
    health: null,
    networks: {
      [`${PROJECT}_default`]: {
        NetworkID: "",
        Aliases: [`${PROJECT}-web-1`, "web"],
      },
    },
  });
  return fixture;
}

test("interrupted replacement observes and recovers only a verified predecessor's temporary name", async () => {
  await prepare(interruptedReplacement());
  const observed = await observeSavedNativeComposeOwned(options);
  expect(observed.containers).toHaveLength(2);
  expect(
    observed.containers.find((row) => row.generationId === PENDING)
  ).toMatchObject({
    state: "created",
    name: `${ID.slice(0, 12)}_${PROJECT}-web-1`,
  });
  await expectRefusal(options);
  expect(
    (await assertNativeComposeOwned({ ...options, recovery: "down" }))
      .containers
  ).toHaveLength(2);
  expect(await Bun.file(join(root, "mutated")).exists()).toBe(false);
});

test.each([
  "unknown-prefix",
  "missing-predecessor",
  "same-generation",
  "other-service",
  "oneoff",
  "running",
  "alias-drift",
])("interrupted replacement refuses %s", async (change) => {
  const fixture = interruptedReplacement();
  const current = fixture.container?.[0];
  const pending = fixture.container?.[1];
  if (!(current && pending)) {
    throw new Error("Missing replacement fixture");
  }
  if (change === "unknown-prefix") {
    pending.name = `/${"f".repeat(12)}_${PROJECT}-web-1`;
  } else if (change === "missing-predecessor") {
    fixture.container = [pending];
    const network = fixture.network?.[0];
    if (!network) {
      throw new Error("Missing replacement network");
    }
    network.containers = {};
  } else if (change === "same-generation") {
    pending.generation = GENERATION;
  } else if (change === "other-service") {
    current.service = "install";
  } else if (change === "oneoff") {
    pending.oneoff = "True";
  } else if (change === "running") {
    pending.state = "running";
  } else {
    pending.networks = {
      [`${PROJECT}_default`]: { NetworkID: "", Aliases: ["unknown", "web"] },
    };
  }
  await prepare(fixture);
  await expect(observeSavedNativeComposeOwned(options)).rejects.toBeInstanceOf(
    NativeComposeOwnershipError
  );
  await expectRefusal({ ...options, recovery: "down" });
});

test("empty created aliases retain owned renamed-container observation without authorizing effects", async () => {
  const fixture = interruptedReplacement();
  const pending = fixture.container?.[1];
  if (!pending) {
    throw new Error("Missing replacement fixture");
  }
  pending.name = "/unknown-owned-created-name";
  pending.networks = {
    [`${PROJECT}_default`]: { NetworkID: "", Aliases: null },
  };
  await prepare(fixture);
  expect(
    (await observeSavedNativeComposeOwned(options)).containers
  ).toHaveLength(2);
  expect(
    (await assertNativeComposeOwned({ ...options, recovery: "down" }))
      .containers
  ).toHaveLength(2);
  await expectRefusal(options);
});

test.each([
  "running",
  "paused",
  "restarting",
  "exited",
  "missing-bridge",
  "foreign-bridge",
  "foreign-member",
  "created-member",
  "wrong-id",
  "alias-drift",
  "foreign-key",
  "endpoint-drift",
  "recovery-option",
])("saved created observation refuses %s", async (change) => {
  const { fixture, selection, container, network } = customOwned();
  container.state = "created";
  container.networks = { [CUSTOM]: { NetworkID: "", Aliases: null } };
  network.containers = {};
  if (["running", "paused", "restarting", "exited"].includes(change)) {
    container.state = change;
  } else if (change === "missing-bridge") {
    fixture.network = [];
  } else if (change === "foreign-bridge") {
    network.owner = "f".repeat(32);
  } else if (change === "foreign-member" || change === "created-member") {
    network.containers = {
      [change === "created-member" ? ID : "f".repeat(64)]: {},
    };
  } else if (change === "wrong-id") {
    container.networks = {
      [CUSTOM]: { NetworkID: "f".repeat(64), Aliases: null },
    };
  } else if (change === "alias-drift") {
    container.networks = {
      [CUSTOM]: { NetworkID: "", Aliases: ["unrequested"] },
    };
  } else if (change === "foreign-key") {
    container.networks = { foreign: { NetworkID: "", Aliases: null } };
  } else if (change === "endpoint-drift") {
    fixture.mode = change;
  }
  await prepare(fixture);
  await expect(
    observeSavedNativeComposeOwned({
      ...selection,
      ...(change === "recovery-option" ? { recovery: "down" as const } : {}),
    })
  ).rejects.toBeInstanceOf(NativeComposeOwnershipError);
  expect(await Bun.file(join(root, "mutated")).exists()).toBe(false);
});

test("active topology changes retain every old physical policy; verified stop permits replacement while recovery keeps known union", async () => {
  const old = { name: CUSTOM, driver: "bridge" as const, internal: true };
  const added = {
    name: `${PROJECT}_default`,
    driver: "bridge" as const,
    internal: false,
  };
  expect(
    mergeNativeComposeNetworkPolicies({
      proposed: [old, added],
      retained: [[old]],
    })
  ).toEqual([old, added]);
  for (const proposed of [[added], [{ ...old, internal: false }]]) {
    expect(() =>
      mergeNativeComposeNetworkPolicies({ proposed, retained: [[old]] })
    ).toThrow("Run hack down");
  }
  expect(
    mergeNativeComposeNetworkPolicies({ proposed: [added], retained: [] })
  ).toEqual([added]);
  expect(
    mergeNativeComposeNetworkPolicies({
      proposed: [added],
      retained: [[old]],
      retiring: true,
    })
  ).toEqual([added, old]);
  expect(() =>
    mergeNativeComposeNetworkPolicies({
      proposed: [{ ...old, internal: false }],
      retained: [[old]],
      retiring: true,
    })
  ).toThrow("Run hack down");
  expect(await Bun.file(join(root, "commands")).exists()).toBe(false);
});
