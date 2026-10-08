import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  open,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
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
import { parseDotEnv, serializeDotEnv } from "./env.ts";
import {
  ensureDir,
  ensureGitignoreEntry,
  ensureManagedGitignoreBlock,
  pathExists,
  readTextFile,
  writeTextFile,
  writeTextFileIfChanged,
} from "./fs.ts";
import {
  resolveGitPrimaryWorktreeRoot,
  resolveGitRepositoryIdentity,
  resolveGitWorktreeDir,
} from "./git-worktree.ts";
import { getRecord, getString, isRecord } from "./guards.ts";
import { readHackEnvContract, resolveHackEnv } from "./hack-env.ts";
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
import { readProjectDefaultEnvConfig } from "./project.ts";
import {
  assertLegacyProjectDirectory,
  assertLegacyProjectInputFamily,
  ProjectInputSelectionError,
} from "./project-input-selection.ts";
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
const PROJECT_ENV_SECRET_PREFIX = "v1" as const;
const PROJECT_ENV_ALGORITHM = "aes-256-gcm";
const PROJECT_ENV_IV_BYTES = 12;
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

  const scoped = opts.resolved.serviceEnv[scopeName];
  if (!scoped) {
    throw new Error(`Unknown env scope: ${scopeName}`);
  }

  return { ...scoped };
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
  return { ...(opts.resolved.hostTargetEnv[scopeName] ?? selected) };
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

