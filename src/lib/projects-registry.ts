import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  GLOBAL_PROJECTS_REGISTRY_FILENAME,
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_FILENAME,
} from "../constants.ts";
import { resolveGlobalHackDir } from "./config-paths.ts";
import { ensureDir, pathExists, readTextFile } from "./fs.ts";
import {
  resolveGitCurrentBranch,
  resolveGitRegistrationMetadata,
  resolveGitRepositoryIdentity,
} from "./git-worktree.ts";
import { getString, isRecord } from "./guards.ts";
import type { ProjectContext, ProjectDirName } from "./project.ts";
import { defaultProjectSlugFromPath, readProjectConfig } from "./project.ts";
import {
  AmbiguousProjectNameError,
  normalizeProjectName,
} from "./project-name.ts";
import {
  deferIfProjectsRegistryBusy,
  withProjectsRegistryLock,
  writeProjectsRegistryAtomic,
} from "./projects-registry-lock.ts";

const REGISTRY_VERSION = 1 as const;
const REGISTRY_LOCK_FILENAME = `${GLOBAL_PROJECTS_REGISTRY_FILENAME}.lock`;
const REGISTRY_TOUCH_INTERVAL_MS = 60_000;

export interface RegisteredProjectWorktree {
  readonly path: string;
  readonly branch: string | null;
  readonly lastSeenAt: string;
}

export interface RegisteredProject {
  readonly id: string;
  readonly name: string;
  readonly repoRoot: string;
  readonly projectDirName: ProjectDirName;
  readonly projectDir: string;
  readonly devHost?: string;
  readonly createdAt: string;
  readonly lastSeenAt?: string;
  /** Linked git worktree checkouts of this project seen by the CLI (additive; absent in older registries). */
  readonly worktrees?: readonly RegisteredProjectWorktree[];
}

export interface ProjectsRegistry {
  readonly version: typeof REGISTRY_VERSION;
  readonly projects: readonly RegisteredProject[];
}

export type RegisterOutcome =
  | { readonly status: "created"; readonly project: RegisteredProject }
  | { readonly status: "updated"; readonly project: RegisteredProject }
  | { readonly status: "noop"; readonly project: RegisteredProject }
  | {
      readonly status: "conflict";
      readonly conflictName: string;
      readonly existing: RegisteredProject;
      readonly incoming: Pick<
        RegisteredProject,
        "name" | "projectDir" | "repoRoot"
      >;
    };

/** Read an explicit session registry without changing process-wide environment. */
export async function readProjectsRegistry(opts?: {
  readonly registryPath?: string;
}): Promise<ProjectsRegistry> {
  const path = opts?.registryPath ?? getRegistryPath();
  const text = await readTextFile(path);
  if (!text) {
    return { version: REGISTRY_VERSION, projects: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { version: REGISTRY_VERSION, projects: [] };
  }

  const out = parseRegistry(parsed);
  return out ?? { version: REGISTRY_VERSION, projects: [] };
}

export async function upsertProjectRegistration(opts: {
  readonly project: ProjectContext;
  readonly nowIso?: string;
  /** Optional maintenance may abandon a busy lock without waiting or reclaiming it. */
  readonly waitForLock?: boolean;
  readonly signal?: AbortSignal;
}): Promise<RegisterOutcome> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const registryPath = getRegistryPath();
  const registryDir = dirname(registryPath);
  if (opts.waitForLock === false) {
    // Skip Git and configuration discovery for an already-busy optional upsert.
    // The late check and atomic publication still arbitrate later arrivals.
    await deferIfProjectsRegistryBusy({
      lockPath: getRegistryLockPath(),
      signal: opts.signal,
    });
  }
  await ensureDir(registryDir);

  const [repoRootReal, projectDirReal] = await Promise.all([
    tryRealpath(opts.project.projectRoot),
    tryRealpath(opts.project.projectDir),
  ]);
  const { repoIdentity, gitBranch } = await resolveGitRegistrationMetadata({
    repoRoot: repoRootReal,
  });

  const cfg = await readProjectConfig(opts.project);
  const derivedName = defaultProjectSlugFromPath(repoRootReal);
  const name = requireProjectName(cfg.name ?? derivedName);
  const devHost = cfg.devHost?.trim();

  return await withRegistryLock(
    async () => {
      const current = await readProjectsRegistry();
      const { project, status } = await upsertInMemory({
        current,
        nowIso,
        incoming: {
          name,
          devHost,
          repoRoot: repoRootReal,
          repoIdentity,
          gitBranch,
          projectDirName: opts.project.projectDirName,
          projectDir: projectDirReal,
        },
      });

      if (status.status === "conflict") {
        return status;
      }
      if (status.status === "noop") {
        if (status.changed) {
          await writeRegistryAtomic(
            registryPath,
            {
              version: REGISTRY_VERSION,
              projects: status.projects,
            },
            opts.signal
          );
        }
        return { status: "noop", project };
      }

      await writeRegistryAtomic(
        registryPath,
        {
          version: REGISTRY_VERSION,
          projects: status.projects,
        },
        opts.signal
      );

      return { status: status.status, project };
    },
    { waitForLock: opts.waitForLock, signal: opts.signal }
  );
}

