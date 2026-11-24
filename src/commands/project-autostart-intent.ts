import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { CliUsageError } from "../cli/command.ts";
import { parseProjectSelectorOption } from "../cli/project-selector.ts";
import {
  PROJECT_ENV_CONTRACT_FILENAME,
  PROJECT_ENV_FILENAME,
} from "../constants.ts";
import { assertAutostartCheckoutTrusted } from "../lib/autostart-checkout-trust.ts";
import { assertAutostartDockerConfigTrusted } from "../lib/autostart-docker-trust.ts";
import {
  assertAutostartProjectCurrent,
  autostartProjectLockName,
  withAutostartProjectLock,
} from "../lib/autostart-project-lock.ts";
import { assertAutostartAdoptionAllowed } from "../lib/autostart-refusal.ts";
import { assertAutostartStartPolicy } from "../lib/autostart-start-policy.ts";
import { resolveEffectiveBranch } from "../lib/branches.ts";
import { HackCliError } from "../lib/cli-result.ts";
import { resolveComposeProjectName } from "../lib/compose-project-name.ts";
import { assertEnvMigrationFinished } from "../lib/env-migration.ts";
import { pathExists } from "../lib/fs.ts";
import { selectLegacyComposeAdoptedRoot } from "../lib/native-compose-adoption-command.ts";
import {
  findProjectContextAtRoot,
  type ProjectConfig,
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
  type ProjectsRegistry,
  type RegisteredProject,
  readProjectsRegistry,
  selectRegisteredProjectByName,
  setProjectAutostartPaused,
} from "../lib/projects-registry.ts";

import { readRuntimeProjects } from "../lib/runtime-projects.ts";
import {
  type DownSafetyNotice,
  reconcileImplicitDownTarget,
} from "./project-down-safety.ts";

export interface LocalComposeTarget {
  readonly base: string;
  readonly projectDir: string;
  readonly lifecycle: {
    readonly projectName: string;
    readonly lifecycleComposeProject: string;
  };
  readonly envName: string | null | undefined;
  readonly env: Readonly<Record<string, string>>;
  readonly lifecycleEnv: Readonly<Record<string, string>>;
  readonly pin: boolean;
  /** A saved runtime can keep its explicit name when running one-offs. */
  readonly hasSavedLaunch?: boolean;
}

export interface AutostartDownTarget {
  readonly branch: string | null;
  readonly compose?: LocalComposeTarget;
  readonly observedComposeProject?: string;
}
interface AutostartCommandSelection {
  readonly cwd: string;
  readonly path?: string;
  readonly project?: string;
  readonly branch?: string;
}

export interface ComposeCheckoutCopy {
  readonly branch: string | null;
  readonly effective?: Awaited<ReturnType<typeof resolveEffectiveBranch>>;
}

async function resolveAutostartDownBranch(opts: {
  readonly project: ProjectContext;
  readonly cfg: ProjectConfig;
  readonly branch?: string;
}) {
  const raw = opts.branch?.trim();
  const explicitBranch = raw ? sanitizeBranchSlug(raw) || "branch" : null;
  const effective = await resolveEffectiveBranch({
    explicitBranch,
    projectRoot: opts.project.projectRoot,
    autoBranchEnabled: resolveWorktreeAutoBranch(opts.cfg),
  });
  if (effective.source === "detached-worktree") {
    throw new CliUsageError(
      "Detached linked worktree requires an explicit --branch <name>."
    );
  }
  return { explicitBranch, effective };
}

/** Serialize name discovery and pin publication for one logical copy. Sibling
 * copies have separate locks so a lifecycle hook can act on one synchronously. */
export async function withComposeCheckoutLock<T>(
  opts: AutostartCommandSelection & {
    readonly selectedCopy?: ComposeCheckoutCopy;
    readonly beforeLock?: (target: ComposeCheckoutCopy) => Promise<void>;
    readonly signal?: AbortSignal;
    readonly run: (
      copy?: ComposeCheckoutCopy,
      projectDir?: string
    ) => Promise<T>;
  }
): Promise<T> {
  const registry = await readProjectsRegistry();
  const context = await discoverAutostartCommandContext({ ...opts, registry });
  if (!context) {
    return await opts.run();
  }
  const { project } = context;
  const selection = opts.selectedCopy
    ? undefined
    : await resolveAutostartDownBranch({
        project,
        cfg: await readProjectConfig(project),
        branch: opts.branch,
      });
  const copy = opts.selectedCopy ?? {
    branch: selection?.effective.branch ?? null,
    effective: selection?.effective,
  };
  if (opts.selectedCopy || selection?.explicitBranch || copy.branch === null) {
    await opts.beforeLock?.(copy);
  }
  return await withComposeCopyLock({
    projectDir: project.projectDir,
    branch: copy.branch,
    signal: opts.signal,
    run: () => opts.run(copy, project.projectDir),
  });
}

