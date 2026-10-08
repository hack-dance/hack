import { chmod, mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import type {
  Project,
  Workload,
} from "../../../packages/config-compiler/generated/native-config.ts";
import { isRecord } from "../../../src/lib/guards.ts";
import { openNativeComposeGenerationStore } from "../../../src/lib/native-compose-generation.ts";
import { createMonorepoFixture } from "../fixture.ts";
import {
  type CliResult,
  expect,
  expectExit,
  resolveCliSpawnArgs,
  runCommand,
  type Scenario,
} from "../harness.ts";
import { recordKnownUncertainProcessPolicyStartup } from "../native-process-policy-startup-diagnostic.ts";

const TIMEOUT = 120_000;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const RESOURCE_ID = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9]{32}$/;
const COMPOSE_PROJECT = "com.docker.compose.project";
const COMPOSE_SERVICE = "com.docker.compose.service";
const INSTANCE = "io.hack.native-config.instance";
const OWNER = "io.hack.native-config.owner";
const READER_OWNER = "hack.e2e.native-process-policy-reader";
const UNSUPPORTED_VALUE = "private-process-policy-refusal-canary";
const EXECUTION_INPUT_REFUSAL =
  "Native execution inputs are invalid or changed; prepare a fresh generation. Values omitted.";
const RECORDS = [
  "graceful-signal",
  "graceful-complete",
  "forced-signal",
  "forced-heartbeat",
  "init-result",
  "retry-result",
] as const;
type ResourceKind = "container" | "network" | "volume";
type Identity = {
  readonly composeProject: string;
  readonly ownerToken: string;
};

/** Fixture records are public synthetic evidence. Atomic replacement preserves the last heartbeat on SIGKILL. */
const RECORD_PROGRAM = [
  'import { rename } from "node:fs/promises";',
  "const owner = process.env.FIXTURE_OWNER;",
  'const record = async (name, value) => { const path = "/evidence/" + name + ".json"; const temporary = path + "." + crypto.randomUUID(); await Bun.write(temporary, JSON.stringify({ owner, ...value })); await rename(temporary, path); };',
  'const ready = async name => record(name + "-ready", { ready: true, pid: process.pid });',
].join("\n");
const GRACEFUL = [
  RECORD_PROGRAM,
  'process.on("SIGUSR1", async () => { const started = performance.now(); await record("graceful-signal", { signal: "SIGUSR1" }); await Bun.sleep(1200); await record("graceful-complete", { signal: "SIGUSR1", elapsedMs: performance.now() - started }); process.exit(0); });',
  'await ready("graceful"); setInterval(() => {}, 1000);',
].join("\n");
const FORCED = [
  RECORD_PROGRAM,
  "let received = null;",
  'process.on("SIGUSR1", async () => { if (received !== null) return; received = performance.now(); await record("forced-signal", { signal: "SIGUSR1" }); });',
  'await ready("forced");',
  'while (true) { if (received !== null) await record("forced-heartbeat", { signal: "SIGUSR1", elapsedMs: performance.now() - received }); await Bun.sleep(100); }',
].join("\n");
const INIT = [
  RECORD_PROGRAM,
  'process.on("SIGTERM", () => process.exit(0));',
  'const initName = (await Bun.file("/proc/1/comm").text()).trim();',
  'const child = Bun.spawn(["/bin/sh", "-c", "sleep 2 >/dev/null 2>&1 & echo $!; exit 0"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });',
  "const pid = Number((await new Response(child.stdout).text()).trim());",
  "if ((await child.exited) !== 0 || !Number.isInteger(pid) || pid <= 1) process.exit(41);",
  'const path = "/proc/" + pid + "/status"; const first = await Bun.file(path).text();',
  "const parent = Number(first.match(/^PPid:\\s+(\\d+)$/m)?.[1]);",
  "if (parent !== 1) process.exit(42);",
  "const deadline = performance.now() + 10000; let reaped = false;",
  "while (performance.now() < deadline) { if (!(await Bun.file(path).exists())) { reaped = true; break; } await Bun.sleep(25); }",
  'await record("init-result", { appPid: process.pid, adoptedPid: pid, parent, initName, reaped });',
  "if (!reaped) process.exit(43);",
  'await ready("reaper"); setInterval(() => {}, 1000);',
].join("\n");
const RETRY = [
  RECORD_PROGRAM,
  'const path = "/evidence/retry-count"; const before = (await Bun.file(path).exists()) ? Number(await Bun.file(path).text()) : 0;',
  "if (!Number.isInteger(before) || before < 0) process.exit(44);",
  "const attempts = before + 1; await Bun.write(path, String(attempts));",
  "if (attempts <= 2) process.exit(17);",
  'process.on("SIGTERM", () => process.exit(0));',
  'await record("retry-result", { attempts }); await ready("retry"); setInterval(() => {}, 1000);',
].join("\n");
const READ_RECORDS = `const names = ${JSON.stringify(RECORDS)}; const records = {}; for (const name of names) records[name] = await Bun.file("/evidence/" + name + ".json").json(); process.stdout.write(JSON.stringify(records));`;