/**
 * Best-effort registry touch for read-style commands (e.g. `hack projects`).
 *
 * Coalesces unchanged observations for one minute. New or changed checkouts
 * use the normal serialized upsert, but never wait for or reclaim a busy lock.
 * Registry maintenance must not delay or break a read command.
 *
 * @returns The registration outcome, or null when the touch failed.
 */
export async function touchProjectRegistration(opts: {
  readonly project: ProjectContext;
  readonly nowIso?: string;
}): Promise<RegisterOutcome | null> {
  try {
    const nowIso = opts.nowIso ?? new Date().toISOString();
    const fresh = await readFreshRegistration({
      project: opts.project,
      nowIso,
    });
    if (fresh) {
      return { status: "noop", project: fresh };
    }
    return await upsertProjectRegistration({
      project: opts.project,
      nowIso,
      waitForLock: false,
    });
  } catch {
    return null;
  }
}

/** A read-only freshness optimization; mutation decisions still run under the lock. */
async function readFreshRegistration(opts: {
  readonly project: ProjectContext;
  readonly nowIso: string;
}): Promise<RegisteredProject | null> {
  const [registry, cfg, projectDir, repoRoot] = await Promise.all([
    readProjectsRegistry(),
    readProjectConfig(opts.project),
    tryRealpath(opts.project.projectDir),
    tryRealpath(opts.project.projectRoot),
  ]);
  const name = requireProjectName(
    cfg.name ?? defaultProjectSlugFromPath(repoRoot)
  );
  const matches = matchingNames(registry.projects, name);
  if (matches.length !== 1) {
    return null;
  }
  for (const entry of matches) {
    if (
      entry.name !== name ||
      entry.devHost !== cfg.devHost?.trim() ||
      entry.projectDirName !== opts.project.projectDirName
    ) {
      continue;
    }
    const primary =
      entry.projectDir === projectDir && entry.repoRoot === repoRoot;
    const worktree = primary
      ? undefined
      : entry.worktrees?.find((item) => item.path === repoRoot);
    const lastSeen = primary ? entry.lastSeenAt : worktree?.lastSeenAt;
    const age = Date.parse(opts.nowIso) - Date.parse(lastSeen ?? "");
    if (!(age >= 0 && age < REGISTRY_TOUCH_INTERVAL_MS)) {
      continue;
    }
    if (primary) {
      return entry;
    }
    if (
      worktree &&
      worktree.branch === (await resolveGitCurrentBranch({ repoRoot })) &&
      (await isSameRepositoryFamily({
        existingRepoRoot: entry.repoRoot,
        incomingRepoIdentity: await resolveGitRepositoryIdentity({ repoRoot }),
      }))
    ) {
      return entry;
    }
  }
  return null;
}