/** Serialize selection and publication for an already resolved checkout and branch. */
export async function withComposeCopyLock<T>(opts: {
  readonly projectDir: string;
  readonly branch: string | null;
  readonly signal?: AbortSignal;
  readonly run: () => Promise<T>;
}): Promise<T> {
  return await withAutostartProjectLock({
    scope: {
      projectId: "",
      // Delimit the branch so a checkout path cannot alias a sibling copy.
      composeProject: `checkout:${await realpath(opts.projectDir)}\0${opts.branch ?? ""}`,
      branch: null,
    },
    signal: opts.signal,
    run: opts.run,
  });
}

/** A checkout lock protects selection; the name lock serializes Compose effects across checkouts. */
export async function withComposeNameLock<T>(
  name: string | undefined,
  run: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (name === undefined) {
    return await run();
  }
  return await withAutostartProjectLock({
    scope: { projectId: "", composeProject: name, branch: null },
    signal,
    run,
  });
}

/** Resolve once before pause, locking and shutdown; an owned base target is explicit null. */
export async function resolveFinalAutostartDownTarget(
  opts: AutostartCommandSelection & {
    readonly writeNotice?: (notice: DownSafetyNotice) => void;
    readonly selectedCopy?: Pick<
      AutostartDownTarget,
      "branch" | "observedComposeProject"
    >;
    readonly lockedCopy?: ComposeCheckoutCopy;
  },
  deps?: {
    readonly readProjectsRegistry?: typeof readProjectsRegistry;
    readonly readRuntimeProjects?: typeof readRuntimeProjects;
    readonly isLocalTarget?: (project: ProjectContext) => Promise<boolean>;
    readonly resolveComposeTarget?: (opts: {
      readonly project: ProjectContext;
      readonly cfg: ProjectConfig;
      readonly branch: string | null;
      readonly observedComposeProject?: string;
    }) => Promise<AutostartDownTarget["compose"]>;
    readonly setProjectAutostartPaused?: typeof setProjectAutostartPaused;
  }
): Promise<AutostartDownTarget | undefined> {
  const registry = await (deps?.readProjectsRegistry ?? readProjectsRegistry)();
  const context = await discoverAutostartCommandContext({ ...opts, registry });
  if (!context) {
    return undefined;
  }
  const { project, registration } = context;
  const cfg = await readProjectConfig(project);
  const targetFor = async (
    branch: string | null,
    observedComposeProject?: string
  ): Promise<AutostartDownTarget> => {
    const compose = await deps?.resolveComposeTarget?.({
      project,
      cfg,
      branch,
      observedComposeProject,
    });
    return {
      branch,
      ...(compose ? { compose } : {}),
      ...(observedComposeProject ? { observedComposeProject } : {}),
    };
  };
  if (opts.selectedCopy) {
    return await targetFor(
      opts.selectedCopy.branch,
      opts.selectedCopy.observedComposeProject
    );
  }
  const locked = opts.lockedCopy?.effective;
  const { explicitBranch, effective } = locked
    ? { explicitBranch: opts.branch?.trim() || null, effective: locked }
    : await resolveAutostartDownBranch({ project, cfg, branch: opts.branch });
  if (explicitBranch !== null || effective.branch === null) {
    return await targetFor(effective.branch);
  }
  if (deps?.isLocalTarget && !(await deps.isLocalTarget(project))) {
    return undefined;
  }
  if (effective.source === "worktree" && effective.branch) {
    opts.writeNotice?.({
      level: "info",
      message: `Linked worktree detected → using branch instance "${effective.branch}" (override with --branch <name>, disable with worktree.auto_branch=false)`,
    });
  }
  const runtime = await (deps?.readRuntimeProjects ?? readRuntimeProjects)({
    includeGlobal: false,
  });
  if (!runtime.ok) {
    // A login pass may be waiting for this same engine. Stop intent cannot
    // wait for it: without runtime evidence any marked instance of this
    // registration (base, this branch, or a renamed worktree's old branch)
    // may be the target, so pause it before failing.
    const paused = await pauseCandidateDownMarker({
      registration,
      pause: deps?.setProjectAutostartPaused ?? setProjectAutostartPaused,
    });
    throw new HackCliError({
      code: "E_DOCKER_UNAVAILABLE",
      message: `Cannot inspect runtime ownership before down: ${runtime.error}${paused ? " Automatic startup for this project is paused; run hack up to resume it." : ""}`,
    });
  }
  const current = await targetFor(effective.branch);
  const baseProjectName =
    current.compose?.base ??
    (await resolveComposeProjectName({ project, cfg }));
  const reconciled = reconcileImplicitDownTarget({
    baseProjectName,
    branch: effective.branch,
    projectDir: project.projectDir,
    runtime: runtime.runtime,
    writeNotice: opts.writeNotice ?? (() => undefined),
  });
  return reconciled.kind === "inferred"
    ? current
    : {
        branch: reconciled.branch,
        observedComposeProject: reconciled.composeProject,
      };
}

