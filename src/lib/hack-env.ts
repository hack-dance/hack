import { resolve } from "node:path";

import {
  PROJECT_ENV_CONTRACT_FILENAME,
  PROJECT_ENV_FILENAME,
} from "../constants.ts";
import { readControlPlaneConfig } from "../control-plane/sdk/config.ts";
import { parseDotEnv, serializeDotEnv } from "./env.ts";
import { readTextFile, writeTextFileIfChanged } from "./fs.ts";
import { getString, isRecord } from "./guards.ts";
import { readProjectDefaultEnvConfig } from "./project.ts";
import type { SecretStoreDescriptor } from "./secret-store.ts";
import { resolveSecretStore } from "./secret-store.ts";

export const HACK_ENV_VERSION = 1 as const;
const HACK_ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export type HackEnvSource = "plain_env" | "keychain";

export type HackEnvMutationSourceValidationResult =
  | {
      readonly ok: true;
    }
  | {
      readonly ok: false;
      readonly kind: "contract_parse_error";
      readonly contractPath: string;
      readonly parseError: string;
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly kind: "source_mismatch";
      readonly contractPath: string;
      readonly expectedSource: HackEnvSource;
      readonly attemptedSource: HackEnvSource;
      readonly message: string;
    };

export type HackEnvVar = {
  readonly key: string;
  readonly required: boolean;
  readonly source: HackEnvSource;
  readonly services: readonly string[] | null;
  readonly description?: string;
};

export type HackEnvContract = {
  readonly $schema?: string;
  readonly version: typeof HACK_ENV_VERSION;
  readonly vars: readonly HackEnvVar[];
};

export type HackEnvReadResult = {
  readonly path: string;
  readonly exists: boolean;
  readonly contract: HackEnvContract;
  readonly parseError?: string;
};

