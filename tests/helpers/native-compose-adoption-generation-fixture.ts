import { afterEach, beforeEach, test as boundedTest, expect } from "bun:test";
import {
  chmod,
  lstat,
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
  renderComposeEnvReferenceOverride,
  renderManagedComposeEnvOverride,
} from "../../src/lib/compose-managed-env.ts";
import { DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS } from "../../src/lib/compose-startup-budget.ts";
import {
  LegacyComposeAdoptedGenerationError,
  openLegacyComposeAdoptedGenerationStore,
} from "../../src/lib/native-compose-adoption-generation.ts";
import { inspectLegacyComposeAdoptionSelection } from "../../src/lib/native-compose-adoption-marker.ts";
import { defaultProjectSlugFromPath } from "../../src/lib/project.ts";
import { setProjectEnvValue } from "../../src/lib/project-env-config.ts";
import { buildRuntimeHostMetadataOverride } from "../../src/lib/runtime-host-metadata.ts";
import type { captureAdoptionDependencyFirstPrepare } from "../e2e/scenarios/native-compose-adoption-dependency-staged-read.ts";
import { completedJobFixtureSources } from "../e2e/scenarios/native-compose-adoption-job-inputs.ts";
import { createCompletedJobFixtureSettlement } from "../e2e/scenarios/native-compose-adoption-job-worktrees.ts";
import { restoreEnv } from "./env.ts";
import { managedEnvCompilerFixture } from "./managed-env-compiler.ts";
import { privateCliEnv } from "./private-cli-env.ts";
/** Each test file owns a fixture closure; hooks never share mutable state across files. */
export function createAdoptionGenerationFixture() {
  /**
   * The test budget of a case that prepares, publishes, reads or rolls back a
   * saved adoption, or runs a CLI adoption command, without waiting on a retained
   * operation's deadline. Every engine and compiler query is a cold Bun process.
   * With every limit lifted, the slowest such case took 27 s under synthetic CPU
   * load (load average about 90 on 20 cores); the former 20 s and 30 s limits
   * timed out there (HACK-1319). This is about four times that.
   */
  const ADOPTION_CASE_TIMEOUT_MS = 120_000;

  /**
   * The aggregate deadline a test gives each retained operation it runs: the
   * deadline the public adopted command gives one
   * (`DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS`). It replaces a 20 s literal that a
   * loaded host could exhaust before a healthy operation finished (HACK-1319).
   * Tests of deadline expiry name {@link EXPIRING_OPERATION_DEADLINE_MS} instead.
   */
  const RETAINED_OPERATION_DEADLINE_MS = DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS;

  /**
   * The test budget of a case that runs `operations` retained operations (direct
   * or through the public adopted command), each bounded by
   * {@link RETAINED_OPERATION_DEADLINE_MS}, after its own adoption work. A slow
   * host therefore ends in the operation's own closed refusal before Bun's
   * timeout. A Bun timeout is worse than a failure here: the timed-out owner may
   * still be running, so every later case in this file refuses to start.
   */
  function retainedOperationCaseTimeout(operations: number): number {
    return (
      ADOPTION_CASE_TIMEOUT_MS + operations * RETAINED_OPERATION_DEADLINE_MS
    );
  }

  /**
   * The aggregate deadline of a case that proves expiry. Work before its callback
   * must fit inside it, so it covers the pre-callback freshness probes under
   * load, and a held probe must still be ended by it rather than by the fake
   * child's 60 s sleep (HACK-1319; formerly 5 s).
   */
  const EXPIRING_OPERATION_DEADLINE_MS = 15_000;

  /** How late after its deadline an expired operation may refuse under load. */
  const DEADLINE_REFUSAL_SLACK_MS = 5000;

  /**
   * How soon after its abort a cancelled retained effect must refuse. It stays
   * far below the effect child's 60 s sleep and the operation's deadline, so only
   * the cancellation can end the effect in time.
   */
  const CANCELLED_EFFECT_REFUSAL_BOUND_MS = 10_000;

  // Unnamed cases are saved-adoption cases (see ADOPTION_CASE_TIMEOUT_MS).
  const test = (name: string, run: () => Promise<void>) =>
    boundedTest(name, run, ADOPTION_CASE_TIMEOUT_MS);

  const CANARY = "synthetic-private-adoption-canary";

  /**
   * Budget for a rollback-recovery test that runs several saved adoption reads,
   * rollbacks or CLI adoption commands; adoption tests are load-sensitive on
   * shared hosts (HACK-1367). The slowest took 49 s under the load above.
   */
  const ROLLBACK_RECOVERY_BUDGET_MS = 240_000;

  const ID = "a".repeat(64);

  const NETWORK = "b".repeat(64);

  const VOLUME = "original_private_database";

  const CREATED = "2026-01-01T01:02:03Z";

  /**
   * Synthetic engine config hash over every `${NAME}` reference in the selected
   * Compose files, resolved from the Compose process env (blank when unset), as
   * the engine does when it labels a container. The stub engine below computes
   * the same digest from its own argv and environment.
   */
  async function composeReferenceHash(opts: {
    readonly files: readonly string[];
    readonly env: Readonly<Record<string, string>>;
  }): Promise<string> {
    const names: string[] = [];
    for (const file of opts.files) {
      for (const match of (await readFile(file, "utf8")).matchAll(
        /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
      )) {
        names.push(match[1] ?? "");
      }
    }
    return new Bun.CryptoHasher("sha256")
      .update(JSON.stringify(names.map((name) => [name, opts.env[name] ?? ""])))
      .digest("hex");
  }

  type Fixture = {
    engine: string;
    container: Record<string, unknown>[];
    volume: Record<string, unknown>[];
    network: Record<string, unknown>[];
    mode?: string;
    configHash?: string;
    /** Hash Compose references like the engine: with the values in the Compose env. */
    envConfigHash?: boolean;
    running?: boolean;
    mutationFailure?: boolean;
    states?: Record<string, boolean>;
    health?: Record<string, string>;
    ordered?: boolean;
    jobs?: Record<
      string,
      {
        startedAt: string;
        finishedAt: string;
        exitCode: number;
        attempts: number;
      }
    >;
    jobFinalRace?: boolean;
    jobObservation?:
      | "shape"
      | "timestamp"
      | "restart-policy"
      | "membership"
      | "probe";
    jobRestartPolicy?: "" | "no" | "always";
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

  let priorRuntimeBackend: string | undefined;

  let fixture: Fixture;

  let publicStatic7Commands = 0;

  const publicStatic7Settlement = createCompletedJobFixtureSettlement();

  beforeEach(async () => {
    // An outer test timeout does not cancel an awaited owner. Never recycle its globals or roots.
    publicStatic7Settlement.assertConfirmed();
    priorPath = process.env.PATH;
    priorCI = process.env.CI;
    priorExecutionMode = process.env.HACK_EXECUTION_MODE;
    priorRuntimeBackend = process.env.HACK_RUNTIME_BACKEND;
    process.env.HACK_RUNTIME_BACKEND = "compose";
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
import {appendFileSync, readFileSync, renameSync, writeFileSync} from "node:fs";
const root = ${JSON.stringify(root)};
// Publish a hanging child's PID by rename: a child killed mid-write must never leave an empty file (HACK-1319).
const publishPid = (name) => {writeFileSync(root + "/" + name + ".tmp", String(process.pid));renameSync(root + "/" + name + ".tmp", root + "/" + name);};
const args = process.argv.slice(2);
appendFileSync(root + "/commands", JSON.stringify(args) + "\\n");
const fixture = JSON.parse(readFileSync(root + "/fixture.json", "utf8"));
const [kind, action] = args;
if(fixture.dependencyReadScope && !(kind === 'container' && ['start','stop','restart'].includes(action))) {
 const {adoptionDependencyReadAllowed}=await import(${JSON.stringify(new URL("../e2e/scenarios/native-compose-adoption-dependency-inputs.ts", import.meta.url).pathname)});
 const {adoptionDependencyStagedReadAllowed}=await import(${JSON.stringify(new URL("../e2e/scenarios/native-compose-adoption-dependency-staged-read.ts", import.meta.url).pathname)});
 let saved=null;try {saved=JSON.parse(readFileSync(fixture.dependencyReadScope.projectRoot+'/.hack/.internal/legacy-compose-adoption-v1/receipt.json','utf8'));}catch{}
 const allowed=adoptionDependencyReadAllowed({args,projectRoot:fixture.dependencyReadScope.projectRoot,project:'fixture',containerIds:fixture.container.map(row=>row.id),networkId:fixture.network[0].id,volumeName:fixture.volume[0].id,generationId:saved?.prepared?.id ?? saved?.publication?.generation?.id}) || (fixture.dependencyReadScope.allowFirstPrepare && await adoptionDependencyStagedReadAllowed({args,project:'fixture',first:fixture.dependencyReadScope.first}));
 const stage=kind==='compose' && args[10]?.includes('/generations/') ? saved?.prepared ? 'published' : 'staged' : 'original';
 appendFileSync(root+'/read-stages',JSON.stringify({stage,allowed})+'\\n');
 if(!allowed){console.error('dependency-read-refused stage='+stage+' code=93');process.exit(93);}
}
if (kind === 'container' && ['start','restart','stop'].includes(action)) {
 if (!args.slice(2).length || args.slice(2).some(id => !fixture.container.some(container => container.id === id))) { writeFileSync(root + '/mutation','unverified effect');process.exit(99); }
 if(fixture.hangMutation) {publishPid('effect-started');await Bun.sleep(60_000);}
 if (fixture.ordered) {for(const id of args.slice(2)) fixture.states[id] = action !== 'stop';}
 else fixture.running = action !== 'stop';
 if(fixture.jobs) for(const id of args.slice(2)) if(fixture.jobs[id]) {
  fixture.states[id]=false;
  if(action==='start') {fixture.jobs[id].attempts++;fixture.jobs[id].startedAt='2026-10-08T00:00:02.'+String(fixture.jobs[id].attempts).padStart(9,'0')+'Z';fixture.jobs[id].finishedAt='2026-10-08T00:00:03Z';}
 }
 if (fixture.aliases) {for(const id of args.slice(2)) {const row=fixture.container.find(container=>container.id===id);if(row) row.networks[0].aliases=action==='stop'?[]:[row.name.slice(1),row.service,...(fixture.aliases[row.service]??[])];}}
 if (fixture.foreignAfterFirstStart && action==='start' && args.includes(${JSON.stringify(ID)})) {fixture.network[0].containers.push('e'.repeat(64));delete fixture.foreignAfterFirstStart;}
 if(fixture.sourceRace) { writeFileSync(${JSON.stringify(join(projectRoot, ".hack/hack.project.json"))}, 'synthetic-private-source-race'); }
 writeFileSync(root+'/fixture.json',JSON.stringify(fixture));process.exit(fixture.mutationFailure ? 7 : 0);
}
if (kind === 'container' && ['exec','logs'].includes(action)) { process.exit(0); }
if (kind === "compose") {
 let hash = 'd'.repeat(64);
 if (fixture.envConfigHash) { const names = args.flatMap((arg, index) => args[index - 1] === '--file' ? [...readFileSync(arg, 'utf8').matchAll(/\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}/g)].map((match) => match[1]) : []); hash = new Bun.CryptoHasher('sha256').update(JSON.stringify(names.map((name) => [name, process.env[name] ?? '']))).digest('hex'); }
 for (const container of fixture.container) console.log(container.service + ' ' + hash); process.exit(0);
}
if (!(kind === "info" && action === "--format") && (!['container','volume','network'].includes(kind) || !['ls','inspect'].includes(action) || !args.includes('--format'))) {writeFileSync(root + "/mutation", "unauthorized command");process.exit(99);}
if (fixture.mode === "fail") {console.error(${JSON.stringify(CANARY)});process.exit(29);}
if (fixture.mode === "malformed") {console.log(${JSON.stringify(CANARY)});process.exit(0);}
if (fixture.mode === "hang") {publishPid("started");await Bun.sleep(60_000);}
if (fixture.mode === "hang-state" && kind === "container" && action === "inspect" && args.join().includes('.State.Running') && !args.join().includes('.Mounts')) {publishPid("started");await Bun.sleep(60_000);}
if (fixture.mode === "overflow") {await Bun.write(Bun.stdout, "x".repeat(9 * 1024 * 1024));process.exit(0);}
if (fixture.mode === "stderr-overflow") {await Bun.write(Bun.stderr, "x".repeat(17 * 1024));process.exit(0);}
if (kind === "info") {console.log(JSON.stringify({id: fixture.engine, os: "linux"}));}
else if (action === "ls") {for (const row of fixture[kind]) console.log(JSON.stringify({id: row.id, name: kind === 'container' ? row.name.slice(1) : row.name, project: row.project ?? ""}));}
else {
 if(args.join().includes('.State.Health')) {console.error('map has no entry for key Health');process.exit(49);}
 for (const id of args.slice(4)) {
 const rows = fixture[kind].filter(row => row.id === id);
 if (!rows.length) process.exit(1);
 if (kind === "container" && args.join().includes('config-hash')) { console.log(JSON.stringify({id,hash:fixture.configHash ?? 'd'.repeat(64)})); continue; }
 if (kind === "container" && args.join().includes('.State.Running') && !args.join().includes('.Mounts')) { const running=fixture.states?.[id] ?? fixture.running ?? false;
  if(args.join().includes('.State.ExitCode')) {
   if(fixture.jobObservation==='probe') {console.error(${JSON.stringify(CANARY)});process.exit(29);}
   if(fixture.jobFinalRace) writeFileSync(${JSON.stringify(join(projectRoot, ".hack/hack.project.json"))}, 'synthetic-private-final-job-race');
   const observed={id,running,paused:false,status:running?'running':'exited',health:fixture.health?.[id]??'',exitCode:fixture.jobs?.[id]?.exitCode??0,startedAt:fixture.jobs?.[id]?.startedAt??'2026-10-08T00:00:01Z',finishedAt:fixture.jobs?.[id]?.finishedAt??'2026-10-08T00:00:03Z',restartPolicy:fixture.jobRestartPolicy??'no',maximumRetryCount:0};
   if(fixture.jobObservation==='shape') delete observed.health;
   if(fixture.jobObservation==='timestamp') observed.startedAt=${JSON.stringify(CANARY)};
   if(fixture.jobObservation==='restart-policy') observed.restartPolicy=${JSON.stringify(CANARY)};
   if(fixture.jobObservation==='membership') observed.id='f'.repeat(64);
   console.log(JSON.stringify(observed)); continue;
  }
  console.log(JSON.stringify({id,running,paused:false,status:running ? 'running' : 'exited', ...(args.join().includes('index .State "Health"') ? {health: fixture.health?.[id] ?? ''} : {})})); continue; }
 for (const row of rows) {
  if (kind === 'container') console.log(JSON.stringify({...row,running:fixture.states?.[id] ?? fixture.running ?? false}));
  else if (kind === 'network') console.log(JSON.stringify({...row,containers:row.containers.filter(id=>!fixture.container.some(container=>container.id===id) || (fixture.states?.[id] ?? fixture.running ?? false))}));
  else console.log(JSON.stringify(row));
 }
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
    if (publicStatic7Commands !== 0) {
      publicStatic7Settlement.markUnconfirmed();
    }
    try {
      publicStatic7Settlement.assertConfirmed();
    } catch {
      // Retain the still-owned fixture; a late callback cannot restore teardown authority.
      return;
    }
    restoreEnv("PATH", priorPath);
    restoreEnv("CI", priorCI);
    restoreEnv("HACK_EXECUTION_MODE", priorExecutionMode);
    restoreEnv("HACK_RUNTIME_BACKEND", priorRuntimeBackend);
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

  async function prepared(binary?: string) {
    const store = await openLegacyComposeAdoptedGenerationStore({
      projectRoot,
    });
    try {
      const generation = await store.prepare({
        binary: binary ?? (await compiler()),
      });
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

  async function completedJobFixture() {
    const app = await dependencyFixture(),
      job = "e".repeat(64);
    await writeFile(
      join(projectRoot, ".hack/docker-compose.yml"),
      JSON.stringify({
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
            depends_on: {
              seed: { condition: "service_completed_successfully" },
            },
          },
        },
        volumes: { data: { name: VOLUME } },
      })
    );
    fixture.container.push({
      ...container(),
      id: job,
      name: "/fixture-seed-1",
      service: "seed",
      mounts: [],
    });
    network().containers = [ID, app, job];
    fixture.states = { [ID]: false, [app]: false, [job]: false };
    fixture.jobs = {
      [job]: {
        startedAt: "2026-10-08T00:00:01Z",
        finishedAt: "2026-10-08T00:00:01.5Z",
        exitCode: 0,
        attempts: 0,
      },
    };
    await save();
    return { app, job };
  }

  async function maintainedCompletedJobFixture() {
    const ids = await completedJobFixture();
    const authored = completedJobFixtureSources({
      name: "fixture",
      image: `sha256:${"d".repeat(64)}`,
      marker: "retained-seed",
    });
    await writeFile(
      join(projectRoot, ".hack/hack.config.json"),
      JSON.stringify(authored.config)
    );
    await writeFile(
      join(projectRoot, ".hack/docker-compose.yml"),
      JSON.stringify(authored.compose)
    );
    const originalVolume = fixture.volume[0];
    if (!originalVolume) {
      throw new Error("missing original volume");
    }
    originalVolume.id = "fixture_data";
    originalVolume.name = "fixture_data";
    for (const row of fixture.container) {
      if (row.id === ids.app) {
        row.service = "app";
        row.name = "/fixture-app-1";
      }
      row.mounts = [
        {
          type: "volume",
          name: "fixture_data",
          source: originalVolume.mountpoint,
          target: "/var/lib/postgresql/data",
          rw: row.service === "db",
        },
      ];
    }
    await save();
    return ids;
  }

  /** Transport stand-in for the maintained authored family; compiler semantic qualification remains separate. */
  async function maintainedJobCompiler() {
    const binary = join(root, "job-compiler");
    await writeFile(
      binary,
      `#!${process.execPath}
if(process.argv[2]==='--protocol') {console.log(JSON.stringify({transport_version:1, authored_version:1, plan_version:1, process_plan_version:1, acquisition_plan_version:1}));}
else {
 const raw=await Bun.stdin.text();const input=JSON.parse(raw);
 const workloads=(values)=>Object.fromEntries(Object.entries(values??{}).map(([name,value])=>{
  const next={...value};if(next.shutdown){if(next.shutdown.grace!=='3s') throw new Error('fixture shutdown mismatch');next.shutdown={...next.shutdown,grace:'3000ms'};}return[name,next];
 }));
 const plan={...input, plan_version:1, selected_profiles:[], services:workloads(input.services), jobs:workloads(input.jobs)};
 const declared_workloads=Object.fromEntries([...Object.keys(input.services).map(name=>[name,'service']),...Object.keys(input.jobs).map(name=>[name,'job'])]);
 console.log(JSON.stringify({transport_version:1,ok:true,plan,declared_workloads,semantic_hash:'a'.repeat(64)}));
}`
    );
    await chmod(binary, 0o700);
    return binary;
  }

  async function publicStatic7Case(run: () => Promise<void>) {
    publicStatic7Commands += 1;
    try {
      await run();
    } finally {
      publicStatic7Commands -= 1;
    }
  }

  function publicStatic7Stages() {
    const started = Date.now();
    return (
      phase: "prepare" | "publish" | "start" | "stop",
      status: "enter" | "settled"
    ) => {
      console.info(
        `static7-public phase=${phase} status=${status} elapsedMs=${Date.now() - started}`
      );
    };
  }

  /** Current writers keep references at rest; "literal" models a file an earlier
   * Hack version left, which neither adoption nor its publication may pin. */
  async function managedGenerated(form: "literal" | "reference" = "reference") {
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
    const projection = {
      targetServices: ["db"],
      globalEnv: { MANAGED: CANARY, EMPTY: "" },
      serviceEnv: { db: { MANAGED: CANARY, EMPTY: "" } },
    };
    const env =
      form === "reference"
        ? renderComposeEnvReferenceOverride(projection)?.text
        : renderManagedComposeEnvOverride(projection);
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

  /** A published v3 adoption over reference-form generated overrides. */
  async function publishedManagedAdoption() {
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
    const store = await openLegacyComposeAdoptedGenerationStore({
      projectRoot,
    });
    try {
      const generation = await store.prepare({ binary });
      await store.publish({ generation, binary });
    } finally {
      await store.close();
    }
    return files;
  }

  /**
   * A tracked managed checkout with a secret key, a managed value and a compiler
   * that the CLI adopts end to end once its env override is in reference form.
   * A refusal over the literal form can then come only from the literal check,
   * not from an incomplete fixture.
   */
  async function adoptableManagedFixture(form: "literal" | "reference") {
    Reflect.deleteProperty(process.env, "CI");
    Reflect.deleteProperty(process.env, "HACK_EXECUTION_MODE");
    await trackedManagedCheckout();
    const files = await managedGenerated(form);
    await writeFile(join(projectRoot, ".hack.secret.key"), "synthetic-cli-key");
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
    return { override: files[2] ?? "", binary };
  }

  /** Each command a fixed recovery step names, in order. */
  function namedAdoptCommands(message: string): string[][] {
    return [...message.matchAll(/'hack config adopt([^']*)'/g)].map((match) =>
      (match[1] ?? "").split(" ").filter(Boolean)
    );
  }

  /**
   * Runs the only command a pending-switch step names and asserts it finishes
   * the rollback: originals restored, the selection rolled back, and the
   * moved or restored override neither read into output nor rewritten.
   */
  async function runNamedRecoveryStep(opts: {
    readonly message: string;
    readonly binary: string;
    readonly original: Awaited<ReturnType<typeof originalSnapshots>>;
    readonly moved: {
      readonly path: string;
      readonly text: string;
      readonly ino: number;
    };
    readonly override: string;
  }) {
    const named = namedAdoptCommands(opts.message);
    expect(named).toEqual([["--recover", "--rollback"]]);
    const released = await adoptCli(
      [...(named[0] ?? []), "--json"],
      opts.binary
    );
    expect(released.code).toBe(0);
    expect(JSON.parse(released.stdout)).toMatchObject({
      status: "rolled-back",
    });
    expect(released.output).not.toContain(CANARY);
    await expectOriginals(opts.original);
    expect(await inspectLegacyComposeAdoptionSelection({ projectRoot })).toBe(
      "rolled-back"
    );
    expect(await readFile(opts.moved.path, "utf8")).toBe(opts.moved.text);
    expect((await lstat(opts.moved.path)).ino).toBe(opts.moved.ino);
    if (opts.moved.path !== opts.override) {
      expect(await lstat(opts.override).catch(() => null)).toBeNull();
    }
  }

  async function adoptCli(flags: readonly string[], binary: string) {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../../index.ts"),
        "config",
        "adopt",
        "--path",
        projectRoot,
        ...flags,
      ],
      {
        env: privateCliEnv({
          root,
          env: {
            HACK_HOME: join(root, "isolated-home"),
            HACK_CONFIG_COMPILER_BINARY: binary,
          },
        }),
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
    return { code, stdout, output: stdout + stderr };
  }

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
    await writeFile(
      join(projectRoot, ".hack/hack.config.json"),
      '{"name":"fixture","worktree":{"auto_branch":false}}\n'
    );
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

  async function linkedBranchCheckout() {
    await linkedCheckout();
    const composeText = await readFile(
      join(projectRoot, ".hack/docker-compose.yml"),
      "utf8"
    );
    await writeFile(
      join(projectRoot, ".hack/hack.config.json"),
      JSON.stringify({
        name: "fixture",
        dev_host: "fixture.test",
        worktree: { auto_branch: true },
      })
    );
    const physical = "fixture--linked";
    const fragment = buildRuntimeHostMetadataOverride({
      composeYamls: [composeText],
      branch: "linked",
      devHost: "fixture.test",
      aliasHost: null,
      composeProject: physical,
    });
    expect(fragment).toBeTruthy();
    await mkdir(join(projectRoot, ".hack/.branch"));
    const fragmentPath = join(
      projectRoot,
      ".hack/.branch/compose.linked.runtime.override.yml"
    );
    await writeFile(fragmentPath, fragment ?? "");
    container().name = `/${physical}-db-1`;
    container().project = physical;
    container().configFiles = `${join(projectRoot, ".hack/docker-compose.yml")},${fragmentPath}`;
    container().networks = [{ name: `${physical}_default`, id: NETWORK }];
    fixture.volume[0]!.project = physical;
    fixture.network[0]!.project = physical;
    fixture.network[0]!.name = `${physical}_default`;
    await save();
    return physical;
  }

  async function readReceipt() {
    return JSON.parse(
      await readFile(join(stateRoot(), "receipt.json"), "utf8")
    );
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
  return {
    ADOPTION_CASE_TIMEOUT_MS,
    RETAINED_OPERATION_DEADLINE_MS,
    retainedOperationCaseTimeout,
    EXPIRING_OPERATION_DEADLINE_MS,
    DEADLINE_REFUSAL_SLACK_MS,
    CANCELLED_EFFECT_REFUSAL_BOUND_MS,
    test,
    CANARY,
    ROLLBACK_RECOVERY_BUDGET_MS,
    ID,
    NETWORK,
    VOLUME,
    CREATED,
    composeReferenceHash,
    save,
    ownedBridge,
    twoOwnedBridges,
    container,
    volume,
    network,
    compiler,
    stateRoot,
    prepared,
    dependencyFixture,
    combinedBridgeHealthFixture,
    mutationCommands,
    completedJobFixture,
    maintainedCompletedJobFixture,
    maintainedJobCompiler,
    publicStatic7Case,
    publicStatic7Stages,
    managedGenerated,
    trackedManagedCheckout,
    publishedManagedAdoption,
    adoptableManagedFixture,
    namedAdoptCommands,
    runNamedRecoveryStep,
    adoptCli,
    artifactPath,
    refusal,
    linkedCheckout,
    linkedBranchCheckout,
    readReceipt,
    writeReceipt,
    originalSnapshots,
    expectOriginals,
    get root() {
      return root;
    },
    get projectRoot() {
      return projectRoot;
    },
    get fixture() {
      return fixture;
    },
    set fixture(value: Fixture) {
      fixture = value;
    },
    get priorPath() {
      return priorPath;
    },
  };
}
