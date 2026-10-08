import { afterEach, beforeEach, test as boundedTest, expect } from "bun:test";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveModernComposeEnvOverrides,
  resolveRuntimeHostMetadataOverride,
} from "../src/commands/project.ts";
import { renderManagedComposeEnvOverride } from "../src/lib/compose-managed-env.ts";
import { tryLegacyComposeAdoptedCommand } from "../src/lib/native-compose-adoption-command.ts";
import { runLegacyComposeRetainedOperation } from "../src/lib/native-compose-adoption-execution.ts";
import {
  LegacyComposeAdoptedGenerationError,
  openLegacyComposeAdoptedGenerationStore,
} from "../src/lib/native-compose-adoption-generation.ts";
import { inspectLegacyComposeAdoptionSelection } from "../src/lib/native-compose-adoption-marker.ts";
import { previewLegacyComposeAdoption } from "../src/lib/native-compose-adoption-preview.ts";
import {
  defaultProjectSlugFromPath,
  findProjectContextAtRoot,
} from "../src/lib/project.ts";
import { setProjectEnvValue } from "../src/lib/project-env-config.ts";
import {
  assertLegacyProjectInputFamily,
  discoverProjectInputs,
} from "../src/lib/project-input-selection.ts";
import { buildRuntimeHostMetadataOverride } from "../src/lib/runtime-host-metadata.ts";
import { captureAdoptionDependencyFirstPrepare } from "./e2e/scenarios/native-compose-adoption-dependency-staged-read.ts";
import { restoreEnv } from "./helpers/env.ts";
import { managedEnvCompilerFixture } from "./helpers/managed-env-compiler.ts";

