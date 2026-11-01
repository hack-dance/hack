import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { YAML } from "bun";
import {
  HACK_PROJECT_DIR_PRIMARY,
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_CONFIG_DEFAULT_FILENAME,
  PROJECT_ENV_CONFIG_FILENAME_PREFIX,
  PROJECT_ENV_CONFIG_FILENAME_SUFFIX,
  PROJECT_ENV_CONTRACT_FILENAME,
  PROJECT_ENV_FILENAME,
  PROJECT_ENV_KEY_FILENAME,
  PROJECT_ENV_LOCAL_SEGMENT,
  PROJECT_ENV_STATE_FILENAME,
} from "../constants.ts";
import {
  HACK_DIR_GITIGNORE_BEGIN_MARKER,
  HACK_DIR_GITIGNORE_END_MARKER,
  HACK_DIR_GITIGNORE_ENTRIES,
} from "../templates.ts";
import { ClosedCliError, HackCliError } from "./cli-result.ts";
import { parseDotEnv, serializeDotEnv } from "./env.ts";
import { withEnvLayerLock } from "./env-layer-lock.ts";
import {
  AtomicWriteConflictError,
  closedFileWriteError,
  ensureDir,
  ensureDirForWrite,
  ensureGitignoreEntry,
  ensureRealDirectoryForWrite,
  mergeManagedGitignoreBlock,
  pathExists,
  readAtomicWriteTargetText,
  readOptionalTextFile,
  readTextFile,
  writeTextFile,
  writeTextFileAtomicIfChanged,
  writeTextFileIfChanged,
} from "./fs.ts";
import { ensureHackGitInfoExclude } from "./git-info-exclude.ts";
import {
  resolveGitPrimaryWorktreeRoot,
  resolveGitRepositoryIdentity,
  resolveGitWorktreeDir,
} from "./git-worktree.ts";
import { getRecord, getString, isRecord } from "./guards.ts";
import {
  readHackEnvContract,
  resolveEnvFilePath,
  resolveHackEnv,
} from "./hack-env.ts";
import {
  isOwnedLegacyAdoptionManagedEnvAdmission,
  type LegacyAdoptionManagedEnvAdmission,
} from "./native-compose-adoption-env-inputs.ts";
import {
  NATIVE_CONFIG_INPUT_LIMIT,
  NativeConfigCompilerError,
} from "./native-config-compiler.ts";
import {
  acquireNativeManagedEnvFile,
  assertNativeProjectInputRoot,
} from "./native-project-inputs.ts";
import { writePrivateEnvFileIfChanged } from "./private-env-file.ts";
import {
  createPrivateFileExclusive,
  decodeCanonicalBase64,
  publishPrivateFileExclusive,
  type ReplaceablePrivateFileOptions,
  readBoundedPrivateFile,
  readReplaceablePrivateFile,
  replacePrivateFileAtomic,
} from "./private-file.ts";
import { readProjectDefaultEnvConfig } from "./project.ts";
import {
  assertLegacyProjectDirectory,
  assertLegacyProjectInputFamily,
  ProjectInputSelectionError,
} from "./project-input-selection.ts";
import {
  ProjectsRegistryLockTimeoutError,
  withProjectsRegistryLock,
} from "./projects-registry-lock.ts";
import {
  isNativeManagedLocalTracked,
  resolvePrimaryLocalProjectDir,
  resolveVerifiedPrimaryWorktreeRoot,
  resolveVerifiedProjectEnvKeyGitLocation,
  shouldInheritPrimaryLocalInputs,
  validatePrimaryLocalFile,
} from "./worktree-local-config.ts";

const PROJECT_ENV_CONFIG_VERSION = 1 as const;
const PROJECT_ENV_SECRETS_PROVIDER = "project_key" as const;
const NATIVE_ENV_WORKLOAD_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const NATIVE_ENV_OVERLAY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROJECT_ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const PROJECT_ENV_SCOPE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Fixed refusals for env key and scope arguments.
 *
 * Invariant: these messages never interpolate the rejected argument. A key
 * argument is often a mistyped `KEY=value` or a value pasted into the key
 * position, so echoing any part of it could disclose a secret in terminal
 * output, logs, or CI transcripts.
 */
export const ENV_KEY_INVALID_MESSAGE =
  "Invalid env key: keys must match ^[A-Z_][A-Z0-9_]*$ (for example API_TOKEN). The argument is not shown because it may contain a value.";
export const ENV_KEY_ASSIGNMENT_MESSAGE =
  'Invalid env key: the key argument cannot contain "=". Pass only the key (matching ^[A-Z_][A-Z0-9_]*$) and supply secret values with --value-stdin or the hidden prompt. The argument is not shown because it may contain a value.';
export const ENV_SCOPE_INVALID_MESSAGE =
  'Invalid env scope: scopes must be "global" or match ^[a-z0-9][a-z0-9._-]*$ (usually a compose service name). The argument is not shown because it may contain a value.';
export const ENV_SCOPE_UNKNOWN_MESSAGE =
  "Unknown env scope: the requested scope is not global, a compose service, or a scope in the project env files. The argument is not shown because it may contain a value.";
const UNKNOWN_SCOPE_LIST_LIMIT = 20;
const PROJECT_ENV_SECRET_PREFIX = "v1" as const;
const PROJECT_ENV_ALGORITHM = "aes-256-gcm";
const PROJECT_ENV_IV_BYTES = 12;
const PROJECT_ENV_TAG_BYTES = 16;
/** Decoded ciphertext bound; a value never exceeds its 1 MiB env layer. */
const PROJECT_ENV_CIPHERTEXT_LIMIT = NATIVE_CONFIG_INPUT_LIMIT;
const PROJECT_ENV_SECRET_KEY_ENV = "HACK_ENV_SECRET_KEY";
export const PROJECT_ENV_HOST_SCOPE = "host" as const;

type ProjectEnvScalar = string | number | boolean;

type ProjectEnvSecretValue = {
  readonly secure: string;
};

/** Null is an explicit removal of a value from earlier layers. */
export type ProjectEnvStoredValue =
  | ProjectEnvScalar
  | ProjectEnvSecretValue
  | null;

export type ProjectEnvValuesByScope = Record<
  string,
  Record<string, ProjectEnvStoredValue>
>;

export type ProjectEnvConfig = {
  readonly version: typeof PROJECT_ENV_CONFIG_VERSION;
  readonly environment: string;
  readonly secretsprovider: typeof PROJECT_ENV_SECRETS_PROVIDER;
  readonly values: ProjectEnvValuesByScope;
};

export type LegacyComposeEnvFileReference = {
  readonly service: string;
  readonly configuredPath: string;
  readonly resolvedPath: string;
};

export type ProjectEnvSelection = {
  readonly requestedEnv: string | null;
  readonly defaultEnv: string | null;
  readonly effectiveEnv: string | null;
  readonly defaultPath: string;
  readonly overlayPath: string | null;
  readonly overlayExists: boolean;
  readonly localDefaultPath: string;
  readonly localDefaultExists: boolean;
  readonly localOverlayPath: string | null;
  readonly localOverlayExists: boolean;
};

type EffectiveEnvMetadata = Record<
  string,
  Record<string, { readonly scope: string; readonly secret: boolean }>
>;

/** Names, winning scopes and secret flags only; never carries stored values. */
export type ProjectEnvResolvedMetadata = {
  readonly effectiveMetadata: EffectiveEnvMetadata;
  readonly hostEffectiveMetadata: EffectiveEnvMetadata;
  readonly selection: ProjectEnvSelection;
  readonly files: readonly string[];
  readonly declaredScopes: readonly string[];
  readonly unknownScopes: readonly string[];
};

export type ProjectEnvResolvedConfig = ProjectEnvResolvedMetadata & {
  readonly merged: ProjectEnvConfig;
  readonly globalEnv: Readonly<Record<string, string>>;
  readonly hostEnv: Readonly<Record<string, string>>;
  readonly hostTargetEnv: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  readonly serviceEnv: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
};

export function selectProjectEnvValues(opts: {
  readonly resolved: ProjectEnvResolvedConfig;
  readonly scopeName?: string | null;
}): Record<string, string> {
  const scopeName = normalizeProjectEnvScopeName({
    scopeName: opts.scopeName,
  });
  if (scopeName === "global") {
    return { ...opts.resolved.globalEnv };
  }

  const scoped = Object.hasOwn(opts.resolved.serviceEnv, scopeName)
    ? opts.resolved.serviceEnv[scopeName]
    : undefined;
  if (!scoped) {
    throw new ClosedCliError(
      unknownProjectEnvScopeMessage({
        configuredScopes: Object.keys(opts.resolved.serviceEnv),
      })
    );
  }

  return { ...scoped };
}

/**
 * Fixed refusal for a scope that is not configured. It may list scope names
 * taken from the project's compose and env files, but never the requested
 * argument: a mistyped `--service KEY=value` must not be echoed.
 */
export function unknownProjectEnvScopeMessage(opts: {
  readonly configuredScopes: readonly string[];
}): string {
  const configured = [
    "global",
    ...[...new Set(opts.configuredScopes)]
      .filter((scope) => scope !== "global")
      .sort(),
  ];
  const shown = configured.slice(0, UNKNOWN_SCOPE_LIST_LIMIT);
  const more =
    configured.length > shown.length
      ? ` (and ${configured.length - shown.length} more)`
      : "";
  return `${ENV_SCOPE_UNKNOWN_MESSAGE} Configured scopes: ${shown.join(", ")}${more}.`;
}

export function selectProjectEnvValuesForExecutionTarget(opts: {
  readonly resolved: ProjectEnvResolvedConfig;
  readonly scopeName?: string | null;
  readonly target: "host" | "compose";
}): Record<string, string> {
  const selected = selectProjectEnvValues({
    resolved: opts.resolved,
    scopeName: opts.scopeName,
  });
  if (opts.target !== "host") {
    return selected;
  }
  const scopeName = normalizeProjectEnvScopeName({
    scopeName: opts.scopeName,
  });
  const hostTarget = Object.hasOwn(opts.resolved.hostTargetEnv, scopeName)
    ? opts.resolved.hostTargetEnv[scopeName]
    : undefined;
  return { ...(hostTarget ?? selected) };
}

export function isValidProjectEnvScopeName(opts: {
  readonly scopeName: string;
}): boolean {
  return (
    opts.scopeName === "global" ||
    PROJECT_ENV_SCOPE_PATTERN.test(opts.scopeName)
  );
}

export function normalizeProjectEnvScopeName(opts: {
  readonly scopeName?: string | null;
}): string {
  const scopeName = opts.scopeName?.trim() ?? "";
  return scopeName.length === 0 ? "global" : scopeName;
}

/**
 * Returns the normalized scope (`global` when empty), or refuses with the
 * fixed, value-free `ENV_SCOPE_INVALID_MESSAGE` as a `ClosedCliError`.
 */
export function assertValidProjectEnvScopeName(opts: {
  readonly scopeName?: string | null;
}): string {
  const scopeName = normalizeProjectEnvScopeName({
    scopeName: opts.scopeName,
  });
  if (!isValidProjectEnvScopeName({ scopeName })) {
    throw new ClosedCliError(ENV_SCOPE_INVALID_MESSAGE);
  }
  return scopeName;
}

type ProjectEnvConfigReadResult = {
  readonly path: string;
  readonly exists: boolean;
  readonly config: ProjectEnvConfig;
  readonly parseError?: string;
};

type ProjectEnvMutationResult = {
  readonly filePath: string;
  readonly scope: string;
  readonly createdKey: boolean;
  readonly changed: boolean;
  readonly local: boolean;
};

type ProjectEnvStateFile = {
  readonly version: number;
  readonly selectedOverlay: string | null;
  readonly selectedService: string | null;
  readonly generatedAt: string;
  readonly inputs: Readonly<Record<string, string>>;
};

export type ProjectEnvMaterializationInspection = {
  readonly envPath: string;
  readonly statePath: string;
  readonly status: "ok" | "warn";
  readonly message: string;
  readonly issues: readonly string[];
};

function defaultProjectEnvConfig(opts: {
  readonly environment: string;
}): ProjectEnvConfig {
  return {
    version: PROJECT_ENV_CONFIG_VERSION,
    environment: opts.environment,
    secretsprovider: PROJECT_ENV_SECRETS_PROVIDER,
    values: {
      global: {},
    },
  };
}

export function resolveProjectEnvConfigPath(opts: {
  readonly projectDir: string;
  readonly envName: string | null;
}): string {
  if (opts.envName === null) {
    return resolve(opts.projectDir, PROJECT_ENV_CONFIG_DEFAULT_FILENAME);
  }
  return resolve(
    opts.projectDir,
    `${PROJECT_ENV_CONFIG_FILENAME_PREFIX}${opts.envName}${PROJECT_ENV_CONFIG_FILENAME_SUFFIX}`
  );
}

export function resolveProjectEnvLocalConfigPath(opts: {
  readonly projectDir: string;
  readonly envName: string | null;
}): string {
  if (opts.envName === null) {
    return resolve(
      opts.projectDir,
      `${PROJECT_ENV_CONFIG_FILENAME_PREFIX}${PROJECT_ENV_LOCAL_SEGMENT}${PROJECT_ENV_CONFIG_FILENAME_SUFFIX}`
    );
  }
  return resolve(
    opts.projectDir,
    `${PROJECT_ENV_CONFIG_FILENAME_PREFIX}${opts.envName}.${PROJECT_ENV_LOCAL_SEGMENT}${PROJECT_ENV_CONFIG_FILENAME_SUFFIX}`
  );
}

function resolveProjectEnvLegacyCompatibleLocalDefaultConfigPath(opts: {
  readonly projectDir: string;
}): string {
  return resolve(
    opts.projectDir,
    `${PROJECT_ENV_CONFIG_FILENAME_PREFIX}default.${PROJECT_ENV_LOCAL_SEGMENT}${PROJECT_ENV_CONFIG_FILENAME_SUFFIX}`
  );
}

export function resolveProjectEnvKeyPath(opts: {
  readonly projectRoot: string;
}): string {
  return resolve(opts.projectRoot, PROJECT_ENV_KEY_FILENAME);
}

export type ProjectEnvSharedKeyLocation = {
  /** Absolute path of the shared key file under the git common dir (may not exist yet). */
  readonly path: string;
  /** True when the checkout is a linked worktree (worktree git dir differs from the common dir). */
  readonly linkedWorktree: boolean;
};

/**
 * Resolves the shared key LOCATION for the repo family that contains
 * `projectRoot`, regardless of whether the key file exists yet.
 * Returns null when git is unavailable or the path is not a git checkout.
 */
export async function resolveProjectEnvSharedKeyLocation(opts: {
  readonly projectRoot: string;
}): Promise<ProjectEnvSharedKeyLocation | null> {
  const [commonDir, worktreeDir] = await Promise.all([
    resolveGitRepositoryIdentity({
      repoRoot: opts.projectRoot,
    }),
    resolveGitWorktreeDir({
      repoRoot: opts.projectRoot,
    }),
  ]);
  if (!(commonDir && worktreeDir)) {
    return null;
  }
  return {
    path: resolve(commonDir, PROJECT_ENV_KEY_FILENAME),
    linkedWorktree: commonDir !== worktreeDir,
  };
}

export async function resolveProjectEnvSharedKeyPath(opts: {
  readonly projectRoot: string;
}): Promise<string | null> {
  const location = await resolveProjectEnvSharedKeyLocation({
    projectRoot: opts.projectRoot,
  });
  if (!location) {
    return null;
  }
  if (location.linkedWorktree) {
    return location.path;
  }
  return (await pathExists(location.path)) ? location.path : null;
}

/**
 * Ensures the committed, hack-owned `.hack/.gitignore` exists and carries the
 * canonical managed block for machine-local generated files (`.internal/`,
 * `.branch/`, `.env`, `.env.state.json`, `hack.env*.local.yaml`).
 *
 * The file is meant to be committed, so fresh clones and linked worktrees
 * inherit the ignore rules with zero setup. User lines outside the managed
 * markers are preserved; see `mergeManagedGitignoreBlock` for the merge
 * scheme. Called only from explicit commands: `hack init`, `hack doctor
 * --fix`, and machine-local env writes (`hack env set --local`,
 * `hack env hydrate`). Runtime commands never call it; they use
 * `ensureHackGitInfoExclude` so they do not change the working tree.
 *
 * No-follow: the file is read with O_NOFOLLOW and replaced through an
 * exclusive, no-follow temp file and a rename, keeping its mode (0644 when
 * new). A symlinked or non-regular `.gitignore`, or a symlinked project dir,
 * throws {@link HackDirGitignoreRefusalError} before anything is written, so a
 * planted link can never redirect the write outside the project. Ancestors
 * above the project dir are not inspected.
 *
 * Read-only is respected (the same policy as `ensureHackGitInfoExclude` for
 * `info/exclude`): an existing file that needs an update but that the user
 * cannot write (for example mode 0444) is left unchanged instead of being
 * replaced through the rename, which would only need a writable directory.
 * The result then has `readOnly: true` and `changed: false`; nothing throws,
 * so callers decide how to report it. A file that is already current is
 * never probed. See {@link isHackDirGitignoreWritable} for how read-only is
 * decided, including for root.
 */
export async function ensureHackDirGitignore(opts: {
  readonly projectDir: string;
  /** Test seam; see {@link HackDirGitignoreWriteAccess}. */
  readonly checkWriteAccess?: HackDirGitignoreWriteAccess;
}): Promise<HackDirGitignoreEnsureResult> {
  await assertLegacyProjectDirectory({ projectDir: opts.projectDir });
  await ensureDirForWrite(opts.projectDir);
  await assertLegacyProjectDirectory({ projectDir: opts.projectDir });
  const options = hackDirGitignoreFileOptions({ projectDir: opts.projectDir });
  const current = await readReplaceablePrivateFile(options);
  const next = mergeHackDirGitignore({ existing: current?.text ?? null });
  if (current?.text === next) {
    return { changed: false, readOnly: false };
  }
  if (
    current &&
    !(await isHackDirGitignoreWritable({
      path: options.path,
      mode: current.mode,
      checkWriteAccess: opts.checkWriteAccess,
    }))
  ) {
    return { changed: false, readOnly: true };
  }
  await replacePrivateFileAtomic({
    ...options,
    text: next,
    mode: current ? current.mode & 0o777 : 0o644,
  });
  return { changed: true, readOnly: false };
}

/**
 * Outcome of {@link ensureHackDirGitignore}. `readOnly` is true only when an
 * existing file lacked the managed block and was left unchanged because the
 * user cannot write it.
 */
export type HackDirGitignoreEnsureResult = {
  readonly changed: boolean;
  readonly readOnly: boolean;
};

/** Error codes that mean the user may not write the file. */
const HACK_DIR_GITIGNORE_READ_ONLY_CODES: ReadonlySet<string> = new Set([
  "EACCES",
  "EPERM",
  "EROFS",
]);

/**
 * Write-permission probe for an existing `.hack/.gitignore`: resolves when the
 * user may write the path, rejects with the `access(2)` error otherwise.
 * Production uses `access(path, W_OK)`. Tests inject a probe that always
 * resolves to model root, whose `access(2)` ignores mode bits.
 */
export type HackDirGitignoreWriteAccess = (path: string) => Promise<void>;

const accessHackDirGitignoreForWrite: HackDirGitignoreWriteAccess = (path) =>
  access(path, constants.W_OK);

/** Permission bits that grant write access to owner, group or others. */
const ANY_WRITE_PERMISSION_BITS = 0o222;

/**
 * Whether the user may write the existing `.hack/.gitignore`.
 *
 * Policy: a file with no write permission bit at all (for example mode 0444)
 * is read-only for every user, root included. `access(2)` alone cannot decide
 * this, because it grants root write access whatever the mode, so a 0444 file
 * would be replaced under `sudo` or in a root container. `mode` is the one the
 * caller read with the file. When some write bit is set, `access(2)` decides,
 * so a file that only another user or group may write stays read-only for
 * this user.
 *
 * Only a permission check: `access(2)` resolves a final symlink, but the
 * caller has just read the path as a regular file without following links,
 * and the write that this gates refuses a symlink again on its own. So a link
 * swapped in between can only skip the write, never redirect it. A file that
 * vanished counts as writable (the replace recreates it).
 */
async function isHackDirGitignoreWritable(opts: {
  readonly path: string;
  readonly mode: number;
  readonly checkWriteAccess?: HackDirGitignoreWriteAccess;
}): Promise<boolean> {
  if ((opts.mode & ANY_WRITE_PERMISSION_BITS) === 0) {
    return false;
  }
  const checkWriteAccess =
    opts.checkWriteAccess ?? accessHackDirGitignoreForWrite;
  try {
    await checkWriteAccess(opts.path);
    return true;
  } catch (error: unknown) {
    if (!(isRecord(error) && typeof error.code === "string")) {
      throw error;
    }
    if (error.code === "ENOENT") {
      return true;
    }
    if (HACK_DIR_GITIGNORE_READ_ONLY_CODES.has(error.code)) {
      return false;
    }
    throw error;
  }
}

/** Fixed, value-free warning for a read-only, outdated `.hack/.gitignore`. */
export const HACK_DIR_GITIGNORE_READ_ONLY_WARNING =
  ".hack/.gitignore is read-only and lacks Hack's current managed block, so Hack left it unchanged. Make it writable (chmod u+w .hack/.gitignore), then run 'hack doctor --fix' and commit it.";

/**
 * {@link ensureHackDirGitignore} for machine-local env writes (`hack env set
 * --local`, `hack env hydrate`). A read-only file does not fail the command:
 * it is left unchanged and reported once with
 * {@link HACK_DIR_GITIGNORE_READ_ONLY_WARNING}. Refusals still throw.
 *
 * The warning is written straight to stderr as `WARN: <message>` (like the
 * env key warnings), never through the UI logger: its clack backend prints to
 * stdout, and `hack env hydrate --json` must keep stdout pure JSON.
 */
async function ensureHackDirGitignoreForLocalEnvWrite(opts: {
  readonly projectDir: string;
}): Promise<void> {
  const result = await ensureHackDirGitignore({ projectDir: opts.projectDir });
  if (result.readOnly) {
    process.stderr.write(`WARN: ${HACK_DIR_GITIGNORE_READ_ONLY_WARNING}\n`);
  }
}

/** Fixed, value-free message of {@link HackDirGitignoreRefusalError}. */
export const HACK_DIR_GITIGNORE_REFUSAL =
  "Refused .hack/.gitignore access: the file or its .hack directory is a symlink or not a regular file. Replace it with a regular file or directory and retry.";

/**
 * Refusal to read or write `.hack/.gitignore` through a symlink or a
 * non-regular entry (for example a directory). Names no path or contents.
 * Closed with `E_PATH_CONFLICT`: the CLI prints it as one `CODE: message`
 * line, never with a stack, and `--json` reports the same code.
 */
export class HackDirGitignoreRefusalError extends HackCliError {
  constructor() {
    super({ code: "E_PATH_CONFLICT", message: HACK_DIR_GITIGNORE_REFUSAL });
    this.name = "HackDirGitignoreRefusalError";
  }
}

function hackDirGitignoreFileOptions(opts: {
  readonly projectDir: string;
}): ReplaceablePrivateFileOptions {
  return {
    path: resolve(opts.projectDir, ".gitignore"),
    directories: [resolve(opts.projectDir)],
    refusal: () => new HackDirGitignoreRefusalError(),
  };
}

function mergeHackDirGitignore(opts: {
  readonly existing: string | null;
}): string {
  return mergeManagedGitignoreBlock({
    existing: opts.existing,
    beginMarker: HACK_DIR_GITIGNORE_BEGIN_MARKER,
    endMarker: HACK_DIR_GITIGNORE_END_MARKER,
    entries: HACK_DIR_GITIGNORE_ENTRIES,
  });
}

/**
 * State of the committed `.hack/.gitignore`, for `hack doctor`:
 * - `current`: it carries the canonical managed block
 * - `missing`: the file does not exist (for example, a project initialized by
 *   an earlier Hack version)
 * - `outdated`: it exists without the canonical managed block
 * - `unsafe`: the file is a symlink or not a regular file, or the project dir
 *   is a symlink; `--fix` never writes through it
 * - `read-only`: it exists without the canonical managed block and the user
 *   cannot write it (for example mode 0444); `--fix` leaves it alone
 * - `unreadable`: it exists but cannot be read; `--fix` leaves it alone
 *
 * Read-only and no-follow: never writes, never reads through a symlink.
 * `ensureHackDirGitignore` applies the repair.
 */
export type HackDirGitignoreState =
  | "current"
  | "missing"
  | "outdated"
  | "read-only"
  | "unsafe"
  | "unreadable";

export async function inspectHackDirGitignore(opts: {
  readonly projectDir: string;
  /** Test seam; see {@link HackDirGitignoreWriteAccess}. */
  readonly checkWriteAccess?: HackDirGitignoreWriteAccess;
}): Promise<HackDirGitignoreState> {
  const options = hackDirGitignoreFileOptions({ projectDir: opts.projectDir });
  let current: Awaited<ReturnType<typeof readReplaceablePrivateFile>>;
  try {
    current = await readReplaceablePrivateFile(options);
  } catch (error: unknown) {
    return error instanceof HackDirGitignoreRefusalError
      ? "unsafe"
      : "unreadable";
  }
  if (current === null) {
    return "missing";
  }
  if (mergeHackDirGitignore({ existing: current.text }) === current.text) {
    return "current";
  }
  try {
    return (await isHackDirGitignoreWritable({
      path: options.path,
      mode: current.mode,
      checkWriteAccess: opts.checkWriteAccess,
    }))
      ? "outdated"
      : "read-only";
  } catch {
    return "unreadable";
  }
}

function toGitRelativePath(opts: {
  readonly projectRoot: string;
  readonly path: string;
}): string {
  return relative(opts.projectRoot, opts.path).split("\\").join("/");
}

async function isGitTrackedProjectEnvPath(opts: {
  readonly projectRoot: string;
  readonly path: string;
}): Promise<boolean | null> {
  const relativePath = toGitRelativePath(opts);
  let proc: Bun.Subprocess<"ignore", "ignore", "ignore">;
  try {
    proc = Bun.spawn({
      cmd: [
        "git",
        "-C",
        opts.projectRoot,
        "ls-files",
        "--error-unmatch",
        "--",
        relativePath,
      ],
      stderr: "ignore",
      stdin: "ignore",
      stdout: "ignore",
    });
  } catch {
    return null;
  }

  const exitCode = await proc.exited;
  if (exitCode === 0) {
    return true;
  }
  if (exitCode === 1) {
    return false;
  }
  return null;
}

/**
 * Whether git's ignore rules (`.gitignore` files, `.git/info/exclude`,
 * `core.excludesFile`) match `path`, whether or not it is tracked
 * (`check-ignore --no-index`). Null when git is unavailable or `projectRoot`
 * is not inside a work tree, where nothing can be committed.
 */
export async function isGitIgnoredProjectEnvPath(opts: {
  readonly projectRoot: string;
  readonly path: string;
}): Promise<boolean | null> {
  let proc: Bun.Subprocess<"ignore", "ignore", "ignore">;
  try {
    proc = Bun.spawn({
      cmd: [
        "git",
        "-C",
        opts.projectRoot,
        "check-ignore",
        "-q",
        "--no-index",
        "--",
        toGitRelativePath(opts),
      ],
      stderr: "ignore",
      stdin: "ignore",
      stdout: "ignore",
    });
  } catch {
    return null;
  }

  const exitCode = await proc.exited;
  if (exitCode === 0) {
    return true;
  }
  if (exitCode === 1) {
    return false;
  }
  return null;
}

/**
 * Whether `startDir` or an ancestor holds a `.git` entry (directory, linked
 * worktree file or symlink), or `GIT_DIR` points git elsewhere. It does not ask
 * git, so it still answers when git itself refuses to run in the checkout.
 */
async function isInsideGitCheckoutMarker(opts: {
  readonly startDir: string;
}): Promise<boolean> {
  if ((process.env.GIT_DIR ?? "").trim().length > 0) {
    return true;
  }
  let current = resolve(opts.startDir);
  while (true) {
    const marker = await lstat(resolve(current, ".git")).catch(() => null);
    if (marker !== null) {
      return true;
    }
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

async function hasLegacyLocalEnvironment(opts: {
  readonly path: string;
}): Promise<boolean> {
  const text = await readTextFile(opts.path);
  if (text === null) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch {
    return false;
  }
  if (!isRecord(parsed)) {
    return false;
  }
  return getString(parsed, "environment") === "local";
}

async function isLegacyTrackedLocalOverlay(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
}): Promise<boolean> {
  const localDefaultPath = resolveProjectEnvLocalConfigPath({
    projectDir: opts.projectDir,
    envName: null,
  });
  if (!(await pathExists(localDefaultPath))) {
    return false;
  }
  const tracked = await isGitTrackedProjectEnvPath({
    projectRoot: opts.projectRoot,
    path: localDefaultPath,
  });
  if (tracked !== null) {
    return tracked;
  }
  return await hasLegacyLocalEnvironment({
    path: localDefaultPath,
  });
}

async function resolveProjectEnvEffectiveLocalConfigPath(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly envName: string | null;
}): Promise<string> {
  if (opts.envName !== null) {
    return resolveProjectEnvLocalConfigPath({
      projectDir: opts.projectDir,
      envName: opts.envName,
    });
  }

  const legacyTrackedLocalOverlay = await isLegacyTrackedLocalOverlay({
    projectRoot: opts.projectRoot,
    projectDir: opts.projectDir,
  });
  if (legacyTrackedLocalOverlay) {
    return resolveProjectEnvLegacyCompatibleLocalDefaultConfigPath({
      projectDir: opts.projectDir,
    });
  }

  return resolveProjectEnvLocalConfigPath({
    projectDir: opts.projectDir,
    envName: null,
  });
}

function resolveProjectEnvStatePath(opts: {
  readonly projectDir: string;
}): string {
  return resolve(opts.projectDir, PROJECT_ENV_STATE_FILENAME);
}

export async function projectEnvConfigExists(opts: {
  readonly projectDir: string;
}): Promise<boolean> {
  const defaultPath = resolveProjectEnvConfigPath({
    projectDir: opts.projectDir,
    envName: null,
  });
  if (await pathExists(defaultPath)) {
    return true;
  }

  const entries = await readdir(opts.projectDir, { withFileTypes: true });
  return entries.some((entry) => {
    if (!entry.isFile()) {
      return false;
    }
    if (!entry.name.startsWith(PROJECT_ENV_CONFIG_FILENAME_PREFIX)) {
      return false;
    }
    if (!entry.name.endsWith(PROJECT_ENV_CONFIG_FILENAME_SUFFIX)) {
      return false;
    }
    return entry.name !== PROJECT_ENV_CONFIG_DEFAULT_FILENAME;
  });
}

