import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNativeComposeOwned,
  mergeNativeComposeNetworkPolicies,
  NativeComposeOwnershipError,
  type NativeComposeOwnershipOptions,
} from "../src/lib/native-compose-ownership.ts";
import { restoreEnv } from "./helpers/env.ts";

const PROJECT = "hack-fixture-instance";
const OWNER = "0".repeat(32);
const GENERATION = "a".repeat(32);
const PENDING = "b".repeat(32);
const ID = "c".repeat(64);
const NETWORK_ID = "d".repeat(64);
const VOLUME = "hack-21-hack-fixture-instance-4-data";
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
 for (const id of selected) { const row = rows.find(row => row.id === id); if (!row) process.exit(1); console.log(JSON.stringify(row)); }
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
  code = "E_NATIVE_COMPOSE_OWNERSHIP"
) {
  try {
    await assertNativeComposeOwned(opts);
    throw new Error("unexpected probe success");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(NativeComposeOwnershipError);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain(CANARY);
    expect(JSON.stringify(error)).not.toContain(CANARY);
  }
  expect(await Bun.file(join(root, "mutated")).exists()).toBe(false);
}
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
    volumes: [{ name: VOLUME, storage: "data" }],
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
    expect(await commands()).toHaveLength(11);
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
      await expectRefusal();
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
  await expectRefusal();
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
        ...fields,
      },
    ];
    await prepare(fixture);
    await expectRefusal();
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
    },
  ];
  await prepare(fixture);
  await expectRefusal();
  await prepare(owned());
  await expectRefusal({ ...options, expectedVolumes: [] });
  await expectRefusal({ ...options, expectedNetwork: "another-default" });
});
test("vanished resources and changed selected inventory refuse without retry or mutation", async () => {
  for (const mode of ["vanished", "inventory-change"]) {
    await prepare({ ...owned(), mode });
    await expectRefusal(
      options,
      mode === "vanished"
        ? "E_NATIVE_COMPOSE_PROBE"
        : "E_NATIVE_COMPOSE_OWNERSHIP"
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
    await expectRefusal(selection);
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
