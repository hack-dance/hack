import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type {
  HostHook,
  Project,
} from "../../../packages/config-compiler/generated/native-config.ts";
import { isRecord } from "../../../src/lib/guards.ts";
import { createNativeComposeProbe } from "../../../src/lib/native-compose-ownership.ts";
import { setProjectEnvValue } from "../../../src/lib/project-env-config.ts";
import { run } from "../../../src/lib/shell.ts";
import { createMonorepoFixture } from "../fixture.ts";
import {
  type CliResult,
  expect,
  expectExit,
  resolveCliSpawnArgs,
  type Scenario,
  type ScenarioContext,
} from "../harness.ts";
import {
  type NativeComposeFixtureVolumePin,
  observeNativeComposeFixture,
  pinNativeComposeFixtureVolume,
  runWithOwnedCleanup,
} from "../native-compose-owned-fixture.ts";

const TIMEOUT = 90_000;
const HOST_VALUE = "synthetic-down-host-$literal";
function data(result: CliResult): Record<string, unknown> {
  const value: unknown = JSON.parse(result.stdout);
  if (!(isRecord(value) && value.ok === true && isRecord(value.data))) {
    throw new Error(
      "Expected successful saved native fixture state; values omitted"
    );
  }
  return value.data;
}
function noValues(result: CliResult): void {
  expect({
    that: !result.combined.includes(HOST_VALUE),
    message: "Synthetic host values must stay out of CLI output",
  });
}
async function setup(ctx: ScenarioContext) {
  expect({
    that: resolveCliSpawnArgs([]).length === 1,
    message:
      "Down-hook acceptance requires the current compiled CLI and companion compiler",
  });
  const docker = (args: readonly string[]) =>
    createNativeComposeProbe({ timeoutMs: 10_000 })(args);
  const image = (
    await docker([
      "image",
      "inspect",
      "oven/bun:1.4.2-slim",
      "--format",
      "{{.Id}}",
    ])
  ).trim();
  expect({
    that: /^sha256:[a-f0-9]{64}$/.test(image),
    message:
      "Down-hook fixture requires the cached exact Bun image; no image pulls",
  });
  const created = await createMonorepoFixture({
    parentDir: ctx.tempRoot,
    withHackConfig: false,
  });
  const root = await realpath(created.root);
  const projectDir = join(root, ".hack");
  await mkdir(projectDir);
  for (const [scope, value] of [
    ["global", "synthetic-down-guest"],
    ["host", HOST_VALUE],
  ] as const) {
    await setProjectEnvValue({
      projectRoot: root,
      projectDir,
      envName: null,
      scope,
      key: "DOWN_TOKEN",
      value,
      secret: false,
    });
  }
  const helper = new URL("../native-compose-owned-fixture.ts", import.meta.url)
    .href;
  await Bun.write(
    join(root, "down-hook.ts"),
    `
import {appendFile} from "node:fs/promises";
import {observeNativeComposeFixture} from ${JSON.stringify(helper)};
const phase=process.argv[2];
if(process.env.SEEN!==${JSON.stringify(HOST_VALUE)}||Object.hasOwn(process.env,"DOWN_TOKEN")||process.env.EMPTY!=="")process.exit(41);
const state=await observeNativeComposeFixture(process.cwd());
if(state.pending?.operation!=="down"||state.hostHookPhase!=="down."+phase||state.observed.volumes.length!==1)process.exit(42);
if(phase==="before"?state.observed.containers.length!==1||state.observed.containers[0].state!=="running":state.observed.containers.length!==0||state.observed.networks.length!==0)process.exit(43);
await appendFile("order",phase+"\\n");
if((await Bun.file("mode").text())===phase+"17")process.exit(17);
`
  );
  const hook = (phase: string): HostHook => ({
    name: `down-${phase}`,
    command: { exec: [process.execPath, "down-hook.ts", phase] },
    environment: {
      SEEN: { env_ref: "DOWN_TOKEN" },
      DOWN_TOKEN: { unset: true },
      EMPTY: { literal: "" },
    },
  });
  const project: Project = {
    schema_version: 1,
    name: created.name,
    source: { root: ".", mode: "host-mounted" },
    worktree: { inherit_local: false, auto_branch: false },
    storage: { data: { kind: "persistent", scope: "worktree" } },
    services: {
      app: {
        image,
        pull_policy: "never",
        restart: { kind: "no" },
        shutdown: { signal: "SIGTERM", grace: "1s" },
        command: {
          exec: [
            "bun",
            "-e",
            'const file=Bun.file("/data/marker");const next=(await file.exists()?Number(await file.text()):0)+1;if(!Number.isSafeInteger(next))process.exit(44);await Bun.write("/data/marker",String(next));await Bun.write("/tmp/started","yes");setInterval(()=>{},60000)',
          ],
        },
        mounts: [{ storage: "data", target: "/data", access: "read-write" }],
        readiness: {
          kind: "exec",
          command: {
            exec: [
              "bun",
              "-e",
              'process.exit(await Bun.file("/tmp/started").exists()&&process.env.DOWN_TOKEN==="synthetic-down-guest"&&!Object.hasOwn(process.env,"SEEN")?0:1)',
            ],
          },
          interval: "1s",
          timeout: "2s",
          retries: 10,
        },
      },
    },
    host: {
      down: {
        before: [hook("before")],
        after: [
          hook("after"),
          {
            name: "down-tail",
            command: { shell: "printf 'tail\\n' >> order" },
          },
        ],
      },
    },
  };
  const projectPath = join(projectDir, "hack.project.json");
  const projectText = JSON.stringify(project);
  await Bun.write(projectPath, projectText);
  const envPath = join(projectDir, "hack.env.default.yaml");
  const envText = await Bun.file(envPath).text();
  const raw = async (args: readonly string[]) => {
    const result = await ctx.cli({
      args,
      cwd: root,
      timeoutMs: TIMEOUT,
      env: {
        HACK_RUNTIME_BACKEND: "compose",
        HACK_COMPOSE_STARTUP_TIMEOUT_MS: "15000",
        HACK_DAEMON_DISABLE_DOCKER_EVENTS: "1",
      },
    });
    noValues(result);
    if (result.timedOut) {
      ctx.retainFixtures(
        "CLI timeout leaves unverified finite down effects; inspect saved owner before cleanup"
      );
    }
    return result;
  };
  const pins: { volume: NativeComposeFixtureVolumePin | null } = {
    volume: null,
  };
  return {
    root,
    projectPath,
    projectText,
    envPath,
    envText,
    raw,
    docker,
    pins,
  };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function assertStopped(fixture: Fixture, volume: string): Promise<void> {
  const state = await observeNativeComposeFixture(fixture.root);
  expect({
    that:
      state.observed.containers.length === 0 &&
      state.observed.networks.length === 0 &&
      state.observed.volumes.length === 1 &&
      state.observed.volumes[0]?.name === volume,
    message: "Exact engine stop must retain the same owned data volume",
  });
}
async function cleanup(ctx: ScenarioContext, fixture: Fixture): Promise<void> {
  const result = await fixture.raw(["down", "--recover", "--json"]);
  expectExit({
    result,
    codes: [0],
    message: "Cleanup must explicitly stop saved ownership without replay",
  });
  const state = await observeNativeComposeFixture(fixture.root);
  expect({
    that:
      state.stopped &&
      state.pending === null &&
      !state.beforeHooksPending &&
      state.observed.containers.length === 0 &&
      state.observed.networks.length === 0,
    message: "Unknown hook or engine effects prevent volume cleanup",
  });
  const pin = fixture.pins.volume;
  const current = await pinNativeComposeFixtureVolume({
    ...state,
    probe: fixture.docker,
  });
  if (!pin || JSON.stringify(current) !== JSON.stringify(pin)) {
    throw new Error("Original fixture volume pin is missing or changed");
  }
  // Repeat whole-owner absence and the original creation/storage/owner pin immediately before deletion.
  const immediate = await observeNativeComposeFixture(fixture.root);
  expect({
    that:
      immediate.stopped &&
      immediate.pending === null &&
      !immediate.beforeHooksPending &&
      immediate.observed.containers.length === 0 &&
      immediate.observed.networks.length === 0,
    message: "Changed stop ownership prevents fixture volume cleanup",
  });
  const final = await pinNativeComposeFixtureVolume({
    ...immediate,
    probe: fixture.docker,
  });
  if (JSON.stringify(final) !== JSON.stringify(pin)) {
    throw new Error("Fixture volume changed immediately before cleanup");
  }
  const code = await run(["docker", "volume", "rm", pin.name], {
    stdin: "ignore",
    timeoutMs: 10_000,
    forwardSignals: true,
  });
  expect({
    that: code === 0,
    message: "Remove only the immediately reverified original fixture volume",
  });
  const absent = await observeNativeComposeFixture(fixture.root);
  expect({
    that:
      absent.observed.volumes.length === 0 &&
      absent.observed.containers.length === 0 &&
      absent.observed.networks.length === 0,
    message: "Exact owned fixture cleanup must leave no resources",
  });
  ctx.log("finite down-hook fixture cleanup verified");
}
async function exercise(fixture: Fixture): Promise<void> {
  for (const [index, mode] of ["success", "before17", "after17"].entries()) {
    await Bun.write(join(fixture.root, "mode"), mode);
    await Bun.write(join(fixture.root, "order"), "");
    const up = await fixture.raw(["up", "--detach", "--json"]);
    expectExit({
      result: up,
      codes: [0],
      message: "Each finite down mode starts a ready owned generation",
    });
    expect({
      that: data(up).status === "ready",
      message: "Fixture startup must commit ready",
    });
    const observed = await observeNativeComposeFixture(fixture.root);
    const current = await pinNativeComposeFixtureVolume({
      ...observed,
      probe: fixture.docker,
    });
    expect({
      that:
        fixture.pins.volume === null ||
        JSON.stringify(fixture.pins.volume) === JSON.stringify(current),
      message: "Later starts preserve original volume creation/storage/owner",
    });
    fixture.pins.volume ??= current;
    const volume = current.name;
    const marker = await fixture.raw([
      "exec",
      "app",
      "--",
      "bun",
      "-e",
      'console.log(await Bun.file("/data/marker").text())',
    ]);
    expectExit({
      result: marker,
      codes: [0],
      message:
        "Read only the synthetic retained-data counter in the owned workload",
    });
    expect({
      that: marker.stdout.trim() === String(index + 1),
      message: "Persistent data must survive each completed or recovered stop",
    });
    const result = await fixture.raw(["down", "--json"]);
    expectExit({
      result,
      codes: [mode === "success" ? 0 : 17],
      message: "Finite down mode preserves exact hook exit",
    });
    const order = await Bun.file(join(fixture.root, "order")).text();
    expect({
      that:
        order ===
        (mode === "success"
          ? "before\nafter\ntail\n"
          : mode === "before17"
            ? "before\n"
            : "before\nafter\n"),
      message:
        "Authored phases surround verified teardown and skip later hooks on failure",
    });
    const state = data(await fixture.raw(["ps", "--json"]));
    expect({
      that:
        state.pending === (mode !== "success") &&
        state.beforeHooksPending === false &&
        state.stopped === (mode === "success"),
      message:
        "Known finite exit clears only its hook intent and keeps failed stop pending",
    });
    if (mode === "before17") {
      expect({
        that:
          (await observeNativeComposeFixture(fixture.root)).observed.containers
            .length === 1,
        message: "Before failure must not stop the owned workload",
      });
    } else {
      await assertStopped(fixture, volume);
    }
    if (mode !== "success") {
      await Bun.write(fixture.projectPath, "malformed source");
      await Bun.write(fixture.envPath, "malformed managed env");
      const recovered = await fixture.raw(["down", "--recover", "--json"]);
      expectExit({
        result: recovered,
        codes: [0],
        message: "Saved recovery bypasses malformed authored source and env",
      });
      expect({
        that:
          data(recovered).status === "stopped" &&
          data(recovered).hostHooksSkipped === true,
        message: "Engine recovery explicitly reports skipped hooks",
      });
      expect({
        that: (await Bun.file(join(fixture.root, "order")).text()) === order,
        message: "Recovery never replays known failed authored hooks",
      });
      await assertStopped(fixture, volume);
      await Bun.write(fixture.projectPath, fixture.projectText);
      await Bun.write(fixture.envPath, fixture.envText);
    }
  }
}

export const nativeConfigDownHooksScenario: Scenario = {
  name: "native-config-down-hooks",
  tier: "docker",
  summary:
    "finite down before/after, exact pending recovery and retained owned data",
  run: async (ctx) => {
    const fixture = await setup(ctx);
    await runWithOwnedCleanup({
      run: () => exercise(fixture),
      cleanup: async () => {
        try {
          await cleanup(ctx, fixture);
        } catch (error) {
          ctx.retainFixtures(
            "Finite down fixture cleanup is incomplete; saved ownership/resources retained"
          );
          throw error;
        }
      },
      secondaryFailure: () =>
        ctx.log(
          "Exact finite down cleanup also failed; retain the first failure and owned fixture"
        ),
    });
  },
};