function object(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) {
    throw new Error("Expected fixture object; values omitted");
  }
  return value;
}

function data(result: CliResult): Record<string, unknown> {
  const value = object(result.stdout);
  expect({
    that: value.ok === true && isRecord(value.data),
    message: "Expected successful native CLI envelope",
  });
  if (!isRecord(value.data)) {
    throw new Error("Native CLI data is absent");
  }
  return value.data;
}

/** Reject weak evidence: a configured init flag, a signal receipt alone, or an eventual ready process is insufficient. */
export function verifyNativeProcessPolicyEvidence(opts: {
  readonly owner: string;
  readonly records: unknown;
  readonly gracefulExit: string;
  readonly forcedExit: string;
  readonly initEnabled: unknown;
  readonly restart: unknown;
  readonly retryContainer: string;
  readonly retryEvents: unknown;
}): void {
  expect({
    that: isRecord(opts.records),
    message: "Process evidence must be an object",
  });
  if (!isRecord(opts.records)) {
    return;
  }
  const records = opts.records;
  const read = (name: (typeof RECORDS)[number]): Record<string, unknown> => {
    const value = Object.hasOwn(records, name) ? records[name] : undefined;
    expect({
      that: isRecord(value) && value.owner === opts.owner,
      message: "Process evidence must match the fixture marker",
    });
    if (!isRecord(value)) {
      throw new Error("Process evidence is absent");
    }
    return value;
  };
  const gracefulSignal = read("graceful-signal");
  const complete = read("graceful-complete");
  const forcedSignal = read("forced-signal");
  const heartbeat = read("forced-heartbeat");
  expect({
    that:
      [gracefulSignal, complete, forcedSignal, heartbeat].every(
        (value) => value.signal === "SIGUSR1"
      ) &&
      opts.gracefulExit === "0" &&
      opts.forcedExit === "137",
    message:
      "Selected nondefault signal must complete gracefully or terminate with SIGKILL as authored",
  });
  expect({
    that:
      typeof complete.elapsedMs === "number" &&
      complete.elapsedMs >= 1000 &&
      complete.elapsedMs < 2000 &&
      typeof heartbeat.elapsedMs === "number" &&
      heartbeat.elapsedMs >= 1500 &&
      heartbeat.elapsedMs < 4000,
    message:
      "Observed signal handling and forced-stop heartbeat must respect the authored two-second grace",
  });
  const init = read("init-result");
  expect({
    that:
      opts.initEnabled === true &&
      typeof init.appPid === "number" &&
      Number.isInteger(init.appPid) &&
      init.appPid > 1 &&
      typeof init.adoptedPid === "number" &&
      Number.isInteger(init.adoptedPid) &&
      init.adoptedPid > 1 &&
      init.parent === 1 &&
      init.initName === "docker-init" &&
      init.reaped === true,
    message:
      "Actual init must adopt and reap an orphan; the engine flag alone does not qualify this",
  });
  const retry = read("retry-result");
  expect({
    that:
      retry.attempts === 3 &&
      isRecord(opts.restart) &&
      opts.restart.name === "on-failure" &&
      opts.restart.maximumRetryCount === 2 &&
      opts.restart.restartCount === 2,
    message:
      "Failure policy must execute exactly two retries before its successful third start",
  });
  const events = opts.retryEvents;
  expect({
    that:
      RESOURCE_ID.test(opts.retryContainer) &&
      Array.isArray(events) &&
      events.length === 5 &&
      events.every(
        (event) =>
          isRecord(event) &&
          event.id === opts.retryContainer &&
          (event.action === "start" ||
            (event.action === "die" && event.exitCode === "17"))
      ) &&
      events.filter((event) => isRecord(event) && event.action === "start")
        .length === 3 &&
      events.filter((event) => isRecord(event) && event.action === "die")
        .length === 2,
    message:
      "Exact owned retry events must independently show two failures and three starts",
  });
}

