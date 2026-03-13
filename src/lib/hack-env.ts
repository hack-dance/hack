import { resolve } from "node:path";

import {
  PROJECT_ENV_CONTRACT_FILENAME,
  PROJECT_ENV_FILENAME,
} from "../constants.ts";
import { parseDotEnv } from "./env.ts";
import { readTextFile, writeTextFileIfChanged } from "./fs.ts";
import { getString, isRecord } from "./guards.ts";
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
  readonly resolvedFrom: "dotenv" | "process" | "keychain" | null;
};

export type HackEnvResolveResult = {
  readonly contractPath: string;
  readonly contractExists: boolean;
  readonly contractParseError?: string;
  readonly envPath: string;
  readonly envExists: boolean;
  readonly contract: HackEnvContract;
  readonly storage: HackEnvStorageSummary;
  readonly values: readonly HackEnvValueState[];
  readonly missingRequired: readonly HackEnvValueState[];
  readonly envForCompose: Readonly<Record<string, string>>;
};

export type HackEnvPortableStateSummary = {
  readonly status: "not_configured";
  readonly trustModel: "local_only";
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
    readonly trustModel: "gitignored_plaintext";
  };
  readonly localSecrets: SecretStoreDescriptor & {
    readonly trustModel: "local_secret_backend";
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
}): Promise<HackEnvResolveResult> {
  const read = await readHackEnvContract({ projectDir: opts.projectDir });
  const contract = read.contract;
  const secretStore = await resolveSecretStore({
    projectName: opts.projectName,
    projectDir: opts.projectDir,
  });

  const envPath = resolve(opts.projectDir, PROJECT_ENV_FILENAME);
  const envText = await readTextFile(envPath);
  const envExists = envText !== null;
  const dotenv = envText ? parseDotEnv(envText) : {};

  const envForCompose: Record<string, string> = {};
  const values: HackEnvValueState[] = [];
  for (const v of contract.vars) {
    const key = v.key;

    if (v.source === "keychain") {
      const value = await secretStore.get({
        key,
      });
      const resolvedFrom = value === null ? null : "keychain";
      values.push({
        key,
        required: v.required,
        source: v.source,
        services: v.services,
        value,
        resolvedFrom,
      });
      if (value !== null) {
        envForCompose[key] = value;
      }
      continue;
    }

    const fromDotenv = dotenv[key];
    if (typeof fromDotenv === "string" && fromDotenv.length > 0) {
      values.push({
        key,
        required: v.required,
        source: v.source,
        services: v.services,
        value: fromDotenv,
        resolvedFrom: "dotenv",
      });
      envForCompose[key] = fromDotenv;
      continue;
    }

    const fromProcess = process.env[key];
    if (typeof fromProcess === "string" && fromProcess.length > 0) {
      values.push({
        key,
        required: v.required,
        source: v.source,
        services: v.services,
        value: fromProcess,
        resolvedFrom: "process",
      });
      envForCompose[key] = fromProcess;
      continue;
    }

    values.push({
      key,
      required: v.required,
      source: v.source,
      services: v.services,
      value: null,
      resolvedFrom: null,
    });
  }

  const missingRequired = values.filter((v) => v.required && v.value === null);
  return {
    contractPath: read.path,
    contractExists: read.exists,
    ...(read.parseError ? { contractParseError: read.parseError } : {}),
    envPath,
    envExists,
    contract,
    storage: {
      contract: {
        path: read.path,
        trustModel: "committed_no_values",
      },
      localPlaintext: {
        path: envPath,
        exists: envExists,
        trustModel: "gitignored_plaintext",
      },
      localSecrets: {
        ...secretStore.descriptor,
        trustModel: "local_secret_backend",
      },
      portableState: {
        status: "not_configured",
        trustModel: "local_only",
        message:
          "Project env values are not portable across machines by default. Portable encrypted bundles are not configured yet.",
      },
    },
    values,
    missingRequired,
    envForCompose,
  };
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
  const lines: string[] = [];
  for (const key of Object.keys(env).sort((a, b) => a.localeCompare(b))) {
    const value = env[key];
    if (typeof value !== "string") {
      continue;
    }
    lines.push(`${key}=${escapeEnvValue(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

function escapeEnvValue(value: string): string {
  const needsQuotes =
    value.includes(" ") || value.includes("\n") || value.includes('"');
  if (!needsQuotes) {
    return value;
  }
  return `"${value.replaceAll('"', '\\"')}"`;
}
