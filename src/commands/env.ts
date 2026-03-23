import { resolve } from "node:path";
import { confirm, isCancel, password, text } from "@clack/prompts";

import type { CliContext, CommandHandlerFor } from "../cli/command.ts";
import {
  CliUsageError,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";
import { optJson, optPath, optProject } from "../cli/options.ts";
import { PROJECT_ENV_FILENAME } from "../constants.ts";
import { readControlPlaneConfig } from "../control-plane/sdk/config.ts";
import { updateGlobalConfig } from "../lib/config.ts";
import type { HackEnvStorageSummary } from "../lib/hack-env.ts";
import {
  removeDotEnvKey,
  resolveHackEnv,
  upsertDotEnvValue,
} from "../lib/hack-env.ts";
import type { ProjectContext } from "../lib/project.ts";
import {
  defaultProjectSlugFromPath,
  findProjectContext,
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
  options: [optPath, optProject, optJson, optShowSecrets],
  positionals: [],
  subcommands: [],
} as const);

const setSpec = defineCommand({
  name: "set",
  summary: "Set an env value (.hack/.env or keychain)",
  group: "Project",
  options: [optPath, optProject, optSecret],
  positionals: [{ name: "spec", required: false }],
  subcommands: [],
} as const);

const unsetSpec = defineCommand({
  name: "unset",
  summary: "Unset an env value (.hack/.env and keychain)",
  group: "Project",
  options: [optPath, optProject],
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

  const resolved = await resolveHackEnv({
    projectDir: project.projectDir,
    projectName,
  });

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          project: projectName,
          storage: serializeEnvStorageForJson({ storage: resolved.storage }),
          vars: resolved.values.map((v) => ({
            key: v.key,
            required: v.required,
            source: v.source,
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
        "contract",
        `${resolved.storage.contract.path} (committed contract, no values)`,
      ],
      [
        "local_plaintext",
        `${resolved.storage.localPlaintext.path} (${resolved.storage.localPlaintext.exists ? "present" : "missing"} plaintext file for plain_env, gitignore not enforced)`,
      ],
      [
        "local_fallback",
        `${resolved.storage.localPlaintext.fallback.source} (used when .env does not provide a plain_env value)`,
      ],
      [
        "local_secrets",
        `${formatSecretStoreDescriptor({ descriptor: resolved.storage.localSecrets })} (${resolved.storage.localSecrets.mode === "shim" ? "local secret backend shim" : "local secret backend"})`,
      ],
      [
        "portable_state",
        `${resolved.storage.portableState.status}: ${resolved.storage.portableState.message}`,
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
    const from = v.resolvedFrom ?? "missing";
    const services = v.services ? v.services.join(",") : "*";
    process.stdout.write(
      `${v.key}\t${required}\t${v.source}\t${from}\t${services}\t${value}\n`
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
  return {
    contract: {
      path: input.storage.contract.path,
      trust_model: input.storage.contract.trustModel,
    },
    local_plaintext: {
      path: input.storage.localPlaintext.path,
      exists: input.storage.localPlaintext.exists,
      trust_model: input.storage.localPlaintext.trustModel,
      fallback: {
        enabled: input.storage.localPlaintext.fallback.enabled,
        source: input.storage.localPlaintext.fallback.source,
        trust_model: input.storage.localPlaintext.fallback.trustModel,
      },
    },
    local_secrets: {
      backend: input.storage.localSecrets.backend,
      location: input.storage.localSecrets.location,
      mode: input.storage.localSecrets.mode,
      provider: input.storage.localSecrets.provider ?? null,
      trust_model: input.storage.localSecrets.trustModel,
    },
    portable_state: {
      status: input.storage.portableState.status,
      trust_model: input.storage.portableState.trustModel,
      message: input.storage.portableState.message,
    },
  };
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
    await store.set({ key, value });
    logger.success({
      message: `Stored secret "${key}" in ${formatSecretStoreDescriptor({ descriptor: store.descriptor })}`,
    });
    return 0;
  }

  const envFile = resolve(project.projectDir, PROJECT_ENV_FILENAME);
  const result = await upsertDotEnvValue({ envFile, key, value });
  logger.success({
    message: result.changed ? `Updated ${envFile}` : "No changes needed.",
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

  const key = await resolveEnvKey({ key: (args.positionals.key ?? "").trim() });

  const ok = await confirm({
    message: `Unset "${key}" from ${project.projectDir}/.env and ${formatSecretStoreDescriptor({ descriptor: store.descriptor })}?`,
    initialValue: true,
  });
  if (isCancel(ok)) {
    return 1;
  }
  if (!ok) {
    return 0;
  }

  const envFile = resolve(project.projectDir, PROJECT_ENV_FILENAME);
  const [dotenvResult, secretDeleted] = await Promise.all([
    removeDotEnvKey({ envFile, key }),
    store.delete({ key }),
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
> = async ({ args }): Promise<number> => {
  const controlPlane = await readControlPlaneConfig({});
  const secretsConfig = controlPlane.config.secrets;
  if (args.options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          backend: secretsConfig.backend,
          allow_env_auth_refs: secretsConfig.allowEnvAuthRefs,
          encrypted_file: secretsConfig.encryptedFile,
          encrypted_file_key_env: ENCRYPTED_FILE_KEY_ENV,
          cloud: secretsConfig.cloud,
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
      ["encrypted_file_path", secretsConfig.encryptedFile.path],
      ["encrypted_file_key_path", secretsConfig.encryptedFile.keyPath],
      ["encrypted_file_key_env", ENCRYPTED_FILE_KEY_ENV],
      ["cloud_provider", secretsConfig.cloud.provider ?? ""],
      ["cloud_project", secretsConfig.cloud.project ?? ""],
      ["cloud_secret_prefix", secretsConfig.cloud.secretPrefix],
    ],
  });
  return 0;
};

const handleEnvBackendUse: CommandHandlerFor<typeof backendUseSpec> = async ({
  args,
}): Promise<number> => {
  const backend = args.positionals.backend.trim();
  if (
    !SECRET_BACKEND_VALUES.includes(
      backend as (typeof SECRET_BACKEND_VALUES)[number]
    )
  ) {
    throw new CliUsageError(
      `Invalid backend "${backend}". Expected one of: ${SECRET_BACKEND_VALUES.join(", ")}`
    );
  }

  const providerRaw = args.options.provider?.trim();
  if (
    providerRaw &&
    !CLOUD_PROVIDER_VALUES.includes(
      providerRaw as (typeof CLOUD_PROVIDER_VALUES)[number]
    )
  ) {
    throw new CliUsageError(
      `Invalid --provider "${providerRaw}". Expected one of: ${CLOUD_PROVIDER_VALUES.join(", ")}`
    );
  }

  await updateGlobalConfig({
    path: "controlPlane.secrets.backend",
    value: backend,
  });

  if (backend === "encrypted_file" && args.options.storePath?.trim()) {
    await updateGlobalConfig({
      path: "controlPlane.secrets.encryptedFile.path",
      value: args.options.storePath.trim(),
    });
  }

  if (backend === "encrypted_file" && args.options.keyPath?.trim()) {
    await updateGlobalConfig({
      path: "controlPlane.secrets.encryptedFile.keyPath",
      value: args.options.keyPath.trim(),
    });
  }

  if (backend === "cloud") {
    if (!providerRaw) {
      throw new CliUsageError(
        "Cloud backend requires --provider <aws|gcp|azure|vault>."
      );
    }
    await updateGlobalConfig({
      path: "controlPlane.secrets.cloud.provider",
      value: providerRaw,
    });
    if (args.options.secretProject?.trim()) {
      await updateGlobalConfig({
        path: "controlPlane.secrets.cloud.project",
        value: args.options.secretProject.trim(),
      });
    }
    if (args.options.secretPrefix?.trim()) {
      await updateGlobalConfig({
        path: "controlPlane.secrets.cloud.secretPrefix",
        value: args.options.secretPrefix.trim(),
      });
    }
  }

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
