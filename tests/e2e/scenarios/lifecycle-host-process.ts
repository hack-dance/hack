import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isRecord } from "../../../src/lib/guards.ts";
import { resolveLifecycleSupervisorRoot } from "../../../src/lib/lifecycle-supervisor.ts";
import { restoreEnv } from "../../helpers/env.ts";

import { createMonorepoFixture } from "../fixture.ts";
import { expect, expectExit, runCommand, type Scenario } from "../harness.ts";
import { downBestEffort, requireDockerPreconditions } from "./docker-shared.ts";

const UP_TIMEOUT_MS = 420_000;

/**
 * Lifecycle host hooks run as part of `hack up` (there is no standalone
 * lifecycle start/stop command today), so this scenario lives in the docker
 * tier: `hack up --detach` must execute the configured lifecycle.up.before
 * hook on the host (observed via a marker file) before starting services,
 * record lifecycle runtime state under .hack/.internal/lifecycle/, and retain
 * the wrapped command's actual process group for teardown.
 */
export const lifecycleHostProcessScenario: Scenario = {
  name: "lifecycle-host-process",
  tier: "docker",
  summary: "lifecycle hooks and command-group teardown run during up/down",
  run: async (ctx) => {
    await requireDockerPreconditions({ ctx });
    const supervisor = process.env.HACK_LIFECYCLE_RUNNER === "supervisor";

    const markerFile = join(ctx.tempRoot, "lifecycle-marker.txt");
    const envMarkerFile = join(ctx.tempRoot, "lifecycle-env-marker.txt");
    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
      lifecycle: {
        persistentProcess: true,
        upBeforeMarkerFile: markerFile,
        upBeforeEnvMarkerFile: envMarkerFile,
        standaloneContainers: true,
      },
    });
    if (supervisor) {
      const binary =
        process.env.HACK_LIFECYCLE_SUPERVISOR_BINARY ??
        resolve(
          ctx.repoRoot,
          ".hack-local/target/lifecycle-integration/debug/hack-lifecycle-supervisor"
        );
      expect({
        that: await Bun.file(binary).exists(),
        message:
          "supervisor host scenario requires its current-source executable",
      });
      // Store only the runner choice in this disposable fixture. The native
      // executable remains an explicit test environment override.
      await runSupervisorHostProcess({
        ctx,
        fixture,
        markerFile,
        envMarkerFile,
        binary,
      });
      return;
    }

    const previousTmuxRoot = process.env.TMUX_TMPDIR;
    process.env.TMUX_TMPDIR = ctx.tempRoot;
    const cli: typeof ctx.cli = (invocation) =>
      ctx.cli({
        ...invocation,
        env: { ...invocation.env, TMUX_TMPDIR: ctx.tempRoot },
      });
    try {
      const up = await cli({
        args: ["up", "--detach"],
        cwd: fixture.root,
        timeoutMs: UP_TIMEOUT_MS,
      });
      expectExit({
        result: up,
        codes: [0],
        message: "hack up --detach with a lifecycle hook should succeed",
      });

      const marker = Bun.file(markerFile);
      expect({
        that: await marker.exists(),
        message: `lifecycle.up.before hook did not run (missing marker ${markerFile})`,
        result: up,
      });
      expect({
        that: (await marker.text()).includes("up-before-ran"),
        message: "lifecycle marker file has unexpected content",
        result: up,
      });
      const envMarker = Bun.file(envMarkerFile);
      expect({
        that: await envMarker.exists(),
        message: `lifecycle env hook did not run (missing marker ${envMarkerFile})`,
        result: up,
      });
      expect({
        that: (await envMarker.text()) === "host-value|host-only",
        message:
          "lifecycle hooks did not receive global values with host overrides",
        result: up,
      });

      const statePath = join(
        fixture.hackDir,
        ".internal",
        "lifecycle",
        "state.json"
      );
      const firstState = await readLifecycleState({ path: statePath });
      const firstEntry = firstState.entries[0];
      expect({
        that: Boolean(firstEntry?.ownershipToken),
        message: "lifecycle state should persist an ownership token",
        result: up,
      });
      const sleeper = firstEntry?.processes?.find(
        (process) => process.name === "e2e-sleeper"
      );
      const panePid = sleeper?.panePid ?? 0;
      const processGroupId = sleeper?.processGroupId ?? 0;
      expect({
        that:
          Number.isInteger(panePid) &&
          panePid > 1 &&
          Number.isInteger(processGroupId) &&
          processGroupId > 1 &&
          processGroupId !== panePid,
        message:
          "lifecycle state should persist the wrapped command group, not the tmux pane group",
        result: up,
      });

      const groupLeader = await runCommand({
        argv: ["ps", "-o", "pgid=", "-p", String(processGroupId)],
        cwd: fixture.root,
      });
      expectExit({
        result: groupLeader,
        codes: [0],
        message: "persisted lifecycle command group leader should be live",
      });
      expect({
        that: Number.parseInt(groupLeader.stdout.trim(), 10) === processGroupId,
        message:
          "persisted lifecycle PGID does not match the live command group",
        result: groupLeader,
      });

      // New sessions keep ownership in the session environment, populated over stdin.
      const owner = await runCommand({
        argv: [
          "tmux",
          "show-environment",
          "-t",
          `${fixture.name}--lifecycle`,
          "HACK_LIFECYCLE_OWNER_TOKEN",
        ],
        cwd: fixture.root,
      });
      expectExit({
        result: owner,
        codes: [0],
        message: "tmux lifecycle session should expose ownership metadata",
      });
      expect({
        that:
          owner.stdout.trim() ===
          `HACK_LIFECYCLE_OWNER_TOKEN=${firstEntry?.ownershipToken}`,
        message: "tmux and lifecycle state ownership tokens should match",
        result: owner,
      });

      const repeatedUp = await cli({
        args: ["up", "--detach"],
        cwd: fixture.root,
        timeoutMs: UP_TIMEOUT_MS,
      });
      expectExit({
        result: repeatedUp,
        codes: [0],
        message: "hack up should adopt its healthy lifecycle session",
      });
      const adoptedState = await readLifecycleState({ path: statePath });
      expect({
        that:
          adoptedState.entries[0]?.ownershipToken ===
          firstEntry?.ownershipToken,
        message: "healthy lifecycle adoption should preserve ownership token",
        result: repeatedUp,
      });

      const legacyState = {
        entries: adoptedState.entries.map((entry) => {
          const {
            definitionHash: _definitionHash,
            ownershipToken: _token,
            ...rest
          } = entry;
          return rest;
        }),
      };
      await Bun.write(statePath, `${JSON.stringify(legacyState, null, 2)}\n`);
      const clearOwner = await runCommand({
        argv: [
          "tmux",
          "set-environment",
          "-u",
          "-t",
          `${fixture.name}--lifecycle`,
          "HACK_LIFECYCLE_OWNER_TOKEN",
        ],
        cwd: fixture.root,
      });
      expectExit({
        result: clearOwner,
        codes: [0],
        message: "failed to simulate a pre-ownership lifecycle session",
      });
      const clearedOwner = await runCommand({
        argv: [
          "tmux",
          "show-environment",
          "-t",
          `${fixture.name}--lifecycle`,
          "HACK_LIFECYCLE_OWNER_TOKEN",
        ],
        cwd: fixture.root,
      });
      expectExit({
        result: clearedOwner,
        codes: [1],
        message: "legacy fixture should have no session ownership token",
      });

      const recoveredUp = await cli({
        args: ["up", "--detach"],
        cwd: fixture.root,
        timeoutMs: UP_TIMEOUT_MS,
      });
      expectExit({
        result: recoveredUp,
        codes: [0],
        message:
          "hack up should replace a legacy session with strong tmux proof",
      });
      const recoveredState = await readLifecycleState({ path: statePath });
      expect({
        that: Boolean(recoveredState.entries[0]?.ownershipToken),
        message: "legacy recovery should write current ownership metadata",
        result: recoveredUp,
      });

      const down = await cli({
        args: ["down"],
        cwd: fixture.root,
        timeoutMs: UP_TIMEOUT_MS,
      });
      expectExit({
        result: down,
        codes: [0],
        message: "hack down should clean the owned lifecycle session",
      });
      const sessionAfterDown = await runCommand({
        argv: ["tmux", "has-session", "-t", `${fixture.name}--lifecycle`],
        cwd: fixture.root,
      });
      expect({
        that: sessionAfterDown.exitCode !== 0,
        message: "lifecycle session survived hack down",
        result: sessionAfterDown,
      });
      let commandGroupStillExists = true;
      try {
        process.kill(-processGroupId, 0);
      } catch {
        commandGroupStillExists = false;
      }
      expect({
        that: !commandGroupStillExists,
        message: "hack down left the lifecycle command process group alive",
        result: down,
      });

      const failingFixture = await createMonorepoFixture({
        parentDir: ctx.tempRoot,
        withHackConfig: true,
        lifecycle: {
          persistentProcess: true,
          composeFailure: true,
          standaloneContainers: true,
        },
      });
      const failedUp = await cli({
        args: ["up", "--detach", "--json"],
        cwd: failingFixture.root,
        timeoutMs: UP_TIMEOUT_MS,
      });
      expect({
        that: failedUp.exitCode !== 0,
        message: "invalid compose fixture should fail after lifecycle startup",
        result: failedUp,
      });
      const failedSession = await runCommand({
        argv: [
          "tmux",
          "has-session",
          "-t",
          `${failingFixture.name}--lifecycle`,
        ],
        cwd: failingFixture.root,
      });
      expect({
        that: failedSession.exitCode !== 0,
        message: "compose failure left its lifecycle session behind",
        result: failedSession,
      });
      const failedState = await readLifecycleState({
        path: join(
          failingFixture.hackDir,
          ".internal",
          "lifecycle",
          "state.json"
        ),
      });
      expect({
        that: failedState.entries.length === 0,
        message: "compose failure left lifecycle ownership state behind",
        result: failedUp,
      });
    } finally {
      try {
        await downBestEffort({ ctx: { ...ctx, cli }, fixture });
      } finally {
        await runCommand({ argv: ["tmux", "kill-server"], cwd: fixture.root });
        restoreEnv("TMUX_TMPDIR", previousTmuxRoot);
      }
    }
  },
};