/**
 * Closed refusal for a `.hack/hack.env.*.yaml` entry that is neither a regular
 * file nor a symlink to one: a dangling symlink, a link to a directory, a
 * directory or another special file. The message names the path and a fixed
 * remedy only; the CLI prints it as one `E_PATH_CONFLICT: message` line.
 */
export class ProjectEnvLayerPathConflictError extends HackCliError {
  readonly path: string;

  constructor(opts: { readonly path: string }) {
    super({
      code: "E_PATH_CONFLICT",
      message: `Refusing to choose the env format: ${opts.path} is not a regular file (for example a dangling symlink or a directory). Replace it with a regular env layer file or remove it, then retry.`,
    });
    this.name = "ProjectEnvLayerPathConflictError";
    this.path = opts.path;
  }
}

/**
 * The env-format decision of a command that writes either the env layers or
 * the legacy `.hack/.env` (`hack env set`, `hack env unset`).
 *
 * {@link projectEnvConfigExists} reads a dangling default layer, and any
 * symlinked overlay, as absent, so such a project would silently fall back to
 * the legacy file. Here every entry named like an env layer must be a regular
 * file or a symlink that resolves to one, and either counts as an env layer;
 * any other entry is refused with {@link ProjectEnvLayerPathConflictError}
 * before anything is read from stdin or written.
 */
export async function projectEnvConfigExistsForMutation(opts: {
  readonly projectDir: string;
}): Promise<boolean> {
  const entries = await readdir(opts.projectDir, { withFileTypes: true });
  let linkedLayer = false;
  for (const entry of entries) {
    if (
      entry.isFile() ||
      !entry.name.startsWith(PROJECT_ENV_CONFIG_FILENAME_PREFIX) ||
      !entry.name.endsWith(PROJECT_ENV_CONFIG_FILENAME_SUFFIX)
    ) {
      continue;
    }
    const path = resolve(opts.projectDir, entry.name);
    const target = await stat(path).catch(() => null);
    if (!target?.isFile()) {
      throw new ProjectEnvLayerPathConflictError({ path });
    }
    linkedLayer = true;
  }
  return linkedLayer || (await projectEnvConfigExists(opts));
}

export async function listProjectEnvOverlayNames(opts: {
  readonly projectDir: string;
}): Promise<readonly string[]> {
  const legacyTrackedLocalOverlay = await isLegacyTrackedLocalOverlay({
    projectRoot: dirname(opts.projectDir),
    projectDir: opts.projectDir,
  });
  const entries = await readdir(opts.projectDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => {
      if (name === PROJECT_ENV_CONFIG_DEFAULT_FILENAME) {
        return false;
      }
      return (
        name.startsWith(PROJECT_ENV_CONFIG_FILENAME_PREFIX) &&
        name.endsWith(PROJECT_ENV_CONFIG_FILENAME_SUFFIX)
      );
    })
    .map((name) =>
      name
        .slice(PROJECT_ENV_CONFIG_FILENAME_PREFIX.length)
        .slice(0, -PROJECT_ENV_CONFIG_FILENAME_SUFFIX.length)
    )
    .filter(
      (name) => name !== PROJECT_ENV_LOCAL_SEGMENT || legacyTrackedLocalOverlay
    )
    .filter((name) => !name.endsWith(`.${PROJECT_ENV_LOCAL_SEGMENT}`))
    .filter((name) => name.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

/** Strict planning reads distinguish missing paths from failed/non-file layers. */
/**
 * Read a selected layer for the CLI and runtime paths. Only an absent entry
 * (ENOENT on lstat) is an absent layer. An entry that exists but is not a
 * readable regular file (a dangling symlink, a link to a directory, a
 * directory, an unreadable file) refuses closed, so a broken layer never
 * makes a read silently fall back to the legacy `.hack/.env` format.
 */
async function readLenientProjectEnvLayerText(opts: {
  readonly path: string;
}): Promise<string | null> {
  const text = await readTextFile(opts.path);
  if (text !== null) {
    return text;
  }
  try {
    await lstat(opts.path);
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }
    throw new ClosedCliError(`Cannot read the env layer ${opts.path}.`);
  }
  const target = await stat(opts.path).catch(() => null);
  if (!target?.isFile()) {
    throw new ProjectEnvLayerPathConflictError({ path: opts.path });
  }
  throw new ClosedCliError(
    `Cannot read the env layer ${opts.path}. Check its permissions, then retry.`
  );
}

async function readProjectEnvLayerText(opts: {
  readonly path: string;
  readonly strictRead?: boolean;
}): Promise<string | null> {
  if (!opts.strictRead) {
    return await readLenientProjectEnvLayerText({ path: opts.path });
  }
  try {
    const selected = await stat(opts.path);
    if (!selected.isFile()) {
      throw new Error("Selected env layer is not a regular file");
    }
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") {
      try {
        await lstat(opts.path);
      } catch (entryError: unknown) {
        if (isRecord(entryError) && entryError.code === "ENOENT") {
          return null;
        }
        throw entryError;
      }
    }
    // A dangling link is an existing invalid layer, not an absent one.
    throw error;
  }
  // Preflight is not an atomic input fence; a failed read after it still refuses.
  return await Bun.file(opts.path).text();
}

async function readProjectEnvConfigFile(opts: {
  readonly path: string;
  readonly environment: string;
  readonly strictRead?: boolean;
}): Promise<ProjectEnvConfigReadResult> {
  const text = await readProjectEnvLayerText(opts);
  return parseProjectEnvConfigText({
    path: opts.path,
    environment: opts.environment,
    text,
  });
}

function parseProjectEnvConfigText(opts: {
  readonly path: string;
  readonly environment: string;
  readonly text: string | null;
}): ProjectEnvConfigReadResult {
  const text = opts.text;
  if (text === null) {
    return {
      path: opts.path,
      exists: false,
      config: defaultProjectEnvConfig({ environment: opts.environment }),
    };
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch (error: unknown) {
    return {
      path: opts.path,
      exists: true,
      config: defaultProjectEnvConfig({ environment: opts.environment }),
      parseError: error instanceof Error ? error.message : "Invalid YAML",
    };
  }

  const parsedConfig = parseProjectEnvConfig({
    parsed,
    environment: opts.environment,
  });
  if (!parsedConfig.ok) {
    return {
      path: opts.path,
      exists: true,
      config: defaultProjectEnvConfig({ environment: opts.environment }),
      parseError: parsedConfig.error,
    };
  }

  return {
    path: opts.path,
    exists: true,
    config: parsedConfig.config,
  };
}

function parseProjectEnvConfig(opts: {
  readonly parsed: unknown;
  readonly environment: string;
}):
  | { readonly ok: true; readonly config: ProjectEnvConfig }
  | { readonly ok: false; readonly error: string } {
  if (!isRecord(opts.parsed)) {
    return { ok: false, error: "Env config root must be an object." };
  }

  const version = opts.parsed.version;
  if (version !== PROJECT_ENV_CONFIG_VERSION) {
    return {
      ok: false,
      error: `Env config version must be ${PROJECT_ENV_CONFIG_VERSION}.`,
    };
  }

  const environment = getString(opts.parsed, "environment") ?? opts.environment;
  const secretsprovider = getString(opts.parsed, "secretsprovider");
  if (secretsprovider !== PROJECT_ENV_SECRETS_PROVIDER) {
    return {
      ok: false,
      error: `Env config secretsprovider must be "${PROJECT_ENV_SECRETS_PROVIDER}".`,
    };
  }

  const valuesRaw = getRecord(opts.parsed, "values");
  if (!valuesRaw) {
    return { ok: false, error: 'Env config "values" must be an object.' };
  }

  const values: ProjectEnvValuesByScope = {};
  for (const [scope, scopeRaw] of Object.entries(valuesRaw)) {
    if (!isValidProjectEnvScopeName({ scopeName: scope })) {
      return {
        ok: false,
        // The name is not echoed: it is file content and may hold a pasted
        // value or a line break, and this error is printed as one line.
        error:
          'Invalid env scope name; scopes must be "global" or match ^[a-z0-9][a-z0-9._-]*$.',
      };
    }
    if (!isRecord(scopeRaw)) {
      return {
        ok: false,
        error: `Env scope "${scope}" must be an object.`,
      };
    }

    const scopeValues: Record<string, ProjectEnvStoredValue> = {};
    for (const [key, valueRaw] of Object.entries(scopeRaw)) {
      if (!PROJECT_ENV_KEY_PATTERN.test(key)) {
        return {
          ok: false,
          // The scope is validated above; the key is not echoed because a
          // malformed entry may hold a pasted value.
          error: `Invalid env key in scope "${scope}"; keys must match ^[A-Z_][A-Z0-9_]*$.`,
        };
      }
      const normalizedValue = parseProjectEnvStoredValue({ valueRaw });
      if (!normalizedValue.ok) {
        return {
          ok: false,
          error: `Invalid value for "${scope}.${key}": ${normalizedValue.error}`,
        };
      }
      scopeValues[key] = normalizedValue.value;
    }
    values[scope] = scopeValues;
  }

  if (!("global" in values)) {
    values.global = {};
  }

  return {
    ok: true,
    config: {
      version: PROJECT_ENV_CONFIG_VERSION,
      environment,
      secretsprovider: PROJECT_ENV_SECRETS_PROVIDER,
      values,
    },
  };
}

function parseProjectEnvStoredValue(opts: {
  readonly valueRaw: unknown;
}):
  | { readonly ok: true; readonly value: ProjectEnvStoredValue }
  | { readonly ok: false; readonly error: string } {
  if (
    opts.valueRaw === null ||
    typeof opts.valueRaw === "string" ||
    typeof opts.valueRaw === "number" ||
    typeof opts.valueRaw === "boolean"
  ) {
    return { ok: true, value: opts.valueRaw };
  }

  if (isRecord(opts.valueRaw)) {
    const secure = getString(opts.valueRaw, "secure");
    if (typeof secure === "string" && secure.length > 0) {
      return { ok: true, value: { secure } };
    }
  }

  return {
    ok: false,
    error: "expected null, a scalar or { secure: <ciphertext> }",
  };
}

export async function resolveProjectEnvSelection(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly envName?: string | null;
}): Promise<ProjectEnvSelection> {
  const requestedEnv = opts.envName === undefined ? undefined : opts.envName;
  const defaultEnv = await readProjectDefaultEnvConfig({
    projectDir: opts.projectDir,
  });
  const effectiveEnv = requestedEnv === undefined ? defaultEnv : requestedEnv;
  const defaultPath = resolveProjectEnvConfigPath({
    projectDir: opts.projectDir,
    envName: null,
  });
  const localDefaultPath = await resolveProjectEnvEffectiveLocalConfigPath({
    projectRoot: opts.projectRoot,
    projectDir: opts.projectDir,
    envName: null,
  });
  const overlayPath =
    effectiveEnv === null
      ? null
      : resolveProjectEnvConfigPath({
          projectDir: opts.projectDir,
          envName: effectiveEnv,
        });
  const localOverlayPath =
    effectiveEnv === null
      ? null
      : resolveProjectEnvLocalConfigPath({
          projectDir: opts.projectDir,
          envName: effectiveEnv,
        });

  return {
    requestedEnv: requestedEnv ?? null,
    defaultEnv,
    effectiveEnv,
    defaultPath,
    overlayPath,
    overlayExists: overlayPath === null ? false : await pathExists(overlayPath),
    localDefaultPath,
    localDefaultExists: await pathExists(localDefaultPath),
    localOverlayPath,
    localOverlayExists:
      localOverlayPath === null ? false : await pathExists(localOverlayPath),
  };
}

/** Read the same ordered layers for injection and requested-key disclosure. */
async function readProjectEnvLayers(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly envName?: string | null;
  readonly strictRead?: boolean;
}) {
  const selection = await resolveProjectEnvSelection({
    projectRoot: opts.projectRoot,
    projectDir: opts.projectDir,
    envName: opts.envName,
  });

  const defaultRead = await readProjectEnvConfigFile({
    strictRead: opts.strictRead,
    path: selection.defaultPath,
    environment: "default",
  });
  const overlayRead =
    selection.overlayPath === null
      ? null
      : await readProjectEnvConfigFile({
          strictRead: opts.strictRead,
          path: selection.overlayPath,
          environment: selection.effectiveEnv ?? "default",
        });
  const localDefaultRead = await readProjectEnvConfigFile({
    strictRead: opts.strictRead,
    path: selection.localDefaultPath,
    environment: "default",
  });
  const localOverlayRead =
    selection.localOverlayPath === null
      ? null
      : await readProjectEnvConfigFile({
          strictRead: opts.strictRead,
          path: selection.localOverlayPath,
          environment: selection.effectiveEnv ?? "default",
        });

  const primaryDir = await resolvePrimaryLocalProjectDir(opts);
  const inheritedReads: ProjectEnvConfigReadResult[] = [];
  if (primaryDir !== null) {
    const primaryDefaultPath = await resolveProjectEnvEffectiveLocalConfigPath({
      projectRoot: dirname(primaryDir),
      projectDir: primaryDir,
      envName: null,
    });
    await validatePrimaryLocalFile(primaryDefaultPath);
    inheritedReads.push(
      await readProjectEnvConfigFile({
        strictRead: opts.strictRead,
        path: primaryDefaultPath,
        environment: "default",
      })
    );
    if (selection.effectiveEnv !== null) {
      const primaryOverlayPath = resolveProjectEnvLocalConfigPath({
        projectDir: primaryDir,
        envName: selection.effectiveEnv,
      });
      await validatePrimaryLocalFile(primaryOverlayPath);
      inheritedReads.push(
        await readProjectEnvConfigFile({
          strictRead: opts.strictRead,
          path: primaryOverlayPath,
          environment: selection.effectiveEnv,
        })
      );
    }
  }
  // Primary local settings are live inputs, subordinate to checkout-local choices.
  const reads = [
    defaultRead,
    overlayRead,
    ...inheritedReads,
    localDefaultRead,
    localOverlayRead,
  ];
  if (!reads.some((read) => read?.exists)) {
    return null;
  }
  for (const read of reads) {
    if (read?.parseError) {
      // The same closed, value-free line as the write path's refusal.
      throw new ClosedCliError(
        `Failed to parse ${read.path}: ${read.parseError}`
      );
    }
  }
  const envLayers = reads.map((read) => (read?.exists ? read.config : null));
  const merged = mergeProjectEnvConfigLayers({
    layers: envLayers,
    environment: selection.effectiveEnv ?? "default",
  });
  const files = [selection.defaultPath];
  if (selection.overlayPath && overlayRead?.exists) {
    files.push(selection.overlayPath);
  }
  for (const read of inheritedReads) {
    if (read.exists) {
      files.push(read.path);
    }
  }
  if (localDefaultRead.exists) {
    files.push(selection.localDefaultPath);
  }
  if (selection.localOverlayPath && localOverlayRead?.exists) {
    files.push(selection.localOverlayPath);
  }

  return { selection, envLayers, merged, files };
}

/**
 * Resolve only the requested winning entry, without decrypting unrelated values.
 * null means no modern config; { value: null } means a missing/deleted key.
 * Empty strings remain present. Reading never creates or materializes a key file.
 */
export async function resolveProjectEnvValue(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly envName?: string | null;
  readonly serviceNames: readonly string[];
  readonly scope?: string;
  readonly key: string;
}): Promise<{ readonly value: string | null } | null> {
  const layers = await readProjectEnvLayers(opts);
  if (!layers) {
    return null;
  }
  const scope = normalizeProjectEnvScopeName({ scopeName: opts.scope });
  if (
    scope !== "global" &&
    !opts.serviceNames.includes(scope) &&
    !Object.hasOwn(layers.merged.values, scope)
  ) {
    throw new ClosedCliError(
      unknownProjectEnvScopeMessage({
        configuredScopes: [
          ...opts.serviceNames,
          ...Object.keys(layers.merged.values),
        ],
      })
    );
  }
  const entries = resolveEffectiveStoredEntries({
    layers: layers.envLayers,
    scopeNames: scope === "global" ? ["global"] : ["global", scope],
  });
  const entry = Object.hasOwn(entries, opts.key)
    ? entries[opts.key]
    : undefined;
  if (!entry) {
    return { value: null };
  }
  const keyText = isProjectEnvSecretValue(entry.value)
    ? await resolveProjectEnvKey({
        projectRoot: opts.projectRoot,
        required: true,
      })
    : null;
  return {
    value: decryptProjectEnvStoredValue({ storedValue: entry.value, keyText }),
  };
}

type ProjectEnvResolveOptions = {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly envName?: string | null;
  readonly serviceNames: readonly string[];
};

type ProjectEnvLayers = NonNullable<
  Awaited<ReturnType<typeof readProjectEnvLayers>>
>;

/**
 * Plan modern env bindings without acquiring a key or decrypting any value.
 * Uses the same layers and target scopes as runtime injection. Omitted envName
 * selects the configured default; null bypasses it. null output means no modern
 * config, so callers can preserve their own legacy fallback. Errors intentionally
 * omit parser diagnostics because YAML errors may include stored value excerpts.
 * Selected env layer read failures refuse; only ENOENT means an absent layer.
 * Project selection retains legacy behavior. Paths and names are private metadata,
 * not a portable public plan or an atomic snapshot of configuration inputs.
 */
export async function resolveProjectEnvMetadata(
  opts: ProjectEnvResolveOptions
): Promise<ProjectEnvResolvedMetadata | null> {
  try {
    const layers = await readProjectEnvLayers({ ...opts, strictRead: true });
    return layers
      ? projectEnvProjection({ layers, serviceNames: opts.serviceNames })
          .metadata
      : null;
  } catch {
    throw new Error(
      "Cannot resolve project env metadata: selected configuration is invalid or unreadable."
    );
  }
}

export type NativeProjectEnvHostTargets = {
  readonly includeDefault: boolean;
  readonly workloadNames: readonly string[];
};

type EnvTargetMetadata = Readonly<
  Record<string, { readonly scope: string; readonly secret: boolean }>
>;

export type NativeProjectEnvHostMetadata = {
  readonly default?: EnvTargetMetadata;
  readonly workloads: Readonly<Record<string, EnvTargetMetadata>>;
};

/** Native planning carries names and winning scope/secret flags, never stored values. */
export type NativeProjectEnvMetadata = {
  readonly overlay: string | null;
  readonly overlayExists: boolean;
  readonly effectiveMetadata: EffectiveEnvMetadata;
  readonly unknownScopes: readonly string[];
  readonly hostMetadata?: NativeProjectEnvHostMetadata;
};

export type NativeProjectEnvSelectionOptions = {
  readonly projectRoot: string;
  readonly overlay: string | null;
  readonly inheritLocal: boolean;
  readonly declaredWorkloadNames: readonly string[];
  readonly hostTargets?: NativeProjectEnvHostTargets;
  readonly signal?: AbortSignal;
};

type NativeEnvTargetValues = Readonly<Record<string, string>>;

/** Values are private execution inputs; callers must never serialize them into plans or diagnostics. */
export type NativeProjectEnvResolvedConfig = NativeProjectEnvMetadata & {
  readonly globalEnv: NativeEnvTargetValues;
  readonly workloadEnv: Readonly<Record<string, NativeEnvTargetValues>>;
  readonly hostValues?: {
    readonly default?: NativeEnvTargetValues;
    readonly workloads: Readonly<Record<string, NativeEnvTargetValues>>;
  };
};

/** Private in-process execution capability; only its names-only metadata is serializable. */
export type NativeProjectEnvExecutionAcquisition = {
  readonly metadata: NativeProjectEnvMetadata;
  readonly resolveValues: (opts?: {
    readonly signal?: AbortSignal;
  }) => Promise<NativeProjectEnvResolvedConfig>;
  readonly assertFresh: (
    selection: NativeProjectEnvSelectionOptions
  ) => Promise<void>;
};

const legacyAdoptionEnvRevisions = new WeakMap<
  NativeProjectEnvExecutionAcquisition,
  string
>();
const PRIVATE_ENV_REVISION = /^[a-f0-9]{64}$/;

/** Private durable owner only. This is the revision of the initial metadata/value acquisition, never a report field. */
export function privateLegacyAdoptionEnvRevision(
  acquisition: NativeProjectEnvExecutionAcquisition
): string {
  const revision = legacyAdoptionEnvRevisions.get(acquisition);
  if (!revision) {
    throw redactLegacyAdoptionEnvError(undefined);
  }
  return revision;
}

/**
 * Raw-only saved-generation check through the identical bounded layer selector.
 * The durable owner must first verify its original source/checkout proof and
 * supply the root checker. This returns names-only metadata, never bytes, digest or values, and
 * never resolves a key or grants value-delivery/execution authority.
 */
export async function assertSavedLegacyAdoptionEnvRevision(opts: {
  readonly selection: NativeProjectEnvSelectionOptions;
  readonly revision: string;
  readonly inputOwner: ExplicitManagedEnvInputOwner;
}): Promise<NativeProjectEnvMetadata> {
  try {
    const { revision, selection: suppliedSelection, inputOwner } = opts;
    if (typeof revision !== "string" || !PRIVATE_ENV_REVISION.test(revision)) {
      throw nativeEnvRevisionError();
    }
    const selection = snapshotNativeEnvSelection(suppliedSelection);
    const recorded = nativeEnvRevisionRecorder();
    const selected = await readNativeProjectEnvSelection(
      selection,
      recorded.onAcquired,
      inputOwner
    );
    if (recorded.finish(selection, selected) !== revision) {
      throw nativeEnvRevisionError();
    }
    return readonlyNativeEnvMetadata(selected.metadata);
  } catch (error: unknown) {
    throw redactLegacyAdoptionEnvError(error);
  }
}

function nativeEnvRevisionError(): Error {
  return new Error(
    "Cannot use native managed env values: selected inputs changed or could not be rechecked; values omitted."
  );
}

function nativeEnvValuesError(): Error {
  return new Error(
    "Cannot resolve native managed env values: selected inputs or decryption key are missing, invalid, unreadable, unstable or oversized; values omitted."
  );
}

const NATIVE_ENV_DIAGNOSTIC_PROPERTY = "diagnosticCause";
const NATIVE_ENV_DIAGNOSTIC_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const NATIVE_ENV_DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const NATIVE_ENV_DIAGNOSTIC =
  /^[A-Za-z][A-Za-z0-9]{0,63}(?::[A-Z][A-Z0-9_]{0,63})?$/;

/**
 * Closed metadata refusal. It keeps only a value-free diagnostic of what failed:
 * the underlying error's class name and identifier-shaped code (for example
 * `HackCliError:E_CONFIG_INVALID` or `Error:ENOENT`), never its message, paths,
 * bytes or values. The diagnostic is a non-enumerable own property rather than
 * `cause`, so serializers, reports and the public message stay unchanged.
 */
function nativeEnvMetadataError(diagnostic = "NativeEnvMetadataError"): Error {
  const refusal = new Error(
    "Cannot resolve native managed env metadata: selected inputs are invalid, unreadable, unstable or oversized; values omitted."
  );
  Object.defineProperty(refusal, NATIVE_ENV_DIAGNOSTIC_PROPERTY, {
    value: diagnostic,
    enumerable: false,
  });
  return refusal;
}

/** Refuse with the cause's value-free diagnostic; a nested refusal keeps its own. */
function nativeEnvMetadataRefusal(cause: unknown): Error {
  return nativeEnvMetadataError(
    nativeEnvMetadataDiagnostic(cause) ?? valueFreeErrorDiagnostic(cause)
  );
}

function valueFreeErrorDiagnostic(error: unknown): string {
  if (!(error instanceof Error)) {
    return error === null ? "null" : typeof error;
  }
  const name = NATIVE_ENV_DIAGNOSTIC_NAME.test(error.name)
    ? error.name
    : "Error";
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" && NATIVE_ENV_DIAGNOSTIC_CODE.test(code)
    ? `${name}:${code}`
    : name;
}

/**
 * Read the value-free diagnostic of a native metadata refusal, for tests and
 * debugging. Returns undefined for any other error or a malformed diagnostic.
 */
export function nativeEnvMetadataDiagnostic(
  error: unknown
): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const diagnostic: unknown = Reflect.get(
    error,
    NATIVE_ENV_DIAGNOSTIC_PROPERTY
  );
  return typeof diagnostic === "string" &&
    NATIVE_ENV_DIAGNOSTIC.test(diagnostic)
    ? diagnostic
    : undefined;
}

function validateNativeHostTargets(
  value: unknown,
  declaredWorkloadNames: readonly string[]
): NativeProjectEnvHostTargets | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    typeof value.includeDefault !== "boolean" ||
    !Array.isArray(value.workloadNames)
  ) {
    throw nativeEnvMetadataError();
  }
  const declared = new Set(declaredWorkloadNames);
  const names: string[] = [];
  const seen = new Set<string>();
  for (const name of value.workloadNames) {
    if (
      typeof name !== "string" ||
      !NATIVE_ENV_WORKLOAD_PATTERN.test(name) ||
      !declared.has(name) ||
      seen.has(name)
    ) {
      throw nativeEnvMetadataError();
    }
    names.push(name);
    seen.add(name);
  }
  return { includeDefault: value.includeDefault, workloadNames: names };
}

/** Resolve only selected host baselines; scope precedence remains owned by the shared projection. */
function projectNativeHostMetadata(opts: {
  readonly targets: NativeProjectEnvHostTargets;
  readonly envLayers: readonly (ProjectEnvConfig | null)[];
  readonly projection: ReturnType<typeof projectEnvScopeProjection>;
  readonly guestResult: NativeProjectEnvMetadata;
  readonly signal?: AbortSignal;
}): NativeProjectEnvHostMetadata {
  const workloads: Record<string, EnvTargetMetadata> = {};
  let defaultMetadata: EnvTargetMetadata | undefined;
  // Charge the envelope and each returned map, including duplicate default/workload
  // baselines. Never build all host maps and then discover that expansion is too large.
  let bytes = Buffer.byteLength(
    JSON.stringify({ ...opts.guestResult, hostMetadata: { workloads: {} } })
  );
  const acquire = (name: string, scopeNames: readonly string[]) => {
    checkNativeEnvCancellation(opts.signal);
    const metadata = resolveMetadata({ layers: opts.envLayers, scopeNames });
    bytes += Buffer.byteLength(JSON.stringify({ [name]: metadata }));
    if (bytes > NATIVE_CONFIG_INPUT_LIMIT) {
      throw nativeEnvMetadataError();
    }
    return metadata;
  };
  if (opts.targets.includeDefault) {
    defaultMetadata = acquire("default", opts.projection.globalHostScopeNames);
  }
  const scopeNamesByWorkload = new Map(
    opts.projection.serviceTargets.map((target) => [
      target.serviceName,
      target.hostScopeNames,
    ])
  );
  for (const name of opts.targets.workloadNames) {
    const scopeNames = scopeNamesByWorkload.get(name);
    if (!scopeNames) {
      throw nativeEnvMetadataError();
    }
    workloads[name] = acquire(name, scopeNames);
  }
  return {
    ...(defaultMetadata === undefined ? {} : { default: defaultMetadata }),
    workloads,
  };
}

function checkNativeEnvCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new NativeConfigCompilerError(
      "E_COMPILER_CANCELLED",
      "Native managed env acquisition was cancelled."
    );
  }
}

/** Only the managed-env owner may observe these private acquired bytes. */
type NativeEnvAcquisitionObserver = (input: {
  readonly projectRoot: string;
  readonly filename: string;
  readonly bytes: Uint8Array | undefined;
}) => void;

type ExplicitManagedEnvInputOwner = {
  readonly assertRoot: (opts: {
    readonly projectRoot: string;
    readonly signal?: AbortSignal;
  }) => Promise<void>;
  readonly acquireFile: (opts: {
    readonly projectRoot: string;
    readonly filename: string;
    readonly signal?: AbortSignal;
  }) => Promise<Uint8Array | undefined>;
};
const nativeManagedEnvInputOwner: ExplicitManagedEnvInputOwner = {
  assertRoot: assertNativeProjectInputRoot,
  acquireFile: acquireNativeManagedEnvFile,
};

async function readNativeEnvLayer(opts: {
  readonly projectRoot: string;
  readonly filename: string;
  readonly environment: string;
  readonly signal?: AbortSignal;
  readonly onAcquired?: NativeEnvAcquisitionObserver;
  readonly inputOwner?: ExplicitManagedEnvInputOwner;
}): Promise<ProjectEnvConfig | null> {
  const bytes = await (
    opts.inputOwner ?? nativeManagedEnvInputOwner
  ).acquireFile(opts);
  checkNativeEnvCancellation(opts.signal);
  opts.onAcquired?.({
    projectRoot: opts.projectRoot,
    filename: opts.filename,
    bytes,
  });
  if (bytes === undefined) {
    return null;
  }
  return parseNativeEnvLayer({ bytes, environment: opts.environment });
}

function parseNativeEnvLayer(opts: {
  readonly bytes: Uint8Array;
  readonly environment: string;
}): ProjectEnvConfig {
  const parsed: unknown = YAML.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(opts.bytes)
  );
  const result = parseProjectEnvConfig({
    parsed,
    environment: opts.environment,
  });
  if (!result.ok) {
    throw nativeEnvMetadataError();
  }
  return result.config;
}

/** Preserve tracked local-overlay compatibility without reading legacy policy. */
async function readNativeLocalBase(opts: {
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
  readonly onAcquired?: NativeEnvAcquisitionObserver;
  readonly inputOwner?: ExplicitManagedEnvInputOwner;
}): Promise<ProjectEnvConfig | null> {
  const bytes = await (
    opts.inputOwner ?? nativeManagedEnvInputOwner
  ).acquireFile({
    ...opts,
    filename: "hack.env.local.yaml",
  });
  opts.onAcquired?.({
    projectRoot: opts.projectRoot,
    filename: "hack.env.local.yaml",
    bytes,
  });
  if (bytes === undefined) {
    return null;
  }
  const tracked = await isNativeManagedLocalTracked(opts);
  const local =
    tracked === true
      ? null
      : parseNativeEnvLayer({ bytes, environment: "default" });
  if (tracked ?? local?.environment === "local") {
    return await readNativeEnvLayer({
      ...opts,
      filename: "hack.env.default.local.yaml",
      environment: "default",
    });
  }
  return local;
}

