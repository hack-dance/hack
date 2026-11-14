import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { CliUsageError } from "../cli/command.ts";
import { parseProjectSelectorOption } from "../cli/project-selector.ts";
import {
  PROJECT_ENV_CONTRACT_FILENAME,
  PROJECT_ENV_FILENAME,
} from "../constants.ts";
import {
  assertAutostartProjectCurrent,
  withAutostartProjectLock,
} from "../lib/autostart-project-lock.ts";
import { resolveEffectiveBranch } from "../lib/branches.ts";
import { HackCliError } from "../lib/cli-result.ts";
import { resolveComposeProjectName } from "../lib/compose-project-name.ts";
import { pathExists } from "../lib/fs.ts";
import {
  findProjectContextAtRoot,
  type ProjectContext,
  readProjectConfig,
  resolveWorktreeAutoBranch,
  sanitizeBranchSlug,
} from "../lib/project.ts";
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
  readProjectsRegistry,
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

/** Resolve the same registered instance for command serialization without native legacy discovery. */
export async function withAutostartCommandLock<T>(opts: {
  readonly cwd: string;
  readonly path?: string;
  readonly project?: string;
  readonly branch?: string;
  readonly run: () => Promise<T>;
}): Promise<T> {
  const login = process.env.HACK_AUTOSTART_LOGIN === "1";
  const branch = opts.branch?.trim()
    ? sanitizeBranchSlug(opts.branch.trim())
    : null;
  const registry = await readProjectsRegistry(
    login ? { requireAutostartTrust: true } : undefined
  );
  const requested = resolve(opts.cwd, opts.path ?? ".");
  const cwd = await realpath(requested).catch(() => requested);
  const selected =
    opts.project === undefined
      ? undefined
      : parseProjectSelectorOption({ projectOpt: opts.project });
  const registrations = registry.projects
    .filter((project) =>
      selected
        ? normalizeProjectName(project.name) === selected.name
        : [
            project.repoRoot,
            ...(project.worktrees?.map((tree) => tree.path) ?? []),
          ].some((root) => cwd === root || cwd.startsWith(`${root}/`))
    )
    .sort((a, b) => b.repoRoot.length - a.repoRoot.length);
  const registration = registrations[0];
  if (selected && !registration) {
    return await opts.run();
  }
  const inputs = await discoverProjectInputs({
    startDir: selected && registration ? registration.repoRoot : cwd,
  });
  if (!inputs || inputs.kind !== "legacy") {
    return await opts.run();
  }
  const project = await findProjectContextAtRoot({
    projectRoot: inputs.projectRoot,
    projectDirName: inputs.composeDirectories.includes(".hack")
      ? ".hack"
      : ".dev",
  });
  if (!project) {
    return await opts.run();
  }
  const cfg = await readProjectConfig(project);
  const effective = await resolveEffectiveBranch({
    explicitBranch: branch,
    projectRoot: project.projectRoot,
    autoBranchEnabled: login ? false : resolveWorktreeAutoBranch(cfg),
  });
  const projectId = login
    ? process.env.HACK_AUTOSTART_PROJECT_ID
    : registration?.id;
  if (login && (!projectId || projectId.length > 128)) {
    throw new HackCliError({
      code: "E_CANCELLED",
      message: "Autostart requires an explicit registered project identity.",
    });
  }
  if (
    login &&
    !registry.projects.some(
      (entry) =>
        entry.id === projectId && entry.repoRoot === project.projectRoot
    )
  ) {
    throw new HackCliError({
      code: "E_CANCELLED",
      message: "Autostart project path changed; no start ran.",
    });
  }
  const scope = {
    projectId: projectId ?? "",
    composeProject: await resolveComposeProjectName({ project, cfg }),
    branch: effective.branch,
  };
  return await withAutostartProjectLock({
    scope,
    run: async () => {
      if (login) {
        await assertAutostartProjectCurrent({
          scope,
          expectedRoot: project.projectRoot,
        });
      }
      return await opts.run();
    },
  });
}

/** Read the original login identity again at the container publication boundary. */
export async function assertLoginAutostartCurrent(
  branch: string | null,
  expectedRoot: string
): Promise<void> {
  if (process.env.HACK_AUTOSTART_LOGIN !== "1") {
    return;
  }
  const projectId = process.env.HACK_AUTOSTART_PROJECT_ID;
  if (!projectId) {
    throw new HackCliError({
      code: "E_CANCELLED",
      message: "Autostart project identity is unavailable.",
    });
  }
  await assertAutostartProjectCurrent({
    scope: { projectId, branch },
    expectedRoot,
  });
}