export async function resolveRegisteredProjectByName(opts: {
  readonly registryPath?: string;
  readonly name: string;
}): Promise<ProjectContext | null> {
  const name = normalizeProjectName(opts.name);
  if (!name) {
    return null;
  }
  const registry = await readProjectsRegistry({
    registryPath: opts.registryPath,
  });
  const match = selectRegisteredProjectByName({
    projects: registry.projects,
    name,
  });
  if (!match) {
    return null;
  }

  if (!(await pathExists(match.projectDir))) {
    return null;
  }

  const composeFile = resolve(match.projectDir, PROJECT_COMPOSE_FILENAME);
  const configFile = resolve(match.projectDir, PROJECT_CONFIG_FILENAME);
  const envFile = resolve(match.projectDir, PROJECT_ENV_FILENAME);

  if (!(await pathExists(composeFile))) {
    return null;
  }

  return {
    projectRoot: match.repoRoot,
    projectDirName: match.projectDirName,
    projectDir: match.projectDir,
    composeFile,
    envFile,
    configFile,
  };
}

/** Select one canonical name/legacy alias without filtering out stale contenders. */
export function selectRegisteredProjectByName(opts: {
  readonly projects: readonly RegisteredProject[];
  readonly name: string;
}): RegisteredProject | null {
  const name = normalizeProjectName(opts.name);
  if (!name) {
    return null;
  }
  const matches = matchingNames(opts.projects, name);
  if (matches.length > 1) {
    throw new AmbiguousProjectNameError(name);
  }
  return matches[0] ?? null;
}

export async function resolveRegisteredProjectById(opts: {
  readonly id: string;
}): Promise<{
  readonly project: ProjectContext;
  readonly registration: RegisteredProject;
} | null> {
  const registry = await readProjectsRegistry();
  const match = registry.projects.find((p) => p.id === opts.id) ?? null;
  if (!match) {
    return null;
  }

  if (!(await pathExists(match.projectDir))) {
    return null;
  }

  const composeFile = resolve(match.projectDir, PROJECT_COMPOSE_FILENAME);
  const configFile = resolve(match.projectDir, PROJECT_CONFIG_FILENAME);
  const envFile = resolve(match.projectDir, PROJECT_ENV_FILENAME);

  if (!(await pathExists(composeFile))) {
    return null;
  }

  return {
    registration: match,
    project: {
      projectRoot: match.repoRoot,
      projectDirName: match.projectDirName,
      projectDir: match.projectDir,
      composeFile,
      envFile,
      configFile,
    },
  };
}

export async function removeProjectsById(opts: {
  readonly ids: readonly string[];
  readonly signal?: AbortSignal;
}): Promise<{ readonly removed: readonly RegisteredProject[] }> {
  if (opts.ids.length === 0) {
    return { removed: [] };
  }
  const removeIds = new Set(opts.ids);
  return await withRegistryLock(
    async () => {
      const current = await readProjectsRegistry();
      const removed = current.projects.filter((p) => removeIds.has(p.id));
      if (removed.length === 0) {
        return { removed: [] };
      }

      const next = current.projects.filter((p) => !removeIds.has(p.id));
      await writeRegistryAtomic(
        getRegistryPath(),
        {
          version: REGISTRY_VERSION,
          projects: next,
        },
        opts.signal
      );
      return { removed };
    },
    { signal: opts.signal }
  );
}

export type DeadProjectRegistration = {
  readonly project: RegisteredProject;
  readonly reason: "missing repo root";
};

/**
 * Find registry entries whose `repoRoot` no longer exists on disk (e.g.
 * deleted checkouts or stale temp-dir test projects).
 *
 * Detection only — pair with {@link removeProjectsById} to prune, so callers
 * can show candidates and confirm before mutating the registry.
 */
export async function findDeadProjectRegistrations(opts: {
  readonly projects: readonly RegisteredProject[];
}): Promise<DeadProjectRegistration[]> {
  const checks = await Promise.all(
    opts.projects.map((project) => pathExists(project.repoRoot))
  );
  return opts.projects
    .filter((_, index) => checks[index] === false)
    .map((project) => ({ project, reason: "missing repo root" as const }));
}

