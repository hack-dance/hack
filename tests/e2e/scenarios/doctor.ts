import { createMonorepoFixture } from "../fixture.ts";
import { expect, type Scenario } from "../harness.ts";

const DOCTOR_TIMEOUT_MS = 240_000;

/**
 * `hack doctor` in a fixture project must complete non-interactively and
 * report findings instead of crashing — including on machines where docker
 * or the global infra is unavailable (that is a report, not a crash).
 */
export const doctorScenario: Scenario = {
  name: "doctor",
  tier: "local",
  summary: "hack doctor reports (not crashes) in a fresh fixture",
  run: async (ctx) => {
    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
    });

    const result = await ctx.cli({
      args: ["doctor"],
      cwd: fixture.root,
      timeoutMs: DOCTOR_TIMEOUT_MS,
    });

    expect({
      that: !result.timedOut,
      message: "hack doctor timed out (likely blocked on a prompt or hang)",
      result,
    });
    expect({
      that: result.exitCode === 0 || result.exitCode === 1,
      message: `hack doctor should exit 0 (healthy) or 1 (issues found), got ${result.exitCode}`,
      result,
    });
    // Content: the summary always renders (a healthy machine lists no issue
    // names, so do NOT assert on specific check names like "docker").
    expect({
      that:
        result.combined.includes("Doctor summary") ||
        result.combined.includes("Doctor checks complete"),
      message: "hack doctor output should include the doctor summary",
      result,
    });
    expect({
      that: !result.combined.includes("Unhandled"),
      message: "hack doctor output contains an unhandled error/crash trace",
      result,
    });
    const hasAnsi = result.stdout.includes("\u001b[");
    ctx.log(
      `doctor exited ${result.exitCode} in ${(result.durationMs / 1000).toFixed(1)}s${
        hasAnsi
          ? " (note: spinner ANSI escapes leak into non-TTY stdout — Phase 3 AX finding)"
          : ""
      }`
    );
  },
};
