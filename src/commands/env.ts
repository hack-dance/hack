import { resolve } from "node:path";
import { confirm, isCancel, password, text } from "@clack/prompts";

import type { CliContext, CommandHandlerFor } from "../cli/command.ts";
import {
  CliUsageError,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";
import { optEnv, optJson, optPath, optProject } from "../cli/options.ts";
import { readControlPlaneConfig } from "../control-plane/sdk/config.ts";
import { updateGlobalConfig } from "../lib/config.ts";
import type {
  HackEnvStorageSummary,
  HackEnvValueState,
} from "../lib/hack-env.ts";
import {
  readHackEnvRuntimeConfig,
  removeDotEnvKey,
  resolveEnvFilePath,
  resolveEnvSecretKey,
  resolveHackEnv,
  upsertDotEnvValue,
} from "../lib/hack-env.ts";
import {
  describeBackendStrategyStatus,
  describeEnvAggregateStatusForJson,
  describeValueStorageForJson as describeValueStorageForJsonShape,
  serializeEnvClassificationForJson,
  serializeEnvStorageForJson as serializeEnvStorageForJsonShape,
} from "../lib/hack-env-status.ts";
import type { ProjectContext } from "../lib/project.ts";
import {
  defaultProjectSlugFromPath,
  findProjectContext,
  parseEnvConfigSelection,
  readProjectConfig,
  sanitizeProjectSlug,
} from "../lib/project.ts";
import { resolveRegisteredProjectByName } from "../lib/projects-registry.ts";
import {
  formatSecretStoreDescriptor,
  provisionEncryptedFileKey,
  resolveSecretStore,
} from "../lib/secret-store.ts";
import { display } from "../ui/display.ts";
import { logger } from "../ui/logger.ts";

const optShowSecrets = defineOption({
  name: "showSecrets",
  type: "boolean",
  long: "--show-secrets",
  description: "Print secret values (keychain) in plaintext",
} as const);

const optSecret = defineOption({
  name: "secret",
  type: "boolean",
  long: "--secret",
  description: "Store value in configured secret backend instead of .hack/.env",
} as const);

const listSpec = defineCommand({
  name: "list",
  summary: "List env contract vars and resolution state",
  group: "Project",
  options: [optPath, optProject, optEnv, optJson, optShowSecrets],
  positionals: [],
  subcommands: [],
} as const);

const setSpec = defineCommand({
  name: "set",
  summary: "Set an env value (.hack/.env or keychain)",
  group: "Project",
  options: [optPath, optProject, optEnv, optSecret],
  positionals: [{ name: "spec", required: false }],
  subcommands: [],
} as const);

const unsetSpec = defineCommand({
  name: "unset",
  summary: "Unset an env value (.hack/.env and keychain)",
  group: "Project",
  options: [optPath, optProject, optEnv],
  positionals: [{ name: "key", required: false }],
  subcommands: [],
} as const);

const optProvider = defineOption({
  name: "provider",
  type: "string",
  long: "--provider",
  valueHint: "<aws|gcp|azure|vault>",
  description: "Cloud secret provider when backend is cloud",
} as const);

const optStorePath = defineOption({
  name: "storePath",
  type: "string",
  long: "--store-path",
  valueHint: "<path>",
  description: "Encrypted file path when backend is encrypted_file",
} as const);

const optKeyPath = defineOption({
  name: "keyPath",
  type: "string",
  long: "--key-path",
  valueHint: "<path>",
  description: "Stable key file path when backend is encrypted_file",
} as const);

const optProvisionKey = defineOption({
  name: "provisionKey",
  type: "boolean",
  long: "--provision-key",
  description: "Provision a stable key file for encrypted_file backend",
} as const);

const optSecretProject = defineOption({
  name: "secretProject",
  type: "string",
  long: "--secret-project",
  valueHint: "<id>",
  description: "Optional cloud project/account identifier",
} as const);

const optSecretPrefix = defineOption({
  name: "secretPrefix",
  type: "string",
  long: "--secret-prefix",
  valueHint: "<prefix>",
  description: "Optional cloud secret name prefix",
} as const);

const backendSpec = defineCommand({
  name: "backend",
  summary: "Manage env/secret storage backend strategy",
  group: "Project",
  options: [],
  positionals: [],
  subcommands: [],
} as const);

const backendStatusSpec = defineCommand({
  name: "status",
  summary: "Show configured env/secret backend strategy",
  group: "Project",
  options: [optJson],
  positionals: [],
  subcommands: [],
} as const);

const backendUseSpec = defineCommand({
  name: "use",
  summary: "Select env/secret backend strategy",
  group: "Project",
  options: [
    optProvider,
    optStorePath,
    optKeyPath,
    optProvisionKey,
    optSecretProject,
    optSecretPrefix,
    optJson,
  ],
  positionals: [{ name: "backend", required: true }],
  subcommands: [],
} as const);

const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_BACKEND_VALUES = ["keychain", "encrypted_file", "cloud"] as const;
const CLOUD_PROVIDER_VALUES = ["aws", "gcp", "azure", "vault"] as const;
const ENCRYPTED_FILE_KEY_ENV = "HACK_SECRETS_FILE_KEY";

function describeLocalSecretsForDisplay(input: {
  readonly storage: HackEnvStorageSummary["localSecrets"];
}): string {
  const descriptor = formatSecretStoreDescriptor({
    descriptor: input.storage,
  });
  if (input.storage.backend === "keychain") {
    return `${descriptor} (encrypted by the OS keychain; machine-local secret storage)`;
  }
  if (input.storage.backend === "encrypted_file") {
    return `${descriptor} (encrypted local file; machine-local secret storage)`;
  }
  return `${descriptor} (cloud shim today; values still land in a local encrypted file until provider-native transport ships)`;
}

function describePortableStateForDisplay(input: {
  readonly storage: HackEnvStorageSummary["portableState"];
}): string {
  return `${input.storage.status} (${input.storage.trustModel}) — ${input.storage.message}`;
}

function describeValueStorageForJson(input: {
  readonly value: Pick<HackEnvValueState, "source" | "resolvedFrom">;
  readonly storage: HackEnvStorageSummary;
}) {
  return describeValueStorageForJsonShape(input);
}

function describeValueStorageForDisplay(input: {
  readonly value: Pick<HackEnvValueState, "source" | "resolvedFrom">;
  readonly storage: HackEnvStorageSummary;
}): string {
  const storage = describeValueStorageForJson(input);
  if (storage.kind === "secret") {
    const providerSuffix =
      input.storage.localSecrets.backend === "cloud" &&
      input.storage.localSecrets.provider
        ? `:${input.storage.localSecrets.provider}`
        : "";
    const modeSuffix =
      input.storage.localSecrets.mode === "shim" ? " [shim]" : "";
    return `secret:${input.storage.localSecrets.backend}${providerSuffix}${modeSuffix}`;
  }

  if (storage.backend === "process_env") {
    return "plaintext:process_env";
  }

  if (input.value.resolvedFrom === "portable_backend") {
    const providerSuffix =
      input.storage.localSecrets.backend === "cloud" &&
      input.storage.localSecrets.provider
        ? `:${input.storage.localSecrets.provider}`
        : "";
    const modeSuffix =
      input.storage.localSecrets.mode === "shim" ? " [shim]" : "";
    return `plaintext:${input.storage.localSecrets.backend}${providerSuffix}${modeSuffix} [bundle]`;
  }

  return "plaintext:.hack/.env";
}

function describeBackendTrustStatus(input: {
  readonly backend: (typeof SECRET_BACKEND_VALUES)[number];
  readonly provider?: string | null;
  readonly storePlaintextInBackend: boolean;
}) {
  return describeBackendStrategyStatus(input);
}

function isSecretBackend(
  value: string
): value is (typeof SECRET_BACKEND_VALUES)[number] {
  return SECRET_BACKEND_VALUES.includes(
    value as (typeof SECRET_BACKEND_VALUES)[number]
  );
}

function isCloudProvider(
  value: string
): value is (typeof CLOUD_PROVIDER_VALUES)[number] {
  return CLOUD_PROVIDER_VALUES.includes(
    value as (typeof CLOUD_PROVIDER_VALUES)[number]
  );
}

async function persistBackendSelection(input: {
  readonly backend: (typeof SECRET_BACKEND_VALUES)[number];
  readonly storePath?: string;
  readonly keyPath?: string;
  readonly provider?: string;
  readonly secretProject?: string;
  readonly secretPrefix?: string;
}): Promise<void> {
  await updateGlobalConfig({
    path: "controlPlane.secrets.backend",
    value: input.backend,
  });

  if (input.backend === "encrypted_file" && input.storePath) {
    await updateGlobalConfig({
      path: "controlPlane.secrets.encryptedFile.path",
      value: input.storePath,
    });
  }

  if (input.backend === "encrypted_file" && input.keyPath) {
    await updateGlobalConfig({
      path: "controlPlane.secrets.encryptedFile.keyPath",
      value: input.keyPath,
    });
  }

  if (input.backend !== "cloud" || !input.provider) {
    return;
  }

  await updateGlobalConfig({
    path: "controlPlane.secrets.cloud.provider",
    value: input.provider,
  });

  if (input.secretProject) {
    await updateGlobalConfig({
      path: "controlPlane.secrets.cloud.project",
      value: input.secretProject,
    });
  }

  if (input.secretPrefix) {
    await updateGlobalConfig({
      path: "controlPlane.secrets.cloud.secretPrefix",
      value: input.secretPrefix,
    });
  }
}

async function resolveProjectForEnv(opts: {
  readonly ctx: CliContext;
  readonly pathOpt: string | undefined;
  readonly projectOpt: string | undefined;
}): Promise<ProjectContext> {
  if (opts.pathOpt && opts.projectOpt) {
    throw new CliUsageError("Use either --path or --project (not both).");
  }

  if (opts.projectOpt) {
    const name = sanitizeProjectSlug(opts.projectOpt);
    if (!name) {
      throw new CliUsageError("Invalid --project value.");
    }
    const project = await resolveRegisteredProjectByName({ name });
    if (!project) {
      throw new CliUsageError(
        `Unknown project "${name}". Run 'hack init' in that repo (or run 'hack projects' to see registered projects).`
      );
    }
    return project;
  }

  const startDir = opts.pathOpt
    ? resolve(opts.ctx.cwd, opts.pathOpt)
    : opts.ctx.cwd;
  const project = await findProjectContext(startDir);
  if (!project) {
    throw new CliUsageError("No .hack/ found. Run: hack init");
  }
  return project;
}

async function resolveProjectName(project: ProjectContext): Promise<string> {
  const cfg = await readProjectConfig(project);
  const derived = defaultProjectSlugFromPath(project.projectRoot);
  const raw = (cfg.name ?? derived).trim();
  return sanitizeProjectSlug(raw.length > 0 ? raw : derived);
}

function resolveRequestedEnvName(input: {
  readonly envOption: string | undefined;
}): string | null | undefined {
  const envName = parseEnvConfigSelection(input.envOption);
  if (input.envOption !== undefined && envName === undefined) {
    throw new CliUsageError("Invalid --env value.");
  }
  return envName;
}

async function resolveConfiguredSecretStore(input: {
  readonly project: ProjectContext;
  readonly projectName: string;
}) {
  try {
    return await resolveSecretStore({
      projectName: input.projectName,
      projectDir: input.project.projectDir,
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to resolve secret store.";
    throw new CliUsageError(message);
  }
}

const handleEnvList: CommandHandlerFor<typeof listSpec> = async ({
  ctx,
  args,
}): Promise<number> => {
  const project = await resolveProjectForEnv({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
  });
  const projectName = await resolveProjectName(project);
  const showSecrets = args.options.showSecrets === true;
  const json = args.options.json === true;
  const envName = resolveRequestedEnvName({
    envOption: args.options.env,
  });

  const resolved = await resolveHackEnv({
    projectDir: project.projectDir,
    projectName,
    envName,
  });

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          project: projectName,
          env_selection: {
            requested: resolved.envSelection.requestedEnv,
            default: resolved.envSelection.defaultEnv,
            effective: resolved.envSelection.effectiveEnv,
            overlay_path: resolved.envSelection.overlayPath,
            overlay_exists: resolved.envSelection.overlayExists,
          },
          status: describeEnvAggregateStatusForJson({
            storage: resolved.storage,
          }),
          storage: serializeEnvStorageForJson({ storage: resolved.storage }),
          vars: resolved.values.map((v) => ({
            key: v.key,
            required: v.required,
            source: v.source,
            storage: describeValueStorageForJson({
              value: v,
              storage: resolved.storage,
            }),
            services: v.services,
            resolved_from: v.resolvedFrom,
            value:
              v.source === "keychain" && !showSecrets && v.value !== null
                ? "***"
                : v.value,
          })),
          missing_required: resolved.missingRequired.map((v) => v.key),
        },
        null,
        2
      )}\n`
    );
    return resolved.missingRequired.length > 0 ? 1 : 0;
  }

  await display.kv({
    title: "Env storage",
    entries: [
      [
        "env_selection",
        resolved.envSelection.effectiveEnv
          ? `${resolved.envSelection.effectiveEnv} (base .hack/.env overlaid by ${resolved.envSelection.overlayPath})`
          : "base (.hack/.env only)",
      ],
      [
        "contract",
        `${resolved.storage.contract.path} (committed metadata only; no values are stored here)`,
      ],
      [
        "local_plaintext",
        `${resolved.storage.localPlaintext.path} (${resolved.storage.localPlaintext.exists ? "present" : "missing"} plaintext compatibility file for plain_env; existing .env-style workflows still work and gitignore is recommended but not enforced)`,
      ],
      [
        "local_fallback",
        `${resolved.storage.localPlaintext.fallback.source} (ambient plaintext fallback when .hack/.env does not provide a plain_env value)`,
      ],
      [
        "local_secrets",
        describeLocalSecretsForDisplay({
          storage: resolved.storage.localSecrets,
        }),
      ],
      [
        "compatibility_mode",
        "Plaintext values materialize to .hack/.env. Secret values materialize to the configured secret backend. This preserves current local runtime behavior while portable env stays opt-in.",
      ],
      [
        "portable_state",
        describePortableStateForDisplay({
          storage: resolved.storage.portableState,
        }),
      ],
    ],
  });

  if (resolved.contract.vars.length === 0) {
    logger.info({
      message: `No ${project.projectDir}/hack.env.json contract found (or it has no vars).`,
    });
    return 0;
  }

  await display.section("Resolved env vars");

  for (const v of resolved.values) {
    const value =
      v.source === "keychain" && !showSecrets && v.value !== null
        ? "***"
        : (v.value ?? "");
    const required = v.required ? "required" : "optional";
    const source = v.source;
    const from = v.resolvedFrom ?? "missing";
    const storage = describeValueStorageForDisplay({
      value: v,
      storage: resolved.storage,
    });
    const services = v.services ? v.services.join(",") : "*";
    process.stdout.write(
      `${v.key}\t${required}\t${source}\t${storage}\t${from}\t${services}\t${value}\n`
    );
  }

  if (resolved.missingRequired.length > 0) {
    logger.warn({
      message: `Missing required env: ${resolved.missingRequired.map((v) => v.key).join(", ")}`,
    });
    return 1;
  }

  return 0;
};

function serializeEnvStorageForJson(input: {
  readonly storage: HackEnvStorageSummary;
}) {
  return serializeEnvStorageForJsonShape(input);
}

const handleEnvSet: CommandHandlerFor<typeof setSpec> = async ({
  ctx,
  args,
}): Promise<number> => {
  const project = await resolveProjectForEnv({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
  });
  const projectName = await resolveProjectName(project);
  const storeSecret = args.options.secret === true;
  const runtimeConfig = await readHackEnvRuntimeConfig({
    projectDir: project.projectDir,
  });
  const envName = resolveRequestedEnvName({
    envOption: args.options.env,
  });

  const spec = (args.positionals.spec ?? "").trim();
  const [keyFromSpec, valueFromSpec] = parseKeyValueSpec(spec);

  const key = await resolveEnvKey({ key: keyFromSpec });
  const value = await resolveEnvValue({
    key,
    value: valueFromSpec,
    secret: storeSecret,
  });

  if (storeSecret) {
    const store = await resolveConfiguredSecretStore({ project, projectName });
    await store.set({
      key: resolveEnvSecretKey({ key, envName }),
      value,
    });
    logger.success({
      message: `Stored secret "${key}" in ${formatSecretStoreDescriptor({ descriptor: store.descriptor })}${envName ? ` (env ${envName})` : ""}`,
    });
    return 0;
  }

  const envFile = resolveEnvFilePath({
    projectDir: project.projectDir,
    envName,
  });
  const [result, mirroredToBackend] = await Promise.all([
    upsertDotEnvValue({ envFile, key, value }),
    runtimeConfig.storePlaintextInBackend
      ? resolveConfiguredSecretStore({ project, projectName }).then(
          async (store) => {
            await store.set({
              key: resolveEnvSecretKey({ key, envName }),
              value,
            });
            return formatSecretStoreDescriptor({
              descriptor: store.descriptor,
            });
          }
        )
      : Promise.resolve<string | null>(null),
  ]);
  logger.success({
    message: [
      result.changed ? `Updated ${envFile}` : `No changes needed in ${envFile}`,
      mirroredToBackend
        ? `Mirrored portable plaintext to ${mirroredToBackend}`
        : null,
    ]
      .filter((value) => typeof value === "string")
      .join(" • "),
  });
  return 0;
};

const handleEnvUnset: CommandHandlerFor<typeof unsetSpec> = async ({
  ctx,
  args,
}): Promise<number> => {
  const project = await resolveProjectForEnv({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
  });
  const projectName = await resolveProjectName(project);
  const store = await resolveConfiguredSecretStore({ project, projectName });
  const envName = resolveRequestedEnvName({
    envOption: args.options.env,
  });

  const key = await resolveEnvKey({ key: (args.positionals.key ?? "").trim() });

  const ok = await confirm({
    message: `Unset "${key}" from ${resolveEnvFilePath({ projectDir: project.projectDir, envName })} and ${formatSecretStoreDescriptor({ descriptor: store.descriptor })}${envName ? ` (env ${envName})` : ""}?`,
    initialValue: true,
  });
  if (isCancel(ok)) {
    return 1;
  }
  if (!ok) {
    return 0;
  }

  const envFile = resolveEnvFilePath({
    projectDir: project.projectDir,
    envName,
  });
  const [dotenvResult, secretDeleted] = await Promise.all([
    removeDotEnvKey({ envFile, key }),
    store.delete({
      key: resolveEnvSecretKey({ key, envName }),
    }),
  ]);

  logger.success({
    message: [
      dotenvResult.changed ? `Updated ${envFile}` : `No ${key} in ${envFile}`,
      secretDeleted
        ? `Deleted from ${formatSecretStoreDescriptor({ descriptor: store.descriptor })}`
        : "No secret entry",
    ].join(" • "),
  });
  return 0;
};

const handleEnvBackendStatus: CommandHandlerFor<
  typeof backendStatusSpec
> = async ({ ctx, args }): Promise<number> => {
  const project = await findProjectContext(ctx.cwd);
  const controlPlane = await readControlPlaneConfig({
    ...(project ? { projectDir: project.projectDir } : {}),
  });
  const secretsConfig = controlPlane.config.secrets;
  const backendStatus = describeBackendTrustStatus({
    backend: secretsConfig.backend,
    provider: secretsConfig.cloud.provider ?? null,
    storePlaintextInBackend: secretsConfig.storePlaintextInBackend,
  });
  if (args.options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          backend: secretsConfig.backend,
          allow_env_auth_refs: secretsConfig.allowEnvAuthRefs,
          store_plaintext_in_backend: secretsConfig.storePlaintextInBackend,
          encrypted_file: secretsConfig.encryptedFile,
          encrypted_file_key_env: ENCRYPTED_FILE_KEY_ENV,
          cloud: secretsConfig.cloud,
          status: {
            storage_mode: backendStatus.storageMode,
            trust_model: backendStatus.trustModel,
            portability: backendStatus.portability,
            plaintext_compatibility: backendStatus.plaintextCompatibility,
            classification: serializeEnvClassificationForJson({
              classification: backendStatus.classification,
            }),
          },
        },
        null,
        2
      )}\n`
    );
    return 0;
  }

  await display.kv({
    title: "Env/secret backend strategy",
    entries: [
      ["backend", secretsConfig.backend],
      [
        "allow_env_auth_refs",
        secretsConfig.allowEnvAuthRefs ? "true" : "false",
      ],
      [
        "store_plaintext_in_backend",
        secretsConfig.storePlaintextInBackend ? "true" : "false",
      ],
      ["encrypted_file_path", secretsConfig.encryptedFile.path],
      ["encrypted_file_key_path", secretsConfig.encryptedFile.keyPath],
      ["encrypted_file_key_env", ENCRYPTED_FILE_KEY_ENV],
      ["cloud_provider", secretsConfig.cloud.provider ?? ""],
      ["cloud_project", secretsConfig.cloud.project ?? ""],
      ["cloud_secret_prefix", secretsConfig.cloud.secretPrefix],
      ["storage_mode", backendStatus.storageMode],
      ["trust_model", backendStatus.trustModel],
      ["portability", backendStatus.portability],
      ["plaintext_compatibility", backendStatus.plaintextCompatibility],
    ],
  });
  return 0;
};