function parseRegistry(value: unknown): ProjectsRegistry | null {
  if (!isRecord(value)) {
    return null;
  }
  const versionRaw = value.version;
  const version = typeof versionRaw === "number" ? versionRaw : null;
  if (version !== REGISTRY_VERSION) {
    return null;
  }

  const projectsRaw = value.projects;
  if (!Array.isArray(projectsRaw)) {
    return null;
  }

  const projects: RegisteredProject[] = [];
  for (const item of projectsRaw) {
    const p = parseProject(item);
    if (p) {
      projects.push(p);
    }
  }

  return { version: REGISTRY_VERSION, projects };
}

function parseProject(value: unknown): RegisteredProject | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = getString(value, "id");
  const name = getString(value, "name");
  const repoRoot = getString(value, "repoRoot");
  const projectDirName = getString(value, "projectDirName");
  const projectDir = getString(value, "projectDir");
  const createdAt = getString(value, "createdAt");
  if (!(id && name && repoRoot && projectDirName && projectDir && createdAt)) {
    return null;
  }
  if (projectDirName !== ".hack" && projectDirName !== ".dev") {
    return null;
  }

  const devHost = getString(value, "devHost") ?? undefined;
  const lastSeenAt = getString(value, "lastSeenAt") ?? undefined;
  const worktrees = parseWorktrees(value.worktrees);

  return {
    id,
    // Preserve the legacy spelling until an unambiguous owned upsert migrates it.
    name: name.trim().toLowerCase(),
    repoRoot,
    projectDirName,
    projectDir,
    ...(devHost ? { devHost } : {}),
    createdAt,
    ...(lastSeenAt ? { lastSeenAt } : {}),
    ...(worktrees.length > 0 ? { worktrees } : {}),
  };
}

function parseWorktrees(value: unknown): readonly RegisteredProjectWorktree[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const out: RegisteredProjectWorktree[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const path = getString(item, "path");
    const lastSeenAt = getString(item, "lastSeenAt");
    if (!(path && lastSeenAt)) {
      continue;
    }
    const branch = getString(item, "branch") ?? null;
    out.push({ path, branch, lastSeenAt });
  }
  return out;
}

function resolveGlobalRegistryRoot(): string {
  const override = (process.env.HACK_GLOBAL_CONFIG_PATH ?? "").trim();
  if (override.length > 0) {
    return dirname(override);
  }
  return resolveGlobalHackDir();
}

function getRegistryPath(): string {
  return resolve(
    resolveGlobalRegistryRoot(),
    GLOBAL_PROJECTS_REGISTRY_FILENAME
  );
}

function getRegistryLockPath(): string {
  return resolve(resolveGlobalRegistryRoot(), REGISTRY_LOCK_FILENAME);
}

async function writeRegistryAtomic(
  path: string,
  registry: ProjectsRegistry,
  signal?: AbortSignal
): Promise<void> {
  await writeProjectsRegistryAtomic({
    path,
    text: `${JSON.stringify(registry, null, 2)}\n`,
    signal,
  });
}

async function tryRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function withRegistryLock<T>(
  fn: () => Promise<T>,
  opts?: { readonly waitForLock?: boolean; readonly signal?: AbortSignal }
): Promise<T> {
  const lockPath = getRegistryLockPath();
  await ensureDir(dirname(lockPath));
  return await withProjectsRegistryLock({ lockPath, run: fn, ...opts });
}

function requireProjectName(input: string): string {
  const name = normalizeProjectName(input);
  if (!name) {
    throw new Error(
      "Invalid project name: use a name containing letters or digits."
    );
  }
  return name;
}

function matchingNames(projects: readonly RegisteredProject[], name: string) {
  return projects.filter(
    (project) => normalizeProjectName(project.name) === name
  );
}

function registrationConflict(opts: {
  readonly existing: RegisteredProject;
  readonly incoming: Pick<
    RegisteredProject,
    "name" | "projectDir" | "repoRoot"
  >;
}) {
  return {
    project: opts.existing,
    status: {
      status: "conflict" as const,
      conflictName: opts.incoming.name,
      existing: opts.existing,
      incoming: {
        name: opts.incoming.name,
        projectDir: opts.incoming.projectDir,
        repoRoot: opts.incoming.repoRoot,
      },
    },
  };
}