/**
 * Resolve an explicit native selection through the existing managed-env owner.
 * Does not read legacy policy/defaults, dotenv, keys, or decrypt stored entries.
 * Only missing files are optional; selected files are bounded stable regular
 * files in unredirected native roots. This is not an atomic multi-file snapshot.
 * Unknown scopes remain names for diagnostics, not authorized workload targets.
 * Optional host targets select declared workloads, never host-process names.
 * Only requested host baselines are allocated, under a combined output budget.
 */
async function readNativeProjectEnvSelection(
  opts: NativeProjectEnvSelectionOptions,
  onAcquired?: NativeEnvAcquisitionObserver,
  inputOwner: ExplicitManagedEnvInputOwner = nativeManagedEnvInputOwner
) {
  checkNativeEnvCancellation(opts.signal);
  const overlayName = opts.overlay;
  const inheritLocal = opts.inheritLocal;
  const declaredWorkloadNames = [...opts.declaredWorkloadNames];
  if (
    overlayName !== null &&
    (typeof overlayName !== "string" ||
      !NATIVE_ENV_OVERLAY_PATTERN.test(overlayName))
  ) {
    throw nativeEnvMetadataError();
  }
  const hostTargets = validateNativeHostTargets(
    opts.hostTargets,
    declaredWorkloadNames
  );
  const projectRoot = resolve(opts.projectRoot);
  await inputOwner.assertRoot({ projectRoot, signal: opts.signal });
  let primaryRoot: string | null = null;
  if (shouldInheritPrimaryLocalInputs({ inheritLocal })) {
    primaryRoot = await resolveVerifiedPrimaryWorktreeRoot({
      projectRoot,
      signal: opts.signal,
    });
    if (primaryRoot) {
      await inputOwner.assertRoot({
        projectRoot: primaryRoot,
        signal: opts.signal,
      });
    }
  }
  const read = (root: string, envName: string | null, local: boolean) => {
    const projectDir = resolve(root, HACK_PROJECT_DIR_PRIMARY);
    return readNativeEnvLayer({
      projectRoot: root,
      filename: basename(
        local
          ? resolveProjectEnvLocalConfigPath({ projectDir, envName })
          : resolveProjectEnvConfigPath({ projectDir, envName })
      ),
      environment: envName ?? "default",
      signal: opts.signal,
      onAcquired,
      inputOwner,
    });
  };
  const base = await read(projectRoot, null, false);
  const overlay =
    overlayName === null ? null : await read(projectRoot, overlayName, false);
  const envLayers = [
    base,
    overlay,
    primaryRoot
      ? await readNativeLocalBase({
          projectRoot: primaryRoot,
          signal: opts.signal,
          onAcquired,
          inputOwner,
        })
      : null,
    primaryRoot && overlayName !== null
      ? await read(primaryRoot, overlayName, true)
      : null,
    await readNativeLocalBase({
      projectRoot,
      signal: opts.signal,
      onAcquired,
      inputOwner,
    }),
    overlayName === null ? null : await read(projectRoot, overlayName, true),
  ];
  const merged = mergeProjectEnvConfigLayers({
    layers: envLayers,
    environment: overlayName ?? "default",
  });
  const projection = projectEnvScopeProjection({
    layers: { envLayers, merged },
    serviceNames: declaredWorkloadNames,
    metadataByteLimit: NATIVE_CONFIG_INPUT_LIMIT,
    includeHostMetadata: false,
  });
  const guestResult: NativeProjectEnvMetadata = {
    overlay: overlayName,
    overlayExists: overlay !== null,
    effectiveMetadata: envLayers.some((layer) => layer !== null)
      ? projection.metadata.effectiveMetadata
      : {},
    unknownScopes: projection.metadata.unknownScopes,
  };
  const result: NativeProjectEnvMetadata =
    hostTargets === undefined
      ? guestResult
      : {
          ...guestResult,
          hostMetadata: projectNativeHostMetadata({
            targets: hostTargets,
            envLayers,
            projection,
            guestResult,
            signal: opts.signal,
          }),
        };
  if (Buffer.byteLength(JSON.stringify(result)) > NATIVE_CONFIG_INPUT_LIMIT) {
    throw nativeEnvMetadataError();
  }
  await inputOwner.assertRoot({ projectRoot, signal: opts.signal });
  if (primaryRoot) {
    await inputOwner.assertRoot({
      projectRoot: primaryRoot,
      signal: opts.signal,
    });
  }
  checkNativeEnvCancellation(opts.signal);
  return {
    projectRoot,
    primaryRoot,
    envLayers,
    projection,
    metadata: result,
    declaredWorkloadNames,
    hostTargets,
    inputOwner,
  };
}

/** Resolve native names and winning scope/secret flags without acquiring any key or decrypting values. */
export async function resolveProjectEnvMetadataForNativeSelection(
  opts: NativeProjectEnvSelectionOptions
): Promise<NativeProjectEnvMetadata> {
  try {
    return (await readNativeProjectEnvSelection(opts)).metadata;
  } catch (error: unknown) {
    if (
      error instanceof NativeConfigCompilerError &&
      error.code === "E_COMPILER_CANCELLED"
    ) {
      throw error;
    }
    throw nativeEnvMetadataRefusal(error);
  }
}

/**
 * Deliver values for an explicit native selection through the managed-env owner.
 * Shares bounded layer acquisition and scope precedence with metadata planning;
 * does not read legacy config/defaults, dotenv or materialized state. Only declared
 * workloads and requested host baselines receive values. Reads never create keys.
 * Acquisition is not an atomic execution-admission fence: callers own that fence
 * and the lifetime and disclosure protection of these private execution inputs.
 */
export async function resolveProjectEnvConfigForNativeSelection(
  opts: NativeProjectEnvSelectionOptions
): Promise<NativeProjectEnvResolvedConfig> {
  try {
    return await resolveNativeProjectEnvValues({
      selected: await readNativeProjectEnvSelection(opts),
      signal: opts.signal,
    });
  } catch (error: unknown) {
    if (
      error instanceof NativeConfigCompilerError &&
      error.code === "E_COMPILER_CANCELLED"
    ) {
      throw error;
    }
    throw nativeEnvValuesError();
  }
}

async function resolveNativeProjectEnvValues(opts: {
  readonly selected: Awaited<ReturnType<typeof readNativeProjectEnvSelection>>;
  readonly signal?: AbortSignal;
}): Promise<NativeProjectEnvResolvedConfig> {
  try {
    const { selected } = opts;
    const scopes = new Map(
      selected.projection.serviceTargets.map((target) => [
        target.serviceName,
        target,
      ])
    );
    const guestTargets = selected.declaredWorkloadNames.map((name) => {
      if (!NATIVE_ENV_WORKLOAD_PATTERN.test(name)) {
        throw nativeEnvValuesError();
      }
      const target = scopes.get(name);
      if (!target) {
        throw nativeEnvValuesError();
      }
      return target;
    });
    const requestedScopes = [
      ["global"],
      ...guestTargets.map((target) => target.composeScopeNames),
      ...(selected.hostTargets?.includeDefault
        ? [selected.projection.globalHostScopeNames]
        : []),
      ...(selected.hostTargets?.workloadNames ?? []).map((name) => {
        const target = scopes.get(name);
        if (!target) {
          throw nativeEnvValuesError();
        }
        return target.hostScopeNames;
      }),
    ];
    const required = requestedScopes.some((scopeNames) =>
      Object.values(
        resolveEffectiveStoredEntries({
          layers: selected.envLayers,
          scopeNames,
        })
      ).some((entry) => isProjectEnvSecretValue(entry.value))
    );
    const keyText = required
      ? await resolveProjectEnvKey({
          projectRoot: selected.projectRoot,
          required: true,
          nativeSelection: { signal: opts.signal },
        })
      : null;
    const workloadEnv: Record<string, NativeEnvTargetValues> = {};
    let bytes = Buffer.byteLength(
      JSON.stringify({
        ...selected.metadata,
        globalEnv: {},
        workloadEnv: {},
        ...(selected.hostTargets ? { hostValues: { workloads: {} } } : {}),
      })
    );
    const values = (name: string, scopeNames: readonly string[]) => {
      checkNativeEnvCancellation(opts.signal);
      const result: Record<string, string> = {};
      bytes += Buffer.byteLength(JSON.stringify({ [name]: {} }));
      const entries = resolveEffectiveStoredEntries({
        layers: selected.envLayers,
        scopeNames,
      });
      for (const [key, entry] of Object.entries(entries)) {
        checkNativeEnvCancellation(opts.signal);
        const value = decryptProjectEnvStoredValue({
          storedValue: entry.value,
          keyText,
        });
        bytes += Buffer.byteLength(JSON.stringify({ [key]: value }));
        if (bytes > NATIVE_CONFIG_INPUT_LIMIT) {
          throw nativeEnvValuesError();
        }
        result[key] = value;
      }
      if (bytes > NATIVE_CONFIG_INPUT_LIMIT) {
        throw nativeEnvValuesError();
      }
      return result;
    };
    const globalEnv = values("globalEnv", ["global"]);
    for (const target of guestTargets) {
      workloadEnv[target.serviceName] = values(
        target.serviceName,
        target.composeScopeNames
      );
    }
    const hostValues = resolveNativeHostValues({
      targets: selected.hostTargets,
      projection: selected.projection,
      values,
    });
    await selected.inputOwner.assertRoot({
      projectRoot: selected.projectRoot,
      signal: opts.signal,
    });
    if (selected.primaryRoot) {
      await selected.inputOwner.assertRoot({
        projectRoot: selected.primaryRoot,
        signal: opts.signal,
      });
    }
    checkNativeEnvCancellation(opts.signal);
    return {
      ...selected.metadata,
      globalEnv,
      workloadEnv,
      ...(hostValues === undefined ? {} : { hostValues }),
    };
  } catch (error: unknown) {
    if (
      error instanceof NativeConfigCompilerError &&
      error.code === "E_COMPILER_CANCELLED"
    ) {
      throw error;
    }
    throw nativeEnvValuesError();
  }
}

function snapshotNativeEnvSelection(
  opts: NativeProjectEnvSelectionOptions
): NativeProjectEnvSelectionOptions {
  const declaredWorkloadNames = Object.freeze([...opts.declaredWorkloadNames]);
  const targets = validateNativeHostTargets(
    opts.hostTargets,
    declaredWorkloadNames
  );
  return Object.freeze({
    projectRoot: resolve(opts.projectRoot),
    overlay: opts.overlay,
    inheritLocal: opts.inheritLocal,
    declaredWorkloadNames,
    signal: opts.signal,
    ...(targets === undefined
      ? {}
      : {
          hostTargets: Object.freeze({
            includeDefault: targets.includeDefault,
            workloadNames: Object.freeze([...targets.workloadNames]),
          }),
        }),
  });
}

/** Fingerprints remain inside this owner; no digest is placed on a public object. */
function nativeEnvRevisionRecorder() {
  const revision = createHash("sha256");
  const onAcquired: NativeEnvAcquisitionObserver = ({
    projectRoot,
    filename,
    bytes,
  }) => {
    revision
      .update(JSON.stringify([projectRoot, filename, bytes?.length ?? null]))
      .update("\0");
    if (bytes !== undefined) {
      revision.update(bytes);
    }
    revision.update("\0");
  };
  const finish = (
    selection: NativeProjectEnvSelectionOptions,
    selected: Awaited<ReturnType<typeof readNativeProjectEnvSelection>>
  ) => {
    revision.update(
      JSON.stringify({
        projectRoot: selected.projectRoot,
        primaryRoot: selected.primaryRoot,
        overlay: selection.overlay,
        inheritLocal: selection.inheritLocal,
        declaredWorkloadNames: selection.declaredWorkloadNames,
        hostTargets: selection.hostTargets ?? null,
      })
    );
    return revision.digest("hex");
  };
  return { onAcquired, finish };
}

/** Freeze only owner-created acyclic metadata/value objects, never caller inputs. */
function freezeNativeEnvOwnedValue(value: unknown): void {
  if (!(isRecord(value) || Array.isArray(value))) {
    return;
  }
  for (const entry of Object.values(value)) {
    freezeNativeEnvOwnedValue(entry);
  }
  Object.freeze(value);
}

function readonlyNativeEnvMetadata(
  metadata: NativeProjectEnvMetadata
): NativeProjectEnvMetadata {
  const result = structuredClone(metadata);
  freezeNativeEnvOwnedValue(result);
  return result;
}

function redactNativeEnvRevisionError(error: unknown): Error {
  return error instanceof NativeConfigCompilerError &&
    error.code === "E_COMPILER_CANCELLED"
    ? error
    : nativeEnvRevisionError();
}

/**
 * Acquire one private env generation for metadata planning and later value delivery.
 * Raw bytes, missing-file presence and selected roots/targets are bound privately;
 * metadata and values come from the same bounded acquisition. Methods are omitted
 * from enumeration and JSON. Call assertFresh with the current validated selection
 * immediately before each effect. Rechecks do not freeze concurrent external editors.
 */
export async function acquireProjectEnvForNativeExecution(
  opts: NativeProjectEnvSelectionOptions
): Promise<NativeProjectEnvExecutionAcquisition> {
  return await acquireExplicitProjectEnvExecution({
    selection: opts,
    inputOwner: nativeManagedEnvInputOwner,
  });
}

/** A replacement invocation signal cannot revive a cancelled legacy acquisition. */
function retainedEnvSignal(
  captured: AbortSignal | undefined,
  supplied: AbortSignal | undefined
): AbortSignal | undefined {
  return captured && supplied
    ? AbortSignal.any([captured, supplied])
    : (supplied ?? captured);
}

/** Metadata, revision and delivery share one raw-layer acquisition under the admitted input owner. */
async function acquireExplicitProjectEnvExecution(opts: {
  readonly selection: NativeProjectEnvSelectionOptions;
  readonly inputOwner: ExplicitManagedEnvInputOwner;
  readonly redactError?: (error: unknown) => Error;
  readonly retainCapturedSignal?: boolean;
}): Promise<NativeProjectEnvExecutionAcquisition> {
  const redactError = opts.redactError ?? redactNativeEnvRevisionError;
  try {
    const selection = snapshotNativeEnvSelection(opts.selection);
    const inputOwner = opts.inputOwner;
    const recorded = nativeEnvRevisionRecorder();
    const selected = await readNativeProjectEnvSelection(
      selection,
      recorded.onAcquired,
      inputOwner
    );
    const revision = recorded.finish(selection, selected);
    const assertFresh = async (current: NativeProjectEnvSelectionOptions) => {
      try {
        const currentSelection = snapshotNativeEnvSelection({
          ...current,
          signal: opts.retainCapturedSignal
            ? retainedEnvSignal(selection.signal, current.signal)
            : current.signal,
        });
        const rechecked = nativeEnvRevisionRecorder();
        const currentInputs = await readNativeProjectEnvSelection(
          currentSelection,
          rechecked.onAcquired,
          inputOwner
        );
        if (rechecked.finish(currentSelection, currentInputs) !== revision) {
          throw nativeEnvRevisionError();
        }
      } catch (error: unknown) {
        throw redactError(error);
      }
    };
    const resolveValues = async (valueOpts?: {
      readonly signal?: AbortSignal;
    }) => {
      try {
        if (
          opts.retainCapturedSignal &&
          valueOpts !== undefined &&
          !isRecord(valueOpts)
        ) {
          throw nativeEnvRevisionError();
        }
        const signal = opts.retainCapturedSignal
          ? retainedEnvSignal(selection.signal, valueOpts?.signal)
          : (valueOpts?.signal ?? selection.signal);
        await assertFresh({ ...selection, signal });
        const resolved = await resolveNativeProjectEnvValues({
          selected,
          signal,
        });
        await assertFresh({ ...selection, signal });
        const result = {
          ...resolved,
          ...readonlyNativeEnvMetadata(selected.metadata),
        };
        freezeNativeEnvOwnedValue(result);
        return result;
      } catch (error: unknown) {
        throw redactError(error);
      }
    };
    const acquisition = {
      metadata: readonlyNativeEnvMetadata(selected.metadata),
      resolveValues,
      assertFresh,
    };
    Object.defineProperty(acquisition, "resolveValues", { enumerable: false });
    Object.defineProperty(acquisition, "assertFresh", { enumerable: false });
    if (opts.retainCapturedSignal) {
      legacyAdoptionEnvRevisions.set(acquisition, revision);
    }
    return Object.freeze(acquisition);
  } catch (error: unknown) {
    throw redactError(error);
  }
}

function redactLegacyAdoptionEnvError(error: unknown): Error {
  return error instanceof NativeConfigCompilerError &&
    error.code === "E_COMPILER_CANCELLED"
    ? new NativeConfigCompilerError(
        "E_COMPILER_CANCELLED",
        "Legacy adoption managed acquisition was cancelled; values omitted."
      )
    : new Error(
        "Legacy adoption managed acquisition refused: selected inputs or key are invalid, unsafe or changed; values omitted."
      );
}

/** Private legacy-adoption delivery; native metadata and selection APIs keep their native family fence. */
export async function acquireProjectEnvForLegacyAdoption(opts: {
  readonly admission: LegacyAdoptionManagedEnvAdmission;
}): Promise<NativeProjectEnvExecutionAcquisition> {
  try {
    if (
      !(
        isRecord(opts) &&
        isOwnedLegacyAdoptionManagedEnvAdmission(opts.admission)
      )
    ) {
      throw nativeEnvRevisionError();
    }
    return await acquireExplicitProjectEnvExecution({
      selection: opts.admission.selection,
      inputOwner: opts.admission,
      redactError: redactLegacyAdoptionEnvError,
      retainCapturedSignal: true,
    });
  } catch (error: unknown) {
    throw redactLegacyAdoptionEnvError(error);
  }
}

function resolveNativeHostValues(opts: {
  readonly targets: NativeProjectEnvHostTargets | undefined;
  readonly projection: ReturnType<typeof projectEnvScopeProjection>;
  readonly values: (
    name: string,
    scopeNames: readonly string[]
  ) => NativeEnvTargetValues;
}): NativeProjectEnvResolvedConfig["hostValues"] {
  if (!opts.targets) {
    return undefined;
  }
  const workloads: Record<string, NativeEnvTargetValues> = {};
  const defaultValues = opts.targets.includeDefault
    ? opts.values("default", opts.projection.globalHostScopeNames)
    : undefined;
  const scopes = new Map(
    opts.projection.serviceTargets.map((target) => [
      target.serviceName,
      target.hostScopeNames,
    ])
  );
  for (const name of opts.targets.workloadNames) {
    const scopeNames = scopes.get(name);
    if (!scopeNames) {
      throw nativeEnvValuesError();
    }
    workloads[name] = opts.values(name, scopeNames);
  }
  return {
    ...(defaultValues === undefined ? {} : { default: defaultValues }),
    workloads,
  };
}

/** Select only a declared guest workload or an explicitly requested host baseline. */
export function selectProjectEnvValuesForNativeExecutionTarget(opts: {
  readonly resolved: NativeProjectEnvResolvedConfig;
  readonly target: "guest" | "host";
  readonly workloadName?: string | null;
}): Record<string, string> {
  const workloadName = opts.workloadName ?? null;
  const targets =
    opts.target === "host"
      ? (opts.resolved.hostValues?.workloads ?? {})
      : opts.resolved.workloadEnv;
  let selected: NativeEnvTargetValues | undefined;
  if (workloadName === null) {
    selected =
      opts.target === "host"
        ? opts.resolved.hostValues?.default
        : opts.resolved.globalEnv;
  } else if (Object.hasOwn(targets, workloadName)) {
    selected = targets[workloadName];
  }
  if (!selected) {
    throw nativeEnvValuesError();
  }
  return { ...selected };
}

/** Keep legacy selection provenance outside the shared scope projection. */
function projectEnvProjection(opts: {
  readonly layers: ProjectEnvLayers;
  readonly serviceNames: readonly string[];
}) {
  const projection = projectEnvScopeProjection(opts);
  return {
    ...projection,
    metadata: {
      ...projection.metadata,
      selection: opts.layers.selection,
      files: opts.layers.files,
    },
  };
}

/** One scope projection owns metadata planning and runtime injection. */
function projectEnvScopeProjection(opts: {
  readonly layers: {
    readonly envLayers: readonly (ProjectEnvConfig | null)[];
    readonly merged: ProjectEnvConfig;
  };
  readonly serviceNames: readonly string[];
  readonly metadataByteLimit?: number;
  readonly includeHostMetadata?: boolean;
}) {
  const { envLayers, merged } = opts.layers;
  const declaredScopes = Object.keys(merged.values).sort((left, right) =>
    left.localeCompare(right)
  );
  const knownServiceSet = new Set(opts.serviceNames);
  const hostScopeConflictsWithService = knownServiceSet.has(
    PROJECT_ENV_HOST_SCOPE
  );
  const unknownScopes = declaredScopes
    .filter((scope) => scope !== "global")
    .filter((scope) => scope !== PROJECT_ENV_HOST_SCOPE)
    .filter((scope) => !knownServiceSet.has(scope));
  const serviceSet = new Set<string>([
    ...opts.serviceNames,
    ...declaredScopes.filter((scope) => scope !== "global"),
  ]);
  const serviceTargets = [...serviceSet].map((serviceName) => {
    const composeScopeNames =
      serviceName === "global" ? ["global"] : ["global", serviceName];
    return {
      serviceName,
      composeScopeNames,
      hostScopeNames: hostScopeConflictsWithService
        ? composeScopeNames
        : [...composeScopeNames, PROJECT_ENV_HOST_SCOPE],
    };
  });
  const effectiveMetadata: EffectiveEnvMetadata = {
    global: resolveMetadata({ layers: envLayers, scopeNames: ["global"] }),
  };
  let metadataBytes =
    opts.metadataByteLimit === undefined
      ? 0
      : Buffer.byteLength(JSON.stringify(effectiveMetadata));
  const checkMetadataSize = () => {
    if (
      opts.metadataByteLimit !== undefined &&
      metadataBytes > opts.metadataByteLimit
    ) {
      throw nativeEnvMetadataError();
    }
  };
  checkMetadataSize();
  const hostEffectiveMetadata: EffectiveEnvMetadata = {};
  for (const {
    serviceName,
    composeScopeNames,
    hostScopeNames,
  } of serviceTargets) {
    effectiveMetadata[serviceName] = resolveMetadata({
      layers: envLayers,
      scopeNames: composeScopeNames,
    });
    if (opts.metadataByteLimit !== undefined) {
      metadataBytes += Buffer.byteLength(
        JSON.stringify({ [serviceName]: effectiveMetadata[serviceName] })
      );
      checkMetadataSize();
    }
    if (opts.includeHostMetadata !== false) {
      hostEffectiveMetadata[serviceName] = resolveMetadata({
        layers: envLayers,
        scopeNames: hostScopeNames,
      });
    }
  }
  const globalHostScopeNames = hostScopeConflictsWithService
    ? ["global"]
    : ["global", PROJECT_ENV_HOST_SCOPE];
  if (opts.includeHostMetadata !== false) {
    hostEffectiveMetadata.global = resolveMetadata({
      layers: envLayers,
      scopeNames: globalHostScopeNames,
    });
  }
  const metadata = {
    effectiveMetadata,
    hostEffectiveMetadata,
    declaredScopes,
    unknownScopes,
  };
  return {
    metadata,
    serviceTargets,
    globalHostScopeNames,
    hostScopeNames: hostScopeConflictsWithService
      ? []
      : [PROJECT_ENV_HOST_SCOPE],
  };
}

export async function resolveProjectEnvConfig(
  opts: ProjectEnvResolveOptions
): Promise<ProjectEnvResolvedConfig | null> {
  const layers = await readProjectEnvLayers(opts);
  if (!layers) {
    return null;
  }
  const { envLayers, merged } = layers;
  const keyText = await resolveProjectEnvKey({
    projectRoot: opts.projectRoot,
    required: hasSecretEntries({ config: merged }),
  });
  const projection = projectEnvProjection({
    layers,
    serviceNames: opts.serviceNames,
  });
  const resolveScopes = (scopeNames: readonly string[]) =>
    resolveLayeredProjectEnvValuesForScopes({
      layers: envLayers,
      scopeNames,
      keyText,
    });
  const globalEnv = resolveScopes(["global"]);
  const hostEnv = resolveScopes(projection.hostScopeNames);
  const serviceEnv: Record<string, Record<string, string>> = {};
  const hostTargetEnv: Record<string, Record<string, string>> = {};
  for (const {
    serviceName,
    composeScopeNames,
    hostScopeNames,
  } of projection.serviceTargets) {
    serviceEnv[serviceName] = resolveScopes(composeScopeNames);
    hostTargetEnv[serviceName] = resolveScopes(hostScopeNames);
  }
  hostTargetEnv.global = resolveScopes(projection.globalHostScopeNames);
  return {
    ...projection.metadata,
    merged,
    globalEnv,
    hostEnv,
    hostTargetEnv,
    serviceEnv,
  };
}

function mergeProjectEnvConfigLayers(opts: {
  readonly layers: readonly (ProjectEnvConfig | null)[];
  readonly environment: string;
}): ProjectEnvConfig {
  const values: ProjectEnvValuesByScope = {};
  const scopes = new Set<string>(["global"]);
  for (const layer of opts.layers) {
    for (const scope of Object.keys(layer?.values ?? {})) {
      scopes.add(scope);
    }
  }
  for (const scope of scopes) {
    const scopeValues: Record<string, ProjectEnvStoredValue> = {};
    for (const layer of opts.layers) {
      for (const [key, value] of Object.entries(layer?.values[scope] ?? {})) {
        if (value === null) {
          delete scopeValues[key];
        } else {
          scopeValues[key] = value;
        }
      }
    }
    values[scope] = scopeValues;
  }
  return {
    version: PROJECT_ENV_CONFIG_VERSION,
    environment: opts.environment,
    secretsprovider: PROJECT_ENV_SECRETS_PROVIDER,
    values,
  };
}

function resolveProjectEnvScopeValues(opts: {
  readonly values: Readonly<Record<string, ProjectEnvStoredValue>>;
  readonly keyText: string | null;
}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, storedValue] of Object.entries(opts.values)) {
    if (storedValue === null) {
      continue;
    }
    out[key] = decryptProjectEnvStoredValue({
      storedValue,
      keyText: opts.keyText,
    });
  }
  return out;
}

/**
 * Resolve env precedence by source layer first, then target specificity within
 * each layer. A named overlay's global value therefore overrides a base-file
 * host/service value, while an overlay host/service value still overrides the
 * overlay global value.
 */
function resolveLayeredProjectEnvValuesForScopes(opts: {
  readonly layers: readonly (ProjectEnvConfig | null)[];
  readonly scopeNames: readonly string[];
  readonly keyText: string | null;
}): Record<string, string> {
  const entries = resolveEffectiveStoredEntries(opts);
  return resolveProjectEnvScopeValues({
    values: Object.fromEntries(
      Object.entries(entries).map(([key, entry]) => [key, entry.value])
    ),
    keyText: opts.keyText,
  });
}

/** Shared traversal keeps runtime values and disclosure metadata in lockstep. */
function resolveEffectiveStoredEntries(opts: {
  readonly layers: readonly (ProjectEnvConfig | null)[];
  readonly scopeNames: readonly string[];
}) {
  const entries: Record<
    string,
    { scope: string; value: Exclude<ProjectEnvStoredValue, null> }
  > = {};
  for (const layer of opts.layers) {
    for (const scope of opts.scopeNames) {
      for (const [key, value] of Object.entries(layer?.values[scope] ?? {})) {
        if (value === null) {
          delete entries[key];
        } else {
          entries[key] = { scope, value };
        }
      }
    }
  }
  return entries;
}

function resolveMetadata(
  opts: Parameters<typeof resolveEffectiveStoredEntries>[0]
) {
  return Object.fromEntries(
    Object.entries(resolveEffectiveStoredEntries(opts)).map(([key, entry]) => [
      key,
      { scope: entry.scope, secret: isProjectEnvSecretValue(entry.value) },
    ])
  );
}

function hasSecretEntries(opts: {
  readonly config: ProjectEnvConfig;
}): boolean {
  for (const scopeValues of Object.values(opts.config.values)) {
    for (const value of Object.values(scopeValues)) {
      if (isProjectEnvSecretValue(value)) {
        return true;
      }
    }
  }
  return false;
}

function isProjectEnvSecretValue(
  value: ProjectEnvStoredValue
): value is ProjectEnvSecretValue {
  return isRecord(value) && typeof value.secure === "string";
}

function decryptProjectEnvStoredValue(opts: {
  readonly storedValue: Exclude<ProjectEnvStoredValue, null>;
  readonly keyText: string | null;
}): string {
  if (!isProjectEnvSecretValue(opts.storedValue)) {
    return String(opts.storedValue);
  }
  if (!opts.keyText) {
    throw new Error(
      `Missing ${PROJECT_ENV_KEY_FILENAME}. Run "hack env add --secret ..." or provision the key file.`
    );
  }
  return decryptProjectEnvValue({
    ciphertext: opts.storedValue.secure,
    keyText: opts.keyText,
  });
}

/**
 * Secret value to store for `plaintext`, keeping the entry's current ciphertext
 * when it already opens to exactly `plaintext` under `keyText`.
 *
 * Fresh-IV encryption makes every write differ, so re-encrypting an unchanged
 * value would churn a tracked file on each repeat. Reuse is semantic, not
 * textual: an absent, plain, removed, malformed, wrong-key or different entry
 * gets a new ciphertext with a fresh IV. Decryption failures are not reported;
 * they only select rotation.
 */
function stableProjectEnvSecretValue(opts: {
  readonly previous: ProjectEnvStoredValue | undefined;
  readonly plaintext: string;
  readonly keyText: string;
}): ProjectEnvSecretValue {
  const previous = opts.previous;
  if (
    previous !== undefined &&
    previous !== null &&
    isProjectEnvSecretValue(previous) &&
    opensToPlaintext({
      ciphertext: previous.secure,
      plaintext: opts.plaintext,
      keyText: opts.keyText,
    })
  ) {
    return { secure: previous.secure };
  }
  return {
    secure: encryptProjectEnvValue({
      plaintext: opts.plaintext,
      keyText: opts.keyText,
    }),
  };
}

function opensToPlaintext(opts: {
  readonly ciphertext: string;
  readonly plaintext: string;
  readonly keyText: string;
}): boolean {
  try {
    return (
      decryptProjectEnvValue({
        ciphertext: opts.ciphertext,
        keyText: opts.keyText,
      }) === opts.plaintext
    );
  } catch {
    return false;
  }
}

/**
 * Reads the env layer a set or unset rewrites. An existing layer that cannot
 * be read, or is not a regular file, is refused with the same closed
 * `AtomicWriteRefusedError` the write itself raises, never treated as empty:
 * an unset would otherwise report nothing to remove, and a set would build its
 * result from an empty layer. An invalid layer is refused with a closed,
 * value-free message. Both refusals happen before anything is written.
 */
