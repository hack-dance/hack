import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { GLOBAL_PROJECTS_REGISTRY_FILENAME } from "../constants.ts";
import { HackCliError } from "./cli-result.ts";
import { resolveGlobalHackDir } from "./config-paths.ts";
import { ensureDir, pathExists } from "./fs.ts";
import {
  resolveGitCurrentBranch,
  resolveGitRegistrationMetadata,
  resolveGitRepositoryIdentity,
} from "./git-worktree.ts";
import { getString, isRecord } from "./guards.ts";
import type { ProjectContext, ProjectDirName } from "./project.ts";
import {
  defaultProjectSlugFromPath,
  findProjectContextAtRoot,
  readProjectConfig,
} from "./project.ts";
import {
  assertLegacyProjectDirectory,
  ProjectInputSelectionError,
} from "./project-input-selection.ts";
import {
  AmbiguousProjectNameError,
  normalizeProjectName,
} from "./project-name.ts";
import {
  deferIfProjectsRegistryBusy,
  withProjectsRegistryLock,
  writeProjectsRegistryAtomic,
} from "./projects-registry-lock.ts";
import {
  attachValueFreeDiagnostic,
  readValueFreeDiagnostic,
  valueFreeErrorDiagnostic,
} from "./value-free-diagnostic.ts";

const REGISTRY_VERSION = 1 as const;
const REGISTRY_LOCK_FILENAME = `${GLOBAL_PROJECTS_REGISTRY_FILENAME}.lock`;
const REGISTRY_TOUCH_INTERVAL_MS = 60_000;
const AUTOSTART_REGISTRY_LIMIT_BYTES = 16 * 1024 * 1024;
/** Progress records are bounded independently of the overall registry byte cap. */
export const AUTOSTART_LOGIN_PROJECT_LIMIT = 1000;
const AUTOSTART_PROJECT_ID_LIMIT = 128;

export interface RegisteredProjectWorktree {
  readonly path: string;
  readonly branch: string | null;
  readonly lastSeenAt: string;
}

/** Value-free result of the daemon's most recent startup attempt. */
export interface ProjectAutostartResult {
  readonly status: "started" | "skipped" | "failed" | "already_running";
  readonly reason: string | null;
  readonly at: string;
}

/** Machine-owned intent; repository configuration never creates this marker. */
export interface ProjectAutostart {
  readonly branch: string | null;
  readonly paused: boolean;
  readonly lastResult: ProjectAutostartResult | null;
  /** Persisted before starting: daemon replacement in the same boot cannot replay it. */
  readonly lastAttemptBootId: string | null;
  /** Invalid/future intent is visible but never eligible for automatic starts. */
  readonly invalid?: true;
}

/** Login progress uses project IDs. Run identity is private admission bookkeeping. */
export interface AutostartLoginRun {
  readonly runId: string | null;
  readonly bootId: string | null;
  readonly inProgress: boolean;
  readonly waitingForEngine: boolean;
  readonly startedAt: string | null;
  readonly pending: readonly string[];
  readonly started: readonly string[];
  readonly failed: readonly string[];
}

/** Global pause is independent of per-project manual-stop pauses. */
export interface AutostartGlobal {
  readonly paused: boolean;
  readonly loginRun: AutostartLoginRun;
  readonly invalid?: true;
}

// Invalid markers remain repairable and survive unrelated registry writes byte-for-JSON-value.
// The weak key follows the marker through project spreads without exposing raw data in views.
const invalidAutostartValues = new WeakMap<object, unknown>();

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
  readonly autostart?: ProjectAutostart;
  /** Legacy paths copied from writable storage still need independent review before first opt-in. */
  readonly autostartRequiresReview?: true;
}

export interface ProjectsRegistry {
  readonly version: typeof REGISTRY_VERSION;
  readonly projects: readonly RegisteredProject[];
  readonly autostartGlobal?: AutostartGlobal;
}

export class AmbiguousProjectIdError extends Error {
  constructor(id: string) {
    super(
      `Ambiguous project ID "${id}". Multiple registrations share this ID; inspect 'hack projects' before updating or removing an entry.`
    );
  }
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

const REGISTRY_READ_DIAGNOSTIC = "ProjectsRegistryReadError";

/**
 * Closed, value-free refusal when the projects registry exists (or may exist)
 * but cannot be read. Only a missing file (ENOENT/ENOTDIR) means an empty
 * registry; any other fault refuses so an unreadable registry is never
 * reported, targeted or rewritten as if it were empty.
 *
 * `E_PERMISSION` covers EACCES/EPERM; every other fault is `E_CONFIG_INVALID`.
 * The message never carries the OS message or the registry path. The fault's
 * class and errno code (for example `Error:EACCES`) are kept only as a
 * non-enumerable diagnostic; read it with {@link projectsRegistryReadDiagnostic}.
 */
export class ProjectsRegistryReadError extends HackCliError {
  override readonly code: "E_PERMISSION" | "E_CONFIG_INVALID";