function computeId(opts: {
  readonly name: string;
  readonly projectDir: string;
}): string {
  const sha = createHash("sha1")
    .update(`${opts.name}\n${opts.projectDir}`)
    .digest("hex");
  return sha.slice(0, 12);
}

function isSameProject(
  a: RegisteredProject,
  b: { readonly projectDir: string }
): boolean {
  return a.projectDir === b.projectDir;
}

function isPathLikelyMissing(path: string): Promise<boolean> {
  return pathExists(path).then((ok) => !ok);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Registry upsert keeps conflict, migration, and worktree-tracking rules explicit in one decision tree.
async function upsertInMemory(opts: {
  readonly current: ProjectsRegistry;
  readonly nowIso: string;
  readonly incoming: {
    readonly name: string;
    readonly devHost?: string;
    readonly repoRoot: string;
    readonly repoIdentity: string | null;
    readonly gitBranch: string | null;
    readonly projectDirName: ProjectDirName;
    readonly projectDir: string;
  };
}): Promise<{
  readonly project: RegisteredProject;
  readonly status:
    | {
        readonly status: "conflict";
        readonly conflictName: string;
        readonly existing: RegisteredProject;
        readonly incoming: Pick<
          RegisteredProject,
          "name" | "projectDir" | "repoRoot"
        >;
      }
    | {
        readonly status: "noop" | "updated";
        readonly projects: readonly RegisteredProject[];
        readonly changed?: boolean;
      }
    | {
        readonly status: "created";
        readonly projects: readonly RegisteredProject[];
      };
}> {
  const incoming = opts.incoming;
  const current = [...opts.current.projects];

  const byName = matchingNames(current, incoming.name);
  const byDir = current.filter((p) => p.projectDir === incoming.projectDir);
  const ambiguous = byName[1] ?? byDir[1];
  if (ambiguous) {
    return registrationConflict({ existing: ambiguous, incoming });
  }
  const existingByDir = byDir[0] ?? null;
  const existingByName = byName[0] ?? null;

  // 1) Same directory already registered → update name/devHost/lastSeen.
  if (existingByDir) {
    if (existingByName && !isSameProject(existingByName, incoming)) {
      return registrationConflict({ existing: existingByName, incoming });
    }

    const prunedWorktrees = await pruneWorktreeEntries(existingByDir.worktrees);
    const { worktrees: _staleWorktrees, ...existingBase } = existingByDir;
    const updated: RegisteredProject = {
      ...existingBase,
      name: incoming.name,
      repoRoot: incoming.repoRoot,
      projectDirName: incoming.projectDirName,
      ...(incoming.devHost ? { devHost: incoming.devHost } : {}),
      lastSeenAt: opts.nowIso,
      ...(prunedWorktrees && prunedWorktrees.length > 0
        ? { worktrees: prunedWorktrees }
        : {}),
    };
    return {
      project: updated,
      status: {
        status: shallowEqual(existingByDir, updated) ? "noop" : "updated",
        projects: replaceById(current, updated),
      },
    };
  }

  // 2) Only a proven Git worktree family may share or move a registered identity.
  if (existingByName) {
    const oldMissing = await isPathLikelyMissing(existingByName.projectDir);
    const sameRepositoryFamily = await isSameRepositoryFamily({
      existingRepoRoot: existingByName.repoRoot,
      incomingRepoIdentity: incoming.repoIdentity,
    });
    if (sameRepositoryFamily && !oldMissing) {
      const nextWorktrees = await mergeWorktreeEntry({
        worktrees: existingByName.worktrees,
        entry: {
          path: incoming.repoRoot,
          branch: incoming.gitBranch,
          lastSeenAt: opts.nowIso,
        },
      });
      if (
        nextWorktrees === existingByName.worktrees &&
        existingByName.name === incoming.name
      ) {
        return {
          project: existingByName,
          status: {
            status: "noop",
            projects: current,
          },
        };
      }

      const withWorktrees: RegisteredProject = {
        ...existingByName,
        name: incoming.name,
        ...(nextWorktrees && nextWorktrees.length > 0
          ? { worktrees: nextWorktrees }
          : {}),
      };
      return {
        project: withWorktrees,
        status: {
          status: "noop",
          projects: replaceById(current, withWorktrees),
          changed: true,
        },
      };
    }

    if (!(oldMissing && sameRepositoryFamily)) {
      return registrationConflict({ existing: existingByName, incoming });
    }

    const moved: RegisteredProject = {
      ...existingByName,
      name: incoming.name,
      repoRoot: incoming.repoRoot,
      projectDirName: incoming.projectDirName,
      projectDir: incoming.projectDir,
      ...(incoming.devHost ? { devHost: incoming.devHost } : {}),
      lastSeenAt: opts.nowIso,
    };
    return {
      project: moved,
      status: {
        status: "updated",
        projects: replaceById(current, moved),
      },
    };
  }

  // 3) New project.
  const created: RegisteredProject = {
    id: computeId({ name: incoming.name, projectDir: incoming.projectDir }),
    name: incoming.name,
    repoRoot: incoming.repoRoot,
    projectDirName: incoming.projectDirName,
    projectDir: incoming.projectDir,
    ...(incoming.devHost ? { devHost: incoming.devHost } : {}),
    createdAt: opts.nowIso,
    lastSeenAt: opts.nowIso,
  };

  return {
    project: created,
    status: { status: "created", projects: [...current, created] },
  };
}

/**
 * Removes worktree entries whose paths no longer exist.
 * Returns the input reference unchanged when nothing was pruned so callers
 * can cheaply detect "no change".
 */
async function pruneWorktreeEntries(
  worktrees: readonly RegisteredProjectWorktree[] | undefined
): Promise<readonly RegisteredProjectWorktree[] | undefined> {
  if (!worktrees || worktrees.length === 0) {
    return worktrees;
  }

  const checks = await Promise.all(
    worktrees.map((entry) => pathExists(entry.path))
  );
  if (checks.every((exists) => exists)) {
    return worktrees;
  }
  return worktrees.filter((_, index) => checks[index] === true);
}

/**
 * Upserts a sibling-checkout entry (deduped by realpath) into the worktrees
 * list and prunes entries whose paths no longer exist.
 * Returns the input reference unchanged when nothing changed.
 */
async function mergeWorktreeEntry(opts: {
  readonly worktrees: readonly RegisteredProjectWorktree[] | undefined;
  readonly entry: RegisteredProjectWorktree;
}): Promise<readonly RegisteredProjectWorktree[] | undefined> {
  const entryPath = await tryRealpath(opts.entry.path);
  const pruned = (await pruneWorktreeEntries(opts.worktrees)) ?? [];

  const existing = pruned.find((item) => item.path === entryPath) ?? null;
  if (
    existing &&
    existing.branch === opts.entry.branch &&
    existing.lastSeenAt === opts.entry.lastSeenAt &&
    pruned === opts.worktrees
  ) {
    return opts.worktrees;
  }

  const next = pruned.filter((item) => item.path !== entryPath);
  next.push({
    path: entryPath,
    branch: opts.entry.branch,
    lastSeenAt: opts.entry.lastSeenAt,
  });
  next.sort((a, b) => a.path.localeCompare(b.path));
  return next;
}

function replaceById(
  projects: readonly RegisteredProject[],
  replacement: RegisteredProject
): readonly RegisteredProject[] {
  return projects.map((p) => (p.id === replacement.id ? replacement : p));
}

function shallowEqual(a: RegisteredProject, b: RegisteredProject): boolean {
  const keys = Object.keys(a) as Array<keyof RegisteredProject>;
  for (const k of keys) {
    if (a[k] !== b[k]) {
      return false;
    }
  }
  return true;
}

async function isSameRepositoryFamily(opts: {
  readonly existingRepoRoot: string;
  readonly incomingRepoIdentity: string | null;
}): Promise<boolean> {
  if (!opts.incomingRepoIdentity) {
    return false;
  }

  const existingIdentity = await resolveGitRepositoryIdentity({
    repoRoot: opts.existingRepoRoot,
  });
  return (
    existingIdentity !== null && existingIdentity === opts.incomingRepoIdentity
  );
}
