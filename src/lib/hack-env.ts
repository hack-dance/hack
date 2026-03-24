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

export type HackEnvSource = "plain_env" | "keychain";

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
  readonly envForCompose: Readonly<Record<string, string>>;
};

export type HackEnvSelection = {
  readonly requestedEnv: string | null;
  readonly defaultEnv: string | null;
  readonly effectiveEnv: string | null;
  readonly overlayPath: string | null;
  readonly overlayExists: boolean;
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
  if (!contract) {
    return {
      path,
      exists: true,
      contract: defaultHackEnvContract(),
      parseError: "Invalid hack.env.json format",
    };
  }

  return { path, exists: true, contract };
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
    envForCompose,
  };
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

function parseHackEnvContract(value: unknown): HackEnvContract | null {
  if (!isRecord(value)) {
    return null;
  }
  const versionRaw = value.version;
  const version = typeof versionRaw === "number" ? versionRaw : null;
  if (version !== HACK_ENV_VERSION) {
    return null;
  }

  const varsRaw = value.vars;
  if (!Array.isArray(varsRaw)) {
    return null;
  }

  const vars: HackEnvVar[] = [];
  for (const entry of varsRaw) {
    const parsed = parseHackEnvVar(entry);
    if (parsed) {
      vars.push(parsed);
    }
  }

  return {
    $schema: getString(value, "$schema") ?? undefined,
    version: HACK_ENV_VERSION,
    vars,
  };
}

function parseHackEnvVar(value: unknown): HackEnvVar | null {
  if (!isRecord(value)) {
    return null;
  }
  const key = getString(value, "key");
  if (!key) {
    return null;
  }
  const required = value.required === true;
  const sourceRaw = getString(value, "source") ?? "plain_env";
  const source: HackEnvSource =
    sourceRaw === "keychain" ? "keychain" : "plain_env";

  const servicesRaw = value.services;
  const services = Array.isArray(servicesRaw)
    ? servicesRaw
        .map((v) => (typeof v === "string" ? v.trim() : ""))
        .filter((v) => v.length > 0)
    : null;

  const description = getString(value, "description") ?? undefined;

  return {
    key,
    required,
    source,
    services,
    ...(description ? { description } : {}),
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
  if (opts.storePlaintextInBackend) {
    const fromPortableBackend = await resolveSecretValue({
      secretStore: opts.secretStore,
      key: opts.contractVar.key,
      envName: opts.envName,
    });
    if (
      typeof fromPortableBackend === "string" &&
      fromPortableBackend.length > 0
    ) {
      return {
        key: opts.contractVar.key,
        required: opts.contractVar.required,
        source: opts.contractVar.source,
        services: opts.contractVar.services,
        value: fromPortableBackend,
        resolvedFrom: "portable_backend",
      };
    }
  }

  const fromDotenv =
    opts.overlayDotenv[opts.contractVar.key] ??
    opts.baseDotenv[opts.contractVar.key] ??
    null;
  if (typeof fromDotenv === "string" && fromDotenv.length > 0) {
    return {
      key: opts.contractVar.key,
      required: opts.contractVar.required,
      source: opts.contractVar.source,
      services: opts.contractVar.services,
      value: fromDotenv,
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
