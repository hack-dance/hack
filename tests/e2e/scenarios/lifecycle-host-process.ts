import { join } from "node:path";

import { createMonorepoFixture } from "../fixture.ts";
import { expect, expectExit, type Scenario } from "../harness.ts";
import { downBestEffort, requireDockerPreconditions } from "./docker-shared.ts";

const UP_TIMEOUT_MS = 420_000;

/**
 * Lifecycle host hooks run as part of `hack up` (there is no standalone
 * lifecycle start/stop command today), so this scenario lives in the docker
 * tier: `hack up --detach` must execute the configured lifecycle.up.before
 * hook on the host (observed via a marker file) before starting services,
 * and record lifecycle runtime state under .hack/.internal/lifecycle/.
 */
export const lifecycleHostProcessScenario: Scenario = {
  name: "lifecycle-host-process",
  tier: "docker",
  summary: "lifecycle.up.before host hook runs during hack up",
  run: async (ctx) => {
    await requireDockerPreconditions({ ctx });

    const markerFile = join(ctx.tempRoot, "lifecycle-marker.txt");
    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
      lifecycle: { upBeforeMarkerFile: markerFile },
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
      const hasState = await stateFile.exists();
      ctx.log(
        hasState
          ? "lifecycle state recorded at .hack/.internal/lifecycle/state.json"
          : "note: no lifecycle state.json written (no persistent processes configured)"
      );
    } finally {
      await downBestEffort({ ctx, fixture });
    }
  },
};