type HackEnvContractParseResult =
  | {
      readonly ok: true;
      readonly contract: HackEnvContract;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

type HackEnvVarParseResult =
  | {
      readonly ok: true;
      readonly value: HackEnvVar;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

export type HackEnvValueState = {
  readonly key: string;
  readonly required: boolean;
  readonly source: HackEnvSource;
  readonly services: readonly string[] | null;
  readonly value: string | null;
  readonly resolvedFrom:
    | "dotenv"
    | "process"
    | "keychain"
    | "portable_backend"
    | null;
};

export type HackEnvResolveResult = {
  readonly contractPath: string;
  readonly contractExists: boolean;
  readonly contractParseError?: string;
  readonly envPath: string;
  readonly envExists: boolean;
  readonly envSelection: HackEnvSelection;
  readonly contract: HackEnvContract;
  readonly storage: HackEnvStorageSummary;
  readonly values: readonly HackEnvValueState[];
  readonly missingRequired: readonly HackEnvValueState[];
  readonly warnings: readonly HackEnvWarning[];
  readonly envForCompose: Readonly<Record<string, string>>;
};

export type HackEnvSelection = {
  readonly requestedEnv: string | null;
  readonly defaultEnv: string | null;
  readonly effectiveEnv: string | null;
  readonly overlayPath: string | null;
  readonly overlayExists: boolean;
};

export type HackEnvWarning = {
  readonly kind: "overlay_plaintext_ignored_for_secret_contract";
  readonly key: string;
  readonly overlayPath: string;
  readonly services: readonly string[] | null;
  readonly message: string;
};

export type HackEnvPortableStateSummary = {
  readonly status: "not_configured" | "backend_bundle";
  readonly trustModel: "local_only" | "encrypted_backend_bundle";
  readonly message: string;
};

export type HackEnvStorageSummary = {
  readonly contract: {
    readonly path: string;
    readonly trustModel: "committed_no_values";
  };
  readonly localPlaintext: {
    readonly path: string;
    readonly exists: boolean;
    readonly trustModel: "unenforced_plaintext_file";
    readonly mirroredToBackend: boolean;
    readonly fallback: {
      readonly enabled: true;
      readonly source: "process_env";
      readonly trustModel: "ambient_process_env";
    };
  };
  readonly localSecrets: SecretStoreDescriptor & {
    readonly trustModel: "local_secret_backend" | "local_secret_backend_shim";
  };
  readonly portableState: HackEnvPortableStateSummary;
};

export async function readHackEnvContract(opts: {
  readonly projectDir: string;
}): Promise<HackEnvReadResult> {
  const path = resolve(opts.projectDir, PROJECT_ENV_CONTRACT_FILENAME);
  const text = await readTextFile(path);
  if (text === null) {
    return { path, exists: false, contract: defaultHackEnvContract() };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid JSON";
    return {
      path,
      exists: true,
      contract: defaultHackEnvContract(),
      parseError: message,
    };
  }

  const contract = parseHackEnvContract(parsed);
  if (!contract.ok) {
    return {
      path,
      exists: true,
      contract: defaultHackEnvContract(),
      parseError: contract.error,
    };
  }

  return { path, exists: true, contract: contract.contract };
}

export async function resolveHackEnv(opts: {
  readonly projectDir: string;
  readonly projectName: string;
  readonly envName?: string | null;
}): Promise<HackEnvResolveResult> {
  const read = await readHackEnvContract({ projectDir: opts.projectDir });
  const contract = read.contract;
  const runtimeConfig = await readHackEnvRuntimeConfig({
    projectDir: opts.projectDir,
  });
  const envSelection = await resolveHackEnvSelection({
    projectDir: opts.projectDir,
    envName: opts.envName,
  });
  const secretStore = await resolveSecretStore({
    projectName: opts.projectName,
    projectDir: opts.projectDir,
  });

  const envPath = resolve(opts.projectDir, PROJECT_ENV_FILENAME);
  const envText = await readTextFile(envPath);
  const envExists = envText !== null;
  const baseDotenv = envText ? parseDotEnv(envText) : {};
  const overlayText =
    envSelection.overlayPath === null
      ? null
      : await readTextFile(envSelection.overlayPath);
  const overlayDotenv = overlayText ? parseDotEnv(overlayText) : {};
  const warnings = collectOverlayPlaintextWarnings({
    contract,
    overlayPath: envSelection.overlayPath,
    overlayDotenv,
  });

  const envForCompose: Record<string, string> = {};
  const values: HackEnvValueState[] = [];
  for (const contractVar of contract.vars) {
    const valueState = await resolveHackEnvValueState({
      contractVar,
      storePlaintextInBackend: runtimeConfig.storePlaintextInBackend,
      effectiveEnvName: envSelection.effectiveEnv,
      baseDotenv,
      overlayDotenv,
      secretStore,
    });
    values.push(valueState);
    if (valueState.value !== null) {
      envForCompose[valueState.key] = valueState.value;
    }
  }

  const missingRequired = values.filter((v) => v.required && v.value === null);
  return {
    contractPath: read.path,
    contractExists: read.exists,
    ...(read.parseError ? { contractParseError: read.parseError } : {}),
    envPath,
    envExists,
    envSelection,
    contract,
    storage: {
      contract: {
        path: read.path,
        trustModel: "committed_no_values",
      },
      localPlaintext: {
        path: envPath,
        exists: envExists,
        trustModel: "unenforced_plaintext_file",
        mirroredToBackend: runtimeConfig.storePlaintextInBackend,
        fallback: {
          enabled: true,
          source: "process_env",
          trustModel: "ambient_process_env",
        },
      },
      localSecrets: {
        ...secretStore.descriptor,
        trustModel:
          secretStore.descriptor.mode === "shim"
            ? "local_secret_backend_shim"
            : "local_secret_backend",
      },
      portableState: {
        ...describePortableState({
          storePlaintextInBackend: runtimeConfig.storePlaintextInBackend,
          localSecrets: {
            ...secretStore.descriptor,
            trustModel:
              secretStore.descriptor.mode === "shim"
                ? "local_secret_backend_shim"
                : "local_secret_backend",
          },
        }),
      },
    },
    values,
    missingRequired,
    warnings,
    envForCompose,
  };
}

export async function inspectHackEnvOverlayWarnings(opts: {
  readonly projectDir: string;
  readonly envName?: string | null;
}): Promise<readonly HackEnvWarning[]> {
  const read = await readHackEnvContract({ projectDir: opts.projectDir });
  const overlayPath =
    opts.envName === null
      ? null
      : resolveEnvFilePath({
          projectDir: opts.projectDir,
          envName: opts.envName,
        });
  const overlayText =
    overlayPath === null ? null : await readTextFile(overlayPath);
  const overlayDotenv = overlayText ? parseDotEnv(overlayText) : {};
  return collectOverlayPlaintextWarnings({
    contract: read.contract,
    overlayPath,
    overlayDotenv,
  });
}

export async function readHackEnvRuntimeConfig(opts: {
  readonly projectDir: string;
}): Promise<{
  readonly storePlaintextInBackend: boolean;
}> {
  const controlPlane = await readControlPlaneConfig({
    projectDir: opts.projectDir,
  });
  return {
    storePlaintextInBackend:
      controlPlane.config.secrets.storePlaintextInBackend,
  };
}

export async function validateHackEnvMutationSource(input: {
  readonly projectDir: string;
  readonly key: string;
  readonly attemptedSource: HackEnvSource;
}): Promise<HackEnvMutationSourceValidationResult> {
  const contract = await readHackEnvContract({ projectDir: input.projectDir });
  if (contract.exists && contract.parseError) {
    return {
      ok: false,
      kind: "contract_parse_error",
      contractPath: contract.path,
      parseError: contract.parseError,
      message: buildHackEnvMalformedContractMessage({
        key: input.key,
        contractPath: contract.path,
        parseError: contract.parseError,
      }),
    };
  }
  const contractVar =
    contract.contract.vars.find((entry) => entry.key === input.key) ?? null;
  if (!contractVar || contractVar.source === input.attemptedSource) {
    return { ok: true };
  }

  return {
    ok: false,
    kind: "source_mismatch",
    contractPath: contract.path,
    expectedSource: contractVar.source,
    attemptedSource: input.attemptedSource,
    message: buildHackEnvMutationSourceMismatchMessage({
      key: input.key,
      contractPath: contract.path,
      expectedSource: contractVar.source,
      attemptedSource: input.attemptedSource,
    }),
  };
}

export function resolveEnvFilePath(opts: {
  readonly projectDir: string;
  readonly envName?: string | null;
}): string {
  const envName = opts.envName?.trim() ?? "";
  const fileName =
    envName.length > 0
      ? `${PROJECT_ENV_FILENAME}.${envName}`
      : PROJECT_ENV_FILENAME;
  return resolve(opts.projectDir, fileName);
}

export function resolveEnvSecretKey(opts: {
  readonly key: string;
  readonly envName?: string | null;
}): string {
  const envName = opts.envName?.trim() ?? "";
  return envName.length > 0 ? `env.${envName}.${opts.key}` : opts.key;
}

export async function upsertDotEnvValue(opts: {
  readonly envFile: string;
  readonly key: string;
  readonly value: string;
}): Promise<{ readonly changed: boolean }> {
  const existingText = (await readTextFile(opts.envFile)) ?? "";
  const env = parseDotEnv(existingText);
  const nextEnv: Record<string, string> = { ...env, [opts.key]: opts.value };
  const nextText = serializeDotEnvStable(nextEnv);
  const result = await writeTextFileIfChanged(opts.envFile, nextText);
  return { changed: result.changed };
}

export async function removeDotEnvKey(opts: {
  readonly envFile: string;
  readonly key: string;
}): Promise<{ readonly changed: boolean }> {
  const existingText = (await readTextFile(opts.envFile)) ?? "";
  const env = parseDotEnv(existingText);
  if (!(opts.key in env)) {
    return { changed: false };
  }
  const nextEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === opts.key) {
      continue;
    }
    nextEnv[key] = value;
  }
  const nextText = serializeDotEnvStable(nextEnv);
  const result = await writeTextFileIfChanged(opts.envFile, nextText);
  return { changed: result.changed };
}

