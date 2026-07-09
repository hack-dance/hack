import { join } from "node:path";

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

    const markerFile = join(ctx.tempRoot, "lifecycle-marker.txt");
    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
      lifecycle: {
        persistentProcess: true,
        upBeforeMarkerFile: markerFile,
        standaloneContainers: true,
      },
    });

    try {
      const up = await ctx.cli({
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

      const owner = await runCommand({
        argv: [
          "tmux",
          "show-options",
          "-v",
          "-t",
          `${fixture.name}--lifecycle`,
          "@hack_lifecycle_owner",
        ],
        cwd: fixture.root,
      });
      expectExit({
        result: owner,
        codes: [0],
        message: "tmux lifecycle session should expose ownership metadata",
      });
      expect({
        that: owner.stdout.trim() === firstEntry?.ownershipToken,
        message: "tmux and lifecycle state ownership tokens should match",
        result: owner,
      });

      const repeatedUp = await ctx.cli({
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
          "set-option",
          "-u",
          "-t",
          `${fixture.name}--lifecycle`,
          "@hack_lifecycle_owner",
        ],
        cwd: fixture.root,
      });
      expectExit({
        result: clearOwner,
        codes: [0],
        message: "failed to simulate a pre-ownership lifecycle session",
      });

      const recoveredUp = await ctx.cli({
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

      const down = await ctx.cli({
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
      const failedUp = await ctx.cli({
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
      await downBestEffort({ ctx, fixture });
    }
  },
};

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