const handleEnvBackendUse: CommandHandlerFor<typeof backendUseSpec> = async ({
  args,
}): Promise<number> => {
  const backend = args.positionals.backend.trim();
  if (!isSecretBackend(backend)) {
    throw new CliUsageError(
      `Invalid backend "${backend}". Expected one of: ${SECRET_BACKEND_VALUES.join(", ")}`
    );
  }

  const providerRaw = args.options.provider?.trim();
  if (providerRaw && !isCloudProvider(providerRaw)) {
    throw new CliUsageError(
      `Invalid --provider "${providerRaw}". Expected one of: ${CLOUD_PROVIDER_VALUES.join(", ")}`
    );
  }

  if (backend === "cloud" && !providerRaw) {
    throw new CliUsageError(
      "Cloud backend requires --provider <aws|gcp|azure|vault>."
    );
  }

  await persistBackendSelection({
    backend,
    storePath: args.options.storePath?.trim() || undefined,
    keyPath: args.options.keyPath?.trim() || undefined,
    provider: providerRaw,
    secretProject: args.options.secretProject?.trim() || undefined,
    secretPrefix: args.options.secretPrefix?.trim() || undefined,
  });

  const controlPlane = await readControlPlaneConfig({});
  const secretsConfig = controlPlane.config.secrets;
  let provisionedKey: {
    readonly keyPath: string;
    readonly source: "env" | "file" | "keychain" | "generated";
  } | null = null;
  if (backend === "encrypted_file" && args.options.provisionKey) {
    provisionedKey = await provisionEncryptedFileKey({
      keyPath: secretsConfig.encryptedFile.keyPath,
      storePath: secretsConfig.encryptedFile.path,
    });
  }
  if (args.options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          backend: secretsConfig.backend,
          allow_env_auth_refs: secretsConfig.allowEnvAuthRefs,
          store_plaintext_in_backend: secretsConfig.storePlaintextInBackend,
          encrypted_file: secretsConfig.encryptedFile,
          encrypted_file_key_env: ENCRYPTED_FILE_KEY_ENV,
          encrypted_file_key_provisioned: provisionedKey,
          cloud: secretsConfig.cloud,
        },
        null,
        2
      )}\n`
    );
    return 0;
  }

  await display.kv({
    title: "Env/secret backend updated",
    entries: [
      ["backend", secretsConfig.backend],
      ["encrypted_file_path", secretsConfig.encryptedFile.path],
      ["encrypted_file_key_path", secretsConfig.encryptedFile.keyPath],
      ["encrypted_file_key_env", ENCRYPTED_FILE_KEY_ENV],
      ["encrypted_file_key_source", provisionedKey?.source ?? ""],
      ["cloud_provider", secretsConfig.cloud.provider ?? ""],
      ["cloud_project", secretsConfig.cloud.project ?? ""],
      ["cloud_secret_prefix", secretsConfig.cloud.secretPrefix],
    ],
  });
  if (backend === "encrypted_file") {
    logger.info({
      message: provisionedKey
        ? `Provisioned stable encrypted backend key at ${provisionedKey.keyPath} (${provisionedKey.source}).`
        : `Set ${ENCRYPTED_FILE_KEY_ENV} or provision ${secretsConfig.encryptedFile.keyPath} to avoid repeated macOS keychain prompts for encrypted file backend key access.`,
    });
  } else {
    logger.info({
      message:
        "Secret writes now use the configured backend for keychain-sourced env values.",
    });
  }
  return 0;
};

function parseKeyValueSpec(spec: string): readonly [string, string | null] {
  const trimmed = spec.trim();
  if (trimmed.length === 0) {
    return ["", null];
  }

  const idx = trimmed.indexOf("=");
  if (idx === -1) {
    return [trimmed, null];
  }

  const key = trimmed.slice(0, idx).trim();
  const value = trimmed.slice(idx + 1);
  return [key, value];
}

async function resolveEnvKey(opts: { readonly key: string }): Promise<string> {
  const fromPos = opts.key.trim();
  if (fromPos.length > 0) {
    if (!ENV_KEY_PATTERN.test(fromPos)) {
      throw new CliUsageError(`Invalid env key: ${fromPos}`);
    }
    return fromPos;
  }

  const key = await text({
    message: "Env key:",
    validate: (value) => {
      const v = value?.trim();
      if (!v) {
        return "Required";
      }
      if (!ENV_KEY_PATTERN.test(v)) {
        return "Use uppercase snake-case (e.g. AWS_PROFILE)";
      }
      return undefined;
    },
  });
  if (isCancel(key)) {
    throw new Error("Canceled");
  }
  return key.trim();
}

async function resolveEnvValue(opts: {
  readonly key: string;
  readonly value: string | null;
  readonly secret: boolean;
}): Promise<string> {
  const fromSpec = opts.value;
  if (typeof fromSpec === "string" && fromSpec.length > 0) {
    return fromSpec;
  }

  if (opts.secret) {
    const v = await password({
      message: `Value for secret "${opts.key}":`,
      validate: (value) =>
        !value || value.length === 0 ? "Required" : undefined,
    });
    if (isCancel(v)) {
      throw new Error("Canceled");
    }
    return v;
  }

  const v = await text({
    message: `Value for "${opts.key}":`,
    validate: (value) =>
      !value || value.length === 0 ? "Required" : undefined,
  });
  if (isCancel(v)) {
    throw new Error("Canceled");
  }
  return v;
}

export const envCommand = defineCommand({
  name: "env",
  summary: "Set project env vars and local secrets",
  group: "Integrations",
  expandInRootHelp: true,
  options: [],
  positionals: [],
  subcommands: [
    withHandler(listSpec, handleEnvList),
    withHandler(setSpec, handleEnvSet),
    withHandler(unsetSpec, handleEnvUnset),
    withHandler(
      defineCommand({
        ...backendSpec,
        subcommands: [
          withHandler(backendStatusSpec, handleEnvBackendStatus),
          withHandler(backendUseSpec, handleEnvBackendUse),
        ],
      } as const),
      async () => {
        await display.panel({
          title: "Env backend commands",
          tone: "info",
          lines: [
            "hack env backend status [--json]",
            "hack env backend use <keychain|encrypted_file|cloud> [--store-path <path>] [--provider <aws|gcp|azure|vault>] [--secret-project <id>] [--secret-prefix <prefix>]",
          ],
        });
        return 0;
      }
    ),
  ],
} as const);
