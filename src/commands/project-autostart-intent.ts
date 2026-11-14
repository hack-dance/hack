import { resolve } from "node:path";
import { CliUsageError } from "../cli/command.ts";
import {
  PROJECT_ENV_CONTRACT_FILENAME,
  PROJECT_ENV_FILENAME,
} from "../constants.ts";
import { HackCliError } from "../lib/cli-result.ts";
import { pathExists } from "../lib/fs.ts";
import { type ProjectContext, sanitizeBranchSlug } from "../lib/project.ts";
import {
  discoverComposeServiceNames,
  findUnmigratedLegacyDotenv,
  hasUnmigratedLegacyDotenv,
  projectEnvConfigExists,
} from "../lib/project-env-config.ts";
import { discoverProjectInputs } from "../lib/project-input-selection.ts";
import { normalizeProjectName } from "../lib/project-name.ts";
import {
  type RegisteredProject,
  setProjectAutostartPaused,
} from "../lib/projects-registry.ts";

/** Login must never continue with a legacy environment requiring migration. */
export async function assertAutostartEnvironment(opts: {
  readonly project: ProjectContext;
}): Promise<void> {
  const project = opts.project;
  const contract = await pathExists(
    resolve(project.projectDir, PROJECT_ENV_CONTRACT_FILENAME)
  );
  const modern = await projectEnvConfigExists({
    projectDir: project.projectDir,
  });
  const legacy = await findUnmigratedLegacyDotenv({
    projectRoot: project.projectRoot,
    projectDir: project.projectDir,
    serviceNames: await discoverComposeServiceNames({
      composeFile: project.composeFile,
    }),
  });
  const dotenv = Bun.file(resolve(project.projectDir, PROJECT_ENV_FILENAME));
  const legacyDotenv = !modern && (await dotenv.exists()) && dotenv.size > 0;
  if (
    (!modern && contract) ||
    legacyDotenv ||
    hasUnmigratedLegacyDotenv(legacy)
  ) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message:
        "Autostart skipped: pending env migration. Run hack doctor --migrate-env-config.",
      detail: { reason: "pending_env_migration" },
    });
  }
}

/** Match canonical registry identity without entering legacy project discovery. */
export function findAutostartRegistration(opts: {
  readonly projects: readonly RegisteredProject[];
  readonly selectorName?: string;
  readonly startDir: string;
}): RegisteredProject | undefined {
  return opts.projects
    .filter((entry) => entry.autostart)
    .find((entry) =>
      opts.selectorName
        ? normalizeProjectName(entry.name) === opts.selectorName
        : [
            entry.repoRoot,
            ...(entry.worktrees?.map((worktree) => worktree.path) ?? []),
          ].some(
            (path) =>
              opts.startDir === path || opts.startDir.startsWith(`${path}/`)
          )
    );
}

/** Native/adopted dispatch owns its context; machine pause intent needs only its registry ID. */
export async function updateNativeAutostartIntent(opts: {
  readonly project: RegisteredProject;
  readonly selectedRoot: string;
  readonly action: "up" | "down";
  readonly branch?: string;
  readonly always?: boolean;
  readonly login: boolean;
}): Promise<boolean> {
  const inputs = await discoverProjectInputs({ startDir: opts.selectedRoot });
  if (inputs?.kind !== "native" && inputs?.kind !== "conflict") {
    return false;
  }
  if (opts.login || opts.always) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message:
        "Autostart supports Compose projects only; start native projects manually.",
      detail: { reason: "native_unsupported" },
    });
  }
  const rawBranch = opts.branch?.trim();
  const branch = rawBranch ? sanitizeBranchSlug(rawBranch) : null;
  if (rawBranch && !branch) {
    throw new CliUsageError("Invalid branch instance.");
  }
  const selected =
    inputs.projectRoot === opts.project.repoRoot ||
    opts.project.worktrees?.some(
      (worktree) => worktree.path === inputs.projectRoot
    );
  if (selected && opts.project.autostart?.branch === branch) {
    await setProjectAutostartPaused({
      id: opts.project.id,
      paused: opts.action === "down",
    });
  }
  return true;
}
