import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLegacyComposeAdoptionBinding,
  inspectLegacyComposeSourceBindResources,
  LegacyComposeAdoptionBindingError,
} from "../src/lib/native-compose-adoption-binding.ts";
import { executeLegacyComposeRetainedPlan } from "../src/lib/native-compose-adoption-execution.ts";
import {
  type LegacyComposeJobState,
  legacyComposeFreshJobResult,
} from "../src/lib/native-compose-adoption-jobs.ts";
import { planLegacyComposeSourceBindAdoption } from "../src/lib/native-compose-adoption-plan.ts";
import { legacyComposeRetainedPlan } from "../src/lib/native-compose-adoption-readiness.ts";
import { acquireNativeConfigImportInputs } from "../src/lib/native-config-import-inputs.ts";
import { mapLegacyNativeStorageAdoption } from "../src/lib/native-config-import-plan.ts";
import { restoreEnv } from "./helpers/env.ts";

const CANARY = "synthetic-private-adoption-canary";
const ID = "a".repeat(64);
const NETWORK = "b".repeat(64);
const VOLUME = "original_private_database";
const CREATED = "2026-01-01T01:02:03Z";
type Fixture = {
  engine: string;
  container: Record<string, unknown>[];
  volume: Record<string, unknown>[];
  network: Record<string, unknown>[];
  mode?: string;
};
let root: string;
let projectRoot: string;
let priorPath: string | undefined;
let fixture: Fixture;
let snapshotCaseActive = false;
let snapshotCaseUnconfirmed = false;
beforeEach(async () => {
  if (snapshotCaseUnconfirmed) {
    throw new Error("Snapshot case lifetime unconfirmed; fixture retained.");
  }
  priorPath = process.env.PATH;
  root = await realpath(
    await mkdtemp(join(tmpdir(), "native-adoption-binding-"))
  );
  projectRoot = join(root, "checkout");
  await mkdir(join(projectRoot, ".hack"), { recursive: true });
  await writeFile(
    join(projectRoot, ".hack/hack.config.json"),
    '{"name":"fixture"}\n'
  );
  await writeFile(
    join(projectRoot, ".hack/docker-compose.yml"),
    `name: fixture\nservices:\n  db:\n    image: ${CANARY}\n    environment:\n      PRIVATE: ${CANARY}\n      EMPTY: ""\n    volumes:\n      - data:/var/lib/database\nvolumes:\n  data:\n    name: ${VOLUME}\n`
  );
  fixture = {
    engine: CANARY,
    container: [
      {
        id: ID,
        name: "/fixture-db-1",
        project: "fixture",
        native: "",
        service: "db",
        number: "1",
        oneoff: "False",
        running: true,
        workingDir: join(projectRoot, ".hack"),
        configFiles: join(projectRoot, ".hack/docker-compose.yml"),
        mounts: [
          {
            type: "volume",
            name: VOLUME,
            source: "/var/lib/docker/volumes/original/_data",
            target: "/var/lib/database",
            rw: true,
          },
        ],
        networks: [{ name: "fixture_default", id: NETWORK }],
      },
    ],
    volume: [
      {
        id: VOLUME,
        name: VOLUME,
        project: "fixture",
        native: "",
        storage: "data",
        createdAt: CREATED,
        driver: "local",
        scope: "local",
        mountpoint: "/var/lib/docker/volumes/original/_data",
        options: null,
      },
    ],
    network: [
      {
        id: NETWORK,
        name: "fixture_default",
        project: "fixture",
        native: "",
        logical: "default",
        createdAt: CREATED,
        driver: "bridge",
        scope: "local",
        internal: false,
        containers: [ID],
      },
    ],
  };
  await writeFile(
    join(root, "docker"),
    `#!${process.execPath}
import {appendFileSync, existsSync, readFileSync, writeFileSync} from "node:fs";
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
appendFileSync(root + "/commands", JSON.stringify(args) + "\\n");
const fixture = JSON.parse(readFileSync(root + "/fixture.json", "utf8"));
const [kind, action] = args;
if (!(kind === "info" && action === "--format") && (!['container','volume','network'].includes(kind) || !['ls','inspect'].includes(action) || !args.includes('--format'))) {writeFileSync(root + "/mutation", "unauthorized command");process.exit(99);}
if (fixture.mode === "fail") {console.error(${JSON.stringify(CANARY)});process.exit(29);}
if (fixture.mode === "malformed") {console.log(${JSON.stringify(CANARY)});process.exit(0);}
if (fixture.mode === "hang") {writeFileSync(root + "/started", String(process.pid));await Bun.sleep(60_000);}
if (fixture.mode === "overflow") {await Bun.write(Bun.stdout, "x".repeat(9 * 1024 * 1024));process.exit(0);}
if (fixture.mode === "stderr-overflow") {await Bun.write(Bun.stderr, "x".repeat(17 * 1024));process.exit(0);}
let networkOrdinal = 0;
if (kind === "network" && action === "inspect" && existsSync(root+'/snapshot-network-ordinal')) {
 networkOrdinal = Number(readFileSync(root+'/snapshot-network-ordinal','utf8')) + 1;
 writeFileSync(root+'/snapshot-network-ordinal',String(networkOrdinal));
}
if (fixture.mode === "snapshot-wrong-bridge" && networkOrdinal === 4) {
 fixture.container[0].running = false;
 for (const bridge of fixture.network) bridge.containers = bridge.containers.filter(id => id !== 'a'.repeat(64));
 fixture.network.find(row => row.logical === 'edge').containers.push('c'.repeat(64));
}
if (fixture.mode?.startsWith('source-bind-c2-') && kind === 'container' && action === 'inspect') {
 const path = root+'/source-bind-container-ordinal';
 const ordinal = existsSync(path) ? Number(readFileSync(path,'utf8')) + 1 : 1;
 writeFileSync(path,String(ordinal));
 if (ordinal === 2) {
  const bind = fixture.container[0].mounts.find(row => row.type === 'bind');
  if (!bind) process.exit(98);
  if (fixture.mode === 'source-bind-c2-source') bind.source += '-replaced';
  if (fixture.mode === 'source-bind-c2-target') bind.target = '/changed';
  if (fixture.mode === 'source-bind-c2-access') bind.rw = false;
  writeFileSync(root+'/fixture.json',JSON.stringify(fixture));
 }
}
if (kind === "info") {console.log(JSON.stringify({id: fixture.engine, os: "linux"}));}
else if (action === "ls") {for (const row of fixture[kind]) console.log(JSON.stringify({id: row.id, name: kind === 'container' ? row.name.slice(1) : row.name, project: row.project ?? ""}));}
else {
 const id = args.at(-1);const rows = fixture[kind].filter(row => row.id === id);
 if (!rows.length) process.exit(1);
 for (const row of rows) console.log(JSON.stringify(row));
}
if (fixture.mode === "replace-volume" && kind === "volume" && action === "inspect") {fixture.volume[0].createdAt = '2026-02-02T01:02:03Z';delete fixture.mode;writeFileSync(root + '/fixture.json',JSON.stringify(fixture));}
if (fixture.mode === "source-change" && kind === "info") {appendFileSync(${JSON.stringify(join(projectRoot, ".hack/docker-compose.yml"))}, '\\n');}
if (fixture.mode === "inventory-change" && kind === "container" && action === "ls") {fixture.container.push({...fixture.container[0],id:'c'.repeat(64),name:'/fixture-db-2'});delete fixture.mode;writeFileSync(root+'/fixture.json',JSON.stringify(fixture));}
if (fixture.mode === "snapshot-job-exit" && networkOrdinal === 2) {
 const before = structuredClone(fixture);
 const job = fixture.container.find(row => row.id === 'e'.repeat(64) && row.service === 'seed');
 if (!job || job.running !== true) process.exit(98);
 job.running = false;
 fixture.network[0].containers = fixture.network[0].containers.filter(id => id !== job.id);
 delete fixture.mode;
 writeFileSync(root+'/snapshot-transition.json', JSON.stringify({before, after:fixture, ordinal:networkOrdinal}));
 writeFileSync(root+'/fixture.json', JSON.stringify(fixture));
}
if (fixture.mode?.startsWith("snapshot-guard-") && kind === "network" && action === "inspect") {
 const current = fixture.container[0];
 current.running = !current.running;
 fixture.network[0].containers = current.running ? [current.id] : [];
 if (fixture.mode === "snapshot-guard-foreign") fixture.network[0].containers.push('f'.repeat(64));
 if (fixture.mode === "snapshot-guard-container") current.id = 'f'.repeat(64);
 if (fixture.mode === "snapshot-guard-network") fixture.network[0].createdAt = '2026-02-02T01:02:03Z';
 if (fixture.mode === "snapshot-guard-volume") {
  fixture.volume[0].createdAt = '2026-02-02T01:02:03Z';
  delete fixture.mode;
 }
 writeFileSync(root+'/fixture.json', JSON.stringify(fixture));
}
if (fixture.mode === "snapshot-wrong-bridge" && networkOrdinal === 4) {
 fixture.network.find(row => row.logical === 'edge').containers = [];
 delete fixture.mode;
 writeFileSync(root+'/fixture.json', JSON.stringify(fixture));
}
`
  );
  await chmod(join(root, "docker"), 0o700);
  process.env.PATH = root;
  await save();
});
afterEach(async () => {
  if (snapshotCaseActive || snapshotCaseUnconfirmed) {
    snapshotCaseUnconfirmed = true;
    return;
  }
  restoreEnv("PATH", priorPath);
  await rm(root, { recursive: true, force: true });
});
async function save() {
  await writeFile(join(root, "fixture.json"), JSON.stringify(fixture));
}
async function customBridge() {
  const path = join(projectRoot, ".hack/docker-compose.yml");
  const original = await readFile(path, "utf8");
  await writeFile(
    path,
    `${original.replace(
      "    volumes:\n      - data:/var/lib/database",
      "    networks:\n      private:\n        aliases: [database]\n    volumes:\n      - data:/var/lib/database"
    )}networks:\n  private:\n    driver: bridge\n    internal: true\n`
  );
  container().networks = [
    {
      name: "fixture_private",
      id: NETWORK,
      aliases: ["fixture-db-1", "db", "database"],
    },
  ];
  network().name = "fixture_private";
  network().logical = "private";
  network().internal = true;
  await save();
}
async function twoBridges() {
  await writeFile(
    join(projectRoot, ".hack/docker-compose.yml"),
    `name: fixture\nservices:\n  db:\n    image: ${CANARY}\n    networks:\n      private:\n        aliases: [database]\n      edge:\n        aliases: [writer]\n    volumes:\n      - data:/var/lib/database\n  reader:\n    image: ${CANARY}\n    networks:\n      private:\n        aliases: [read-alias]\nnetworks:\n  private:\n    driver: bridge\n    internal: true\n  edge:\n    driver: bridge\n    internal: false\nvolumes:\n  data:\n    name: ${VOLUME}\n`
  );
  const reader = "c".repeat(64);
  const edge = "d".repeat(64);
  container().networks = [
    {
      name: "fixture_private",
      id: NETWORK,
      aliases: ["fixture-db-1", "db", "database"],
    },
    {
      name: "fixture_edge",
      id: edge,
      aliases: ["fixture-db-1", "db", "writer"],
    },
  ];
  fixture.container.push({
    ...container(),
    id: reader,
    name: "/fixture-reader-1",
    service: "reader",
    mounts: [],
    networks: [
      {
        name: "fixture_private",
        id: NETWORK,
        aliases: ["fixture-reader-1", "reader", "read-alias"],
      },
    ],
  });
  fixture.network[0] = {
    ...network(),
    name: "fixture_private",
    logical: "private",
    internal: true,
    containers: [ID, reader],
  };
  fixture.network.push({
    ...network(),
    id: edge,
    name: "fixture_edge",
    logical: "edge",
    internal: false,
    containers: [ID],
  });
  await save();
}
function container() {
  const row = fixture.container[0];
  if (!row) {
    throw new Error("fixture missing");
  }
  return row;
}
function volume() {
  const row = fixture.volume[0];
  if (!row) {
    throw new Error("fixture missing");
  }
  return row;
}
function network() {
  const row = fixture.network[0];
  if (!row) {
    throw new Error("fixture missing");
  }
  return row;
}
async function refusal(pending: Promise<unknown>, code?: string) {
  try {
    await pending;
    throw new Error("unexpected binding success");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(LegacyComposeAdoptionBindingError);
    if (code) {
      expect(error).toMatchObject({ code });
    }
    for (const value of [CANARY, projectRoot, VOLUME]) {
      expect(String(error)).not.toContain(value);
      expect(JSON.stringify(error)).not.toContain(value);
    }
  }
  expect(await Bun.file(join(root, "mutation")).exists()).toBe(false);
}
async function commands(): Promise<string[][]> {
  return (await readFile(join(root, "commands"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test.each([
  "unchanged",
  "source",
  "target",
  "access",
])("source-bind bracket keeps the exact original mount through C2 (%s)", async (change) => {
  const composePath = join(projectRoot, ".hack/docker-compose.yml");
  const composeText = (await readFile(composePath, "utf8")).replace(
    "      - data:/var/lib/database",
    "      - data:/var/lib/database\n      - ../source:/work:rw"
  );
  await writeFile(composePath, composeText);
  await mkdir(join(projectRoot, "source"));
  const declaredMounts = container().mounts;
  if (!Array.isArray(declaredMounts)) {
    throw new Error("Missing original mount rows");
  }
  container().mounts = [
    ...declaredMounts,
    {
      type: "bind",
      name: null,
      source: join(projectRoot, "source"),
      target: "/work",
      rw: true,
    },
  ];
  fixture.mode = `source-bind-c2-${change}`;
  await save();
  const plan = planLegacyComposeSourceBindAdoption({
    configText: await readFile(
      join(projectRoot, ".hack/hack.config.json"),
      "utf8"
    ),
    composeText,
  });
  if (!plan.intent) {
    throw new Error("Missing source-bind candidate");
  }
  const observed = inspectLegacyComposeSourceBindResources({
    root: projectRoot,
    intent: plan.intent,
  });
  if (change === "unchanged") {
    expect(await observed).toMatchObject({
      binding_version: 12,
      sourceBinds: [
        { service: "db", source: "source", target: "/work", readOnly: false },
      ],
      containers: [{ id: ID, service: "db" }],
    });
  } else {
    await expect(observed).rejects.toThrow();
  }
  expect(
    await readFile(join(root, "source-bind-container-ordinal"), "utf8")
  ).toBe("2");
  const reads = (await commands()).filter(
    (args) => args[0] === "container" && args[1] === "inspect"
  );
  expect(reads).toHaveLength(2);
  expect(reads.every((args) => args[3]?.includes('index $m "Name"'))).toBe(
    true
  );
  expect(await Bun.file(join(root, "mutation")).exists()).toBe(false);
});

test("stopped originals retain configured network identity without active endpoints", async () => {
  const acquired = await acquireLegacyComposeAdoptionBinding({ projectRoot });
  const original = await acquired.resolveBinding({ projectRoot });
  container().running = false;
  network().containers = [];
  await save();
  await acquired.assertFresh({ projectRoot });
  expect(await acquired.resolveBinding({ projectRoot })).toEqual(original);
  expect(JSON.stringify(original)).not.toContain("running");
});

test("moving job snapshot counterexample retains identity and admits a fresh completed exit", async () => {
  snapshotCaseActive = true;
  try {
    const job = "e".repeat(64);
    const web = "c".repeat(64);
    const composeText = JSON.stringify({
      name: "fixture",
      services: {
        db: {
          image: CANARY,
          volumes: ["data:/var/lib/database"],
          healthcheck: {
            test: ["CMD", "probe"],
            interval: "1s",
            timeout: "1s",
            retries: 2,
          },
        },
        seed: {
          image: CANARY,
          command: ["seed-once"],
          labels: { "hack.service.one-shot": "true" },
          depends_on: { db: { condition: "service_healthy" } },
        },
        web: {
          image: CANARY,
          depends_on: { seed: { condition: "service_completed_successfully" } },
        },
      },
      volumes: { data: { name: VOLUME } },
    });
    await writeFile(join(projectRoot, ".hack/docker-compose.yml"), composeText);
    fixture.container.push(
      {
        ...container(),
        id: job,
        name: "/fixture-seed-1",
        service: "seed",
        mounts: [],
        running: false,
      },
      {
        ...container(),
        id: web,
        name: "/fixture-web-1",
        service: "web",
        mounts: [],
        running: false,
      }
    );
    network().containers = [ID];
    await save();
    const mapped = mapLegacyNativeStorageAdoption({
      configText: '{"name":"fixture"}',
      composeText,
    });
    if (!mapped.candidate) {
      throw new Error("Missing completed-job candidate");
    }
    const plan = legacyComposeRetainedPlan(mapped.candidate);
    expect(plan.requiresV7).toBe(true);
    expect(plan.ordered.find((item) => item.service === "seed")?.kind).toBe(
      "job"
    );
    const acquired = await acquireLegacyComposeAdoptionBinding({ projectRoot });
    const original = await acquired.resolveBinding({ projectRoot });
    const effects: string[] = [];
    let jobStarted = false;
    let jobArmCommandCursor = 0;
    let bracketTrace: string[][] = [];
    const priorStartedAt = "2026-10-08T00:00:01Z";
    async function observed(): Promise<LegacyComposeJobState[]> {
      const current: Fixture = JSON.parse(
        await readFile(join(root, "fixture.json"), "utf8")
      );
      return current.container.map((row) => ({
        id: String(row.id),
        running: row.running === true,
        paused: false,
        status: row.running ? "running" : "exited",
        health: row.id === ID ? "healthy" : "",
        exitCode: 0,
        startedAt:
          row.id === job && jobStarted
            ? "2026-10-08T00:00:02Z"
            : priorStartedAt,
        finishedAt: row.running
          ? "0001-01-01T00:00:00Z"
          : "2026-10-08T00:00:03Z",
        restartPolicy: "no",
        maximumRetryCount: 0,
      }));
    }
    // The maintained job fixture uses the same 20s operation / 30s case bounds.
    const deadline = Date.now() + 20_000;
    await executeLegacyComposeRetainedPlan({
      plan,
      binding: original,
      operation: "start",
      deadline,
      assertFresh: async () => {
        await acquired.assertFresh({ projectRoot });
      },
      observe: observed,
      effect: async (action, id) => {
        effects.push(`${action}:${id}`);
        if (action !== "start" || ![ID, job, web].includes(id)) {
          throw new Error("Unexpected synthetic lifecycle call");
        }
        if (id === job) {
          jobStarted = true;
          const selected = fixture.container.find((row) => row.id === job);
          if (!selected) {
            throw new Error("Missing seed fixture");
          }
          selected.running = true;
          network().containers = [ID, job];
          fixture.mode = "snapshot-job-exit";
          await writeFile(join(root, "snapshot-network-ordinal"), "0");
          jobArmCommandCursor = (await commands()).length;
          await save();
        }
        if (id === web) {
          bracketTrace = (await commands()).slice(jobArmCommandCursor);
          // Read the stand-in's persisted terminal seed state before changing
          // only the newly admitted dependent's own running endpoint.
          fixture = JSON.parse(
            await readFile(join(root, "fixture.json"), "utf8")
          );
          const selected = fixture.container.find((row) => row.id === web);
          if (!selected) {
            throw new Error("Missing web fixture");
          }
          selected.running = true;
          network().containers = [ID, web];
          await save();
        }
        return 0;
      },
    });
    expect(Date.now()).toBeLessThan(deadline);
    expect(effects).toEqual([`start:${ID}`, `start:${job}`, `start:${web}`]);
    const networkOffsets = bracketTrace.flatMap((args, index) =>
      args[0] === "network" && args[1] === "inspect" ? [index] : []
    );
    expect(networkOffsets.length).toBeGreaterThanOrEqual(3);
    for (const offset of [0, 1]) {
      expect(
        bracketTrace
          .slice(networkOffsets[offset]! + 1, networkOffsets[offset + 1]!)
          .map((args) => args.slice(0, 2))
      ).toEqual(Array.from({ length: 3 }, () => ["container", "inspect"]));
    }
    const transition: { before: Fixture; after: Fixture; ordinal: number } =
      JSON.parse(
        await readFile(join(root, "snapshot-transition.json"), "utf8")
      );
    expect(transition.ordinal).toBe(2);
    const expectedAfter = structuredClone(transition.before);
    const selected = expectedAfter.container.find((row) => row.id === job);
    if (!selected) {
      throw new Error("Missing original seed transition");
    }
    selected.running = false;
    expectedAfter.network[0]!.containers = [ID];
    const { mode: _mode, ...expectedWithoutMode } = expectedAfter;
    expect(transition.after).toEqual(expectedWithoutMode);
    const completed = (await observed()).find((row) => row.id === job);
    if (!completed) {
      throw new Error("Missing completed seed observation");
    }
    expect(
      legacyComposeFreshJobResult({
        attempt: { id: job, priorStartedAt },
        observed: completed,
      })
    ).toBe("ready");
    expect(
      legacyComposeFreshJobResult({
        attempt: { id: job, priorStartedAt: completed.startedAt },
        observed: completed,
      })
    ).toBe("waiting");
    expect(
      legacyComposeFreshJobResult({
        attempt: { id: "f".repeat(64), priorStartedAt },
        observed: completed,
      })
    ).toBe("refused");
    expect(
      legacyComposeFreshJobResult({
        attempt: { id: job, priorStartedAt },
        observed: { ...completed, finishedAt: "0001-01-01T00:00:00Z" },
      })
    ).toBe("refused");
    await acquired.assertFresh({ projectRoot });
    expect(await acquired.resolveBinding({ projectRoot })).toEqual(original);
    expect(await Bun.file(join(root, "mutation")).exists()).toBe(false);
  } finally {
    snapshotCaseActive = false;
  }
}, 30_000);

test.each([
  "foreign",
  "container",
  "network",
  "volume",
])("moving snapshot guard refuses %s drift without mutation", async (kind) => {
  fixture.mode = `snapshot-guard-${kind}`;
  await save();
  await refusal(
    acquireLegacyComposeAdoptionBinding({ projectRoot }),
    kind === "container"
      ? "E_LEGACY_COMPOSE_BINDING_PROBE"
      : "E_LEGACY_COMPOSE_BINDING_IDENTITY"
  );
  expect(await Bun.file(join(root, "mutation")).exists()).toBe(false);
}, 20_000);

test("moving snapshot guard exhausts the original shared deadline", async () => {
  fixture.mode = "snapshot-guard-unstable";
  await save();
  const started = Date.now();
  await refusal(
    acquireLegacyComposeAdoptionBinding({ projectRoot, timeoutMs: 3000 }),
    "E_LEGACY_COMPOSE_BINDING_PROBE"
  );
  expect(Date.now() - started).toBeLessThan(5000);
  const commands = (await readFile(join(root, "commands"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  expect(
    commands.filter(
      ([kind, action]) => kind === "network" && action === "inspect"
    ).length
  ).toBeGreaterThan(2);
  expect(await Bun.file(join(root, "mutation")).exists()).toBe(false);
}, 10_000);

test("moving snapshot guard rejects a selected ID on its undeclared bridge before retry", async () => {
  await twoBridges();
  fixture.mode = "snapshot-wrong-bridge";
  await writeFile(join(root, "snapshot-network-ordinal"), "0");
  await save();
  await refusal(
    acquireLegacyComposeAdoptionBinding({ projectRoot }),
    "E_LEGACY_COMPOSE_BINDING_IDENTITY"
  );
  const observed = await commands();
  expect(
    observed.filter(
      ([kind, action]) => kind === "network" && action === "inspect"
    )
  ).toHaveLength(4);
  expect(
    observed.filter(
      ([kind, action]) => kind === "container" && action === "inspect"
    )
  ).toHaveLength(2);
  expect(await Bun.file(join(root, "mutation")).exists()).toBe(false);
}, 20_000);

test("one authored bridge binds original physical ID, internal policy and exact live aliases", async () => {
  await customBridge();
  const acquired = await acquireLegacyComposeAdoptionBinding({ projectRoot });
  expect(acquired.report.binding_version).toBe(3);
  const original = await acquired.resolveBinding({ projectRoot });
  if (original.binding_version !== 3) {
    throw new Error("Expected one owned bridge binding");
  }
  expect(original.network).toMatchObject({
    id: NETWORK,
    name: "fixture_private",
    logical: "private",
    internal: true,
  });
  expect(original.containers).toEqual([
    { id: ID, name: "fixture-db-1", service: "db" },
  ]);
  expect(JSON.stringify(acquired)).not.toContain(NETWORK);
  const customFormat = (await commands())
    .filter((args) => args[0] === "container" && args[1] === "inspect")
    .map((args) => args[args.indexOf("--format") + 1]);
  expect(customFormat.every((value) => value?.includes("$n.Aliases"))).toBe(
    true
  );

  container().running = false;
  network().containers = [];
  (container().networks as Record<string, unknown>[])[0]!.aliases = null;
  await save();
  await acquired.assertFresh({ projectRoot });
  expect(await acquired.resolveBinding({ projectRoot })).toEqual(original);
});

test("two owned bridges bind both original IDs, policies, aliases and exact members", async () => {
  await twoBridges();
  const acquired = await acquireLegacyComposeAdoptionBinding({ projectRoot });
  expect(acquired.report.binding_version).toBe(5);
  const original = await acquired.resolveBinding({ projectRoot });
  expect(original.binding_version).toBe(5);
  if (original.binding_version !== 5) {
    throw new Error("missing plural binding");
  }
  expect(
    original.networks.map((network) => [
      network.logical,
      network.id,
      network.internal,
    ])
  ).toEqual([
    ["edge", "d".repeat(64), false],
    ["private", NETWORK, true],
  ]);
  expect(original.containers.map((container) => container.id)).toEqual([
    ID,
    "c".repeat(64),
  ]);
  container().running = false;
  fixture.network[0]!.containers = ["c".repeat(64)];
  fixture.network[1]!.containers = [];
  (container().networks as Record<string, unknown>[]).forEach((network) => {
    network.aliases = null;
  });
  await save();
  await acquired.assertFresh({ projectRoot });
  expect(await acquired.resolveBinding({ projectRoot })).toEqual(original);
});

test.each([
  [
    "foreign member",
    () => {
      fixture.network[1]!.containers = [ID, "e".repeat(64)];
    },
  ],
  [
    "duplicate selected name",
    () => {
      fixture.network[1]!.name = "fixture_private";
    },
  ],
  [
    "replaced bridge",
    () => {
      fixture.network[1]!.id = "e".repeat(64);
    },
  ],
  [
    "changed policy",
    () => {
      fixture.network[1]!.internal = true;
    },
  ],
  [
    "alias drift",
    () => {
      (container().networks as Record<string, unknown>[])[1]!.aliases = [
        "db",
        "writer",
      ];
    },
  ],
  [
    "extra attachment",
    () => {
      (fixture.container[1]!.networks as Record<string, unknown>[]).push({
        name: "fixture_edge",
        id: "d".repeat(64),
        aliases: [],
      });
    },
  ],
])("plural binding refuses %s before effect", async (_, change) => {
  await twoBridges();
  const acquired = await acquireLegacyComposeAdoptionBinding({ projectRoot });
  change();
  await save();
  await refusal(acquired.assertFresh({ projectRoot }));
});

test.each([
  [
    "foreign bridge ID",
    () => {
      (container().networks as Record<string, unknown>[])[0]!.id = "c".repeat(
        64
      );
    },
  ],
  [
    "foreign alias",
    () => {
      (container().networks as Record<string, unknown>[])[0]!.aliases = [
        "fixture-db-1",
        "db",
        "foreign",
      ];
    },
  ],
  [
    "extra alias",
    () => {
      (container().networks as Record<string, unknown>[])[0]!.aliases = [
        "fixture-db-1",
        "db",
        "database",
        "foreign",
      ];
    },
  ],
  [
    "missing alias",
    () => {
      (container().networks as Record<string, unknown>[])[0]!.aliases = [
        "fixture-db-1",
        "db",
      ];
    },
  ],
  [
    "changed policy",
    () => {
      network().internal = false;
    },
  ],
  [
    "foreign member",
    () => {
      network().containers = [ID, "c".repeat(64)];
    },
  ],
  [
    "replacement bridge",
    () => {
      network().id = "c".repeat(64);
    },
  ],
])("owned bridge refuses %s before adoption effects", async (_, change) => {
  await customBridge();
  const acquired = await acquireLegacyComposeAdoptionBinding({ projectRoot });
  change();
  await save();
  await refusal(acquired.assertFresh({ projectRoot }));
});

test("running original cannot hide absent aliases behind stopped endpoint allowance", async () => {
  await customBridge();
  (container().networks as Record<string, unknown>[])[0]!.aliases = null;
  await save();
  await refusal(acquireLegacyComposeAdoptionBinding({ projectRoot }));
});

test("mixed stopped and running originals require exactly the running endpoint IDs", async () => {
  const second = "c".repeat(64),
    path = join(projectRoot, ".hack/docker-compose.yml");
  const text = await readFile(path, "utf8"),
    insert = text.lastIndexOf("volumes:\n  data:");
  await writeFile(
    path,
    `${text.slice(0, insert)}  worker:\n    image: ${CANARY}\n    volumes:\n      - data:/var/lib/database\n${text.slice(insert)}`
  );
  fixture.container.push({
    ...container(),
    id: second,
    name: "/fixture-worker-1",
    service: "worker",
    running: false,
  });
  await save();
  const acquired = await acquireLegacyComposeAdoptionBinding({ projectRoot });
  expect(
    (await acquired.resolveBinding({ projectRoot })).containers
  ).toHaveLength(2);
  network().containers = [];
  await save();
  await refusal(acquired.assertFresh({ projectRoot }));
  network().containers = [ID, second];
  await save();
  await refusal(acquired.assertFresh({ projectRoot }));
  network().containers = [ID, "d".repeat(64)];
  await save();
  await refusal(acquired.assertFresh({ projectRoot }));
});

test("stopped configured NetworkID drift and malformed running state refuse", async () => {
  container().running = false;
  network().containers = [];
  await save();
  const acquired = await acquireLegacyComposeAdoptionBinding({ projectRoot });
  container().networks = [{ name: "fixture_default", id: "d".repeat(64) }];
  await save();
  await refusal(acquired.assertFresh({ projectRoot }));
  container().networks = [{ name: "fixture_default", id: NETWORK }];
  container().running = "false";
  await save();
  await refusal(acquired.assertFresh({ projectRoot }));
});
test("exact existing identities are private, frozen and repeatedly verified without writes", async () => {
  const before = await readFile(join(projectRoot, ".hack/docker-compose.yml"));
  const acquired = await acquireLegacyComposeAdoptionBinding({ projectRoot });
  expect(acquired.report).toEqual({
    binding_version: 1,
    status: "verified",
    adoption: "not_performed",
    containers: 1,
    volumes: 1,
  });
  const binding = await acquired.resolveBinding({ projectRoot });
  expect(binding).toMatchObject({
    composeProject: "fixture",
    projectRoot,
    engineId: CANARY,
    containers: [{ id: ID, name: "fixture-db-1", service: "db" }],
    volumes: [
      {
        storage: "data",
        name: VOLUME,
        createdAt: CREATED,
        mountpoint: "/var/lib/docker/volumes/original/_data",
      },
    ],
    network: { id: NETWORK, name: "fixture_default" },
  });
  expect(Object.isFrozen(binding.volumes)).toBe(true);
  expect(Object.keys(acquired)).toEqual(["report"]);
  for (const text of [
    JSON.stringify(acquired),
    JSON.stringify({ ...acquired }),
    JSON.stringify({ ...acquired }),
  ]) {
    for (const value of [
      CANARY,
      ID,
      NETWORK,
      VOLUME,
      projectRoot,
      "assertFresh",
      "resolveBinding",
      "revision",
    ]) {
      expect(text).not.toContain(value);
    }
  }
  expect(await readFile(join(projectRoot, ".hack/docker-compose.yml"))).toEqual(
    before
  );
  expect(
    await Bun.file(join(projectRoot, ".hack/hack.project.json")).exists()
  ).toBe(false);
  for (const args of await commands()) {
    expect(
      args[0] === "info" || args[1] === "ls" || args[1] === "inspect"
    ).toBe(true);
    const format = args[args.indexOf("--format") + 1] ?? "";
    expect(format).not.toContain(".Config.Env");
    expect(format).not.toContain(".Config.Image");
    expect(format).not.toContain("{{json .}}");
  }
});
test("missing existing database volume refuses instead of allocating an empty replacement", async () => {
  fixture.volume = [];
  await save();
  await refusal(
    acquireLegacyComposeAdoptionBinding({ projectRoot }),
    "E_LEGACY_COMPOSE_BINDING_IDENTITY"
  );
});
test.each([
  ["container", "workingDir", "foreign-checkout"],
  ["container", "configFiles", "multiple,foreign,files"],
  ["container", "service", "foreign"],
  ["container", "oneoff", "True"],
  ["container", "number", "2"],
  ["container", "native", "1"],
  ["volume", "project", "foreign"],
  ["volume", "storage", "replacement"],
  ["volume", "createdAt", null],
  ["volume", "driver", "nfs"],
  ["volume", "scope", "global"],
  ["volume", "options", { device: CANARY }],
  ["volume", "native", "1"],
  ["network", "logical", "other"],
  ["network", "driver", "overlay"],
  ["network", "internal", true],
  ["network", "containers", [ID, "c".repeat(64)]],
])("wrong existing identity refuses: %s.%s", async (kind, key, value) => {
  let row = network();
  if (kind === "container") {
    row = container();
  }
  if (kind === "volume") {
    row = volume();
  }
  row[String(key)] = value;
  await save();
  await refusal(acquireLegacyComposeAdoptionBinding({ projectRoot }));
});
test.each([
  [
    {
      type: "volume",
      name: "replacement",
      source: "/different",
      target: "/var/lib/database",
      rw: true,
    },
  ],
  [
    {
      type: "volume",
      name: VOLUME,
      source: "/different",
      target: "/var/lib/database",
      rw: true,
    },
  ],
  [
    {
      type: "volume",
      name: VOLUME,
      source: "/var/lib/docker/volumes/original/_data",
      target: "/wrong",
      rw: true,
    },
  ],
  [
    {
      type: "volume",
      name: VOLUME,
      source: "/var/lib/docker/volumes/original/_data",
      target: "/var/lib/database",
      rw: false,
    },
  ],
  [],
])("mounted identity must exactly match authored path and original data: %j", async (...mounts) => {
  container().mounts = mounts;
  await save();
  await refusal(acquireLegacyComposeAdoptionBinding({ projectRoot }));
});
test.each([
  "container",
  "network",
])("missing existing %s refuses", async (kind) => {
  if (kind === "container") {
    fixture.container = [];
  } else {
    fixture.network = [];
  }
  await save();
  await refusal(acquireLegacyComposeAdoptionBinding({ projectRoot }));
});
test("the authored default volume name must exist exactly, with no generated native replacement", async () => {
  const path = join(projectRoot, ".hack/docker-compose.yml");
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace(`    name: ${VOLUME}`, "    {}")
  );
  await refusal(acquireLegacyComposeAdoptionBinding({ projectRoot }));
});
test.each([
  "replace-volume",
  "source-change",
  "inventory-change",
])("changes during acquisition cannot return a stale capability: %s", async (mode) => {
  fixture.mode = mode;
  await save();
  await refusal(acquireLegacyComposeAdoptionBinding({ projectRoot }));
});
test.each([
  "volume",
  "container",
  "network",
  "engine",
])("captured binding detects later %s replacement", async (kind) => {
  const acquired = await acquireLegacyComposeAdoptionBinding({ projectRoot });
  if (kind === "volume") {
    volume().createdAt = "2026-02-02T01:02:03Z";
  }
  if (kind === "container") {
    container().id = "c".repeat(64);
  }
  if (kind === "network") {
    network().createdAt = "2026-02-02T01:02:03Z";
  }
  if (kind === "engine") {
    fixture.engine = "other-engine";
  }
  await save();
  await refusal(acquired.assertFresh({ projectRoot }));
});
test.each([
  ".hack/docker-compose.yml",
  ".hack/hack.config.json",
])("raw whitespace-only source change invalidates private binding: %s", async (path) => {
  const acquired = await acquireLegacyComposeAdoptionBinding({ projectRoot });
  const file = join(projectRoot, path);
  await writeFile(file, `${await readFile(file, "utf8")}\n`);
  await refusal(acquired.resolveBinding({ projectRoot }));
});
test.each([
  ".hack/hack.local.json",
  ".env",
  ".hack/hack.project.json",
  ".git",
])("adding a relevant marker after resolve invalidates binding: %s", async (path) => {
  const acquired = await acquireLegacyComposeAdoptionBinding({ projectRoot });
  await acquired.resolveBinding({ projectRoot });
  await writeFile(join(projectRoot, path), CANARY);
  await refusal(acquired.assertFresh({ projectRoot }));
});
test("a different checkout target and changed Docker route refuse before a new probe", async () => {
  const acquired = await acquireLegacyComposeAdoptionBinding({ projectRoot });
  const count = (await commands()).length;
  await refusal(
    acquired.assertFresh({ projectRoot: join(root, "sibling") }),
    "E_LEGACY_COMPOSE_BINDING_CHANGED"
  );
  process.env.PATH = `${root}:changed`;
  await refusal(
    acquired.assertFresh({ projectRoot }),
    "E_LEGACY_COMPOSE_BINDING_CHANGED"
  );
  expect((await commands()).length).toBe(count);
});
test("caller option mutation cannot redirect acquisition", async () => {
  const opts = {
    projectRoot,
    timeoutMs: 15_000,
    signal: new AbortController().signal,
  };
  const pending = acquireLegacyComposeAdoptionBinding(opts);
  opts.projectRoot = join(root, "foreign");
  opts.timeoutMs = 1;
  opts.signal = AbortSignal.abort(CANARY);
  const acquired = await pending;
  expect((await acquired.resolveBinding({ projectRoot })).projectRoot).toBe(
    projectRoot
  );
});
test.each([
  "fail",
  "malformed",
  "overflow",
  "stderr-overflow",
])("bounded real probe failures stay redacted: %s", async (mode) => {
  fixture.mode = mode;
  await save();
  await refusal(
    acquireLegacyComposeAdoptionBinding({ projectRoot, timeoutMs: 1000 })
  );
});
test("cancelled real child is reaped and abort reason stays private", async () => {
  fixture.mode = "hang";
  await save();
  const controller = new AbortController();
  const pending = acquireLegacyComposeAdoptionBinding({
    projectRoot,
    signal: controller.signal,
  });
  const started = join(root, "started");
  for (
    let count = 0;
    count < 100 && !(await Bun.file(started).exists());
    count++
  ) {
    await Bun.sleep(5);
  }
  expect(await Bun.file(started).exists()).toBe(true);
  const pid = Number(await readFile(started, "utf8"));
  controller.abort(CANARY);
  await refusal(pending, "E_LEGACY_COMPOSE_BINDING_CANCELLED");
  expect(() => process.kill(pid, 0)).toThrow();
});
test("timeout reaps real child without authorizing any mutation", async () => {
  const binary = join(root, "docker");
  // A slow startup may be killed before its script can publish a PID. Force that
  // case; observe the actual returned child without changing spawn or the timer.
  await writeFile(binary, `#!${process.execPath}\nawait Bun.sleep(60_000);\n`);
  const children: {
    child: ReturnType<typeof Bun.spawn>;
    exited: boolean;
  }[] = [];
  const actualSpawn = Bun.spawn;
  const spawn = spyOn(Bun, "spawn").mockImplementation((...args) => {
    const child: ReturnType<typeof Bun.spawn> = Reflect.apply(
      actualSpawn,
      Bun,
      args
    );
    const argv = args[0];
    if (Array.isArray(argv) && argv[0] === binary) {
      const observed = { child, exited: false };
      children.push(observed);
      void child.exited.then(() => {
        observed.exited = true;
      });
    }
    return child;
  });
  try {
    await refusal(
      acquireLegacyComposeAdoptionBinding({ projectRoot, timeoutMs: 150 }),
      "E_LEGACY_COMPOSE_BINDING_PROBE"
    );
    expect(children.length).toBeGreaterThan(0);
    for (const { child, exited } of children) {
      expect(exited).toBe(true);
      expect(child.signalCode).toBe("SIGKILL");
      expect(await child.exited).not.toBe(0);
      expect(() => process.kill(child.pid, 0)).toThrow();
    }
    expect(await Bun.file(join(root, "started")).exists()).toBe(false);
  } finally {
    spawn.mockRestore();
    // Preserve the assertion failure while preventing a broken reaping path from
    // leaving this exact synthetic child alive in the rest of the test suite.
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
  }
});
test("abort before acquisition starts no Docker process", async () => {
  await refusal(
    acquireLegacyComposeAdoptionBinding({
      projectRoot,
      signal: AbortSignal.abort(CANARY),
    }),
    "E_LEGACY_COMPOSE_BINDING_CANCELLED"
  );
  expect(await Bun.file(join(root, "commands")).exists()).toBe(false);
});
test("symlinked source and linked Git marker refuse before any engine probe", async () => {
  const file = join(projectRoot, ".hack/hack.config.json");
  await rm(file);
  await symlink(join(projectRoot, ".hack/docker-compose.yml"), file);
  await refusal(acquireLegacyComposeAdoptionBinding({ projectRoot }));
  expect(await Bun.file(join(root, "commands")).exists()).toBe(false);
  await rm(file);
  await writeFile(file, '{"name":"fixture"}');
  await writeFile(join(projectRoot, ".git"), "gitdir: ../other");
  await refusal(
    acquireLegacyComposeAdoptionBinding({ projectRoot }),
    "E_LEGACY_COMPOSE_BINDING_UNSUPPORTED"
  );
});
test("source capability hides bytes and detects changes without decrypting or writing", async () => {
  const source = await acquireNativeConfigImportInputs({ projectRoot });
  expect(source.ok).toBe(true);
  expect(JSON.stringify(source)).toBe('{"ok":true}');
  if (!source.ok) {
    throw new Error("fixture source refused");
  }
  expect(source.composeText).toContain(CANARY);
  expect(Object.isFrozen(source)).toBe(true);
  await writeFile(
    join(projectRoot, ".hack/hack.config.json"),
    '{ "name": "fixture" }'
  );
  await expect(source.assertFresh()).rejects.toThrow("values omitted");
  expect(await Bun.file(join(root, "commands")).exists()).toBe(false);
});
test("unknown inactive-profile behavior refuses before Docker inspection", async () => {
  const path = join(projectRoot, ".hack/docker-compose.yml");
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace(
      "volumes:\n  data:",
      "  inactive:\n    image: fixture\n    profiles: [later]\n    privileged: true\nvolumes:\n  data:"
    )
  );
  await refusal(
    acquireLegacyComposeAdoptionBinding({ projectRoot }),
    "E_LEGACY_COMPOSE_BINDING_UNSUPPORTED"
  );
  expect(await Bun.file(join(root, "commands")).exists()).toBe(false);
});
test("different checkout containers in one project cannot be mistaken for the selected instance", async () => {
  fixture.container.push({
    ...container(),
    id: "c".repeat(64),
    name: "/fixture-db-2",
    workingDir: join(root, "sibling/.hack"),
  });
  await save();
  await refusal(
    acquireLegacyComposeAdoptionBinding({ projectRoot }),
    "E_LEGACY_COMPOSE_BINDING_IDENTITY"
  );
  expect(await Bun.file(join(root, "commands")).exists()).toBe(true);
});
test("two independently named checkouts retain separate existing data bindings", async () => {
  const sibling = join(root, "sibling");
  await mkdir(join(sibling, ".hack"), { recursive: true });
  await writeFile(
    join(sibling, ".hack/hack.config.json"),
    '{"name":"sibling"}'
  );
  await writeFile(
    join(sibling, ".hack/docker-compose.yml"),
    "name: sibling\nservices:\n  db:\n    image: fixture\n    volumes: [data:/database]\nvolumes:\n  data: {}\n"
  );
  const siblingId = "c".repeat(64);
  const siblingNetwork = "d".repeat(64);
  const siblingVolume = "sibling_data";
  fixture.container.push({
    ...container(),
    id: siblingId,
    name: "/sibling-db-1",
    project: "sibling",
    workingDir: join(sibling, ".hack"),
    configFiles: join(sibling, ".hack/docker-compose.yml"),
    mounts: [
      {
        type: "volume",
        name: siblingVolume,
        source: "/var/lib/docker/volumes/sibling/_data",
        target: "/database",
        rw: true,
      },
    ],
    networks: [{ id: siblingNetwork, name: "sibling_default" }],
  });
  fixture.volume.push({
    ...volume(),
    id: siblingVolume,
    name: siblingVolume,
    project: "sibling",
    mountpoint: "/var/lib/docker/volumes/sibling/_data",
  });
  fixture.network.push({
    ...network(),
    id: siblingNetwork,
    name: "sibling_default",
    project: "sibling",
    containers: [siblingId],
  });
  await save();
  const selected = await acquireLegacyComposeAdoptionBinding({ projectRoot });
  const other = await acquireLegacyComposeAdoptionBinding({
    projectRoot: sibling,
  });
  expect(
    (await selected.resolveBinding({ projectRoot })).volumes[0]?.name
  ).toBe(VOLUME);
  expect(
    (await other.resolveBinding({ projectRoot: sibling })).volumes[0]?.name
  ).toBe(siblingVolume);
  await writeFile(
    join(sibling, ".hack/hack.config.json"),
    '{ "name": "sibling" }'
  );
  await selected.assertFresh({ projectRoot });
  await refusal(other.assertFresh({ projectRoot: sibling }));
});
test("captured cancellation cannot be replaced by a later fresh signal", async () => {
  const controller = new AbortController();
  const acquired = await acquireLegacyComposeAdoptionBinding({
    projectRoot,
    signal: controller.signal,
  });
  fixture.mode = "hang";
  await save();
  const pending = acquired.assertFresh({
    projectRoot,
    signal: new AbortController().signal,
  });
  const started = join(root, "started");
  for (
    let count = 0;
    count < 100 && !(await Bun.file(started).exists());
    count++
  ) {
    await Bun.sleep(5);
  }
  expect(await Bun.file(started).exists()).toBe(true);
  controller.abort(CANARY);
  await refusal(pending, "E_LEGACY_COMPOSE_BINDING_CANCELLED");
  const pid = Number(await readFile(started, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});
const malformedArguments: readonly {
  readonly label: string;
  readonly value: unknown;
}[] = [
  { label: "null", value: null },
  { label: "undefined", value: undefined },
  { label: "missing root", value: {} },
  { label: "nonstring root", value: { projectRoot: { private: CANARY } } },
  {
    label: "throwing root",
    value: {
      get projectRoot() {
        throw new Error(CANARY);
      },
    },
  },
  {
    label: "invalid signal",
    value: {
      projectRoot: "/",
      signal: {
        get aborted() {
          throw new Error(CANARY);
        },
      },
    },
  },
];
for (const { label, value } of malformedArguments) {
  test(`malformed runtime acquisition argument remains redacted: ${label}`, async () => {
    // Reflect exercises the untyped runtime boundary without weakening API types.
    await refusal(
      Reflect.apply(acquireLegacyComposeAdoptionBinding, undefined, [value]),
      "E_LEGACY_COMPOSE_BINDING_INPUT"
    );
    expect(await Bun.file(join(root, "commands")).exists()).toBe(false);
  });
  test(`malformed runtime freshness argument remains redacted: ${label}`, async () => {
    const acquired = await acquireLegacyComposeAdoptionBinding({ projectRoot });
    const count = (await commands()).length;
    await refusal(
      Reflect.apply(acquired.assertFresh, undefined, [value]),
      "E_LEGACY_COMPOSE_BINDING_INPUT"
    );
    expect((await commands()).length).toBe(count);
  });
}
test("private source owner redacts malformed argument and getter diagnostics", async () => {
  const source = await acquireNativeConfigImportInputs({ projectRoot });
  if (!source.ok) {
    throw new Error("fixture source refused");
  }
  for (const current of [
    null,
    {
      get signal() {
        throw new Error(CANARY);
      },
    },
    { signal: CANARY },
  ]) {
    const pending = Reflect.apply(source.assertFresh, undefined, [current]);
    await expect(pending).rejects.toThrow("values omitted");
    try {
      await pending;
    } catch (error: unknown) {
      expect(String(error)).not.toContain(CANARY);
    }
  }
  for (const opts of [
    null,
    {
      get projectRoot() {
        throw new Error(CANARY);
      },
    },
    { projectRoot, signal: CANARY },
  ]) {
    const pending = Reflect.apply(acquireNativeConfigImportInputs, undefined, [
      opts,
    ]);
    await expect(pending).rejects.toThrow("values omitted");
    try {
      await pending;
    } catch (error: unknown) {
      expect(String(error)).not.toContain(CANARY);
    }
  }
});
