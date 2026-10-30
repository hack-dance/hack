import {
  clearOwnershipJournal,
  describeResources,
  listFixtureNetworks,
  listOwnedNetworks,
  ownedFixtureNames,
  recoverStaleOwnership,
  runDocker,
  sweepOwnedComposeResources,
} from "./docker-ownership.ts";
import { runIsolationCanary, runScenarios, type Scenario } from "./harness.ts";
import { agentDocsSyncScenario } from "./scenarios/agent-docs-sync.ts";
import { automationCheckScenario } from "./scenarios/automation-check.ts";
import { cachePruneScenario } from "./scenarios/cache-prune.ts";
import { dependencyCacheScenario } from "./scenarios/dependency-cache.ts";
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
 *   HACK_E2E_CLI_BIN=./dist/hack ...        # exercise the compiled binary
 *   HACK_E2E_REQUIRE_DOCKER=1 ...            # fail if a Docker scenario skips
 *   HACK_E2E_REQUIRE_TMUX=1 ...              # fail if tmux recovery cannot run
 *
 * Exit codes: 0 all pass/skip, 1 any scenario failed or the run left an
 * owned Docker network behind, 2 isolation canary failed (nothing ran).
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
  cachePruneScenario,
  dependencyCacheScenario,
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
  const requireDocker = (process.env.HACK_E2E_REQUIRE_DOCKER ?? "") === "1";
  const keepTempDirs = (process.env.HACK_E2E_KEEP ?? "") === "1";
  const networksBefore = dockerEnabled ? await prepareDockerRun() : null;
  const outcomes = await runScenarios({
    scenarios: ALL_SCENARIOS,
    dockerEnabled,
    only: args.only,
    keepTempDirs,
  });
  const networksLeft = dockerEnabled
    ? await finishDockerRun({ networksBefore })
    : false;

  const dockerSkipped = outcomes.some(
    (outcome) => outcome.tier === "docker" && outcome.status === "skip"
  );
  process.exitCode =
    outcomes.some((outcome) => outcome.status === "fail") ||
    networksLeft ||
    (requireDocker && dockerSkipped)
      ? 1
      : 0;
}

const TERMINATION_SIGNALS = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
} as const;

/**
 * Before any docker scenario: reclaim resources journaled by e2e runs that
 * died without cleaning up, count fixture networks, and make an interrupted
 * run sweep what it owns before exiting.
 */
async function prepareDockerRun(): Promise<number | null> {
  const { recovered } = await recoverStaleOwnership({ docker: runDocker });
  for (const sweep of recovered) {
    if (sweep.removed.length > 0) {
      process.stdout.write(
        `reclaimed from a dead e2e run: ${describeResources(sweep.removed)}\n`
      );
    }
  }
  installInterruptCleanup();
  const networks = await listFixtureNetworks({ docker: runDocker });
  return networks?.length ?? null;
}

let interrupted = false;

function installInterruptCleanup(): void {
  for (const [signal, number] of Object.entries(TERMINATION_SIGNALS)) {
    process.on(signal, async () => {
      if (interrupted) {
        return;
      }
      interrupted = true;
      process.stdout.write(
        `\n${signal}: removing Docker resources owned by this run\n`
      );
      const sweep = await sweepOwnedComposeResources({
        docker: runDocker,
        names: ownedFixtureNames(),
      });
      if (sweep.removed.length > 0) {
        process.stdout.write(`removed: ${describeResources(sweep.removed)}\n`);
      }
      // The journal stays: a CLI child still running may recreate resources,
      // and the next run reclaims them once this process is gone.
      process.exit(128 + number);
    });
  }
}

/**
 * After all scenarios: count fixture networks again and fail the run when
 * any network owned by this run is still present (sweeping it first).
 */
async function finishDockerRun(opts: {
  readonly networksBefore: number | null;
}): Promise<boolean> {
  const names = ownedFixtureNames();
  const owned = await listOwnedNetworks({ docker: runDocker, names });
  const after = await listFixtureNetworks({ docker: runDocker });
  if (owned === null || after === null || opts.networksBefore === null) {
    process.stdout.write("\nnetwork check skipped: docker network ls failed\n");
    return false;
  }
  process.stdout.write(
    `\nfixture networks: before=${opts.networksBefore} after=${after.length} left by this run=${owned.length}\n`
  );
  if (owned.length === 0) {
    await clearOwnershipJournal();
    return false;
  }
  process.stdout.write(
    `LEAK: this run left Docker networks: ${describeResources(owned)}\n`
  );
  const sweep = await sweepOwnedComposeResources({ docker: runDocker, names });
  if (sweep.failed.length === 0) {
    await clearOwnershipJournal();
  }
  return true;
}

await main();