async function readProjectEnvLayerForMutation(opts: {
  readonly path: string;
  readonly environment: string;
}): Promise<{
  readonly read: ProjectEnvConfigReadResult;
  /** The exact bytes read (null when absent), for the compare-and-swap. */
  readonly text: string | null;
}> {
  const text = await readAtomicWriteTargetText(opts.path);
  const read = parseProjectEnvConfigText({
    path: opts.path,
    environment: opts.environment,
    text,
  });
  if (read.parseError) {
    throw new ClosedCliError(
      `Failed to parse ${opts.path}: ${read.parseError}`
    );
  }
  return { read, text };
}

export async function setProjectEnvValue(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly envName: string | null;
  readonly scope: string;
  readonly key: string;
  readonly value: string;
  readonly secret: boolean;
  readonly local?: boolean;
  /** Bounded wait for the layer lock; tests only. */
  readonly layerLockTimeoutMs?: number;
}): Promise<ProjectEnvMutationResult> {
  await assertLegacyProjectDirectory({ projectDir: opts.projectDir });
  await assertLegacyProjectInputFamily({ projectRoot: opts.projectRoot });
  if (!PROJECT_ENV_KEY_PATTERN.test(opts.key)) {
    throw new ClosedCliError(ENV_KEY_INVALID_MESSAGE);
  }
  const scope = assertValidProjectEnvScopeName({
    scopeName: opts.scope,
  });

  const filePath =
    opts.local === true
      ? await resolveProjectEnvEffectiveLocalConfigPath({
          projectRoot: opts.projectRoot,
          projectDir: opts.projectDir,
          envName: opts.envName,
        })
      : resolveProjectEnvConfigPath({
          projectDir: opts.projectDir,
          envName: opts.envName,
        });
  // The read, the change and the write form one critical section per layer,
  // so a concurrent set or unset of another key is never lost (HACK-1376).
  return await withEnvLayerLock({
    layerPath: filePath,
    timeoutMs: opts.layerLockTimeoutMs,
    run: async () =>
      await setLockedProjectEnvValue({ ...opts, scope, filePath }),
  });
}

async function setLockedProjectEnvValue(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly envName: string | null;
  readonly scope: string;
  readonly key: string;
  readonly value: string;
  readonly secret: boolean;
  readonly local?: boolean;
  readonly filePath: string;
}): Promise<ProjectEnvMutationResult> {
  const { filePath, scope } = opts;
  const { read, text } = await readProjectEnvLayerForMutation({
    path: filePath,
    environment: opts.envName ?? "default",
  });

  const nextValues: ProjectEnvValuesByScope = {
    ...read.config.values,
    [scope]: {
      ...(read.config.values[scope] ?? {}),
    },
  };

  let createdKey = false;
  let storedValue: ProjectEnvStoredValue = opts.value;
  if (opts.secret) {
    const ensuredKey = await ensureProjectEnvSecretKey({
      projectRoot: opts.projectRoot,
    });
    createdKey = ensuredKey.created;
    storedValue = stableProjectEnvSecretValue({
      previous: read.config.values[scope]?.[opts.key],
      plaintext: opts.value,
      keyText: ensuredKey.keyText,
    });
  }
  if (opts.local === true) {
    await ensureHackDirGitignoreForLocalEnvWrite({
      projectDir: opts.projectDir,
    });
  }

  const nextScopeValues = nextValues[scope] ?? {};
  nextScopeValues[opts.key] = storedValue;
  nextValues[scope] = nextScopeValues;
  if (!("global" in nextValues)) {
    nextValues.global = {};
  }

  const nextConfig: ProjectEnvConfig = {
    version: PROJECT_ENV_CONFIG_VERSION,
    environment: opts.envName ?? "default",
    secretsprovider: PROJECT_ENV_SECRETS_PROVIDER,
    values: nextValues,
  };
  // The lock excludes cooperating writers; the compare-and-swap turns a write
  // by anything else since the read into a closed, retryable conflict.
  const changed = await writeProjectEnvConfigFile({
    path: filePath,
    config: nextConfig,
    expectedExisting: text,
  });
  return {
    filePath,
    scope,
    createdKey,
    changed,
    local: opts.local === true,
  };
}

export async function unsetProjectEnvValue(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly envName: string | null;
  readonly scope: string;
  readonly key: string;
  readonly local?: boolean;
  /** Bounded wait for the layer lock; tests only. */
  readonly layerLockTimeoutMs?: number;
}): Promise<{ readonly changed: boolean; readonly filePath: string }> {
  await assertLegacyProjectDirectory({ projectDir: opts.projectDir });
  await assertLegacyProjectInputFamily({ projectRoot: opts.projectRoot });
  const filePath =
    opts.local === true
      ? await resolveProjectEnvEffectiveLocalConfigPath({
          projectRoot: opts.projectRoot,
          projectDir: opts.projectDir,
          envName: opts.envName,
        })
      : resolveProjectEnvConfigPath({
          projectDir: opts.projectDir,
          envName: opts.envName,
        });
  // Same per-layer critical section as `setProjectEnvValue` (HACK-1376).
  return await withEnvLayerLock({
    layerPath: filePath,
    timeoutMs: opts.layerLockTimeoutMs,
    run: async () => await unsetLockedProjectEnvValue({ ...opts, filePath }),
  });
}

async function unsetLockedProjectEnvValue(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly envName: string | null;
  readonly scope: string;
  readonly key: string;
  readonly local?: boolean;
  readonly filePath: string;
}): Promise<{ readonly changed: boolean; readonly filePath: string }> {
  const { filePath } = opts;
  const { read, text } = await readProjectEnvLayerForMutation({
    path: filePath,
    environment: opts.envName ?? "default",
  });

  const scopeValues = { ...(read.config.values[opts.scope] ?? {}) };
  const inheritsLocal =
    opts.local === true && (await resolvePrimaryLocalProjectDir(opts)) !== null;
  if (inheritsLocal) {
    if (scopeValues[opts.key] === null) {
      return { changed: false, filePath };
    }
    scopeValues[opts.key] = null;
  } else {
    if (!(opts.key in scopeValues)) {
      return { changed: false, filePath };
    }
    delete scopeValues[opts.key];
  }

  const nextValues: ProjectEnvValuesByScope = {
    ...read.config.values,
    [opts.scope]: scopeValues,
  };
  if (opts.scope !== "global" && Object.keys(scopeValues).length === 0) {
    delete nextValues[opts.scope];
  }
  if (!("global" in nextValues)) {
    nextValues.global = {};
  }

  const changed = await writeProjectEnvConfigFile({
    path: filePath,
    config: {
      version: PROJECT_ENV_CONFIG_VERSION,
      environment: opts.envName ?? "default",
      secretsprovider: PROJECT_ENV_SECRETS_PROVIDER,
      values: nextValues,
    },
    expectedExisting: text,
  });
  return { changed, filePath };
}

/** Closed reasons `hydrateProjectEnvLocalLayer` refuses with; none writes a layer. */
export const PROJECT_ENV_HYDRATION_REFUSAL_REASONS = [
  "tracked_layer",
  "tracking_unknown",
  "locked",
  "stale_lock",
  "unreadable_layer",
  "wrong_key",
  "key_env_only",
  "secret_downgrade",
  "concurrent_write",
] as const;

export type ProjectEnvHydrationRefusalReason =
  (typeof PROJECT_ENV_HYDRATION_REFUSAL_REASONS)[number];

const PROJECT_ENV_HYDRATION_LOCK_FILENAME = "env-hydrate.lock";
const PROJECT_ENV_HYDRATION_NOTHING_WRITTEN = "No env layer was changed.";

function projectEnvHydrationRefusalMessage(opts: {
  readonly reason: ProjectEnvHydrationRefusalReason;
  readonly lockPath: string;
}): string {
  switch (opts.reason) {
    case "tracked_layer":
      return "Refusing to hydrate: git tracks the machine-local env layer, so hydrated values would be committed. Untrack it with `git rm --cached` and retry.";
    case "tracking_unknown":
      return "Refusing to hydrate: this checkout is a git repository, but git could not report whether it tracks the machine-local env layer (for example after a safe.directory refusal, with a damaged index, or without git installed), so hydrated values could be committed. Make `git status` work in this checkout and retry.";
    case "locked":
      return "Refusing to hydrate: another `hack env hydrate` is writing this project's machine-local env layer. Retry when it finishes.";
    case "stale_lock":
      return `Refusing to hydrate: an interrupted \`hack env hydrate\` left its lock at ${opts.lockPath}, and the process that held it has exited. Remove that file and retry.`;
    case "unreadable_layer":
      return "Refusing to hydrate: the machine-local env layer is not a readable, valid env file. Fix or remove it and retry.";
    case "wrong_key":
      return `Refusing to hydrate: a secret already in the machine-local env layer does not decrypt under the project env key, or no key is available. Restore the matching ${PROJECT_ENV_KEY_FILENAME} and retry.`;
    case "key_env_only":
      return `Refusing to hydrate secrets: ${PROJECT_ENV_SECRET_KEY_ENV} is set but no ${PROJECT_ENV_KEY_FILENAME} exists, and creating one would replace that key for every layer. Store the same key in ${PROJECT_ENV_KEY_FILENAME} and retry.`;
    case "secret_downgrade":
      return "Refusing to hydrate without --secret: an imported key is stored as a secret in the machine-local env layer, and a plain import would replace its ciphertext with plaintext. Re-run with --secret, or first remove that key with `hack env unset <key> --local` if it should be stored as plain text.";
    case "concurrent_write":
      return "Refusing to hydrate: the machine-local env layer changed while hydration was preparing it. Re-run hydration.";
    default:
      return "Refusing to hydrate.";
  }
}

/**
 * Closed, value-free refusal from `hydrateProjectEnvLocalLayer`. The message
 * names no key, value or input line; it may name Hack's own lock path.
 */
export class ProjectEnvHydrationRefusalError extends ClosedCliError {
  readonly reason: ProjectEnvHydrationRefusalReason;

  constructor(opts: {
    readonly reason: ProjectEnvHydrationRefusalReason;
    readonly lockPath: string;
  }) {
    super(
      `${projectEnvHydrationRefusalMessage(opts)} ${PROJECT_ENV_HYDRATION_NOTHING_WRITTEN}`
    );
    this.name = "ProjectEnvHydrationRefusalError";
    this.reason = opts.reason;
  }
}

export type ProjectEnvHydrationResult = {
  readonly filePath: string;
  readonly scope: string;
  readonly changed: boolean;
  readonly createdKey: boolean;
  /** Imported keys that the layer's scope did not hold. Sorted. */
  readonly added: readonly string[];
  /** Imported keys whose stored entry was replaced. Sorted. */
  readonly updated: readonly string[];
  /** Imported keys whose stored entry already held the value. Sorted. */
  readonly unchanged: readonly string[];
};

/**
 * Writes several values into the machine-local env layer in one commit.
 *
 * Contract:
 * - Only the effective machine-local layer for `envName` is written
 *   (`hack.env.local.yaml` or `hack.env.<overlay>.local.yaml`); a layer that
 *   git tracks is refused, and so is any layer inside a git checkout where
 *   git cannot answer (fail closed). Tracked defaults are never read for
 *   writing.
 * - A layer that exists but is not a valid env file is refused, never
 *   replaced, so hand-written content is not lost.
 * - Without `secret`, an imported key that the target scope stores as a
 *   secret is refused rather than downgraded to plaintext.
 * - Keys outside `entries`, other scopes and removal markers for other keys
 *   are kept as they are. An imported key replaces that key's local entry.
 * - Idempotent: an entry that already holds its value is kept unchanged (a
 *   secret keeps its ciphertext, a scalar keeps its YAML type). When no entry
 *   changes, the file is not rewritten at all. A changed or newly secret value
 *   gets new ciphertext with a fresh IV.
 * - All-or-nothing: the whole new layer is published by one rename. Every
 *   refusal ({@link ProjectEnvHydrationRefusalError}) happens before that
 *   rename, so the previous layer stays in place.
 * - Concurrency: hydrations of one project are serialized by an exclusive
 *   lock file under `.internal/`; a second hydration refuses instead of
 *   waiting. A lock left by a killed process is reported, not removed. Inside
 *   it, hydration takes the layer's write lock (`withEnvLayerLock`), the same
 *   one `hack env set`/`unset` hold, waiting a bounded time for them. The
 *   write is also a compare-and-swap against the bytes read, so a writer that
 *   takes no lock and changed the layer meanwhile makes hydration refuse
 *   rather than overwrite it.
 * - Wrong key: every secret already in the layer must decrypt under the key
 *   readers would use, or hydration refuses. Secret mode encrypts with the key
 *   file `hack env add --secret` uses and refuses to create one while only
 *   `HACK_ENV_SECRET_KEY` provides a key.
 *
 * Values never appear in errors or results; results name only keys.
 */
export async function hydrateProjectEnvLocalLayer(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly envName: string | null;
  readonly scope: string;
  /** Validated keys to plaintext values. */
  readonly entries: ReadonlyMap<string, string>;
  readonly secret: boolean;
}): Promise<ProjectEnvHydrationResult> {
  await assertLegacyProjectDirectory({ projectDir: opts.projectDir });
  await assertLegacyProjectInputFamily({ projectRoot: opts.projectRoot });
  for (const key of opts.entries.keys()) {
    if (!PROJECT_ENV_KEY_PATTERN.test(key)) {
      throw new ClosedCliError(ENV_KEY_INVALID_MESSAGE);
    }
  }
  const scope = assertValidProjectEnvScopeName({ scopeName: opts.scope });
  const filePath = await resolveProjectEnvEffectiveLocalConfigPath({
    projectRoot: opts.projectRoot,
    projectDir: opts.projectDir,
    envName: opts.envName,
  });
  const lockPath = resolve(
    opts.projectDir,
    ".internal",
    PROJECT_ENV_HYDRATION_LOCK_FILENAME
  );
  const refuse = (reason: ProjectEnvHydrationRefusalReason) =>
    new ProjectEnvHydrationRefusalError({ reason, lockPath });

  const tracked = await isGitTrackedProjectEnvPath({
    projectRoot: opts.projectRoot,
    path: filePath,
  });
  if (tracked === true) {
    throw refuse("tracked_layer");
  }
  // `null` covers both "not a repository" and "git failed" (a safe.directory
  // refusal, a damaged index, git missing). Only the first is safe to write.
  if (
    tracked === null &&
    (await isInsideGitCheckoutMarker({ startDir: opts.projectRoot }))
  ) {
    throw refuse("tracking_unknown");
  }

  const release = await acquireProjectEnvHydrationLock({
    projectDir: opts.projectDir,
    lockPath,
    refuse,
  });
  try {
    // Also take the per-layer lock that `hack env set`/`unset` hold, so a
    // concurrent set of another key waits instead of making hydration refuse
    // as `concurrent_write` (or being overwritten).
    return await withEnvLayerLock({
      layerPath: filePath,
      run: async () =>
        await hydrateLockedProjectEnvLayer({
          ...opts,
          scope,
          filePath,
          refuse,
        }),
    });
  } finally {
    await release();
  }
}

type ProjectEnvHydrationRefuse = (
  reason: ProjectEnvHydrationRefusalReason
) => ProjectEnvHydrationRefusalError;

async function hydrateLockedProjectEnvLayer(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly envName: string | null;
  readonly scope: string;
  readonly entries: ReadonlyMap<string, string>;
  readonly secret: boolean;
  readonly filePath: string;
  readonly refuse: ProjectEnvHydrationRefuse;
}): Promise<ProjectEnvHydrationResult> {
  const environment = opts.envName ?? "default";
  const layer = await readProjectEnvHydrationLayer({
    filePath: opts.filePath,
    environment,
    refuse: opts.refuse,
  });
  const key = await resolveProjectEnvHydrationKey({
    projectRoot: opts.projectRoot,
    config: layer.config,
    secret: opts.secret,
    refuse: opts.refuse,
  });
  const previousScope = layer.config.values[opts.scope] ?? {};
  if (
    !opts.secret &&
    [...opts.entries.keys()].some((entryKey) => {
      const previous = Object.hasOwn(previousScope, entryKey)
        ? previousScope[entryKey]
        : undefined;
      return (
        previous !== undefined &&
        previous !== null &&
        isProjectEnvSecretValue(previous)
      );
    })
  ) {
    // A plain import would silently drop at-rest encryption for that key.
    throw opts.refuse("secret_downgrade");
  }
  const plan = planProjectEnvHydration({
    previousScope,
    entries: opts.entries,
    keyText: key.keyText,
  });
  const result = {
    filePath: opts.filePath,
    scope: opts.scope,
    createdKey: key.createdKey,
    added: plan.added,
    updated: plan.updated,
    unchanged: plan.unchanged,
  };
  if (plan.added.length === 0 && plan.updated.length === 0) {
    // Nothing to change: leave the layer's bytes, including hand edits, alone.
    return { ...result, changed: false };
  }

  const nextValues: ProjectEnvValuesByScope = {
    ...layer.config.values,
    [opts.scope]: plan.nextScope,
  };
  if (!("global" in nextValues)) {
    nextValues.global = {};
  }
  await ensureHackDirGitignoreForLocalEnvWrite({ projectDir: opts.projectDir });
  try {
    await writeProjectEnvConfigFile({
      path: opts.filePath,
      config: {
        version: PROJECT_ENV_CONFIG_VERSION,
        environment,
        secretsprovider: PROJECT_ENV_SECRETS_PROVIDER,
        values: nextValues,
      },
      expectedExisting: layer.text,
    });
  } catch (error: unknown) {
    if (error instanceof AtomicWriteConflictError) {
      throw opts.refuse("concurrent_write");
    }
    throw error;
  }
  return { ...result, changed: true };
}

/** The layer's exact bytes (null when absent) and its parsed config. */
async function readProjectEnvHydrationLayer(opts: {
  readonly filePath: string;
  readonly environment: string;
  readonly refuse: ProjectEnvHydrationRefuse;
}): Promise<{
  readonly text: string | null;
  readonly config: ProjectEnvConfig;
}> {
  let text: string | null;
  try {
    text = await readProjectEnvLayerText({
      path: opts.filePath,
      strictRead: true,
    });
  } catch {
    throw opts.refuse("unreadable_layer");
  }
  const read = parseProjectEnvConfigText({
    path: opts.filePath,
    environment: opts.environment,
    text,
  });
  if (read.parseError !== undefined) {
    throw opts.refuse("unreadable_layer");
  }
  return { text, config: read.config };
}

/**
 * Checks every secret already in the layer against the key readers use and,
 * in secret mode, selects (or first creates) the encryption key.
 */
async function resolveProjectEnvHydrationKey(opts: {
  readonly projectRoot: string;
  readonly config: ProjectEnvConfig;
  readonly secret: boolean;
  readonly refuse: ProjectEnvHydrationRefuse;
}): Promise<{ readonly keyText: string | null; readonly createdKey: boolean }> {
  const fileKey = await readExistingProjectEnvKeyFileText({
    projectRoot: opts.projectRoot,
  });
  const environmentKey =
    process.env[PROJECT_ENV_SECRET_KEY_ENV]?.trim() || null;
  // The same priority `resolveProjectEnvKey` gives readers of this layer.
  const readerKey = fileKey ?? environmentKey;
  const existingSecrets = Object.values(opts.config.values).flatMap(
    (scopeValues) =>
      Object.values(scopeValues).filter(
        (value): value is ProjectEnvSecretValue =>
          value !== null && isProjectEnvSecretValue(value)
      )
  );
  const opensAll =
    readerKey !== null &&
    existingSecrets.every((secret) =>
      canDecryptProjectEnvValue({
        ciphertext: secret.secure,
        keyText: readerKey,
      })
    );
  if (existingSecrets.length > 0 && !opensAll) {
    throw opts.refuse("wrong_key");
  }
  if (!opts.secret) {
    return { keyText: null, createdKey: false };
  }
  if (fileKey === null && readerKey !== null) {
    throw opts.refuse("key_env_only");
  }
  const ensured = await ensureProjectEnvSecretKey({
    projectRoot: opts.projectRoot,
  });
  if (readerKey !== null && ensured.keyText !== readerKey) {
    throw opts.refuse("wrong_key");
  }
  return { keyText: ensured.keyText, createdKey: ensured.created };
}

/** Pure merge of imported entries into one scope; keys are reported sorted. */
function planProjectEnvHydration(opts: {
  readonly previousScope: Readonly<Record<string, ProjectEnvStoredValue>>;
  readonly entries: ReadonlyMap<string, string>;
  /** Encrypts every imported value when set; stores plain values when null. */
  readonly keyText: string | null;
}) {
  const nextScope: Record<string, ProjectEnvStoredValue> = {
    ...opts.previousScope,
  };
  const added: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const keys = [...opts.entries.keys()].sort((left, right) =>
    left.localeCompare(right)
  );
  for (const key of keys) {
    const plaintext = opts.entries.get(key) ?? "";
    const previous = Object.hasOwn(opts.previousScope, key)
      ? opts.previousScope[key]
      : undefined;
    const stored: ProjectEnvStoredValue =
      opts.keyText === null
        ? stableProjectEnvPlainValue({ previous, plaintext })
        : stableProjectEnvSecretValue({
            previous,
            plaintext,
            keyText: opts.keyText,
          });
    if (sameProjectEnvStoredValue(previous, stored)) {
      unchanged.push(key);
      continue;
    }
    (previous === undefined ? added : updated).push(key);
    nextScope[key] = stored;
  }
  return { nextScope, added, updated, unchanged };
}

/** A plain scalar that already prints as `plaintext` keeps its YAML type. */
function stableProjectEnvPlainValue(opts: {
  readonly previous: ProjectEnvStoredValue | undefined;
  readonly plaintext: string;
}): ProjectEnvStoredValue {
  const previous = opts.previous;
  if (
    (typeof previous === "string" ||
      typeof previous === "number" ||
      typeof previous === "boolean") &&
    String(previous) === opts.plaintext
  ) {
    return previous;
  }
  return opts.plaintext;
}

function sameProjectEnvStoredValue(
  previous: ProjectEnvStoredValue | undefined,
  next: ProjectEnvStoredValue
): boolean {
  if (previous === undefined || previous === null || next === null) {
    return previous === next;
  }
  if (isProjectEnvSecretValue(previous) || isProjectEnvSecretValue(next)) {
    return (
      isProjectEnvSecretValue(previous) &&
      isProjectEnvSecretValue(next) &&
      previous.secure === next.secure
    );
  }
  return previous === next;
}

function canDecryptProjectEnvValue(opts: {
  readonly ciphertext: string;
  readonly keyText: string;
}): boolean {
  try {
    decryptProjectEnvValue(opts);
    return true;
  } catch {
    return false;
  }
}

/**
 * The key file `ensureProjectEnvSecretKey` would select (checkout-local,
 * existing shared, then the primary checkout's), read without creating,
 * copying or adopting anything.
 */
async function readExistingProjectEnvKeyFileText(opts: {
  readonly projectRoot: string;
}): Promise<string | null> {
  const localKey = await readLegacyProjectEnvKeyFile({
    path: resolveProjectEnvKeyPath({ projectRoot: opts.projectRoot }),
  });
  if (localKey !== null) {
    return localKey;
  }
  const sharedKeyPath = await resolveProjectEnvSharedKeyPath({
    projectRoot: opts.projectRoot,
  });
  const sharedKey =
    sharedKeyPath === null
      ? null
      : await readLegacyProjectEnvKeyFile({ path: sharedKeyPath });
  if (sharedKey !== null) {
    return sharedKey;
  }
  const inherited = await resolveInheritedProjectEnvKey({
    projectRoot: opts.projectRoot,
  });
  return inherited?.keyText ?? null;
}

/**
 * Takes the project's hydration lock: `.internal/env-hydrate.lock`, created
 * exclusively (no symlink follow, mode 0600) and holding the owner's PID.
 * `.internal` itself must be a real directory (or absent, then created).
 *
 * An existing lock is never removed or taken over, because a second process
 * cannot prove the first one is gone without racing a third. It refuses as
 * `locked` while the recorded PID is alive (or unreadable, which includes a
 * lock still being written) and as `stale_lock` once that process has exited.
 * The returned release removes the lock only while the path still names the
 * file this call created.
 */
async function acquireProjectEnvHydrationLock(opts: {
  readonly projectDir: string;
  readonly lockPath: string;
  readonly refuse: ProjectEnvHydrationRefuse;
}): Promise<() => Promise<void>> {
  // A symlinked or non-directory `.internal` (including a dangling link) is
  // refused as E_PATH_CONFLICT; the lock is never created through it.
  await ensureRealDirectoryForWrite(dirname(opts.lockPath));
  await assertLegacyProjectDirectory({ projectDir: opts.projectDir });
  try {
    await createPrivateFileExclusive({
      path: opts.lockPath,
      text: `${process.pid}\n`,
    });
  } catch (error: unknown) {
    if (!(isRecord(error) && error.code === "EEXIST")) {
      throw error;
    }
    const holder = await readTextFile(opts.lockPath);
    const pid = Number.parseInt(holder?.trim() ?? "", 10);
    throw opts.refuse(
      Number.isSafeInteger(pid) && pid > 0 && !isProcessAlive(pid)
        ? "stale_lock"
        : "locked"
    );
  }
  const created = await lstat(opts.lockPath);
  return async () => {
    const current = await lstat(opts.lockPath).catch(() => null);
    if (
      current?.isFile() &&
      current.dev === created.dev &&
      current.ino === created.ino
    ) {
      await unlink(opts.lockPath).catch(() => undefined);
    }
  };
}

/** Signal 0 probes existence only; EPERM means a live process of another user. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return isRecord(error) && error.code === "EPERM";
  }
}

function serializeProjectEnvConfig(config: ProjectEnvConfig): string {
  const yaml = YAML.stringify(config, null, 2);
  return yaml.endsWith("\n") ? yaml : `${yaml}\n`;
}

/**
 * Creates a machine-local layer of the `.env`-only migration as a private
 * (0600) file, published only where no entry exists. An existing entry,
 * including a symlink, refuses; nothing is replaced or followed.
 */
async function publishMigrationLocalLayer(opts: {
  readonly projectDir: string;
  readonly write: PlannedEnvLayerWrite;
}): Promise<void> {
  await assertLegacyProjectDirectory({ projectDir: opts.projectDir });
  const refusal = () =>
    new LegacyDotenvMigrationRefusalError({
      code: "E_PATH_CONFLICT",
      reason: `${opts.write.path} already exists or is not a regular file path.`,
    });
  const published = await publishPrivateFileExclusive({
    path: opts.write.path,
    text: serializeProjectEnvConfig(opts.write.config),
    directories: [opts.projectDir],
    refusal,
  });
  if (!published) {
    throw refusal();
  }
}

async function writeProjectEnvConfigFile(opts: {
  readonly path: string;
  readonly config: ProjectEnvConfig;
  /** Compare-and-swap guard; see `writeTextFileAtomicIfChanged`. */
  readonly expectedExisting?: string | null;
}): Promise<boolean> {
  const text = serializeProjectEnvConfig(opts.config);
  await assertLegacyProjectDirectory({ projectDir: dirname(opts.path) });
  // Rename-committed: an interrupted mutation leaves the previous layer intact.
  return (
    await writeTextFileAtomicIfChanged(
      opts.path,
      text,
      opts.expectedExisting === undefined
        ? {}
        : { expectedExisting: opts.expectedExisting }
    )
  ).changed;
}

export async function materializeProjectEnv(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly envName?: string | null;
  readonly serviceName?: string | null;
  readonly serviceNames: readonly string[];
}): Promise<{
  readonly envPath: string;
  readonly changed: boolean;
  readonly effectiveEnvName: string | null;
}> {
  await assertLegacyProjectDirectory({ projectDir: opts.projectDir });
  await assertLegacyProjectInputFamily({ projectRoot: opts.projectRoot });
  const resolved = await resolveProjectEnvConfig({
    projectRoot: opts.projectRoot,
    projectDir: opts.projectDir,
    envName: opts.envName,
    serviceNames: opts.serviceNames,
  });
  if (!resolved) {
    throw new Error("No project env config files found.");
  }

  const selectedEnv = selectProjectEnvValues({
    resolved,
    scopeName: opts.serviceName,
  });
  const envPath = resolve(opts.projectDir, PROJECT_ENV_FILENAME);
  const text = serializeDotEnv(selectedEnv);
  await ensureHackGitInfoExclude({ projectDir: opts.projectDir });
  await assertLegacyProjectDirectory({ projectDir: opts.projectDir });
  // Mode 0600, atomic replace; a symlinked .env or .hack is refused.
  const changed = (
    await writePrivateEnvFileIfChanged({ envFile: envPath, text })
  ).changed;
  await ensureDir(
    dirname(resolveProjectEnvStatePath({ projectDir: opts.projectDir }))
  );
  const stateText = `${JSON.stringify(
    {
      version: 1,
      selectedOverlay: resolved.selection.effectiveEnv,
      selectedService: opts.serviceName ?? null,
      generatedAt: new Date().toISOString(),
      inputs: await buildProjectEnvStateDigests({ files: resolved.files }),
    },
    null,
    2
  )}\n`;
  await assertLegacyProjectDirectory({ projectDir: opts.projectDir });
  await writeTextFile(
    resolveProjectEnvStatePath({ projectDir: opts.projectDir }),
    stateText
  );
  return {
    envPath,
    changed,
    effectiveEnvName: resolved.selection.effectiveEnv,
  };
}

async function buildProjectEnvStateDigests(opts: {
  readonly files: readonly string[];
}): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const filePath of opts.files) {
    const contents = (await readTextFile(filePath)) ?? "";
    out[filePath] = createHash("sha256").update(contents, "utf8").digest("hex");
  }
  return out;
}

