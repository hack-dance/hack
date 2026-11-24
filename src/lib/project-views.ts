import { realpathSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

import { YAML } from "bun";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_FILENAME,
} from "../constants.ts";
import { readControlPlaneConfig } from "../control-plane/sdk/config.ts";
import { parseSessionBase } from "../mux/session-names.ts";
import { serializeProjectAutostart } from "./autostart-view.ts";
import {
  type BranchInstanceCheckout,
  type BranchInstanceIdentity,
  type CheckoutOpenSettings,
  checkoutContext,
  configBranchServiceHosts,
  listNativeBranchRecords,
  listRegistrationCheckouts,
  type NativeBranchRecord,
  readCheckoutOpenSettings,
  resolveBranchInstanceName,
  resolveOwningCheckout,
  resolvePrimaryOpenUrl,
  runtimeServiceHosts,
} from "./branch-instance-identity.ts";
import { readBranchUsage } from "./branch-usage.ts";
import { autoWorktreeBranch, readBranchesFile } from "./branches.ts";
import {
  COMPOSE_PROJECT_NAME_TIMEOUT_MS,
  resolveDesktopComposeProjectName,
} from "./compose-project-name.ts";
import {
  type ComposeServiceActivation,
  composeServiceActivation,
} from "./compose-service-activation.ts";
import { composeServiceReadiness } from "./compose-service-readiness.ts";

// biome-ignore lint/performance/noBarrelFile: Preserve the existing project policy serializer import contract.
export { serializeProjectAutostart } from "./autostart-view.ts";

import { pathExists, readTextFile } from "./fs.ts";
import {
  type GitWorktreeListEntry,
  listGitWorktrees,
  resolveGitRepositoryIdentity,
} from "./git-worktree.ts";
import { isRecord } from "./guards.ts";
import { withProcessDeadline } from "./process-deadline.ts";
import {
  type ProjectConfig,
  type ProjectLifecycleCommand,
  type ProjectLifecycleProcess,
  type ProjectOwnershipConfig,
  readProjectConfig,
  resolveWorktreeAutoBranch,
} from "./project.ts";
import {
  assertLegacyProjectInputFamily,
  ProjectInputSelectionError,
} from "./project-input-selection.ts";
import { normalizeProjectName } from "./project-name.ts";
import { observeNativeProject } from "./project-native-observation.ts";
import {
  type ProjectObservation,
  projectObservation,
} from "./project-observation.ts";
import {
  type ProjectRemoteStatus,
  projectRemoteStatuses,
} from "./project-remote-status.ts";
import type { ServiceReadiness } from "./project-state.ts";
import type {
  RegisteredProject,
  RegisteredProjectWorktree,
} from "./projects-registry.ts";
import { selectRegisteredProjectByName } from "./projects-registry.ts";
import {
  countRunningServices,
  type RuntimeProject,
  serializeRuntimeProject,
} from "./runtime-projects.ts";
import { exec, findExecutableInPath } from "./shell.ts";

const NATIVE_OBSERVATION_CONCURRENCY = 4;

export type BranchRuntime = {
  readonly branch: string;
  readonly runtime: RuntimeProject;
  readonly composeProject?: string;
  readonly composeProjectUnresolved?: boolean;
  readonly checkoutVerified?: boolean;
  /** Explicit identity (R20); absent for unregistered projects. */
  readonly identity?: BranchInstanceIdentity;
};

/** A native branch instance from its saved run mapping (R19). */
export type NativeBranchRuntime = {
  readonly branch: string;
  readonly store: NativeBranchRecord["store"];
  readonly identity: BranchInstanceIdentity;
};

type BranchCopy = {
  readonly branch: string | null;
  readonly name: string;
  readonly checkout: BranchInstanceCheckout;
  readonly url: string | null;
  readonly definedServices: readonly string[];
  readonly recorded: boolean;
  readonly composeProject: string | null;
  readonly composeProjectUnresolved?: boolean;
  readonly runtime?: RuntimeProject;
};

export type MuxSession = {
  readonly name: string;
  readonly backend: "tmux" | "zellij";
  readonly attached: boolean;
  readonly path: string | null;
  readonly windows: number | null;
  readonly createdAt: number | null;
};

export type ProjectSession = {
  readonly name: string;
  readonly backend: "tmux" | "zellij";
  readonly source: "hack" | "external";
  readonly attached: boolean;
  readonly path: string | null;
  readonly windows: number | null;
  readonly createdAt: number | null;
};

export type ProjectLifecycleCommandView = {
  readonly name: string | null;
  readonly command: string;
  readonly cwd: string | null;
  readonly service: string;
  readonly persistent?: boolean;
};

export type ProjectLifecycleProcessView = {
  readonly name: string;
  readonly command: string;
  readonly cwd: string | null;
  readonly service: string;
};

export type ProjectLifecycleView = {
  readonly upBefore: readonly ProjectLifecycleCommandView[];
  readonly upAfter: readonly ProjectLifecycleCommandView[];
  readonly downBefore: readonly ProjectLifecycleCommandView[];
  readonly downAfter: readonly ProjectLifecycleCommandView[];
  readonly processes: readonly ProjectLifecycleProcessView[];
};

export type ProjectView = {
  readonly remotes?: readonly ProjectRemoteStatus[];
  readonly observation?: ProjectObservation;
  readonly serviceActivation?: ComposeServiceActivation;
  readonly serviceReadiness?: Readonly<Record<string, ServiceReadiness>>;
  readonly projectId?: string;
  readonly autostart?: RegisteredProject["autostart"];
  readonly name: string;
  readonly devHost: string | null;
  readonly repoRoot: string | null;
  readonly projectDir: string | null;
  readonly ownership: ProjectOwnershipConfig | null;
  readonly definedServices: readonly string[] | null;
  readonly extensionsEnabled: readonly string[] | null;
  readonly features: readonly string[] | null;
  readonly serviceHosts: Readonly<Record<string, readonly string[]>> | null;
  readonly runtimeConfigured: boolean | null;
  readonly runtimeStatus: ProjectRuntimeStatus;
  readonly inputDiagnostic?: {
    readonly code: ProjectInputSelectionError["code"];
    readonly message: string;
  };
  readonly runtime: RuntimeProject | null;
  readonly branchRuntime: readonly BranchRuntime[];
  readonly branchCopies?: readonly BranchCopy[];
  readonly composeProject?: string;
  readonly composeProjectUnresolved?: boolean;
  /** Native branch instances with a saved run mapping (R19). */
  readonly nativeBranchRuntime?: readonly NativeBranchRuntime[];
  /** The URL `hack open` opens with no target and no branch (R20). */
  readonly openUrl?: {
    readonly url: string;
    readonly host: "dev" | "alias";
  } | null;
  readonly sessions: readonly ProjectSession[];
  readonly lifecycle: ProjectLifecycleView | null;
  readonly worktrees: readonly RegisteredProjectWorktree[] | null;
  readonly kind: "registered" | "unregistered";
  readonly status:
    | "running"
    | "stopped"
    | "missing"
    | "unregistered"
    | "unavailable"
    | "unknown";
};

export type ProjectRuntimeStatus =
  | "running"
  | "stopped"
  | "missing"
  | "unknown"
  | "unavailable"
  | "not_configured";