export function resolveKeychainServiceName(opts: {
  readonly projectName: string;
}): string {
  return `hack-${opts.projectName}`;
}

function defaultHackEnvContract(): HackEnvContract {
  return { version: HACK_ENV_VERSION, vars: [] };
}

function parseHackEnvContract(value: unknown): HackEnvContractParseResult {
  if (!isRecord(value)) {
    return { ok: false, error: "Contract root must be an object." };
  }
  if ("$schema" in value && typeof value.$schema !== "string") {
    return { ok: false, error: 'Field "$schema" must be a string.' };
  }
  const versionRaw = value.version;
  const version = typeof versionRaw === "number" ? versionRaw : null;
  if (version !== HACK_ENV_VERSION) {
    return {
      ok: false,
      error: `Field "version" must be ${HACK_ENV_VERSION}.`,
    };
  }

  const varsRaw = value.vars;
  if (!Array.isArray(varsRaw)) {
    return { ok: false, error: 'Field "vars" must be an array.' };
  }

  const vars: HackEnvVar[] = [];
  for (const [index, entry] of varsRaw.entries()) {
    const parsed = parseHackEnvVar({ value: entry });
    if (!parsed.ok) {
      return {
        ok: false,
        error: `Field "vars[${index}]" is invalid: ${parsed.error}`,
      };
    }
    vars.push(parsed.value);
  }

  return {
    ok: true,
    contract: {
      $schema: getString(value, "$schema") ?? undefined,
      version: HACK_ENV_VERSION,
      vars,
    },
  };
}