export function assertValidProjectEnvScopeName(opts: {
  readonly scopeName?: string | null;
}): string {
  const scopeName = normalizeProjectEnvScopeName({
    scopeName: opts.scopeName,
  });
  if (!isValidProjectEnvScopeName({ scopeName })) {
    throw new Error(`Invalid env scope: ${scopeName}`);
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
 * markers are preserved; see `ensureManagedGitignoreBlock` for the merge
 * scheme. Self-healing: called from `hack init`, `hack up`, the internal
 * override writers, and env-local override writes.
 */
export async function ensureHackDirGitignore(opts: {
  readonly projectDir: string;
}): Promise<{ readonly changed: boolean }> {
  await assertLegacyProjectDirectory({ projectDir: opts.projectDir });
  await ensureDir(opts.projectDir);
  await assertLegacyProjectDirectory({ projectDir: opts.projectDir });
  return await ensureManagedGitignoreBlock({
    gitignorePath: resolve(opts.projectDir, ".gitignore"),
    beginMarker: HACK_DIR_GITIGNORE_BEGIN_MARKER,
    endMarker: HACK_DIR_GITIGNORE_END_MARKER,
    entries: HACK_DIR_GITIGNORE_ENTRIES,
  });
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
async function readProjectEnvLayerText(opts: {
  readonly path: string;
  readonly strictRead?: boolean;
}): Promise<string | null> {
  if (!opts.strictRead) {
    return await readTextFile(opts.path);
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
        error: `Invalid env scope: ${scope}`,
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
          error: `Invalid env key "${key}" in scope "${scope}".`,
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
      throw new Error(`Failed to parse ${read.path}: ${read.parseError}`);
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
    throw new Error("Unknown env scope");
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

function nativeEnvMetadataError(): Error {
  return new Error(
    "Cannot resolve native managed env metadata: selected inputs are invalid, unreadable, unstable or oversized; values omitted."
  );
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
    throw nativeEnvMetadataError();
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

export async function setProjectEnvValue(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly envName: string | null;
  readonly scope: string;
  readonly key: string;
  readonly value: string;
  readonly secret: boolean;
  readonly local?: boolean;
}): Promise<ProjectEnvMutationResult> {
  await assertLegacyProjectDirectory({ projectDir: opts.projectDir });
  await assertLegacyProjectInputFamily({ projectRoot: opts.projectRoot });
  if (!PROJECT_ENV_KEY_PATTERN.test(opts.key)) {
    throw new Error(`Invalid env key: ${opts.key}`);
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
  const read = await readProjectEnvConfigFile({
    path: filePath,
    environment: opts.envName ?? "default",
  });
  if (read.parseError) {
    throw new Error(`Failed to parse ${filePath}: ${read.parseError}`);
  }

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
    storedValue = {
      secure: encryptProjectEnvValue({
        plaintext: opts.value,
        keyText: ensuredKey.keyText,
      }),
    };
  }
  if (opts.local === true) {
    await ensureHackDirGitignore({
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
  const changed = await writeProjectEnvConfigFile({
    path: filePath,
    config: nextConfig,
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
  const read = await readProjectEnvConfigFile({
    path: filePath,
    environment: opts.envName ?? "default",
  });
  if (read.parseError) {
    throw new Error(`Failed to parse ${filePath}: ${read.parseError}`);
  }

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
  });
  return { changed, filePath };
}

async function writeProjectEnvConfigFile(opts: {
  readonly path: string;
  readonly config: ProjectEnvConfig;
}): Promise<boolean> {
  const yaml = YAML.stringify(opts.config, null, 2);
  const text = yaml.endsWith("\n") ? yaml : `${yaml}\n`;
  await assertLegacyProjectDirectory({ projectDir: dirname(opts.path) });
  return (await writeTextFileIfChanged(opts.path, text)).changed;
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
  await assertLegacyProjectDirectory({ projectDir: opts.projectDir });
  const changed = (await writeTextFileIfChanged(envPath, text)).changed;
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
  const keyPath = resolveProjectEnvKeyPath({ projectRoot: opts.projectRoot });
  const sharedKeyPath = await resolveProjectEnvSharedKeyPath({
    projectRoot: opts.projectRoot,
  });
  const text = await readTextFile(keyPath);
  const sharedText =
    sharedKeyPath === null ? null : await readTextFile(sharedKeyPath);
  const envFallback = process.env[PROJECT_ENV_SECRET_KEY_ENV]?.trim() ?? "";
  const inheritedKey = await resolveInheritedProjectEnvKey({
    projectRoot: opts.projectRoot,
  });
  const trimmed = text?.trim() ?? "";
  if (trimmed.length > 0) {
    return trimmed;
  }
  const sharedTrimmed = sharedText?.trim() ?? "";
  if (sharedTrimmed.length > 0) {
    return sharedTrimmed;
  }
  if (inheritedKey) {
    return inheritedKey.keyText;
  }
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

function sameNativeKeyFile(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

/** Keys stay inside their existing owner; reject redirected, oversized or changing descriptor reads. */
async function readNativeProjectEnvKeyFile(opts: {
  readonly path: string;
  readonly directories: readonly string[];
  readonly signal?: AbortSignal;
}): Promise<string | null> {
  checkNativeEnvCancellation(opts.signal);
  const directories = await Promise.all(
    opts.directories.map(async (path) => {
      const stats = await lstat(path);
      if (!stats.isDirectory() || (await realpath(path)) !== path) {
        throw nativeEnvValuesError();
      }
      return { path, stats };
    })
  );
  const recheckDirectories = async () => {
    for (const { path, stats } of directories) {
      const current = await lstat(path);
      if (
        !current.isDirectory() ||
        current.dev !== stats.dev ||
        current.ino !== stats.ino ||
        (await realpath(path)) !== path
      ) {
        throw nativeEnvValuesError();
      }
    }
    checkNativeEnvCancellation(opts.signal);
  };
  const observed = await lstat(opts.path).catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (!observed) {
    await recheckDirectories();
    return null;
  }
  if (
    !observed.isFile() ||
    observed.size > NATIVE_CONFIG_INPUT_LIMIT ||
    (observed.mode & 0o444) === 0 ||
    (await realpath(opts.path)) !== opts.path
  ) {
    throw nativeEnvValuesError();
  }
  const file = await open(
    opts.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    checkNativeEnvCancellation(opts.signal);
    const before = await file.stat();
    if (!(before.isFile() && sameNativeKeyFile(observed, before))) {
      throw nativeEnvValuesError();
    }
    const buffer = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < buffer.length) {
      checkNativeEnvCancellation(opts.signal);
      const { bytesRead } = await file.read(
        buffer,
        size,
        buffer.length - size,
        size
      );
      if (bytesRead === 0) {
        break;
      }
      size += bytesRead;
    }
    const after = await file.stat();
    const current = await lstat(opts.path);
    if (
      size !== before.size ||
      !current.isFile() ||
      !sameNativeKeyFile(before, after) ||
      !sameNativeKeyFile(before, current) ||
      (await realpath(opts.path)) !== opts.path
    ) {
      throw nativeEnvValuesError();
    }
    await recheckDirectories();
    return (
      new TextDecoder("utf-8", { fatal: true })
        .decode(buffer.subarray(0, size))
        .trim() || null
    );
  } finally {
    await file.close();
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
 */
export async function ensureProjectEnvSecretKey(opts: {
  readonly projectRoot: string;
}): Promise<EnsureProjectEnvSecretKeyResult> {
  await assertLegacyProjectInputFamily({ projectRoot: opts.projectRoot });
  const keyPath = resolveProjectEnvKeyPath({ projectRoot: opts.projectRoot });
  const sharedLocation = await resolveProjectEnvSharedKeyLocation({
    projectRoot: opts.projectRoot,
  });
  const sharedKeyPath = await resolveSharedKeyPathFromLocation(sharedLocation);
  const existing = await readTextFile(keyPath);
  if (existing !== null && existing.trim().length > 0) {
    return {
      keyPath,
      keyText: existing.trim(),
      created: false,
      warnings: [],
    };
  }
  const sharedExisting =
    sharedKeyPath === null ? null : await readTextFile(sharedKeyPath);
  if (
    sharedKeyPath !== null &&
    sharedExisting !== null &&
    sharedExisting.trim().length > 0
  ) {
    return {
      keyPath: sharedKeyPath,
      keyText: sharedExisting.trim(),
      created: false,
      warnings: [],
    };
  }

  const inheritedKey = await resolveInheritedProjectEnvKey({
    projectRoot: opts.projectRoot,
  });
  if (inheritedKey) {
    const written = await writeProjectEnvKeyWithFallback({
      projectRoot: opts.projectRoot,
      preferredKeyPath: sharedKeyPath,
      localKeyPath: keyPath,
      keyText: inheritedKey.keyText,
      sharedLocation,
    });
    return {
      keyPath: written.keyPath,
      keyText: inheritedKey.keyText,
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
    keyText,
    created: true,
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
}): Promise<{ readonly keyPath: string; readonly warnings: string[] }> {
  const warnings: string[] = [];

  if (opts.preferredKeyPath !== null) {
    try {
      await writeProjectEnvKeyFile({
        projectRoot: opts.projectRoot,
        path: opts.preferredKeyPath,
        keyText: opts.keyText,
      });
      return { keyPath: opts.preferredKeyPath, warnings };
    } catch (error: unknown) {
      if (error instanceof ProjectInputSelectionError) {
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

  await writeProjectEnvKeyFile({
    projectRoot: opts.projectRoot,
    path: opts.localKeyPath,
    keyText: opts.keyText,
  });
  await assertLegacyProjectInputFamily({ projectRoot: opts.projectRoot });
  await ensureGitignoreEntry({
    gitignorePath: resolve(opts.projectRoot, ".gitignore"),
    entry: PROJECT_ENV_KEY_FILENAME,
    comment: "# project env key",
  });
  emitProjectEnvKeyWarnings({ warnings });
  return { keyPath: opts.localKeyPath, warnings };
}

async function writeProjectEnvKeyFile(opts: {
  readonly projectRoot: string;
  readonly path: string;
  readonly keyText: string;
}): Promise<void> {
  await assertLegacyProjectInputFamily({ projectRoot: opts.projectRoot });
  await ensureDir(dirname(opts.path));
  await assertLegacyProjectInputFamily({ projectRoot: opts.projectRoot });
  await writeTextFile(opts.path, `${opts.keyText}\n`);
  await chmod(opts.path, 0o600);
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
  const keyText = (await readTextFile(keyPath))?.trim() ?? "";
  if (keyText.length === 0) {
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
  const cipher = createCipheriv(PROJECT_ENV_ALGORITHM, key, iv);
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

function decryptProjectEnvValue(opts: {
  readonly ciphertext: string;
  readonly keyText: string;
}): string {
  const parts = opts.ciphertext.split(":");
  const [prefix, ivText, tagText, ciphertextText] = parts;
  // AES-GCM authenticates an empty plaintext with an empty ciphertext segment.
  if (
    parts.length !== 4 ||
    prefix !== PROJECT_ENV_SECRET_PREFIX ||
    !ivText ||
    !tagText ||
    ciphertextText === undefined
  ) {
    throw new Error("Invalid secure env value.");
  }
  const key = deriveProjectEnvKey({ keyText: opts.keyText });
  const decipher = createDecipheriv(
    PROJECT_ENV_ALGORITHM,
    key,
    Buffer.from(ivText, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
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

/**
 * Migrates a legacy v2 `.env`-based project env layout to the v3
 * `hack.env.*.yaml` config system.
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
}): Promise<{
  readonly wroteFiles: readonly string[];
  readonly migratedOverlays: readonly string[];
  readonly legacyDetected: boolean;
  readonly updatedProjectConfig: boolean;
  readonly cleanupCandidates: readonly string[];
  readonly blockedCleanupCandidates: readonly string[];
  readonly composeEnvFileReferences: readonly LegacyComposeEnvFileReference[];
}> {
  await assertLegacyProjectDirectory({ projectDir: opts.projectDir });
  await assertLegacyProjectInputFamily({ projectRoot: opts.projectRoot });
  const contract = await readHackEnvContract({ projectDir: opts.projectDir });
  if (!contract.exists) {
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

  const baseResolved = await resolveHackEnv({
    projectDir: opts.projectDir,
    projectName: opts.projectName,
    envName: null,
  });

  const overlayNames = await discoverLegacyOverlayNames({
    projectDir: opts.projectDir,
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
}): Promise<readonly string[]> {
  const names = new Set<string>();
  const entries = await readdir(opts.projectDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
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

export function parseProjectEnvTarget(input: {
  readonly keyOrPath: string;
  readonly scopeOverride?: string | undefined;
}): {
  readonly scope: string;
  readonly key: string;
} {
  const trimmed = input.keyOrPath.trim();
  if (trimmed.length === 0) {
    throw new Error("Env key is required.");
  }

  const dotIndex = trimmed.lastIndexOf(".");
  if (dotIndex > 0) {
    if (input.scopeOverride) {
      throw new Error("Do not combine dotted scope syntax with --service.");
    }
    const scope = trimmed.slice(0, dotIndex).trim();
    const key = trimmed.slice(dotIndex + 1).trim();
    assertValidProjectEnvScopeName({ scopeName: scope });
    if (!PROJECT_ENV_KEY_PATTERN.test(key)) {
      throw new Error(`Invalid env key: ${key}`);
    }
    return { scope, key };
  }

  if (!PROJECT_ENV_KEY_PATTERN.test(trimmed)) {
    throw new Error(`Invalid env key: ${trimmed}`);
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