async function runSupervisorHostProcess(opts: {
  readonly ctx: Parameters<Scenario["run"]>[0];
  readonly fixture: Awaited<ReturnType<typeof createMonorepoFixture>>;
  readonly markerFile: string;
  readonly envMarkerFile: string;
  readonly binary: string;
}): Promise<void> {
  const env = {
    HACK_LIFECYCLE_RUNNER: "supervisor",
    HACK_LIFECYCLE_SUPERVISOR_BINARY: opts.binary,
  };
  const statePath = join(
    opts.fixture.hackDir,
    ".internal/lifecycle/state.json"
  );
  const cli = (args: readonly string[]) =>
    opts.ctx.cli({
      args,
      cwd: opts.fixture.root,
      env,
      timeoutMs: UP_TIMEOUT_MS,
    });
  try {
    const up = await cli(["up", "--detach"]);
    expectExit({
      result: up,
      codes: [0],
      message: "supervisor host fixture should start real Compose services",
    });
    expect({
      that: (await Bun.file(opts.markerFile).text()).includes("up-before-ran"),
      message: "supervisor before hook did not precede Compose",
      result: up,
    });
    expect({
      that:
        (await Bun.file(opts.envMarkerFile).text()) === "host-value|host-only",
      message: "supervisor before hook lost resolved environment",
      result: up,
    });
    const first = (await readLifecycleState({ path: statePath })).entries[0];
    const guard = first?.processes?.find(
      (process) => process.name === "e2e-sleeper"
    )?.processGroupId;
    expect({
      that:
        first?.backend === "supervisor" &&
        Boolean(first.ownershipToken) &&
        Number.isInteger(guard) &&
        (guard ?? 0) > 1,
      message: "native lifecycle state lost owner/session identity",
      result: up,
    });
    const leader = await runCommand({
      argv: ["ps", "-o", "pid=,pgid=", "-p", String(guard)],
      cwd: opts.fixture.root,
    });
    expectExit({
      result: leader,
      codes: [0],
      message: "recorded native guard should be alive",
    });
    expect({
      that: leader.stdout
        .trim()
        .split(/\s+/)
        .every((value) => Number(value) === guard),
      message: "native guard should lead its own group",
      result: leader,
    });
    const repeated = await cli(["up", "--detach"]);
    expectExit({
      result: repeated,
      codes: [0],
      message: "supervisor host fixture should adopt healthy owner",
    });
    expect({
      that:
        (await readLifecycleState({ path: statePath })).entries[0]
          ?.ownershipToken === first?.ownershipToken,
      message: "native healthy adoption replaced ownership",
      result: repeated,
    });
    const down = await cli(["down"]);
    expectExit({
      result: down,
      codes: [0],
      message: "native down should confirm host session retirement",
    });
    expect({
      that:
        (await readLifecycleState({ path: statePath })).entries.length === 0,
      message: "native down retained stopped state",
      result: down,
    });
    if (guard && guard > 1) {
      let alive = true;
      try {
        process.kill(guard, 0);
      } catch {
        alive = false;
      }
      expect({
        that: !alive,
        message: "native guard survived confirmed down",
        result: down,
      });
    }
    const failing = await createMonorepoFixture({
      parentDir: opts.ctx.tempRoot,
      withHackConfig: true,
      lifecycle: {
        persistentProcess: true,
        composeFailure: true,
        standaloneContainers: true,
      },
    });
    const failingState = join(
      failing.hackDir,
      ".internal/lifecycle/state.json"
    );
    try {
      const failedUp = await opts.ctx.cli({
        args: ["up", "--detach", "--json"],
        cwd: failing.root,
        env,
        timeoutMs: UP_TIMEOUT_MS,
      });
      expect({
        that: failedUp.exitCode !== 0 && !failedUp.timedOut,
        message:
          "real Compose failure must propagate after native lifecycle startup",
        result: failedUp,
      });
      expect({
        that:
          (await readLifecycleState({ path: failingState })).entries.length ===
          0,
        message: "real Compose failure left native lifecycle ownership",
        result: failedUp,
      });
      const priorHome = process.env.HACK_HOME;
      let nativeRoot: string;
      try {
        process.env.HACK_HOME = opts.ctx.hackHome;
        nativeRoot = resolveLifecycleSupervisorRoot({
          projectDir: failing.hackDir,
          composeProject: failing.name,
        });
      } finally {
        restoreEnv("HACK_HOME", priorHome);
      }
      const receipts = (await readdir(nativeRoot)).filter((name) =>
        name.endsWith(".json")
      );
      expect({
        that: receipts.length > 0,
        message: "failure fixture did not reach native lifecycle startup",
        result: failedUp,
      });
      for (const name of receipts) {
        const state: unknown = await Bun.file(join(nativeRoot, name)).json();
        expect({
          that:
            isRecord(state) &&
            Number.isInteger(state.commandPid) &&
            (state.phase === "exited" || state.phase === "killed"),
          message:
            "Compose failure did not retain confirmed native retirement evidence",
          result: failedUp,
        });
      }
    } finally {
      const cleanup = await opts.ctx.cli({
        args: ["down"],
        cwd: failing.root,
        env,
        timeoutMs: UP_TIMEOUT_MS,
      });
      if (
        cleanup.timedOut ||
        (await readLifecycleState({ path: failingState })).entries.length > 0
      ) {
        opts.ctx.retainFixtures(
          "Failed Compose cleanup retained native ownership evidence."
        );
      }
      await downBestEffort({ ctx: opts.ctx, fixture: failing });
    }
  } finally {
    const cleanup = await cli(["down"]);
    if (
      cleanup.exitCode !== 0 ||
      cleanup.timedOut ||
      (await readLifecycleState({ path: statePath })).entries.length > 0
    ) {
      opts.ctx.retainFixtures(
        "Supervisor host cleanup was not confirmed; retained private ownership evidence."
      );
    }
    await downBestEffort({ ctx: opts.ctx, fixture: opts.fixture });
  }
}

type LifecycleStateFixture = {
  readonly entries: ReadonlyArray<{
    readonly ownershipToken?: string;
    readonly definitionHash?: string;
    readonly processes?: ReadonlyArray<{
      readonly name?: string;
      readonly panePid?: number;
      readonly processGroupId?: number;
    }>;
    readonly [key: string]: unknown;
  }>;
};

async function readLifecycleState(opts: {
  readonly path: string;
}): Promise<LifecycleStateFixture> {
  const file = Bun.file(opts.path);
  if (!(await file.exists())) {
    return { entries: [] };
  }
  return (await file.json()) as LifecycleStateFixture;
}