function parseHackEnvVar(input: {
  readonly value: unknown;
}): HackEnvVarParseResult {
  if (!isRecord(input.value)) {
    return { ok: false, error: "Expected an object." };
  }
  const key = getString(input.value, "key");
  if (!(key && HACK_ENV_KEY_PATTERN.test(key))) {
    return {
      ok: false,
      error:
        'Field "key" must be an uppercase snake-case env var name (for example "DATABASE_URL").',
    };
  }

  if ("required" in input.value && typeof input.value.required !== "boolean") {
    return {
      ok: false,
      error: 'Field "required" must be a boolean when provided.',
    };
  }
  const required = input.value.required === true;

  const sourceRaw = getString(input.value, "source");
  if (
    "source" in input.value &&
    sourceRaw !== "plain_env" &&
    sourceRaw !== "keychain"
  ) {
    return {
      ok: false,
      error: 'Field "source" must be "plain_env" or "keychain" when provided.',
    };
  }
  const source: HackEnvSource =
    sourceRaw === "keychain" ? "keychain" : "plain_env";

  const servicesRaw = input.value.services;
  if (
    servicesRaw !== undefined &&
    servicesRaw !== null &&
    !Array.isArray(servicesRaw)
  ) {
    return {
      ok: false,
      error:
        'Field "services" must be null or an array of non-empty strings when provided.',
    };
  }
  let services: readonly string[] | null = null;
  if (Array.isArray(servicesRaw)) {
    const parsedServices: string[] = [];
    for (const [index, service] of servicesRaw.entries()) {
      if (
        typeof service !== "string" ||
        service.length === 0 ||
        service.trim() !== service
      ) {
        return {
          ok: false,
          error: `Field "services[${index}]" must be a non-empty string without surrounding whitespace.`,
        };
      }
      parsedServices.push(service);
    }
    services = parsedServices;
  }

  if (
    "description" in input.value &&
    typeof input.value.description !== "string"
  ) {
    return {
      ok: false,
      error: 'Field "description" must be a string when provided.',
    };
  }
  const description = getString(input.value, "description");

  return {
    ok: true,
    value: {
      key,
      required,
      source,
      services,
      ...(description !== undefined ? { description } : {}),
    },
  };
}

function serializeDotEnvStable(env: Record<string, string>): string {
  const sortedEnv: Record<string, string> = {};
  for (const key of Object.keys(env).sort((a, b) => a.localeCompare(b))) {
    const value = env[key];
    if (typeof value === "string") {
      sortedEnv[key] = value;
    }
  }
  return serializeDotEnv(sortedEnv);
}

function buildHackEnvMutationSourceMismatchMessage(input: {
  readonly key: string;
  readonly contractPath: string;
  readonly expectedSource: HackEnvSource;
  readonly attemptedSource: HackEnvSource;
}): string {
  if (input.expectedSource === "keychain") {
    return `Env key "${input.key}" is declared as source "keychain" in ${input.contractPath}. Use "hack env set --secret ${input.key}=…" or update the contract source before writing. Hack will not write this key to plaintext compatibility storage.`;
  }

  return `Env key "${input.key}" is declared as source "plain_env" in ${input.contractPath}. Use "hack env set ${input.key}=…" or update the contract source before writing. Hack will not write this key through the secret backend until the contract source changes.`;
}

function buildHackEnvMalformedContractMessage(input: {
  readonly key: string;
  readonly contractPath: string;
  readonly parseError: string;
}): string {
  return `Env contract ${input.contractPath} is malformed (${input.parseError}). Fix or remove the contract file before writing "${input.key}". Hack will not fall back to the default contract while mutation-source validation cannot trust the declared storage rules.`;
}