export async function inspectProjectEnvMaterialization(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly envName?: string | null;
  readonly serviceName?: string | null;
  readonly serviceNames: readonly string[];
}): Promise<ProjectEnvMaterializationInspection> {
  const envPath = resolve(opts.projectDir, PROJECT_ENV_FILENAME);
  const statePath = resolveProjectEnvStatePath({ projectDir: opts.projectDir });
  const [envExists, stateExists] = await Promise.all([
    pathExists(envPath),
    pathExists(statePath),
  ]);

  const unmigrated = await findUnmigratedLegacyDotenv(opts);
  if (hasUnmigratedLegacyDotenv(unmigrated)) {
    return {
      envPath,
      statePath,
      status: "warn",
      message: `The legacy .hack/.env files hold values the env layers don't deliver: this checkout ${describeUnmigratedLegacyDotenv(unmigrated)} (run: hack doctor --migrate-env-config)`,
      issues: ["unmigrated legacy env values"],
    };
  }

  if (!(envExists || stateExists)) {
    return {
      envPath,
      statePath,
      status: "ok",
      message: "No materialized .hack/.env compatibility output present",
      issues: [],
    };
  }

  if (envExists && !stateExists) {
    return {
      envPath,
      statePath,
      status: "warn",
      message: `Materialized ${envPath} is missing ${statePath} (run: hack env materialize)`,
      issues: [`missing ${statePath}`],
    };
  }

  if (!envExists && stateExists) {
    return {
      envPath,
      statePath,
      status: "warn",
      message: `Materialized env state exists but ${envPath} is missing (run: hack env materialize)`,
      issues: [`missing ${envPath}`],
    };
  }

  const stateRead = await readProjectEnvStateFile({ statePath });
  if (!stateRead.ok) {
    return {
      envPath,
      statePath,
      status: "warn",
      message: `Invalid ${statePath}: ${stateRead.error} (run: hack env materialize)`,
      issues: [`invalid ${statePath}`],
    };
  }

  const resolved = await resolveProjectEnvConfig({
    projectRoot: opts.projectRoot,
    projectDir: opts.projectDir,
    envName: opts.envName,
    serviceNames: opts.serviceNames,
  });
  if (!resolved) {
    return {
      envPath,
      statePath,
      status: "ok",
      message: "No modern env config files found",
      issues: [],
    };
  }

  const issues = await collectProjectEnvMaterializationIssues({
    state: stateRead.state,
    resolved,
    serviceName: opts.serviceName,
    serviceNames: opts.serviceNames,
  });
  if (issues.length === 0) {
    return {
      envPath,
      statePath,
      status: "ok",
      message:
        "Materialized .hack/.env matches current env selection and inputs",
      issues,
    };
  }

  return {
    envPath,
    statePath,
    status: "warn",
    message: `${issues.join("; ")} (run: hack env materialize)`,
    issues,
  };
}

async function readProjectEnvStateFile(opts: {
  readonly statePath: string;
}): Promise<
  | { readonly ok: true; readonly state: ProjectEnvStateFile }
  | { readonly ok: false; readonly error: string }
> {
  const text = await readTextFile(opts.statePath);
  if (text === null) {
    return { ok: false, error: "file missing" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid JSON",
    };
  }

  return parseProjectEnvStateFile({ parsed });
}

function parseProjectEnvStateFile(opts: {
  readonly parsed: unknown;
}):
  | { readonly ok: true; readonly state: ProjectEnvStateFile }
  | { readonly ok: false; readonly error: string } {
  if (!isRecord(opts.parsed)) {
    return { ok: false, error: "state root must be an object" };
  }

  const version = opts.parsed.version;
  if (typeof version !== "number") {
    return { ok: false, error: "version must be a number" };
  }

  const generatedAt = getString(opts.parsed, "generatedAt");
  if (!generatedAt) {
    return { ok: false, error: "generatedAt must be a string" };
  }

  const selectedOverlayRaw = opts.parsed.selectedOverlay;
  if (
    !(selectedOverlayRaw === null || typeof selectedOverlayRaw === "string")
  ) {
    return { ok: false, error: "selectedOverlay must be a string or null" };
  }

  const selectedServiceRaw = opts.parsed.selectedService;
  if (
    !(selectedServiceRaw === null || typeof selectedServiceRaw === "string")
  ) {
    return { ok: false, error: "selectedService must be a string or null" };
  }

  const inputsRaw = getRecord(opts.parsed, "inputs");
  if (!inputsRaw) {
    return { ok: false, error: "inputs must be an object" };
  }

  const inputs: Record<string, string> = {};
  for (const [path, digest] of Object.entries(inputsRaw)) {
    if (typeof digest !== "string") {
      return {
        ok: false,
        error: `input digest for ${path} must be a string`,
      };
    }
    inputs[path] = digest;
  }

  return {
    ok: true,
    state: {
      version,
      selectedOverlay: selectedOverlayRaw,
      selectedService: selectedServiceRaw,
      generatedAt,
      inputs,
    },
  };
}

async function collectProjectEnvMaterializationIssues(opts: {
  readonly state: ProjectEnvStateFile;
  readonly resolved: ProjectEnvResolvedConfig;
  readonly serviceName?: string | null;
  readonly serviceNames: readonly string[];
}): Promise<readonly string[]> {
  const issues: string[] = [];
  const effectiveOverlay = opts.resolved.selection.effectiveEnv;
  if (opts.state.selectedOverlay !== effectiveOverlay) {
    issues.push(
      `materialized overlay ${formatProjectEnvStateValue({
        value: opts.state.selectedOverlay,
      })} does not match effective overlay ${formatProjectEnvStateValue({
        value: effectiveOverlay,
      })}`
    );
  }

  const expectedService = opts.serviceName ?? null;
  if (opts.state.selectedService !== expectedService) {
    if (
      opts.state.selectedService !== null &&
      !opts.serviceNames.includes(opts.state.selectedService)
    ) {
      issues.push(
        `materialized service scope ${opts.state.selectedService} no longer exists`
      );
    } else {
      issues.push(
        `materialized service scope ${formatProjectEnvStateValue({
          value: opts.state.selectedService,
        })} does not match effective service scope ${formatProjectEnvStateValue(
          {
            value: expectedService,
          }
        )}`
      );
    }
  }

  const currentInputs = await buildProjectEnvStateDigests({
    files: opts.resolved.files,
  });
  const staleInputs = new Set<string>();
  for (const [path, digest] of Object.entries(currentInputs)) {
    if (opts.state.inputs[path] !== digest) {
      staleInputs.add(path);
    }
  }
  for (const path of Object.keys(opts.state.inputs)) {
    if (!(path in currentInputs)) {
      staleInputs.add(path);
    }
  }
  if (staleInputs.size > 0) {
    issues.push(
      `${staleInputs.size} env input file${staleInputs.size === 1 ? "" : "s"} changed since materialization`
    );
  }

  return issues;
}

function formatProjectEnvStateValue(opts: {
  readonly value: string | null;
}): string {
  return opts.value === null ? "none" : opts.value;
}

async function resolveProjectEnvKey(opts: {
  readonly projectRoot: string;
  readonly required: boolean;
  readonly nativeSelection?: { readonly signal?: AbortSignal };
}): Promise<string | null> {
  if (opts.nativeSelection) {
    return await resolveNativeProjectEnvKey({
      ...opts,
      signal: opts.nativeSelection.signal,
    });
  }
  // Priority: checkout-local, shared common-dir, primary checkout, environment.
  const keyPath = resolveProjectEnvKeyPath({ projectRoot: opts.projectRoot });
  const localKey = await readLegacyProjectEnvKeyFile({ path: keyPath });
  if (localKey) {
    return localKey;
  }
  const sharedKeyPath = await resolveProjectEnvSharedKeyPath({
    projectRoot: opts.projectRoot,
  });
  const sharedKey =
    sharedKeyPath === null
      ? null
      : await readLegacyProjectEnvKeyFile({ path: sharedKeyPath });
  if (sharedKey) {
    return sharedKey;
  }
  const inheritedKey = await resolveInheritedProjectEnvKey({
    projectRoot: opts.projectRoot,
  });
  if (inheritedKey) {
    return inheritedKey.keyText;
  }
  const envFallback = process.env[PROJECT_ENV_SECRET_KEY_ENV]?.trim() ?? "";
  if (envFallback.length > 0) {
    return envFallback;
  }
  if (opts.required) {
    const searchedPaths = [keyPath, sharedKeyPath]
      .filter((value): value is string => typeof value === "string")
      .join(" or ");
    throw new Error(
      `Missing project env key at ${searchedPaths}. Run "hack env add --secret ..." to generate it, restore the key file, or set ${PROJECT_ENV_SECRET_KEY_ENV}.`
    );
  }
  return null;
}

/** Native reads preserve this owner's local/shared/primary/environment key priority without mutation. */
async function resolveNativeProjectEnvKey(opts: {
  readonly projectRoot: string;
  readonly required: boolean;
  readonly signal?: AbortSignal;
}): Promise<string | null> {
  checkNativeEnvCancellation(opts.signal);
  const localKey = await readNativeProjectEnvKeyFile({
    path: resolveProjectEnvKeyPath(opts),
    directories: [opts.projectRoot],
    signal: opts.signal,
  });
  if (localKey) {
    return localKey;
  }
  // Key sharing is independent of local env inheritance opt-outs and runner modes.
  const gitLocation = await resolveVerifiedProjectEnvKeyGitLocation(opts);
  if (gitLocation) {
    const sharedKey = await readNativeProjectEnvKeyFile({
      path: resolve(gitLocation.commonDir, PROJECT_ENV_KEY_FILENAME),
      directories: [gitLocation.checkoutRoot, gitLocation.commonDir],
      signal: opts.signal,
    });
    if (sharedKey) {
      return sharedKey;
    }
  }
  const primaryRoot = gitLocation?.primaryRoot;
  if (primaryRoot) {
    const inheritedKey = await readNativeProjectEnvKeyFile({
      path: resolveProjectEnvKeyPath({ projectRoot: primaryRoot }),
      directories: [primaryRoot],
      signal: opts.signal,
    });
    if (inheritedKey) {
      return inheritedKey;
    }
  }
  checkNativeEnvCancellation(opts.signal);
  const envFallback = process.env[PROJECT_ENV_SECRET_KEY_ENV]?.trim() ?? "";
  if (Buffer.byteLength(envFallback) > NATIVE_CONFIG_INPUT_LIMIT) {
    throw nativeEnvValuesError();
  }
  if (envFallback) {
    return envFallback;
  }
  if (opts.required) {
    throw nativeEnvValuesError();
  }
  return null;
}

/** Keys stay inside their existing owner; reject redirected, oversized or changing descriptor reads. */
async function readNativeProjectEnvKeyFile(opts: {
  readonly path: string;
  readonly directories: readonly string[];
  readonly signal?: AbortSignal;
}): Promise<string | null> {
  return await readBoundedPrivateFile({
    path: opts.path,
    directories: opts.directories,
    canonical: true,
    maxBytes: NATIVE_CONFIG_INPUT_LIMIT,
    refusal: nativeEnvValuesError,
    checkpoint: () => checkNativeEnvCancellation(opts.signal),
  });
}

const PROJECT_ENV_KEY_READ_ATTEMPTS = 10;
const PROJECT_ENV_KEY_READ_RETRY_DELAY_MS = 25;

/**
 * Legacy key files are refused unless they are regular, non-symlink, bounded
 * UTF-8 files, so a committed `.hack.secret.key` symlink never selects another
 * file as the key. Directory components keep their legacy spelling (temporary
 * and home directories are often reached through symlinks); only the final
 * component is pinned. Absent and whitespace-only files return null.
 *
 * A read that overlaps a concurrent creator's publication can observe the
 * file's metadata change (the publisher drops its staging link) and refuse.
 * While the entry is still a regular file the read is retried for a bounded
 * period (about a quarter second); a persistent refusal still throws.
 */
async function readLegacyProjectEnvKeyFile(opts: {
  readonly path: string;
}): Promise<string | null> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await readBoundedPrivateFile({
        path: opts.path,
        directories: [],
        canonical: false,
        maxBytes: NATIVE_CONFIG_INPUT_LIMIT,
        refusal: projectEnvKeyFileError,
      });
    } catch {
      const entry = await lstat(opts.path).catch(() => null);
      if (attempt >= PROJECT_ENV_KEY_READ_ATTEMPTS || !entry?.isFile()) {
        throw projectEnvKeyFileError();
      }
      await Bun.sleep(PROJECT_ENV_KEY_READ_RETRY_DELAY_MS);
    }
  }
}

/**
 * Fixed, value-free refusal for legacy key selection, creation and encryption.
 * Closed: the CLI prints its message as one line, never with a stack.
 */
export class ProjectEnvKeyRefusalError extends ClosedCliError {
  constructor(message: string) {
    super(message);
    this.name = "ProjectEnvKeyRefusalError";
  }
}

function projectEnvKeyFileError(): ProjectEnvKeyRefusalError {
  return new ProjectEnvKeyRefusalError(
    `Refusing project env key: ${PROJECT_ENV_KEY_FILENAME} must be a regular, readable, non-symlink, non-empty UTF-8 file of at most 1 MiB. Remove or replace it; key contents are never included in this message.`
  );
}

function projectEnvTrackedKeyError(): ProjectEnvKeyRefusalError {
  return new ProjectEnvKeyRefusalError(
    `Refusing to encrypt with a git-tracked ${PROJECT_ENV_KEY_FILENAME}: a committed key is not secret. Run 'hack doctor --fix' to untrack it, rotate the key, and re-encrypt existing secrets.`
  );
}

/**
 * Encryption refuses a key file that git tracks. Decryption with such a key
 * stays allowed for v4 compatibility; `hack doctor` reports the tracked key.
 * An undeterminable status (git unavailable, path outside a work tree) is not
 * treated as tracked.
 */
async function assertProjectEnvKeyUntracked(opts: {
  readonly keyPath: string;
}): Promise<void> {
  const tracked = await isGitTrackedProjectEnvPath({
    projectRoot: dirname(opts.keyPath),
    path: opts.keyPath,
  });
  if (tracked === true) {
    throw projectEnvTrackedKeyError();
  }
}

export type EnsureProjectEnvSecretKeyResult = {
  readonly keyPath: string;
  readonly keyText: string;
  readonly created: boolean;
  /** Non-empty when the key had to be written somewhere that risks divergence across checkouts. */
  readonly warnings: readonly string[];
};

/**
 * Ensures a decryption key exists for the project, preferring locations that
 * keep linked worktrees converged on one key:
 * 1. existing checkout-local `.hack.secret.key` (always wins for that checkout)
 * 2. existing shared key under the git common dir
 * 3. adopt the primary checkout's key (written to the shared location in a
 *    linked worktree so sibling checkouts converge)
 * 4. generate a new key, written to the shared location in a linked worktree
 *    (checkout-local only in a primary/non-git checkout)
 *
 * A checkout-local key is never silently created in a linked worktree: if the
 * shared location cannot be resolved (degraded git) or written, the fallback
 * local write carries a loud divergence warning (also returned in `warnings`).
 *
 * This is the encryption-side key owner. Key files are read without following
 * symlinks, a git-tracked selected or adopted key is refused before any write,
 * and new key files are created exclusively with mode 0600 (an existing entry,
 * including a dangling symlink, is never replaced or followed).
 *
 * Ignore invariant: a checkout-local key is returned only once git ignores it.
 * The root `.gitignore` entry is written before a new local key, so a failed
 * write leaves no key behind, and an existing local key that git does not
 * ignore is repaired or refused (see `ensureProjectEnvKeyIgnored`).
 *
 * Concurrency: when no key exists, creation in a git checkout runs under a
 * cooperative lock at `<git common dir>/.hack.secret.key.lock`, so concurrent
 * first users across primary and linked checkouts converge on one key. Legacy
 * v4 writers do not take this lock.
 */
export async function ensureProjectEnvSecretKey(opts: {
  readonly projectRoot: string;
}): Promise<EnsureProjectEnvSecretKeyResult> {
  await assertLegacyProjectInputFamily({ projectRoot: opts.projectRoot });
  const sharedLocation = await resolveProjectEnvSharedKeyLocation({
    projectRoot: opts.projectRoot,
  });
  if (
    sharedLocation === null ||
    (await pathExists(resolveProjectEnvKeyPath(opts))) ||
    (await pathExists(sharedLocation.path))
  ) {
    return await ensureProjectEnvSecretKeyUnlocked(opts);
  }
  // No key yet. The primary checkout mints a checkout-local key and a linked
  // worktree mints a shared one, so concurrent first users in different
  // checkouts would each select a different key. One cooperative lock in the
  // git common dir serializes creation; under it the full lookup runs again
  // and adopts a key another checkout created meanwhile.
  let started = false;
  const lockPath = `${sharedLocation.path}.lock`;
  try {
    return await withProjectsRegistryLock({
      lockPath,
      label: "project env key",
      run: async () => {
        started = true;
        return await ensureProjectEnvSecretKeyUnlocked(opts);
      },
    });
  } catch (error: unknown) {
    if (started) {
      throw error;
    }
    if (error instanceof ProjectsRegistryLockTimeoutError) {
      throw new ProjectEnvKeyLockTimeoutError({
        lockPath,
        recoveryBusy: error.recoveryBusy,
      });
    }
    if (!isProjectEnvKeyLockUnavailable(error)) {
      // Any other filesystem failure the user must fix (a full disk or quota,
      // a non-directory on the way) is refused as the key it blocked, never
      // as the lock's random `.owner` staging path or the raw errno.
      throw closedFileWriteError({
        error,
        path: sharedLocation.linkedWorktree
          ? sharedLocation.path
          : resolveProjectEnvKeyPath(opts),
        operation: "write",
      });
    }
    // The git dir cannot hold a lock (for example it is read-only): create
    // the key unserialized, as before; the writer's own fallbacks apply.
    return await ensureProjectEnvSecretKeyUnlocked(opts);
  }
}

/**
 * The project env key lock stayed held for the whole bounded wait: another
 * hack command is creating the key, or a lock was left behind by a process
 * whose PID is now reused (which is never reclaimed automatically), or an
 * interrupted recovery left its guard. Closed (`E_LOCKED`) and value-free: it
 * names the lock path and the remedy only. Nothing was written.
 */
export class ProjectEnvKeyLockTimeoutError extends HackCliError {
  constructor(opts: {
    readonly lockPath: string;
    readonly recoveryBusy: boolean;
  }) {
    const stale = opts.recoveryBusy
      ? `${opts.lockPath} and the directory ${opts.lockPath}.recovery`
      : opts.lockPath;
    super({
      code: "E_LOCKED",
      message: `Timed out waiting for the project env key lock ${opts.lockPath}; nothing was written. Another hack command may be creating the key: retry when it finishes. If no other hack command is running, the lock is stale: remove ${stale}, then retry.`,
    });
    this.name = "ProjectEnvKeyLockTimeoutError";
  }
}

function isProjectEnvKeyLockUnavailable(error: unknown): boolean {
  return (
    isRecord(error) &&
    typeof error.code === "string" &&
    ["EACCES", "ENOENT", "EPERM", "EROFS"].includes(error.code)
  );
}

async function ensureProjectEnvSecretKeyUnlocked(opts: {
  readonly projectRoot: string;
}): Promise<EnsureProjectEnvSecretKeyResult> {
  await assertLegacyProjectInputFamily({ projectRoot: opts.projectRoot });
  const keyPath = resolveProjectEnvKeyPath({ projectRoot: opts.projectRoot });
  const sharedLocation = await resolveProjectEnvSharedKeyLocation({
    projectRoot: opts.projectRoot,
  });
  const sharedKeyPath = await resolveSharedKeyPathFromLocation(sharedLocation);
  const existing = await readLegacyProjectEnvKeyFile({ path: keyPath });
  if (existing !== null) {
    await assertProjectEnvKeyUntracked({ keyPath });
    // A key left un-ignored (an older Hack, a failed ignore write, a hand-
    // copied key) is repaired before it is used, or refused.
    await ensureProjectEnvKeyIgnored({
      projectRoot: opts.projectRoot,
      keyPath,
      creating: false,
    });
    return {
      keyPath,
      keyText: existing,
      created: false,
      warnings: [],
    };
  }
  const sharedExisting =
    sharedKeyPath === null
      ? null
      : await readLegacyProjectEnvKeyFile({ path: sharedKeyPath });
  if (sharedKeyPath !== null && sharedExisting !== null) {
    await assertProjectEnvKeyUntracked({ keyPath: sharedKeyPath });
    return {
      keyPath: sharedKeyPath,
      keyText: sharedExisting,
      created: false,
      warnings: [],
    };
  }

  const inheritedKey = await resolveInheritedProjectEnvKey({
    projectRoot: opts.projectRoot,
  });
  if (inheritedKey) {
    // Refuse before copying a committed key into the shared location.
    await assertProjectEnvKeyUntracked({ keyPath: inheritedKey.keyPath });
    const written = await writeProjectEnvKeyWithFallback({
      projectRoot: opts.projectRoot,
      preferredKeyPath: sharedKeyPath,
      localKeyPath: keyPath,
      keyText: inheritedKey.keyText,
      sharedLocation,
    });
    return {
      keyPath: written.keyPath,
      keyText: written.keyText,
      created: false,
      warnings: written.warnings,
    };
  }

  const keyText = randomBytes(32).toString("base64url");
  const written = await writeProjectEnvKeyWithFallback({
    projectRoot: opts.projectRoot,
    preferredKeyPath: sharedKeyPath,
    localKeyPath: keyPath,
    keyText,
    sharedLocation,
  });
  return {
    keyPath: written.keyPath,
    keyText: written.keyText,
    // A concurrent writer's key is adopted rather than replaced.
    created: written.keyText === keyText,
    warnings: written.warnings,
  };
}

async function resolveSharedKeyPathFromLocation(
  location: ProjectEnvSharedKeyLocation | null
): Promise<string | null> {
  if (!location) {
    return null;
  }
  if (location.linkedWorktree) {
    return location.path;
  }
  return (await pathExists(location.path)) ? location.path : null;
}

/**
 * Writes the key to the preferred (shared) path when available, falling back
 * to the checkout-local path with a divergence warning when the shared write
 * fails or the shared location could not be resolved for a git checkout.
 */
async function writeProjectEnvKeyWithFallback(opts: {
  readonly projectRoot: string;
  readonly preferredKeyPath: string | null;
  readonly localKeyPath: string;
  readonly keyText: string;
  readonly sharedLocation: ProjectEnvSharedKeyLocation | null;
}): Promise<{
  readonly keyPath: string;
  readonly keyText: string;
  readonly warnings: string[];
}> {
  const warnings: string[] = [];

  if (opts.preferredKeyPath !== null) {
    try {
      const keyText = await writeProjectEnvKeyFile({
        projectRoot: opts.projectRoot,
        path: opts.preferredKeyPath,
        keyText: opts.keyText,
      });
      return { keyPath: opts.preferredKeyPath, keyText, warnings };
    } catch (error: unknown) {
      if (
        error instanceof ProjectInputSelectionError ||
        error instanceof ProjectEnvKeyRefusalError
      ) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(
        `Failed to write shared env key at ${opts.preferredKeyPath} (${message}); falling back to a checkout-local key at ${opts.localKeyPath}. Sibling git worktrees will NOT share this key and secrets encrypted here may not decrypt elsewhere.`
      );
    }
  } else if (
    opts.sharedLocation === null &&
    (await pathExists(resolve(opts.projectRoot, ".git")))
  ) {
    warnings.push(
      `git could not resolve the shared env key location for ${opts.projectRoot}; creating a checkout-local key at ${opts.localKeyPath}. If this repo uses linked worktrees, sibling checkouts may mint divergent keys. Restore git availability and re-run, or copy ${PROJECT_ENV_KEY_FILENAME} between checkouts.`
    );
  }

  // The ignore entry comes first: if it cannot be written, no key file exists
  // for a retry to pick up unignored.
  await assertLegacyProjectInputFamily({ projectRoot: opts.projectRoot });
  await ensureProjectEnvKeyIgnored({
    projectRoot: opts.projectRoot,
    keyPath: opts.localKeyPath,
    creating: true,
  });
  const keyText = await writeProjectEnvKeyFile({
    projectRoot: opts.projectRoot,
    path: opts.localKeyPath,
    keyText: opts.keyText,
  });
  emitProjectEnvKeyWarnings({ warnings });
  return { keyPath: opts.localKeyPath, keyText, warnings };
}

/**
 * Fixed, value-free refusal for a checkout-local key git would commit.
 * `unwritable`: Hack could not add the entry to the root `.gitignore`.
 * `reincluded`: the entry is there, but a later rule in that file (such as
 * `!.hack.secret.key`) re-includes the key, so adding it again cannot help.
 */
function projectEnvKeyUnignoredError(opts: {
  readonly rootGitignore: string;
  readonly cause: "unwritable" | "reincluded";
}): ProjectEnvKeyRefusalError {
  return new ProjectEnvKeyRefusalError(
    opts.cause === "reincluded"
      ? `Refusing to use ${PROJECT_ENV_KEY_FILENAME}: git does not ignore it, so it could be committed. ${opts.rootGitignore} lists '${PROJECT_ENV_KEY_FILENAME}', but a later rule in that file re-includes the key (for example '!${PROJECT_ENV_KEY_FILENAME}'). Remove that rule, then retry; key contents are never included in this message.`
      : `Refusing to use ${PROJECT_ENV_KEY_FILENAME}: git does not ignore it, so it could be committed, and Hack could not add it to ${opts.rootGitignore}. Add a '${PROJECT_ENV_KEY_FILENAME}' line to that file (making it writable if needed) and remove any rule that re-includes the key, then retry; key contents are never included in this message.`
  );
}

/**
 * Keeps the checkout-local key file out of commits: makes sure the root
 * `.gitignore` lists it and that git then ignores it.
 *
 * - `creating`: runs before a new key file is written. The entry is always
 *   ensured (also outside git, so a later `git init` ignores the key); a
 *   failed write is refused as that `.gitignore` write, and the caller writes
 *   no key.
 * - otherwise (an existing key): only a key git positively does not ignore is
 *   repaired, so an ignored key or a checkout outside git causes no write. A
 *   failed repair is refused with {@link projectEnvKeyUnignoredError}, and the
 *   key is not used.
 *
 * Either way, a key git still does not ignore after the entry (for example a
 * later `!.hack.secret.key` rule) is refused, naming that cause.
 *
 * A checkout outside git that later becomes one (`git init`) is not watched:
 * Hack runs no code at that point. If the entry went missing meanwhile, the
 * first `--secret` set or hydrate in the new checkout repairs it or refuses
 * here, and `hack doctor`'s env key check reports `env-key-unignored`.
 */
async function ensureProjectEnvKeyIgnored(opts: {
  readonly projectRoot: string;
  readonly keyPath: string;
  readonly creating: boolean;
}): Promise<void> {
  const probe = { projectRoot: opts.projectRoot, path: opts.keyPath };
  if (!opts.creating && (await isGitIgnoredProjectEnvPath(probe)) !== false) {
    return;
  }
  const rootGitignore = resolve(opts.projectRoot, ".gitignore");
  try {
    await ensureGitignoreEntry({
      gitignorePath: rootGitignore,
      entry: PROJECT_ENV_KEY_FILENAME,
      comment: "# project env key",
    });
  } catch (error: unknown) {
    throw opts.creating
      ? closedFileWriteError({ error, path: rootGitignore, operation: "write" })
      : projectEnvKeyUnignoredError({ rootGitignore, cause: "unwritable" });
  }
  // The entry is in the root `.gitignore` now (written or already there), and
  // no deeper ignore file applies to a key at the project root, so only a
  // later rule in that same file can re-include it.
  if ((await isGitIgnoredProjectEnvPath(probe)) === false) {
    throw projectEnvKeyUnignoredError({ rootGitignore, cause: "reincluded" });
  }
}

/**
 * Publishes the key file only when the path is free (a fsynced mode-0600
 * sibling linked into place, so no reader ever sees an empty or partial key)
 * and returns the key text now stored at `path`. When the path is already
 * occupied, a valid untracked regular key file (e.g. a concurrent writer's)
 * is adopted; anything else, including a symlink, is refused.
 */
async function writeProjectEnvKeyFile(opts: {
  readonly projectRoot: string;
  readonly path: string;
  readonly keyText: string;
}): Promise<string> {
  await assertLegacyProjectInputFamily({ projectRoot: opts.projectRoot });
  await ensureDirForWrite(dirname(opts.path));
  await assertLegacyProjectInputFamily({ projectRoot: opts.projectRoot });
  const published = await publishPrivateFileExclusive({
    path: opts.path,
    text: `${opts.keyText}\n`,
    // Like an O_EXCL|O_NOFOLLOW create, only the final component is checked,
    // so a checkout reached through a symlinked root stays usable.
    directories: [],
    refusal: projectEnvKeyFileError,
  });
  if (published) {
    return opts.keyText;
  }
  return await adoptExistingProjectEnvKeyFile({ path: opts.path });
}

const PROJECT_ENV_KEY_ADOPTION_ATTEMPTS = 20;
const PROJECT_ENV_KEY_ADOPTION_DELAY_MS = 25;

/**
 * A concurrent creator may expose its key file before writing the key, so a
 * regular file is re-read for a bounded period (about half a second). A
 * symlink or other entry, or a file still empty or invalid afterwards, is
 * refused; it is never replaced.
 */
async function adoptExistingProjectEnvKeyFile(opts: {
  readonly path: string;
}): Promise<string> {
  for (
    let attempt = 0;
    attempt < PROJECT_ENV_KEY_ADOPTION_ATTEMPTS;
    attempt += 1
  ) {
    const entry = await lstat(opts.path).catch(() => null);
    if (!entry?.isFile()) {
      break;
    }
    const existing = await readLegacyProjectEnvKeyFile({
      path: opts.path,
    }).catch(() => null);
    if (existing !== null) {
      await assertProjectEnvKeyUntracked({ keyPath: opts.path });
      return existing;
    }
    await Bun.sleep(PROJECT_ENV_KEY_ADOPTION_DELAY_MS);
  }
  throw projectEnvKeyFileError();
}

function emitProjectEnvKeyWarnings(opts: {
  readonly warnings: readonly string[];
}): void {
  for (const warning of opts.warnings) {
    process.stderr.write(`WARN: ${warning}\n`);
  }
}

async function resolveInheritedProjectEnvKey(opts: {
  readonly projectRoot: string;
}): Promise<{ readonly keyPath: string; readonly keyText: string } | null> {
  const primaryRoot = await resolveGitPrimaryWorktreeRoot({
    repoRoot: opts.projectRoot,
  });
  if (!primaryRoot || primaryRoot === opts.projectRoot) {
    return null;
  }

  const keyPath = resolveProjectEnvKeyPath({ projectRoot: primaryRoot });
  const keyText = await readLegacyProjectEnvKeyFile({ path: keyPath });
  if (keyText === null) {
    return null;
  }

  return {
    keyPath,
    keyText,
  };
}