type BuildProjectViewsOptions = {
  readonly observeNative?: boolean;
  readonly registryProjects: readonly RegisteredProject[];
  readonly runtime: readonly RuntimeProject[];
  readonly runtimeOk: boolean;
  readonly filter: string | null;
  readonly includeUnregistered: boolean;
  readonly muxSessions?: readonly MuxSession[];
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Project views aggregate many optional runtime signals into one read model.
export async function buildProjectViews(
  opts: BuildProjectViewsOptions
): Promise<ProjectView[]> {
  const runtimeByName = new Map(
    opts.runtime.map((p) => [p.project, p] as const)
  );
  const runtimeByProjectDir = new Map<string, RuntimeProject[]>();
  for (const runtimeProject of opts.runtime) {
    if (!runtimeProject.workingDir) {
      continue;
    }
    const dir = canonicalPath(runtimeProject.workingDir);
    const runtimes = runtimeByProjectDir.get(dir) ?? [];
    runtimes.push(runtimeProject);
    runtimeByProjectDir.set(dir, runtimes);
  }

  if (opts.filter) {
    selectRegisteredProjectByName({
      projects: opts.registryProjects,
      name: opts.filter,
    });
  }
  const names = new Set<string>();
  for (const p of opts.registryProjects) {
    names.add(p.name);
  }
  if (opts.includeUnregistered) {
    for (const runtimeProject of opts.runtime) {
      names.add(runtimeProject.project);
    }
  }
  const muxSessions = opts.muxSessions ?? (await listMuxSessions());

  // The desktop daemon request has a 3-second budget. Share one smaller
  // Git deadline across projects so a slow checkout cannot starve the list.
  const gitDeadline = performance.now() + 800;
  const catalogs = new Map<string, CheckoutCatalog>();
  const checkoutOwners = new Map<string, string>();
  // A checkout registered directly takes precedence over a linked checkout
  // recorded by another registration.
  for (const registration of opts.registryProjects) {
    checkoutOwners.set(canonicalPath(registration.repoRoot), registration.name);
    checkoutOwners.set(
      canonicalPath(registration.projectDir),
      registration.name
    );
  }
  for (const registration of opts.registryProjects) {
    const catalog = await describeCheckoutCatalog({
      registration,
      deadline: gitDeadline,
    });
    catalogs.set(registration.name, catalog);
    indexLinkedCheckoutOwners({ catalog, checkoutOwners, current: true });
  }
  for (const catalog of catalogs.values()) {
    indexLinkedCheckoutOwners({ catalog, checkoutOwners, current: false });
  }
  const runtimeOwners = new Map(
    opts.runtime.map((runtime) => [
      runtime,
      runtime.workingDir
        ? checkoutOwners.get(canonicalPath(runtime.workingDir))
        : undefined,
    ])
  );
  // Interpolated names use local Compose config. Share a budget across the
  // entire snapshot, independently of the Git discovery budget.
  const composeDeadline = Date.now() + COMPOSE_PROJECT_NAME_TIMEOUT_MS;
  const out: ProjectView[] = [];
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    if (
      opts.filter &&
      normalizeProjectName(name) !== normalizeProjectName(opts.filter)
    ) {
      continue;
    }

    const catalog = catalogs.get(name);
    if (catalog) {
      out.push(
        await buildRegisteredProjectView({
          name,
          catalog,
          composeDeadline,
          runtimeInProjectDir:
            runtimeByProjectDir.get(
              canonicalPath(catalog.registration.projectDir)
            ) ?? [],
          runtimeByName,
          allRuntime: opts.runtime.filter((runtime) => {
            const owner = runtimeOwners.get(runtime);
            return owner === undefined || owner === name;
          }),
          runtimeOk: opts.runtimeOk,
          muxSessions,
        })
      );
      continue;
    }

    if (opts.includeUnregistered) {
      out.push(
        buildUnregisteredProjectView({
          name,
          runtime: runtimeByName.get(name) ?? null,
          runtimeOk: opts.runtimeOk,
        })
      );
    }
  }

  const nestedRuntimeNames = new Set(
    out.flatMap((view) => [
      ...(view.kind === "registered" && view.runtime
        ? [view.runtime.project]
        : []),
      ...view.branchRuntime.flatMap((entry) =>
        entry.identity?.checkout ? [entry.runtime.project] : []
      ),
      ...(view.branchCopies ?? []).flatMap((copy) =>
        copy.runtime ? [copy.runtime.project] : []
      ),
    ])
  );
  const visible = out.filter(
    (view) => view.kind === "registered" || !nestedRuntimeNames.has(view.name)
  );
  const nativeSelected = process.env.HACK_RUNTIME_BACKEND?.trim() === "native";
  const observed: ProjectView[] = [];
  // Native status reads own subprocesses; keep registry size from becoming fan-out.
  for (
    let offset = 0;
    offset < visible.length;
    offset += NATIVE_OBSERVATION_CONCURRENCY
  ) {
    observed.push(
      ...(await Promise.all(
        visible
          .slice(offset, offset + NATIVE_OBSERVATION_CONCURRENCY)
          .map(async (view) => {
            const base = projectObservation({
              view,
              runtimeOk: opts.runtimeOk,
              nativeSelected,
            });
            const observation =
              opts.observeNative && base.backend === "native"
                ? await observeNativeProject({ view })
                : base;
            return { ...view, observation };
          })
      ))
    );
  }
  return observed;
}

function resolveRegisteredRuntime(opts: {
  readonly registration: RegisteredProject;
  readonly baseName: string | null;
  readonly runtimeInProjectDir: readonly RuntimeProject[];
  readonly runtimeByName: ReadonlyMap<string, RuntimeProject>;
}): RuntimeProject | null {
  for (const name of new Set([opts.baseName, opts.registration.name])) {
    if (name === null) {
      continue;
    }
    const runtime = opts.runtimeByName.get(name);
    if (
      runtime &&
      (!runtime.workingDir ||
        resolveOwningCheckout({
          registration: opts.registration,
          workingDir: runtime.workingDir,
        })?.kind === "primary")
    ) {
      return runtime;
    }
  }
  // Keep the legacy directory match for old Compose names. A branch instance
  // can start in the same directory and must never become the base row.
  const legacy = opts.runtimeInProjectDir.filter(
    (runtime) => !runtime.project.includes("--")
  );
  return legacy.length === 1 ? (legacy[0] ?? null) : null;
}