function describePortableState(input: {
  readonly storePlaintextInBackend: boolean;
  readonly localSecrets: HackEnvStorageSummary["localSecrets"];
}): HackEnvPortableStateSummary {
  if (!input.storePlaintextInBackend) {
    return {
      status: "not_configured",
      trustModel: "local_only",
      message:
        "Project env values are not portable across machines by default. Portable encrypted bundles are not configured yet.",
    };
  }

  if (input.localSecrets.backend === "encrypted_file") {
    return {
      status: "backend_bundle",
      trustModel: "encrypted_backend_bundle",
      message:
        "Plaintext and secret env values are bundled in the encrypted backend. Share the encrypted file and key to move the full env set across machines.",
    };
  }

  if (input.localSecrets.backend === "cloud") {
    return {
      status: "backend_bundle",
      trustModel: "encrypted_backend_bundle",
      message:
        "Plaintext and secret env values are bundled in the backend, but cloud mode still uses a local encrypted-file shim today.",
    };
  }

  return {
    status: "backend_bundle",
    trustModel: "local_only",
    message:
      "Plaintext and secret env values are bundled in the keychain backend, but that backend remains machine-local.",
  };
}

function collectOverlayPlaintextWarnings(input: {
  readonly contract: HackEnvContract;
  readonly overlayPath: string | null;
  readonly overlayDotenv: Readonly<Record<string, string>>;
}): HackEnvWarning[] {
  if (input.overlayPath === null) {
    return [];
  }

  const varsByKey = new Map(
    input.contract.vars.map((contractVar) => [contractVar.key, contractVar])
  );
  const warnings: HackEnvWarning[] = [];

  for (const key of Object.keys(input.overlayDotenv).sort()) {
    const contractVar = varsByKey.get(key);
    if (contractVar?.source !== "keychain") {
      continue;
    }
    const overlayName = resolveOverlayNameFromPath({
      overlayPath: input.overlayPath,
    });
    warnings.push({
      kind: "overlay_plaintext_ignored_for_secret_contract",
      key,
      overlayPath: input.overlayPath,
      services: contractVar.services,
      message: `Selected overlay ${input.overlayPath} contains plaintext ${key}, but ${key} is declared as source "keychain" in .hack/hack.env.json. That plaintext overlay value is ignored. Use "hack env set --env ${overlayName} --secret ${key}=…" instead.`,
    });
  }

  return warnings;
}

function resolveOverlayNameFromPath(input: {
  readonly overlayPath: string;
}): string {
  const suffix = input.overlayPath.split(`${PROJECT_ENV_FILENAME}.`)[1] ?? "";
  return suffix.trim() || "<env>";
}

async function resolveHackEnvSelection(opts: {
  readonly projectDir: string;
  readonly envName?: string | null;
}): Promise<HackEnvSelection> {
  const requestedEnv = opts.envName === undefined ? undefined : opts.envName;
  const defaultEnv = await readProjectDefaultEnvConfig({
    projectDir: opts.projectDir,
  });
  const effectiveEnv = requestedEnv === undefined ? defaultEnv : requestedEnv;
  const overlayPath =
    effectiveEnv === null
      ? null
      : resolveEnvFilePath({
          projectDir: opts.projectDir,
          envName: effectiveEnv,
        });
  const overlayExists =
    overlayPath === null ? false : (await readTextFile(overlayPath)) !== null;

  return {
    requestedEnv: requestedEnv ?? null,
    defaultEnv,
    effectiveEnv,
    overlayPath,
    overlayExists,
  };
}

async function resolveSecretValue(opts: {
  readonly secretStore: {
    readonly get: (input: { readonly key: string }) => Promise<string | null>;
  };
  readonly key: string;
  readonly envName?: string | null;
}): Promise<string | null> {
  if (opts.envName) {
    const overlayValue = await opts.secretStore.get({
      key: resolveEnvSecretKey({
        key: opts.key,
        envName: opts.envName,
      }),
    });
    if (typeof overlayValue === "string" && overlayValue.length > 0) {
      return overlayValue;
    }
  }

  return await opts.secretStore.get({ key: opts.key });
}