export function nativeProcessPolicyProject(opts: {
  readonly name: string;
  readonly image: string;
}): Project {
  const workload = (name: string, program: string): Workload => ({
    image: opts.image,
    pull_policy: "never",
    init: true,
    restart: { kind: "no" },
    shutdown: {
      signal: name === "graceful" || name === "forced" ? "SIGUSR1" : "SIGTERM",
      grace: "2s",
    },
    command: { exec: ["bun", "-e", program] },
    environment: { FIXTURE_OWNER: { literal: opts.name } },
    profiles: ["exercise"],
    mounts: [
      { storage: "evidence", target: "/evidence", access: "read-write" },
    ],
    readiness: {
      kind: "exec",
      command: {
        exec: [
          "bun",
          "-e",
          `const r=await Bun.file("/evidence/${name}-ready.json").json();process.exit(r.ready===true&&r.owner===${JSON.stringify(opts.name)}?0:1);`,
        ],
      },
      interval: "1s",
      timeout: "5s",
      retries: 30,
    },
  });
  return {
    schema_version: 1,
    name: opts.name,
    profiles: ["exercise", "readback"],
    storage: { evidence: { kind: "persistent", scope: "worktree" } },
    services: {
      graceful: workload("graceful", GRACEFUL),
      forced: workload("forced", FORCED),
      reaper: workload("reaper", INIT),
      retry: {
        ...workload("retry", RETRY),
        restart: { kind: "on-failure", max_retries: 2 },
      },
      observer: {
        image: opts.image,
        pull_policy: "never",
        command: { exec: ["bun", "-e", "setInterval(() => {}, 1000)"] },
        profiles: ["readback"],
        mounts: [
          { storage: "evidence", target: "/evidence", access: "read-only" },
        ],
        readiness: {
          kind: "exec",
          command: { exec: ["bun", "-e", READ_RECORDS] },
          interval: "1s",
          timeout: "5s",
          retries: 30,
        },
      },
    },
  };
}

/** Compile diagnostics identify unsupported intent; execution deliberately returns a fixed redacted refusal. */
export function verifyUnsupportedNativeProcessPolicy(opts: {
  readonly field: "resources" | "logging";
  readonly compilerReport: unknown;
  readonly executionReport: unknown;
}): void {
  const compiler = opts.compilerReport;
  const diagnostic =
    isRecord(compiler) &&
    Array.isArray(compiler.diagnostics) &&
    compiler.diagnostics.length === 1
      ? compiler.diagnostics[0]
      : null;
  expect({
    that:
      isRecord(compiler) &&
      compiler.transport_version === 1 &&
      compiler.ok === false &&
      isRecord(diagnostic) &&
      diagnostic.code === "unknown_field" &&
      diagnostic.pointer === `/services/unsupported/${opts.field}` &&
      diagnostic.document === "project",
    message:
      "Compiler must specifically refuse the unsupported resource/logging field",
  });
  const execution = opts.executionReport;
  expect({
    that:
      isRecord(execution) &&
      execution.ok === false &&
      isRecord(execution.error) &&
      execution.error.code === "E_UNEXPECTED" &&
      execution.error.message === EXECUTION_INPUT_REFUSAL,
    message: "Native execution must return its fixed redacted input refusal",
  });
}