/**
 * Pause the registration's marked instance when an implicit down cannot read
 * the engine. Over-pausing a different branch is the safe failure: a later
 * `hack up` resumes it, whereas a missed pause lets a waiting login pass start
 * what this down meant to stop.
 */
async function pauseCandidateDownMarker(opts: {
  readonly registration: RegisteredProject | undefined;
  readonly pause: typeof setProjectAutostartPaused;
}): Promise<boolean> {
  const marker = opts.registration?.autostart;
  if (!(opts.registration && marker) || marker.paused) {
    return false;
  }
  await opts.pause({ id: opts.registration.id, paused: true });
  return true;
}

/** Shared legacy discovery never crosses native inputs or guesses a duplicate named registration. */
async function discoverAutostartCommandContext(
  opts: AutostartCommandSelection & { readonly registry: ProjectsRegistry }
): Promise<
  | {
      readonly project: ProjectContext;
      readonly registration: RegisteredProject | undefined;
    }
  | undefined
> {
  // Retained adoption owns recovery, including pending operations that ordinary
  // input discovery deliberately refuses. Do not fence its dispatcher here.
  if (await selectLegacyComposeAdoptedRoot(opts)) {
    assertAutostartAdoptionAllowed();
    return undefined;
  }
  const requested = resolve(opts.cwd, opts.path ?? ".");
  const cwd = await realpath(requested).catch(() => requested);
  const selected =
    opts.project === undefined
      ? undefined
      : parseProjectSelectorOption({ projectOpt: opts.project });
  const registration = selected
    ? (selectRegisteredProjectByName({
        projects: opts.registry.projects,
        name: selected.name,
      }) ?? undefined)
    : opts.registry.projects
        .filter((entry) =>
          [
            entry.repoRoot,
            ...(entry.worktrees?.map((tree) => tree.path) ?? []),
          ].some((root) => cwd === root || cwd.startsWith(`${root}/`))
        )
        .sort((a, b) => b.repoRoot.length - a.repoRoot.length)[0];
  if (selected && !registration) {
    return undefined;
  }
  const inputs = await discoverProjectInputs({
    startDir: selected && registration ? registration.repoRoot : cwd,
  });
  if (!inputs || inputs.kind !== "legacy") {
    return undefined;
  }
  const project = await findProjectContextAtRoot({
    projectRoot: inputs.projectRoot,
    projectDirName: inputs.composeDirectories.includes(".hack")
      ? ".hack"
      : ".dev",
  });
  return project ? { project, registration } : undefined;
}

