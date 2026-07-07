import { createHash } from "node:crypto";
import { open, realpath, rename, stat, unlink } from "node:fs/promises";
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
  resolveGitRepositoryIdentity,
} from "./git-worktree.ts";
import { getString, isRecord } from "./guards.ts";
import type { ProjectContext, ProjectDirName } from "./project.ts";
import { defaultProjectSlugFromPath, readProjectConfig } from "./project.ts";

const REGISTRY_VERSION = 1 as const;
const REGISTRY_LOCK_FILENAME = `${GLOBAL_PROJECTS_REGISTRY_FILENAME}.lock`;
const REGISTRY_LOCK_TIMEOUT_MS = 2000;
const REGISTRY_LOCK_STALE_MS = 30_000;
const REGISTRY_LOCK_RETRY_MS = 50;

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

export async function readProjectsRegistry(): Promise<ProjectsRegistry> {
  const path = getRegistryPath();
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
}): Promise<RegisterOutcome> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const registryPath = getRegistryPath();
  const registryDir = dirname(registryPath);
  await ensureDir(registryDir);

  const [repoRootReal, projectDirReal] = await Promise.all([
    tryRealpath(opts.project.projectRoot),
    tryRealpath(opts.project.projectDir),
  ]);
  const repoIdentity = await resolveGitRepositoryIdentity({
    repoRoot: repoRootReal,
  });

  const cfg = await readProjectConfig(opts.project);
  const derivedName = defaultProjectSlugFromPath(repoRootReal);
  const name = sanitizeProjectName(cfg.name ?? derivedName);
  const devHost = cfg.devHost?.trim();
  const gitBranch = await resolveGitCurrentBranch({ repoRoot: repoRootReal });

  return await withRegistryLock(async () => {
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
        await writeRegistryAtomic(registryPath, {
          version: REGISTRY_VERSION,
          projects: status.projects,
        });
      }
      return { status: "noop", project };
    }

    await writeRegistryAtomic(registryPath, {
      version: REGISTRY_VERSION,
      projects: status.projects,
    });

    return { status: status.status, project };
  });
}

export async function resolveRegisteredProjectByName(opts: {
  readonly name: string;
}): Promise<ProjectContext | null> {
  const name = sanitizeProjectName(opts.name);
  const registry = await readProjectsRegistry();
  const match = registry.projects.find((p) => p.name === name) ?? null;
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
}): Promise<{ readonly removed: readonly RegisteredProject[] }> {
  if (opts.ids.length === 0) {
    return { removed: [] };
  }
  const removeIds = new Set(opts.ids);
  return await withRegistryLock(async () => {
    const current = await readProjectsRegistry();
    const removed = current.projects.filter((p) => removeIds.has(p.id));
    if (removed.length === 0) {
      return { removed: [] };
    }

    const next = current.projects.filter((p) => !removeIds.has(p.id));
    await writeRegistryAtomic(getRegistryPath(), {
      version: REGISTRY_VERSION,
      projects: next,
    });
    return { removed };
  });
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
    name: sanitizeProjectName(name),
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
  registry: ProjectsRegistry
): Promise<void> {
  const json = `${JSON.stringify(registry, null, 2)}\n`;
  const tmp = `${path}.tmp`;
  await Bun.write(tmp, json);
  await rename(tmp, path);
}

async function tryRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function withRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
  await acquireRegistryLock();
  try {
    return await fn();
  } finally {
    await releaseRegistryLock();
  }
}

async function acquireRegistryLock(): Promise<void> {
  const lockPath = getRegistryLockPath();
  const start = Date.now();

  while (true) {
    try {
      const file = await open(lockPath, "wx");
      await file.writeFile(`${process.pid}\n`);
      await file.close();
      return;
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: string }).code
          : undefined;
      if (code !== "EEXIST") {
        throw error;
      }
      if (await isLockStale(lockPath)) {
        // biome-ignore lint/suspicious/noEmptyBlockStatements: best-effort stale lock cleanup
        await unlink(lockPath).catch(() => {});
        continue;
      }
      if (Date.now() - start > REGISTRY_LOCK_TIMEOUT_MS) {
        throw new Error("Timed out waiting for projects registry lock");
      }
      await sleep(REGISTRY_LOCK_RETRY_MS);
    }
  }
}

async function releaseRegistryLock(): Promise<void> {
  const lockPath = getRegistryLockPath();
  // biome-ignore lint/suspicious/noEmptyBlockStatements: lock release is best-effort
  await unlink(lockPath).catch(() => {});
}

async function isLockStale(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs > REGISTRY_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeProjectName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return "project";
  }
  return trimmed.toLowerCase();
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

  const byName = new Map(current.map((p) => [p.name, p] as const));
  const byDir = new Map(current.map((p) => [p.projectDir, p] as const));

  const existingByDir = byDir.get(incoming.projectDir) ?? null;
  const existingByName = byName.get(incoming.name) ?? null;

  // 1) Same directory already registered → update name/devHost/lastSeen.
  if (existingByDir) {
    if (
      existingByDir.name !== incoming.name &&
      existingByName &&
      !isSameProject(existingByName, incoming)
    ) {
      return {
        project: existingByDir,
        status: {
          status: "conflict",
          conflictName: incoming.name,
          existing: existingByName,
          incoming: {
            name: incoming.name,
            projectDir: incoming.projectDir,
            repoRoot: incoming.repoRoot,
          },
        },
      };
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

  // 2) Name already registered → either move (old path missing) or conflict.
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
      if (nextWorktrees === existingByName.worktrees) {
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

    if (!oldMissing) {
      return {
        project: existingByName,
        status: {
          status: "conflict",
          conflictName: incoming.name,
          existing: existingByName,
          incoming: {
            name: incoming.name,
            projectDir: incoming.projectDir,
            repoRoot: incoming.repoRoot,
          },
        },
      };
    }

    const moved: RegisteredProject = {
      ...existingByName,
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