  constructor(error: unknown) {
    const errno = isRecord(error) ? error.code : undefined;
    const code =
      errno === "EACCES" || errno === "EPERM"
        ? "E_PERMISSION"
        : "E_CONFIG_INVALID";
    super({
      code,
      message:
        "Cannot read the Hack projects registry (projects.json). Check its filesystem permissions before retrying; it was not changed. Values omitted.",
    });
    this.name = "ProjectsRegistryReadError";
    this.code = code;
    attachValueFreeDiagnostic({
      target: this,
      diagnostic: valueFreeErrorDiagnostic(error),
      fallback: REGISTRY_READ_DIAGNOSTIC,
    });
  }
}

/** The value-free diagnostic of a {@link ProjectsRegistryReadError}, for tests and debugging. */
export function projectsRegistryReadDiagnostic(
  error: unknown
): string | undefined {
  return error instanceof ProjectsRegistryReadError
    ? readValueFreeDiagnostic(error)
    : undefined;
}

async function readRegistryText(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch (error: unknown) {
    const errno = isRecord(error) ? error.code : undefined;
    if (errno === "ENOENT" || errno === "ENOTDIR") {
      return null;
    }
    throw new ProjectsRegistryReadError(error);
  }
}

/** Value-free refusal: an untrusted registry must never authorize login code execution. */
export class AutostartRegistryTrustError extends HackCliError {
  constructor() {
    super({
      code: "E_PERMISSION",
      message:
        "Autostart cannot trust projects.json. Preserve the old file outside the active registry, then rebuild a fresh current-user-owned regular registry and re-enable only reviewed projects. Do not repair writable files with in-place chmod: existing writer descriptors remain writable. Fresh files must have mode 0600, no symbolic link, and stay below 16 MiB. Values omitted.",
    });
    this.name = "AutostartRegistryTrustError";
  }
}

/** Strict intent mutations cannot discard malformed registration or worktree records. */
class AutostartRegistryInvalidError extends HackCliError {
  constructor() {
    super({
      code: "E_CONFIG_INVALID",
      message:
        "Projects registry is invalid; autostart intent was not changed.",
    });
  }
}

/**
 * Trust the opened file, never a pre-open path observation. The UID check applies
 * on hosts with a user identity; Unix file modes must deny group/other writes.
 * Kept pure so owner rejection can be tested without changing real ownership.
 */
export function isTrustedAutostartRegistryFile(opts: {
  readonly regular: boolean;
  readonly fileUid: number;
  readonly currentUid: number | undefined;
  readonly mode: number;
  readonly size: number;
}): boolean {
  return (
    opts.regular &&
    (opts.currentUid === undefined || opts.fileUid === opts.currentUid) &&
    (opts.mode & 0o022) === 0 &&
    opts.size >= 0 &&
    opts.size <= AUTOSTART_REGISTRY_LIMIT_BYTES
  );
}

/** No-follow, non-blocking and bounded read from the same descriptor we validate. */
async function readTrustedAutostartRegistryText(
  path: string,
  allowLegacyWritable = false
): Promise<string | null> {
  let file: FileHandle;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch (error: unknown) {
    const errno = isRecord(error) ? error.code : undefined;
    if (errno === "ENOENT" || errno === "ENOTDIR") {
      return null;
    }
    throw new AutostartRegistryTrustError();
  }
  try {
    const info = await file.stat();
    if (
      !isTrustedAutostartRegistryFile({
        regular: info.isFile(),
        fileUid: info.uid,
        currentUid: process.getuid?.(),
        // Only explicit first opt-in may rebuild unmarked legacy state. The
        // descriptor's regular-file, owner and byte bounds still apply.
        mode: allowLegacyWritable ? info.mode & ~0o022 : info.mode,
        size: info.size,
      })
    ) {
      throw new AutostartRegistryTrustError();
    }
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, AUTOSTART_REGISTRY_LIMIT_BYTES + 1 - total),
        null
      );
      if (bytesRead === 0) {
        return Buffer.concat(chunks, total).toString("utf8");
      }
      total += bytesRead;
      if (total > AUTOSTART_REGISTRY_LIMIT_BYTES) {
        throw new AutostartRegistryTrustError();
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
  } catch {
    throw new AutostartRegistryTrustError();
  } finally {
    await file.close().catch(() => undefined);
  }
}

type RegistryReadOptions = {
  readonly registryPath?: string;
  /** Automatic starts require a private, current-user-owned regular registry file. */
  readonly requireAutostartTrust?: true;
};

/**
 * Read an explicit session registry without changing process-wide environment.
 *
 * A missing registry is empty, and so (best-effort) is one that is not valid
 * JSON or not a registry. A registry that exists but cannot be read refuses
 * with {@link ProjectsRegistryReadError}; writers reread under the lock, so
 * they refuse too instead of replacing it.
 * `requireAutostartTrust` additionally refuses unsafe file identity, mode or
 * size with {@link AutostartRegistryTrustError}, before parsing any intent.
 */