function encryptProjectEnvValue(opts: {
  readonly plaintext: string;
  readonly keyText: string;
}): string {
  const iv = randomBytes(PROJECT_ENV_IV_BYTES);
  const key = deriveProjectEnvKey({ keyText: opts.keyText });
  const cipher = createCipheriv(PROJECT_ENV_ALGORITHM, key, iv, {
    authTagLength: PROJECT_ENV_TAG_BYTES,
  });
  const ciphertext = Buffer.concat([
    cipher.update(opts.plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    PROJECT_ENV_SECRET_PREFIX,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

function invalidSecureEnvValueError(): Error {
  return new Error("Invalid secure env value.");
}

/**
 * Parses and opens a v1 value `v1:<iv>:<tag>:<ciphertext>`. Each segment must
 * be canonical padded base64; the IV must be 12 bytes, the tag 16 bytes and the
 * ciphertext at most the env input bound. An empty ciphertext segment is the
 * authenticated empty plaintext. Malformed, oversized, truncated, tampered and
 * wrong-key inputs all throw the same fixed, value-free error.
 */
function decryptProjectEnvValue(opts: {
  readonly ciphertext: string;
  readonly keyText: string;
}): string {
  const parts = opts.ciphertext.split(":");
  const [prefix, ivText, tagText, ciphertextText] = parts;
  if (
    parts.length !== 4 ||
    prefix !== PROJECT_ENV_SECRET_PREFIX ||
    ivText === undefined ||
    tagText === undefined ||
    ciphertextText === undefined
  ) {
    throw invalidSecureEnvValueError();
  }
  const iv = decodeCanonicalBase64({
    text: ivText,
    maxBytes: PROJECT_ENV_IV_BYTES,
  });
  const tag = decodeCanonicalBase64({
    text: tagText,
    maxBytes: PROJECT_ENV_TAG_BYTES,
  });
  const ciphertext = decodeCanonicalBase64({
    text: ciphertextText,
    maxBytes: PROJECT_ENV_CIPHERTEXT_LIMIT,
  });
  if (
    iv?.length !== PROJECT_ENV_IV_BYTES ||
    tag?.length !== PROJECT_ENV_TAG_BYTES ||
    ciphertext === null
  ) {
    throw invalidSecureEnvValueError();
  }
  try {
    const key = deriveProjectEnvKey({ keyText: opts.keyText });
    const decipher = createDecipheriv(PROJECT_ENV_ALGORITHM, key, iv, {
      authTagLength: PROJECT_ENV_TAG_BYTES,
    });
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch {
    throw invalidSecureEnvValueError();
  }
}

function deriveProjectEnvKey(opts: { readonly keyText: string }): Buffer {
  return createHash("sha256").update(opts.keyText, "utf8").digest();
}

export async function discoverComposeServiceNames(opts: {
  readonly composeFile: string;
}): Promise<readonly string[]> {
  const parsed = await readComposeFile({ composeFile: opts.composeFile });
  if (!parsed) {
    return [];
  }
  const services = getRecord(parsed, "services");
  if (!services) {
    return [];
  }
  return Object.keys(services).sort((left, right) => left.localeCompare(right));
}

export async function inspectLegacyComposeEnvFileReferences(opts: {
  readonly composeFile: string;
  readonly projectDir: string;
}): Promise<readonly LegacyComposeEnvFileReference[]> {
  const parsed = await readComposeFile({ composeFile: opts.composeFile });
  if (!parsed) {
    return [];
  }

  const services = getRecord(parsed, "services");
  if (!services) {
    return [];
  }

  const composeDir = dirname(opts.composeFile);
  const references: LegacyComposeEnvFileReference[] = [];
  for (const [service, rawService] of Object.entries(services)) {
    if (!isRecord(rawService)) {
      continue;
    }
    for (const configuredPath of readComposeEnvFilePaths({
      rawService,
    })) {
      const resolvedPath = resolve(composeDir, configuredPath);
      if (
        isLegacyProjectEnvFilePath({
          projectDir: opts.projectDir,
          candidatePath: resolvedPath,
        })
      ) {
        references.push({
          service,
          configuredPath,
          resolvedPath,
        });
      }
    }
  }

  return references.sort((left, right) => {
    const byService = left.service.localeCompare(right.service);
    if (byService !== 0) {
      return byService;
    }
    return left.configuredPath.localeCompare(right.configuredPath);
  });
}

export async function repairLegacyComposeEnvFileReferences(opts: {
  readonly composeFile: string;
  readonly projectDir: string;
}): Promise<{
  readonly changed: boolean;
  readonly removed: readonly LegacyComposeEnvFileReference[];
}> {
  await assertLegacyProjectDirectory({ projectDir: opts.projectDir });
  const text = await readTextFile(opts.composeFile);
  if (!text) {
    return { changed: false, removed: [] };
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch {
    return { changed: false, removed: [] };
  }
  if (!isRecord(parsed)) {
    return { changed: false, removed: [] };
  }

  const services = getRecord(parsed, "services");
  if (!services) {
    return { changed: false, removed: [] };
  }

  const composeDir = dirname(opts.composeFile);
  const removed: LegacyComposeEnvFileReference[] = [];
  for (const [service, rawService] of Object.entries(services)) {
    if (!(isRecord(rawService) && "env_file" in rawService)) {
      continue;
    }

    const nextEnvFile = removeLegacyComposeEnvFileEntries({
      service,
      rawEnvFile: rawService.env_file,
      composeDir,
      projectDir: opts.projectDir,
      removed,
    });
    if (nextEnvFile === undefined) {
      rawService.env_file = undefined;
      continue;
    }
    rawService.env_file = nextEnvFile;
  }

  if (removed.length === 0) {
    return { changed: false, removed: [] };
  }

  const nextYaml = YAML.stringify(parsed, null, 2);
  const nextText = nextYaml.endsWith("\n") ? nextYaml : `${nextYaml}\n`;
  await assertLegacyProjectDirectory({ projectDir: opts.projectDir });
  const result = await writeTextFileIfChanged(opts.composeFile, nextText);
  return {
    changed: result.changed,
    removed: removed.sort((left, right) => {
      const byService = left.service.localeCompare(right.service);
      if (byService !== 0) {
        return byService;
      }
      return left.configuredPath.localeCompare(right.configuredPath);
    }),
  };
}

async function readComposeFile(opts: {
  readonly composeFile: string;
}): Promise<Record<string, unknown> | null> {
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

  return isRecord(parsed) ? parsed : null;
}

function readComposeEnvFilePaths(opts: {
  readonly rawService: Record<string, unknown>;
}): string[] {
  const rawEnvFile = opts.rawService.env_file;
  if (typeof rawEnvFile === "string") {
    return [rawEnvFile];
  }
  if (!Array.isArray(rawEnvFile)) {
    return [];
  }

  const paths: string[] = [];
  for (const entry of rawEnvFile) {
    if (typeof entry === "string") {
      paths.push(entry);
      continue;
    }
    if (isRecord(entry)) {
      const pathValue = getString(entry, "path");
      if (pathValue) {
        paths.push(pathValue);
      }
    }
  }
  return paths;
}

function isLegacyProjectEnvFilePath(opts: {
  readonly projectDir: string;
  readonly candidatePath: string;
}): boolean {
  const normalizedProjectDir = resolve(opts.projectDir);
  const normalizedCandidatePath = resolve(opts.candidatePath);
  if (dirname(normalizedCandidatePath) !== normalizedProjectDir) {
    return false;
  }

  const name = basename(normalizedCandidatePath);
  return (
    name === PROJECT_ENV_FILENAME || name.startsWith(`${PROJECT_ENV_FILENAME}.`)
  );
}

function removeLegacyComposeEnvFileEntries(opts: {
  readonly service: string;
  readonly rawEnvFile: unknown;
  readonly composeDir: string;
  readonly projectDir: string;
  readonly removed: LegacyComposeEnvFileReference[];
}): unknown {
  if (typeof opts.rawEnvFile === "string") {
    const resolvedPath = resolve(opts.composeDir, opts.rawEnvFile);
    if (
      isLegacyProjectEnvFilePath({
        projectDir: opts.projectDir,
        candidatePath: resolvedPath,
      })
    ) {
      opts.removed.push({
        service: opts.service,
        configuredPath: opts.rawEnvFile,
        resolvedPath,
      });
      return undefined;
    }
    return opts.rawEnvFile;
  }

  if (!Array.isArray(opts.rawEnvFile)) {
    return opts.rawEnvFile;
  }

  const kept: unknown[] = [];
  for (const entry of opts.rawEnvFile) {
    if (typeof entry === "string") {
      const resolvedPath = resolve(opts.composeDir, entry);
      if (
        isLegacyProjectEnvFilePath({
          projectDir: opts.projectDir,
          candidatePath: resolvedPath,
        })
      ) {
        opts.removed.push({
          service: opts.service,
          configuredPath: entry,
          resolvedPath,
        });
        continue;
      }
      kept.push(entry);
      continue;
    }
    if (isRecord(entry)) {
      const pathValue = getString(entry, "path");
      if (pathValue) {
        const resolvedPath = resolve(opts.composeDir, pathValue);
        if (
          isLegacyProjectEnvFilePath({
            projectDir: opts.projectDir,
            candidatePath: resolvedPath,
          })
        ) {
          opts.removed.push({
            service: opts.service,
            configuredPath: pathValue,
            resolvedPath,
          });
          continue;
        }
      }
    }
    kept.push(entry);
  }

  return kept.length > 0 ? kept : undefined;
}

/** Outcome of {@link migrateLegacyProjectEnv}. */
export type LegacyProjectEnvMigration = {
  readonly wroteFiles: readonly string[];
  readonly migratedOverlays: readonly string[];
  readonly legacyDetected: boolean;
  readonly updatedProjectConfig: boolean;
  readonly cleanupCandidates: readonly string[];
  readonly blockedCleanupCandidates: readonly string[];
  readonly composeEnvFileReferences: readonly LegacyComposeEnvFileReference[];
  /** Keys every service receives once their env is selected, from files no service listed. Names only. */
  readonly keysNewToEveryService?: readonly string[];
};

/**
 * Migrates a legacy v2 `.env`-based project env layout to the v3
 * `hack.env.*.yaml` config system.
 *
 * Without a `.hack/hack.env.json` contract nothing is migrated
 * (`legacyDetected: false`) unless `migrateUndeclaredDotenv` is set; see
 * {@link migrateUndeclaredLegacyDotenv} for that explicit-request path.
 *
 * @deprecated v2→v3 migration path. TODO(remove: v3.2) together with its
 * callers in commands/project.ts, commands/doctor.ts, commands/session.ts,
 * and commands/env.ts (`maybeMigrateLegacyProjectEnv`).
 */
export async function migrateLegacyProjectEnv(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly projectName: string;
  readonly serviceNames: readonly string[];
  readonly materialize: boolean;
  /**
   * Also migrate a project that has no contract: the legacy `.hack/.env`
   * and `.hack/.env.<overlay>` files become plaintext global values in the
   * gitignored machine-local layers, never in a tracked layer. Only an
   * explicit migration request (`hack doctor --migrate-env-config`) sets it;
   * the implicit migrations run by other commands keep requiring a contract.
   */
  readonly migrateUndeclaredDotenv?: boolean;
}): Promise<LegacyProjectEnvMigration> {
  await assertLegacyProjectDirectory({ projectDir: opts.projectDir });
  await assertLegacyProjectInputFamily({ projectRoot: opts.projectRoot });
  const contract = await readHackEnvContract({ projectDir: opts.projectDir });
  if (!contract.exists) {
    if (opts.migrateUndeclaredDotenv === true) {
      return await migrateUndeclaredLegacyDotenv(opts);
    }
    return {
      wroteFiles: [],
      migratedOverlays: [],
      legacyDetected: false,
      updatedProjectConfig: false,
      cleanupCandidates: [],
      blockedCleanupCandidates: [],
      composeEnvFileReferences: [],
    };
  }
  // Callers gate on projectEnvConfigExists, which reads a dangling default
  // layer or a symlinked overlay as absent. Decide the format here with the
  // mutation check: an unusable entry refuses (E_PATH_CONFLICT) instead of
  // being replaced, and a linked regular layer means env layers are in use.
  if (
    await projectEnvConfigExistsForMutation({ projectDir: opts.projectDir })
  ) {
    return {
      wroteFiles: [],
      migratedOverlays: [],
      legacyDetected: false,
      updatedProjectConfig: false,
      cleanupCandidates: [],
      blockedCleanupCandidates: [],
      composeEnvFileReferences: [],
    };
  }

  // Discovered overlays are regular files only, and a link that remains (the
  // base file, or a configured default overlay) refuses wherever it points: this
  // path writes plain_env values to tracked layers, so a repository's symlink
  // must not pull another file's values into them, even one in .hack such as a
  // machine-local .env.local.
  const overlayNames = await discoverLegacyOverlayNames({
    projectDir: opts.projectDir,
    includeSymlinks: false,
  });
  await assertNoLegacyDotenvLinks({
    projectDir: opts.projectDir,
    overlayNames,
  });

  const baseResolved = await resolveHackEnv({
    projectDir: opts.projectDir,
    projectName: opts.projectName,
    envName: null,
  });

  const keyInfo = baseResolved.values.some(
    (value) => value.source === "keychain"
  )
    ? await ensureProjectEnvSecretKey({ projectRoot: opts.projectRoot })
    : null;

  const wroteFiles: string[] = [];
  const defaultConfig = buildMigratedProjectEnvConfig({
    environment: "default",
    values: buildMigratedValues({
      resolvedValues: baseResolved.values,
      baseValues: null,
      keyText: keyInfo?.keyText ?? null,
    }),
  });
  const defaultPath = resolveProjectEnvConfigPath({
    projectDir: opts.projectDir,
    envName: null,
  });
  if (
    await writeProjectEnvConfigFile({
      path: defaultPath,
      config: defaultConfig,
      // Create only: no layer existed at the format check above.
      expectedExisting: null,
    })
  ) {
    wroteFiles.push(defaultPath);
  }

  for (const overlayName of overlayNames) {
    const overlayResolved = await resolveHackEnv({
      projectDir: opts.projectDir,
      projectName: opts.projectName,
      envName: overlayName,
    });
    const overlayConfig = buildMigratedProjectEnvConfig({
      environment: overlayName,
      values: buildMigratedValues({
        resolvedValues: overlayResolved.values,
        baseValues: new Map(
          baseResolved.values.map((value) => [value.key, value.value])
        ),
        keyText: keyInfo?.keyText ?? null,
      }),
    });
    const hasOverlayEntries = Object.entries(overlayConfig.values).some(
      ([scope, values]) => scope !== "global" || Object.keys(values).length > 0
    );
    if (!hasOverlayEntries) {
      continue;
    }

    const overlayPath = resolveProjectEnvConfigPath({
      projectDir: opts.projectDir,
      envName: overlayName,
    });
    if (
      await writeProjectEnvConfigFile({
        path: overlayPath,
        config: overlayConfig,
        expectedExisting: null,
      })
    ) {
      wroteFiles.push(overlayPath);
    }
  }

  if (opts.materialize) {
    await materializeProjectEnv({
      projectRoot: opts.projectRoot,
      projectDir: opts.projectDir,
      envName: undefined,
      serviceNames: opts.serviceNames,
    });
  }

  const configCleanup = await migrateLegacyProjectConfig({
    projectRoot: opts.projectRoot,
    projectDir: opts.projectDir,
  });
  const composeEnvFileReferences = await inspectLegacyComposeEnvFileReferences({
    composeFile: resolve(opts.projectDir, PROJECT_COMPOSE_FILENAME),
    projectDir: opts.projectDir,
  });
  const cleanupCandidates = await collectLegacyProjectEnvCleanupCandidates({
    projectRoot: opts.projectRoot,
    projectDir: opts.projectDir,
    overlayNames,
    materialize: opts.materialize,
    configCleanupCandidates: configCleanup.cleanupCandidates,
    composeEnvFileReferences,
  });

  return {
    wroteFiles,
    migratedOverlays: overlayNames,
    legacyDetected: true,
    updatedProjectConfig: configCleanup.changed,
    cleanupCandidates: cleanupCandidates.allowed,
    blockedCleanupCandidates: cleanupCandidates.blocked,
    composeEnvFileReferences,
  };
}

/**
 * Closed, value-free refusal of the explicit migration of a project without a
 * `.hack/hack.env.json` contract ({@link migrateUndeclaredLegacyDotenv}). It is
 * raised before any file is written, so the legacy `.hack/.env*` files and any
 * existing entries stay as they were. The message names paths, legacy file
 * names and counts only, never a key or a value.
 */
export class LegacyDotenvMigrationRefusalError extends HackCliError {
  constructor(opts: {
    readonly code: "E_CONFIG_INVALID" | "E_PATH_CONFLICT" | "E_PERMISSION";
    readonly reason: string;
  }) {
    super({
      code: opts.code,
      message: `Refusing to migrate the legacy .hack/.env files: ${opts.reason} Nothing was written, and the legacy files are kept.`,
    });
    this.name = "LegacyDotenvMigrationRefusalError";
  }
}

/** `.hack/.env.state.json` is Hack's own state file, not a dotenv overlay. */
const LEGACY_DOTENV_STATE_OVERLAY = PROJECT_ENV_STATE_FILENAME.slice(
  `${PROJECT_ENV_FILENAME}.`.length
);

/** `.hack/.env.<name>` copies that are templates or backups, not overlays. */
const LEGACY_DOTENV_NON_OVERLAY_NAMES: ReadonlySet<string> = new Set([
  "example",
  "sample",
  "template",
  "dist",
  "bak",
  "backup",
  "old",
  "orig",
]);

/** Cleanup candidates git does not track; unknown status inside a checkout is kept out. */
async function filterUntrackedLegacyCleanupCandidates(opts: {
  readonly projectRoot: string;
  readonly paths: readonly string[];
}): Promise<string[]> {
  const kept: string[] = [];
  for (const path of opts.paths) {
    const tracked = await isGitTrackedProjectEnvPath({
      projectRoot: opts.projectRoot,
      path,
    });
    const untracked =
      tracked === null
        ? !(await isInsideGitCheckoutMarker({ startDir: opts.projectRoot }))
        : !tracked;
    if (untracked) {
      kept.push(path);
    }
  }
  return kept;
}

/**
 * Legacy overlay names whose env layers would be the default layer or a
 * machine-local layer instead of an overlay (`.env.default`, `.env.local`,
 * `.env.<name>.local`).
 */
function isReservedLegacyOverlayName(name: string): boolean {
  return (
    name === "default" ||
    name === PROJECT_ENV_LOCAL_SEGMENT ||
    name.endsWith(`.${PROJECT_ENV_LOCAL_SEGMENT}`)
  );
}

function countLabel(opts: {
  readonly count: number;
  readonly noun: string;
}): string {
  return `${opts.count} ${opts.noun}${opts.count === 1 ? "" : "s"}`;
}

type PlannedEnvLayerWrite = {
  readonly path: string;
  readonly config: ProjectEnvConfig;
};

/**
 * Refuses a machine-local migration target that git tracks, or that sits in a
 * git checkout where git cannot say (fail closed), since migrated values
 * written there could be committed. Mirrors `hack env hydrate`.
 */
async function assertUntrackedMigrationLocalLayer(opts: {
  readonly projectRoot: string;
  readonly path: string;
}): Promise<void> {
  const tracked = await isGitTrackedProjectEnvPath(opts);
  if (tracked === true) {
    throw new LegacyDotenvMigrationRefusalError({
      code: "E_PATH_CONFLICT",
      reason: `git tracks the machine-local env layer ${opts.path}, so migrated values would be committed. Untrack it with \`git rm --cached\` and retry.`,
    });
  }
  if (
    tracked === null &&
    (await isInsideGitCheckoutMarker({ startDir: opts.projectRoot }))
  ) {
    throw new LegacyDotenvMigrationRefusalError({
      code: "E_PATH_CONFLICT",
      reason: `this checkout is a git repository, but git could not report whether it tracks ${opts.path}, so migrated values could be committed. Make \`git status\` work in this checkout and retry.`,
    });
  }
}

/**
 * Legacy `.hack/.env.<name>` overlays the `.env`-only migration converts.
 * Refuses, before anything is written, names that are not overlay names or
 * that would land on the default or a machine-local layer.
 */
/**
 * Names legacy overlay files for a refusal. File names are not values, but
 * each is JSON-quoted so a control character cannot break the one-line message.
 */
function legacyOverlayFileList(names: readonly string[]): string {
  return names
    .map((name) => JSON.stringify(`${PROJECT_ENV_FILENAME}.${name}`))
    .join(", ");
}

function isExcludedLegacyDotenvName(name: string): boolean {
  return (
    name === LEGACY_DOTENV_STATE_OVERLAY ||
    LEGACY_DOTENV_NON_OVERLAY_NAMES.has(name)
  );
}

/**
 * Refuses when Compose uses a `.hack/.env.<name>` file the migration leaves
 * out: its values reach no layer, and the Compose repair that follows removes
 * every `.hack/.env*` reference, so the next launch would lose them.
 */
async function assertComposeUsesNoExcludedLegacyDotenv(opts: {
  readonly projectDir: string;
}): Promise<void> {
  const references = await inspectLegacyComposeEnvFileReferences({
    composeFile: resolve(opts.projectDir, PROJECT_COMPOSE_FILENAME),
    projectDir: opts.projectDir,
  });
  const excluded = [
    ...new Set(
      references
        .map((reference) =>
          basename(reference.resolvedPath).slice(
            `${PROJECT_ENV_FILENAME}.`.length
          )
        )
        .filter(isExcludedLegacyDotenvName)
    ),
  ].sort((left, right) => left.localeCompare(right));
  if (excluded.length > 0) {
    throw new LegacyDotenvMigrationRefusalError({
      code: "E_CONFIG_INVALID",
      reason: `Compose env_file uses ${legacyOverlayFileList(excluded)}, which the migration does not carry over, so those values would be lost. Rename the file to an overlay name or move it out of .hack, update env_file to match, then retry.`,
    });
  }
}

/**
 * Refuses when Compose uses a migrated overlay that a launch without `--env`
 * would not select. Compose loads that file unconditionally, but the migration
 * puts its values only in the overlay's layers and the Compose repair removes
 * the reference, so the service would lose them. An overlay with no entries
 * beyond the base loses nothing, because the base layer already holds them.
 */
async function assertComposeOverlaysStaySelected(opts: {
  readonly projectDir: string;
  readonly overlayNames: readonly string[];
  readonly legacyValues: ReadonlyMap<string | null, Record<string, string>>;
}): Promise<void> {
  const references = await inspectLegacyComposeEnvFileReferences({
    composeFile: resolve(opts.projectDir, PROJECT_COMPOSE_FILENAME),
    projectDir: opts.projectDir,
  });
  const referenced = new Set(
    references.map((reference) =>
      basename(reference.resolvedPath).slice(`${PROJECT_ENV_FILENAME}.`.length)
    )
  );
  const defaultOverlay = await readProjectDefaultEnvConfig({
    projectDir: opts.projectDir,
  });
  const baseValues = opts.legacyValues.get(null) ?? {};
  const unselected = opts.overlayNames.filter(
    (name) =>
      name !== defaultOverlay &&
      referenced.has(name) &&
      Object.keys(
        legacyOverlayChangedValues({
          overlayValues: opts.legacyValues.get(name) ?? {},
          baseValues,
        })
      ).length > 0
  );
  if (unselected.length > 0) {
    throw new LegacyDotenvMigrationRefusalError({
      code: "E_CONFIG_INVALID",
      reason: `Compose env_file uses ${legacyOverlayFileList(unselected)}, but a launch without --env would not select ${unselected.length === 1 ? "that overlay" : "those overlays"}, so the service would lose its values. Set env.defaultOverlay to the overlay every launch should use, or remove the env_file entry and select the overlay with --env, then retry.`,
    });
  }
}

/**
 * Keys a Compose service sets in its own `environment` (map keys, or the
 * names of `KEY=value` / `KEY` list entries). Null when the entry has a shape
 * this check cannot read.
 */
function composeServiceEnvironmentKeys(
  environment: unknown
): ReadonlySet<string> | null {
  if (environment === undefined || environment === null) {
    return new Set();
  }
  if (Array.isArray(environment)) {
    const keys = new Set<string>();
    for (const entry of environment) {
      if (typeof entry !== "string") {
        return null;
      }
      const key = entry.split("=", 1)[0]?.trim() ?? "";
      if (key.length > 0) {
        keys.add(key);
      }
    }
    return keys;
  }
  return isRecord(environment) ? new Set(Object.keys(environment)) : null;
}

/** Compose's own settings: it reads these from `.hack/.env`, so only a changed value matters. */
const COMPOSE_OWN_KEY_PATTERN = /^COMPOSE_/;

/**
 * Settings the Docker client, build tools or the process itself read from their
 * environment. Migrated values enter Compose's process environment, where before
 * they only reached Compose's project environment, so even an unchanged value
 * could select another daemon or proxy.
 */
const COMPOSE_TOOL_KEY_PATTERN =
  /^(?:DOCKER_|BUILDKIT_|BUILDX_|HTTP_PROXY$|HTTPS_PROXY$|NO_PROXY$|ALL_PROXY$|SOURCE_DATE_EPOCH$|HOME$|PATH$)/;

function assertNoComposeToolKeys(opts: {
  readonly migratedKeys: ReadonlySet<string>;
}): void {
  const toolKeys = [...opts.migratedKeys]
    .filter((key) => COMPOSE_TOOL_KEY_PATTERN.test(key))
    .map((key) => JSON.stringify(key))
    .sort();
  if (toolKeys.length > 0) {
    throw new LegacyDotenvMigrationRefusalError({
      code: "E_CONFIG_INVALID",
      reason: `the legacy .env files set ${toolKeys.join(", ")}, which Docker, its build tools or the process read from their environment. After the migration these would reach the Docker client as well as the services. Set them for one service with \`hack env set --service --local\` after migrating, or in your shell, and remove them from the legacy file, then retry.`,
    });
  }
}

/**
 * Text of each non-legacy `env_file`, because Compose expands variables inside
 * those files too. An absent file adds nothing; an unreadable one was refused
 * by {@link composeEnvFileKeyConflicts}.
 */
async function composeOtherEnvFileText(opts: {
  readonly projectDir: string;
  readonly services: Record<string, unknown>;
}): Promise<string> {
  const paths = new Set(
    composeServiceEntries(opts.services).flatMap(([, rawService]) =>
      readComposeEnvFilePaths({ rawService })
        .map((configured) => resolve(opts.projectDir, configured))
        .filter(
          (candidatePath) =>
            !isLegacyProjectEnvFilePath({
              projectDir: opts.projectDir,
              candidatePath,
            })
        )
    )
  );
  const texts: string[] = [];
  for (const path of paths) {
    const read = await readOptionalTextFile(path);
    if (read.kind !== "absent" && read.kind !== "unreadable") {
      texts.push(read.text);
    }
  }
  return texts.join("\n");
}

/**
 * Keys the default overlay changes that Compose reads from its own environment:
 * any whose name appears in `searchText` (the Compose file and other `env_file`
 * text), however it is used (`${KEY}`, a bare `build.args` entry, a secret's
 * `environment:`), and Compose's own settings. Compose reads these from `.hack/.env` alone before the migration,
 * and from the selected layers after it. Matching the name anywhere can refuse
 * more than it must, which is the safe direction. Key names only, JSON-quoted.
 */
function composeReferencedOverlayKeys(opts: {
  readonly searchText: string;
  readonly legacyValues: ReadonlyMap<string | null, Record<string, string>>;
  readonly defaultOverlay: string | null;
}): readonly string[] {
  if (opts.defaultOverlay === null) {
    return [];
  }
  const changed = legacyOverlayChangedValues({
    overlayValues: opts.legacyValues.get(opts.defaultOverlay) ?? {},
    baseValues: opts.legacyValues.get(null) ?? {},
  });
  return Object.keys(changed)
    .filter(
      // Keys match PROJECT_ENV_KEY_PATTERN, so they are safe in a pattern.
      (key) =>
        COMPOSE_OWN_KEY_PATTERN.test(key) ||
        new RegExp(`(?<![A-Za-z0-9_])${key}(?![A-Za-z0-9_])`).test(
          opts.searchText
        )
    )
    .map((key) => JSON.stringify(key))
    .sort();
}

const COMPOSE_MERGE_TAG_PATTERN = /!(?:reset|override)\b/;

/** Whether a map-form `env_file` entry sets a `format`, which changes how Compose reads the file. */
function composeEnvFileHasFormat(rawEnvFile: unknown): boolean {
  return (
    Array.isArray(rawEnvFile) &&
    rawEnvFile.some((entry) => isRecord(entry) && "format" in entry)
  );
}

/**
 * Compose inputs that can add, hide or reinterpret an `env_file` this check
 * cannot read: a top-level `include`, a service `extends`, an `env_file` path
 * with a variable or a `~`, a `!reset` or `!override` tag, a repeated entry (Compose versions may drop a repeat, which
 * changes the order), or a `format`. Returned as refusal labels naming the
 * service or field only.
 */
function uncheckableComposeEnvInputs(opts: {
  readonly projectDir: string;
  readonly composeText: string;
  readonly parsed: Record<string, unknown>;
  readonly services: Record<string, unknown>;
}): readonly string[] {
  const labels: string[] =
    "include" in opts.parsed ? ["top-level include"] : [];
  if (COMPOSE_MERGE_TAG_PATTERN.test(opts.composeText)) {
    labels.push("a !reset or !override tag");
  }
  for (const [service, rawService] of composeServiceEntries(opts.services)) {
    if ("extends" in rawService) {
      labels.push(`extends in ${JSON.stringify(service)}`);
    }
    const paths = readComposeEnvFilePaths({ rawService });
    if (paths.some((path) => path.includes("$"))) {
      labels.push(`a variable env_file path in ${JSON.stringify(service)}`);
    }
    if (paths.some((path) => path.startsWith("~"))) {
      labels.push(
        `a home-relative env_file path in ${JSON.stringify(service)}`
      );
    }
    const resolved = paths.map((path) => resolve(opts.projectDir, path));
    if (new Set(resolved).size < resolved.length) {
      labels.push(`a repeated env_file entry in ${JSON.stringify(service)}`);
    }
    if (composeEnvFileHasFormat(rawService.env_file)) {
      labels.push(`an env_file format in ${JSON.stringify(service)}`);
    }
  }
  return labels;
}

/**
 * Migrated keys a service's other `env_file` entries set, as refusal labels.
 * Those files stay in Compose, but Hack's generated override applies migrated
 * values after them. An absent file sets nothing; an unreadable one refuses.
 */
async function composeEnvFileKeyConflicts(opts: {
  readonly projectDir: string;
  readonly service: string;
  readonly rawService: Record<string, unknown>;
  readonly migratedKeys: ReadonlySet<string>;
}): Promise<readonly string[]> {
  const conflicts: string[] = [];
  for (const configuredPath of readComposeEnvFilePaths({
    rawService: opts.rawService,
  })) {
    const path = resolve(opts.projectDir, configuredPath);
    if (
      isLegacyProjectEnvFilePath({
        projectDir: opts.projectDir,
        candidatePath: path,
      })
    ) {
      continue;
    }
    const values = await readLegacyDotenvFile({ path });
    for (const key of Object.keys(values)) {
      if (opts.migratedKeys.has(key)) {
        conflicts.push(
          `${JSON.stringify(key)} (${JSON.stringify(configuredPath)} in ${JSON.stringify(opts.service)})`
        );
      }
    }
  }
  return conflicts;
}

/** Per-service `environment` and other `env_file` entries that set a migrated key. */
async function collectComposeServiceConflicts(opts: {
  readonly projectDir: string;
  readonly services: Record<string, unknown>;
  readonly migratedKeys: ReadonlySet<string>;
}): Promise<{
  readonly conflicts: string[];
  readonly unreadable: string[];
  readonly envFileConflicts: string[];
}> {
  const conflicts: string[] = [];
  const unreadable: string[] = [];
  const envFileConflicts: string[] = [];
  for (const [service, rawService] of Object.entries(opts.services)) {
    if (!isRecord(rawService)) {
      continue;
    }
    envFileConflicts.push(
      ...(await composeEnvFileKeyConflicts({
        projectDir: opts.projectDir,
        service,
        rawService,
        migratedKeys: opts.migratedKeys,
      }))
    );
    const keys = composeServiceEnvironmentKeys(rawService.environment);
    if (keys === null) {
      unreadable.push(JSON.stringify(service));
      continue;
    }
    for (const key of [...keys].filter((name) => opts.migratedKeys.has(name))) {
      conflicts.push(`${JSON.stringify(key)} in ${JSON.stringify(service)}`);
    }
  }
  return { conflicts, unreadable, envFileConflicts };
}

/**
 * Refuses when a migrated key is also set in a Compose service's own
 * `environment` or another of its `env_file` entries. Legacy `env_file` values rank below `environment`, but the
 * migrated values become global layer values, which Hack's generated Compose
 * override applies to every service after `environment`; the service would
 * silently switch to the dotenv value. The refusal names services and keys,
 * JSON-quoted, never values.
 */
async function assertComposeEnvironmentKeepsPrecedence(opts: {
  readonly projectDir: string;
  readonly legacyValues: ReadonlyMap<string | null, Record<string, string>>;
}): Promise<void> {
  const migratedKeys = new Set<string>();
  for (const values of opts.legacyValues.values()) {
    for (const key of Object.keys(values)) {
      migratedKeys.add(key);
    }
  }
  if (migratedKeys.size === 0) {
    return;
  }
  assertNoComposeToolKeys({ migratedKeys });
  const composeFile = resolve(opts.projectDir, PROJECT_COMPOSE_FILENAME);
  const composeText = (await readTextFile(composeFile)) ?? "";
  const parsed = await readComposeFile({ composeFile });
  if (parsed === null && composeText.trim().length > 0) {
    throw new LegacyDotenvMigrationRefusalError({
      code: "E_CONFIG_INVALID",
      reason: `${PROJECT_COMPOSE_FILENAME} is not a single YAML document this check can read, such as a file with several "---" documents, so the migration cannot tell which values services receive. Merge it into one document, then retry.`,
    });
  }
  if (!parsed) {
    return;
  }
  // No `services` still runs the checks: `include` can supply every service.
  const services = getRecord(parsed, "services") ?? {};
  const uncheckable = uncheckableComposeEnvInputs({
    projectDir: opts.projectDir,
    composeText,
    parsed,
    services,
  });
  if (uncheckable.length > 0) {
    throw new LegacyDotenvMigrationRefusalError({
      code: "E_CONFIG_INVALID",
      reason: `Compose uses ${uncheckable.join(", ")}, so the migration cannot tell which values services receive from the legacy .env files. Write those services' env_file entries directly in ${PROJECT_COMPOSE_FILENAME}, each file once, with a plain path and no format, and remove any !reset or !override text (a comment or value containing it also matches), then retry.`,
    });
  }
  const { conflicts, unreadable, envFileConflicts } =
    await collectComposeServiceConflicts({
      projectDir: opts.projectDir,
      services,
      migratedKeys,
    });
  if (unreadable.length > 0) {
    throw new LegacyDotenvMigrationRefusalError({
      code: "E_CONFIG_INVALID",
      reason: `the Compose environment of ${unreadable.sort().join(", ")} cannot be read, so the migration cannot check that it keeps precedence over the migrated values. Use a map or a list of KEY=value entries, then retry.`,
    });
  }
  if (conflicts.length > 0) {
    throw new LegacyDotenvMigrationRefusalError({
      code: "E_CONFIG_INVALID",
      reason: `Compose environment sets ${conflicts.sort().join(", ")}, which the legacy .env files also set; after the migration the .env value would override the Compose value. Remove the key from the .hack/.env file or from that service's environment, then retry.`,
    });
  }
  if (envFileConflicts.length > 0) {
    throw new LegacyDotenvMigrationRefusalError({
      code: "E_CONFIG_INVALID",
      reason: `Compose env_file sets ${envFileConflicts.sort().join(", ")}, which the legacy .env files also set; after the migration the .env value would override that file's value. Remove the key from the .hack/.env file or from that env_file, then retry.`,
    });
  }
  const defaultOverlay = await readProjectDefaultEnvConfig({
    projectDir: opts.projectDir,
  });
  const referenced = composeReferencedOverlayKeys({
    searchText: `${JSON.stringify(parsed)}\n${await composeOtherEnvFileText({
      projectDir: opts.projectDir,
      services,
    })}`,
    legacyValues: opts.legacyValues,
    defaultOverlay,
  });
  if (referenced.length > 0) {
    throw new LegacyDotenvMigrationRefusalError({
      code: "E_CONFIG_INVALID",
      reason: `Compose reads ${referenced.join(", ")}, which the default overlay sets differently from .hack/.env. Compose takes these from .hack/.env today, but after the migration the overlay value would apply. Make the two files agree or stop using the key in Compose, then retry.`,
    });
  }
  assertComposeServicesKeepLegacyValues({
    projectDir: opts.projectDir,
    services,
    legacyValues: opts.legacyValues,
    defaultOverlay,
  });
}

/** Compose services as records, skipping entries that are not service maps. */
function composeServiceEntries(
  services: Record<string, unknown>
): readonly (readonly [string, Record<string, unknown>])[] {
  return Object.entries(services).filter(
    (entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])
  );
}

/** Legacy files a service lists in `env_file`, as `legacyValues` keys. */
function composeServiceLegacyEnvNames(opts: {
  readonly projectDir: string;
  readonly rawService: Record<string, unknown>;
  readonly legacyValues: ReadonlyMap<string | null, Record<string, string>>;
}): readonly (string | null)[] {
  const listed = readComposeEnvFilePaths({ rawService: opts.rawService }).map(
    (configured) => resolve(opts.projectDir, configured)
  );
  return [...opts.legacyValues.keys()].filter((envName) =>
    listed.includes(
      resolveEnvFilePath({ projectDir: opts.projectDir, envName })
    )
  );
}

/**
 * Before the migration a legacy dotenv file listed in `env_file` reached only
 * the services that list it; after it, its values are global layer values that
 * Hack applies to every service. When any service lists a legacy file, returns
 * refusal labels (file, service and key names only) for each file with values
 * to migrate that only some services list, for a default overlay some service
 * does not list, and for each service that does not list a file setting a base
 * key.
 *
 * A project where no service lists a legacy file has no `env_file` boundary to
 * compare, and its values may be needed for interpolation, so it is not refused
 * here; {@link legacyKeysNewToEveryService} reports what those services gain.
 */
function composeServicesMissingLegacyDotenv(opts: {
  readonly projectDir: string;
  readonly services: Record<string, unknown>;
  readonly legacyValues: ReadonlyMap<string | null, Record<string, string>>;
  readonly defaultOverlay: string | null;
}): string[] {
  const baseValues = opts.legacyValues.get(null) ?? {};
  const services = composeServiceEntries(opts.services).map(
    ([service, rawService]) => ({
      label: JSON.stringify(service),
      listed: composeServiceLegacyEnvNames({
        projectDir: opts.projectDir,
        rawService,
        legacyValues: opts.legacyValues,
      }),
    })
  );
  if (services.every((service) => service.listed.length === 0)) {
    return [];
  }
  const labels: string[] = [];
  for (const [envName, values] of opts.legacyValues) {
    const migrated =
      envName === null
        ? values
        : legacyOverlayChangedValues({ overlayValues: values, baseValues });
    if (Object.keys(migrated).length === 0) {
      continue;
    }
    const missing = services
      .filter((service) => !service.listed.includes(envName))
      .map((service) => service.label)
      .sort();
    // Every launch selects the default overlay, so its values reach every
    // service even when no service lists it.
    const reachesEveryLaunch =
      envName !== null && envName === opts.defaultOverlay;
    if (
      missing.length > 0 &&
      (missing.length < services.length || reachesEveryLaunch)
    ) {
      labels.push(
        `${missing.join(", ")} ${missing.length === 1 ? "does" : "do"} not list ${JSON.stringify(basename(resolveEnvFilePath({ projectDir: opts.projectDir, envName })))} in env_file`
      );
    }
  }
  for (const service of services) {
    const had = new Set(
      service.listed.flatMap((envName) =>
        Object.keys(opts.legacyValues.get(envName) ?? {})
      )
    );
    const gained = Object.keys(baseValues)
      .filter((key) => !had.has(key))
      .map((key) => JSON.stringify(key))
      .sort();
    if (gained.length > 0 && !service.listed.includes(null)) {
      labels.push(
        `${service.label} lists no legacy file that sets ${gained.join(", ")}`
      );
    }
  }
  return labels.sort();
}

/**
 * Refuses when a service would gain a value it never had, or a listed key
 * would change because the migration ignores `env_file` order.
 */
function assertComposeServicesKeepLegacyValues(opts: {
  readonly projectDir: string;
  readonly services: Record<string, unknown>;
  readonly legacyValues: ReadonlyMap<string | null, Record<string, string>>;
  readonly defaultOverlay: string | null;
}): void {
  const unlisted = composeServicesMissingLegacyDotenv(opts);
  if (unlisted.length > 0) {
    throw new LegacyDotenvMigrationRefusalError({
      code: "E_CONFIG_INVALID",
      reason: `${unlisted.join("; ")}. Migrated values are global and reach every service, so those services would receive values they never had. List the file in env_file for those services if they may have its values, or move the values out of it and set them with \`hack env set --service\` after migrating, then retry.`,
    });
  }
  const orderConflicts = composeLegacyEnvFileOrderConflicts(opts);
  if (orderConflicts.length > 0) {
    throw new LegacyDotenvMigrationRefusalError({
      code: "E_CONFIG_INVALID",
      reason: `the order of Compose env_file gives ${orderConflicts.join(", ")} a different value from the migrated layers, where the default overlay wins over .hack/.env. List .env before the overlay, or make the files agree, then retry.`,
    });
  }
}

/**
 * Keys whose value a service would change because the migration ignores
 * `env_file` order. Compose lets the last listed file win; the selected layers
 * always let the default overlay win over the base. Refusal labels naming keys
 * and services, never values.
 */
function composeLegacyEnvFileOrderConflicts(opts: {
  readonly projectDir: string;
  readonly services: Record<string, unknown>;
  readonly legacyValues: ReadonlyMap<string | null, Record<string, string>>;
  readonly defaultOverlay: string | null;
}): readonly string[] {
  const selected = {
    ...(opts.legacyValues.get(null) ?? {}),
    ...(opts.defaultOverlay === null
      ? {}
      : (opts.legacyValues.get(opts.defaultOverlay) ?? {})),
  };
  const envNameByPath = new Map(
    [...opts.legacyValues.keys()].map((envName) => [
      resolveEnvFilePath({ projectDir: opts.projectDir, envName }),
      envName,
    ])
  );
  const conflicts: string[] = [];
  for (const [service, rawService] of composeServiceEntries(opts.services)) {
    const effective: Record<string, string> = {};
    for (const configured of readComposeEnvFilePaths({ rawService })) {
      const envName = envNameByPath.get(resolve(opts.projectDir, configured));
      if (envName !== undefined) {
        Object.assign(effective, opts.legacyValues.get(envName) ?? {});
      }
    }
    for (const [key, value] of Object.entries(effective)) {
      if (key in selected && selected[key] !== value) {
        conflicts.push(`${JSON.stringify(key)} in ${JSON.stringify(service)}`);
      }
    }
  }
  return conflicts.sort();
}

/**
 * Migrated keys from legacy files no service lists in `env_file`, for the
 * migration to name: they reach every service once their env is selected.
 * Files a service lists are covered by {@link composeServicesMissingLegacyDotenv}.
 */
async function legacyKeysNewToEveryService(opts: {
  readonly projectDir: string;
  readonly legacyValues: ReadonlyMap<string | null, Record<string, string>>;
}): Promise<readonly string[]> {
  const parsed = await readComposeFile({
    composeFile: resolve(opts.projectDir, PROJECT_COMPOSE_FILENAME),
  });
  const services = parsed ? getRecord(parsed, "services") : null;
  if (!services) {
    return [];
  }
  const entries = composeServiceEntries(services);
  if (entries.length === 0) {
    return [];
  }
  const listed = new Set(
    entries.flatMap(([, rawService]) =>
      composeServiceLegacyEnvNames({
        projectDir: opts.projectDir,
        rawService,
        legacyValues: opts.legacyValues,
      })
    )
  );
  const baseValues = opts.legacyValues.get(null) ?? {};
  const keys = new Set<string>();
  for (const [envName, values] of opts.legacyValues) {
    if (listed.has(envName)) {
      continue;
    }
    const migrated =
      envName === null
        ? values
        : legacyOverlayChangedValues({ overlayValues: values, baseValues });
    for (const key of Object.keys(migrated)) {
      keys.add(key);
    }
  }
  return [...keys].sort((left, right) => left.localeCompare(right));
}

/**
 * Entries the current layers don't deliver with the same value. With no layers
 * that is all of them. Skipping the rest keeps a teammate from pinning a team
 * value in their local layer, where a later team change wouldn't reach them.
 */
function legacyValuesNotDelivered(opts: {
  readonly values: Record<string, string>;
  readonly delivered: Readonly<Record<string, string>>;
}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(opts.values).filter(
      ([key, value]) => opts.delivered[key] !== value
    )
  );
}

/** Overlay entries a migrated overlay layer must hold: those that differ from the base. */
function legacyOverlayChangedValues(opts: {
  readonly overlayValues: Record<string, string>;
  readonly baseValues: Record<string, string>;
}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(opts.overlayValues).filter(
      ([key, value]) => opts.baseValues[key] !== value
    )
  );
}

async function selectLegacyDotenvOverlays(opts: {
  readonly projectDir: string;
}): Promise<readonly string[]> {
  // Template and backup copies (`.env.example`, `.env.bak`, ...) are not
  // overlays: they are neither migrated nor offered for cleanup.
  const overlayNames =
    // A symlinked overlay is an overlay too: skipping it would switch formats
    // without its values. Its target is checked by the migration before reading.
    (
      await discoverLegacyOverlayNames({
        projectDir: opts.projectDir,
        includeSymlinks: true,
      })
    ).filter((name) => !isExcludedLegacyDotenvName(name));
  const invalidOverlays = overlayNames.filter(
    (name) =>
      !(
        isReservedLegacyOverlayName(name) ||
        NATIVE_ENV_OVERLAY_PATTERN.test(name)
      )
  );
  if (invalidOverlays.length > 0) {
    throw new LegacyDotenvMigrationRefusalError({
      code: "E_CONFIG_INVALID",
      reason: `${legacyOverlayFileList(invalidOverlays)} in ${opts.projectDir} ${invalidOverlays.length === 1 ? "is not named" : "are not named"} like an overlay (lowercase letters, digits and single dashes). Rename ${invalidOverlays.length === 1 ? "it" : "them"} (and select the overlay by its new name with --env) or remove ${invalidOverlays.length === 1 ? "it" : "them"}, then retry.`,
    });
  }
  const reservedOverlays = overlayNames.filter(isReservedLegacyOverlayName);
  if (reservedOverlays.length > 0) {
    throw new LegacyDotenvMigrationRefusalError({
      code: "E_CONFIG_INVALID",
      reason: `${legacyOverlayFileList(reservedOverlays)} would become the default or a machine-local env layer rather than an overlay. Rename it to another overlay name or remove it, then retry.`,
    });
  }
  return overlayNames;
}

export type UnmigratedLegacyDotenv = {
  /** Valid key names the layers don't deliver with the same value. */
  readonly keys: readonly string[];
  /** Entries whose name isn't a valid key; a name could hold a value, so never shown. */
  readonly malformedCount: number;
  /** Legacy file names that exist but can't be read. */
  readonly unreadableFiles: readonly string[];
};

/** The value each key has from the layers selected for `envName`. Empty when none can be read. */
async function deliveredLayerValues(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly serviceNames: readonly string[];
  readonly envName: string | null;
}): Promise<Readonly<Record<string, string>>> {
  try {
    return (await resolveProjectEnvConfig(opts))?.globalEnv ?? {};
  } catch {
    // An unusable layer delivers nothing, and its own commands report it.
    return {};
  }
}

/**
 * What this checkout's legacy `.hack/.env*` files hold that its env layers don't
 * deliver, in a project that already has layers, for example after a teammate's
 * migration was committed. The answer comes from comparing values, not from which
 * files exist: an unrelated local layer doesn't make a value safe to overwrite.
 *
 * A contract project is out of scope, because its own migration owns those files.
 * `.hack/.env` with a valid state file is generated output, so it is skipped;
 * overlays are not generated by materialize, so they are always compared.
 */
export async function findUnmigratedLegacyDotenv(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly serviceNames: readonly string[];
}): Promise<UnmigratedLegacyDotenv> {
  const none = { keys: [], malformedCount: 0, unreadableFiles: [] };
  const entries = await readdir(opts.projectDir, { withFileTypes: true });
  const hasLayers = entries.some(
    (entry) =>
      entry.name.startsWith(PROJECT_ENV_CONFIG_FILENAME_PREFIX) &&
      entry.name.endsWith(PROJECT_ENV_CONFIG_FILENAME_SUFFIX)
  );
  if (
    !hasLayers ||
    (await pathExists(resolve(opts.projectDir, PROJECT_ENV_CONTRACT_FILENAME)))
  ) {
    return none;
  }
  const state = await readProjectEnvStateFile({
    statePath: resolveProjectEnvStatePath({ projectDir: opts.projectDir }),
  });
  const overlayNames = (
    await discoverLegacyOverlayNames({
      projectDir: opts.projectDir,
      includeSymlinks: true,
    })
  ).filter(
    (name) =>
      !(
        isExcludedLegacyDotenvName(name) || isReservedLegacyOverlayName(name)
      ) && NATIVE_ENV_OVERLAY_PATTERN.test(name)
  );
  const keys = new Set<string>();
  const unreadableFiles: string[] = [];
  let malformedCount = 0;
  for (const envName of [...(state.ok ? [] : [null]), ...overlayNames]) {
    const path = resolveEnvFilePath({ projectDir: opts.projectDir, envName });
    const read = await readOptionalTextFile(path);
    if (read.kind === "unreadable") {
      unreadableFiles.push(basename(path));
    }
    if (read.kind !== "text") {
      continue;
    }
    const delivered = await deliveredLayerValues({ ...opts, envName });
    for (const [key, value] of Object.entries(parseDotEnv(read.text))) {
      if (!PROJECT_ENV_KEY_PATTERN.test(key)) {
        malformedCount += 1;
      } else if (delivered[key] !== value) {
        keys.add(key);
      }
    }
  }
  return {
    keys: [...keys].sort((left, right) => left.localeCompare(right)),
    malformedCount,
    unreadableFiles,
  };
}