/** Login must never continue with a legacy environment requiring migration. */
export async function assertAutostartEnvironment(opts: {
  readonly project: ProjectContext;
}): Promise<void> {
  const project = opts.project;
  // An unfinished or unverifiable env migration needs its owner, not a retry:
  // report it as the manual-start reason before any startup work.
  try {
    await assertEnvMigrationFinished(project);
  } catch {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message:
        "Autostart skipped: an env migration is unfinished or cannot be verified. Finish it with hack env migrate, then run hack up.",
      detail: { reason: "pending_env_migration" },
    });
  }
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
  readonly action: "up" | "down";
  readonly resolvedDownTarget?: AutostartDownTarget;
  readonly cwd: string;
  readonly path?: string;
  readonly project?: string;
  readonly branch?: string;
  readonly expectComposeProject?: string;
  readonly signal?: AbortSignal;
  readonly resolveLoginComposeBase?: (opts: {
    readonly project: ProjectContext;
    readonly cfg: ProjectConfig;
    readonly branch: string | null;
  }) => Promise<string | undefined>;
  readonly run: (loginComposeBase?: string, lockedName?: string) => Promise<T>;
}): Promise<T> {
  const login = process.env.HACK_AUTOSTART_LOGIN === "1";
  if (!login) {
    if (opts.expectComposeProject !== undefined) {
      // The desktop sends the full name, including any branch suffix.
      // Execution revalidates it under this lock before mutating Compose.
      const name = opts.expectComposeProject;
      const run = () =>
        withComposeNameLock(name, () => opts.run(undefined, name), opts.signal);
      if (opts.action === "up") {
        return await withComposeCheckoutLock({ ...opts, run });
      }
      return await run();
    }
    if (opts.action !== "down") {
      return await opts.run();
    }
  }
  const branch = opts.branch?.trim()
    ? sanitizeBranchSlug(opts.branch.trim())
    : null;
  const registry = await readProjectsRegistry(
    login ? { requireAutostartTrust: true } : undefined
  );
  if (login) {
    await assertLoginCheckoutBeforeDiscovery({
      projectId: process.env.HACK_AUTOSTART_PROJECT_ID,
      projects: registry.projects,
    });
  }
  const context = await discoverAutostartCommandContext({ ...opts, registry });
  if (!context) {
    return await opts.run();
  }
  const { project, registration } = context;
  const cfg = await readProjectConfig(project);
  const effective =
    opts.resolvedDownTarget ??
    (await resolveEffectiveBranch({
      explicitBranch: branch,
      projectRoot: project.projectRoot,
      autoBranchEnabled: login ? false : resolveWorktreeAutoBranch(cfg),
    }));
  const projectId = login
    ? process.env.HACK_AUTOSTART_PROJECT_ID
    : registration?.id;
  if (login) {
    assertLoginProjectIdentity({
      projectId,
      projects: registry.projects,
      root: project.projectRoot,
    });
  }
  const loginComposeBase = login
    ? await opts.resolveLoginComposeBase?.({
        project,
        cfg,
        branch: effective.branch,
      })
    : undefined;
  const scope = {
    projectId: projectId ?? "",
    composeProject:
      loginComposeBase ??
      opts.resolvedDownTarget?.compose?.base ??
      (await resolveComposeProjectName({ project, cfg })),
    branch: effective.branch,
  };
  return await withAutostartProjectLock({
    scope,
    signal: opts.signal,
    run: async () => {
      if (login) {
        await assertAutostartProjectCurrent({
          scope,
          expectedRoot: project.projectRoot,
        });
      }
      return await opts.run(loginComposeBase, autostartProjectLockName(scope));
    },
  });
}

/** Check the trusted registry target before even reading repository-controlled inputs. */
async function assertLoginCheckoutBeforeDiscovery(opts: {
  readonly projectId?: string;
  readonly projects: readonly RegisteredProject[];
}): Promise<void> {
  const matches = opts.projects.filter(
    (project) => project.id === opts.projectId
  );
  const project = matches.length === 1 ? matches[0] : undefined;
  if (!project) {
    throw new HackCliError({
      code: "E_CANCELLED",
      message: "Autostart project path changed; no start ran.",
      detail: { reason: "target_changed" },
    });
  }
  assertAutostartCheckoutTrusted(project);
  await assertAutostartStartPolicy(project);
  assertAutostartDockerConfigTrusted({ home: homedir() });
}

function assertLoginProjectIdentity(opts: {
  readonly projectId?: string;
  readonly projects: readonly RegisteredProject[];
  readonly root: string;
}): void {
  if (!opts.projectId || opts.projectId.length > 128) {
    throw new HackCliError({
      code: "E_CANCELLED",
      message: "Autostart requires an explicit registered project identity.",
    });
  }
  if (
    !opts.projects.some(
      (entry) => entry.id === opts.projectId && entry.repoRoot === opts.root
    )
  ) {
    throw new HackCliError({
      code: "E_CANCELLED",
      message: "Autostart project path changed; no start ran.",
    });
  }
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