export async function readProjectsRegistry(
  opts?: RegistryReadOptions
): Promise<ProjectsRegistry> {
  const path = opts?.registryPath ?? getRegistryPath();
  const text = opts?.requireAutostartTrust
    ? await readTrustedAutostartRegistryText(path)
    : await readRegistryText(path);
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

/**
 * Strict read for callers that must not take an unreadable or invalid
 * registry for an empty one (HACK-2177): `absent` (no file), `valid`, or
 * `invalid` (not JSON, or not a registry). A file that cannot be read
 * throws {@link ProjectsRegistryReadError}, as {@link readProjectsRegistry}.
 * Trusted autostart reads also throw {@link AutostartRegistryTrustError}.
 */
export async function readProjectsRegistryStrict(
  opts?: RegistryReadOptions
): Promise<
  | { readonly kind: "absent" | "invalid" }
  | {
      readonly kind: "valid";
      readonly registry: ProjectsRegistry;
      /** Project entries the registry holds that are not valid (skipped). */
      readonly rejected: number;
      /** Invalid/future autostart markers retained as disabled diagnostics. */
      readonly invalidAutostart: number;
    }
> {
  const path = opts?.registryPath ?? getRegistryPath();
  const text = opts?.requireAutostartTrust
    ? await readTrustedAutostartRegistryText(path)
    : await readRegistryText(path);
  if (text === null) {
    return { kind: "absent" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid" };
  }
  const registry = parseRegistry(parsed);
  if (registry === null) {
    return { kind: "invalid" };
  }
  // The best-effort parser skips invalid project entries, and invalid
  // worktree entries inside a valid project; count both, so a caller never
  // presents a filtered list as complete.
  const raw = isRecord(parsed) ? parsed.projects : undefined;
  const items: unknown[] = Array.isArray(raw) ? raw : [];
  let rejected = 0;
  for (const item of items) {
    const project = parseProject(item);
    if (project === null) {
      rejected += 1;
      continue;
    }
    const rawWorktrees = isRecord(item) ? item.worktrees : undefined;
    if (Array.isArray(rawWorktrees)) {
      rejected += rawWorktrees.length - (project.worktrees?.length ?? 0);
    } else if (rawWorktrees !== undefined) {
      // A present worktrees field that is not an array hides any checkouts
      // it held: unknown, not "no worktrees".
      rejected += 1;
    }
  }
  return {
    kind: "valid",
    registry,
    rejected,
    invalidAutostart: registry.projects.filter(
      (project) => project.autostart?.invalid
    ).length,
  };
}

/**
 * Ordinary registry writers must not launder untrusted login intent into a
 * current-user-owned atomic replacement. Call only while holding the registry
 * lock; if the first read carries intent, build the update from a trusted fresh
 * read instead. If it carries none, a later path replacement cannot inject a
 * marker into the already-read state that this writer publishes.
 */
async function readProjectsRegistryForMutation(): Promise<ProjectsRegistry> {
  const observed = await readProjectsRegistry();
  if (
    observed.autostartGlobal ||
    observed.projects.some((project) => project.autostart)
  ) {
    return await readProjectsRegistry({ requireAutostartTrust: true });
  }
  try {
    return (
      await readAutostartMutationRegistry({
        registryPath: getRegistryPath(),
        allowLegacyPermissionRepair: true,
        requireObservedLegacyProject: false,
      })
    ).registry;
  } catch (error: unknown) {
    if (
      !(
        error instanceof AutostartRegistryTrustError ||
        error instanceof AutostartRegistryInvalidError
      )
    ) {
      throw error;
    }
    // Preserve ordinary registration/prune behavior for unmarked legacy data.
    // Replacing a link publishes a fresh file at the registry path and leaves
    // its target untouched; none of the copied paths gains startup authority.
    return {
      ...observed,
      projects: observed.projects.map((project) => ({
        ...project,
        autostartRequiresReview: true,
      })),
    };
  }
}

type RegistrationUpsertOptions = {
  readonly project: ProjectContext;
  readonly nowIso?: string;
  /** Optional maintenance may abandon a busy lock without waiting or reclaiming it. */
  readonly waitForLock?: boolean;
  readonly signal?: AbortSignal;
};

type RegistrationObservation = {
  readonly name: string;
  readonly devHost: string | undefined;
  readonly repoRoot: string;
  readonly projectDir: string;
  readonly projectDirName: ProjectDirName;
};

export async function upsertProjectRegistration(
  opts: RegistrationUpsertOptions
): Promise<RegisterOutcome> {
  return await upsertObservedRegistration({ options: opts });
}

async function readRegistrationObservation(
  project: ProjectContext
): Promise<RegistrationObservation> {
  const [cfg, repoRoot, projectDir] = await Promise.all([
    readProjectConfig(project),
    tryRealpath(project.projectRoot),
    tryRealpath(project.projectDir),
  ]);
  return {
    name: requireProjectName(cfg.name ?? defaultProjectSlugFromPath(repoRoot)),
    devHost: cfg.devHost?.trim(),
    repoRoot,
    projectDir,
    projectDirName: project.projectDirName,
  };
}

async function upsertObservedRegistration(input: {
  readonly options: RegistrationUpsertOptions;
  readonly observation?: RegistrationObservation;
}): Promise<RegisterOutcome> {
  const opts = input.options;
  await assertLegacyProjectDirectory({ projectDir: opts.project.projectDir });
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

  // A touch can reuse only its own observation. Public upserts always observe
  // independently after admission; registry mutation still rereads under lock.
  const observation =
    input.observation ?? (await readRegistrationObservation(opts.project));
  const { repoIdentity, gitBranch } = await resolveGitRegistrationMetadata({
    repoRoot: observation.repoRoot,
  });

  return await withRegistryLock(
    async () => {
      await assertLegacyProjectDirectory({
        projectDir: opts.project.projectDir,
      });
      const current = await readProjectsRegistryForMutation();
      const update = await upsertInMemory({
        current,
        nowIso,
        incoming: {
          ...observation,
          repoIdentity,
          gitBranch,
        },
      });

      return await commitRegistrationUpdate({
        registry: current,
        update,
        registryPath,
        signal: opts.signal,
        projectDir: opts.project.projectDir,
      });
    },
    { waitForLock: opts.waitForLock, signal: opts.signal }
  );
}

async function commitRegistrationUpdate(opts: {
  readonly registry: ProjectsRegistry;
  readonly update: Awaited<ReturnType<typeof upsertInMemory>>;
  readonly registryPath: string;
  readonly signal?: AbortSignal;
  readonly projectDir: string;
}): Promise<RegisterOutcome> {
  const { project, status } = opts.update;
  if (status.status === "conflict") {
    return status;
  }
  if (status.status !== "noop" || status.changed) {
    await assertLegacyProjectDirectory({ projectDir: opts.projectDir });
    await writeRegistryAtomic(
      opts.registryPath,
      { ...opts.registry, projects: status.projects },
      opts.signal
    );
  }
  return { status: status.status, project };
}

/**
 * Only an unchanged, unambiguous primary may skip Git discovery. Before locking,
 * this selection is merely a hint; the owned reread must prove it again.
 */
function selectUnchangedPrimary(opts: {
  readonly registry: ProjectsRegistry;
  readonly observation: RegistrationObservation;
}): RegisteredProject | null {
  const { observation, registry } = opts;
  const byName = matchingNames(registry.projects, observation.name);
  const byDir = registry.projects.filter(
    (entry) => entry.projectDir === observation.projectDir
  );
  const entry = byName[0];
  if (
    byName.length !== 1 ||
    byDir.length !== 1 ||
    entry !== byDir[0] ||
    !entry ||
    entry.name !== observation.name ||
    entry.repoRoot !== observation.repoRoot ||
    entry.projectDirName !== observation.projectDirName ||
    entry.devHost !== observation.devHost ||
    registry.projects.filter((item) => item.id === entry.id).length !== 1
  ) {
    return null;
  }
  return entry;
}

/** A failed proof releases ownership completely before the caller discovers Git. */
async function refreshUnchangedPrimary(opts: {
  readonly observation: RegistrationObservation;
  readonly nowIso: string;
}): Promise<RegisterOutcome | null> {
  const registryPath = getRegistryPath();
  await assertLegacyProjectDirectory({
    projectDir: opts.observation.projectDir,
  });
  await deferIfProjectsRegistryBusy({ lockPath: getRegistryLockPath() });
  await ensureDir(dirname(registryPath));
  return await withRegistryLock(
    async () => {
      await assertLegacyProjectDirectory({
        projectDir: opts.observation.projectDir,
      });
      const current = await readProjectsRegistryForMutation();
      const primary = selectUnchangedPrimary({
        registry: current,
        observation: opts.observation,
      });
      const age =
        Date.parse(opts.nowIso) - Date.parse(primary?.lastSeenAt ?? "");
      if (!(primary && age >= 0)) {
        return null;
      }
      if (age < REGISTRY_TOUCH_INTERVAL_MS) {
        return { status: "noop", project: primary };
      }
      return await commitRegistrationUpdate({
        registry: current,
        registryPath,
        projectDir: opts.observation.projectDir,
        update: await updatePrimaryRegistration({
          current: current.projects,
          existing: primary,
          incoming: opts.observation,
          nowIso: opts.nowIso,
        }),
      });
    },
    { waitForLock: false }
  );
}

/**
 * Best-effort registry touch for read-style commands (e.g. `hack projects`).
 *
 * Coalesces unchanged observations for one minute. New or changed checkouts
 * use the normal serialized upsert, but never wait for or reclaim a busy lock.
 * An unchanged primary refresh skips Git only after a locked registry reread.
 * Configuration and canonical paths are observed once per invocation; a later
 * invocation reads them again even when the registration is still fresh.
 * Registry maintenance must not delay or break a read command.
 *
 * @returns The registration outcome, or null when the touch failed.
 */
export async function touchProjectRegistration(opts: {
  readonly project: ProjectContext;
  readonly nowIso?: string;
}): Promise<RegisterOutcome | null> {
  await assertLegacyProjectDirectory({ projectDir: opts.project.projectDir });
  try {
    const nowIso = opts.nowIso ?? new Date().toISOString();
    const [registry, observation] = await Promise.all([
      readProjectsRegistry(),
      readRegistrationObservation(opts.project),
    ]);
    const fresh = await readFreshRegistration({
      registry,
      observation,
      nowIso,
    });
    if (fresh) {
      return { status: "noop", project: fresh };
    }
    const primaryHint = selectUnchangedPrimary({ registry, observation });
    const age = Date.parse(nowIso) - Date.parse(primaryHint?.lastSeenAt ?? "");
    if (primaryHint && age >= 0) {
      const refreshed = await refreshUnchangedPrimary({ observation, nowIso });
      if (refreshed) {
        return refreshed;
      }
    }
    return await upsertObservedRegistration({
      options: { project: opts.project, nowIso, waitForLock: false },
      observation,
    });
  } catch (error: unknown) {
    if (error instanceof ProjectInputSelectionError) {
      throw error;
    }
    return null;
  }
}

/** A read-only freshness optimization; mutation decisions still run under the lock. */
async function readFreshRegistration(opts: {
  readonly registry: ProjectsRegistry;
  readonly observation: RegistrationObservation;
  readonly nowIso: string;
}): Promise<RegisteredProject | null> {
  const { name, devHost, projectDirName, projectDir, repoRoot } =
    opts.observation;
  const matches = matchingNames(opts.registry.projects, name);
  if (matches.length !== 1) {
    return null;
  }
  for (const entry of matches) {
    selectRegisteredProjectById({
      projects: opts.registry.projects,
      id: entry.id,
    });
    if (
      entry.name !== name ||
      entry.devHost !== devHost ||
      entry.projectDirName !== projectDirName
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

  return await findProjectContextAtRoot({
    projectRoot: match.repoRoot,
    projectDirName: match.projectDirName,
  });
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
  const match = matches[0];
  return match
    ? selectRegisteredProjectById({ projects: opts.projects, id: match.id })
    : null;
}

/** Refuse the selected identity before liveness checks can hide a contender. */
function selectRegisteredProjectById(opts: {
  readonly projects: readonly RegisteredProject[];
  readonly id: string;
}): RegisteredProject | null {
  const matches = opts.projects.filter((project) => project.id === opts.id);
  if (matches.length > 1) {
    throw new AmbiguousProjectIdError(opts.id);
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
  const match = selectRegisteredProjectById({
    projects: registry.projects,
    id: opts.id,
  });
  if (!match) {
    return null;
  }

  const project = await findProjectContextAtRoot({
    projectRoot: match.repoRoot,
    projectDirName: match.projectDirName,
  });
  if (!project) {
    return null;
  }

  return {
    registration: match,
    project,
  };
}

type AutostartRegistryOptions = {
  readonly registryPath?: string;
  readonly signal?: AbortSignal;
};

/** Legacy registries default to unpaused with no observed login run. */
export function getDefaultAutostartGlobal(): AutostartGlobal {
  return {
    paused: false,
    loginRun: {
      runId: null,
      bootId: null,
      inProgress: false,
      waitingForEngine: false,
      startedAt: null,
      pending: [],
      started: [],
      failed: [],
    },
  };
}

/** Automatic-start policy must be read from a trusted machine registry. */
export async function readAutostartGlobal(
  opts: AutostartRegistryOptions = {}
): Promise<AutostartGlobal> {
  const registry = await readTrustedAutostartRegistry(opts);
  return registry.autostartGlobal ?? getDefaultAutostartGlobal();
}

/** Global pause masks every opt-in, including future markers; manual-stop intent is retained. */
export async function setAutostartGlobalPaused(
  opts: AutostartRegistryOptions & { readonly paused: boolean }
): Promise<AutostartGlobal> {
  return await mutateAutostartRegistry({
    ...opts,
    update: (current) => {
      const old = current.autostartGlobal;
      const global: AutostartGlobal = {
        ...(old?.invalid
          ? getDefaultAutostartGlobal()
          : (old ?? getDefaultAutostartGlobal())),
        paused: opts.paused,
      };
      return { next: { ...current, autostartGlobal: global }, value: global };
    },
  });
}

/** Begin a new owned progress record. A globally paused machine starts no run. */
export async function beginAutostartLoginRun(
  opts: AutostartRegistryOptions & {
    readonly bootId: string;
    readonly startedAt: string;
    readonly pendingIds: readonly string[];
    readonly waitingForEngine?: boolean;
  }
): Promise<AutostartLoginRun | null> {
  if (!(opts.bootId.trim() && Number.isFinite(Date.parse(opts.startedAt)))) {
    throw new Error(
      "Autostart login requires a boot identity and valid start time."
    );
  }
  const pending = [...new Set(opts.pendingIds)];
  if (!isAutostartLoginProjectIds(pending)) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message:
        "Autostart login progress supports at most 1000 project IDs, each 1 to 128 characters. No projects were started.",
    });
  }
  return await mutateAutostartRegistry({
    ...opts,
    update: (current) => {
      const global = current.autostartGlobal ?? getDefaultAutostartGlobal();
      if (global.paused) {
        return { next: current, value: null };
      }
      const run: AutostartLoginRun = {
        runId: randomUUID(),
        bootId: opts.bootId,
        inProgress: true,
        waitingForEngine: opts.waitingForEngine ?? false,
        startedAt: opts.startedAt,
        pending,
        started: [],
        failed: [],
      };
      return {
        next: { ...current, autostartGlobal: { ...global, loginRun: run } },
        value: run,
      };
    },
  });
}

/** Complete one pending project; duplicate and superseded run receipts do nothing. */
export async function recordAutostartLoginOutcome(
  opts: AutostartRegistryOptions & {
    readonly runId: string;
    readonly id: string;
    readonly succeeded: boolean;
    /** User intent/cancellation is neither success nor a startup failure. */
    readonly cancelled?: boolean;
  }
): Promise<boolean> {
  return await mutateAutostartRegistry({
    ...opts,
    update: (current) => {
      const global = current.autostartGlobal ?? getDefaultAutostartGlobal();
      const run = global.loginRun;
      if (
        !run.inProgress ||
        run.runId !== opts.runId ||
        !run.pending.includes(opts.id)
      ) {
        return { next: current, value: false };
      }
      const loginRun: AutostartLoginRun = {
        ...run,
        pending: run.pending.filter((id) => id !== opts.id),
        started: opts.succeeded ? [...run.started, opts.id] : run.started,
        failed:
          opts.succeeded || opts.cancelled
            ? run.failed
            : [...run.failed, opts.id],
      };
      return {
        next: { ...current, autostartGlobal: { ...global, loginRun } },
        value: true,
      };
    },
  });
}

/** Publish engine readiness for the active run without touching project claims or outcomes. */
export async function setAutostartLoginWaitingForEngine(
  opts: AutostartRegistryOptions & {
    readonly runId: string;
    readonly waitingForEngine: boolean;
  }
): Promise<boolean> {
  return await mutateAutostartRegistry({
    ...opts,
    update: (current) => {
      const global = current.autostartGlobal ?? getDefaultAutostartGlobal();
      const run = global.loginRun;
      if (!run.inProgress || run.runId !== opts.runId) {
        return { next: current, value: false };
      }
      return {
        next: {
          ...current,
          autostartGlobal: {
            ...global,
            loginRun: { ...run, waitingForEngine: opts.waitingForEngine },
          },
        },
        value: true,
      };
    },
  });
}

/** Close a run; engine deferral retains unclaimed work for a later readiness pass. */
export async function finishAutostartLoginRun(
  opts: AutostartRegistryOptions & {
    readonly runId: string;
    readonly waitingForEngine?: boolean;
  }
): Promise<boolean> {
  return await mutateAutostartRegistry({
    ...opts,
    update: (current) => {
      const global = current.autostartGlobal ?? getDefaultAutostartGlobal();
      const run = global.loginRun;
      if (!run.inProgress || run.runId !== opts.runId) {
        return { next: current, value: false };
      }
      const loginRun: AutostartLoginRun = {
        ...run,
        inProgress: false,
        waitingForEngine: opts.waitingForEngine ?? false,
        pending: opts.waitingForEngine ? run.pending : [],
        failed: run.failed,
      };
      return {
        next: { ...current, autostartGlobal: { ...global, loginRun } },
        value: true,
      };
    },
  });
}

async function readTrustedAutostartRegistry(
  opts: AutostartRegistryOptions
): Promise<ProjectsRegistry> {
  const read = await readProjectsRegistryStrict({
    registryPath: opts.registryPath,
    requireAutostartTrust: true,
  });
  if (read.kind === "invalid" || (read.kind === "valid" && read.rejected > 0)) {
    throw new AutostartRegistryInvalidError();
  }
  return read.kind === "valid"
    ? read.registry
    : { version: REGISTRY_VERSION, projects: [] };
}

/** Serialize global policy, progress and project intent with all existing registry writers. */
async function mutateAutostartRegistry<T>(
  opts: AutostartRegistryOptions & {
    readonly update: (current: ProjectsRegistry) => {
      readonly next: ProjectsRegistry;
      readonly value: T;
    };
  }
): Promise<T> {
  const registryPath = opts.registryPath ?? getRegistryPath();
  await ensureDir(dirname(registryPath));
  return await withProjectsRegistryLock({
    lockPath: `${registryPath}.lock`,
    signal: opts.signal,
    run: async () => {
      const current = await readTrustedAutostartRegistry({ registryPath });
      const { next, value } = opts.update(current);
      if (next !== current) {
        await writeRegistryAtomic(registryPath, next, opts.signal);
      }
      return value;
    },
  });
}

/** Explicit machine opt-in. Re-adding an unchanged target preserves its boot claim. */
export async function setProjectAutostart(
  opts: AutostartRegistryOptions & {
    readonly id: string;
    readonly branch?: string | null;
    /** Independently observed current checkout; unsafe legacy paths cannot establish this proof. */
    readonly observedProject?: {
      readonly repoRoot: string;
      readonly projectDir: string;
    };
    /** Fired only after rebuilding an owned, unmarked legacy registry on a new private inode. */
    readonly onPermissionsRepaired?: () => void;
  }
): Promise<RegisteredProject> {
  let selected: RegisteredProject | undefined;
  await mutateProjectAutostart({
    ...opts,
    allowLegacyPermissionRepair: true,
    requireObservedProjectReview: true,
    update: (project) => {
      const branch = opts.branch ?? null;
      const old = project.autostart;
      if (old?.invalid) {
        throw new HackCliError({
          code: "E_CONFIG_INVALID",
          message:
            "Autostart state is invalid or newer than this CLI. Remove the marker with 'hack autostart remove' before adding it again. Values omitted.",
        });
      }
      const autostart: ProjectAutostart = {
        ...old,
        branch,
        paused: false,
        lastResult: old?.lastResult ?? null,
        lastAttemptBootId: old?.lastAttemptBootId ?? null,
      };
      const { autostartRequiresReview: _reviewed, ...reviewed } = project;
      selected = { ...reviewed, autostart };
      return selected;
    },
  });
  if (!selected) {
    throw new HackCliError({
      code: "E_PROJECT_NOT_FOUND",
      message:
        "Project is not registered; register it before enabling autostart.",
    });
  }
  return selected;
}

/** Remove machine intent without stopping the project's running processes. */
export async function removeProjectAutostart(
  opts: AutostartRegistryOptions & { readonly id: string }
): Promise<RegisteredProject | null> {
  const changed = await mutateProjectAutostart({
    ...opts,
    update: (project) => {
      const { autostart: _removed, ...rest } = project;
      return rest;
    },
  });
  return changed[0] ?? null;
}

/** Pause/resume only existing opt-ins. An omitted id selects all marked projects. */
export async function setProjectAutostartPaused(
  opts: AutostartRegistryOptions & {
    readonly id?: string;
    readonly paused: boolean;
  }
): Promise<readonly RegisteredProject[]> {
  return await mutateProjectAutostart({
    ...opts,
    update: (project) =>
      project.autostart && !project.autostart.invalid
        ? {
            ...project,
            autostart: { ...project.autostart, paused: opts.paused },
          }
        : project,
  });
}

/**
 * Atomically claim an unpaused opt-in once per OS boot, before any child starts.
 * A crash after publication can skip that boot's attempt; it never duplicates it.
 * The returned registration is the locked reread, not a stale scheduling snapshot.
 */
export async function claimProjectAutostart(
  opts: AutostartRegistryOptions & {
    readonly id: string;
    readonly bootId: string;
  }
): Promise<RegisteredProject | null> {
  if (!opts.bootId.trim()) {
    throw new Error("Autostart requires a non-empty OS boot identity.");
  }
  let claimed: RegisteredProject | null = null;
  await mutateProjectAutostart({
    ...opts,
    respectGlobalPause: true,
    update: (project) => {
      const marker = project.autostart;
      if (
        project.autostartRequiresReview ||
        !marker ||
        marker.invalid ||
        marker.paused ||
        marker.lastAttemptBootId === opts.bootId
      ) {
        return project;
      }
      claimed = {
        ...project,
        autostart: { ...marker, lastAttemptBootId: opts.bootId },
      };
      return claimed;
    },
  });
  return claimed;
}

/** A late result cannot recreate removed intent or overwrite a newer boot claim. */
export async function recordProjectAutostartResult(
  opts: AutostartRegistryOptions & {
    readonly id: string;
    readonly bootId: string;
    readonly result: ProjectAutostartResult;
  }
): Promise<boolean> {
  let recorded = false;
  await mutateProjectAutostart({
    ...opts,
    update: (project) => {
      if (
        project.autostart?.invalid ||
        project.autostart?.lastAttemptBootId !== opts.bootId
      ) {
        return project;
      }
      recorded = true;
      return {
        ...project,
        autostart: { ...project.autostart, lastResult: opts.result },
      };
    },
  });
  return recorded;
}

/** Every intent mutation rereads and publishes under the same registry lock as upsert. */
async function mutateProjectAutostart(
  opts: AutostartRegistryOptions & {
    readonly id?: string;
    readonly respectGlobalPause?: boolean;
    readonly allowLegacyPermissionRepair?: boolean;
    readonly requireObservedProjectReview?: boolean;
    readonly observedProject?: {
      readonly repoRoot: string;
      readonly projectDir: string;
    };
    readonly onPermissionsRepaired?: () => void;
    readonly update: (project: RegisteredProject) => RegisteredProject;
  }
): Promise<readonly RegisteredProject[]> {
  const registryPath = opts.registryPath ?? getRegistryPath();
  await ensureDir(dirname(registryPath));
  return await withProjectsRegistryLock({
    lockPath: `${registryPath}.lock`,
    signal: opts.signal,
    run: async () => {
      const { registry: current, permissionsRepaired } =
        await readAutostartMutationRegistry({
          registryPath,
          id: opts.id,
          observedProject: opts.observedProject,
          allowLegacyPermissionRepair: opts.allowLegacyPermissionRepair,
        });
      if (opts.respectGlobalPause && current.autostartGlobal?.paused) {
        return [];
      }
      if (
        opts.requireObservedProjectReview &&
        current.projects.some(
          (project) => project.id === opts.id && project.autostartRequiresReview
        )
      ) {
        await assertObservedLegacyRepairProject({
          registry: current,
          id: opts.id,
          observedProject: opts.observedProject,
        });
      }
      if (opts.id !== undefined) {
        selectRegisteredProjectById({
          projects: current.projects,
          id: opts.id,
        });
      } else {
        for (const project of current.projects) {
          selectRegisteredProjectById({
            projects: current.projects,
            id: project.id,
          });
        }
      }
      const selected: RegisteredProject[] = [];
      const projects = current.projects.map((project) => {
        if (
          opts.id !== undefined ? project.id !== opts.id : !project.autostart
        ) {
          return project;
        }
        const updated = opts.update(project);
        selected.push(updated);
        return updated;
      });
      if (
        projects.some((project, index) => project !== current.projects[index])
      ) {
        await writeRegistryAtomic(
          registryPath,
          { ...current, projects },
          opts.signal
        );
        if (permissionsRepaired) {
          opts.onPermissionsRepaired?.();
        }
      }
      return selected;
    },
  });
}

/**
 * An explicit first opt-in may copy current-user-owned unmarked v4 registrations
 * to a fresh 0600 inode only after independently observed checkout paths match.
 * Existing automatic-start intent cannot be authenticated
 * this way: it requires separate preservation and a reviewed rebuild instead.
 */
async function readAutostartMutationRegistry(opts: {
  readonly registryPath: string;
  readonly allowLegacyPermissionRepair?: boolean;
  readonly requireObservedLegacyProject?: boolean;
  readonly id?: string;
  readonly observedProject?: {
    readonly repoRoot: string;
    readonly projectDir: string;
  };
}): Promise<{
  readonly registry: ProjectsRegistry;
  readonly permissionsRepaired: boolean;
}> {
  try {
    return {
      registry: await readTrustedAutostartRegistry(opts),
      permissionsRepaired: false,
    };
  } catch (error: unknown) {
    if (
      !(
        opts.allowLegacyPermissionRepair &&
        error instanceof AutostartRegistryTrustError
      )
    ) {
      throw error;
    }
  }
  const text = await readTrustedAutostartRegistryText(opts.registryPath, true);
  let value: unknown;
  try {
    value =
      text === null
        ? { version: REGISTRY_VERSION, projects: [] }
        : JSON.parse(text);
  } catch {
    throw new AutostartRegistryTrustError();
  }
  const registry = parseRegistry(value);
  if (
    !(registry && isRecord(value) && Array.isArray(value.projects)) ||
    registry.projects.length !== value.projects.length
  ) {
    throw new AutostartRegistryTrustError();
  }
  if (
    value.autostartGlobal !== undefined ||
    value.projects.some(
      (project: unknown) => isRecord(project) && project.autostart !== undefined
    )
  ) {
    throw new AutostartRegistryTrustError();
  }
  if (
    value.projects.some((project: unknown, index) => {
      if (!isRecord(project) || project.worktrees === undefined) {
        return false;
      }
      return (
        !Array.isArray(project.worktrees) ||
        project.worktrees.length !==
          (registry.projects[index]?.worktrees?.length ?? 0)
      );
    })
  ) {
    throw new AutostartRegistryTrustError();
  }
  if (opts.requireObservedLegacyProject !== false) {
    await assertObservedLegacyRepairProject({
      registry,
      id: opts.id,
      observedProject: opts.observedProject,
    });
  }
  return {
    registry: {
      ...registry,
      projects: registry.projects.map((project) => ({
        ...project,
        autostartRequiresReview: true,
      })),
    },
    permissionsRepaired: true,
  };
}

async function assertObservedLegacyRepairProject(opts: {
  readonly registry: ProjectsRegistry;
  readonly id?: string;
  readonly observedProject?: {
    readonly repoRoot: string;
    readonly projectDir: string;
  };
}): Promise<void> {
  const refusal = () =>
    new HackCliError({
      code: "E_PERMISSION",
      message:
        "A writable legacy registry cannot authorize a named target by itself. Change into the reviewed project checkout and run 'hack up --always' or 'hack autostart add' there. No intent was changed. Values omitted.",
    });
  const matches = opts.registry.projects.filter(
    (project) => project.id === opts.id
  );
  const selected = matches.length === 1 ? matches[0] : undefined;
  if (!(selected && opts.observedProject)) {
    throw refusal();
  }
  try {
    const [observedRoot, observedDir, registeredRoot, registeredDir] =
      await Promise.all([
        realpath(opts.observedProject.repoRoot),
        realpath(opts.observedProject.projectDir),
        realpath(selected.repoRoot),
        realpath(selected.projectDir),
      ]);
    if (observedRoot !== registeredRoot || observedDir !== registeredDir) {
      throw refusal();
    }
  } catch {
    throw refusal();
  }
}

/** Validate every requested ID under ownership before removing any entry. */
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
      const current = await readProjectsRegistryForMutation();
      for (const id of removeIds) {
        selectRegisteredProjectById({ projects: current.projects, id });
      }
      const removed = current.projects.filter((p) => removeIds.has(p.id));
      if (removed.length === 0) {
        return { removed: [] };
      }

      const next = current.projects.filter((p) => !removeIds.has(p.id));
      await writeRegistryAtomic(
        getRegistryPath(),
        {
          ...current,
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

  const autostartGlobal = parseAutostartGlobal(value.autostartGlobal);
  return {
    version: REGISTRY_VERSION,
    projects,
    ...(autostartGlobal ? { autostartGlobal } : {}),
  };
}

/** Invalid/future global policy remains visible, preserved and incapable of automatic starts. */
function parseAutostartGlobal(value: unknown): AutostartGlobal | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    isRecord(value) &&
    typeof value.paused === "boolean" &&
    isRecord(value.loginRun)
  ) {
    const run = value.loginRun;
    if (
      (run.runId === null || typeof run.runId === "string") &&
      (run.bootId === null || typeof run.bootId === "string") &&
      typeof run.inProgress === "boolean" &&
      (run.waitingForEngine === undefined ||
        typeof run.waitingForEngine === "boolean") &&
      (run.startedAt === null ||
        (typeof run.startedAt === "string" &&
          Number.isFinite(Date.parse(run.startedAt)))) &&
      isAutostartLoginProjectIds(run.pending) &&
      isAutostartLoginProjectIds(run.started) &&
      isAutostartLoginProjectIds(run.failed) &&
      run.pending.length + run.started.length + run.failed.length <=
        AUTOSTART_LOGIN_PROJECT_LIMIT &&
      (!run.inProgress || Boolean(run.runId && run.bootId && run.startedAt))
    ) {
      return {
        ...value,
        paused: value.paused,
        loginRun: {
          ...run,
          runId: run.runId,
          bootId: run.bootId,
          inProgress: run.inProgress,
          waitingForEngine: run.waitingForEngine ?? false,
          startedAt: run.startedAt,
          pending: run.pending,
          started: run.started,
          failed: run.failed,
        },
      };
    }
  }
  const global: AutostartGlobal = {
    ...getDefaultAutostartGlobal(),
    paused: true,
    invalid: true,
  };
  invalidAutostartValues.set(global, value);
  return global;
}

function isAutostartLoginProjectIds(
  value: unknown
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= AUTOSTART_LOGIN_PROJECT_LIMIT &&
    value.every(
      (id: unknown) =>
        typeof id === "string" &&
        id.length > 0 &&
        id.length <= AUTOSTART_PROJECT_ID_LIMIT
    )
  );
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
  const autostart = parseProjectAutostart(value.autostart);

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
    ...(autostart ? { autostart } : {}),
    ...(value.autostartRequiresReview === true
      ? { autostartRequiresReview: true }
      : {}),
  };
}