export function hasUnmigratedLegacyDotenv(
  unmigrated: UnmigratedLegacyDotenv
): boolean {
  return (
    unmigrated.keys.length > 0 ||
    unmigrated.malformedCount > 0 ||
    unmigrated.unreadableFiles.length > 0
  );
}

/** Value-free description: valid key names, a count of malformed names, and file names. */
export function describeUnmigratedLegacyDotenv(
  unmigrated: UnmigratedLegacyDotenv
): string {
  const parts: string[] = [];
  if (unmigrated.keys.length > 0) {
    parts.push(`sets ${unmigrated.keys.join(", ")}`);
  }
  if (unmigrated.malformedCount > 0) {
    parts.push(
      `has ${countLabel({ count: unmigrated.malformedCount, noun: "malformed entry" })} (not shown, because a malformed line may contain a value)`
    );
  }
  if (unmigrated.unreadableFiles.length > 0) {
    parts.push(`can't read ${unmigrated.unreadableFiles.join(", ")}`);
  }
  return parts.join("; ");
}

/** Whether `doctor --migrate-env-config` can move these values: regular layer files only. */
export async function canMigrateCheckoutLegacyDotenv(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly serviceNames: readonly string[];
}): Promise<boolean> {
  const entries = await readdir(opts.projectDir, { withFileTypes: true });
  const allRegular = entries
    .filter(
      (entry) =>
        entry.name.startsWith(PROJECT_ENV_CONFIG_FILENAME_PREFIX) &&
        entry.name.endsWith(PROJECT_ENV_CONFIG_FILENAME_SUFFIX)
    )
    .every((entry) => entry.isFile());
  return (
    allRegular &&
    hasUnmigratedLegacyDotenv(await findUnmigratedLegacyDotenv(opts))
  );
}

/**
 * Refuses a legacy `.hack/.env` or overlay that is a symlink at all, dangling or
 * not, for a migration that publishes values to tracked layers.
 */
async function assertNoLegacyDotenvLinks(opts: {
  readonly projectDir: string;
  readonly overlayNames: readonly string[];
}): Promise<void> {
  const linked: string[] = [];
  for (const envName of [null, ...opts.overlayNames]) {
    const path = resolveEnvFilePath({ projectDir: opts.projectDir, envName });
    const entry = await lstat(path).catch(() => null);
    if (entry?.isSymbolicLink()) {
      linked.push(JSON.stringify(basename(path)));
    }
  }
  if (linked.length > 0) {
    throw new LegacyDotenvMigrationRefusalError({
      code: "E_PATH_CONFLICT",
      reason: `${linked.join(", ")} ${linked.length === 1 ? "is a symlink" : "are symlinks"}, and this migration writes plain_env values to tracked env layers, so another file's values could be committed. Replace the link with a regular file, or remove it, then retry.`,
    });
  }
}

/**
 * Refuses a legacy `.hack/.env` or overlay that is a symlink resolving outside
 * `.hack`, so a repository cannot pull an outside file, such as a root `.env`,
 * into its env layers. A dangling link stays for the read to refuse.
 */
async function assertLegacyDotenvLinksStayInProject(opts: {
  readonly projectDir: string;
  readonly overlayNames: readonly string[];
}): Promise<void> {
  const projectDir = await realpath(opts.projectDir);
  const escaping: string[] = [];
  for (const envName of [null, ...opts.overlayNames]) {
    const path = resolveEnvFilePath({ projectDir: opts.projectDir, envName });
    const entry = await lstat(path).catch(() => null);
    if (!entry?.isSymbolicLink()) {
      continue;
    }
    const target = await realpath(path).catch(() => null);
    if (target === null) {
      continue;
    }
    const inside = relative(projectDir, target);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      escaping.push(JSON.stringify(basename(path)));
    }
  }
  if (escaping.length > 0) {
    throw new LegacyDotenvMigrationRefusalError({
      code: "E_PATH_CONFLICT",
      reason: `${escaping.join(", ")} ${escaping.length === 1 ? "is a symlink" : "are symlinks"} to a file outside .hack, so migrating would copy that file's values into this project's env layers. Replace the link with a regular file in .hack, or remove it, then retry.`,
    });
  }
}

/**
 * In a git checkout, a machine-local layer the migration writes must be
 * ignored by git, or its plaintext values could be committed. Unknown status
 * inside a checkout refuses too. Outside a checkout nothing can be committed.
 */
async function assertIgnoredMigrationLocalLayer(opts: {
  readonly projectRoot: string;
  readonly path: string;
}): Promise<void> {
  const ignored = await isGitIgnoredProjectEnvPath(opts);
  if (ignored === true) {
    return;
  }
  if (
    ignored === null &&
    !(await isInsideGitCheckoutMarker({ startDir: opts.projectRoot }))
  ) {
    return;
  }
  throw new LegacyDotenvMigrationRefusalError({
    code: "E_PATH_CONFLICT",
    reason: `git does not ignore the machine-local env layer ${opts.path}, so migrated values could be committed. Make .hack/.gitignore writable (or ignore that path), then retry.`,
  });
}

const COMPOSE_UNQUOTED_INLINE_COMMENT_PATTERN = /\s#/;

/** End of the quoted value in `text`, or -1 when it continues on the next line. */
function closingQuoteIndex(opts: {
  readonly text: string;
  readonly quote: string;
}): number {
  for (let index = 0; index < opts.text.length; index += 1) {
    if (opts.text[index] === "\\") {
      index += 1;
    } else if (opts.text[index] === opts.quote) {
      return index;
    }
  }
  return -1;
}

/**
 * Counts dotenv entries Compose reads differently from {@link parseDotEnv}.
 * Compose drops an unquoted inline comment, expands `$` outside single quotes,
 * reads backslashes in quoted values differently (across lines too), reads
 * text after a closing quote as another entry, and accepts `KEY: value` and a
 * bare `KEY`, while the parser keeps the text literally or skips it. A migrated value goes through Hack's generated override, so
 * the service would receive the parser's reading instead.
 */
function countComposeOnlyDotenvEntries(text: string): number {
  let count = 0;
  let open: { quote: string; flagged: boolean } | null = null;
  for (const rawLine of text.split("\n")) {
    let quoted = rawLine;
    if (open === null) {
      const entry = readComposeDotenvEntryStart(rawLine);
      count += entry.differs ? 1 : 0;
      if (entry.quote === null) {
        continue;
      }
      open = { quote: entry.quote, flagged: false };
      quoted = entry.text;
    }
    const end = closingQuoteIndex({ text: quoted, quote: open.quote });
    if (
      !open.flagged &&
      composeReadsQuotedTextDifferently({
        text: quoted,
        end,
        quote: open.quote,
      })
    ) {
      open.flagged = true;
      count += 1;
    }
    if (end !== -1) {
      open = null;
    }
  }
  return count;
}

/** Whether Compose reads this line of a quoted value differently from the parser. */
function composeReadsQuotedTextDifferently(opts: {
  readonly text: string;
  readonly end: number;
  readonly quote: string;
}): boolean {
  const content = opts.end === -1 ? opts.text : opts.text.slice(0, opts.end);
  const trailing = opts.end === -1 ? "" : opts.text.slice(opts.end + 1).trim();
  return (
    content.includes("\\") ||
    (opts.quote === '"' && content.includes("$")) ||
    !(trailing.length === 0 || trailing.startsWith("#"))
  );
}

/**
 * Reads a dotenv line that starts an entry. `quote` is set when the value is
 * quoted, with `text` as what follows the opening quote; otherwise `differs`
 * says whether Compose reads the whole line differently.
 */
function readComposeDotenvEntryStart(rawLine: string): {
  readonly differs: boolean;
  readonly quote: string | null;
  readonly text: string;
} {
  const line = rawLine.trim();
  if (line.length === 0 || line.startsWith("#")) {
    return { differs: false, quote: null, text: "" };
  }
  const separator = rawLine.indexOf("=");
  if (separator <= 0) {
    return { differs: true, quote: null, text: "" };
  }
  const value = rawLine.slice(separator + 1).trimStart();
  const first = value[0];
  if (first === '"' || first === "'") {
    return { differs: false, quote: first, text: value.slice(1) };
  }
  return {
    differs:
      value.includes("$") ||
      COMPOSE_UNQUOTED_INLINE_COMMENT_PATTERN.test(value),
    quote: null,
    text: "",
  };
}

/**
 * Entries of `.hack/.env` (key `null`) and each legacy overlay file. Refuses,
 * before anything is written, when a key cannot be an env layer key; the
 * refusal counts such keys per file and never shows them.
 */
async function readValidatedLegacyDotenvFiles(opts: {
  readonly projectDir: string;
  readonly overlayNames: readonly string[];
}): Promise<ReadonlyMap<string | null, Record<string, string>>> {
  const legacyFiles = [
    { envName: null, label: PROJECT_ENV_FILENAME },
    ...opts.overlayNames.map((name) => ({
      envName: name,
      label: `${PROJECT_ENV_FILENAME}.${name}`,
    })),
  ];
  const legacyValues = new Map<string | null, Record<string, string>>();
  const invalidKeyCounts: string[] = [];
  const composeSyntaxCounts: string[] = [];
  for (const file of legacyFiles) {
    const path = resolveEnvFilePath({
      projectDir: opts.projectDir,
      envName: file.envName,
    });
    const values = await readLegacyDotenvFile({ path });
    legacyValues.set(file.envName, values);
    const read = await readOptionalTextFile(path);
    const composeSyntax =
      read.kind === "absent" || read.kind === "unreadable"
        ? 0
        : countComposeOnlyDotenvEntries(read.text);
    if (composeSyntax > 0) {
      composeSyntaxCounts.push(
        `${countLabel({ count: composeSyntax, noun: "line" })} in ${file.label}`
      );
    }
    const invalid = Object.keys(values).filter(
      (key) => !PROJECT_ENV_KEY_PATTERN.test(key)
    ).length;
    if (invalid > 0) {
      invalidKeyCounts.push(
        `${countLabel({ count: invalid, noun: "key" })} in ${file.label}`
      );
    }
  }
  if (invalidKeyCounts.length > 0) {
    throw new LegacyDotenvMigrationRefusalError({
      code: "E_CONFIG_INVALID",
      reason: `env keys must match ^[A-Z_][A-Z0-9_]*$, but ${invalidKeyCounts.join(", ")} do not (for example a lowercase name or an "export " prefix). The keys are not shown because a malformed line may contain a value. Rename or remove them, then retry.`,
    });
  }
  if (composeSyntaxCounts.length > 0) {
    throw new LegacyDotenvMigrationRefusalError({
      code: "E_CONFIG_INVALID",
      reason: `Compose reads ${composeSyntaxCounts.join(", ")} differently from Hack, so the migrated value would change or be lost: an unquoted " #" starts a comment, "$" outside single quotes is expanded, "\\" in a quoted value is read differently, text after a closing quote is another entry, and a line without "=" still sets a key. Write each one on its own as KEY='the value Compose uses' with real line breaks and no backslashes, or remove it, then retry. The lines are not shown because they may contain values.`,
    });
  }
  return legacyValues;
}