/** Actual compiler/CLI refusals run behind engine and hook tripwires, including unselected declarations. */
async function refuseUnsupportedPolicies(opts: {
  readonly root: string;
  readonly source: string;
  readonly image: string;
  readonly project: Project;
  readonly invoke: (
    args: readonly string[],
    env: Readonly<Record<string, string>>
  ) => Promise<CliResult>;
}): Promise<void> {
  const baseline = await opts.invoke(
    ["--profile", "exercise", "config", "validate", "--json"],
    {}
  );
  expectExit({
    result: baseline,
    codes: [0],
    message: "The supported process-policy fixture must validate first",
  });
  expect({
    that: object(baseline.stdout).ok === true,
    message: "Supported process-policy declarations must compile successfully",
  });
  const tripwire = join(opts.root, "tripwire");
  await mkdir(tripwire);
  const engineCalled = join(tripwire, "engine-called");
  const hookCalled = join(tripwire, "hook-called");
  const fakeDocker = join(tripwire, "docker");
  await Bun.write(
    fakeDocker,
    `#!${process.execPath}\nawait Bun.write(${JSON.stringify(engineCalled)}, "called");process.exit(99);\n`
  );
  await chmod(fakeDocker, 0o700);
  for (const field of ["resources", "logging"] as const) {
    for (const inactive of [false, true]) {
      const invalid: unknown = {
        ...opts.project,
        host: {
          up: {
            before: [
              {
                name: "must-not-run",
                command: {
                  exec: [
                    process.execPath,
                    "-e",
                    `await Bun.write(${JSON.stringify(hookCalled)}, "called")`,
                  ],
                },
              },
            ],
          },
        },
        services: {
          ...opts.project.services,
          unsupported: {
            image: opts.image,
            ...(inactive ? { profiles: ["readback"] } : {}),
            [field]: { value: UNSUPPORTED_VALUE },
          },
        },
      };
      await Bun.write(opts.source, JSON.stringify(invalid));
      const validation = await opts.invoke(
        ["--profile", "exercise", "config", "validate", "--json"],
        { PATH: `${tripwire}:${process.env.PATH ?? "/usr/bin:/bin"}` }
      );
      const result = await opts.invoke(
        ["--profile", "exercise", "up", "--detach", "--json"],
        { PATH: `${tripwire}:${process.env.PATH ?? "/usr/bin:/bin"}` }
      );
      expect({
        that:
          validation.exitCode !== 0 &&
          !validation.timedOut &&
          !validation.combined.includes(UNSUPPORTED_VALUE) &&
          result.exitCode !== 0 &&
          !result.timedOut &&
          !result.combined.includes(UNSUPPORTED_VALUE),
        message:
          "Unsupported resource/logging intent, including inactive workloads, must refuse with redacted compiler diagnostics",
      });
      verifyUnsupportedNativeProcessPolicy({
        field,
        compilerReport: object(validation.stdout),
        executionReport: object(result.stdout),
      });
      expect({
        that: !(
          (await Bun.file(engineCalled).exists()) ||
          (await Bun.file(hookCalled).exists())
        ),
        message:
          "Unsupported intent must refuse before engine access or lifecycle hooks",
      });
    }
  }
}

