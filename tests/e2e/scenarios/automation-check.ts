import { expect, expectExit, type Scenario } from "../harness.ts";

const ANSI_ESCAPE = "\u001b[";
const HELP_TARGETS: readonly (readonly string[])[] = [
  ["--help"],
  ["init", "--help"],
  ["up", "--help"],
  ["env", "--help"],
  ["doctor", "--help"],
  ["projects", "--help"],
  ["setup", "--help"],
];

/**
 * Agent-reality baseline: help output for the core surface must succeed in a
 * non-TTY pipe with exit 0 and must not contain ANSI escape sequences.
 */
export const automationCheckScenario: Scenario = {
  name: "automation-check",
  tier: "local",
  summary: "core --help surfaces are non-TTY safe (exit 0, no ANSI escapes)",
  run: async (ctx) => {
    for (const args of HELP_TARGETS) {
      const result = await ctx.cli({ args: [...args], cwd: ctx.tempRoot });
      expectExit({
        result,
        codes: [0],
        message: `hack ${args.join(" ")} should exit 0 when piped`,
      });
      expect({
        that: result.stdout.trim().length > 0,
        message: `hack ${args.join(" ")} should print help text to stdout`,
        result,
      });
      expect({
        that: !result.stdout.includes(ANSI_ESCAPE),
        message: `hack ${args.join(" ")} stdout must not contain ANSI escapes when piped`,
        result,
      });
      expect({
        that: !result.stderr.includes(ANSI_ESCAPE),
        message: `hack ${args.join(" ")} stderr must not contain ANSI escapes when piped`,
        result,
      });
    }

    const unknown = await ctx.cli({
      args: ["definitely-not-a-command"],
      cwd: ctx.tempRoot,
    });
    expect({
      that: unknown.exitCode !== 0,
      message: "unknown commands should exit non-zero (machine-detectable)",
      result: unknown,
    });
  },
};