/**
 * An existing machine-local layer the migration may add to, or null when absent.
 * Refuses one it can't read or parse, or that isn't a regular file: `.config`
 * would be an empty default, and treating it as absent or empty loses values.
 * The refusal names the file, never its content.
 */
async function readExistingLocalLayer(opts: {
  readonly path: string;
  readonly environment: string;
}): Promise<{
  readonly text: string;
  readonly config: ProjectEnvConfig;
} | null> {
  const read = await readOptionalTextFile(opts.path);
  if (read.kind === "absent") {
    return null;
  }
  const parsed =
    read.kind === "text"
      ? parseProjectEnvConfigText({ ...opts, text: read.text })
      : null;
  const entry = await lstat(opts.path).catch(() => null);
  if (
    read.kind !== "text" ||
    parsed?.parseError !== undefined ||
    !entry?.isFile() ||
    !parsed
  ) {
    throw new LegacyDotenvMigrationRefusalError({
      code: "E_CONFIG_INVALID",
      reason: `${basename(opts.path)} can't be read as an env layer, so migrated values can't be added to it safely. Fix or move that file, then retry.`,
    });
  }
  return { text: read.text, config: parsed.config };
}

/**
 * Refuses when an existing local overlay sets a key its legacy overlay file sets
 * differently. Planning drops an overlay entry equal to the base, and this layer
 * would keep winning over it, so the disagreement would pass unnoticed and leave
 * a key reported as undelivered that no further migration could clear.
 */
async function assertLocalOverlaysAgreeWithLegacy(opts: {
  readonly projectDir: string;
  readonly overlayNames: readonly string[];
  readonly legacyValues: ReadonlyMap<string | null, Record<string, string>>;
}): Promise<void> {
  const conflicts: string[] = [];
  for (const overlayName of opts.overlayNames) {
    const path = resolveProjectEnvLocalConfigPath({
      projectDir: opts.projectDir,
      envName: overlayName,
    });
    const layer = await readExistingLocalLayer({
      path,
      environment: overlayName,
    });
    if (layer === null) {
      continue;
    }
    const global = layer.config.values.global ?? {};
    for (const [key, value] of Object.entries(
      opts.legacyValues.get(overlayName) ?? {}
    )) {
      if (key in global && global[key] !== value) {
        conflicts.push(`${JSON.stringify(key)} in ${basename(path)}`);
      }
    }
  }
  if (conflicts.length > 0) {
    throw new LegacyDotenvMigrationRefusalError({
      code: "E_PATH_CONFLICT",
      reason: `the legacy .env files and the local layer set ${conflicts.sort().join(", ")} to different values. Keep the one you want, by removing the key from the other, then retry.`,
    });
  }
}

/**
 * Replaces a local layer with mode 0600, because the values were in a private
 * `.env` and a layer from `hack env set --local` may be readable by others. It
 * doesn't follow a link at the path: the reader opens no-follow, staging is
 * private from creation, and rename replaces the path itself.
 */
async function replaceLocalLayerPrivately(opts: {
  readonly projectDir: string;
  readonly path: string;
  readonly config: ProjectEnvConfig;
  readonly expectedExisting: string;
}): Promise<void> {
  const options = {
    path: opts.path,
    directories: [opts.projectDir],
    refusal: () =>
      new LegacyDotenvMigrationRefusalError({
        code: "E_PATH_CONFLICT",
        reason: `${basename(opts.path)} changed during the migration or is not a regular file. Check it, then retry.`,
      }),
  };
  const current = await readReplaceablePrivateFile(options);
  if (current?.text !== opts.expectedExisting) {
    throw options.refusal();
  }
  await replacePrivateFileAtomic({
    ...options,
    text: serializeProjectEnvConfig(opts.config),
  });
}

/**
 * Plans adding migrated keys to machine-local layers that already exist. Refuses
 * a key the layer sets to something else, because either value could be the one
 * to keep. The refusal names keys and files, never values.
 */
async function planLocalLayerMerges(opts: {
  readonly localWrites: readonly PlannedEnvLayerWrite[];
}): Promise<
  readonly {
    readonly path: string;
    readonly config: ProjectEnvConfig;
    readonly expectedExisting: string;
  }[]
> {
  const merges: {
    path: string;
    config: ProjectEnvConfig;
    expectedExisting: string;
  }[] = [];
  const conflicts: string[] = [];
  for (const write of opts.localWrites) {
    const layer = await readExistingLocalLayer({
      path: write.path,
      environment: write.config.environment,
    });
    if (layer === null) {
      continue;
    }
    const existing = layer.config;
    const global = existing.values.global ?? {};
    const added = write.config.values.global ?? {};
    conflicts.push(
      ...Object.keys(added)
        .filter((key) => key in global)
        .map((key) => `${JSON.stringify(key)} in ${basename(write.path)}`)
    );
    merges.push({
      path: write.path,
      config: {
        ...existing,
        values: { ...existing.values, global: { ...global, ...added } },
      },
      expectedExisting: layer.text,
    });
  }
  if (conflicts.length > 0) {
    throw new LegacyDotenvMigrationRefusalError({
      code: "E_PATH_CONFLICT",
      reason: `the legacy .env files and the local layer set ${conflicts.sort().join(", ")} to different values. Keep the one you want, by removing the key from the other, then retry.`,
    });
  }
  return merges;
}

/**
 * Publishes machine-local layers, then tracked ones. If a write fails, removes
 * what this call created, so the checkout keeps using the legacy files.
 */
async function publishMigratedLegacyLayers(opts: {
  readonly projectDir: string;
  readonly localWrites: readonly PlannedEnvLayerWrite[];
  readonly trackedWrites: readonly PlannedEnvLayerWrite[];
  /** Local layers that exist and receive these values by merging instead. */
  readonly mergedPaths: ReadonlySet<string>;
}): Promise<string[]> {
  // Machine-local layers first, so the tracked layers switch the format only
  // once the values have a home.
  const wroteFiles: string[] = [];
  try {
    for (const write of opts.localWrites) {
      if (opts.mergedPaths.has(write.path)) {
        continue;
      }
      // Created 0600 from the start: the values were in a private .env.
      await publishMigrationLocalLayer({
        projectDir: opts.projectDir,
        write,
      });
      wroteFiles.push(write.path);
    }
    for (const write of opts.trackedWrites) {
      // Another checkout's migration may already have committed this layer.
      if (await pathExists(write.path)) {
        continue;
      }
      if (
        await writeProjectEnvConfigFile({
          path: write.path,
          config: write.config,
          expectedExisting: null,
        })
      ) {
        wroteFiles.push(write.path);
      }
    }
  } catch (error: unknown) {
    // Every target was absent before this call, so removing what it created
    // leaves the project on the legacy files.
    for (const path of [...wroteFiles].reverse()) {
      await unlink(path).catch(() => undefined);
    }
    throw error;
  }
  return wroteFiles;
}

/**
 * Migrates a legacy project that has no `.hack/hack.env.json` contract, so
 * its values live only in `.hack/.env` and `.hack/.env.<overlay>`.
 *
 * Contract:
 * - Those files are gitignored, so their values stay out of tracked files:
 *   every base entry becomes a plaintext global value in the machine-local
 *   layer `hack.env.local.yaml`, and every overlay entry that differs from the
 *   base becomes a global value in `hack.env.<overlay>.local.yaml`. The tracked
 *   `hack.env.default.yaml` (and `hack.env.<overlay>.yaml` for each migrated
 *   overlay) is written with no values, so the project switches to env layers.
 *   With no legacy file at all only the empty default layer is written.
 * - Refused before anything is written ({@link LegacyDotenvMigrationRefusalError},
 *   or {@link ProjectEnvLayerPathConflictError} for an unusable layer entry):
 *   any existing env layer entry, a legacy file that is a symlink out of
 *   `.hack`, a legacy overlay named like the default or a
 *   machine-local layer, a Compose `env_file` on a file the migration leaves
 *   out or on an overlay a launch without `--env` would not select, a Compose
 *   `environment` or `env_file` entry the migrated value would override, a
 *   service that would gain values a legacy file gave only to others, an
 *   `env_file` order that gives a key a different value from the layers, a Compose
 *   input that hides `env_file` from this check, a line Compose reads differently
 *   from Hack, a key that does not match `^[A-Z_][A-Z0-9_]*$`
 *   (counted per file, never shown), and a machine-local target that git
 *   tracks or, inside a git checkout, cannot report on.
 * - Layers are created only where nothing exists (compare-and-swap against an
 *   absent file); if a later write fails, the layers this call created are
 *   removed again, so the project keeps using the legacy files.
 * - Without a contract nothing names secret-backend values, so none are read
 *   or migrated, and `hack.config.json` (including any secret backend it
 *   configures, and that backend's store) is left unchanged and never offered
 *   for cleanup. Values are written to the layer files only, never returned or
 *   printed.
 */
async function migrateUndeclaredLegacyDotenv(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly serviceNames: readonly string[];
  readonly materialize: boolean;
}): Promise<LegacyProjectEnvMigration> {
  // Also refuses a dangling or non-file layer entry (E_PATH_CONFLICT), which
  // an atomic write would otherwise replace or write through.
  if (
    (await projectEnvConfigExistsForMutation({
      projectDir: opts.projectDir,
    })) &&
    !(await canMigrateCheckoutLegacyDotenv(opts))
  ) {
    throw new LegacyDotenvMigrationRefusalError({
      code: "E_PATH_CONFLICT",
      reason: `env layer files already exist in ${opts.projectDir}.`,
    });
  }
  const overlayNames = await selectLegacyDotenvOverlays({
    projectDir: opts.projectDir,
  });
  await assertComposeUsesNoExcludedLegacyDotenv({
    projectDir: opts.projectDir,
  });
  await assertLegacyDotenvLinksStayInProject({
    projectDir: opts.projectDir,
    overlayNames,
  });

  const legacyValues = await readValidatedLegacyDotenvFiles({
    projectDir: opts.projectDir,
    overlayNames,
  });
  await assertComposeOverlaysStaySelected({
    projectDir: opts.projectDir,
    overlayNames,
    legacyValues,
  });
  await assertComposeEnvironmentKeepsPrecedence({
    projectDir: opts.projectDir,
    legacyValues,
  });

  const baseValues = legacyValues.get(null) ?? {};
  const baseToMigrate = legacyValuesNotDelivered({
    values: baseValues,
    delivered: await deliveredLayerValues({ ...opts, envName: null }),
  });
  const localWrites: PlannedEnvLayerWrite[] = [];
  const trackedWrites: PlannedEnvLayerWrite[] = [
    {
      path: resolveProjectEnvConfigPath({
        projectDir: opts.projectDir,
        envName: null,
      }),
      config: buildMigratedProjectEnvConfig({
        environment: "default",
        values: { global: {} },
      }),
    },
  ];
  if (Object.keys(baseToMigrate).length > 0) {
    localWrites.push({
      path: resolveProjectEnvLocalConfigPath({
        projectDir: opts.projectDir,
        envName: null,
      }),
      config: buildMigratedProjectEnvConfig({
        environment: "default",
        values: { global: { ...baseToMigrate } },
      }),
    });
  }
  for (const overlayName of overlayNames) {
    const changedValues = legacyValuesNotDelivered({
      values: legacyOverlayChangedValues({
        overlayValues: legacyValues.get(overlayName) ?? {},
        baseValues,
      }),
      delivered: await deliveredLayerValues({ ...opts, envName: overlayName }),
    });
    if (Object.keys(changedValues).length === 0) {
      continue;
    }
    localWrites.push({
      path: resolveProjectEnvLocalConfigPath({
        projectDir: opts.projectDir,
        envName: overlayName,
      }),
      config: buildMigratedProjectEnvConfig({
        environment: overlayName,
        values: { global: changedValues },
      }),
    });
    trackedWrites.push({
      path: resolveProjectEnvConfigPath({
        projectDir: opts.projectDir,
        envName: overlayName,
      }),
      config: buildMigratedProjectEnvConfig({
        environment: overlayName,
        values: { global: {} },
      }),
    });
  }

  // Before anything is written, so these refusals leave the checkout unchanged.
  await assertLocalOverlaysAgreeWithLegacy({
    projectDir: opts.projectDir,
    overlayNames,
    legacyValues,
  });
  const merges = await planLocalLayerMerges({ localWrites });
  for (const write of localWrites) {
    await assertUntrackedMigrationLocalLayer({
      projectRoot: opts.projectRoot,
      path: write.path,
    });
  }
  if (localWrites.length > 0) {
    await ensureHackDirGitignoreForLocalEnvWrite({
      projectDir: opts.projectDir,
    });
  }
  // The managed block may not have been written (a read-only .gitignore), so
  // check the outcome, not the attempt.
  for (const write of localWrites) {
    await assertIgnoredMigrationLocalLayer({
      projectRoot: opts.projectRoot,
      path: write.path,
    });
  }

  const wroteFiles = await publishMigratedLegacyLayers({
    projectDir: opts.projectDir,
    localWrites,
    trackedWrites,
    mergedPaths: new Set(merges.map((merge) => merge.path)),
  });
  // Last, after everything that can roll back: each only adds keys, so a failure
  // here leaves the rest for the next run.
  for (const merge of merges) {
    await replaceLocalLayerPrivately({
      projectDir: opts.projectDir,
      path: merge.path,
      config: merge.config,
      expectedExisting: merge.expectedExisting,
    });
    wroteFiles.push(merge.path);
  }

  if (opts.materialize) {
    await materializeProjectEnv({
      projectRoot: opts.projectRoot,
      projectDir: opts.projectDir,
      envName: undefined,
      serviceNames: opts.serviceNames,
    });
  }

  const keysNewToEveryService = await legacyKeysNewToEveryService({
    projectDir: opts.projectDir,
    legacyValues,
  });
  const composeEnvFileReferences = await inspectLegacyComposeEnvFileReferences({
    composeFile: resolve(opts.projectDir, PROJECT_COMPOSE_FILENAME),
    projectDir: opts.projectDir,
  });
  const cleanupCandidates = await collectLegacyProjectEnvCleanupCandidates({
    projectRoot: opts.projectRoot,
    projectDir: opts.projectDir,
    overlayNames,
    materialize: opts.materialize,
    configCleanupCandidates: [],
    composeEnvFileReferences,
  });
  // A legacy file git tracks may carry values teammates rely on; the values
  // now live only in this machine's local layers, so it is never offered
  // for deletion. Neither is one whose status git cannot report.
  const allowedCleanup = await filterUntrackedLegacyCleanupCandidates({
    projectRoot: opts.projectRoot,
    paths: cleanupCandidates.allowed,
  });
  const blockedCleanup = await filterUntrackedLegacyCleanupCandidates({
    projectRoot: opts.projectRoot,
    paths: cleanupCandidates.blocked,
  });

  return {
    wroteFiles,
    migratedOverlays: overlayNames,
    legacyDetected: true,
    updatedProjectConfig: false,
    cleanupCandidates: allowedCleanup,
    blockedCleanupCandidates: blockedCleanup,
    composeEnvFileReferences,
    keysNewToEveryService,
  };
}

/**
 * Entries of a legacy dotenv file; an absent file has none. One that exists
 * but cannot be read (for example mode 000, or a dangling symlink) refuses:
 * reading it as empty would drop its values and then offer it for deletion.
 */
async function readLegacyDotenvFile(opts: {
  readonly path: string;
}): Promise<Record<string, string>> {
  const read = await readOptionalTextFile(opts.path);
  if (read.kind === "unreadable") {
    throw new LegacyDotenvMigrationRefusalError({
      code: "E_PERMISSION",
      reason: `${opts.path} exists but cannot be read. Make it a readable regular file, then retry.`,
    });
  }
  return read.kind === "absent" ? {} : parseDotEnv(read.text);
}

export async function removeLegacyProjectEnvArtifacts(opts: {
  readonly projectRoot: string;
  readonly paths: readonly string[];
}): Promise<readonly string[]> {
  await assertLegacyProjectInputFamily({ projectRoot: opts.projectRoot });
  const removed: string[] = [];
  for (const path of opts.paths) {
    if (!(await pathExists(path))) {
      continue;
    }
    await assertLegacyProjectInputFamily({ projectRoot: opts.projectRoot });
    await rm(path, { recursive: false, force: true });
    removed.push(path);
  }
  return removed;
}

async function discoverLegacyOverlayNames(opts: {
  readonly projectDir: string;
  readonly includeSymlinks: boolean;
}): Promise<readonly string[]> {
  const names = new Set<string>();
  const entries = await readdir(opts.projectDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!(entry.isFile() || (opts.includeSymlinks && entry.isSymbolicLink()))) {
      continue;
    }
    if (!entry.name.startsWith(`${PROJECT_ENV_FILENAME}.`)) {
      continue;
    }
    const envName = entry.name.slice(`${PROJECT_ENV_FILENAME}.`.length).trim();
    if (envName.length > 0) {
      names.add(envName);
    }
  }

  const defaultOverlay = await readProjectDefaultEnvConfig({
    projectDir: opts.projectDir,
  });
  if (defaultOverlay) {
    names.add(defaultOverlay);
  }

  return [...names].sort((left, right) => left.localeCompare(right));
}

function buildMigratedProjectEnvConfig(opts: {
  readonly environment: string;
  readonly values: ProjectEnvValuesByScope;
}): ProjectEnvConfig {
  return {
    version: PROJECT_ENV_CONFIG_VERSION,
    environment: opts.environment,
    secretsprovider: PROJECT_ENV_SECRETS_PROVIDER,
    values:
      "global" in opts.values ? opts.values : { global: {}, ...opts.values },
  };
}

function buildMigratedValues(opts: {
  readonly resolvedValues: readonly {
    readonly key: string;
    readonly value: string | null;
    readonly source: "plain_env" | "keychain";
    readonly services: readonly string[] | null;
  }[];
  readonly baseValues: ReadonlyMap<string, string | null> | null;
  readonly keyText: string | null;
}): ProjectEnvValuesByScope {
  const values: ProjectEnvValuesByScope = {
    global: {},
  };

  for (const valueState of opts.resolvedValues) {
    if (valueState.value === null) {
      continue;
    }
    if (
      opts.baseValues &&
      opts.baseValues.get(valueState.key) === valueState.value
    ) {
      continue;
    }
    const scopes =
      valueState.services && valueState.services.length > 0
        ? valueState.services
        : ["global"];
    for (const scope of scopes) {
      const normalizedScope = scope.trim().length > 0 ? scope : "global";
      const scopeValues = values[normalizedScope] ?? {};
      scopeValues[valueState.key] =
        valueState.source === "keychain"
          ? {
              secure: encryptProjectEnvValue({
                plaintext: valueState.value,
                keyText:
                  opts.keyText ??
                  (() => {
                    throw new Error(
                      "Missing project env key for secret migration."
                    );
                  })(),
              }),
            }
          : valueState.value;
      values[normalizedScope] = scopeValues;
    }
  }

  return values;
}

async function collectLegacyProjectEnvCleanupCandidates(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly overlayNames: readonly string[];
  readonly materialize: boolean;
  readonly configCleanupCandidates: readonly string[];
  readonly composeEnvFileReferences: readonly LegacyComposeEnvFileReference[];
}): Promise<{
  readonly allowed: readonly string[];
  readonly blocked: readonly string[];
}> {
  const candidates = new Set<string>();
  candidates.add(resolve(opts.projectDir, PROJECT_ENV_CONTRACT_FILENAME));
  if (!opts.materialize) {
    candidates.add(resolve(opts.projectDir, PROJECT_ENV_FILENAME));
  }
  for (const overlayName of opts.overlayNames) {
    candidates.add(
      resolve(opts.projectDir, `${PROJECT_ENV_FILENAME}.${overlayName}`)
    );
  }
  for (const path of opts.configCleanupCandidates) {
    candidates.add(path);
  }

  const blockedPaths = new Set(
    opts.composeEnvFileReferences.map((reference) => reference.resolvedPath)
  );
  const allowed: string[] = [];
  const blocked: string[] = [];
  for (const path of candidates) {
    if (await pathExists(path)) {
      if (blockedPaths.has(path)) {
        blocked.push(path);
      } else {
        allowed.push(path);
      }
    }
  }
  return {
    allowed: allowed.sort((left, right) => left.localeCompare(right)),
    blocked: blocked.sort((left, right) => left.localeCompare(right)),
  };
}

async function migrateLegacyProjectConfig(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
}): Promise<{
  readonly changed: boolean;
  readonly cleanupCandidates: readonly string[];
}> {
  await assertLegacyProjectDirectory({ projectDir: opts.projectDir });
  await assertLegacyProjectInputFamily({ projectRoot: opts.projectRoot });
  const configPath = resolve(opts.projectDir, PROJECT_CONFIG_FILENAME);
  const text = await readTextFile(configPath);
  if (text === null) {
    return { changed: false, cleanupCandidates: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { changed: false, cleanupCandidates: [] };
  }
  if (!isRecord(parsed)) {
    return { changed: false, cleanupCandidates: [] };
  }

  const topLevel = normalizeLegacyProjectTopLevelConfig({
    parsed,
    projectRoot: opts.projectRoot,
  });

  if (!topLevel.changed) {
    return {
      changed: false,
      cleanupCandidates: topLevel.cleanupCandidates,
    };
  }

  const nextText = `${JSON.stringify(topLevel.config, null, 2)}\n`;
  await assertLegacyProjectDirectory({ projectDir: opts.projectDir });
  const result = await writeTextFileIfChanged(configPath, nextText);
  return {
    changed: result.changed,
    cleanupCandidates: topLevel.cleanupCandidates,
  };
}

function normalizeLegacyProjectTopLevelConfig(opts: {
  readonly parsed: Record<string, unknown>;
  readonly projectRoot: string;
}): {
  readonly config: Record<string, unknown>;
  readonly changed: boolean;
  readonly cleanupCandidates: readonly string[];
} {
  const {
    defaultEnvConfig,
    env: envRaw,
    controlPlane: controlPlaneRaw,
    ...rest
  } = opts.parsed;

  let changed = false;
  const config: Record<string, unknown> = { ...rest };

  if (envRaw !== undefined) {
    config.env = envRaw;
  }

  const defaultOverlay =
    typeof defaultEnvConfig === "string" ? defaultEnvConfig : null;
  if (defaultOverlay) {
    config.env = normalizeLegacyProjectEnvOverlay({
      envRaw,
      defaultOverlay,
    });
    changed = true;
  } else if (defaultEnvConfig !== undefined) {
    changed = true;
  }

  const controlPlane = normalizeLegacyProjectControlPlaneConfig({
    controlPlaneRaw,
    projectRoot: opts.projectRoot,
  });
  if (controlPlane.value !== undefined) {
    config.controlPlane = controlPlane.value;
  }
  if (controlPlane.changed) {
    changed = true;
  }

  return {
    config,
    changed,
    cleanupCandidates: controlPlane.cleanupCandidates,
  };
}

function normalizeLegacyProjectEnvOverlay(opts: {
  readonly envRaw: unknown;
  readonly defaultOverlay: string;
}): Record<string, unknown> {
  const env = isRecord(opts.envRaw) ? { ...opts.envRaw } : {};
  if (getString(env, "defaultOverlay") !== opts.defaultOverlay) {
    env.defaultOverlay = opts.defaultOverlay;
  }
  return env;
}

function normalizeLegacyProjectControlPlaneConfig(opts: {
  readonly controlPlaneRaw: unknown;
  readonly projectRoot: string;
}): {
  readonly value: Record<string, unknown> | undefined;
  readonly changed: boolean;
  readonly cleanupCandidates: readonly string[];
} {
  if (!isRecord(opts.controlPlaneRaw)) {
    return {
      value: undefined,
      changed: false,
      cleanupCandidates: [],
    };
  }

  const { secrets: secretsRaw, ...rest } = opts.controlPlaneRaw;
  const secrets = normalizeLegacyProjectSecretsConfig({
    secretsRaw,
    projectRoot: opts.projectRoot,
  });

  const value: Record<string, unknown> = { ...rest };
  if (secrets.value !== undefined) {
    value.secrets = secrets.value;
  }

  return {
    value: Object.keys(value).length > 0 ? value : undefined,
    changed: secrets.changed,
    cleanupCandidates: secrets.cleanupCandidates,
  };
}

function normalizeLegacyProjectSecretsConfig(opts: {
  readonly secretsRaw: unknown;
  readonly projectRoot: string;
}): {
  readonly value: Record<string, unknown> | undefined;
  readonly changed: boolean;
  readonly cleanupCandidates: readonly string[];
} {
  if (!isRecord(opts.secretsRaw)) {
    return {
      value: undefined,
      changed: false,
      cleanupCandidates: [],
    };
  }

  const cleanupCandidates = collectLegacyEncryptedBackendCleanupCandidates({
    secretsRaw: opts.secretsRaw,
    projectRoot: opts.projectRoot,
  });

  const backend = getString(opts.secretsRaw, "backend");
  const allowEnvAuthRefs = opts.secretsRaw.allowEnvAuthRefs;
  const cloud = normalizeLegacyProjectSecretsCloudConfig({
    cloudRaw: opts.secretsRaw.cloud,
  });

  const value: Record<string, unknown> = {};
  if (allowEnvAuthRefs === false) {
    value.allowEnvAuthRefs = false;
  }
  if (backend === "cloud") {
    value.backend = backend;
  }
  if (cloud !== undefined) {
    value.cloud = cloud;
  }

  const changed =
    "storePlaintextInBackend" in opts.secretsRaw ||
    "encryptedFile" in opts.secretsRaw ||
    backend === "encrypted_file" ||
    allowEnvAuthRefs === true ||
    (isRecord(opts.secretsRaw.cloud) && cloud === undefined);

  return {
    value: Object.keys(value).length > 0 ? value : undefined,
    changed,
    cleanupCandidates,
  };
}

function normalizeLegacyProjectSecretsCloudConfig(opts: {
  readonly cloudRaw: unknown;
}): Record<string, unknown> | undefined {
  if (!isRecord(opts.cloudRaw)) {
    return undefined;
  }

  const cloudProvider = getString(opts.cloudRaw, "provider");
  const cloudProject = getString(opts.cloudRaw, "project");
  const cloudSecretPrefix = getString(opts.cloudRaw, "secretPrefix");
  if (!(cloudProvider || cloudProject) && cloudSecretPrefix === "hack") {
    return undefined;
  }

  return { ...opts.cloudRaw };
}

function collectLegacyEncryptedBackendCleanupCandidates(opts: {
  readonly secretsRaw: Record<string, unknown>;
  readonly projectRoot: string;
}): readonly string[] {
  const candidates = new Set<string>();
  const encryptedFileRaw = opts.secretsRaw.encryptedFile;
  if (!isRecord(encryptedFileRaw)) {
    return [];
  }

  const pathValue = getString(encryptedFileRaw, "path");
  const keyPathValue = getString(encryptedFileRaw, "keyPath");
  if (pathValue) {
    addProjectLocalCleanupCandidate({
      projectRoot: opts.projectRoot,
      path: resolveConfiguredProjectPath({
        projectRoot: opts.projectRoot,
        configuredPath: pathValue,
      }),
      target: candidates,
    });
  }
  if (keyPathValue) {
    addProjectLocalCleanupCandidate({
      projectRoot: opts.projectRoot,
      path: resolveConfiguredProjectPath({
        projectRoot: opts.projectRoot,
        configuredPath: keyPathValue,
      }),
      target: candidates,
    });
  }

  return [...candidates].sort((left, right) => left.localeCompare(right));
}

function resolveConfiguredProjectPath(opts: {
  readonly projectRoot: string;
  readonly configuredPath: string;
}): string {
  const raw = opts.configuredPath.trim();
  const home = (process.env.HOME ?? "").trim();
  if (raw === "~") {
    return home;
  }
  if (raw.startsWith("~/")) {
    return resolve(home, raw.slice(2));
  }
  if (raw.startsWith("/")) {
    return raw;
  }
  return resolve(opts.projectRoot, raw);
}

function addProjectLocalCleanupCandidate(opts: {
  readonly projectRoot: string;
  readonly path: string;
  readonly target: Set<string>;
}): void {
  const projectRoot = resolve(opts.projectRoot);
  const candidate = resolve(opts.path);
  if (candidate === projectRoot || candidate.startsWith(`${projectRoot}/`)) {
    opts.target.add(candidate);
  }
}

/**
 * Splits a `KEY` or `scope.KEY` argument for `hack env set`, `unset` and
 * `explain`. Every refusal is a fixed, value-free `ClosedCliError`, so the CLI
 * prints it as one line under every logger and never echoes the argument.
 */
export function parseProjectEnvTarget(input: {
  readonly keyOrPath: string;
  readonly scopeOverride?: string | undefined;
}): {
  readonly scope: string;
  readonly key: string;
} {
  const trimmed = input.keyOrPath.trim();
  if (trimmed.length === 0) {
    throw new ClosedCliError("Env key is required.");
  }
  // Refuse `KEY=value` before any dotted-scope split, so no fragment of the
  // value can reach a scope or key error. Every refusal below is fixed text.
  if (trimmed.includes("=")) {
    throw new ClosedCliError(ENV_KEY_ASSIGNMENT_MESSAGE);
  }

  const dotIndex = trimmed.lastIndexOf(".");
  if (dotIndex > 0) {
    if (input.scopeOverride) {
      throw new ClosedCliError(
        "Do not combine dotted scope syntax with --service."
      );
    }
    const scope = trimmed.slice(0, dotIndex).trim();
    const key = trimmed.slice(dotIndex + 1).trim();
    assertValidProjectEnvScopeName({ scopeName: scope });
    if (!PROJECT_ENV_KEY_PATTERN.test(key)) {
      throw new ClosedCliError(ENV_KEY_INVALID_MESSAGE);
    }
    return { scope, key };
  }

  if (!PROJECT_ENV_KEY_PATTERN.test(trimmed)) {
    throw new ClosedCliError(ENV_KEY_INVALID_MESSAGE);
  }
  return {
    scope: assertValidProjectEnvScopeName({
      scopeName: input.scopeOverride,
    }),
    key: trimmed,
  };
}

export async function readMaterializedProjectEnv(opts: {
  readonly projectDir: string;
}): Promise<Record<string, string>> {
  const envPath = resolve(opts.projectDir, PROJECT_ENV_FILENAME);
  const text = await readTextFile(envPath);
  return text ? parseDotEnv(text) : {};
}
