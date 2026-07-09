import { join } from "node:path";

import { createMonorepoFixture } from "../fixture.ts";
import { expect, expectExit, runCommand, type Scenario } from "../harness.ts";
import { downBestEffort, requireDockerPreconditions } from "./docker-shared.ts";

const UP_TIMEOUT_MS = 420_000;

type LifecycleStateFile = {
  readonly entries?: readonly {
    readonly processes?: readonly {
      readonly name?: string;
      readonly panePid?: number;
      readonly processGroupId?: number;
    }[];
  }[];
};

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

      const stateFile = Bun.file(
        join(fixture.hackDir, ".internal", "lifecycle", "state.json")
      );
      expect({
        that: await stateFile.exists(),
        message: "persistent lifecycle process did not write lifecycle state",
        result: up,
      });
      const state = (await stateFile.json()) as LifecycleStateFile;
      const sleeper = state.entries?.[0]?.processes?.find(
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

      await downBestEffort({ ctx, fixture });
      let commandGroupStillExists = true;
      try {
        process.kill(-processGroupId, 0);
      } catch {
        commandGroupStillExists = false;
      }
      expect({
        that: !commandGroupStillExists,
        message: "hack down left the lifecycle command process group alive",
        result: up,
      });
    } finally {
      await downBestEffort({ ctx, fixture });
    }
  },
};
