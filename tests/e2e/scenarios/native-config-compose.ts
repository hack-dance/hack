import { chmod, mkdir, realpath, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Project } from "../../../packages/config-compiler/generated/native-config.ts";
import { PROJECT_ENV_KEY_FILENAME } from "../../../src/constants.ts";
import { isRecord } from "../../../src/lib/guards.ts";
import { openNativeComposeGenerationStore } from "../../../src/lib/native-compose-generation.ts";
import { setProjectEnvValue } from "../../../src/lib/project-env-config.ts";
import { createMonorepoFixture } from "../fixture.ts";
import {
  type CliResult,
  expect,
  expectExit,
  resolveCliSpawnArgs,
  runCommand,
  type Scenario,
} from "../harness.ts";

import { runWithOwnedCleanup } from "../native-compose-owned-fixture.ts";

const TIMEOUT = 180_000;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9]{32}$/;
const COMPOSE_PROJECT = "com.docker.compose.project";
const COMPOSE_SERVICE = "com.docker.compose.service";
const INSTANCE = "io.hack.native-config.instance";
const OWNER = "io.hack.native-config.owner";
const WORKLOAD = "io.hack.native-config.workload";
const GENERATION = "io.hack.native-config.generation";
const CANARY_OWNER = "hack.e2e.native-config-compose-owner";
// Synthetic public fixtures, never credentials for an external account or service.
const SYNTHETIC_KEY = "native-e2e-synthetic-key-never-real-credentials";
const SYNTHETIC_VALUE = "native-e2e-private-value-$AMBIENT-${NOT_INTERPOLATED}";
const VALUE_DIGEST = new Bun.CryptoHasher("sha256")
  .update(SYNTHETIC_VALUE)
  .digest("hex");
const LITERAL = "$literal-${NOT_INTERPOLATED}";
const NO_PROXY = "app,db,localhost,127.0.0.1";
const INITIALIZED = "initializer-completed";
const INITIALIZER = [
  'import { SQL } from "bun";',
  `if (new Bun.CryptoHasher("sha256").update(process.env.NC03_SECRET ?? "").digest("hex") !== ${JSON.stringify(VALUE_DIGEST)}) process.exit(23);`,
  'const sql = new SQL("postgres://postgres@db:5432/nativefixture", { max: 1 });',
  "await sql`CREATE TABLE IF NOT EXISTS marker (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`;",
  `const initialized = ${JSON.stringify(INITIALIZED)};`,
  "await sql`INSERT INTO marker VALUES (0, ${initialized}) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`;",
  "await sql.close();",
  'console.log("native initializer complete");',
].join("\n");
const APP = [
  'import { SQL } from "bun";',
  `const managed = new Bun.CryptoHasher("sha256").update(process.env.NC03_TOKEN ?? "").digest("hex") === ${JSON.stringify(VALUE_DIGEST)} && !Object.hasOwn(process.env, "NC03_SECRET");`,
  `const literal = process.env.NC03_LITERAL === ${JSON.stringify(LITERAL)};`,
  "if (!managed || !literal) process.exit(23);",
  'const sql = new SQL("postgres://postgres@db:5432/nativefixture", { max: 1 });',
  "const initial = await sql`SELECT value FROM marker WHERE id = 0`;",
  `if (initial[0]?.value !== ${JSON.stringify(INITIALIZED)}) process.exit(24);`,
  "const boot = crypto.randomUUID();",
  'Bun.serve({ hostname: "0.0.0.0", port: 3000, async fetch(request) {',
  "  try {",
  '    if (request.method === "POST") {',
  "      const value = await request.text();",
  '      if (value.length > 128) return new Response("too large", { status: 400 });',
  "      await sql`INSERT INTO marker VALUES (1, ${value}) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`;",
  '      console.log("native marker written");',
  "    }",
  "    const rows = await sql`SELECT value FROM marker WHERE id = 1`;",
  "    return Response.json({ owner: process.env.NC03_OWNER, managed, literal, boot, initializer: initial[0].value, marker: rows[0]?.value ?? null });",
  '  } catch { return new Response("database unavailable", { status: 503 }); }',
  "} });",
  'console.log("native app ready");',
].join("\n");

type ResourceKind = "container" | "network" | "volume";
type RuntimeIdentity = {
  readonly composeProject: string;
  readonly ownerToken: string;
};
type Snapshot = {
  readonly containers: Readonly<Record<string, string>>;
  readonly volume: string;
  readonly createdAt: string;
};

/** An incomplete startup alone cannot prove that the intended dependency job actually failed. */
export function nativeComposeFixtureFailureJobMatches(opts: {
  readonly startup: Pick<CliResult, "exitCode" | "timedOut">;
  readonly payload: unknown;
  readonly job: unknown;
  readonly expected: RuntimeIdentity & {
    readonly containerId: string;
    readonly generationId: string;
    readonly image: string;
  };
}): boolean {
  const own = (value: Record<string, unknown>, name: string): unknown =>
    Object.hasOwn(value, name) ? value[name] : undefined;
  const { payload, job, expected } = opts;
  if (
    opts.startup.timedOut ||
    opts.startup.exitCode !== 1 ||
    !/^[a-f0-9]{64}$/.test(expected.containerId) ||
    !TOKEN.test(expected.ownerToken) ||
    !TOKEN.test(expected.generationId) ||
    !IMAGE_ID.test(expected.image) ||
    !isRecord(payload) ||
    own(payload, "ok") !== false ||
    !isRecord(own(payload, "error")) ||
    !isRecord(job)
  ) {
    return false;
  }
  const error = own(payload, "error");
  const labels = own(job, "labels");
  return (
    isRecord(error) &&
    own(error, "code") === "E_STARTUP_INCOMPLETE" &&
    own(job, "id") === expected.containerId &&
    own(job, "image") === expected.image &&
    own(job, "status") === "exited" &&
    own(job, "exitCode") === 17 &&
    own(job, "running") === false &&
    own(job, "restartCount") === 0 &&
    own(job, "restartPolicy") === "no" &&
    isRecord(labels) &&
    own(labels, COMPOSE_PROJECT) === expected.composeProject &&
    own(labels, COMPOSE_SERVICE) === "failure" &&
    own(labels, INSTANCE) === expected.composeProject &&
    own(labels, OWNER) === expected.ownerToken &&
    own(labels, WORKLOAD) === "job" &&
    own(labels, GENERATION) === expected.generationId &&
    own(labels, "io.hack.native-config.version") === "1" &&
    own(labels, "com.docker.compose.oneoff") === "False"
  );
}