/** Unknown intent disables only its automatic start; ordinary project operations still work. */
function parseProjectAutostart(value: unknown): ProjectAutostart | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !(
      isRecord(value) &&
      (value.branch === null || typeof value.branch === "string")
    ) ||
    typeof value.paused !== "boolean" ||
    !(
      value.lastAttemptBootId === null ||
      typeof value.lastAttemptBootId === "string"
    )
  ) {
    return invalidProjectAutostart(value);
  }
  let lastResult: ProjectAutostartResult | null = null;
  if (value.lastResult !== null) {
    const result = value.lastResult;
    if (
      !(
        isRecord(result) &&
        (result.status === "started" ||
          result.status === "skipped" ||
          result.status === "failed" ||
          result.status === "already_running") &&
        (result.reason === null || typeof result.reason === "string")
      ) ||
      typeof result.at !== "string"
    ) {
      return invalidProjectAutostart(value);
    }
    lastResult = {
      ...result,
      status: result.status,
      reason: result.reason,
      at: result.at,
    };
  }
  return {
    ...value,
    branch: value.branch,
    paused: value.paused,
    lastAttemptBootId: value.lastAttemptBootId,
    lastResult,
  };
}

function invalidProjectAutostart(raw: unknown): ProjectAutostart {
  const marker: ProjectAutostart = {
    branch: null,
    paused: true,
    lastAttemptBootId: null,
    lastResult: {
      status: "skipped",
      reason: "invalid_marker",
      // Sentinel: malformed state is observed, not an attempted project start.
      at: "1970-01-01T00:00:00.000Z",
    },
    invalid: true,
  };
  invalidAutostartValues.set(marker, raw);
  return marker;
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

/** The projects registry file this process reads (`projects.json`). */
export function resolveProjectsRegistryPath(): string {
  return getRegistryPath();
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
  const text = `${JSON.stringify(
    registry,
    (_key, value: unknown) => {
      if (
        typeof value === "object" &&
        value !== null &&
        invalidAutostartValues.has(value)
      ) {
        return invalidAutostartValues.get(value);
      }
      return value;
    },
    2
  )}\n`;
  if (
    (registry.autostartGlobal ||
      registry.projects.some((project) => project.autostart)) &&
    Buffer.byteLength(text) > AUTOSTART_REGISTRY_LIMIT_BYTES
  ) {
    throw new AutostartRegistryTrustError();
  }
  await writeProjectsRegistryAtomic({
    path,
    text,
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
  const existingTarget = existingByDir ?? existingByName;
  if (existingTarget) {
    selectRegisteredProjectById({
      projects: current,
      id: existingTarget.id,
    });
  }

  // 1) Same directory already registered → update name/devHost/lastSeen.
  if (existingByDir) {
    if (existingByName && !isSameProject(existingByName, incoming)) {
      return registrationConflict({ existing: existingByName, incoming });
    }

    return await updatePrimaryRegistration({
      current,
      existing: existingByDir,
      incoming,
      nowIso: opts.nowIso,
    });
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
  if (current.some((entry) => entry.id === created.id)) {
    throw new Error(
      `Project ID collision "${created.id}". Refusing to create a registration with an existing ID; inspect 'hack projects'.`
    );
  }

  return {
    project: created,
    status: { status: "created", projects: [...current, created] },
  };
}

async function updatePrimaryRegistration(opts: {
  readonly current: readonly RegisteredProject[];
  readonly existing: RegisteredProject;
  readonly incoming: Pick<
    RegisteredProject,
    "name" | "repoRoot" | "projectDirName" | "devHost"
  >;
  readonly nowIso: string;
}): Promise<{
  readonly project: RegisteredProject;
  readonly status: {
    readonly status: "noop" | "updated";
    readonly projects: readonly RegisteredProject[];
  };
}> {
  const { existing, incoming } = opts;
  const prunedWorktrees = await pruneWorktreeEntries(existing.worktrees);
  const { worktrees: _staleWorktrees, ...existingBase } = existing;
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
      status: shallowEqual(existing, updated) ? "noop" : "updated",
      projects: replaceById(opts.current, updated),
    },
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
  if (keys.length !== Object.keys(b).length) {
    return false;
  }
  for (const k of keys) {
    if (!Object.hasOwn(b, k) || a[k] !== b[k]) {
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
