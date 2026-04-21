import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { chmod, readdir, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { YAML } from "bun";
import {
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
import { parseDotEnv, serializeDotEnv } from "./env.ts";
import {
  ensureDir,
  ensureGitignoreEntry,
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
import { readProjectDefaultEnvConfig } from "./project.ts";

const PROJECT_ENV_CONFIG_VERSION = 1 as const;
const PROJECT_ENV_SECRETS_PROVIDER = "project_key" as const;
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

export type ProjectEnvStoredValue = ProjectEnvScalar | ProjectEnvSecretValue;

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

export type ProjectEnvResolvedConfig = {
  readonly selection: ProjectEnvSelection;
  readonly merged: ProjectEnvConfig;
  readonly files: readonly string[];
  readonly globalEnv: Readonly<Record<string, string>>;
  readonly hostEnv: Readonly<Record<string, string>>;
  readonly serviceEnv: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  readonly declaredScopes: readonly string[];
  readonly unknownScopes: readonly string[];
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

  const hostOverrides = opts.resolved.hostEnv;
  if (!hostOverrides) {
    return selected;
  }
  return {
    ...selected,
    ...hostOverrides,
  };
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

export function resolveProjectEnvKeyPath(opts: {
  readonly projectRoot: string;
}): string {
  return resolve(opts.projectRoot, PROJECT_ENV_KEY_FILENAME);
}

export async function resolveProjectEnvSharedKeyPath(opts: {
  readonly projectRoot: string;
}): Promise<string | null> {
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
  const sharedKeyPath = resolve(commonDir, PROJECT_ENV_KEY_FILENAME);
  if (commonDir !== worktreeDir) {
    return sharedKeyPath;
  }
  return (await pathExists(sharedKeyPath)) ? sharedKeyPath : null;
}

async function ensureProjectEnvLocalIgnoreEntries(opts: {
  readonly projectRoot: string;
}): Promise<void> {
  const gitDir = await resolveGitWorktreeDir({
    repoRoot: opts.projectRoot,
  });
  const ignorePath =
    gitDir === null
      ? resolve(opts.projectRoot, ".gitignore")
      : resolve(gitDir, "info", "exclude");
  await ensureDir(dirname(ignorePath));
  for (const entry of [
    ".hack/hack.env.local.yaml",
    ".hack/hack.env.*.local.yaml",
  ]) {
    await ensureGitignoreEntry({
      gitignorePath: ignorePath,
      entry,
      comment: "# local project env overrides",
    });
  }
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
    .filter((name) => name !== PROJECT_ENV_LOCAL_SEGMENT)
    .filter((name) => !name.endsWith(`.${PROJECT_ENV_LOCAL_SEGMENT}`))
    .filter((name) => name.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

async function readProjectEnvConfigFile(opts: {
  readonly path: string;
  readonly environment: string;
}): Promise<ProjectEnvConfigReadResult> {
  const text = await readTextFile(opts.path);
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
    error: "expected a scalar or { secure: <ciphertext> }",
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
  const localDefaultPath = resolveProjectEnvLocalConfigPath({
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Env resolution keeps layered local/shared/worktree selection explicit in one place.
export async function resolveProjectEnvConfig(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly envName?: string | null;
  readonly serviceNames: readonly string[];
}): Promise<ProjectEnvResolvedConfig | null> {
  const selection = await resolveProjectEnvSelection({
    projectRoot: opts.projectRoot,
    projectDir: opts.projectDir,
    envName: opts.envName,
  });

  const defaultRead = await readProjectEnvConfigFile({
    path: selection.defaultPath,
    environment: "default",
  });
  const overlayRead =
    selection.overlayPath === null
      ? null
      : await readProjectEnvConfigFile({
          path: selection.overlayPath,
          environment: selection.effectiveEnv ?? "default",
        });
  const localDefaultRead = await readProjectEnvConfigFile({
    path: selection.localDefaultPath,
    environment: "default",
  });
  const localOverlayRead =
    selection.localOverlayPath === null
      ? null
      : await readProjectEnvConfigFile({
          path: selection.localOverlayPath,
          environment: selection.effectiveEnv ?? "default",
        });

  if (
    !(
      defaultRead.exists ||
      (overlayRead?.exists ?? false) ||
      localDefaultRead.exists ||
      (localOverlayRead?.exists ?? false)
    )
  ) {
    return null;
  }

  if (defaultRead.parseError) {
    throw new Error(
      `Failed to parse ${defaultRead.path}: ${defaultRead.parseError}`
    );
  }
  if (overlayRead?.parseError) {
    throw new Error(
      `Failed to parse ${overlayRead.path}: ${overlayRead.parseError}`
    );
  }
  if (localDefaultRead.parseError) {
    throw new Error(
      `Failed to parse ${localDefaultRead.path}: ${localDefaultRead.parseError}`
    );
  }
  if (localOverlayRead?.parseError) {
    throw new Error(
      `Failed to parse ${localOverlayRead.path}: ${localOverlayRead.parseError}`
    );
  }

  const merged = mergeProjectEnvConfigLayers({
    layers: [
      defaultRead.exists ? defaultRead.config : null,
      overlayRead?.exists ? overlayRead.config : null,
      localDefaultRead.exists ? localDefaultRead.config : null,
      localOverlayRead?.exists ? localOverlayRead.config : null,
    ],
    environment: selection.effectiveEnv ?? "default",
  });
  const keyText = await resolveProjectEnvKey({
    projectRoot: opts.projectRoot,
    required: hasSecretEntries({ config: merged }),
  });
  const globalEnv = resolveProjectEnvScopeValues({
    values: merged.values.global ?? {},
    keyText,
  });

  const declaredScopes = Object.keys(merged.values).sort((left, right) =>
    left.localeCompare(right)
  );
  const knownServiceSet = new Set(opts.serviceNames);
  const hostScopeConflictsWithService = knownServiceSet.has(
    PROJECT_ENV_HOST_SCOPE
  );
  const hostEnv = hostScopeConflictsWithService
    ? {}
    : resolveProjectEnvScopeValues({
        values: merged.values[PROJECT_ENV_HOST_SCOPE] ?? {},
        keyText,
      });
  const unknownScopes = declaredScopes
    .filter((scope) => scope !== "global")
    .filter((scope) => scope !== PROJECT_ENV_HOST_SCOPE)
    .filter((scope) => !knownServiceSet.has(scope));

  const serviceSet = new Set<string>([
    ...opts.serviceNames,
    ...declaredScopes.filter((scope) => scope !== "global"),
  ]);
  const serviceEnv: Record<string, Record<string, string>> = {};
  for (const serviceName of serviceSet) {
    const scopedValues = resolveProjectEnvScopeValues({
      values: merged.values[serviceName] ?? {},
      keyText,
    });
    serviceEnv[serviceName] = {
      ...globalEnv,
      ...scopedValues,
    };
  }

  const files = [selection.defaultPath];
  if (selection.overlayPath && overlayRead?.exists) {
    files.push(selection.overlayPath);
  }
  if (localDefaultRead.exists) {
    files.push(selection.localDefaultPath);
  }
  if (selection.localOverlayPath && localOverlayRead?.exists) {
    files.push(selection.localOverlayPath);
  }

  return {
    selection,
    merged,
    files,
    globalEnv,
    hostEnv,
    serviceEnv,
    declaredScopes,
    unknownScopes,
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
      Object.assign(scopeValues, layer?.values[scope] ?? {});
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
    out[key] = decryptProjectEnvStoredValue({
      storedValue,
      keyText: opts.keyText,
    });
  }
  return out;
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
  readonly storedValue: ProjectEnvStoredValue;
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
  if (!PROJECT_ENV_KEY_PATTERN.test(opts.key)) {
    throw new Error(`Invalid env key: ${opts.key}`);
  }
  const scope = assertValidProjectEnvScopeName({
    scopeName: opts.scope,
  });

  const filePath =
    opts.local === true
      ? resolveProjectEnvLocalConfigPath({
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
    await ensureProjectEnvLocalIgnoreEntries({
      projectRoot: opts.projectRoot,
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
  readonly projectDir: string;
  readonly envName: string | null;
  readonly scope: string;
  readonly key: string;
  readonly local?: boolean;
}): Promise<{ readonly changed: boolean; readonly filePath: string }> {
  const filePath =
    opts.local === true
      ? resolveProjectEnvLocalConfigPath({
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
  if (!(opts.key in scopeValues)) {
    return { changed: false, filePath };
  }
  delete scopeValues[opts.key];

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
  const changed = (await writeTextFileIfChanged(envPath, text)).changed;
  await ensureDir(
    dirname(resolveProjectEnvStatePath({ projectDir: opts.projectDir }))
  );
  await writeTextFile(
    resolveProjectEnvStatePath({ projectDir: opts.projectDir }),
    `${JSON.stringify(
      {
        version: 1,
        selectedOverlay: resolved.selection.effectiveEnv,
        selectedService: opts.serviceName ?? null,
        generatedAt: new Date().toISOString(),
        inputs: await buildProjectEnvStateDigests({
          files: resolved.files,
        }),
      },
      null,
      2
    )}\n`
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

  if (
    opts.state.selectedService !== null &&
    !opts.serviceNames.includes(opts.state.selectedService)
  ) {
    issues.push(
      `materialized service scope ${opts.state.selectedService} no longer exists`
    );
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
}): Promise<string | null> {
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

export async function ensureProjectEnvSecretKey(opts: {
  readonly projectRoot: string;
}): Promise<{
  readonly keyPath: string;
  readonly keyText: string;
  readonly created: boolean;
}> {
  const keyPath = resolveProjectEnvKeyPath({ projectRoot: opts.projectRoot });
  const sharedKeyPath = await resolveProjectEnvSharedKeyPath({
    projectRoot: opts.projectRoot,
  });
  const existing = await readTextFile(keyPath);
  if (existing !== null && existing.trim().length > 0) {
    return {
      keyPath,
      keyText: existing.trim(),
      created: false,
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
    };
  }

  const inheritedKey = await resolveInheritedProjectEnvKey({
    projectRoot: opts.projectRoot,
  });
  if (inheritedKey) {
    const inheritedKeyPath = sharedKeyPath ?? keyPath;
    await ensureDir(dirname(inheritedKeyPath));
    await writeTextFile(inheritedKeyPath, `${inheritedKey.keyText}\n`);
    await chmod(inheritedKeyPath, 0o600);
    if (sharedKeyPath === null) {
      await ensureGitignoreEntry({
        gitignorePath: resolve(opts.projectRoot, ".gitignore"),
        entry: PROJECT_ENV_KEY_FILENAME,
        comment: "# project env key",
      });
    }
    return {
      keyPath: inheritedKeyPath,
      keyText: inheritedKey.keyText,
      created: false,
    };
  }

  const keyText = randomBytes(32).toString("base64url");
  const nextKeyPath = sharedKeyPath ?? keyPath;
  await ensureDir(dirname(nextKeyPath));
  await writeTextFile(nextKeyPath, `${keyText}\n`);
  await chmod(nextKeyPath, 0o600);
  if (sharedKeyPath === null) {
    await ensureGitignoreEntry({
      gitignorePath: resolve(opts.projectRoot, ".gitignore"),
      entry: PROJECT_ENV_KEY_FILENAME,
      comment: "# project env key",
    });
  }
  return {
    keyPath: nextKeyPath,
    keyText,
    created: true,
  };
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
  const [prefix, ivText, tagText, ciphertextText] = opts.ciphertext.split(":");
  if (
    prefix !== PROJECT_ENV_SECRET_PREFIX ||
    !ivText ||
    !tagText ||
    !ciphertextText
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
  readonly paths: readonly string[];
}): Promise<readonly string[]> {
  const removed: string[] = [];
  for (const path of opts.paths) {
    if (!(await pathExists(path))) {
      continue;
    }
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