// Each owner workflow performs multiple bounded child probes; allow their cumulative work on shared CI hosts.
const test = (name: string, run: () => Promise<void>) =>
  boundedTest(name, run, 20_000);
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
  configHash?: string;
  running?: boolean;
  mutationFailure?: boolean;
  states?: Record<string, boolean>;
  health?: Record<string, string>;
  ordered?: boolean;
  aliases?: Record<string, string[]>;
  foreignAfterFirstStart?: boolean;
  sourceRace?: boolean;
  hangMutation?: boolean;
  dependencyReadScope?: {
    readonly projectRoot: string;
    readonly first: Awaited<
      ReturnType<typeof captureAdoptionDependencyFirstPrepare>
    >;
    readonly allowFirstPrepare: boolean;
  };
};
let root: string;
let projectRoot: string;
let priorPath: string | undefined;
let priorCI: string | undefined;
let priorExecutionMode: string | undefined;
let fixture: Fixture;
beforeEach(async () => {
  priorPath = process.env.PATH;
  priorCI = process.env.CI;
  priorExecutionMode = process.env.HACK_EXECUTION_MODE;
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
import {appendFileSync, readFileSync, writeFileSync} from "node:fs";
import {adoptionDependencyReadAllowed} from ${JSON.stringify(new URL("./e2e/scenarios/native-compose-adoption-dependency-inputs.ts", import.meta.url).pathname)};
import {adoptionDependencyStagedReadAllowed} from ${JSON.stringify(new URL("./e2e/scenarios/native-compose-adoption-dependency-staged-read.ts", import.meta.url).pathname)};
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
appendFileSync(root + "/commands", JSON.stringify(args) + "\\n");
const fixture = JSON.parse(readFileSync(root + "/fixture.json", "utf8"));
const [kind, action] = args;
if(fixture.dependencyReadScope && !(kind === 'container' && ['start','stop','restart'].includes(action))) {
 let saved=null;try {saved=JSON.parse(readFileSync(fixture.dependencyReadScope.projectRoot+'/.hack/.internal/legacy-compose-adoption-v1/receipt.json','utf8'));}catch{}
 const allowed=adoptionDependencyReadAllowed({args,projectRoot:fixture.dependencyReadScope.projectRoot,project:'fixture',containerIds:fixture.container.map(row=>row.id),networkId:fixture.network[0].id,volumeName:fixture.volume[0].id,generationId:saved?.prepared?.id ?? saved?.publication?.generation?.id}) || (fixture.dependencyReadScope.allowFirstPrepare && await adoptionDependencyStagedReadAllowed({args,project:'fixture',first:fixture.dependencyReadScope.first}));
 const stage=kind==='compose' && args[10]?.includes('/generations/') ? saved?.prepared ? 'published' : 'staged' : 'original';
 appendFileSync(root+'/read-stages',JSON.stringify({stage,allowed})+'\\n');
 if(!allowed){console.error('dependency-read-refused stage='+stage+' code=93');process.exit(93);}
}
if (kind === 'container' && ['start','restart','stop'].includes(action)) {
 if (!args.slice(2).length || args.slice(2).some(id => !fixture.container.some(container => container.id === id))) { writeFileSync(root + '/mutation','unverified effect');process.exit(99); }
 if(fixture.hangMutation) {writeFileSync(root + '/effect-started', String(process.pid));await Bun.sleep(60_000);}
 if (fixture.ordered) {for(const id of args.slice(2)) fixture.states[id] = action !== 'stop';}
 else fixture.running = action !== 'stop';
 if (fixture.aliases) {for(const id of args.slice(2)) {const row=fixture.container.find(container=>container.id===id);if(row) row.networks[0].aliases=action==='stop'?[]:[row.name.slice(1),row.service,...(fixture.aliases[row.service]??[])];}}
 if (fixture.foreignAfterFirstStart && action==='start' && args.includes(${JSON.stringify(ID)})) {fixture.network[0].containers.push('e'.repeat(64));delete fixture.foreignAfterFirstStart;}
 if(fixture.sourceRace) { writeFileSync(${JSON.stringify(join(projectRoot, ".hack/hack.project.json"))}, 'synthetic-private-source-race'); }
 writeFileSync(root+'/fixture.json',JSON.stringify(fixture));process.exit(fixture.mutationFailure ? 7 : 0);
}
if (kind === 'container' && ['exec','logs'].includes(action)) { process.exit(0); }
if (kind === "compose") { for (const container of fixture.container) console.log(container.service + ' ' + 'd'.repeat(64)); process.exit(0); }
if (!(kind === "info" && action === "--format") && (!['container','volume','network'].includes(kind) || !['ls','inspect'].includes(action) || !args.includes('--format'))) {writeFileSync(root + "/mutation", "unauthorized command");process.exit(99);}
if (fixture.mode === "fail") {console.error(${JSON.stringify(CANARY)});process.exit(29);}
if (fixture.mode === "malformed") {console.log(${JSON.stringify(CANARY)});process.exit(0);}
if (fixture.mode === "hang") {writeFileSync(root + "/started", String(process.pid));await Bun.sleep(60_000);}
if (fixture.mode === "hang-state" && kind === "container" && action === "inspect" && args.join().includes('.State.Running') && !args.join().includes('.Mounts')) {writeFileSync(root + "/started", String(process.pid));await Bun.sleep(60_000);}
if (fixture.mode === "overflow") {await Bun.write(Bun.stdout, "x".repeat(9 * 1024 * 1024));process.exit(0);}
if (fixture.mode === "stderr-overflow") {await Bun.write(Bun.stderr, "x".repeat(17 * 1024));process.exit(0);}
if (kind === "info") {console.log(JSON.stringify({id: fixture.engine, os: "linux"}));}
else if (action === "ls") {for (const row of fixture[kind]) console.log(JSON.stringify({id: row.id, name: kind === 'container' ? row.name.slice(1) : row.name, project: row.project ?? ""}));}
else {
 if(args.join().includes('.State.Health')) {console.error('map has no entry for key Health');process.exit(49);}
 const id = args.at(-1);const rows = fixture[kind].filter(row => row.id === id);
 if (!rows.length) process.exit(1);
 if (kind === "container" && args.join().includes('config-hash')) { console.log(JSON.stringify({id,hash:fixture.configHash ?? 'd'.repeat(64)})); process.exit(0); }
 if (kind === "container" && args.join().includes('.State.Running') && !args.join().includes('.Mounts')) { const running=fixture.states?.[id] ?? fixture.running ?? false;console.log(JSON.stringify({id,running,paused:false,status:running ? 'running' : 'exited', ...(args.join().includes('index .State "Health"') ? {health: fixture.health?.[id] ?? ''} : {})})); process.exit(0); }
 for (const row of rows) {
  if (kind === 'container') console.log(JSON.stringify({...row,running:fixture.states?.[id] ?? fixture.running ?? false}));
  else if (kind === 'network') console.log(JSON.stringify({...row,containers:row.containers.filter(id=>!fixture.container.some(container=>container.id===id) || (fixture.states?.[id] ?? fixture.running ?? false))}));
  else console.log(JSON.stringify(row));
 }
}
if (fixture.mode === "replace-volume" && kind === "volume" && action === "inspect") {fixture.volume[0].createdAt = '2026-02-02T01:02:03Z';delete fixture.mode;writeFileSync(root + '/fixture.json',JSON.stringify(fixture));}
if (fixture.mode === "source-change" && kind === "info") {appendFileSync(${JSON.stringify(join(projectRoot, ".hack/docker-compose.yml"))}, '\\n');}
if (fixture.mode === "inventory-change" && kind === "container" && action === "ls") {fixture.container.push({...fixture.container[0],id:'c'.repeat(64),name:'/fixture-db-2'});delete fixture.mode;writeFileSync(root+'/fixture.json',JSON.stringify(fixture));}
`
  );
  await chmod(join(root, "docker"), 0o700);
  process.env.PATH = root;
  await mkdir(join(projectRoot, ".git"));
  await save();
});
afterEach(async () => {
  restoreEnv("PATH", priorPath);
  restoreEnv("CI", priorCI);
  restoreEnv("HACK_EXECUTION_MODE", priorExecutionMode);
  await rm(root, { recursive: true, force: true });
});
async function save() {
  await writeFile(join(root, "fixture.json"), JSON.stringify(fixture));
}
async function ownedBridge() {
  await writeFile(
    join(projectRoot, ".hack/docker-compose.yml"),
    `name: fixture\nservices:\n  db:\n    image: ${CANARY}\n    environment:\n      PRIVATE: ${CANARY}\n      EMPTY: ""\n    networks:\n      lab:\n        aliases: [db-alias]\n    volumes:\n      - data:/var/lib/database\nnetworks:\n  lab:\n    driver: bridge\n    internal: true\nvolumes:\n  data:\n    name: ${VOLUME}\n`
  );
  fixture.container[0]!.networks = [
    { name: "fixture_lab", id: NETWORK, aliases: [] },
  ];
  fixture.network[0] = {
    ...fixture.network[0],
    name: "fixture_lab",
    logical: "lab",
    internal: true,
  };
  await save();
}
async function twoOwnedBridges() {
  await writeFile(
    join(projectRoot, ".hack/docker-compose.yml"),
    `name: fixture\nservices:\n  db:\n    image: ${CANARY}\n    environment:\n      PRIVATE: ${CANARY}\n      EMPTY: ""\n    networks:\n      edge:\n        aliases: [writer]\n      lab:\n        aliases: [database]\n    volumes:\n      - data:/var/lib/database\nnetworks:\n  edge:\n    driver: bridge\n    internal: false\n  lab:\n    driver: bridge\n    internal: true\nvolumes:\n  data:\n    name: ${VOLUME}\n`
  );
  fixture.container[0]!.networks = [
    { name: "fixture_edge", id: "e".repeat(64), aliases: [] },
    { name: "fixture_lab", id: NETWORK, aliases: [] },
  ];
  fixture.network[0] = {
    ...fixture.network[0],
    name: "fixture_lab",
    logical: "lab",
    internal: true,
  };
  fixture.network.push({
    ...fixture.network[0],
    id: "e".repeat(64),
    name: "fixture_edge",
    logical: "edge",
    internal: false,
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

async function compiler(body = "") {
  const binary = join(root, "compiler");
  await writeFile(
    binary,
    `#!${process.execPath}
if(process.argv[2]==='--protocol'){console.log(${JSON.stringify(JSON.stringify({ transport_version: 1, authored_version: 1, plan_version: 1, network_plan_version: 1 }))})}
else { const raw=await Bun.stdin.text(); await Bun.write(${JSON.stringify(join(root, "candidate-received"))},raw); ${body}; const input=JSON.parse(raw); const networkAware=Object.hasOwn(input,'networks'); const plan=networkAware?{...input,plan_version:1,selected_profiles:[],networks:Object.fromEntries(Object.entries(input.networks).map(([name,value])=>[name,{internal:value.internal===true}])),jobs:input.jobs??{}}:{plan_version:1}; const result={transport_version:1,ok:true,plan,semantic_hash:'a'.repeat(64),...(networkAware?{declared_workloads:Object.fromEntries(Object.keys(input.services).map(name=>[name,'service']))}:{})}; console.log(JSON.stringify(result)); }
`
  );
  await chmod(binary, 0o700);
  return binary;
}

function stateRoot() {
  return join(projectRoot, ".hack/.internal/legacy-compose-adoption-v1");
}
async function prepared() {
  const store = await openLegacyComposeAdoptedGenerationStore({ projectRoot });
  try {
    const generation = await store.prepare({ binary: await compiler() });
    return { store, generation };
  } catch (error: unknown) {
    await store.close();
    throw error;
  }
}

async function dependencyFixture() {
  const worker = "c".repeat(64);
  await writeFile(
    join(projectRoot, ".hack/docker-compose.yml"),
    JSON.stringify({
      name: "fixture",
      services: {
        web: {
          image: CANARY,
          depends_on: { db: { condition: "service_healthy" } },
        },
        db: {
          image: CANARY,
          healthcheck: {
            test: ["CMD", "probe", CANARY],
            interval: "1s",
            timeout: "1s",
            retries: 2,
          },
          volumes: ["data:/var/lib/database"],
        },
      },
      volumes: { data: { name: VOLUME } },
    })
  );
  fixture.container.push({
    ...container(),
    id: worker,
    name: "/fixture-web-1",
    service: "web",
    mounts: [],
  });
  network().containers = [ID, worker];
  fixture.ordered = true;
  fixture.states = { [ID]: false, [worker]: false };
  fixture.health = { [ID]: "healthy", [worker]: "" };
  await save();
  return worker;
}

async function combinedBridgeHealthFixture() {
  const worker = await dependencyFixture();
  const composePath = join(projectRoot, ".hack/docker-compose.yml");
  const compose = JSON.parse(await readFile(composePath, "utf8"));
  compose.networks = { lab: { driver: "bridge", internal: true } };
  compose.services.db.networks = { lab: { aliases: ["db-alias"] } };
  compose.services.web.networks = { lab: { aliases: ["web-alias"] } };
  await writeFile(composePath, JSON.stringify(compose));
  for (const row of fixture.container) {
    row.networks = [{ name: "fixture_lab", id: NETWORK, aliases: [] }];
  }
  fixture.network[0] = {
    ...network(),
    name: "fixture_lab",
    logical: "lab",
    internal: true,
  };
  fixture.aliases = { db: ["db-alias"], web: ["web-alias"] };
  await save();
  return worker;
}

async function mutationCommands() {
  const lines = (await readFile(join(root, "commands"), "utf8"))
    .trim()
    .split("\n");
  return lines
    .map((line) => JSON.parse(line))
    .filter(
      (args) =>
        args[0] === "container" &&
        ["start", "stop", "restart"].includes(args[1])
    );
}

boundedTest(
  "v5 explicit preparation stop uses reverse original-ID order and can publish after verified completion",
  async () => {
    const worker = await dependencyFixture();
    fixture.states = { [ID]: true, [worker]: true };
    await save();
    const { store, generation } = await prepared();
    const controller = new AbortController();
    try {
      const binary = await compiler(),
        deadline = Date.now() + 20_000;
      expect(
        await store.withPreparationStop({
          generation,
          binary,
          deadline,
          run: async (input) => {
            expect((await readReceipt()).pendingOperation.operation).toBe(
              "stop"
            );
            return await runLegacyComposeRetainedOperation({
              input,
              operation: "stop",
              deadline,
              signal: controller.signal,
            });
          },
        })
      ).toBe(0);
      expect(await mutationCommands()).toEqual([
        ["container", "stop", worker],
        ["container", "stop", ID],
      ]);
      expect((await readReceipt()).pendingOperation).toBeNull();
      await store.publish({ generation, binary });
      expect((await readReceipt()).publication.phase).toBe("active");
    } finally {
      await store.close();
    }
  },
  30_000
);

boundedTest(
  "v5 expired aggregate deadline after callback keeps pending instead of acknowledging completion",
  async () => {
    await dependencyFixture();
    const { store, generation } = await prepared();
    try {
      const binary = await compiler();
      await store.publish({ generation, binary });
      const deadline = Date.now() + 5000;
      await refusal(
        store.withMutation({
          generation,
          binary,
          operation: "stop",
          services: [],
          deadline,
          run: async () => {
            await Bun.sleep(Math.max(1, deadline - Date.now() + 5));
            return 0;
          },
        }),
        "E_LEGACY_ADOPTION_CHANGED"
      );
      expect((await readReceipt()).pendingOperation.operation).toBe("stop");
    } finally {
      await store.close();
    }
  },
  30_000
);

boundedTest(
  "v5 requires one finite aggregate deadline before probing or journaling a mutation",
  async () => {
    await dependencyFixture();
    const { store, generation } = await prepared();
    try {
      const binary = await compiler();
      await store.publish({ generation, binary });
      const before = await readFile(join(root, "commands"), "utf8");
      let called = false;
      for (const deadline of [
        undefined,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Date.now() - 1,
      ]) {
        await refusal(
          store.withMutation({
            generation,
            binary,
            operation: "stop",
            services: [],
            deadline,
            run: async () => {
              called = true;
              return 0;
            },
          }),
          "E_LEGACY_ADOPTION_UNSUPPORTED"
        );
      }
      expect(called).toBe(false);
      expect(await readFile(join(root, "commands"), "utf8")).toBe(before);
      expect((await readReceipt()).pendingOperation).toBeNull();
    } finally {
      await store.close();
    }
  },
  30_000
);

for (const linked of [false, true]) {
  boundedTest(
    `rolled-back v5 can reprepare a verified plain generation with ${linked ? "linked" : "directory"} checkout receipt version`,
    async () => {
      if (linked) {
        await linkedCheckout();
      }
      const worker = await dependencyFixture();
      const { store, generation } = await prepared();
      try {
        const binary = await compiler();
        await store.publish({ generation, binary });
        await store.rollback();
        const composePath = join(projectRoot, ".hack/docker-compose.yml");
        const authored = JSON.parse(await readFile(composePath, "utf8"));
        authored.services.web.depends_on = undefined;
        authored.services.db.healthcheck = undefined;
        await writeFile(composePath, JSON.stringify(authored));
        // The synthetic engine config-hash owner continues to attest the new source.
        const plain = await store.prepare({ binary });
        expect(plain.report.adoption_generation_version).toBe(1);
        expect((await readReceipt()).adoption_receipt_version).toBe(
          linked ? 2 : 1
        );
        expect(
          (await store.loadPrepared())?.report.adoption_generation_version
        ).toBe(1);
        await store.publish({ generation: plain, binary });
        expect(
          (await store.loadActive())?.report.adoption_generation_version
        ).toBe(1);
        expect(await mutationCommands()).toEqual([]);
        expect(fixture.container.map((row) => row.id)).toEqual([ID, worker]);
        expect(fixture.volume[0]?.createdAt).toBe(CREATED);
      } finally {
        await store.close();
      }
    },
    30_000
  );
}

for (const stage of ["per-effect freshness", "final observation"] as const) {
  boundedTest(
    `v5 remaining aggregate clock terminates held ${stage} and retains pending`,
    async () => {
      await dependencyFixture();
      const { store, generation } = await prepared();
      try {
        const binary = await compiler();
        await store.publish({ generation, binary });
        const deadline = Date.now() + 5000;
        let reachedCallback = false;
        await refusal(
          store.withMutation({
            generation,
            binary,
            operation: "stop",
            services: [],
            deadline,
            run: async (input) => {
              reachedCallback = true;
              fixture.mode =
                stage === "per-effect freshness" ? "hang" : "hang-state";
              await save();
              if (stage === "per-effect freshness") {
                await input.assertFresh();
              }
              return 0;
            },
          }),
          "E_LEGACY_ADOPTION_CHANGED"
        );
        expect(reachedCallback).toBe(true);
        expect(Date.now()).toBeLessThan(deadline + 1500);
        const pid = Number(
          (await readFile(join(root, "started"), "utf8")).trim()
        );
        expect(Number.isSafeInteger(pid)).toBe(true);
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        expect(alive).toBe(false);
        expect((await readReceipt()).pendingOperation.operation).toBe("stop");
        expect(await mutationCommands()).toEqual([]);
        expect(fixture.volume[0]?.createdAt).toBe(CREATED);
      } finally {
        await store.close();
      }
    },
    30_000
  );
}

boundedTest(
  "final prepared anchor cannot authorize the earlier staged query; old temporal guard refuses before effects",
  async () => {
    await dependencyFixture();
    fixture.dependencyReadScope = {
      projectRoot,
      first: await captureAdoptionDependencyFirstPrepare({ projectRoot }),
      allowFirstPrepare: false,
    };
    await save();
    await refusal(prepared(), "E_LEGACY_ADOPTION_STATE");
    const stages = (await readFile(join(root, "read-stages"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(stages.at(-1)).toEqual({ stage: "staged", allowed: false });
    expect((await readReceipt()).prepared).toBeNull();
    expect((await readReceipt()).pendingOperation).toBeNull();
    expect(await mutationCommands()).toEqual([]);
    expect(fixture.volume[0]?.createdAt).toBe(CREATED);
  },
  30_000
);

boundedTest(
  "dependency fixture admits first preparation before publication and checks later reads against their current receipt",
  async () => {
    await dependencyFixture();
    fixture.dependencyReadScope = {
      projectRoot,
      first: await captureAdoptionDependencyFirstPrepare({ projectRoot }),
      allowFirstPrepare: true,
    };
    await save();
    const { store, generation } = await prepared();
    try {
      await store.publish({ generation, binary: await compiler() });
      const stages = (await readFile(join(root, "read-stages"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        stages.filter((row) => row.stage === "staged").length
      ).toBeGreaterThan(0);
      expect(
        stages.filter((row) => row.stage === "published").length
      ).toBeGreaterThan(0);
      expect(stages.every((row) => row.allowed)).toBe(true);
      expect(await mutationCommands()).toEqual([]);
      expect(fixture.volume[0]?.createdAt).toBe(CREATED);
    } finally {
      await store.close();
    }
  },
  30_000
);

boundedTest(
  "v5 retained dispatch orders exact originals and reverses stops without creating data",
  async () => {
    const worker = await dependencyFixture(),
      original = await originalSnapshots();
    fixture.dependencyReadScope = {
      projectRoot,
      first: await captureAdoptionDependencyFirstPrepare({ projectRoot }),
      allowFirstPrepare: true,
    };
    await save();
    const { store, generation } = await prepared();
    const priorCompiler = process.env.HACK_CONFIG_COMPILER_BINARY;
    try {
      const binary = await compiler();
      process.env.HACK_CONFIG_COMPILER_BINARY = binary;
      expect(generation.report.adoption_generation_version).toBe(5);
      expect((await readReceipt()).adoption_receipt_version).toBe(5);
      expect(JSON.stringify(generation)).not.toContain(CANARY);
      await store.publish({ generation, binary });
      expect(
        await tryLegacyComposeAdoptedCommand({
          cwd: projectRoot,
          operation: "up",
          detach: true,
        })
      ).toBe(0);
      expect(await mutationCommands()).toEqual([
        ["container", "start", ID],
        ["container", "start", worker],
      ]);
      expect(
        await tryLegacyComposeAdoptedCommand({
          cwd: projectRoot,
          operation: "down",
        })
      ).toBe(0);
      expect((await mutationCommands()).slice(2)).toEqual([
        ["container", "stop", worker],
        ["container", "stop", ID],
      ]);
      fixture = JSON.parse(await readFile(join(root, "fixture.json"), "utf8"));
      expect(fixture.volume[0]?.createdAt).toBe(CREATED);
      expect(fixture.container.map((row) => row.id)).toEqual([ID, worker]);
      expect((await readReceipt()).pendingOperation).toBeNull();
      const reads = (await readFile(join(root, "read-stages"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(reads.length).toBeGreaterThan(20);
      expect(reads.every((row) => row.allowed)).toBe(true);
      await store.rollback();
      await expectOriginals(original);
    } finally {
      restoreEnv("HACK_CONFIG_COMPILER_BINARY", priorCompiler);
      await store.close();
    }
  },
  30_000
);

boundedTest(
  "v5 partial selection refuses before a journal or effect; private recheck expires at callback return",
  async () => {
    await dependencyFixture();
    const { store, generation } = await prepared();
    try {
      const binary = await compiler();
      await store.publish({ generation, binary });
      let calls = 0;
      await refusal(
        store.withMutation({
          deadline: Date.now() + 20_000,
          generation,
          binary,
          operation: "start",
          services: ["db"],
          run: async () => {
            calls++;
            return 0;
          },
        }),
        "E_LEGACY_ADOPTION_UNSUPPORTED"
      );
      expect(calls).toBe(0);
      expect((await readReceipt()).pendingOperation).toBeNull();
      let retained: (() => Promise<void>) | undefined;
      await store.withMutation({
        deadline: Date.now() + 20_000,
        generation,
        binary,
        operation: "stop",
        services: [],
        run: async (input) => {
          expect(Object.keys(input)).toEqual([]);
          expect(JSON.stringify(input)).toBe("{}");
          retained = input.assertFresh;
          await input.assertFresh();
          return 0;
        },
      });
      const before = await readFile(join(root, "commands"), "utf8");
      if (!retained) {
        throw new Error("missing test capability");
      }
      await expect(retained()).rejects.toThrow("values omitted");
      expect(await readFile(join(root, "commands"), "utf8")).toBe(before);
    } finally {
      await store.close();
    }
  },
  30_000
);

boundedTest(
  "v5 source drift between ordered effects retains pending evidence and explicit repair permits stop recovery",
  async () => {
    const worker = await dependencyFixture();
    const { store, generation } = await prepared();
    const priorCompiler = process.env.HACK_CONFIG_COMPILER_BINARY;
    try {
      const binary = await compiler();
      process.env.HACK_CONFIG_COMPILER_BINARY = binary;
      await store.publish({ generation, binary });
      const candidate = await readFile(
        join(projectRoot, ".hack/hack.project.json"),
        "utf8"
      );
      fixture.sourceRace = true;
      await save();
      await expect(
        tryLegacyComposeAdoptedCommand({
          cwd: projectRoot,
          operation: "up",
          detach: true,
        })
      ).rejects.toThrow("values omitted");
      expect(await mutationCommands()).toEqual([["container", "start", ID]]);
      expect((await readReceipt()).pendingOperation.operation).toBe("start");
      fixture = JSON.parse(await readFile(join(root, "fixture.json"), "utf8"));
      fixture.sourceRace = false;
      await save();
      await writeFile(join(projectRoot, ".hack/hack.project.json"), candidate);
      expect(
        await tryLegacyComposeAdoptedCommand({
          cwd: projectRoot,
          operation: "down",
          recover: true,
        })
      ).toBe(0);
      expect((await mutationCommands()).slice(1)).toEqual([
        ["container", "stop", worker],
        ["container", "stop", ID],
      ]);
      expect((await readReceipt()).pendingOperation).toBeNull();
      expect(fixture.volume[0]?.createdAt).toBe(CREATED);
    } finally {
      restoreEnv("HACK_CONFIG_COMPILER_BINARY", priorCompiler);
      await store.close();
    }
  },
  30_000
);

boundedTest(
  "v5 final unhealthy observation cannot acknowledge a successful effect",
  async () => {
    await dependencyFixture();
    const { store, generation } = await prepared();
    try {
      const binary = await compiler();
      await store.publish({ generation, binary });
      await refusal(
        store.withMutation({
          deadline: Date.now() + 20_000,
          generation,
          binary,
          operation: "start",
          services: [],
          run: async () => {
            fixture.states = Object.fromEntries(
              fixture.container.map((row) => [String(row.id), true])
            );
            fixture.health = { [ID]: "unhealthy" };
            await save();
            return 0;
          },
        }),
        "E_LEGACY_ADOPTION_CHANGED"
      );
      expect((await readReceipt()).pendingOperation.operation).toBe("start");
      await refusal(store.loadActive(), "E_LEGACY_ADOPTION_BUSY");
      expect(fixture.volume[0]?.createdAt).toBe(CREATED);
    } finally {
      await store.close();
    }
  },
  30_000
);

boundedTest(
  "v5 recheck cancellation refuses a next effect and retains the journal",
  async () => {
    await dependencyFixture();
    const controller = new AbortController();
    const store = await openLegacyComposeAdoptedGenerationStore({
      projectRoot,
      signal: controller.signal,
    });
    try {
      const binary = await compiler(),
        generation = await store.prepare({ binary });
      await store.publish({ generation, binary });
      let effects = 0;
      await refusal(
        store.withMutation({
          deadline: Date.now() + 20_000,
          generation,
          binary,
          operation: "start",
          services: [],
          run: async (input) => {
            effects++;
            controller.abort(CANARY);
            await input.assertFresh();
            effects++;
            return 0;
          },
        }),
        "E_LEGACY_ADOPTION_CANCELLED"
      );
      expect(effects).toBe(1);
      expect((await readReceipt()).pendingOperation.operation).toBe("start");
    } finally {
      await store.close();
    }
  },
  30_000
);

boundedTest(
  "v5 active captured signal reaps the actual retained effect and keeps pending",
  async () => {
    await dependencyFixture();
    const controller = new AbortController();
    const store = await openLegacyComposeAdoptedGenerationStore({
      projectRoot,
      signal: controller.signal,
    });
    try {
      const binary = await compiler(),
        generation = await store.prepare({ binary });
      await store.publish({ generation, binary });
      fixture.hangMutation = true;
      await save();
      const deadline = Date.now() + 20_000;
      let effectStartedAt = 0;
      await refusal(
        store.withMutation({
          generation,
          binary,
          operation: "start",
          services: [],
          deadline,
          run: async (input) => {
            const operation = runLegacyComposeRetainedOperation({
              input,
              operation: "start",
              deadline,
              signal: controller.signal,
            });
            const readyUntil = Date.now() + 4000;
            while (
              !(await Bun.file(join(root, "effect-started")).exists()) &&
              Date.now() < readyUntil
            ) {
              await Bun.sleep(10);
            }
            expect(await Bun.file(join(root, "effect-started")).exists()).toBe(
              true
            );
            effectStartedAt = Date.now();
            controller.abort(CANARY);
            return await operation;
          },
        }),
        "E_LEGACY_ADOPTION_CANCELLED"
      );
      expect(Date.now() - effectStartedAt).toBeLessThan(4000);
      const pid = Number(await Bun.file(join(root, "effect-started")).text());
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
      expect(await mutationCommands()).toEqual([["container", "start", ID]]);
      expect((await readReceipt()).pendingOperation.operation).toBe("start");
      expect(fixture.volume[0]?.createdAt).toBe(CREATED);
    } finally {
      await store.close();
    }
  },
  30_000
);

boundedTest.skipIf(!process.env.HACK_TEST_OLD_ADOPTION_BINARY)(
  "v5 supplied previous upgraded owner refuses before compiler, key or engine reads",
  async () => {
    await dependencyFixture();
    const { store, generation } = await prepared();
    try {
      const binary = await compiler();
      await store.publish({ generation, binary });
      const oldBinary = process.env.HACK_TEST_OLD_ADOPTION_BINARY;
      if (!oldBinary) {
        throw new Error("required previous binary unavailable");
      }
      const before = await readFile(join(root, "commands"), "utf8");
      const child = Bun.spawn(
        [oldBinary, "--path", projectRoot, "ps", "--json"],
        {
          env: {
            PATH: `${root}:/usr/bin:/bin`,
            HOME: root,
            HACK_HOME: join(root, "old-owner-home"),
            HACK_CONFIG_COMPILER_BINARY: binary,
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        }
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).not.toBe(0);
      expect(stdout + stderr).toContain("Legacy adoption selection");
      expect(stdout + stderr).not.toContain(CANARY);
      expect(await readFile(join(root, "commands"), "utf8")).toBe(before);
    } finally {
      await store.close();
    }
  },
  30_000
);

async function managedGenerated() {
  const composeText = await readFile(
    join(projectRoot, ".hack/docker-compose.yml"),
    "utf8"
  );
  await mkdir(join(projectRoot, ".hack/.internal"), { recursive: true });
  await writeFile(
    join(projectRoot, ".hack/hack.env.default.yaml"),
    JSON.stringify({
      version: 1,
      secretsprovider: "project_key",
      values: { global: { MANAGED: CANARY, EMPTY: "" } },
    })
  );
  const runtime = buildRuntimeHostMetadataOverride({
    composeYamls: [composeText],
    branch: null,
    devHost: `${defaultProjectSlugFromPath(projectRoot)}.hack`,
    aliasHost: null,
    composeProject: "fixture",
  });
  const env = renderManagedComposeEnvOverride({
    targetServices: ["db"],
    globalEnv: { MANAGED: CANARY, EMPTY: "" },
    serviceEnv: { db: { MANAGED: CANARY, EMPTY: "" } },
  });
  if (!(runtime && env)) {
    throw new Error("Synthetic projections missing");
  }
  const files = [
    join(projectRoot, ".hack/docker-compose.yml"),
    join(projectRoot, ".hack/.internal/compose.runtime.override.yml"),
    join(projectRoot, ".hack/.internal/compose.env.override.yml"),
  ];
  await writeFile(files[1] ?? "", runtime);
  await writeFile(files[2] ?? "", env);
  container().configFiles = files.join(",");
  await save();
  return files;
}

async function trackedManagedCheckout() {
  await rm(join(projectRoot, ".git"), { recursive: true });
  for (const args of [
    ["init", "--quiet", "-b", "main"],
    ["add", ".hack"],
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
  ]) {
    const child = Bun.spawn(["/usr/bin/git", "-C", projectRoot, ...args], {
      env: {
        PATH: priorPath ?? "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await child.exited).toBe(0);
  }
  await symlink("/usr/bin/git", join(root, "git"));
}

test("v3 saved adoption consumes canonical original generated sources without env or key delivery", async () => {
  Reflect.deleteProperty(process.env, "CI");
  Reflect.deleteProperty(process.env, "HACK_EXECUTION_MODE");
  await trackedManagedCheckout();
  const files = await managedGenerated();
  await writeFile(join(projectRoot, ".hack.secret.key"), "synthetic-v3-key");
  await setProjectEnvValue({
    projectRoot,
    projectDir: join(projectRoot, ".hack"),
    envName: null,
    scope: "global",
    key: "MANAGED",
    value: CANARY,
    secret: true,
  });
  const binary = await managedEnvCompilerFixture(
    join(root, "managed-compiler")
  );
  expect(
    (await previewLegacyComposeAdoption({ projectRoot, binary })).complete
  ).toBe(true);
  const store = await openLegacyComposeAdoptedGenerationStore({ projectRoot });
  try {
    const generation = await store.prepare({ binary });
    expect(generation.report.adoption_generation_version).toBe(3);
    const receipt = JSON.parse(
      await readFile(join(stateRoot(), "receipt.json"), "utf8")
    );
    expect(receipt.adoption_receipt_version).toBe(3);
    const metaText = await readFile(
      await artifactPath("manifest.json"),
      "utf8"
    );
    const meta = JSON.parse(metaText);
    expect(meta.adoption_generation_version).toBe(3);
    expect(meta.binding.composeFiles).toEqual(files);
    expect(meta.runtimeConfig).toEqual([
      { id: ID, service: "db", hash: "d".repeat(64) },
    ]);
    expect(metaText).not.toContain('"MANAGED"');
    expect(JSON.stringify(generation)).not.toContain(
      meta.projectionProof.managedRevision
    );
    await store.publish({ generation, binary });
    await store.close();
    await rm(join(projectRoot, ".hack.secret.key"));
    await mkdir(join(projectRoot, ".hack.secret.key"));
    const savedStore = await openLegacyComposeAdoptedGenerationStore({
      projectRoot,
      mode: "saved",
    });
    try {
      const active = await savedStore.loadActive();
      if (!active) {
        throw new Error("Expected active adopted generation");
      }
      expect(active.report.adoption_generation_version).toBe(3);
      await savedStore.withLease({
        generation: active,
        run: async (input) => {
          expect(input.binding.containers[0]?.id).toBe(ID);
          expect(input.binding.volumes[0]?.createdAt).toBe(CREATED);
          expect(JSON.stringify(input)).toBe("{}");
        },
      });
      await savedStore.rollback();
      expect(await readFile(files[0] ?? "", "utf8")).toContain("name: fixture");
      expect(await readFile(files[2] ?? "", "utf8")).toContain(CANARY);
      expect(await inspectLegacyComposeAdoptionSelection({ projectRoot })).toBe(
        "rolled-back"
      );
    } finally {
      await savedStore.close();
    }
  } finally {
    await store.close();
  }
});

test("v3 raw managed drift fences saved execution and preserves the original stopped IDs", async () => {
  Reflect.deleteProperty(process.env, "CI");
  Reflect.deleteProperty(process.env, "HACK_EXECUTION_MODE");
  await trackedManagedCheckout();
  await managedGenerated();
  const binary = await managedEnvCompilerFixture(
    join(root, "managed-compiler")
  );
  const store = await openLegacyComposeAdoptedGenerationStore({ projectRoot });
  try {
    const generation = await store.prepare({ binary });
    await store.publish({ generation, binary });
    const path = join(projectRoot, ".hack/hack.env.default.yaml");
    await writeFile(path, `${await readFile(path, "utf8")}\n`);
    let effects = 0;
    await refusal(
      store.withLease({
        generation,
        run: async () => {
          effects++;
        },
      })
    );
    expect(effects).toBe(0);
    expect(container().id).toBe(ID);
    expect(volume().createdAt).toBe(CREATED);
    expect(await inspectLegacyComposeAdoptionSelection({ projectRoot })).toBe(
      "active"
    );
  } finally {
    await store.close();
  }
});

test("v4 typed locals preserve generated bytes, exact original IDs and key-free saved rollback", async () => {
  Reflect.deleteProperty(process.env, "CI");
  Reflect.deleteProperty(process.env, "HACK_EXECUTION_MODE");
  await trackedManagedCheckout();
  const files = await managedGenerated();
  const generatedBytes = await Promise.all(
    files.map((path) => readFile(path, "utf8"))
  );
  const localPath = join(projectRoot, ".hack/hack.local.json");
  const original =
    '{"schema_version":1,"environment":{"default_overlay":null}}';
  await writeFile(localPath, original, { mode: 0o600 });
  await writeFile(join(projectRoot, ".hack.secret.key"), "synthetic-v4-key");
  await setProjectEnvValue({
    projectRoot,
    projectDir: join(projectRoot, ".hack"),
    envName: null,
    scope: "global",
    key: "MANAGED",
    value: CANARY,
    secret: true,
  });
  const binary = await managedEnvCompilerFixture(join(root, "local-compiler"));
  const preview = await previewLegacyComposeAdoption({ projectRoot, binary });
  expect(preview.complete).toBe(true);
  expect(
    preview.fields.some(
      (field) =>
        field.document === "checkout_local" &&
        field.pointer === "/environment/default_overlay" &&
        field.status === "exact"
    )
  ).toBe(true);
  const store = await openLegacyComposeAdoptedGenerationStore({ projectRoot });
  try {
    const generation = await store.prepare({ binary });
    expect(generation.report.adoption_generation_version).toBe(4);
    const receipt = JSON.parse(
      await readFile(join(stateRoot(), "receipt.json"), "utf8")
    );
    expect(receipt.adoption_receipt_version).toBe(4);
    const meta = JSON.parse(
      await readFile(await artifactPath("manifest.json"), "utf8")
    );
    expect(meta.projectionProof.projection_version).toBe(2);
    expect(meta.binding.composeFiles).toEqual(files);
    expect(meta.runtimeConfig).toEqual([
      { id: ID, service: "db", hash: "d".repeat(64) },
    ]);
    expect(JSON.stringify(generation)).not.toContain(
      meta.projectionProof.localInputs.checkout.hash
    );
    await store.publish({ generation, binary });
    await store.close();
    const oldBinary = process.env.HACK_TEST_OLD_ADOPTION_BINARY;
    if (oldBinary) {
      const before = await readFile(join(root, "commands"), "utf8");
      const child = Bun.spawn(
        [oldBinary, "--path", projectRoot, "ps", "--json"],
        {
          env: {
            PATH: `${root}:/usr/bin:/bin`,
            HOME: root,
            HACK_HOME: join(root, "old-client-home"),
            HACK_CONFIG_COMPILER_BINARY: binary,
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        }
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).not.toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        ok: false,
        error: {
          code: "E_CONFIG_INVALID",
          message:
            "Legacy adoption selection is unsafe or interrupted. Use explicit adoption recovery; values omitted.",
        },
      });
      expect(stderr).toBe("");
      expect(stdout).not.toContain(CANARY);
      expect(stderr).not.toContain(CANARY);
      expect(await readFile(join(root, "commands"), "utf8")).toBe(before);
    }
    await rm(join(projectRoot, ".hack.secret.key"));
    await mkdir(join(projectRoot, ".hack.secret.key"));
    const savedStore = await openLegacyComposeAdoptedGenerationStore({
      projectRoot,
      mode: "saved",
    });
    try {
      const active = await savedStore.loadActive();
      if (!active) {
        throw new Error("Expected active typed-local adoption");
      }
      expect(active.report.adoption_generation_version).toBe(4);
      let effects = 0;
      await writeFile(localPath, `${original}\n`);
      await refusal(
        savedStore.withLease({
          generation: active,
          run: async () => {
            effects++;
          },
        })
      );
      expect(effects).toBe(0);
      await writeFile(localPath, original);
      await savedStore.withLease({
        generation: active,
        run: async (input) => {
          expect(input.binding.containers[0]?.id).toBe(ID);
          expect(input.binding.volumes[0]?.createdAt).toBe(CREATED);
          expect(JSON.stringify(input)).toBe("{}");
        },
      });
      await savedStore.rollback();
      expect(await readFile(localPath, "utf8")).toBe(original);
      expect(
        await Promise.all(files.map((path) => readFile(path, "utf8")))
      ).toEqual(generatedBytes);
      expect(await inspectLegacyComposeAdoptionSelection({ projectRoot })).toBe(
        "rolled-back"
      );
    } finally {
      await savedStore.close();
    }
  } finally {
    await store.close();
  }
});

boundedTest(
  "v3 linked saved proof preserves overlay, primary/current precedence, tombstones and original rollback",
  async () => {
    await linkedCheckout();
    const primary = join(root, "checkout");
    await writeFile(
      join(projectRoot, ".hack/hack.config.json"),
      JSON.stringify({
        name: "fixture",
        env: { default_overlay: "qa" },
        worktree: { auto_branch: false },
      })
    );
    await managedGenerated();
    const layer = async (
      selectedRoot: string,
      filename: string,
      values: Record<string, string | null>
    ) =>
      await writeFile(
        join(selectedRoot, ".hack", filename),
        JSON.stringify({
          version: 1,
          secretsprovider: "project_key",
          values: { global: values },
        })
      );
    await layer(projectRoot, "hack.env.qa.yaml", {
      ORDER: "overlay",
      DROP: "overlay",
    });
    await layer(primary, "hack.env.local.yaml", {
      ORDER: "primary",
      PRIMARY: "primary",
    });
    await layer(primary, "hack.env.qa.local.yaml", {
      ORDER: "primary-qa",
      PRIMARY_QA: "primary-qa",
    });
    await layer(projectRoot, "hack.env.local.yaml", {
      ORDER: "current",
      CURRENT: "current",
    });
    await layer(projectRoot, "hack.env.qa.local.yaml", {
      ORDER: "current-qa",
      DROP: null,
      EMPTY: "",
    });
    const project = await findProjectContextAtRoot({
      projectRoot,
      projectDirName: ".hack",
    });
    if (!project) {
      throw new Error("Expected canonical linked context");
    }
    await resolveRuntimeHostMetadataOverride({
      project,
      composeFiles: [project.composeFile],
      branch: null,
      devHost: `${defaultProjectSlugFromPath(projectRoot)}.hack`,
      aliasHost: null,
      composeProject: "fixture",
    });
    const delivery = await resolveModernComposeEnvOverrides({
      project,
      targetServices: ["db"],
      allServiceNames: ["db"],
    });
    expect(delivery?.env.ORDER).toBe("current-qa");
    expect(delivery?.env.DROP).toBeUndefined();
    expect(delivery?.env.EMPTY).toBe("");
    const binary = await managedEnvCompilerFixture(
      join(root, "managed-compiler")
    );
    const store = await openLegacyComposeAdoptedGenerationStore({
      projectRoot,
    });
    try {
      const generation = await store.prepare({ binary });
      await store.publish({ generation, binary });
      await store.withLease({
        generation,
        run: async (input) => {
          expect(input.binding.volumes[0]?.createdAt).toBe(CREATED);
        },
      });
      const path = join(primary, ".hack/hack.env.qa.local.yaml");
      const original = await readFile(path, "utf8");
      await writeFile(path, `${original}\n`);
      let effects = 0;
      await refusal(
        store.withLease({
          generation,
          run: async () => {
            effects++;
          },
        })
      );
      expect(effects).toBe(0);
      await writeFile(path, original);
      await store.rollback();
      expect(container().id).toBe(ID);
      expect(volume().createdAt).toBe(CREATED);
      expect(
        await readFile(join(primary, ".hack/docker-compose.yml"), "utf8")
      ).toContain("name: fixture");
    } finally {
      await store.close();
    }
  },
  240_000
);

boundedTest(
  "v3 source race after a preparation effect retains pending stop evidence and needs exact raw repair",
  async () => {
    Reflect.deleteProperty(process.env, "CI");
    Reflect.deleteProperty(process.env, "HACK_EXECUTION_MODE");
    await trackedManagedCheckout();
    await managedGenerated();
    const binary = await managedEnvCompilerFixture(
      join(root, "managed-compiler")
    );
    const store = await openLegacyComposeAdoptedGenerationStore({
      projectRoot,
    });
    const path = join(projectRoot, ".hack/hack.env.default.yaml");
    const original = await readFile(path, "utf8");
    try {
      const generation = await store.prepare({ binary });
      await refusal(
        store.withPreparationStop({
          generation,
          binary,
          run: async () => {
            await writeFile(path, `${original}\n`);
            return 0;
          },
        })
      );
      expect(await inspectLegacyComposeAdoptionSelection({ projectRoot })).toBe(
        "pending"
      );
      let effects = 0;
      await refusal(
        store.withPreparationStop({
          generation,
          binary,
          recover: true,
          run: async () => {
            effects++;
            return 0;
          },
        })
      );
      expect(effects).toBe(0);
      await writeFile(path, original);
      expect(
        await store.withPreparationStop({
          generation,
          binary,
          recover: true,
          run: async () => 0,
        })
      ).toBe(0);
      await store.publish({ generation, binary });
      await store.rollback();
      expect(container().id).toBe(ID);
      expect(volume().createdAt).toBe(CREATED);
    } finally {
      await store.close();
    }
  },
  60_000
);
async function artifactPath(name: string) {
  const receipt = JSON.parse(
    await readFile(join(stateRoot(), "receipt.json"), "utf8")
  );
  return join(stateRoot(), "generations", receipt.prepared.id, name);
}
async function refusal(pending: Promise<unknown>, code?: string) {
  try {
    await pending;
    throw new Error("unexpected adoption success");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(LegacyComposeAdoptedGenerationError);
    if (code) {
      expect(error).toMatchObject({ code });
    }
    for (const value of [CANARY, projectRoot, VOLUME, ID, NETWORK]) {
      expect(String(error)).not.toContain(value);
      expect(JSON.stringify(error)).not.toContain(value);
    }
  }
  expect(await Bun.file(join(root, "mutation")).exists()).toBe(false);
}

async function linkedCheckout() {
  Reflect.deleteProperty(process.env, "CI");
  Reflect.deleteProperty(process.env, "HACK_EXECUTION_MODE");
  await rm(join(projectRoot, ".git"), { recursive: true });
  const git = async (args: readonly string[]) => {
    const child = Bun.spawn(["/usr/bin/git", "-C", projectRoot, ...args], {
      env: {
        PATH: priorPath ?? "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await child.exited).toBe(0);
  };
  await git(["init", "--quiet", "-b", "main"]);
  await git(["add", ".hack"]);
  await git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  const linked = join(root, "linked-checkout");
  await git(["worktree", "add", "--quiet", "-b", "linked", linked]);
  await symlink("/usr/bin/git", join(root, "git"));
  projectRoot = linked;
  container().workingDir = join(linked, ".hack");
  container().configFiles = join(linked, ".hack/docker-compose.yml");
  await save();
}

test("a verified linked checkout adopts and rolls back using the original resources", async () => {
  await linkedCheckout();
  const config = await readFile(join(projectRoot, ".hack/hack.config.json"));
  const compose = await readFile(join(projectRoot, ".hack/docker-compose.yml"));
  const { store, generation } = await prepared();
  try {
    const saved = JSON.parse(
      await readFile(join(stateRoot(), "receipt.json"), "utf8")
    );
    expect(saved.adoption_receipt_version).toBe(2);
    expect(JSON.stringify(generation)).not.toContain(CANARY);
    await store.publish({ generation, binary: await compiler() });
    expect(await inspectLegacyComposeAdoptionSelection({ projectRoot })).toBe(
      "active"
    );
    await store.rollback();
    expect(await readFile(join(projectRoot, ".hack/hack.config.json"))).toEqual(
      config
    );
    expect(
      await readFile(join(projectRoot, ".hack/docker-compose.yml"))
    ).toEqual(compose);
    expect(await inspectLegacyComposeAdoptionSelection({ projectRoot })).toBe(
      "rolled-back"
    );
    expect(fixture.container[0]?.id).toBe(ID);
    expect(fixture.volume[0]?.createdAt).toBe(CREATED);
  } finally {
    await store.close();
  }
});

test("v6 static owned bridge preserves the selected original IDs through saved publication and rollback", async () => {
  await ownedBridge();
  const original = await readFile(
    join(projectRoot, ".hack/docker-compose.yml"),
    "utf8"
  );
  const binary = await compiler();
  const preview = await previewLegacyComposeAdoption({ projectRoot, binary });
  expect(preview.complete).toBe(true);
  const store = await openLegacyComposeAdoptedGenerationStore({ projectRoot });
  try {
    const generation = await store.prepare({ binary });
    expect(generation.report.adoption_generation_version).toBe(6);
    const receipt = JSON.parse(
      await readFile(join(stateRoot(), "receipt.json"), "utf8")
    );
    expect(receipt.adoption_receipt_version).toBe(6);
    const meta = JSON.parse(
      await readFile(await artifactPath("manifest.json"), "utf8")
    );
    expect(meta.adoption_generation_version).toBe(6);
    expect(meta.binding.binding_version).toBe(3);
    expect(meta.binding.network).toEqual({
      id: NETWORK,
      name: "fixture_lab",
      createdAt: CREATED,
      logical: "lab",
      internal: true,
    });
    await store.publish({ generation, binary });
    await store.close();
    const saved = await openLegacyComposeAdoptedGenerationStore({
      projectRoot,
      mode: "saved",
    });
    try {
      const active = await saved.loadActive();
      expect(active?.report.adoption_generation_version).toBe(6);
      if (!active) {
        throw new Error("Expected active owned bridge adoption");
      }
      await saved.withLease({
        generation: active,
        run: async (input) => {
          expect(input.binding.containers[0]?.id).toBe(ID);
          if (input.binding.binding_version !== 3) {
            throw new Error("Expected one owned bridge binding");
          }
          expect(input.binding.network.id).toBe(NETWORK);
          expect(input.binding.volumes[0]?.createdAt).toBe(CREATED);
          expect(JSON.stringify(input)).toBe("{}");
        },
      });
      await saved.rollback();
      expect(
        await readFile(join(projectRoot, ".hack/docker-compose.yml"), "utf8")
      ).toBe(original);
      expect(fixture.container[0]?.id).toBe(ID);
      expect(fixture.network[0]?.id).toBe(NETWORK);
    } finally {
      await saved.close();
    }
  } finally {
    await store.close();
  }
});

test("v11 two static bridges retain both original identities through publication and rollback", async () => {
  await twoOwnedBridges();
  const original = await readFile(
    join(projectRoot, ".hack/docker-compose.yml"),
    "utf8"
  );
  const binary = await compiler();
  const store = await openLegacyComposeAdoptedGenerationStore({ projectRoot });
  try {
    const generation = await store.prepare({ binary });
    expect(generation.report.adoption_generation_version).toBe(11);
    expect((await readReceipt()).adoption_receipt_version).toBe(11);
    const meta = JSON.parse(
      await readFile(await artifactPath("manifest.json"), "utf8")
    );
    expect(meta.binding.binding_version).toBe(5);
    expect(meta.binding.networks).toEqual([
      {
        id: "e".repeat(64),
        name: "fixture_edge",
        createdAt: CREATED,
        logical: "edge",
        internal: false,
      },
      {
        id: NETWORK,
        name: "fixture_lab",
        createdAt: CREATED,
        logical: "lab",
        internal: true,
      },
    ]);
    await store.publish({ generation, binary });
    await store.withLease({
      generation,
      run: async (input) => {
        expect(input.binding.containers[0]?.id).toBe(ID);
        expect(input.binding.binding_version).toBe(5);
        if (input.binding.binding_version !== 5) {
          throw new Error("missing plural binding");
        }
        expect(input.binding.networks.map((network) => network.id)).toEqual([
          "e".repeat(64),
          NETWORK,
        ]);
      },
    });
    await store.rollback();
    expect(
      await readFile(join(projectRoot, ".hack/docker-compose.yml"), "utf8")
    ).toBe(original);
    expect(container().id).toBe(ID);
    expect(fixture.network.map((network) => network.id).sort()).toEqual(
      [NETWORK, "e".repeat(64)].sort()
    );
    expect(volume().createdAt).toBe(CREATED);
  } finally {
    await store.close();
  }
});

test("v11 rejects crossed saved receipt and foreign bridge membership before callback", async () => {
  await twoOwnedBridges();
  const binary = await compiler();
  const store = await openLegacyComposeAdoptedGenerationStore({ projectRoot });
  try {
    const generation = await store.prepare({ binary });
    const original = await readReceipt();
    for (const foreignVersion of [5, 6, 7, 8, 9, 10]) {
      await writeReceipt({
        ...original,
        adoption_receipt_version: foreignVersion,
      });
      await refusal(store.loadPrepared());
    }
    await writeReceipt(original);
    await store.publish({ generation, binary });
    fixture.network[1]!.containers = ["f".repeat(64)];
    await save();
    let calls = 0;
    await refusal(
      store.withLease({
        generation,
        run: async () => {
          calls++;
        },
      })
    );
    expect(calls).toBe(0);
    expect((await readReceipt()).adoption_receipt_version).toBe(11);
  } finally {
    await store.close();
  }
});

test("v11 saved source drift refuses before callback and rollback can prepare a plain owner", async () => {
  const composePath = join(projectRoot, ".hack/docker-compose.yml");
  const plainCompose = await readFile(composePath, "utf8");
  await twoOwnedBridges();
  const binary = await compiler();
  const store = await openLegacyComposeAdoptedGenerationStore({ projectRoot });
  try {
    const generation = await store.prepare({ binary });
    await store.publish({ generation, binary });
    const activePath = join(projectRoot, ".hack/hack.project.json");
    const active = await readFile(activePath, "utf8");
    await writeFile(activePath, `${active}\n`);
    let calls = 0;
    await refusal(
      store.withLease({
        generation,
        run: async () => {
          calls++;
        },
      })
    );
    expect(calls).toBe(0);
    // A byte-exact restoration permits only the selected old owner to roll back.
    await writeFile(activePath, active);
    await store.rollback();
    fixture.container[0]!.networks = [{ name: "fixture_default", id: NETWORK }];
    fixture.network = [
      {
        ...fixture.network[0],
        id: NETWORK,
        name: "fixture_default",
        logical: "default",
        internal: false,
      },
    ];
    await writeFile(composePath, plainCompose);
    await save();
    const plain = await store.prepare({ binary });
    expect(plain.report.adoption_generation_version).toBe(1);
    expect((await readReceipt()).adoption_receipt_version).toBe(1);
    expect(container().id).toBe(ID);
    expect(volume().createdAt).toBe(CREATED);
  } finally {
    await store.close();
  }
});

test("two bridges with health dependencies refuse before generation writes or effects", async () => {
  const worker = await combinedBridgeHealthFixture();
  const composePath = join(projectRoot, ".hack/docker-compose.yml");
  const compose = JSON.parse(await readFile(composePath, "utf8"));
  compose.networks.edge = { driver: "bridge", internal: false };
  compose.services.db.networks.edge = { aliases: ["writer"] };
  compose.services.web.networks.edge = { aliases: ["reader"] };
  await writeFile(composePath, JSON.stringify(compose));
  for (const row of fixture.container) {
    if (!Array.isArray(row.networks)) {
      throw new Error("fixture networks missing");
    }
    row.networks = [
      ...row.networks,
      { name: "fixture_edge", id: "e".repeat(64), aliases: [] },
    ];
  }
  fixture.network.push({
    ...network(),
    id: "e".repeat(64),
    name: "fixture_edge",
    logical: "edge",
    internal: false,
  });
  await save();
  const binary = await compiler();
  const store = await openLegacyComposeAdoptedGenerationStore({ projectRoot });
  try {
    const receipt = await readReceipt();
    await refusal(store.prepare({ binary }), "E_LEGACY_ADOPTION_UNSUPPORTED");
    expect(await readReceipt()).toEqual(receipt);
    expect(await readdir(join(stateRoot(), "generations"))).toEqual([]);
    expect(await mutationCommands()).toEqual([]);
    expect(fixture.container.map((row) => row.id)).toEqual([ID, worker]);
    expect(fixture.network.map((row) => row.id).sort()).toEqual(
      [NETWORK, "e".repeat(64)].sort()
    );
    expect(volume().createdAt).toBe(CREATED);
  } finally {
    await store.close();
  }
});

boundedTest(
  "v10 binds the original bridge while starting and stopping healthy dependencies in order",
  async () => {
    const worker = await combinedBridgeHealthFixture();
    const original = await originalSnapshots();
    const binary = await compiler();
    const store = await openLegacyComposeAdoptedGenerationStore({
      projectRoot,
    });
    const priorCompiler = process.env.HACK_CONFIG_COMPILER_BINARY;
    try {
      process.env.HACK_CONFIG_COMPILER_BINARY = binary;
      const generation = await store.prepare({ binary });
      expect(generation.report.adoption_generation_version).toBe(10);
      expect((await readReceipt()).adoption_receipt_version).toBe(10);
      const meta = JSON.parse(
        await readFile(await artifactPath("manifest.json"), "utf8")
      );
      expect(meta.adoption_generation_version).toBe(10);
      expect(meta.binding.binding_version).toBe(3);
      expect(meta.binding.network).toMatchObject({
        id: NETWORK,
        logical: "lab",
        internal: true,
      });
      await store.publish({ generation, binary });
      expect(
        await tryLegacyComposeAdoptedCommand({
          cwd: projectRoot,
          operation: "up",
          detach: true,
        })
      ).toBe(0);
      expect(await mutationCommands()).toEqual([
        ["container", "start", ID],
        ["container", "start", worker],
      ]);
      expect(
        await tryLegacyComposeAdoptedCommand({
          cwd: projectRoot,
          operation: "down",
        })
      ).toBe(0);
      expect((await mutationCommands()).slice(2)).toEqual([
        ["container", "stop", worker],
        ["container", "stop", ID],
      ]);
      fixture = JSON.parse(await readFile(join(root, "fixture.json"), "utf8"));
      expect((await readReceipt()).pendingOperation).toBeNull();
      expect(network().id).toBe(NETWORK);
      expect(network().containers).toEqual([ID, worker]);
      expect(fixture.states).toEqual({ [ID]: false, [worker]: false });
      expect(volume().createdAt).toBe(CREATED);
      await store.rollback();
      await expectOriginals(original);
    } finally {
      restoreEnv("HACK_CONFIG_COMPILER_BINARY", priorCompiler);
      await store.close();
    }
  },
  30_000
);

test("v10 saved bridge and health owner rejects other contract receipts", async () => {
  const worker = await combinedBridgeHealthFixture();
  const { store, generation } = await prepared();
  try {
    expect(generation.report.adoption_generation_version).toBe(10);
    const current = await readReceipt();
    for (const foreignVersion of [5, 6, 7, 8, 9, 11]) {
      await writeReceipt({
        ...current,
        adoption_receipt_version: foreignVersion,
      });
      await refusal(store.loadPrepared());
      expect((await readReceipt()).adoption_receipt_version).toBe(
        foreignVersion
      );
      await writeReceipt(current);
    }
    expect(
      (await store.loadPrepared())?.report.adoption_generation_version
    ).toBe(10);
    expect(fixture.container.map((row) => row.id)).toEqual([ID, worker]);
    expect(network().id).toBe(NETWORK);
    expect(volume().createdAt).toBe(CREATED);
  } finally {
    await store.close();
  }
});

for (const owner of ["health", "bridge"] as const) {
  test(`${owner} saved owner refuses a version 10 receipt without gaining combined authority`, async () => {
    if (owner === "health") {
      await dependencyFixture();
    } else {
      await ownedBridge();
    }
    const { store, generation } = await prepared();
    try {
      expect(generation.report.adoption_generation_version).toBe(
        owner === "health" ? 5 : 6
      );
      const current = await readReceipt();
      await writeReceipt({ ...current, adoption_receipt_version: 10 });
      await refusal(store.loadPrepared());
      expect((await readReceipt()).adoption_receipt_version).toBe(10);
      expect(network().id).toBe(NETWORK);
      expect(volume().createdAt).toBe(CREATED);
      expect(await mutationCommands()).toEqual([]);
    } finally {
      await store.close();
    }
  });
}

boundedTest(
  "v10 foreign bridge member after first start retains pending before the dependent effect",
  async () => {
    const worker = await combinedBridgeHealthFixture();
    const { store, generation } = await prepared();
    const priorCompiler = process.env.HACK_CONFIG_COMPILER_BINARY;
    try {
      const binary = await compiler();
      process.env.HACK_CONFIG_COMPILER_BINARY = binary;
      await store.publish({ generation, binary });
      fixture.foreignAfterFirstStart = true;
      await save();
      await expect(
        tryLegacyComposeAdoptedCommand({
          cwd: projectRoot,
          operation: "up",
          detach: true,
        })
      ).rejects.toThrow("values omitted");
      expect(await mutationCommands()).toEqual([["container", "start", ID]]);
      expect((await readReceipt()).pendingOperation.operation).toBe("start");
      fixture = JSON.parse(await readFile(join(root, "fixture.json"), "utf8"));
      expect(network().id).toBe(NETWORK);
      expect(network().containers).toContain("e".repeat(64));
      expect(fixture.states).toEqual({ [ID]: true, [worker]: false });
      expect(fixture.container.map((row) => row.id)).toEqual([ID, worker]);
      expect(volume().createdAt).toBe(CREATED);
    } finally {
      restoreEnv("HACK_CONFIG_COMPILER_BINARY", priorCompiler);
      await store.close();
    }
  },
  30_000
);

boundedTest(
  "v10 refuses a missing aggregate deadline before a retained effect",
  async () => {
    await combinedBridgeHealthFixture();
    const { store, generation } = await prepared();
    try {
      const binary = await compiler();
      await store.publish({ generation, binary });
      const before = await readFile(join(root, "commands"), "utf8");
      let called = false;
      await refusal(
        store.withMutation({
          generation,
          binary,
          operation: "start",
          services: [],
          run: async () => {
            called = true;
            return 0;
          },
        }),
        "E_LEGACY_ADOPTION_UNSUPPORTED"
      );
      expect(called).toBe(false);
      expect(await readFile(join(root, "commands"), "utf8")).toBe(before);
      expect((await readReceipt()).pendingOperation).toBeNull();
      expect(network().id).toBe(NETWORK);
      expect(volume().createdAt).toBe(CREATED);
    } finally {
      await store.close();
    }
  },
  30_000
);

test("rolled-back v10 can reprepare the same owned bridge without health under v6", async () => {
  const worker = await combinedBridgeHealthFixture();
  const binary = await compiler();
  const store = await openLegacyComposeAdoptedGenerationStore({ projectRoot });
  try {
    const combined = await store.prepare({ binary });
    expect(combined.report.adoption_generation_version).toBe(10);
    await store.publish({ generation: combined, binary });
    await store.rollback();
    const composePath = join(projectRoot, ".hack/docker-compose.yml");
    const authored = JSON.parse(await readFile(composePath, "utf8"));
    authored.services.web.depends_on = undefined;
    authored.services.db.healthcheck = undefined;
    await writeFile(composePath, JSON.stringify(authored));
    const bridge = await store.prepare({ binary });
    expect(bridge.report.adoption_generation_version).toBe(6);
    expect((await readReceipt()).adoption_receipt_version).toBe(6);
    expect(
      (await store.loadPrepared())?.report.adoption_generation_version
    ).toBe(6);
    expect(fixture.container.map((row) => row.id)).toEqual([ID, worker]);
    expect(network().id).toBe(NETWORK);
    expect(volume().createdAt).toBe(CREATED);
  } finally {
    await store.close();
  }
});

test("rolled-back v10 resets a later plain receipt to the checkout owner", async () => {
  const composePath = join(projectRoot, ".hack/docker-compose.yml");
  const worker = await combinedBridgeHealthFixture();
  const binary = await compiler();
  const store = await openLegacyComposeAdoptedGenerationStore({ projectRoot });
  try {
    const combined = await store.prepare({ binary });
    expect(combined.report.adoption_generation_version).toBe(10);
    await store.publish({ generation: combined, binary });
    await store.rollback();
    const authored = JSON.parse(await readFile(composePath, "utf8"));
    authored.services.web.depends_on = undefined;
    authored.services.db.healthcheck = undefined;
    authored.services.web.networks = undefined;
    authored.services.db.networks = undefined;
    authored.networks = undefined;
    await writeFile(composePath, JSON.stringify(authored));
    for (const row of fixture.container) {
      row.networks = [{ name: "fixture_default", id: NETWORK }];
    }
    fixture.network[0] = {
      ...network(),
      name: "fixture_default",
      logical: "default",
      internal: false,
    };
    fixture.aliases = undefined;
    await save();
    const plain = await store.prepare({ binary });
    expect(plain.report.adoption_generation_version).toBe(1);
    expect((await readReceipt()).adoption_receipt_version).toBe(1);
    expect(
      (await store.loadPrepared())?.report.adoption_generation_version
    ).toBe(1);
    expect(fixture.container.map((row) => row.id)).toEqual([ID, worker]);
    expect(network().id).toBe(NETWORK);
    expect(volume().createdAt).toBe(CREATED);
  } finally {
    await store.close();
  }
});

test("v6 saved bridge refuses a changed policy before another retained effect", async () => {
  await ownedBridge();
  const binary = await compiler();
  const store = await openLegacyComposeAdoptedGenerationStore({ projectRoot });
  try {
    const generation = await store.prepare({ binary });
    await store.publish({ generation, binary });
    fixture.network[0]!.internal = false;
    await save();
    let effects = 0;
    await refusal(
      store.withLease({
        generation,
        run: async () => {
          effects++;
        },
      }),
      "E_LEGACY_ADOPTION_STATE"
    );
    expect(effects).toBe(0);
    expect(fixture.container[0]?.id).toBe(ID);
    expect(fixture.volume[0]?.createdAt).toBe(CREATED);
  } finally {
    await store.close();
  }
});

test("v6 manifest and receipt must select the same saved topology owner", async () => {
  await ownedBridge();
  const { store, generation } = await prepared();
  try {
    expect(generation.report.adoption_generation_version).toBe(6);
    const current = await readReceipt();
    for (const foreignVersion of [4, 5]) {
      await writeReceipt({
        ...current,
        adoption_receipt_version: foreignVersion,
      });
      await refusal(store.loadPrepared());
      expect(await readReceipt()).toEqual({
        ...current,
        adoption_receipt_version: foreignVersion,
      });
    }
    expect(fixture.container[0]?.id).toBe(ID);
    expect(fixture.network[0]?.id).toBe(NETWORK);
  } finally {
    await store.close();
  }
});

test("v5 retained health owner refuses a v6 topology receipt", async () => {
  await dependencyFixture();
  const { store, generation } = await prepared();
  try {
    expect(generation.report.adoption_generation_version).toBe(5);
    const current = await readReceipt();
    expect(current.adoption_receipt_version).toBe(5);
    await writeReceipt({ ...current, adoption_receipt_version: 6 });
    await refusal(store.loadPrepared());
    expect(await readReceipt()).toEqual({
      ...current,
      adoption_receipt_version: 6,
    });
    expect(fixture.container.map((row) => row.id)).toEqual([
      ID,
      "c".repeat(64),
    ]);
    expect(network().id).toBe(NETWORK);
  } finally {
    await store.close();
  }
});

test("v6 rollback permits a later plain owner without inheriting topology authority", async () => {
  const composePath = join(projectRoot, ".hack/docker-compose.yml");
  const plainCompose = await readFile(composePath, "utf8");
  await ownedBridge();
  const binary = await compiler();
  const store = await openLegacyComposeAdoptedGenerationStore({ projectRoot });
  try {
    const custom = await store.prepare({ binary });
    expect(custom.report.adoption_generation_version).toBe(6);
    await store.publish({ generation: custom, binary });
    await store.rollback();
    expect(network().id).toBe(NETWORK);
    expect(volume().createdAt).toBe(CREATED);

    const plainNetwork = "e".repeat(64);
    await writeFile(composePath, plainCompose);
    container().networks = [{ name: "fixture_default", id: plainNetwork }];
    fixture.network[0] = {
      ...network(),
      id: plainNetwork,
      name: "fixture_default",
      logical: "default",
      internal: false,
    };
    await save();
    const plain = await store.prepare({ binary });
    expect(plain.report.adoption_generation_version).toBe(1);
    expect((await readReceipt()).adoption_receipt_version).toBe(1);
    await store.publish({ generation: plain, binary });
    await store.close();
    const saved = await openLegacyComposeAdoptedGenerationStore({
      projectRoot,
      mode: "saved",
    });
    try {
      expect(
        (await saved.loadActive())?.report.adoption_generation_version
      ).toBe(1);
      expect(container().id).toBe(ID);
      expect(network().id).toBe(plainNetwork);
      expect(volume().createdAt).toBe(CREATED);
    } finally {
      await saved.close();
    }
  } finally {
    await store.close();
  }
});

test("v6 journals a running original stop before effect and retains the owned bridge on recovery", async () => {
  await ownedBridge();
  fixture.running = true;
  fixture.container[0]!.networks = [
    {
      name: "fixture_lab",
      id: NETWORK,
      aliases: ["fixture-db-1", "db", "db-alias"],
    },
  ];
  await save();
  const binary = await compiler();
  expect(
    (await previewLegacyComposeAdoption({ projectRoot, binary })).complete
  ).toBe(false);
  expect(
    (await previewLegacyComposeAdoption({ projectRoot, binary, stop: true }))
      .complete
  ).toBe(true);
  const { store, generation } = await prepared();
  try {
    expect(
      await store.withPreparationStop({
        generation,
        binary,
        run: async (input) => {
          if (input.binding.binding_version !== 3) {
            throw new Error("Expected one owned bridge binding");
          }
          expect(input.binding.network.id).toBe(NETWORK);
          expect((await readReceipt()).adoption_receipt_version).toBe(6);
          expect((await readReceipt()).pendingOperation).toMatchObject({
            operation: "stop",
            services: ["db"],
          });
          fixture.running = false;
          fixture.container[0]!.networks = [
            { name: "fixture_lab", id: NETWORK, aliases: [] },
          ];
          await save();
          return 7;
        },
      })
    ).toBe(7);
    await refusal(store.loadPrepared(), "E_LEGACY_ADOPTION_BUSY");
    const recovered = await store.loadPrepared({ recoverOperation: true });
    if (!recovered) {
      throw new Error("Expected exact selected recovery");
    }
    await store.withPreparationStop({
      generation: recovered,
      binary,
      recover: true,
      run: async () => 0,
    });
    await store.publish({ generation: recovered, binary });
    await store.rollback();
    expect(fixture.container[0]?.id).toBe(ID);
    expect(fixture.network[0]?.id).toBe(NETWORK);
    expect(fixture.volume[0]?.createdAt).toBe(CREATED);
  } finally {
    await store.close();
  }
});

test("unsupported inherited primary inputs refuse before engine inspection or preparation writes", async () => {
  await linkedCheckout();
  const primaryFile = join(root, "checkout/.hack/hack.env.local.yaml");
  await writeFile(primaryFile, CANARY);
  const preview = await previewLegacyComposeAdoption({
    projectRoot,
    binary: await compiler(),
  });
  expect(preview.complete).toBe(false);
  expect(JSON.stringify(preview)).not.toContain(CANARY);
  expect(await Bun.file(join(root, "commands")).exists()).toBe(false);
  expect(await Bun.file(join(stateRoot(), "receipt.json")).exists()).toBe(
    false
  );
  expect(await readFile(primaryFile, "utf8")).toBe(CANARY);
});

for (const mode of ["policy", "ci"] as const) {
  test(`the existing inheritance opt-out ${mode} excludes primary managed inputs`, async () => {
    await linkedCheckout();
    await writeFile(join(root, "checkout/.hack/hack.env.local.yaml"), CANARY);
    if (mode === "policy") {
      await writeFile(
        join(projectRoot, ".hack/hack.config.json"),
        '{"name":"fixture","worktree":{"inherit_local":false}}'
      );
    } else {
      process.env.CI = "1";
    }
    const preview = await previewLegacyComposeAdoption({
      projectRoot,
      binary: await compiler(),
    });
    expect(preview.complete).toBe(true);
    expect(JSON.stringify(preview)).not.toContain(CANARY);
  });
}

test("preparation durably binds original sources and resources without active publication or native labels", async () => {
  const originalConfig = await readFile(
    join(projectRoot, ".hack/hack.config.json"),
    "utf8"
  );
  const originalCompose = await readFile(
    join(projectRoot, ".hack/docker-compose.yml"),
    "utf8"
  );
  const { store, generation } = await prepared();
  try {
    expect(generation.report).toEqual({
      adoption_generation_version: 1,
      owner: "legacy-compose",
      status: "prepared",
      containers: 1,
      volumes: 1,
    });
    expect(JSON.stringify(store)).toBe("{}");
    expect(Object.isFrozen(generation.report)).toBe(true);
    for (const text of [
      JSON.stringify(generation),
      JSON.stringify({ ...generation }),
    ]) {
      for (const value of [
        CANARY,
        VOLUME,
        ID,
        NETWORK,
        projectRoot,
        "hash",
        "revision",
        "generationId",
      ]) {
        expect(text).not.toContain(value);
      }
    }
    await store.withLease({
      generation,
      run: async (input) => {
        expect(input.configText).toBe(originalConfig);
        expect(input.composeText).toBe(originalCompose);
        expect(input.binding.volumes).toEqual([
          {
            storage: "data",
            name: VOLUME,
            createdAt: CREATED,
            mountpoint: "/var/lib/docker/volumes/original/_data",
          },
        ]);
        expect(JSON.stringify(input)).toBe("{}");
        expect(Object.isFrozen(input.binding.volumes)).toBe(true);
        expect(JSON.parse(input.candidateText).services.db.mounts).toEqual([
          {
            storage: "data",
            target: "/var/lib/database",
            access: "read-write",
          },
        ]);
      },
    });
    expect(
      await readFile(join(projectRoot, ".hack/hack.config.json"), "utf8")
    ).toBe(originalConfig);
    expect(
      await readFile(join(projectRoot, ".hack/docker-compose.yml"), "utf8")
    ).toBe(originalCompose);
    expect(
      await Bun.file(join(projectRoot, ".hack/hack.project.json")).exists()
    ).toBe(false);
    expect(
      await Bun.file(
        join(projectRoot, ".hack/.internal/native-compose")
      ).exists()
    ).toBe(false);
    const receipt = JSON.parse(
      await readFile(join(stateRoot(), "receipt.json"), "utf8")
    );
    expect(Object.keys(receipt)).toEqual([
      "adoption_receipt_version",
      "kind",
      "checkout",
      "prepared",
      "publication",
      "pendingOperation",
    ]);
    expect(receipt.kind).toBe("legacy-compose-adopted");
    expect(await Bun.file(join(root, "mutation")).exists()).toBe(false);
  } finally {
    await store.close();
  }
});

test("saved lease uses anchored originals without decoding current authored inputs or reading keys", async () => {
  const first = await prepared();
  await first.store.close();
  await rm(join(projectRoot, ".hack/hack.config.json"));
  await rm(join(projectRoot, ".hack/docker-compose.yml"));
  await writeFile(
    join(projectRoot, ".hack/hack.project.json"),
    "malformed-private-current-input"
  );
  await writeFile(
    join(projectRoot, ".hack/hack.env.default.yaml"),
    "malformed-private-env: ["
  );
  await symlink(
    join(root, "missing-private-key"),
    join(projectRoot, ".hack/hack.env.key")
  );
  const store = await openLegacyComposeAdoptedGenerationStore({
    projectRoot,
    mode: "saved",
  });
  try {
    const generation = await store.loadPrepared();
    expect(generation).not.toBeNull();
    if (!generation) {
      throw new Error("missing fixture generation");
    }
    await store.withLease({
      generation,
      run: async (input) => {
        expect(input.binding.volumes[0]?.name).toBe(VOLUME);
        expect(input.composeText).toContain(CANARY);
      },
    });
    await refusal(store.prepare({ binary: await compiler() }));
  } finally {
    await store.close();
  }
});

for (const changed of [
  "volume missing",
  "volume replacement",
  "container replacement",
  "network replacement",
  "engine replacement",
  "foreign volume",
  "conflicting native label",
] as const) {
  test(`saved original ownership refuses ${changed} before a lease callback`, async () => {
    const { store, generation } = await prepared();
    try {
      if (changed === "volume missing") {
        fixture.volume = [];
      }
      if (changed === "volume replacement") {
        volume().createdAt = "2026-02-02T01:02:03Z";
      }
      if (changed === "container replacement") {
        container().id = "c".repeat(64);
      }
      if (changed === "network replacement") {
        network().id = "c".repeat(64);
      }
      if (changed === "engine replacement") {
        fixture.engine = "different-engine";
      }
      if (changed === "foreign volume") {
        volume().project = "foreign";
      }
      if (changed === "conflicting native label") {
        volume().native = "1";
      }
      await save();
      let calls = 0;
      await refusal(
        store.withLease({
          generation,
          run: async () => {
            calls++;
          },
        })
      );
      expect(calls).toBe(0);
    } finally {
      await store.close();
    }
  });
}

for (const changed of [
  "content",
  "symlink",
  "hardlink",
  "permissions",
  "replacement",
] as const) {
  test(`saved immutable candidate ${changed} refuses before a callback`, async () => {
    const { store, generation } = await prepared();
    try {
      const path = await artifactPath("candidate.json");
      const original = await readFile(path);
      if (changed === "content") {
        await writeFile(path, `${original.toString()} `);
      }
      if (changed === "permissions") {
        await chmod(path, 0o644);
      }
      if (changed === "hardlink") {
        await link(path, join(root, "extra-candidate-link"));
      }
      if (changed === "symlink") {
        await rename(path, join(root, "candidate-original"));
        await symlink(join(root, "candidate-original"), path);
      }
      if (changed === "replacement") {
        await rename(path, join(root, "candidate-original"));
        await writeFile(path, original, { mode: 0o600 });
      }
      let calls = 0;
      await refusal(
        store.withLease({
          generation,
          run: async () => {
            calls++;
          },
        })
      );
      expect(calls).toBe(0);
    } finally {
      await store.close();
    }
  });
}

test("source change during compiler admission cannot commit a prepared generation", async () => {
  const store = await openLegacyComposeAdoptedGenerationStore({ projectRoot });
  const source = join(projectRoot, ".hack/docker-compose.yml");
  try {
    const binary = await compiler(
      `await Bun.write(${JSON.stringify(source)}, raw + "\\n");`
    );
    await refusal(store.prepare({ binary }));
    expect(await store.loadPrepared()).toBeNull();
    expect(
      await Bun.file(join(projectRoot, ".hack/hack.project.json")).exists()
    ).toBe(false);
  } finally {
    await store.close();
  }
});

test("compiler refusal cannot commit a partially converted candidate", async () => {
  const store = await openLegacyComposeAdoptedGenerationStore({ projectRoot });
  try {
    const binary = await compiler(
      "console.error('synthetic-private-adoption-canary');process.exit(27);"
    );
    await refusal(store.prepare({ binary }));
    expect(await store.loadPrepared()).toBeNull();
  } finally {
    await store.close();
  }
});

test("saved receipt and duplicate fields remain strict and bound to this checkout", async () => {
  const { store } = await prepared();
  try {
    const path = join(stateRoot(), "receipt.json");
    const original = await readFile(path, "utf8");
    await writeFile(
      path,
      original.replace(
        '"adoption_receipt_version":1',
        '"adoption_receipt_version":9,"adoption_receipt_version":1'
      )
    );
    await refusal(store.loadPrepared());
  } finally {
    await store.close();
  }
});

test("leased original data refuses replacement after the callback without changing engine resources", async () => {
  const { store, generation } = await prepared();
  try {
    let calls = 0;
    await refusal(
      store.withLease({
        generation,
        run: async () => {
          calls++;
          volume().createdAt = "2026-02-02T01:02:03Z";
          await save();
        },
      }),
      "E_LEGACY_ADOPTION_CHANGED"
    );
    expect(calls).toBe(1);
  } finally {
    await store.close();
  }
});

test("forged and superseded public claims grant no private lease", async () => {
  const { store, generation } = await prepared();
  try {
    let calls = 0;
    await refusal(
      store.withLease({
        generation: { ...generation },
        run: async () => {
          calls++;
        },
      })
    );
    const newer = await store.prepare({ binary: await compiler() });
    await refusal(
      store.withLease({
        generation,
        run: async () => {
          calls++;
        },
      })
    );
    await store.withLease({
      generation: newer,
      run: async () => {
        calls++;
      },
    });
    expect(calls).toBe(1);
  } finally {
    await store.close();
  }
});

test("saved open with no state creates no private adoption paths", async () => {
  await refusal(
    openLegacyComposeAdoptedGenerationStore({ projectRoot, mode: "saved" })
  );
  expect(await Bun.file(stateRoot()).exists()).toBe(false);
});

test("original cancellation and immutable caller options protect later store use", async () => {
  const controller = new AbortController();
  const opts = { projectRoot, signal: controller.signal };
  const store = await openLegacyComposeAdoptedGenerationStore(opts);
  opts.projectRoot = join(root, "wrong-private-root");
  try {
    expect(await store.loadPrepared()).toBeNull();
    controller.abort(CANARY);
    await refusal(
      store.prepare({ binary: await compiler() }),
      "E_LEGACY_ADOPTION_CANCELLED"
    );
  } finally {
    await store.close();
  }
});

async function readReceipt() {
  return JSON.parse(await readFile(join(stateRoot(), "receipt.json"), "utf8"));
}
async function writeReceipt(value: unknown) {
  await writeFile(join(stateRoot(), "receipt.json"), JSON.stringify(value), {
    mode: 0o600,
  });
}
async function originalSnapshots() {
  return Promise.all(
    ["hack.config.json", "docker-compose.yml"].map(async (name) => {
      const path = join(projectRoot, ".hack", name);
      return {
        name,
        text: await readFile(path, "utf8"),
        info: await lstat(path),
      };
    })
  );
}
async function expectOriginals(
  originals: Awaited<ReturnType<typeof originalSnapshots>>
) {
  for (const original of originals) {
    const path = join(projectRoot, ".hack", original.name);
    expect(await readFile(path, "utf8")).toBe(original.text);
    const info = await lstat(path);
    expect([info.dev, info.ino, info.mode, info.nlink]).toEqual([
      original.info.dev,
      original.info.ino,
      original.info.mode,
      1,
    ]);
  }
  expect(
    await Bun.file(join(projectRoot, ".hack/hack.project.json")).exists()
  ).toBe(false);
}

test("explicit stopped publication and rollback preserve exact original files and resource identities", async () => {
  const original = await originalSnapshots();
  const { store, generation } = await prepared();
  try {
    const binary = await compiler();
    await store.publish({ generation, binary });
    expect((await store.loadActive())?.report.status).toBe("active");
    expect(
      await Bun.file(join(projectRoot, ".hack/hack.config.json")).exists()
    ).toBe(false);
    expect(
      await Bun.file(join(projectRoot, ".hack/docker-compose.yml")).exists()
    ).toBe(false);
    expect((await readReceipt()).publication.phase).toBe("active");
    expect(
      await readFile(join(projectRoot, ".hack/hack.project.json"), "utf8")
    ).toBe(await readFile(await artifactPath("candidate.json"), "utf8"));
    expect(fixture.container[0]?.id).toBe(ID);
    expect(fixture.volume[0]?.createdAt).toBe(CREATED);
    await store.rollback();
    expect((await readReceipt()).publication.phase).toBe("rolled-back");
    await expectOriginals(original);
    expect(await store.loadActive()).toBeNull();
  } finally {
    await store.close();
  }
});

for (const boundary of [
  "journal",
  "one-original",
  "both-originals",
  "candidate-pair",
  "candidate-anchored-pair",
  "candidate-anchored-single",
] as const) {
  for (const action of ["complete", "rollback"] as const) {
    test(`repair ${action} resumes an interrupted switch at ${boundary}`, async () => {
      const original = await originalSnapshots();
      const { store } = await prepared();
      try {
        const receipt = await readReceipt(),
          originals = await artifactPath("originals");
        receipt.publication = {
          generation: receipt.prepared,
          phase: "switching",
          native: null,
        };
        await writeReceipt(receipt);
        if (boundary !== "journal") {
          await rename(
            join(projectRoot, ".hack/hack.config.json"),
            join(originals, "legacy-config.original")
          );
        }
        if (!["journal", "one-original"].includes(boundary)) {
          await rename(
            join(projectRoot, ".hack/docker-compose.yml"),
            join(originals, "legacy-compose.original")
          );
        }
        if (boundary.startsWith("candidate")) {
          const candidateText = await readFile(
              await artifactPath("candidate.json"),
              "utf8"
            ),
            staged = join(originals, "native.publish"),
            active = join(projectRoot, ".hack/hack.project.json");
          await writeFile(staged, candidateText, { mode: 0o600 });
          await link(staged, active);
          if (boundary.startsWith("candidate-anchored")) {
            const info = await lstat(active);
            receipt.publication.native = {
              dev: info.dev,
              ino: info.ino,
              hash: (await import("node:crypto"))
                .createHash("sha256")
                .update(candidateText)
                .digest("hex"),
            };
            await writeReceipt(receipt);
          }
          if (boundary === "candidate-anchored-single") {
            await rm(staged);
          }
        }
        await refusal(store.loadPrepared(), "E_LEGACY_ADOPTION_BUSY");
        await store.repairPublication({ action, binary: await compiler() });
        expect((await readReceipt()).publication.phase).toBe(
          action === "complete" ? "active" : "rolled-back"
        );
        if (action === "complete") {
          await store.rollback();
        }
        await expectOriginals(original);
      } finally {
        await store.close();
      }
    });
  }
}

test("publication refuses a running original, changed source inode and config-hash drift before selection changes", async () => {
  const original = await originalSnapshots();
  const { store, generation } = await prepared();
  try {
    const binary = await compiler();
    fixture.running = true;
    await save();
    await refusal(
      store.publish({ generation, binary }),
      "E_LEGACY_ADOPTION_UNSUPPORTED"
    );
    fixture.running = false;
    fixture.configHash = "e".repeat(64);
    await save();
    await refusal(store.publish({ generation, binary }));
    fixture.configHash = "d".repeat(64);
    await save();
    const path = join(projectRoot, ".hack/hack.config.json");
    await rename(path, `${path}.old`);
    await writeFile(path, original[0]?.text ?? "");
    await refusal(
      store.publish({ generation, binary }),
      "E_LEGACY_ADOPTION_CHANGED"
    );
    expect((await readReceipt()).publication).toBeNull();
    expect(
      await Bun.file(join(projectRoot, ".hack/hack.project.json")).exists()
    ).toBe(false);
  } finally {
    await store.close();
  }
});

test("active candidate edits and rollback conflicts retain pending evidence and refuse overwriting external bytes", async () => {
  const { store, generation } = await prepared();
  try {
    await store.publish({ generation, binary: await compiler() });
    const active = join(projectRoot, ".hack/hack.project.json");
    await writeFile(active, CANARY);
    await refusal(store.loadActive());
    await refusal(store.rollback());
    expect(await readFile(active, "utf8")).toBe(CANARY);
    expect((await readReceipt()).publication.phase).toBe("active");
  } finally {
    await store.close();
  }
});

test("dry-run reports storage provenance and existing counts without state, source values or engine effects", async () => {
  const report = await previewLegacyComposeAdoption({
    projectRoot,
    binary: await compiler(),
  });
  expect(report.complete).toBe(true);
  expect(report).toMatchObject({
    containers: 1,
    volumes: 1,
    adoption: "not_performed",
  });
  expect(
    report.fields.some((field) => field.pointer === "/volumes/data/name")
  ).toBe(true);
  for (const value of [
    CANARY,
    VOLUME,
    ID,
    NETWORK,
    projectRoot,
    "hash",
    "revision",
  ]) {
    expect(JSON.stringify(report)).not.toContain(value);
  }
  expect(await Bun.file(stateRoot()).exists()).toBe(false);
  expect(await Bun.file(join(root, "mutation")).exists()).toBe(false);
});

test("CLI adoption refuses other backends before probes, preparation or engine effects", async () => {
  for (const flags of [[], ["--dry-run"], ["--stop"], ["--recover"]]) {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../index.ts"),
        "config",
        "adopt",
        "--path",
        projectRoot,
        ...flags,
      ],
      {
        env: {
          ...process.env,
          HACK_RUNTIME_BACKEND: "native",
          HACK_HOME: join(root, "isolated-home"),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).not.toBe(0);
    expect(stdout + stderr).toContain("Compose backend");
    expect(stdout + stderr).not.toContain(CANARY);
    expect(await Bun.file(join(root, "commands")).exists()).toBe(false);
    expect(await Bun.file(stateRoot()).exists()).toBe(false);
  }
});

test("upgraded discovery refuses an interrupted switch before ancestor selection or legacy writes", async () => {
  const { store } = await prepared();
  try {
    const receipt = await readReceipt();
    receipt.publication = {
      generation: receipt.prepared,
      phase: "switching",
      native: null,
    };
    await writeReceipt(receipt);
    await rename(
      join(projectRoot, ".hack/hack.config.json"),
      await artifactPath("originals/legacy-config.original")
    );
    const nested = join(projectRoot, "nested");
    await mkdir(nested);
    expect(await inspectLegacyComposeAdoptionSelection({ projectRoot })).toBe(
      "pending"
    );
    await expect(discoverProjectInputs({ startDir: nested })).rejects.toThrow(
      "interrupted"
    );
    await expect(
      assertLegacyProjectInputFamily({ projectRoot })
    ).rejects.toThrow("interrupted");
    expect(await Bun.file(join(root, "mutation")).exists()).toBe(false);
  } finally {
    await store.close();
  }
});

test("failed retained-container effects stay pending and only explicit verified stop recovery clears them", async () => {
  const { store, generation } = await prepared();
  try {
    const binary = await compiler();
    await store.publish({ generation, binary });
    const code = await store.withMutation({
      generation,
      binary,
      operation: "start",
      services: [],
      run: async () => {
        expect((await readReceipt()).pendingOperation).toMatchObject({
          operation: "start",
          services: ["db"],
        });
        fixture.running = true;
        await save();
        return 7;
      },
    });
    expect(code).toBe(7);
    await refusal(store.loadActive(), "E_LEGACY_ADOPTION_BUSY");
    await refusal(store.rollback(), "E_LEGACY_ADOPTION_BUSY");
    expect(await inspectLegacyComposeAdoptionSelection({ projectRoot })).toBe(
      "pending"
    );
    const recovery = await store.loadActive({ recoverOperation: true });
    if (!recovery) {
      throw new Error("missing recovery claim");
    }
    await refusal(
      store.withMutation({
        generation: recovery,
        binary,
        operation: "start",
        services: [],
        recover: true,
        run: async () => 0,
      })
    );
    await store.withMutation({
      generation: recovery,
      binary,
      operation: "stop",
      services: [],
      recover: true,
      run: async () => {
        fixture.running = false;
        await save();
        return 0;
      },
    });
    expect((await readReceipt()).pendingOperation).toBeNull();
    await store.rollback();
  } finally {
    await store.close();
  }
});

test("post-effect resource loss cannot acknowledge success or enable automatic replay", async () => {
  const { store, generation } = await prepared();
  try {
    const binary = await compiler();
    await store.publish({ generation, binary });
    await refusal(
      store.withMutation({
        generation,
        binary,
        operation: "start",
        services: ["db"],
        run: async () => {
          fixture.running = true;
          fixture.volume = [];
          await save();
          return 0;
        },
      })
    );
    expect((await readReceipt()).pendingOperation.operation).toBe("start");
    await refusal(store.loadActive());
  } finally {
    await store.close();
  }
});

test("retained command dispatch uses only original IDs and keeps anchors through stop and recovery", async () => {
  const original = await originalSnapshots(),
    { store, generation } = await prepared();
  const priorCompiler = process.env.HACK_CONFIG_COMPILER_BINARY;
  try {
    const binary = await compiler();
    process.env.HACK_CONFIG_COMPILER_BINARY = binary;
    await store.publish({ generation, binary });
    const options = {
      cwd: projectRoot,
      operation: "up" as const,
      detach: true,
    };
    expect(await tryLegacyComposeAdoptedCommand(options)).toBe(0);
    expect(
      JSON.parse(await readFile(join(root, "fixture.json"), "utf8")).running
    ).toBe(true);
    expect(
      await tryLegacyComposeAdoptedCommand({
        cwd: projectRoot,
        operation: "exec",
        service: "db",
        command: ["true"],
      })
    ).toBe(0);
    await expect(
      tryLegacyComposeAdoptedCommand({
        cwd: projectRoot,
        operation: "run",
        service: "db",
        command: ["true"],
      })
    ).rejects.toThrow("Recreation");
    expect(
      await tryLegacyComposeAdoptedCommand({
        cwd: projectRoot,
        operation: "down",
      })
    ).toBe(0);
    fixture = JSON.parse(await readFile(join(root, "fixture.json"), "utf8"));
    expect(fixture.container[0]?.id).toBe(ID);
    expect(fixture.volume[0]?.createdAt).toBe(CREATED);
    fixture.mutationFailure = true;
    await save();
    expect(await tryLegacyComposeAdoptedCommand(options)).toBe(7);
    await expect(tryLegacyComposeAdoptedCommand(options)).rejects.toThrow(
      "busy"
    );
    fixture = JSON.parse(await readFile(join(root, "fixture.json"), "utf8"));
    fixture.mutationFailure = undefined;
    await save();
    expect(
      await tryLegacyComposeAdoptedCommand({
        cwd: projectRoot,
        operation: "down",
        recover: true,
      })
    ).toBe(0);
    await store.rollback();
    await expectOriginals(original);
    const commands = (await readFile(join(root, "commands"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      commands
        .filter((args) => ["start", "stop", "restart"].includes(args[1]))
        .every((args) => args.join(" ").endsWith(ID))
    ).toBe(true);
    expect(
      commands.some(
        (args) =>
          args.includes("rm") ||
          args.includes("up") ||
          args.includes("down") ||
          args.includes("create")
      )
    ).toBe(false);
  } finally {
    restoreEnv("HACK_CONFIG_COMPILER_BINARY", priorCompiler);
    await store.close();
  }
});

test("receipt changes during compile cannot overwrite a newer owner decision", async () => {
  const store = await openLegacyComposeAdoptedGenerationStore({ projectRoot });
  try {
    const body = `const receiptFile=${JSON.stringify(join(stateRoot(), "receipt.json"))}; const owner=JSON.parse(await Bun.file(receiptFile).text()); await Bun.write(receiptFile, JSON.stringify(owner)+' ');`;
    await refusal(store.prepare({ binary: await compiler(body) }));
    expect((await readReceipt()).prepared).toBeNull();
  } finally {
    await store.close();
  }
});

test("explicit preparation stop journals before effect and running dry-run needs the stop request", async () => {
  fixture.running = true;
  await save();
  const binary = await compiler();
  expect(
    (await previewLegacyComposeAdoption({ projectRoot, binary })).complete
  ).toBe(false);
  expect(
    await previewLegacyComposeAdoption({ projectRoot, binary, stop: true })
  ).toMatchObject({
    complete: true,
    stop: "requested",
    adoption: "not_performed",
  });
  expect(await Bun.file(stateRoot()).exists()).toBe(false);
  const { store, generation } = await prepared();
  try {
    await refusal(
      store.publish({ generation, binary }),
      "E_LEGACY_ADOPTION_UNSUPPORTED"
    );
    let calls = 0;
    await store.withPreparationStop({
      generation,
      binary,
      run: async (input) => {
        expect(
          input.binding.containers.map((container) => container.id)
        ).toEqual([ID]);
        expect((await readReceipt()).pendingOperation).toMatchObject({
          operation: "stop",
          services: ["db"],
        });
        expect(
          await inspectLegacyComposeAdoptionSelection({ projectRoot })
        ).toBe("pending");
        calls++;
        fixture.running = false;
        await save();
        return 0;
      },
    });
    expect(calls).toBe(1);
    expect((await readReceipt()).pendingOperation).toBeNull();
    await store.publish({ generation, binary });
    await store.rollback();
  } finally {
    await store.close();
  }
});

test("partial preparation stop retains originals and only explicit all-container recovery enables adoption", async () => {
  const second = "c".repeat(64),
    originalCompose = join(projectRoot, ".hack/docker-compose.yml");
  const text = await readFile(originalCompose, "utf8"),
    insert = text.lastIndexOf("volumes:\n  data:");
  await writeFile(
    originalCompose,
    `${text.slice(0, insert)}  worker:\n    image: ${CANARY}\n    volumes:\n      - data:/var/lib/database\n${text.slice(insert)}`
  );
  fixture.container.push({
    ...container(),
    id: second,
    name: "/fixture-worker-1",
    service: "worker",
  });
  network().containers = [ID, second];
  fixture.states = { [ID]: true, [second]: true };
  await save();
  const original = await originalSnapshots(),
    { store, generation } = await prepared();
  try {
    const binary = await compiler();
    expect(
      await store.withPreparationStop({
        generation,
        binary,
        run: async () => {
          fixture.states = { [ID]: false, [second]: true };
          await save();
          return 7;
        },
      })
    ).toBe(7);
    await refusal(store.loadPrepared(), "E_LEGACY_ADOPTION_BUSY");
    await refusal(
      store.publish({ generation, binary }),
      "E_LEGACY_ADOPTION_BUSY"
    );
    await expectOriginals(original);
    const recovered = await store.loadPrepared({ recoverOperation: true });
    if (!recovered) {
      throw new Error("missing stopped recovery generation");
    }
    await store.withPreparationStop({
      generation: recovered,
      binary,
      recover: true,
      run: async (input) => {
        expect(
          input.binding.containers.map((container) => container.id).sort()
        ).toEqual([ID, second]);
        fixture.states = { [ID]: false, [second]: false };
        await save();
        return 0;
      },
    });
    expect((await readReceipt()).pendingOperation).toBeNull();
    await store.publish({ generation: recovered, binary });
    await store.rollback();
    await expectOriginals(original);
    expect(fixture.volume[0]?.createdAt).toBe(CREATED);
  } finally {
    await store.close();
  }
});

test("preparation stop refuses changed source, forged claims and config drift before callback", async () => {
  const { store, generation } = await prepared();
  try {
    const binary = await compiler();
    let calls = 0;
    const run = async () => {
      calls++;
      return await Promise.resolve(0);
    };
    await refusal(
      store.withPreparationStop({ generation: { ...generation }, binary, run })
    );
    fixture.configHash = "e".repeat(64);
    await save();
    await refusal(store.withPreparationStop({ generation, binary, run }));
    fixture.configHash = "d".repeat(64);
    await save();
    await writeFile(
      join(projectRoot, ".hack/hack.config.json"),
      '{"name":"changed-private"}'
    );
    await refusal(
      store.withPreparationStop({ generation, binary, run }),
      "E_LEGACY_ADOPTION_CHANGED"
    );
    expect(calls).toBe(0);
    expect((await readReceipt()).pendingOperation).toBeNull();
  } finally {
    await store.close();
  }
});