async function resolveHackEnvValueState(opts: {
  readonly contractVar: HackEnvVar;
  readonly storePlaintextInBackend: boolean;
  readonly effectiveEnvName: string | null;
  readonly baseDotenv: Readonly<Record<string, string>>;
  readonly overlayDotenv: Readonly<Record<string, string>>;
  readonly secretStore: {
    readonly get: (input: { readonly key: string }) => Promise<string | null>;
  };
}): Promise<HackEnvValueState> {
  if (opts.contractVar.source === "keychain") {
    return await resolveSecretBackedValueState({
      contractVar: opts.contractVar,
      secretStore: opts.secretStore,
      envName: opts.effectiveEnvName,
    });
  }

  return await resolvePlaintextValueState({
    contractVar: opts.contractVar,
    storePlaintextInBackend: opts.storePlaintextInBackend,
    envName: opts.effectiveEnvName,
    baseDotenv: opts.baseDotenv,
    overlayDotenv: opts.overlayDotenv,
    secretStore: opts.secretStore,
  });
}

async function resolveSecretBackedValueState(opts: {
  readonly contractVar: HackEnvVar;
  readonly secretStore: {
    readonly get: (input: { readonly key: string }) => Promise<string | null>;
  };
  readonly envName: string | null;
}): Promise<HackEnvValueState> {
  const value = await resolveSecretValue({
    secretStore: opts.secretStore,
    key: opts.contractVar.key,
    envName: opts.envName,
  });
  return {
    key: opts.contractVar.key,
    required: opts.contractVar.required,
    source: opts.contractVar.source,
    services: opts.contractVar.services,
    value,
    resolvedFrom: value === null ? null : "keychain",
  };
}

async function resolvePlaintextValueState(opts: {
  readonly contractVar: HackEnvVar;
  readonly storePlaintextInBackend: boolean;
  readonly envName: string | null;
  readonly baseDotenv: Readonly<Record<string, string>>;
  readonly overlayDotenv: Readonly<Record<string, string>>;
  readonly secretStore: {
    readonly get: (input: { readonly key: string }) => Promise<string | null>;
  };
}): Promise<HackEnvValueState> {
  if (opts.storePlaintextInBackend && opts.envName) {
    const fromOverlayPortableBackend = await opts.secretStore.get({
      key: resolveEnvSecretKey({
        key: opts.contractVar.key,
        envName: opts.envName,
      }),
    });
    if (
      typeof fromOverlayPortableBackend === "string" &&
      fromOverlayPortableBackend.length > 0
    ) {
      return {
        key: opts.contractVar.key,
        required: opts.contractVar.required,
        source: opts.contractVar.source,
        services: opts.contractVar.services,
        value: fromOverlayPortableBackend,
        resolvedFrom: "portable_backend",
      };
    }
  }

  const fromOverlayDotenv = opts.overlayDotenv[opts.contractVar.key] ?? null;
  if (typeof fromOverlayDotenv === "string" && fromOverlayDotenv.length > 0) {
    return {
      key: opts.contractVar.key,
      required: opts.contractVar.required,
      source: opts.contractVar.source,
      services: opts.contractVar.services,
      value: fromOverlayDotenv,
      resolvedFrom: "dotenv",
    };
  }

  if (opts.storePlaintextInBackend) {
    const fromBasePortableBackend = await opts.secretStore.get({
      key: opts.contractVar.key,
    });
    if (
      typeof fromBasePortableBackend === "string" &&
      fromBasePortableBackend.length > 0
    ) {
      return {
        key: opts.contractVar.key,
        required: opts.contractVar.required,
        source: opts.contractVar.source,
        services: opts.contractVar.services,
        value: fromBasePortableBackend,
        resolvedFrom: "portable_backend",
      };
    }
  }

  const fromBaseDotenv = opts.baseDotenv[opts.contractVar.key] ?? null;
  if (typeof fromBaseDotenv === "string" && fromBaseDotenv.length > 0) {
    return {
      key: opts.contractVar.key,
      required: opts.contractVar.required,
      source: opts.contractVar.source,
      services: opts.contractVar.services,
      value: fromBaseDotenv,
      resolvedFrom: "dotenv",
    };
  }

  const fromProcess = process.env[opts.contractVar.key];
  if (typeof fromProcess === "string" && fromProcess.length > 0) {
    return {
      key: opts.contractVar.key,
      required: opts.contractVar.required,
      source: opts.contractVar.source,
      services: opts.contractVar.services,
      value: fromProcess,
      resolvedFrom: "process",
    };
  }

  return {
    key: opts.contractVar.key,
    required: opts.contractVar.required,
    source: opts.contractVar.source,
    services: opts.contractVar.services,
    value: null,
    resolvedFrom: null,
  };
}
