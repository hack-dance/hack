import { runIsolationCanary, runScenarios, type Scenario } from "./harness.ts";
import { agentDocsSyncScenario } from "./scenarios/agent-docs-sync.ts";
import { automationCheckScenario } from "./scenarios/automation-check.ts";
import { doctorScenario } from "./scenarios/doctor.ts";
import { envSecretsScenario } from "./scenarios/env-secrets.ts";
import { initScenario } from "./scenarios/init.ts";
import { lifecycleHostProcessScenario } from "./scenarios/lifecycle-host-process.ts";
import { lifecycleSessionRecoveryScenario } from "./scenarios/lifecycle-session-recovery.ts";
import { upDownScenario } from "./scenarios/up-down.ts";
import { worktreeBranchDefaultScenario } from "./scenarios/worktree-branch-default.ts";
import { worktreeParallelUpScenario } from "./scenarios/worktree-parallel-up.ts";
import { worktreeRegistryScenario } from "./scenarios/worktree-registry.ts";
import { worktreeSecretsScenario } from "./scenarios/worktree-secrets.ts";

/**
 * hack CLI end-to-end runner.
 *
 * Usage:
 *   bun tests/e2e/run.ts                    # tier 1 (local) scenarios
 *   HACK_E2E_DOCKER=1 bun tests/e2e/run.ts  # + tier 2 (docker) scenarios
 *   bun tests/e2e/run.ts --only=init,doctor # subset by name
 *   bun tests/e2e/run.ts --list             # list scenarios and exit
 *   HACK_E2E_KEEP=1 ...                     # keep temp fixtures for debugging
 *
 * Exit codes: 0 all pass/skip, 1 any scenario failed, 2 isolation canary
 * failed (nothing ran).
 */

const ALL_SCENARIOS: readonly Scenario[] = [
  automationCheckScenario,
  initScenario,
  envSecretsScenario,
  worktreeSecretsScenario,
  worktreeRegistryScenario,
  worktreeBranchDefaultScenario,
  agentDocsSyncScenario,
  doctorScenario,
  lifecycleSessionRecoveryScenario,
  upDownScenario,
  lifecycleHostProcessScenario,
  worktreeParallelUpScenario,
];

type CliArgs = {
  readonly only: readonly string[];
  readonly list: boolean;
};

function parseArgs(argv: readonly string[]): CliArgs {
  const only: string[] = [];
  let list = false;
  for (const arg of argv) {
    if (arg === "--list") {
      list = true;
    } else if (arg.startsWith("--only=")) {
      only.push(
        ...arg
          .slice("--only=".length)
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name.length > 0)
      );
    } else {
      process.stdout.write(`Unknown argument: ${arg}\n`);
      process.stdout.write(
        "Usage: bun tests/e2e/run.ts [--list] [--only=name,name]\n"
      );
      process.exitCode = 2;
      return { only: [], list: true };
    }
  }
  return { only, list };
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  if (args.list) {
    for (const scenario of ALL_SCENARIOS) {
      process.stdout.write(
        `${scenario.name.padEnd(26)} ${scenario.tier.padEnd(6)} ${scenario.summary}\n`
      );
    }
    return;
  }

  const unknown = args.only.filter(
    (name) => !ALL_SCENARIOS.some((scenario) => scenario.name === name)
  );
  if (unknown.length > 0) {
    process.stdout.write(
      `Unknown scenario name(s): ${unknown.join(", ")} (use --list)\n`
    );
    process.exitCode = 2;
    return;
  }

  process.stdout.write("== hack e2e: isolation canary ==\n");
  const canary = await runIsolationCanary();
  if (!canary.ok) {
    process.stdout.write("CANARY FAILED — aborting before any scenario.\n\n");
    process.stdout.write(`${canary.message}\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(
    `canary ok — isolated registry at ${canary.registryPath}\n\n`
  );

  const dockerEnabled = (process.env.HACK_E2E_DOCKER ?? "") === "1";
  const keepTempDirs = (process.env.HACK_E2E_KEEP ?? "") === "1";
  const outcomes = await runScenarios({
    scenarios: ALL_SCENARIOS,
    dockerEnabled,
    only: args.only,
    keepTempDirs,
  });

  process.exitCode = outcomes.some((outcome) => outcome.status === "fail")
    ? 1
    : 0;
}

await main();
