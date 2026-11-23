import { join } from "node:path";
import { createMonorepoFixture } from "../fixture.ts";
import { expect, expectExit, type Scenario } from "../harness.ts";
import { downBestEffort, requireDockerPreconditions } from "./docker-shared.ts";

const COHORTS = [1, 8, 32] as const;
const COMMAND_TIMEOUT_MS = 120_000;

export const composeBranchScaleScenario: Scenario = {
  name: "compose-branch-scale",
  tier: "docker",
  requiresExplicitSelection: true,
  summary:
    "start and retain distinct volumes across 1, 8 and 32 branch instances",
  run: async (ctx) => {
    await requireDockerPreconditions({ ctx });

    for (const size of COHORTS) {
      const fixture = await createMonorepoFixture({
        parentDir: ctx.tempRoot,
        withHackConfig: true,
      });
      const branches = Array.from({ length: size }, (_, n) => `scale-${n + 1}`);
      await Bun.write(
        join(fixture.hackDir, "docker-compose.yml"),
        `services:
  web:
    image: oven/bun:1.4.4
    command: ["sleep", "infinity"]
    network_mode: none
    stop_grace_period: 1s
    volumes:
      - data:/data
volumes:
  data:
`
      );

      async function cli(branch: string, args: [string, ...string[]]) {
        const result = await ctx.cli({
          args: [args[0], "--branch", branch, ...args.slice(1)],
          cwd: fixture.root,
          timeoutMs: COMMAND_TIMEOUT_MS,
        });
        expectExit({ result, codes: [0], message: `${branch}: ${args[0]}` });
        return result;
      }

      try {
        for (const branch of branches) {
          await cli(branch, ["up", "--detach"]);
          await cli(branch, [
            "exec",
            "web",
            "--",
            "sh",
            "-c",
            'printf "%s" "$1" > /data/marker',
            "sh",
            branch,
          ]);
        }
        for (const branch of branches) {
          await expectMarker(branch);
        }
        for (const branch of branches) {
          await cli(branch, ["down"]);
          await cli(branch, ["up", "--detach"]);
          await expectMarker(branch);
        }
        ctx.log(`retained isolation verified across ${size} branch instances`);
      } finally {
        await downBestEffort({ ctx, fixture, branches });
      }

      async function expectMarker(branch: string) {
        const result = await cli(branch, [
          "exec",
          "web",
          "--",
          "cat",
          "/data/marker",
        ]);
        expect({
          that: result.stdout.trim() === branch,
          message: `${branch}: expected its own retained marker`,
          result,
        });
      }
    }
  },
};
