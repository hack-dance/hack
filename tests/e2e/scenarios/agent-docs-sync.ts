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
 * Ordinary commands leave drift untouched; only explicit setup commands write.
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
    const isolatedUserEnv = { HOME: ctx.hackHome };

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

    const stalePrime = await ctx.cli({
      args: ["agent", "prime"],
      cwd: fixture.root,
      env: isolatedUserEnv,
    });
    expectExit({
      result: stalePrime,
      codes: [0],
      message: "agent primer should still render while integrations are stale",
    });
    expect({
      that:
        stalePrime.stdout.includes(
          "WARNING: Hack agent integrations are stale"
        ) &&
        stalePrime.stdout.includes("hack setup sync --all-scopes") &&
        stalePrime.stdout.includes("reload the agent session"),
      message:
        "agent primer should expose stale project/global guidance upfront",
      result: stalePrime,
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
      args: ["setup", "sync", "--all-scopes"],
      cwd: fixture.root,
      env: isolatedUserEnv,
    });
    expectExit({
      result: fullSync,
      codes: [0],
      message: "hack setup sync (project scope) should succeed",
    });
    const fullSyncCheck = await ctx.cli({
      args: ["setup", "sync", "--all-scopes", "--check"],
      cwd: fixture.root,
      env: isolatedUserEnv,
    });
    expectExit({
      result: fullSyncCheck,
      codes: [0],
      message:
        "hack setup sync --check right after hack setup sync should be clean",
    });

    const currentPrime = await ctx.cli({
      args: ["agent", "prime"],
      cwd: fixture.root,
      env: isolatedUserEnv,
    });
    expectExit({
      result: currentPrime,
      codes: [0],
      message: "agent primer should render after project/global repair",
    });
    expect({
      that: currentPrime.stdout.includes(
        "Hack agent integration freshness: current"
      ),
      message: "agent primer should report current guidance after repair",
      result: currentPrime,
    });

    const syncedAgents = await Bun.file(agentsPath).text();
    expect({
      that: syncedAgents.includes("Integration freshness"),
      message: "synced agent docs should be freshness-stamped",
    });

    await Bun.write(
      agentsPath,
      syncedAgents.replace(
        MARKER_START,
        `${MARKER_START}\nSTALE-ORDINARY-COMMAND-PROBE`
      )
    );
    const ordinaryCommand = await ctx.cli({
      args: ["config", "get", "name"],
      cwd: fixture.root,
      env: isolatedUserEnv,
    });
    expectExit({
      result: ordinaryCommand,
      codes: [0],
      message:
        "a normal project command should still succeed with stale guidance",
    });
    expect({
      that: (await Bun.file(agentsPath).text()).includes(
        "STALE-ORDINARY-COMMAND-PROBE"
      ),
      message: "ordinary commands must not rewrite stale agent integrations",
      result: ordinaryCommand,
    });
  },
};
