import { join } from "node:path";

import { createMonorepoFixture } from "../fixture.ts";
import { expect, expectExit, type Scenario } from "../harness.ts";

const MARKER_START = "<!-- hack:agent-docs:start -->";
const MARKER_END = "<!-- hack:agent-docs:end -->";

/**
 * Drift enforcement loop for agent docs:
 * upsert → check clean → corrupt the marker content → check reports STALE
 * with a non-zero exit → sync repairs → check clean again.
 *
 * The scenario overrides HACK_SETUP_SYNC_MODE=off (the harness default) only
 * via explicit commands so auto-sync cannot mask drift detection.
 */
export const agentDocsSyncScenario: Scenario = {
  name: "agent-docs-sync",
  tier: "local",
  summary: "setup sync --check detects stale AGENTS.md content and repairs",
  run: async (ctx) => {
    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
    });
    const agentsPath = join(fixture.root, "AGENTS.md");

    const upsert = await ctx.cli({
      args: ["setup", "agents", "--agents-md"],
      cwd: fixture.root,
    });
    expectExit({
      result: upsert,
      codes: [0],
      message: "hack setup agents --agents-md should create AGENTS.md",
    });
    const created = await Bun.file(agentsPath).text();
    expect({
      that: created.includes(MARKER_START) && created.includes(MARKER_END),
      message: "AGENTS.md should contain the hack agent-docs markers",
      result: upsert,
    });

    const cleanCheck = await ctx.cli({
      args: ["setup", "agents", "--agents-md", "--check"],
      cwd: fixture.root,
    });
    expectExit({
      result: cleanCheck,
      codes: [0],
      message: "check right after upsert should report clean (exit 0)",
    });

    const corrupted = created.replace(
      MARKER_START,
      `${MARKER_START}\nSTALE-INJECTED-BY-E2E: this line drifts the managed content.`
    );
    expect({
      that: corrupted !== created,
      message: "failed to corrupt the marker region (marker not found)",
    });
    await Bun.write(agentsPath, corrupted);

    const staleCheck = await ctx.cli({
      args: ["setup", "agents", "--agents-md", "--check"],
      cwd: fixture.root,
    });
    expect({
      that: staleCheck.exitCode !== 0,
      message:
        "check must exit non-zero when marker content drifted from the current render",
      result: staleCheck,
    });
    expect({
      that:
        staleCheck.combined.toLowerCase().includes("stale") ||
        staleCheck.combined.toLowerCase().includes("out of date"),
      message: "check output should describe the drift as stale/out of date",
      result: staleCheck,
    });

    const repair = await ctx.cli({
      args: ["setup", "agents", "--agents-md"],
      cwd: fixture.root,
    });
    expectExit({
      result: repair,
      codes: [0],
      message: "hack setup agents --agents-md should repair stale content",
    });
    const repaired = await Bun.file(agentsPath).text();
    expect({
      that: !repaired.includes("STALE-INJECTED-BY-E2E"),
      message: "repair should replace the drifted marker content",
      result: repair,
    });

    const finalCheck = await ctx.cli({
      args: ["setup", "agents", "--agents-md", "--check"],
      cwd: fixture.root,
    });
    expectExit({
      result: finalCheck,
      codes: [0],
      message: "check after repair should report clean (exit 0)",
    });

    const fullSync = await ctx.cli({
      args: ["setup", "sync"],
      cwd: fixture.root,
    });
    expectExit({
      result: fullSync,
      codes: [0],
      message: "hack setup sync (project scope) should succeed",
    });
    const fullSyncCheck = await ctx.cli({
      args: ["setup", "sync", "--check"],
      cwd: fixture.root,
    });
    expectExit({
      result: fullSyncCheck,
      codes: [0],
      message:
        "hack setup sync --check right after hack setup sync should be clean",
    });
  },
};
