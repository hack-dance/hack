import { join } from "node:path";
import { createMonorepoFixture } from "../fixture.ts";
import { expect, expectExit, type Scenario } from "../harness.ts";

/** Legacy automation commands refuse without adopting or repairing any instructions. */
export const agentDocsSyncScenario: Scenario = {
  name: "agent-docs-sync",
  tier: "local",
  summary: "retired agent automation preserves legacy and customized files",
  run: async (ctx) => {
    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
    });
    const paths = [
      "AGENTS.md",
      "CLAUDE.md",
      ".cursor/rules/hack.mdc",
      ".claude/settings.json",
      ".codex/skills/hack-cli/SKILL.md",
    ];
    for (const path of paths) {
      await Bun.write(join(fixture.root, path), `custom legacy: ${path}\n`);
    }
    for (const args of [
      ["setup", "agents"],
      ["setup", "agents", "--check"],
      ["setup", "agents", "--remove"],
      ["setup", "sync", "--all-scopes"],
      ["setup", "sync", "--install-missing"],
      ["setup", "claude"],
      ["setup", "cursor"],
      ["mcp", "install", "--codex", "--docs"],
    ]) {
      const result = await ctx.cli({
        args,
        cwd: fixture.root,
        env: { HOME: ctx.hackHome },
      });
      expectExit({
        result,
        codes: [1],
        message: "retired automation must refuse",
      });
      expect({
        that: result.combined.includes("retired in v5"),
        message: "retirement must be explicit",
        result,
      });
      for (const path of paths) {
        expect({
          that:
            (await Bun.file(join(fixture.root, path)).text()) ===
            `custom legacy: ${path}\n`,
          message: `existing file must be preserved: ${path}`,
          result,
        });
      }
    }
    const primer = await ctx.cli({
      args: ["agent", "prime", "--check"],
      cwd: fixture.root,
      env: { HOME: ctx.hackHome },
    });
    expectExit({
      result: primer,
      codes: [0],
      message: "explicit primer remains printable",
    });
    expect({
      that: !primer.combined.includes("Hack integration inventory:"),
      message: "primer must not audit freshness",
      result: primer,
    });
  },
};