function object(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Expected a complete JSON object; values omitted");
  }
  if (!isRecord(value)) {
    throw new Error("Expected a JSON object; values omitted");
  }
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Assert this before a harness failure can attach CLI captures to an error. */
function noPrivateOutput(result: CliResult): void {
  expect({
    that: ![SYNTHETIC_KEY, SYNTHETIC_VALUE].some((value) =>
      result.combined.includes(value)
    ),
    message:
      "Synthetic managed values and project key must never enter CLI reports or logs",
  });
}

function data(result: CliResult): Record<string, unknown> {
  const payload = object(result.stdout);
  if (!(payload.ok === true && isRecord(payload.data))) {
    throw new Error(
      "Expected one successful native CLI envelope; values omitted"
    );
  }
  return payload.data;
}

function authored(opts: {
  readonly name: string;
  readonly bunImage: string;
  readonly postgresImage: string;
}): Project {
  const proxies = {
    NO_PROXY: { literal: NO_PROXY },
    no_proxy: { literal: NO_PROXY },
  };
  return {
    schema_version: 1,
    name: opts.name,
    source: { root: ".", mode: "host-mounted" },
    profiles: ["failure"],
    storage: { data: { kind: "persistent", scope: "worktree" } },
    services: {
      app: {
        image: opts.bunImage,
        pull_policy: "never",
        command: { exec: ["bun", "-e", APP] },
        init: true,
        restart: { kind: "no" },
        environment: {
          ...proxies,
          NC03_SECRET: { unset: true },
          NC03_TOKEN: { env_ref: "NC03_SECRET" },
          NC03_LITERAL: { literal: LITERAL },
          APP_ORIGIN: {
            endpoint: {
              kind: "service",
              name: "app",
              port: 3000,
              protocol: "http",
            },
          },
        },
        depends_on: [
          { service: "db", condition: "ready" },
          { job: "initializer", condition: "completed" },
        ],
        readiness: {
          kind: "exec",
          command: {
            exec: [
              "bun",
              "-e",
              'const r = await fetch("http://127.0.0.1:3000/", { signal: AbortSignal.timeout(4000) }); process.exit(r.ok ? 0 : 1)',
            ],
          },
          interval: "1s",
          timeout: "5s",
          retries: 30,
        },
      },
      db: {
        image: opts.postgresImage,
        pull_policy: "never",
        init: true,
        restart: { kind: "no" },
        shutdown: { signal: "SIGTERM", grace: "15s" },
        environment: {
          ...proxies,
          POSTGRES_DB: { literal: "nativefixture" },
          POSTGRES_HOST_AUTH_METHOD: { literal: "trust" },
        },
        mounts: [
          {
            storage: "data",
            target: "/var/lib/postgresql/data",
            access: "read-write",
          },
        ],
        readiness: {
          kind: "exec",
          command: {
            exec: ["pg_isready", "-U", "postgres", "-d", "nativefixture"],
          },
          interval: "1s",
          timeout: "5s",
          retries: 30,
        },
      },
    },
    jobs: {
      initializer: {
        image: opts.bunImage,
        pull_policy: "never",
        command: { exec: ["bun", "-e", INITIALIZER] },
        restart: { kind: "no" },
        environment: proxies,
        depends_on: [{ service: "db", condition: "ready" }],
      },
      failure: {
        image: opts.bunImage,
        pull_policy: "never",
        command: { exec: ["bun", "-e", "process.exit(17)"] },
        restart: { kind: "no" },
        profiles: ["failure"],
      },
    },
  };
}