async function buildRegisteredProjectView(opts: {
  readonly name: string;
  readonly catalog: CheckoutCatalog;
  readonly composeDeadline: number;
  readonly runtimeInProjectDir: readonly RuntimeProject[];
  readonly runtimeByName: ReadonlyMap<string, RuntimeProject>;
  readonly allRuntime: readonly RuntimeProject[];
  readonly runtimeOk: boolean;
  readonly muxSessions: readonly MuxSession[];
}): Promise<ProjectView> {
  const { catalog } = opts;
  const registration = catalog.original;
  try {
    await assertLegacyProjectInputFamily({
      projectRoot: registration.repoRoot,
    });
  } catch (error: unknown) {
    if (!(error instanceof ProjectInputSelectionError)) {
      throw error;
    }
    return buildUnavailableProjectView({
      name: opts.name,
      registration,
      error,
      nativeBranchRuntime:
        error.code === "E_NATIVE_PROJECT_UNSUPPORTED"
          ? await describeAuthoredNativeBranchInstances({
              registration,
            })
          : [],
    });
  }
  const { projectDirOk } = catalog;
  const composeFile = resolve(
    registration.projectDir,
    PROJECT_COMPOSE_FILENAME
  );
  const composeExists = projectDirOk && (await pathExists(composeFile));
  const composeDefinition = composeExists
    ? await readComposeServices({ composeFile })
    : null;
  const config = projectDirOk
    ? await readRegisteredProjectConfig({ registration })
    : null;
  const resolveComposeName: typeof resolveDesktopComposeProjectName = (input) =>
    withProcessDeadline(opts.composeDeadline, () =>
      resolveDesktopComposeProjectName(input)
    );
  const composeNameInput = {
    project: { composeFile, projectRoot: registration.repoRoot },
    cfg: config ?? undefined,
    composeName: composeDefinition?.name ?? null,
  };
  const [baseName, branchBaseName] = await Promise.all([
    resolveComposeName(composeNameInput),
    resolveComposeName({ ...composeNameInput, forBranch: true }),
  ]);
  const runtime = resolveRegisteredRuntime({ ...opts, registration, baseName });
  const definedServices = composeDefinition?.names ?? null;
  const serviceHosts = composeExists
    ? await readComposeServiceHosts({ composeFile })
    : null;
  const running = countRunningServices(runtime);
  const runtimeConfigured = composeExists;
  const runtimeStatus: ProjectRuntimeStatus = resolveRuntimeStatus({
    projectDirOk,
    composeExists,
    runtimeOk: opts.runtimeOk,
    running,
  });
  const status: ProjectView["status"] = resolveProjectStatus({
    projectDirOk,
    runtimeOk: opts.runtimeOk,
    running,
  });
  const checkoutNames = new Map([
    [
      composeNameCacheKey(registration.projectDir, false),
      Promise.resolve(baseName),
    ],
    [
      composeNameCacheKey(registration.projectDir, true),
      Promise.resolve(branchBaseName),
    ],
  ]);
  const checkoutComposeName: CheckoutComposeName = ({
    project,
    cfg,
    composeName,
    forBranch,
  }) => {
    const key = composeNameCacheKey(project.projectDir, forBranch);
    let name = checkoutNames.get(key);
    if (!name) {
      name = resolveCheckoutName({
        project,
        cfg,
        composeName,
        forBranch,
        resolveComposeName,
      });
      checkoutNames.set(key, name);
    }
    return name;
  };
  const branchIdentity = await describeBranchInstances({
    ...catalog,
    checkoutComposeName,
    allRuntime: opts.allRuntime,
    branchRuntime: await collectBranchRuntime({
      ...catalog,
      baseName: branchBaseName,
      primaryRuntime: runtime,
      checkoutComposeName,
      runtimeProjects: opts.allRuntime,
    }),
  });
  const sessions = collectProjectSessions({
    projectName: opts.name,
    repoRoot: registration.repoRoot,
    muxSessions: opts.muxSessions,
  });
  const extensions = projectDirOk
    ? await resolveProjectExtensions({
        projectDir: registration.projectDir,
      })
    : null;
  const lifecycle = resolveProjectLifecycleView({ config });
  const defaults = config?.prerequisites?.config?.selected ?? [];
  const remotes = defaults.flatMap((entry) =>
    projectRemoteStatuses([entry]).map((status) => ({
      ...status,
      defaultTarget: entry.target,
    }))
  );

  return {
    projectId: registration.id,
    autostart: registration.autostart,
    name: opts.name,
    devHost: registration.devHost ?? null,
    repoRoot: registration.repoRoot,
    projectDir: registration.projectDir,
    ownership: config && !config.parseError ? config.ownership : null,
    ...(remotes.length > 0 ? { remotes } : {}),
    definedServices,
    serviceReadiness: composeDefinition?.readiness,
    serviceActivation: composeDefinition?.activation,
    extensionsEnabled: extensions?.enabled ?? null,
    features: extensions?.features ?? null,
    serviceHosts,
    runtimeConfigured,
    runtimeStatus,
    runtime,
    composeProject: baseName ?? undefined,
    composeProjectUnresolved: baseName === null,
    branchRuntime: branchIdentity.branchRuntime,
    branchCopies: branchIdentity.branchCopies,
    nativeBranchRuntime: branchIdentity.nativeBranchRuntime,
    openUrl: branchIdentity.openUrl,
    sessions,
    lifecycle,
    worktrees: registration.worktrees ?? null,
    kind: "registered",
    status,
  };
}

/**
 * Explicit branch instance identity for one registered project (HACK-2281).
 *
 * Cost per project: one config read per checkout that owns an instance (at
 * most the registered checkout plus its worktrees), one small
 * `branch-usage.json` read per instance, and for native instances two
 * directory listings per checkout plus one small JSON read per saved run
 * mapping. Automatic copies share one Git worktree read per repository.
 * Resolving an interpolated name can invoke local Compose config, without
 * contacting the Docker engine.
 */