export const nativeConfigProcessPolicyScenario: Scenario = {
  name: "native-config-process-policy",
  tier: "docker",
  summary:
    "actual stop signal/grace, init orphan reaping, failure retries and unsupported-resource refusal",
  run: async (ctx) => {
    expect({
      that: resolveCliSpawnArgs([]).length === 1,
      message:
        "Native process acceptance requires the current compiled CLI and matching compiler",
    });
    const started = performance.now();
    const stage = (message: string): void =>
      ctx.log(
        `${message} (elapsed ${Math.round(performance.now() - started)}ms)`
      );
    const docker = async (args: readonly string[]): Promise<string> => {
      const result = await runCommand({
        argv: ["docker", ...args],
        cwd: ctx.tempRoot,
        timeoutMs: TIMEOUT,
      });
      expectExit({
        result,
        codes: [0],
        message: `Fixture Docker ${args[0]} must succeed`,
      });
      return result.stdout.trim();
    };
    expect({
      that:
        (await docker(["info", "--format", "{{.OSType}}"])).trim() === "linux",
      message: "Process policy requires a Linux Docker daemon",
    });
    const image = await docker([
      "image",
      "inspect",
      "oven/bun:1.4.2-slim",
      "--format",
      "{{.Id}}",
    ]);
    expect({
      that: IMAGE_ID.test(image),
      message: "Bun image must already be cached; no image pulls are permitted",
    });
    const created = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: false,
    });
    const root = await realpath(created.root);
    const hackDir = join(root, ".hack");
    await mkdir(hackDir);
    const source = join(hackDir, "hack.project.json");
    const project = nativeProcessPolicyProject({ name: created.name, image });
    const projectText = `${JSON.stringify(project, null, 2)}\n`;
    const restore = async (): Promise<void> => {
      await Bun.write(source, projectText);
    };
    await restore();
    expect({
      that: !(
        (await Bun.file(join(hackDir, "hack.config.json")).exists()) ||
        (await Bun.file(join(hackDir, "docker-compose.yml")).exists())
      ),
      message: "Only native authored configuration may select this fixture",
    });
    const raw = (
      args: readonly string[],
      env: Readonly<Record<string, string>> = {}
    ): Promise<CliResult> =>
      ctx.cli({
        args,
        cwd: root,
        timeoutMs: TIMEOUT,
        env: {
          HACK_RUNTIME_BACKEND: "compose",
          HACK_DAEMON_DISABLE_DOCKER_EVENTS: "1",
          ...env,
        },
      });
    const cli = async (args: readonly string[]): Promise<CliResult> => {
      const result = await raw(args);
      expectExit({
        result,
        codes: [0],
        message: `Native ${args[0]} must succeed`,
      });
      return result;
    };
    await refuseUnsupportedPolicies({
      root,
      source,
      image,
      project,
      invoke: raw,
    });
    await restore();
    stage(
      "resource/logging and inactive-profile refusals verified before engine/hook access"
    );
    let identity: Identity | null = null;
    let readerId: string | null = null;
    const readerToken = crypto.randomUUID().replaceAll("-", "");
    const readIdentity = async (): Promise<void> => {
      const store = await openNativeComposeGenerationStore({
        projectRoot: root,
        instance: null,
        mode: "saved",
      });
      try {
        identity = {
          composeProject: store.identity.composeProject,
          ownerToken: store.identity.ownerToken,
        };
      } finally {
        await store.close();
      }
    };
    const owner = (): Identity => {
      if (!(identity && TOKEN.test(identity.ownerToken))) {
        throw new Error("Verified process fixture ownership is absent");
      }
      return identity;
    };
    const list = async (kind: ResourceKind): Promise<string[]> => {
      const expected = owner();
      return (
        await docker([
          ...(kind === "container"
            ? ["ps", "-aq", "--no-trunc"]
            : [
                kind,
                "ls",
                "-q",
                ...(kind === "network" ? ["--no-trunc"] : []),
              ]),
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
    const owned = async (kind: ResourceKind, id: string): Promise<void> => {
      const labels = object(
        await docker([
          kind,
          "inspect",
          id,
          "--format",
          kind === "container" ? "{{json .Config.Labels}}" : "{{json .Labels}}",
        ])
      );
      const expected = owner();
      expect({
        that:
          labels[OWNER] === expected.ownerToken &&
          labels[INSTANCE] === expected.composeProject &&
          labels[COMPOSE_PROJECT] === expected.composeProject &&
          labels["io.hack.native-config.version"] === "1",
        message:
          "Every process fixture resource effect requires exact native ownership",
      });
    };
    const service = async (name: string): Promise<string> => {
      const ids = (
        await docker([
          "ps",
          "-aq",
          "--no-trunc",
          "--filter",
          `label=${COMPOSE_PROJECT}=${owner().composeProject}`,
          "--filter",
          `label=${COMPOSE_SERVICE}=${name}`,
          "--filter",
          "label=com.docker.compose.oneoff=False",
        ])
      )
        .split(/\s+/)
        .filter(Boolean);
      const id = ids[0];
      expect({
        that: ids.length === 1 && id !== undefined && RESOURCE_ID.test(id),
        message: "Expected exactly one selected process fixture workload",
      });
      if (!id) {
        throw new Error("Process workload is absent");
      }
      await owned("container", id);
      expect({
        that:
          (
            await docker([
              "inspect",
              id,
              "--format",
              "{{len .HostConfig.PortBindings}}",
            ])
          ).trim() === "0",
        message: "Process fixture must publish no ports",
      });
      return id;
    };
    const clearReader = async (): Promise<void> => {
      const selected = (
        await docker([
          "ps",
          "-aq",
          "--no-trunc",
          "--filter",
          `label=${READER_OWNER}=${readerToken}`,
        ])
      )
        .split(/\s+/)
        .filter(Boolean);
      if (!readerId) {
        expect({
          that: selected.length === 0,
          message:
            "Uncaptured reader resources must retain the recovery roots instead of being silently abandoned",
        });
        return;
      }
      expect({
        that: selected.length === 1 && selected[0] === readerId,
        message:
          "Reader cleanup must select only its originally captured identity",
      });
      const actual = object(
        await docker([
          "inspect",
          readerId,
          "--format",
          '{"id":{{json .Id}},"token":{{json (index .Config.Labels "hack.e2e.native-process-policy-reader")}},"running":{{json .State.Running}}}',
        ])
      );
      expect({
        that:
          actual.id === readerId &&
          actual.token === readerToken &&
          actual.running === false,
        message:
          "Only the exact stopped fixture readback container may be removed",
      });
      await docker(["rm", readerId]);
      readerId = null;
    };
    const cleanup = async (): Promise<void> => {
      await restore();
      if (
        !identity &&
        (await Bun.file(
          join(hackDir, ".internal/native-compose/.gitignore")
        ).exists())
      ) {
        await readIdentity();
      }
      await clearReader();
      if (!identity) {
        return;
      }
      await cli(["down", "--recover", "--json"]);
      for (const kind of ["container", "network", "volume"] as const) {
        const ids = await list(kind);
        for (const id of ids) {
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
            "Final process fixture cleanup must leave no owned engine resources",
        });
      }
    };
    let failure: unknown;
    let failed = false;
    try {
      const eventStart = await docker(["info", "--format", "{{.SystemTime}}"]);
      expect({
        that:
          eventStart.length <= 64 && Number.isFinite(Date.parse(eventStart)),
        message: "Retry event history requires the exact engine clock",
      });
      const expectedEngineId = await docker(["info", "--format", "{{.ID}}"]);
      const initialUp = await raw([
        "--profile",
        "exercise",
        "up",
        "--detach",
        "--json",
      ]);
      const diagnostic = await recordKnownUncertainProcessPolicyStartup({
        result: initialUp,
        projectRoot: root,
        expectedEngineId,
        record: async (summary) => {
          const handle = await open(
            join(ctx.tempRoot, "native-process-policy-startup-diagnostic.json"),
            "wx",
            0o600
          );
          try {
            await handle.writeFile(`${JSON.stringify(summary)}\n`);
            await handle.sync();
          } finally {
            await handle.close();
          }
          ctx.log(`fixed-field startup diagnostic: ${JSON.stringify(summary)}`);
        },
      });
      if (diagnostic !== "not-applicable") {
        stage(`fixed-field startup diagnostic ${diagnostic}`);
      }
      expectExit({
        result: initialUp,
        codes: [0],
        message: "Native --profile must succeed",
      });
      expect({
        that: data(initialUp).status === "ready",
        message: "Process policy workloads must actually reach readiness",
      });
      await readIdentity();
      const gracefulId = await service("graceful");
      const forcedId = await service("forced");
      const reaperId = await service("reaper");
      const retryId = await service("retry");
      const initEnabled: unknown = JSON.parse(
        await docker([
          "inspect",
          reaperId,
          "--format",
          "{{json .HostConfig.Init}}",
        ])
      );
      const restart = object(
        await docker([
          "inspect",
          retryId,
          "--format",
          '{"name":{{json .HostConfig.RestartPolicy.Name}},"maximumRetryCount":{{json .HostConfig.RestartPolicy.MaximumRetryCount}},"restartCount":{{json .RestartCount}}}',
        ])
      );
      const eventEnd = await docker(["info", "--format", "{{.SystemTime}}"]);
      expect({
        that: eventEnd.length <= 64 && Number.isFinite(Date.parse(eventEnd)),
        message: "Retry event history must have a finite engine-time endpoint",
      });
      const eventText = await docker([
        "events",
        "--since",
        eventStart,
        "--until",
        eventEnd,
        "--filter",
        "type=container",
        "--filter",
        `container=${retryId}`,
        "--filter",
        `label=${OWNER}=${owner().ownerToken}`,
        "--filter",
        "event=start",
        "--filter",
        "event=die",
        "--format",
        "{{json .}}",
      ]);
      expect({
        that: eventText.length <= 65_536,
        message: "Exact retry event proof must remain bounded",
      });
      const retryEvents = eventText
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const event = object(line);
          expect({
            that:
              isRecord(event.Actor) &&
              isRecord(event.Actor.Attributes) &&
              event.Actor.ID === retryId &&
              event.Actor.Attributes[OWNER] === owner().ownerToken &&
              event.Actor.Attributes[INSTANCE] === owner().composeProject &&
              event.Actor.Attributes[COMPOSE_SERVICE] === "retry",
            message: "Retry events must belong to the exact owned workload",
          });
          return {
            id: isRecord(event.Actor) ? event.Actor.ID : null,
            action: event.Action,
            exitCode:
              isRecord(event.Actor) && isRecord(event.Actor.Attributes)
                ? event.Actor.Attributes.exitCode
                : null,
          };
        });
      const startupProof = JSON.stringify({
        owner: created.name,
        retryContainer: retryId,
        restart,
        retryEvents,
        initEnabled,
      });
      expect({
        that: startupProof.length <= 65_536,
        message: "Retained synthetic startup proof must remain bounded",
      });
      await Bun.write(
        join(ctx.tempRoot, "native-process-policy-startup-proof.json"),
        startupProof
      );
      const volumes = await list("volume");
      const volume = volumes[0];
      expect({
        that: volumes.length === 1 && volume !== undefined,
        message:
          "Process markers must live in exactly one owned persistent volume",
      });
      if (!volume) {
        throw new Error("Owned process evidence volume is absent");
      }
      await owned("volume", volume);
      const createdAt = await docker([
        "volume",
        "inspect",
        volume,
        "--format",
        "{{.CreatedAt}}",
      ]);
      const wait = (id: string): Promise<CliResult> =>
        runCommand({
          argv: ["docker", "wait", id],
          cwd: root,
          timeoutMs: 30_000,
        });
      const gracefulWait = wait(gracefulId);
      const forcedWait = wait(forcedId);
      const waits = Promise.all([gracefulWait, forcedWait]);
      try {
        await cli(["down", "--json"]);
      } finally {
        // The clients started before down observe exit status even though product cleanup removes containers.
        await waits;
      }
      const [gracefulResult, forcedResult] = await waits;
      expectExit({
        result: gracefulResult,
        codes: [0],
        message: "Graceful exit observer must succeed",
      });
      expectExit({
        result: forcedResult,
        codes: [0],
        message: "Forced exit observer must succeed",
      });
      expect({
        that:
          (await list("container")).length === 0 &&
          (await list("network")).length === 0,
        message: "Native stop must remove transient process resources",
      });
      await owned("volume", volume);
      readerId = await docker([
        "create",
        "--pull=never",
        "--name",
        `native-process-reader-${readerToken}`,
        "--label",
        `${READER_OWNER}=${readerToken}`,
        "--network",
        "none",
        "--read-only",
        "--mount",
        `type=volume,source=${volume},target=/evidence,readonly`,
        image,
        "bun",
        "-e",
        READ_RECORDS,
      ]);
      expect({
        that: RESOURCE_ID.test(readerId),
        message: "Readback container identity must be complete",
      });
      const reader = object(
        await docker([
          "inspect",
          readerId,
          "--format",
          '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},"token":{{json (index .Config.Labels "hack.e2e.native-process-policy-reader")}},"network":{{json .HostConfig.NetworkMode}},"ports":{{len .HostConfig.PortBindings}},"readOnly":{{json .HostConfig.ReadonlyRootfs}},"mounts":{{json .Mounts}}}',
        ])
      );
      expect({
        that:
          reader.id === readerId &&
          reader.name === `/native-process-reader-${readerToken}` &&
          reader.image === image &&
          reader.token === readerToken &&
          reader.network === "none" &&
          reader.ports === 0 &&
          reader.readOnly === true &&
          Array.isArray(reader.mounts) &&
          reader.mounts.length === 1 &&
          isRecord(reader.mounts[0]) &&
          reader.mounts[0].Type === "volume" &&
          reader.mounts[0].Name === volume &&
          reader.mounts[0].Destination === "/evidence" &&
          reader.mounts[0].RW === false,
        message:
          "Readback must use only exact owned, unexposed, read-only fixture resources",
      });
      const recordText = await docker(["start", "--attach", readerId]);
      expect({
        that: recordText.length <= 32_768,
        message: "Synthetic process records must remain bounded",
      });
      const records = object(recordText);
      expect({
        that:
          (await docker([
            "inspect",
            readerId,
            "--format",
            "{{.State.ExitCode}}",
          ])) === "0",
        message: "Persistent evidence reader must exit successfully",
      });
      const proof = {
        owner: created.name,
        records,
        gracefulExit: gracefulResult.stdout.trim(),
        forcedExit: forcedResult.stdout.trim(),
        initEnabled,
        restart,
        retryContainer: retryId,
        retryEvents,
      };
      const proofText = JSON.stringify(proof);
      expect({
        that: proofText.length <= 65_536,
        message: "Retained synthetic process proof must remain bounded",
      });
      await Bun.write(
        join(ctx.tempRoot, "native-process-policy-proof.json"),
        proofText
      );
      await clearReader();
      verifyNativeProcessPolicyEvidence(proof);
      stage(
        "actual SIGUSR1, graceful/forced stop, init adoption/reaping and failure retries verified"
      );
      expect({
        that:
          data(await cli(["--profile", "readback", "up", "--detach", "--json"]))
            .status === "ready",
        message:
          "Readback generation must start against retained process evidence",
      });
      const observerId = await service("observer");
      const observerMounts: unknown = JSON.parse(
        await docker(["inspect", observerId, "--format", "{{json .Mounts}}"])
      );
      expect({
        that:
          Array.isArray(observerMounts) &&
          observerMounts.length === 1 &&
          isRecord(observerMounts[0]) &&
          observerMounts[0].Type === "volume" &&
          observerMounts[0].Name === volume &&
          observerMounts[0].Destination === "/evidence" &&
          observerMounts[0].RW === false,
        message:
          "The native observer must mount only the exact retained evidence volume read-only",
      });
      const writeControl = await raw([
        "exec",
        "observer",
        "--",
        "bun",
        "-e",
        'try { await Bun.write("/evidence/native-observer-write-canary", "unexpected-write"); process.exit(0); } catch(error) { if(error?.code === "EROFS") { process.stdout.write("read-only-volume"); process.exit(23); } process.exit(24); }',
      ]);
      expectExit({
        result: writeControl,
        codes: [23],
        message:
          "A write through the actual native observer must fail on its read-only filesystem",
      });
      expect({
        that: writeControl.stdout.trim() === "read-only-volume",
        message:
          "Read-only acceptance must distinguish EROFS from unrelated execution failure",
      });
      const canary = await cli([
        "exec",
        "observer",
        "--",
        "bun",
        "-e",
        'process.stdout.write((await Bun.file("/evidence/native-observer-write-canary").exists()) ? "present" : "absent");',
      ]);
      expect({
        that: canary.stdout.trim() === "absent",
        message: "Rejected native observer writes must leave no marker",
      });
      const retained = await list("volume");
      expect({
        that:
          retained.length === 1 &&
          retained[0] === volume &&
          (
            await docker([
              "volume",
              "inspect",
              volume,
              "--format",
              "{{.CreatedAt}}",
            ])
          ).trim() === createdAt,
        message: "Down/up must retain the exact process evidence volume",
      });
      const restored = object(
        (await cli(["exec", "observer", "--", "bun", "-e", READ_RECORDS]))
          .stdout
      );
      expect({
        that: JSON.stringify(restored) === JSON.stringify(records),
        message:
          "Read-only native execution must recover every original process marker unchanged",
      });
      stage("retained process markers and profile transition verified");
    } catch (error: unknown) {
      failed = true;
      failure = error;
    }
    try {
      await cleanup();
    } catch (error: unknown) {
      ctx.retainFixtures(
        "Owned process-policy cleanup is incomplete; retained receipts and volume markers are required for recovery"
      );
      await Bun.write(
        join(ctx.tempRoot, "native-process-policy-recovery.json"),
        JSON.stringify(
          {
            version: 1,
            projectRoot: root,
            hackHome: ctx.hackHome,
            identity,
            readerId,
            readerToken,
          },
          null,
          2
        )
      );
      if (failed) {
        stage(
          "secondary owned cleanup failure; private recovery roots retained"
        );
      } else {
        failed = true;
        failure = error;
      }
    }
    if (failed) {
      throw failure;
    }
    stage(
      "exact owned process fixture cleanup verified; resource enforcement remains unsupported"
    );
  },
};