/** Native-only authored inputs, cached images, no published ports or real credentials. */
export const nativeConfigComposeScenario: Scenario = {
  name: "native-config-compose",
  tier: "docker",
  summary:
    "native app/DB/job, encrypted env, saved operations, ownership and retained data",
  run: async (ctx) => {
    const started = performance.now();
    const stage = (message: string): void =>
      ctx.log(
        `${message} (elapsed ${Math.round(performance.now() - started)}ms)`
      );
    expect({
      that: resolveCliSpawnArgs([]).length === 1,
      message:
        "Native acceptance requires HACK_E2E_CLI_BIN selecting the current compiled CLI and companion compiler",
    });
    const docker = async (args: readonly string[]): Promise<string> => {
      const result = await runCommand({
        argv: ["docker", ...args],
        cwd: ctx.tempRoot,
        timeoutMs: TIMEOUT,
      });
      noPrivateOutput(result);
      expectExit({
        result,
        codes: [0],
        message: `Docker ${args[0]} must succeed`,
      });
      return result.stdout.trim();
    };
    expect({
      that: (await docker(["info", "--format", "{{.OSType}}"])) === "linux",
      message: "Native Compose fixture requires a Linux Docker daemon",
    });
    await docker(["compose", "version"]);
    const image = async (tag: string): Promise<string> => {
      const id = await docker(["image", "inspect", tag, "--format", "{{.Id}}"]);
      expect({
        that: IMAGE_ID.test(id),
        message: `${tag} must already be cached; this scenario never pulls images`,
      });
      return id;
    };
    const bunImage = await image("oven/bun:1.4.2-slim");
    const postgresImage = await image("postgres:17.6-alpine");
    const created = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: false,
    });
    // macOS /var aliases must not produce a different private runtime identity than process.cwd().
    const root = await realpath(created.root);
    const fixture = { ...created, root, hackDir: join(root, ".hack") };
    await mkdir(fixture.hackDir);
    await Bun.write(
      join(fixture.root, PROJECT_ENV_KEY_FILENAME),
      SYNTHETIC_KEY
    );
    for (const entry of [
      { key: "NC03_OWNER", value: fixture.name, secret: false },
      { key: "NC03_SECRET", value: SYNTHETIC_VALUE, secret: true },
    ]) {
      await setProjectEnvValue({
        projectRoot: fixture.root,
        projectDir: fixture.hackDir,
        envName: null,
        scope: "global",
        ...entry,
      });
    }
    const projectPath = join(fixture.hackDir, "hack.project.json");
    const baseProject = authored({
      name: fixture.name,
      bunImage,
      postgresImage,
    });
    const app = baseProject.services?.app;
    const db = baseProject.services?.db;
    if (!(app && db)) {
      throw new Error("Authored transition fixture services are missing");
    }
    const renamed: Project = {
      ...baseProject,
      services: {
        db,
        "renamed-app": {
          ...app,
          environment: {
            ...app.environment,
            APP_ORIGIN: {
              endpoint: {
                kind: "service",
                name: "renamed-app",
                port: 3000,
                protocol: "http",
              },
            },
          },
        },
      },
    };
    const projectText = `${JSON.stringify(baseProject, null, 2)}\n`;
    const initialProject: Project = {
      ...baseProject,
      services: {
        ...baseProject.services,
        retired: {
          image: bunImage,
          pull_policy: "never",
          init: true,
          restart: { kind: "no" },
          command: { exec: ["bun", "-e", "setInterval(() => {}, 60000)"] },
        },
      },
    };
    await Bun.write(
      projectPath,
      `${JSON.stringify(initialProject, null, 2)}\n`
    );
    expect({
      that: !(
        (await Bun.file(join(fixture.hackDir, "hack.config.json")).exists()) ||
        (await Bun.file(join(fixture.hackDir, "docker-compose.yml")).exists())
      ),
      message: "Fixture must contain only the native authored project family",
    });
    const envPath = join(fixture.hackDir, "hack.env.default.yaml");
    const encryptedText = await Bun.file(envPath).text();
    expect({
      that:
        encryptedText.includes("v1:") &&
        !encryptedText.includes(SYNTHETIC_VALUE),
      message: "Synthetic managed secret must be encrypted at rest",
    });
    const raw = async (
      args: readonly string[],
      extra: Readonly<Record<string, string>> = {}
    ): Promise<CliResult> => {
      const result = await ctx.cli({
        args,
        cwd: fixture.root,
        timeoutMs: TIMEOUT,
        env: {
          HACK_RUNTIME_BACKEND: "compose",
          HACK_DAEMON_DISABLE_DOCKER_EVENTS: "1",
          AMBIENT: "hostile-interpolation-value",
          ...extra,
        },
      });
      noPrivateOutput(result);
      return result;
    };
    const cli = async (args: readonly string[]): Promise<CliResult> => {
      const result = await raw(args);
      expectExit({
        result,
        codes: [0],
        message: `Native hack ${args[0]} must succeed`,
      });
      return result;
    };
    let runtime: RuntimeIdentity | null = null;
    const readIdentity = async (): Promise<void> => {
      const store = await openNativeComposeGenerationStore({
        projectRoot: fixture.root,
        instance: null,
        mode: "saved",
      });
      try {
        runtime = {
          composeProject: store.identity.composeProject,
          ownerToken: store.identity.ownerToken,
        };
      } finally {
        await store.close();
      }
    };
    const identity = (): RuntimeIdentity => {
      if (!(runtime && TOKEN.test(runtime.ownerToken))) {
        throw new Error("Verified fixture runtime ownership is missing");
      }
      return runtime;
    };
    const labels = async (
      kind: ResourceKind,
      id: string
    ): Promise<Record<string, unknown>> =>
      object(
        await docker([
          kind,
          "inspect",
          id,
          "--format",
          kind === "container" ? "{{json .Config.Labels}}" : "{{json .Labels}}",
        ])
      );
    const owned = async (kind: ResourceKind, id: string): Promise<void> => {
      const actual = await labels(kind, id);
      const expected = identity();
      expect({
        that:
          actual[OWNER] === expected.ownerToken &&
          actual[INSTANCE] === expected.composeProject &&
          actual[COMPOSE_PROJECT] === expected.composeProject &&
          actual["io.hack.native-config.version"] === "1",
        message:
          "Refuse resource mutation outside exact native fixture ownership",
      });
    };
    const list = async (kind: ResourceKind): Promise<string[]> => {
      const expected = identity();
      return (
        await docker([
          ...(kind === "container" ? ["ps", "-aq"] : [kind, "ls", "-q"]),
          "--filter",
          `label=${OWNER}=${expected.ownerToken}`,
          "--filter",
          `label=${INSTANCE}=${expected.composeProject}`,
          "--filter",
          `label=${COMPOSE_PROJECT}=${expected.composeProject}`,
        ])
      )
        .split(/\s+/)
        .filter(Boolean);
    };
    const snapshot = async (appService = "app"): Promise<Snapshot> => {
      const containers: Record<string, string> = {};
      for (const service of [appService, "db", "initializer"]) {
        const ids = (
          await docker([
            "ps",
            "-aq",
            "--filter",
            `label=${COMPOSE_PROJECT}=${identity().composeProject}`,
            "--filter",
            `label=${COMPOSE_SERVICE}=${service}`,
            "--filter",
            "label=com.docker.compose.oneoff=False",
          ])
        )
          .split(/\s+/)
          .filter(Boolean);
        const id = ids[0];
        if (ids.length !== 1 || !id) {
          throw new Error(
            "Expected exactly one native fixture workload container"
          );
        }
        await owned("container", id);
        const actual = await labels("container", id);
        expect({
          that:
            actual[WORKLOAD] ===
            (service === "initializer" ? "job" : "service"),
          message:
            "Authored service/job ownership must survive real-engine execution",
        });
        const state = await docker([
          "inspect",
          id,
          "--format",
          service === "initializer"
            ? "{{.State.Status}} {{.State.ExitCode}} {{len .HostConfig.PortBindings}}"
            : "{{.State.Running}} {{.State.Health.Status}} {{len .HostConfig.PortBindings}}",
        ]);
        expect({
          that:
            state ===
            (service === "initializer" ? "exited 0 0" : "true healthy 0"),
          message:
            "CLI ready must mean healthy services and an exit-zero initializer without published ports",
        });
        containers[service] = id;
      }
      const volumes = await list("volume");
      const volume = volumes[0];
      if (volumes.length !== 1 || !volume) {
        throw new Error("Expected exactly one native fixture data volume");
      }
      await owned("volume", volume);
      expect({
        that:
          (await labels("volume", volume))["io.hack.native-config.storage"] ===
          "data",
        message: "Data volume must carry the selected logical storage identity",
      });
      const db = containers.db;
      if (!db) {
        throw new Error("Database workload is missing");
      }
      expect({
        that:
          (await docker([
            "inspect",
            db,
            "--format",
            '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}',
          ])) === volume,
        message: "Postgres must mount the exact owned persistent volume",
      });
      return {
        containers,
        volume,
        createdAt: await docker([
          "volume",
          "inspect",
          volume,
          "--format",
          "{{.CreatedAt}}",
        ]),
      };
    };
    const probe = async (
      operation: "exec" | "run",
      expected: string | null,
      write = false,
      appService = "app"
    ): Promise<string> => {
      const script = `const r = await fetch(process.env.APP_ORIGIN, { method: ${JSON.stringify(write ? "POST" : "GET")}, ${write ? `body: ${JSON.stringify(expected)},` : ""} signal: AbortSignal.timeout(5000) }); if (!r.ok) process.exit(17); process.stdout.write(await r.text());`;
      const result = await cli([
        operation,
        appService,
        "--",
        "bun",
        "-e",
        script,
      ]);
      const response = object(result.stdout);
      expect({
        that:
          response.owner === fixture.name &&
          response.managed === true &&
          response.literal === true &&
          response.initializer === INITIALIZED &&
          response.marker === expected &&
          typeof response.boot === "string",
        message:
          "Real HTTP read/write must prove encrypted env, literal dollars, successful initializer and persisted SQL data",
        result,
      });
      if (typeof response.boot !== "string") {
        throw new Error("App process identity is missing");
      }
      return response.boot;
    };
    const checkSql = async (marker: string): Promise<void> => {
      const result = await cli([
        "exec",
        "db",
        "--",
        "psql",
        "-U",
        "postgres",
        "-d",
        "nativefixture",
        "-tA",
        "-c",
        "SELECT value FROM marker WHERE id = 1",
      ]);
      expect({
        that: result.stdout.trim() === marker,
        message: "Independent psql read must confirm the HTTP write",
        result,
      });
    };
    const checkLogs = async (): Promise<void> => {
      const logs = await cli([
        "logs",
        "app",
        "--no-follow",
        "--compose",
        "--tail",
        "20",
      ]);
      expect({
        that:
          logs.combined.includes("native app ready") &&
          logs.combined.includes("native marker written"),
        message: "Saved logs must include real app readiness and write events",
        result: logs,
      });
    };
    const coldRun = async (): Promise<{
      readonly marker: string;
      readonly volume: string;
      readonly createdAt: string;
    }> => {
      const marker = crypto.randomUUID();
      const script = [
        'import { SQL } from "bun";',
        `if (new Bun.CryptoHasher("sha256").update(process.env.NC03_TOKEN ?? "").digest("hex") !== ${JSON.stringify(VALUE_DIGEST)} || Object.hasOwn(process.env, "NC03_SECRET") || process.env.NC03_LITERAL !== ${JSON.stringify(LITERAL)}) process.exit(23);`,
        'const sql = new SQL("postgres://postgres@db:5432/nativefixture", { max: 1 });',
        "const rows = await sql`SELECT value FROM marker WHERE id = 0`;",
        `if (rows[0]?.value !== ${JSON.stringify(INITIALIZED)}) process.exit(24);`,
        `const marker = ${JSON.stringify(marker)};`,
        "await sql`INSERT INTO marker VALUES (1, ${marker}) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`;",
        "await sql.close();",
        'console.log("native cold one-off complete");',
      ].join("\n");
      const result = await raw(["run", "app", "--", "bun", "-e", script]);
      // Read ownership before asserting success, so partial cold activation can be recovered.
      await readIdentity();
      expectExit({
        result,
        codes: [0],
        message:
          "Cold one-off must start healthy direct dependencies and its completed initializer before executing",
      });
      expect({
        that: result.stdout.trim() === "native cold one-off complete",
        message:
          "Cold one-off must write real SQL using its managed environment",
        result,
      });
      const state = data(await cli(["ps", "--json"]));
      expect({
        that:
          state.pending === false &&
          Array.isArray(state.services) &&
          state.services.length === 2 &&
          state.services.every(
            (entry) => isRecord(entry) && entry.oneoff === false
          ),
        message:
          "Cold one-off must leave only dependency workloads and no pending or one-off residue",
      });
      await checkSql(marker);
      const volumes = await list("volume");
      const volume = volumes[0];
      if (volumes.length !== 1 || !volume) {
        throw new Error("Expected one owned data volume after cold one-off");
      }
      await owned("volume", volume);
      return {
        marker,
        volume,
        createdAt: await docker([
          "volume",
          "inspect",
          volume,
          "--format",
          "{{.CreatedAt}}",
        ]),
      };
    };
    const checkRemovalFailure = async (
      prior: Snapshot,
      marker: string
    ): Promise<void> => {
      const engine = Bun.which("docker");
      if (!engine?.startsWith("/")) {
        throw new Error(
          "Verified absolute Docker forwarding target is missing"
        );
      }
      const shimDirectory = join(ctx.tempRoot, `${fixture.name}-rm-failure`);
      const receipt = join(shimDirectory, "blocked-owned-rm");
      const shim = join(shimDirectory, "docker");
      await mkdir(shimDirectory, { mode: 0o700 });
      await Bun.write(
        shim,
        [
          "#!/bin/sh",
          'if [ "$1" = container ] && [ "$2" = rm ] && [ "$#" = 3 ]; then',
          `  printf 'blocked-owned-rm\\n' > ${shellQuote(receipt)}`,
          "  exit 71",
          "fi",
          `exec ${shellQuote(engine)} "$@"`,
          "",
        ].join("\n")
      );
      await chmod(shim, 0o700);
      const failed = await raw(
        ["run", "app", "--", "bun", "-e", "process.exit(0)"],
        { PATH: `${shimDirectory}:${process.env.PATH ?? "/usr/bin:/bin"}` }
      );
      expectExit({
        result: failed,
        codes: [1],
        message:
          "Successful one-off execution with failed owned removal must report incomplete",
      });
      expect({
        that:
          (await Bun.file(receipt).text()) === "blocked-owned-rm\n" &&
          JSON.stringify((await snapshot()).containers) ===
            JSON.stringify(prior.containers),
        message:
          "Non-forced removal failure control must activate without changing primary workloads",
      });
      const pending = data(await cli(["ps", "--json"]));
      expect({
        that:
          pending.pending === true &&
          Array.isArray(pending.services) &&
          pending.services.length === 4 &&
          pending.services.filter(
            (entry) =>
              isRecord(entry) &&
              entry.oneoff === true &&
              entry.status === "exited" &&
              entry.exitCode === 0
          ).length === 1,
        message:
          "Failed removal must retain the exact completed one-off and pending ownership",
      });
      expectExit({
        result: await raw(["up", "--detach", "--json"]),
        codes: [1],
        message: "Unrecovered one-off cleanup must block another start",
      });
      const recovered = data(await cli(["down", "--recover", "--json"]));
      expect({
        that: recovered.status === "stopped" && recovered.dataRetained === true,
        message:
          "Explicit real-engine recovery must stop the retained one-off and preserve data",
      });
      await cli(["up", "--detach", "--json"]);
      const restored = await snapshot();
      expect({
        that:
          restored.volume === prior.volume &&
          restored.createdAt === prior.createdAt &&
          data(await cli(["ps", "--json"])).pending === false,
        message:
          "Recovery after removal failure must restore the same data with no pending state",
      });
      await probe("exec", marker);
      await checkSql(marker);
    };
    const canary = `${fixture.name}-canary`;
    let intruder: string | null = null;
    const canaryOwned = async (
      kind: ResourceKind,
      id: string,
      project = canary
    ): Promise<void> => {
      const actual = await labels(kind, id);
      expect({
        that:
          actual[CANARY_OWNER] === canary &&
          actual[COMPOSE_PROJECT] === project,
        message: "Refuse canary cleanup outside exact fixture labels",
      });
    };
    const removeIntruder = async (): Promise<void> => {
      if (intruder) {
        await canaryOwned("container", intruder, identity().composeProject);
        await docker(["container", "rm", "--force", intruder]);
        intruder = null;
      }
    };
    const createIntruder = async (): Promise<void> => {
      intruder = await docker([
        "run",
        "--detach",
        "--pull=never",
        "--label",
        `${CANARY_OWNER}=${canary}`,
        "--label",
        `${COMPOSE_PROJECT}=${identity().composeProject}`,
        "--label",
        `${COMPOSE_SERVICE}=foreign`,
        "--label",
        `${OWNER}=${identity().ownerToken === "0".repeat(32) ? "f".repeat(32) : "0".repeat(32)}`,
        "--network",
        canary,
        bunImage,
        "bun",
        "-e",
        "setInterval(() => {}, 60000)",
      ]);
      await canaryOwned("container", intruder, identity().composeProject);
    };
    const projectContainers = async (): Promise<string[]> =>
      (
        await docker([
          "ps",
          "-aq",
          "--no-trunc",
          "--filter",
          `label=${COMPOSE_PROJECT}=${identity().composeProject}`,
        ])
      )
        .split(/\s+/)
        .filter(Boolean)
        .sort();
    const transition = async (opts: {
      readonly project: Project;
      readonly removedService: string;
      readonly marker: string;
      readonly retained: Snapshot;
      readonly appService?: string;
    }): Promise<void> => {
      const before = await projectContainers();
      for (const id of before) {
        await owned("container", id);
      }
      const states = async (ids: readonly string[]): Promise<string[]> =>
        await Promise.all(
          ids.map((id) =>
            docker([
              "inspect",
              id,
              "--format",
              "{{.State.Status}} {{.State.ExitCode}} {{json .Config.Labels}}",
            ])
          )
        );
      const beforeStates = await states(before);
      await Bun.write(
        projectPath,
        `${JSON.stringify(opts.project, null, 2)}\n`
      );
      await createIntruder();
      if (!intruder) {
        throw new Error("Foreign transition control is missing");
      }
      const foreign = intruder;
      const denied = await raw(["up", "--detach", "--json"]);
      expectExit({
        result: denied,
        codes: [1],
        message:
          "Workload transition must refuse a foreign project container before removing any orphan",
      });
      const denial = object(denied.stdout);
      const afterDenied = (await projectContainers()).filter(
        (id) => id !== foreign
      );
      expect({
        that:
          denial.ok === false &&
          isRecord(denial.error) &&
          denial.error.code === "E_CONFIG_INVALID" &&
          JSON.stringify(afterDenied) === JSON.stringify(before) &&
          JSON.stringify(await states(afterDenied)) ===
            JSON.stringify(beforeStates) &&
          (await docker([
            "inspect",
            foreign,
            "--format",
            "{{.State.Running}}",
          ])) === "true",
        message:
          "Refused transition must preserve every native container and the foreign control",
      });
      await removeIntruder();
      await cli(["up", "--detach", "--json"]);
      expect({
        that:
          (await docker([
            "ps",
            "-aq",
            "--filter",
            `label=${COMPOSE_PROJECT}=${identity().composeProject}`,
            "--filter",
            `label=${COMPOSE_SERVICE}=${opts.removedService}`,
          ])) === "",
        message:
          "Successful whole-project transition must remove the old workload container",
      });
      const observed = data(await cli(["ps", "--json"]));
      const appService = opts.appService ?? "app";
      expect({
        that:
          observed.pending === false &&
          Array.isArray(observed.services) &&
          observed.services.length === 3 &&
          observed.services.every(
            (entry) =>
              isRecord(entry) &&
              entry.oneoff === false &&
              [appService, "db", "initializer"].includes(String(entry.service))
          ),
        message:
          "Saved ps must accept only the successful new service/job generation",
      });
      const after = await snapshot(appService);
      expect({
        that:
          after.volume === opts.retained.volume &&
          after.createdAt === opts.retained.createdAt,
        message: "Workload transition must retain the exact database volume",
      });
      await probe("exec", opts.marker, false, appService);
      await checkSql(opts.marker);
    };
    const cleanCanary = async (): Promise<void> => {
      await removeIntruder();
      for (const kind of ["container", "network", "volume"] as const) {
        const ids = (
          await docker([
            ...(kind === "container" ? ["ps", "-aq"] : [kind, "ls", "-q"]),
            "--filter",
            `label=${CANARY_OWNER}=${canary}`,
            "--filter",
            `label=${COMPOSE_PROJECT}=${canary}`,
          ])
        )
          .split(/\s+/)
          .filter(Boolean);
        for (const id of ids) {
          await canaryOwned(kind, id);
          await docker([
            kind,
            "rm",
            ...(kind === "container" ? ["--force"] : []),
            id,
          ]);
        }
      }
    };
    const canaryLabels = [
      "--label",
      `${CANARY_OWNER}=${canary}`,
      "--label",
      `${COMPOSE_PROJECT}=${canary}`,
    ];
    const withdrawn: { original: string; backup: string }[] = [];
    const restoreInputs = async (): Promise<void> => {
      for (const paths of withdrawn.splice(0)) {
        await rename(paths.backup, paths.original);
      }
      await Bun.write(projectPath, projectText);
    };
    const withdrawInputs = async (): Promise<void> => {
      for (const path of [
        envPath,
        join(fixture.root, PROJECT_ENV_KEY_FILENAME),
        join(fixture.root, ".git", PROJECT_ENV_KEY_FILENAME),
      ]) {
        if (await Bun.file(path).exists()) {
          const backup = join(
            ctx.tempRoot,
            `${fixture.name}-withdrawn-${withdrawn.length}`
          );
          await rename(path, backup);
          withdrawn.push({ original: path, backup });
        }
      }
      await Bun.write(projectPath, "invalid-native-authored-input\n");
    };
    const cleanupRuntime = async (): Promise<void> => {
      await removeIntruder();
      await restoreInputs();
      if (
        !runtime &&
        (await Bun.file(
          join(fixture.hackDir, ".internal/native-compose/.gitignore")
        ).exists())
      ) {
        await readIdentity();
      }
      if (!runtime) {
        return;
      }
      const recovered = await raw(["down", "--recover", "--json"]);
      expectExit({
        result: recovered,
        codes: [0],
        message:
          "Final fixture cleanup must explicitly recover/stop retained native ownership",
      });
      for (const kind of ["container", "network", "volume"] as const) {
        for (const id of await list(kind)) {
          await owned(kind, id);
          await docker([
            kind,
            "rm",
            ...(kind === "container" ? ["--force"] : []),
            id,
          ]);
        }
        expect({
          that: (await list(kind)).length === 0,
          message:
            "Exact native fixture cleanup must leave no owned engine resources",
        });
      }
    };
    const verifyFailureJob = async (opts: {
      readonly startup: CliResult;
      readonly payload: unknown;
    }): Promise<void> => {
      const store = await openNativeComposeGenerationStore({
        projectRoot: fixture.root,
        instance: null,
        mode: "saved",
      });
      try {
        const pending = await store.loadPending();
        if (!pending) {
          throw new Error("Failed startup must retain a verified generation");
        }
        const failureIds = (
          await docker([
            "ps",
            "-aq",
            "--no-trunc",
            "--filter",
            `label=${COMPOSE_PROJECT}=${identity().composeProject}`,
            "--filter",
            `label=${OWNER}=${identity().ownerToken}`,
            "--filter",
            `label=${COMPOSE_SERVICE}=failure`,
            "--filter",
            `label=${GENERATION}=${pending.generationId}`,
          ])
        )
          .split(/\s+/)
          .filter(Boolean);
        const containerId = failureIds[0];
        if (failureIds.length !== 1 || !containerId) {
          throw new Error(
            "Failed startup must expose exactly one owned pending failure job"
          );
        }
        const job = object(
          await docker([
            "container",
            "inspect",
            containerId,
            "--format",
            '{"id":{{json .Id}},"image":{{json .Image}},"status":{{json .State.Status}},"exitCode":{{json .State.ExitCode}},"running":{{json .State.Running}},"restartCount":{{json .RestartCount}},"restartPolicy":{{json .HostConfig.RestartPolicy.Name}},"labels":{{json .Config.Labels}}}',
          ])
        );
        expect({
          that: nativeComposeFixtureFailureJobMatches({
            ...opts,
            job,
            expected: {
              ...identity(),
              containerId,
              generationId: pending.generationId,
              image: bunImage,
            },
          }),
          message:
            "Failed-dependency recovery requires the exact owned pending job to have exited 17; created, timed-out or unrelated failures do not qualify",
        });
      } finally {
        await store.close();
      }
    };
    await runWithOwnedCleanup({
      run: async () => {
        await docker(["volume", "create", ...canaryLabels, canary]);
        await docker([
          "network",
          "create",
          "--internal",
          ...canaryLabels,
          canary,
        ]);
        await docker([
          "run",
          "--detach",
          "--pull=never",
          "--name",
          canary,
          ...canaryLabels,
          "--network",
          canary,
          "--volume",
          `${canary}:/canary`,
          bunImage,
          "bun",
          "-e",
          'await Bun.write("/canary/marker", "untouched"); setInterval(() => {}, 60000)',
        ]);
        const cold = await coldRun();
        stage(
          "cold one-off SQL write and exact completed-container cleanup verified"
        );
        const start = await raw(["up", "--detach", "--json"]);
        await readIdentity();
        expectExit({
          result: start,
          codes: [0],
          message:
            "Native detached startup must complete actual service/job readiness",
        });
        expect({
          that:
            data(start).status === "ready" &&
            data(start).composeProject === identity().composeProject,
          message:
            "Startup must return one redacted ready envelope matching saved ownership",
          result: start,
        });
        const first = await snapshot();
        expect({
          that:
            first.volume === cold.volume && first.createdAt === cold.createdAt,
          message:
            "Normal startup after cold run must retain the same populated database volume",
        });
        const firstBoot = await probe("exec", cold.marker);
        await checkSql(cold.marker);
        const marker = crypto.randomUUID();
        await probe("exec", marker, true);
        await probe("run", marker);
        const nonzero = await raw([
          "run",
          "app",
          "--",
          "bun",
          "-e",
          "process.exit(17)",
        ]);
        expectExit({
          result: nonzero,
          codes: [17],
          message:
            "A genuine nonzero one-off must preserve its target exit status",
        });
        const afterNonzero = data(await cli(["ps", "--json"]));
        expect({
          that:
            afterNonzero.pending === false &&
            Array.isArray(afterNonzero.services) &&
            afterNonzero.services.length === 4 &&
            afterNonzero.services.every(
              (entry) => isRecord(entry) && entry.oneoff === false
            ),
          message:
            "Nonzero one-off completion must remove its exact container without leaving pending or one-off state",
        });
        await checkSql(marker);
        await checkLogs();
        stage(
          "normal startup, HTTP/SQL, encrypted env and exit-17 one-off verified"
        );
        const ps = data(await cli(["ps", "--json"]));
        expect({
          that:
            Array.isArray(ps.services) &&
            ps.services.length === 4 &&
            ps.pending === false &&
            ps.stopped === false,
          message:
            "Saved ps must observe all services and the completed job with no pending effect",
        });

        await createIntruder();
        if (!intruder) {
          throw new Error("Foreign stop control is missing");
        }
        const denied = await raw(["down", "--json"]);
        expectExit({
          result: denied,
          codes: [1],
          message:
            "Same-project foreign resource must block stop before engine effects",
        });
        const denial = object(denied.stdout);
        expect({
          that:
            denial.ok === false &&
            isRecord(denial.error) &&
            denial.error.code === "E_CONFIG_INVALID",
          message: "Foreign resource refusal must be structured and redacted",
        });
        expect({
          that:
            JSON.stringify((await snapshot()).containers) ===
              JSON.stringify(first.containers) &&
            (await docker([
              "inspect",
              intruder,
              "--format",
              "{{.State.Running}}",
            ])) === "true",
          message:
            "Refused stop must leave owned and foreign containers untouched",
        });
        await removeIntruder();

        await transition({
          project: baseProject,
          removedService: "retired",
          marker,
          retained: first,
        });
        await transition({
          project: renamed,
          removedService: "app",
          appService: "renamed-app",
          marker,
          retained: first,
        });
        await cli(["down", "--json"]);
        await cli(["up", "--detach", "--json"]);
        const renamedRestored = await snapshot("renamed-app");
        expect({
          that:
            renamedRestored.volume === first.volume &&
            renamedRestored.createdAt === first.createdAt,
          message:
            "Stop/start after a rename must retain the same persistent volume",
        });
        await probe("exec", marker, false, "renamed-app");
        await checkSql(marker);
        await Bun.write(projectPath, projectText);
        await cli(["up", "--detach", "--json"]);
        const beforeRestart = await snapshot();
        const beforeRestartBoot = await probe("exec", marker);
        stage("owned workload removal/rename and retained SQL data verified");

        const restart = data(await cli(["restart", "--json"]));
        expect({
          that: restart.status === "ready",
          message: "Restart must qualify services and initializer again",
        });
        const restarted = await snapshot();
        expect({
          that:
            restarted.volume === first.volume &&
            restarted.createdAt === first.createdAt &&
            restarted.containers.app !== beforeRestart.containers.app &&
            (await probe("exec", marker)) !== beforeRestartBoot,
          message:
            "Restart must replace the app process while retaining the exact database volume and value",
        });
        await checkSql(marker);
        stage("foreign refusal and restart data retention verified");

        await withdrawInputs();
        const saved = data(await cli(["ps", "--json"]));
        expect({
          that: saved.stopped === false && saved.pending === false,
          message:
            "Saved observation must not decode broken authored inputs or seek removed env/key files",
        });
        await probe("exec", marker, true);
        await checkSql(marker);
        await checkLogs();
        const stopped = data(await cli(["down", "--json"]));
        expect({
          that:
            stopped.status === "stopped" &&
            stopped.dataRetained === true &&
            (await list("container")).length === 0 &&
            (await list("network")).length === 0,
          message:
            "Saved stop must remove only owned transient resources without authored config/env/key dependencies",
        });
        await owned("volume", first.volume);
        await restoreInputs();
        await cli(["up", "--detach", "--json"]);
        const restored = await snapshot();
        expect({
          that:
            restored.volume === first.volume &&
            restored.createdAt === first.createdAt &&
            (await probe("exec", marker)) !== firstBoot,
          message:
            "Down/up must restore a new app process against the original volume and data",
        });
        await probe("run", marker);
        await checkSql(marker);
        await checkRemovalFailure(restored, marker);
        stage(
          "saved input-independent operations, data retention and failed-removal recovery verified"
        );

        const failure = await raw(
          ["up", "--detach", "--profile", "failure", "--json"],
          // The declared DB shutdown grace is 15s; allow shutdown plus normal
          // startup/readiness before requiring the intended job's actual exit.
          { HACK_COMPOSE_STARTUP_TIMEOUT_MS: "45000" }
        );
        expectExit({
          result: failure,
          codes: [1],
          message: "Exit-17 job must not satisfy actual detached readiness",
        });
        const failed = object(failure.stdout);
        expect({
          that:
            failed.ok === false &&
            isRecord(failed.error) &&
            failed.error.code === "E_STARTUP_INCOMPLETE",
          message:
            "Failed readiness must preserve an explicit incomplete outcome",
        });
        await verifyFailureJob({ startup: failure, payload: failed });
        expect({
          that: data(await cli(["ps", "--json"])).pending === true,
          message:
            "Failed readiness must retain pending ownership for recovery",
        });
        expectExit({
          result: await raw(["up", "--detach", "--json"]),
          codes: [1],
          message: "Unrecovered pending startup must refuse another start",
        });
        const recovered = data(await cli(["down", "--recover", "--json"]));
        expect({
          that:
            recovered.status === "stopped" && recovered.dataRetained === true,
          message:
            "Explicit owned stop recovery must clear the failed state and retain data",
        });
        await cli(["up", "--detach", "--json"]);
        const recoveredSnapshot = await snapshot();
        expect({
          that:
            recoveredSnapshot.volume === first.volume &&
            recoveredSnapshot.createdAt === first.createdAt,
          message:
            "Failed-start recovery must retain the identical data volume",
        });
        await probe("exec", marker);
        await checkSql(marker);
        await cli(["down", "--json"]);
        for (const kind of ["container", "network", "volume"] as const) {
          await canaryOwned(kind, canary);
        }
        expect({
          that:
            (await docker([
              "exec",
              canary,
              "bun",
              "-e",
              'process.stdout.write(await Bun.file("/canary/marker").text())',
            ])) === "untouched",
          message:
            "Foreign canary process, network and volume contents must survive every native lifecycle operation",
        });
        stage(
          "native cold run/app/DB/initializer, encrypted env, HTTP/SQL, saved operations, restart/retention, foreign refusal and failed-job recovery verified"
        );
      },
      cleanup: async () => {
        // Exact fixture ownership, never a daemon-wide prune. Explicit recovery is attempted
        // first so a real readiness failure cannot silently leak its pending startup resources.
        try {
          await cleanupRuntime();
        } finally {
          await cleanCanary();
        }
      },
      secondaryFailure: () =>
        ctx.log(
          "Exact native cleanup also failed; owned fixture retained for explicit recovery"
        ),
    });
  },
};