async function describeBranchInstances(opts: {
  readonly registration: RegisteredProject;
  readonly gitWorktrees: readonly GitWorktreeListEntry[] | null;
  readonly verifiedRoots: ReadonlySet<string>;
  readonly allRuntime: readonly RuntimeProject[];
  readonly branchRuntime: readonly BranchRuntime[];
  readonly checkoutComposeName: CheckoutComposeName;
  /** Without its project dir a checkout has no settings `hack open` could use. */
  readonly projectDirOk: boolean;
}): Promise<{
  readonly branchRuntime: readonly BranchRuntime[];
  readonly branchCopies: readonly BranchCopy[];
  readonly nativeBranchRuntime: readonly NativeBranchRuntime[];
  readonly openUrl: ProjectView["openUrl"];
}> {
  const settingsByRoot = new Map<
    string,
    Promise<CheckoutOpenSettings | null>
  >();
  const settingsFor = (checkout: BranchInstanceCheckout) => {
    const key = checkout.projectDir;
    let pending = settingsByRoot.get(key);
    if (!pending) {
      pending = readCheckoutOpenSettings({
        registration: opts.registration,
        checkout,
      }).catch(() => null);
      settingsByRoot.set(key, pending);
    }
    return pending;
  };
  const siteHostsByDir = new Map<
    string,
    Promise<Readonly<Record<string, readonly string[]>> | null>
  >();
  const siteHostsFor = (projectDir: string) => {
    let pending = siteHostsByDir.get(projectDir);
    if (!pending) {
      pending = readComposeSiteLabelHosts({
        composeFile: resolve(projectDir, PROJECT_COMPOSE_FILENAME),
      }).catch(() => null);
      siteHostsByDir.set(projectDir, pending);
    }
    return pending;
  };
  const checkouts = listRegistrationCheckouts(opts.registration);
  const primary = checkouts[0];
  const primarySettings =
    primary && opts.projectDirOk ? await settingsFor(primary) : null;

  const describe = async (input: {
    readonly slug: string;
    readonly checkout: BranchInstanceCheckout | null;
    readonly runtime: RuntimeProject | null;
  }): Promise<BranchInstanceIdentity> => {
    const canReadConfig =
      !input.checkout ||
      (input.runtime === null && opts.gitWorktrees === null) ||
      isCurrentCheckout(input.checkout, opts.verifiedRoots);
    // Compose reads without an owner can report observed Caddy routes only.
    let settings = input.runtime === null ? primarySettings : null;
    if (input.checkout) {
      settings =
        canReadConfig && (await pathExists(input.checkout.projectDir))
          ? await settingsFor(input.checkout)
          : null;
    }
    const named = await resolveBranchInstanceName({
      registration: opts.registration,
      checkout: canReadConfig ? input.checkout : null,
      slug: input.slug,
    });
    const open = settings
      ? resolvePrimaryOpenUrl({ settings, branch: input.slug })
      : null;
    const runtimeHosts = input.runtime
      ? runtimeServiceHosts(input.runtime)
      : {};
    const useRuntimeHosts = Object.keys(runtimeHosts).length > 0;
    let serviceHosts: Readonly<Record<string, readonly string[]>> = {};
    if (useRuntimeHosts) {
      serviceHosts = runtimeHosts;
    } else if (settings) {
      // The owning checkout's own Compose file (a worktree's can differ from
      // the primary's), with every root site label, numbered ones included.
      const baseServiceHosts = await siteHostsFor(
        input.checkout?.projectDir ?? opts.registration.projectDir
      );
      serviceHosts = configBranchServiceHosts({
        baseServiceHosts,
        settings,
        branch: input.slug,
      });
    }
    return {
      name: named.name,
      nameSource: named.source,
      checkout: input.checkout,
      serviceHosts,
      hostsSource: useRuntimeHosts ? "runtime_labels" : "config",
      url: open?.url ?? null,
      urlHost: open?.host ?? null,
    };
  };

  const branchRuntime = await Promise.all(
    opts.branchRuntime.map(async (entry) => ({
      ...entry,
      identity: await describe({
        slug: entry.branch,
        checkout: resolveOwningCheckout({
          registration: opts.registration,
          workingDir: entry.runtime.workingDir,
        }),
        runtime: entry.runtime,
      }),
    }))
  );

  // Each checkout's store is scanned on its own: a missing registered
  // checkout does not hide a worktree's instances (an absent store is empty).
  const nativeBranchRuntime: NativeBranchRuntime[] = [];
  const seen = new Set<string>();
  for (const checkout of checkouts) {
    if (opts.gitWorktrees && !isCurrentCheckout(checkout, opts.verifiedRoots)) {
      continue;
    }
    for (const record of await listNativeBranchRecords({
      checkout,
      store: "runtime",
    })) {
      const key = `${record.checkout.projectDir}\0${record.slug}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      nativeBranchRuntime.push({
        branch: record.slug,
        store: record.store,
        identity: await describe({
          slug: record.slug,
          checkout: record.checkout,
          runtime: null,
        }),
      });
    }
  }

  const branchCopies = await describeBranchCopies({
    registration: opts.registration,
    checkouts,
    settingsFor,
    checkoutComposeName: opts.checkoutComposeName,
    runtime: opts.allRuntime,
    gitWorktrees: opts.gitWorktrees,
    verifiedRoots: opts.verifiedRoots,
  });
  const linkedBaseRuntimes = new Set(branchCopies.map((copy) => copy.runtime));
  return {
    branchRuntime: branchRuntime.filter(
      (entry) => !linkedBaseRuntimes.has(entry.runtime)
    ),
    branchCopies,
    nativeBranchRuntime,
    openUrl: primarySettings
      ? resolvePrimaryOpenUrl({ settings: primarySettings, branch: null })
      : null,
  };
}

type CheckoutCatalog = {
  readonly original: RegisteredProject;
  readonly registration: RegisteredProject;
  readonly projectDirOk: boolean;
  readonly gitWorktrees: readonly GitWorktreeListEntry[] | null;
  readonly verifiedRoots: ReadonlySet<string>;
};

type CheckoutComposeName = (opts: {
  readonly project: ReturnType<typeof checkoutContext>;
  readonly cfg?: ProjectConfig;
  readonly composeName?: string | null;
  readonly forBranch: boolean;
}) => Promise<string | null>;

function composeNameCacheKey(path: string, forBranch: boolean): string {
  return `${canonicalPath(path)}\0${forBranch}`;
}

async function resolveCheckoutName(
  opts: Parameters<CheckoutComposeName>[0] & {
    readonly resolveComposeName: typeof resolveDesktopComposeProjectName;
  }
): Promise<string | null> {
  const cfg = opts.cfg ?? (await readableCheckoutConfig(opts.project));
  return cfg ? await opts.resolveComposeName({ ...opts, cfg }) : null;
}

function indexLinkedCheckoutOwners(opts: {
  readonly catalog: CheckoutCatalog;
  readonly checkoutOwners: Map<string, string>;
  readonly current: boolean;
}): void {
  const { registration, verifiedRoots } = opts.catalog;
  for (const checkout of listRegistrationCheckouts(registration).slice(1)) {
    if (isCurrentCheckout(checkout, verifiedRoots) !== opts.current) {
      continue;
    }
    for (const path of [checkout.root, checkout.projectDir]) {
      const key = canonicalPath(path);
      if (!opts.checkoutOwners.has(key)) {
        opts.checkoutOwners.set(key, registration.name);
      }
    }
  }
}

/** Extend only this observation's checkout catalog. The registry payload stays as saved. */
async function describeCheckoutCatalog(opts: {
  readonly registration: RegisteredProject;
  readonly deadline: number;
}): Promise<CheckoutCatalog> {
  const { registration } = opts;
  const projectDirOk = await pathExists(registration.projectDir);
  const timeoutMs = remainingGitTime(opts.deadline);
  const gitWorktrees =
    projectDirOk && timeoutMs > 0
      ? await listGitWorktrees({ repoRoot: registration.repoRoot, timeoutMs })
      : null;
  const primary = canonicalPath(registration.repoRoot);
  if (!gitWorktrees?.some((entry) => canonicalPath(entry.path) === primary)) {
    return {
      original: registration,
      registration,
      projectDirOk,
      gitWorktrees: null,
      verifiedRoots: new Set(),
    };
  }
  const linked = gitWorktrees.slice(1);
  const verifiedRoots = await verifyLinkedCheckoutRoots(
    registration.repoRoot,
    linked,
    opts.deadline
  );
  const registered = registration.worktrees ?? [];
  const paths = new Set([
    primary,
    ...registered.map((entry) => canonicalPath(entry.path)),
  ]);
  const discovered = linked
    .filter((entry) => {
      const path = canonicalPath(entry.path);
      return verifiedRoots.has(path) && !paths.has(path);
    })
    .map((entry) => ({
      path: entry.path,
      branch: entry.branch,
      lastSeenAt: registration.createdAt,
    }));
  return {
    original: registration,
    registration: {
      ...registration,
      worktrees: [...registered, ...discovered],
    },
    projectDirOk,
    gitWorktrees,
    verifiedRoots,
  };
}

function remainingGitTime(deadline: number): number {
  return Math.max(0, Math.floor(deadline - performance.now()));
}

async function verifyLinkedCheckoutRoots(
  repoRoot: string,
  linked: readonly GitWorktreeListEntry[],
  deadline: number
): Promise<ReadonlySet<string>> {
  const roots = new Set<string>();
  const timeoutMs = remainingGitTime(deadline);
  if (linked.length === 0 || timeoutMs === 0) {
    return roots;
  }
  const family = await resolveGitRepositoryIdentity({ repoRoot, timeoutMs });
  if (!family) {
    return roots;
  }
  for (
    let offset = 0;
    offset < linked.length && remainingGitTime(deadline) > 0;
    offset += 4
  ) {
    await Promise.all(
      linked.slice(offset, offset + 4).map(async (entry) => {
        const metadata = await lstat(resolve(entry.path, ".git")).catch(
          () => null
        );
        if (!metadata?.isFile()) {
          return;
        }
        const remaining = remainingGitTime(deadline);
        if (remaining === 0) {
          return;
        }
        const identity = await resolveGitRepositoryIdentity({
          repoRoot: entry.path,
          timeoutMs: remaining,
        });
        if (identity === family) {
          roots.add(canonicalPath(entry.path));
        }
      })
    );
  }
  return roots;
}

/** Configured and previously used instances, independent of container observation. */
async function describeBranchCopies(opts: {
  readonly registration: RegisteredProject;
  readonly checkouts: readonly BranchInstanceCheckout[];
  readonly gitWorktrees: readonly GitWorktreeListEntry[] | null;
  readonly verifiedRoots: ReadonlySet<string>;
  readonly runtime: readonly RuntimeProject[];
  readonly checkoutComposeName: CheckoutComposeName;
  readonly settingsFor: (
    checkout: BranchInstanceCheckout
  ) => Promise<CheckoutOpenSettings | null>;
}): Promise<readonly BranchCopy[]> {
  const worktrees = opts.registration.worktrees ?? [];
  const gitWorktrees = opts.gitWorktrees;
  const linked = new Map(
    gitWorktrees?.slice(1).map((entry) => [canonicalPath(entry.path), entry])
  );
  const copies = await Promise.all(
    opts.checkouts.map(async (checkout) => {
      if (!isCurrentCheckout(checkout, opts.verifiedRoots)) {
        const remembered = worktrees.find(
          (entry) => entry.path === checkout.root
        );
        return [
          {
            branch: null,
            name:
              remembered?.branch ??
              checkout.root.split("/").at(-1) ??
              "worktree",
            checkout,
            definedServices: [],
            recorded: false,
            composeProject: null,
            url: null,
          },
        ];
      }
      const exists = await pathExists(checkout.projectDir);
      const project = checkoutContext({ ...opts, checkout });
      const config = exists ? await readableCheckoutConfig(project) : null;
      const [settings, usage] = exists
        ? await Promise.all([
            opts.settingsFor(checkout),
            readBranchUsage({ projectDir: checkout.projectDir }).catch(
              () => new Map()
            ),
          ])
        : ([null, new Map()] as const);
      const branches = new Map<string | null, string>(
        [...usage].map(([slug, entry]) => [slug, entry.name ?? slug])
      );
      await addConfiguredBranches({
        checkout,
        worktrees,
        gitWorktrees,
        linked,
        config,
        exists,
        branches,
      });
      const compose =
        branches.size > 0 && config
          ? await readComposeServices({
              composeFile: project.composeFile,
            }).catch(() => null)
          : null;
      const nameFor = (forBranch: boolean) =>
        compose && config
          ? opts.checkoutComposeName({
              project,
              cfg: config,
              composeName: compose.name,
              forBranch,
            })
          : Promise.resolve(null);
      // A linked checkout can explicitly use its own base instance.
      const worktreeUsesBase =
        checkout.kind === "worktree" &&
        linked.has(canonicalPath(checkout.root)) &&
        config !== null &&
        !resolveWorktreeAutoBranch(config);
      const worktreeBase = worktreeUsesBase ? await nameFor(false) : null;
      const branchBase = [...branches.keys()].some((branch) => branch !== null)
        ? await nameFor(true)
        : null;
      const baseRuntime = worktreeBase
        ? opts.runtime.find(
            (row) =>
              row.project === worktreeBase &&
              row.workingDir !== null &&
              canonicalPath(row.workingDir) ===
                canonicalPath(checkout.projectDir)
          )
        : undefined;
      return [...branches].map(([branch, name]) => ({
        branch,
        name,
        checkout,
        definedServices: compose?.names ?? [],
        recorded: branch !== null && usage.has(branch),
        composeProject:
          branch === null
            ? worktreeBase
            : composeBranchName(branchBase, branch),
        composeProjectUnresolved:
          compose !== null &&
          (branch === null
            ? worktreeUsesBase && worktreeBase === null
            : branchBase === null),
        ...(branch === null && baseRuntime ? { runtime: baseRuntime } : {}),
        url:
          settings && (branch || worktreeUsesBase)
            ? (resolvePrimaryOpenUrl({ settings, branch })?.url ?? null)
            : null,
      }));
    })
  );
  return copies.flat();
}

function isCurrentCheckout(
  checkout: BranchInstanceCheckout,
  verifiedRoots: ReadonlySet<string>
): boolean {
  return (
    checkout.kind === "primary" ||
    verifiedRoots.has(canonicalPath(checkout.root))
  );
}

function composeBranchName(base: string | null, branch: string): string | null {
  return base ? `${base}--${branch}` : null;
}

async function addConfiguredBranches(opts: {
  readonly checkout: BranchInstanceCheckout;
  readonly worktrees: readonly RegisteredProjectWorktree[];
  readonly gitWorktrees: readonly GitWorktreeListEntry[] | null;
  readonly linked: ReadonlyMap<string, GitWorktreeListEntry>;
  readonly config: ProjectConfig | null;
  readonly exists: boolean;
  readonly branches: Map<string | null, string>;
}): Promise<void> {
  if (opts.checkout.kind === "worktree") {
    const current = opts.linked.get(canonicalPath(opts.checkout.root));
    const registeredBranch = opts.gitWorktrees
      ? null
      : opts.worktrees.find((entry) => entry.path === opts.checkout.root)
          ?.branch;
    const gitBranch = current?.branch;
    const automatic =
      gitBranch && opts.config && resolveWorktreeAutoBranch(opts.config)
        ? autoWorktreeBranch(gitBranch, opts.gitWorktrees)
        : null;
    opts.branches.set(
      automatic,
      current?.branch ??
        registeredBranch ??
        opts.checkout.root.split("/").at(-1) ??
        "worktree"
    );
  }
  if (opts.checkout.kind === "primary" && opts.exists) {
    const configured = await readBranchesFile({
      projectDir: opts.checkout.projectDir,
    }).catch(() => null);
    for (const branch of configured?.file.branches ?? []) {
      opts.branches.set(branch.slug, branch.name);
    }
  }
}

async function readableCheckoutConfig(
  project: ReturnType<typeof checkoutContext>
): Promise<ProjectConfig | null> {
  try {
    return await readProjectConfig(project);
  } catch {
    // A native, conflicting or unreadable checkout cannot supply a Compose target.
    return null;
  }
}

/**
 * Native branch instances of an authored project (`.hack/hack.project.json`), from
 * `.internal/native-authored-runs` mappings. Their mapping keys the instance
 * by the `--branch` value as given, so `branch` and `branch_name` are both
 * that value. `hack open` there reads the saved native routing, which this
 * read does not open, so `url` and `hosts` are not reported
 * (`hosts_source: unavailable`) rather than guessed from defaults.
 */
async function describeAuthoredNativeBranchInstances(opts: {
  readonly registration: RegisteredProject;
}): Promise<readonly NativeBranchRuntime[]> {
  const out: NativeBranchRuntime[] = [];
  for (const checkout of listRegistrationCheckouts(opts.registration)) {
    for (const record of await listNativeBranchRecords({
      checkout,
      store: "authored",
    })) {
      out.push({
        branch: record.slug,
        store: "authored",
        identity: {
          name: record.slug,
          nameSource: "recorded",
          checkout,
          serviceHosts: {},
          hostsSource: "unavailable",
          url: null,
          urlHost: null,
        },
      });
    }
  }
  return out;
}

function serializeBranchInstanceIdentity(
  identity: BranchInstanceIdentity | undefined
): Record<string, unknown> {
  if (!identity) {
    return {};
  }
  return {
    branch_name: identity.name,
    branch_name_source: identity.nameSource,
    checkout: identity.checkout
      ? {
          root: identity.checkout.root,
          project_dir: identity.checkout.projectDir,
          kind: identity.checkout.kind,
        }
      : null,
    hosts: identity.serviceHosts,
    hosts_source: identity.hostsSource,
    url: identity.url,
    url_host: identity.urlHost,
  };
}

function buildUnavailableProjectView(opts: {
  readonly name: string;
  readonly registration: RegisteredProject;
  readonly error: ProjectInputSelectionError;
  readonly nativeBranchRuntime?: readonly NativeBranchRuntime[];
}): ProjectView {
  return {
    projectId: opts.registration.id,
    autostart: opts.registration.autostart,
    name: opts.name,
    devHost: opts.registration.devHost ?? null,
    repoRoot: opts.registration.repoRoot,
    projectDir: opts.registration.projectDir,
    ownership: null,
    definedServices: null,
    extensionsEnabled: null,
    features: null,
    serviceHosts: null,
    runtimeConfigured: null,
    runtimeStatus: "unavailable",
    inputDiagnostic: { code: opts.error.code, message: opts.error.message },
    runtime: null,
    branchRuntime: [],
    nativeBranchRuntime: opts.nativeBranchRuntime ?? [],
    openUrl: null,
    sessions: [],
    lifecycle: null,
    worktrees: opts.registration.worktrees ?? null,
    kind: "registered",
    status: "unavailable",
  };
}

function buildUnregisteredProjectView(opts: {
  readonly name: string;
  readonly runtime: RuntimeProject | null;
  readonly runtimeOk: boolean;
}): ProjectView {
  const running = countRunningServices(opts.runtime);
  const runtimeStatus: ProjectRuntimeStatus = resolveUnregisteredRuntimeStatus({
    runtimeOk: opts.runtimeOk,
    running,
  });
  return {
    name: opts.name,
    devHost: null,
    repoRoot: null,
    projectDir: null,
    ownership: null,
    definedServices: null,
    extensionsEnabled: null,
    features: null,
    serviceHosts: null,
    runtimeConfigured: null,
    runtimeStatus,
    runtime: opts.runtime,
    branchRuntime: [],
    sessions: [],
    lifecycle: null,
    worktrees: null,
    kind: "unregistered",
    status: "unregistered",
  };
}

/** Summary projection deliberately excludes container labels, mounts and command definitions. */
export function serializeProjectSummary(
  view: ProjectView
): Record<string, unknown> {
  const runtimes = [
    view.runtime,
    ...view.branchRuntime.map((branch) => branch.runtime),
    ...(view.branchCopies ?? []).map((copy) => copy.runtime ?? null),
  ].filter((runtime): runtime is RuntimeProject => runtime !== null);
  const containers = runtimes.flatMap((runtime) =>
    [...runtime.services.values()].flatMap((service) => service.containers)
  );
  return {
    ...(view.observation ??
      projectObservation({
        view,
        runtimeOk:
          view.runtimeStatus !== "unknown" &&
          view.runtimeStatus !== "unavailable",
        nativeSelected: false,
      })),
    project_id: view.projectId ?? null,
    autostart: serializeProjectAutostart(view.autostart),
    name: view.name,
    repo_root: view.repoRoot,
    dev_host: view.devHost,
    status: view.status,
    runtime_status: view.runtimeStatus,
    ...(view.inputDiagnostic ? { input_diagnostic: view.inputDiagnostic } : {}),
    defined_service_count: view.definedServices?.length ?? null,
    host_process_count: containers.filter(
      (container) => container.labels?.["hack.lifecycle.process"] === "true"
    ).length,
    container_count: containers.filter(
      (container) => container.labels?.["hack.lifecycle.process"] !== "true"
    ).length,
    running_container_count: containers.filter(
      (container) =>
        container.state === "running" &&
        container.labels?.["hack.lifecycle.process"] !== "true"
    ).length,
    branch_count: view.branchRuntime.length,
    session_count: view.sessions.length,
  };
}

export function serializeProjectView(
  view: ProjectView
): Record<string, unknown> {
  return {
    ...(view.observation ??
      projectObservation({
        view,
        runtimeOk:
          view.runtimeStatus !== "unknown" &&
          view.runtimeStatus !== "unavailable",
        nativeSelected: false,
      })),
    project_id: view.projectId ?? null,
    autostart: serializeProjectAutostart(view.autostart),
    name: view.name,
    dev_host: view.devHost ?? null,
    repo_root: view.repoRoot ?? null,
    project_dir: view.projectDir ?? null,
    ownership: view.ownership
      ? {
          mode: view.ownership.mode,
          owner_type: view.ownership.ownerType,
          owner_id: view.ownership.ownerId,
          managed_by: view.ownership.managedBy,
        }
      : null,
    defined_services: view.definedServices ?? null,
    extensions_enabled: view.extensionsEnabled ?? null,
    features: view.features ?? null,
    service_hosts: view.serviceHosts ?? null,
    ...(view.remotes ? { remotes: view.remotes } : {}),
    runtime_configured: view.runtimeConfigured ?? null,
    runtime_status: view.runtimeStatus,
    ...(view.inputDiagnostic ? { input_diagnostic: view.inputDiagnostic } : {}),
    runtime: view.runtime ? serializeRuntimeProject(view.runtime) : null,
    compose_project: view.composeProject ?? null,
    ...(view.composeProjectUnresolved
      ? { compose_project_unresolved: true }
      : {}),
    branch_runtime: view.branchRuntime.map((entry) => ({
      branch: entry.branch,
      runtime: serializeRuntimeProject(entry.runtime),
      backend: "compose",
      ...(entry.composeProject
        ? { compose_project: entry.composeProject }
        : {}),
      ...(entry.composeProjectUnresolved
        ? { compose_project_unresolved: true }
        : {}),
      checkout_verified: entry.checkoutVerified,
      ...serializeBranchInstanceIdentity(entry.identity),
    })),
    branch_copies: (view.branchCopies ?? []).map((entry) => ({
      branch: entry.branch,
      branch_name: entry.name,
      checkout: {
        root: entry.checkout.root,
        project_dir: entry.checkout.projectDir,
        kind: entry.checkout.kind,
      },
      url: entry.url,
      defined_services: entry.definedServices,
      recorded: entry.recorded,
      ...(entry.composeProject
        ? { compose_project: entry.composeProject }
        : {}),
      ...(entry.composeProjectUnresolved
        ? { compose_project_unresolved: true }
        : {}),
      ...(entry.runtime
        ? { runtime: serializeRuntimeProject(entry.runtime) }
        : {}),
    })),
    native_branch_runtime: (view.nativeBranchRuntime ?? []).map((entry) => ({
      branch: entry.branch,
      backend: "native",
      // A saved run mapping, not proof that the runtime is alive.
      state: "recorded",
      store: entry.store,
      ...serializeBranchInstanceIdentity(entry.identity),
    })),
    open_url: view.openUrl?.url ?? null,
    open_url_host: view.openUrl?.host ?? null,
    sessions: view.sessions.map((entry) => ({
      name: entry.name,
      backend: entry.backend,
      source: entry.source,
      attached: entry.attached,
      path: entry.path,
      windows: entry.windows,
      created_at: entry.createdAt,
    })),
    worktrees: view.worktrees
      ? view.worktrees.map((entry) => ({
          path: entry.path,
          branch: entry.branch,
          last_seen_at: entry.lastSeenAt,
        }))
      : null,
    lifecycle: view.lifecycle
      ? {
          up_before: view.lifecycle.upBefore.map((entry) => ({
            name: entry.name,
            command: entry.command,
            cwd: entry.cwd,
            service: entry.service,
            ...(entry.persistent === true ? { persistent: true } : {}),
          })),
          up_after: view.lifecycle.upAfter.map((entry) => ({
            name: entry.name,
            command: entry.command,
            cwd: entry.cwd,
            service: entry.service,
            ...(entry.persistent === true ? { persistent: true } : {}),
          })),
          down_before: view.lifecycle.downBefore.map((entry) => ({
            name: entry.name,
            command: entry.command,
            cwd: entry.cwd,
            service: entry.service,
            ...(entry.persistent === true ? { persistent: true } : {}),
          })),
          down_after: view.lifecycle.downAfter.map((entry) => ({
            name: entry.name,
            command: entry.command,
            cwd: entry.cwd,
            service: entry.service,
            ...(entry.persistent === true ? { persistent: true } : {}),
          })),
          processes: view.lifecycle.processes.map((entry) => ({
            name: entry.name,
            command: entry.command,
            cwd: entry.cwd,
            service: entry.service,
          })),
        }
      : null,
    kind: view.kind,
    status: view.status,
  };
}

async function readRegisteredProjectConfig(opts: {
  readonly registration: RegisteredProject;
}): Promise<ProjectConfig> {
  return await readProjectConfig({
    projectRoot: opts.registration.repoRoot,
    projectDirName: opts.registration.projectDirName,
    projectDir: opts.registration.projectDir,
    composeFile: resolve(
      opts.registration.projectDir,
      PROJECT_COMPOSE_FILENAME
    ),
    envFile: resolve(opts.registration.projectDir, PROJECT_ENV_FILENAME),
    configFile: resolve(opts.registration.projectDir, PROJECT_CONFIG_FILENAME),
  });
}

function resolveProjectLifecycleView(opts: {
  readonly config: ProjectConfig | null;
}): ProjectLifecycleView | null {
  const lifecycle = opts.config?.lifecycle;
  if (!lifecycle) {
    return null;
  }

  const upBefore = mapLifecycleCommandView({
    commands: lifecycle.up?.before,
  });
  const upAfter = mapLifecycleCommandView({
    commands: lifecycle.up?.after,
  });
  const downBefore = mapLifecycleCommandView({
    commands: lifecycle.down?.before,
  });
  const downAfter = mapLifecycleCommandView({
    commands: lifecycle.down?.after,
  });
  const processes = mapLifecycleProcessView({
    processes: lifecycle.processes,
  });

  const hasEntries =
    upBefore.length > 0 ||
    upAfter.length > 0 ||
    downBefore.length > 0 ||
    downAfter.length > 0 ||
    processes.length > 0;
  if (!hasEntries) {
    return null;
  }

  return {
    upBefore,
    upAfter,
    downBefore,
    downAfter,
    processes,
  };
}

function mapLifecycleCommandView(opts: {
  readonly commands: readonly ProjectLifecycleCommand[] | undefined;
}): readonly ProjectLifecycleCommandView[] {
  const commands = opts.commands ?? [];
  return commands.map((command, index) => ({
    name: command.name ?? null,
    command: command.command,
    cwd: command.cwd ?? null,
    service: resolveLifecycleCommandService({
      command,
      index,
    }),
    ...(command.persistent === true ? { persistent: true } : {}),
  }));
}

function mapLifecycleProcessView(opts: {
  readonly processes: readonly ProjectLifecycleProcess[] | undefined;
}): readonly ProjectLifecycleProcessView[] {
  const processes = opts.processes ?? [];
  return processes.map((process) => ({
    name: process.name,
    command: process.command,
    cwd: process.cwd ?? null,
    service: process.name,
  }));
}

function resolveLifecycleCommandService(opts: {
  readonly command: ProjectLifecycleCommand;
  readonly index: number;
}): string {
  const fromName = (opts.command.name ?? "").trim();
  if (fromName.length > 0) {
    return fromName;
  }
  return `hook-${opts.index + 1}`;
}

async function collectBranchRuntime(opts: {
  readonly registration: RegisteredProject;
  readonly verifiedRoots: ReadonlySet<string>;
  readonly baseName: string | null;
  readonly primaryRuntime: RuntimeProject | null;
  readonly runtimeProjects: readonly RuntimeProject[];
  readonly checkoutComposeName: CheckoutComposeName;
}): Promise<readonly BranchRuntime[]> {
  const out: BranchRuntime[] = [];
  for (const runtime of opts.runtimeProjects) {
    if (runtime === opts.primaryRuntime || !runtime.project.includes("--")) {
      continue;
    }
    const checkout = resolveOwningCheckout({
      registration: opts.registration,
      workingDir: runtime.workingDir,
    });
    let baseName = opts.baseName;
    const checkoutVerified = checkout
      ? isCurrentCheckout(checkout, opts.verifiedRoots)
      : false;
    if (checkout?.kind === "worktree" && checkoutVerified) {
      const project = checkoutContext({ ...opts, checkout });
      baseName = await opts.checkoutComposeName({ project, forBranch: true });
    }
    // The registered slug is the legacy match for observations without a
    // checkout. Configured Compose names can be shared by unrelated projects.
    const matchBase = checkout ? (baseName ?? opts.baseName) : null;
    const legacyPrefix = `${opts.registration.name}--`;
    const matchedPrefix = (
      matchBase ? [`${matchBase}--`, legacyPrefix] : [legacyPrefix]
    )
      .sort((a, b) => b.length - a.length)
      .find((candidate) => runtime.project.startsWith(candidate));
    if (matchedPrefix && runtime.project !== baseName) {
      const branch = runtime.project.slice(matchedPrefix.length);
      if (branch) {
        out.push({
          branch,
          runtime,
          checkoutVerified,
          composeProjectUnresolved: checkoutVerified && baseName === null,
          ...(checkoutVerified && baseName
            ? { composeProject: `${baseName}--${branch}` }
            : {}),
        });
      }
    }
  }
  return out;
}

function collectProjectSessions(opts: {
  readonly projectName: string;
  readonly repoRoot: string;
  readonly muxSessions: readonly MuxSession[];
}): readonly ProjectSession[] {
  const projectRoot = canonicalPath(opts.repoRoot);
  const out: ProjectSession[] = [];

  for (const session of opts.muxSessions) {
    if (
      !isSessionForProject({
        sessionName: session.name,
        sessionPath: session.path,
        projectName: opts.projectName,
        projectRoot,
      })
    ) {
      continue;
    }

    out.push({
      name: session.name,
      backend: session.backend,
      source: classifySessionSource({
        sessionName: session.name,
        projectName: opts.projectName,
      }),
      attached: session.attached,
      path: session.path,
      windows: session.windows,
      createdAt: session.createdAt,
    });
  }

  return out.sort((a, b) => {
    if (a.source !== b.source) {
      return a.source === "hack" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

function classifySessionSource(opts: {
  readonly sessionName: string;
  readonly projectName: string;
}): "hack" | "external" {
  if (matchesHackSessionName(opts)) {
    return "hack";
  }
  return "external";
}

function isSessionForProject(opts: {
  readonly sessionName: string;
  readonly sessionPath: string | null;
  readonly projectName: string;
  readonly projectRoot: string;
}): boolean {
  if (
    matchesHackSessionName({
      sessionName: opts.sessionName,
      projectName: opts.projectName,
    })
  ) {
    return true;
  }

  if (!opts.sessionPath) {
    return false;
  }
  const sessionPath = canonicalPath(opts.sessionPath);
  return (
    sessionPath === opts.projectRoot ||
    sessionPath.startsWith(`${opts.projectRoot}/`)
  );
}

function matchesHackSessionName(opts: {
  readonly sessionName: string;
  readonly projectName: string;
}): boolean {
  const normalizedProject = normalizeSessionToken(opts.projectName);
  const primaryBase = parseSessionBase({ name: opts.sessionName });
  const legacyBase = opts.sessionName.split(":")[0] ?? "";
  const normalizedBases = [primaryBase, legacyBase]
    .map((value) => normalizeSessionToken(value))
    .filter((value) => value.length > 0);
  if (normalizedProject.length === 0 || normalizedBases.length === 0) {
    return false;
  }
  return (
    opts.sessionName === opts.projectName ||
    opts.sessionName.startsWith(`${opts.projectName}--`) ||
    opts.sessionName.startsWith(`${opts.projectName}:`) ||
    normalizedBases.includes(normalizedProject)
  );
}

function normalizeSessionToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
}

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

async function listMuxSessions(): Promise<readonly MuxSession[]> {
  return await listTmuxSessions();
}

async function listTmuxSessions(): Promise<readonly MuxSession[]> {
  if (!findExecutableInPath("tmux")) {
    return [];
  }

  const separator = "|||HACK_SESSION_FIELD|||";
  const format = [
    "#{session_name}",
    "#{session_attached}",
    "#{session_path}",
    "#{session_windows}",
    "#{session_created}",
  ].join(separator);
  let result: Awaited<ReturnType<typeof exec>>;
  try {
    result = await exec(["tmux", "list-sessions", "-F", format], {
      stdin: "ignore",
    });
  } catch {
    return [];
  }
  if (result.exitCode !== 0) {
    return [];
  }

  const out: MuxSession[] = [];
  const lines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const fields = parseTmuxSessionFields(line, separator, 5);
    if (!fields) {
      continue;
    }
    const [name, attachedRaw, pathRaw, windowsRaw, createdAtRaw] = fields;
    if (!name) {
      continue;
    }
    const windows = windowsRaw ? Number.parseInt(windowsRaw, 10) : Number.NaN;
    const createdAt = createdAtRaw
      ? Number.parseInt(createdAtRaw, 10)
      : Number.NaN;
    out.push({
      name,
      backend: "tmux",
      attached: attachedRaw === "1",
      path: pathRaw && pathRaw.length > 0 ? pathRaw : null,
      windows: Number.isFinite(windows) ? windows : null,
      createdAt: Number.isFinite(createdAt) ? createdAt : null,
    });
  }
  return out;
}

function parseTmuxSessionFields(
  line: string,
  separator: string,
  expectedCount: number
): readonly string[] | null {
  const bySeparator = line.split(separator);
  if (bySeparator.length === expectedCount) {
    return bySeparator;
  }
  const byTab = line.split("\t");
  if (byTab.length === expectedCount) {
    return byTab;
  }
  return null;
}

async function readComposeServices(opts: {
  readonly composeFile: string;
}): Promise<{
  name: string | null;
  names: readonly string[];
  readiness: Readonly<Record<string, ServiceReadiness>>;
  activation: ComposeServiceActivation;
} | null> {
  const text = await readTextFile(opts.composeFile);
  if (!text) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }

  const servicesRaw = parsed.services;
  return {
    name: typeof parsed.name === "string" ? parsed.name : null,
    names: isRecord(servicesRaw)
      ? Object.keys(servicesRaw).sort((a, b) => a.localeCompare(b))
      : [],
    readiness: composeServiceReadiness(parsed),
    activation: composeServiceActivation(parsed),
  };
}

const COMPOSE_SITE_LABEL = /^caddy(?:_\d+)?$/;
const COMPOSE_SITE_SEPARATORS = /[\s,]+/;

/**
 * Every root Caddy site label (`caddy`, `caddy_<n>`) per service in a Compose
 * file, as comma-split entries. Unlike {@link readComposeServiceHosts}, which
 * keeps the published `service_hosts` shape, numbered site labels count.
 */
async function readComposeSiteLabelHosts(opts: {
  readonly composeFile: string;
}): Promise<Readonly<Record<string, readonly string[]>> | null> {
  const text = await readTextFile(opts.composeFile);
  if (!text) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch {
    return null;
  }
  const services = isRecord(parsed) ? parsed.services : null;
  if (!isRecord(services)) {
    return null;
  }
  const out: Record<string, readonly string[]> = {};
  for (const [serviceName, service] of Object.entries(services)) {
    const labels = isRecord(service) ? service.labels : null;
    const entries: string[] = [];
    for (const [key, value] of composeLabelEntries(labels)) {
      // A templated site address names no concrete host (and may hold spaces).
      if (COMPOSE_SITE_LABEL.test(key) && !value.includes("{{")) {
        // Whitespace separates sites too, as native branch routing accepts.
        entries.push(...value.split(COMPOSE_SITE_SEPARATORS).filter(Boolean));
      }
    }
    if (entries.length > 0) {
      out[serviceName] = entries;
    }
  }
  return out;
}

/** Key/value pairs of Compose labels in map or `KEY=value` list form. */
function composeLabelEntries(labels: unknown): [string, string][] {
  if (isRecord(labels)) {
    return Object.entries(labels).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    );
  }
  if (!Array.isArray(labels)) {
    return [];
  }
  const out: [string, string][] = [];
  for (const entry of labels) {
    if (typeof entry !== "string") {
      continue;
    }
    const separator = entry.indexOf("=");
    if (separator > 0) {
      out.push([
        entry.slice(0, separator).trim(),
        entry.slice(separator + 1).trim(),
      ]);
    }
  }
  return out;
}

async function readComposeServiceHosts(opts: {
  readonly composeFile: string;
}): Promise<Readonly<Record<string, readonly string[]>> | null> {
  const text = await readTextFile(opts.composeFile);
  if (!text) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }

  const servicesRaw = parsed.services;
  if (!isRecord(servicesRaw)) {
    return null;
  }

  const out: Record<string, readonly string[]> = {};
  for (const [serviceName, serviceRaw] of Object.entries(servicesRaw)) {
    if (!isRecord(serviceRaw)) {
      continue;
    }
    const labels = serviceRaw.labels;
    const caddyLabel = extractLabelValue(labels, "caddy");
    if (!caddyLabel) {
      continue;
    }
    const hosts = caddyLabel
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (hosts.length > 0) {
      out[serviceName] = hosts;
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}

function extractLabelValue(labels: unknown, key: string): string | null {
  if (isRecord(labels)) {
    const value = labels[key];
    return typeof value === "string" ? value : null;
  }
  if (Array.isArray(labels)) {
    for (const entry of labels) {
      if (typeof entry !== "string") {
        continue;
      }
      const [k, ...rest] = entry.split("=");
      if (!k) {
        continue;
      }
      if (k.trim() === key) {
        const value = rest.join("=").trim();
        if (value.length > 0) {
          return value;
        }
      }
    }
  }
  return null;
}

async function resolveProjectExtensions(opts: {
  readonly projectDir: string;
}): Promise<{
  readonly enabled: readonly string[];
  readonly features: readonly string[];
}> {
  const { config } = await readControlPlaneConfig({
    projectDir: opts.projectDir,
  });
  const enabled = Object.entries(config.extensions)
    .filter(([, value]) => value.enabled)
    .map(([key]) => key)
    .filter((id) => !RETIRED_EXTENSION_IDS.has(id))
    .sort((a, b) => a.localeCompare(b));
  const features = enabled
    .map((id) => mapExtensionFeature(id))
    .filter((value): value is string => value !== null)
    .sort((a, b) => a.localeCompare(b));
  return { enabled, features };
}

const RETIRED_EXTENSION_IDS: ReadonlySet<string> = new Set([
  "dance.hack.github",
  "dance.hack.linear",
  "dance.hack.tickets",
]);

function mapExtensionFeature(id: string): string | null {
  switch (id) {
    case "dance.hack.cloudflare":
      return "cloudflare";
    case "dance.hack.railway":
      return "railway";
    case "dance.hack.tailscale":
      return "tailscale";
    default:
      return id;
  }
}

/**
 * Resolves the runtime status for a registered project.
 */
function resolveRuntimeStatus(opts: {
  readonly projectDirOk: boolean;
  readonly composeExists: boolean;
  readonly runtimeOk: boolean;
  readonly running: number;
}): ProjectRuntimeStatus {
  if (!opts.projectDirOk) {
    return "missing";
  }
  if (!opts.composeExists) {
    return "not_configured";
  }
  if (!opts.runtimeOk) {
    return "unknown";
  }
  if (opts.running > 0) {
    return "running";
  }
  return "stopped";
}

/**
 * Resolves the project status for a registered project.
 */
function resolveProjectStatus(opts: {
  readonly projectDirOk: boolean;
  readonly runtimeOk: boolean;
  readonly running: number;
}): ProjectView["status"] {
  if (!opts.projectDirOk) {
    return "missing";
  }
  if (!opts.runtimeOk) {
    return "unknown";
  }
  if (opts.running > 0) {
    return "running";
  }
  return "stopped";
}

/**
 * Resolves the runtime status for an unregistered project.
 */
function resolveUnregisteredRuntimeStatus(opts: {
  readonly runtimeOk: boolean;
  readonly running: number;
}): ProjectRuntimeStatus {
  if (!opts.runtimeOk) {
    return "unknown";
  }
  if (opts.running > 0) {
    return "running";
  }
  return "stopped";
}
