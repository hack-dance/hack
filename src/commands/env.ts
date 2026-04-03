import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { confirm, isCancel, password, select, text } from "@clack/prompts";

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
import { resolveGlobalConfigPath } from "../lib/config-paths.ts";
import { isRecord } from "../lib/guards.ts";
import type {
  HackEnvStorageSummary,
  HackEnvValueState,
} from "../lib/hack-env.ts";
import {
  readHackEnvContract,
  readHackEnvRuntimeConfig,
  removeDotEnvKey,
  resolveEnvFilePath,
  resolveEnvSecretKey,
  resolveHackEnv,
  selectHackEnvValues,
  upsertDotEnvValue,
  validateHackEnvMutationSource,
} from "../lib/hack-env.ts";
import {
  describeBackendStrategyStatus,
  describeEnvAggregateStatusForJson,
  describeValueStorageForJson as describeValueStorageForJsonShape,
  serializeEnvClassificationForJson,
  serializeEnvStorageForJson as serializeEnvStorageForJsonShape,
} from "../lib/hack-env-status.ts";
import { appendHackHostTrustEnvironment } from "../lib/local-ca.ts";
import type { ProjectContext } from "../lib/project.ts";
import {
  defaultProjectSlugFromPath,
  findProjectContext,
  parseEnvConfigSelection,
  readProjectConfig,
  sanitizeProjectSlug,
} from "../lib/project.ts";
import {
  assertValidProjectEnvScopeName,
  discoverComposeServiceNames,
  materializeProjectEnv,
  migrateLegacyProjectEnv,
  parseProjectEnvTarget,
  projectEnvConfigExists,
  readMaterializedProjectEnv,
  resolveProjectEnvConfig,
  selectProjectEnvValues,
  selectProjectEnvValuesForExecutionTarget,
  setProjectEnvValue,
  unsetProjectEnvValue,
} from "../lib/project-env-config.ts";
import { resolveRegisteredProjectByName } from "../lib/projects-registry.ts";
import {
  formatSecretStoreDescriptor,
  provisionEncryptedFileKey,
  resolveSecretStore,
} from "../lib/secret-store.ts";
import { run } from "../lib/shell.ts";
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
  description: "Store value as an encrypted secure entry",
} as const);

const DEFAULT_ENCRYPTED_FILE_STORE_PATH = "~/.hack/secrets.enc.json";
const DEFAULT_ENCRYPTED_FILE_KEY_PATH = "~/.hack/secrets-file.key";
const LEGACY_RELATIVE_ENCRYPTED_FILE_STORE_PATH = ".hack-secrets.enc.json";
const LEGACY_RELATIVE_ENCRYPTED_FILE_KEY_PATH = ".hack-secrets-file.key";
const HOST_ENV_TARGET_VALUES = ["host", "compose"] as const;
const HOST_LOOPBACK = "127.0.0.1";
const CONTAINER_ONLY_HOSTS = new Set(["host.docker.internal", "host-gateway"]);
const HOST_KEY_PATTERN = /(?:^|_)?(HOST|HOSTNAME)$/;
const URL_LIKE_KEY_PATTERN = /(?:^DATABASE_URL$|(?:^|_)(URL|URI|DSN)$)/;
const URL_LIKE_VALUE_PATTERN =
  /^(?<prefix>[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]+@)?)(?<host>[^:/?#]+)(?<suffix>.*)$/i;

const optService = defineOption({
  name: "service",
  type: "string",
  long: "--service",
  valueHint: "<global|service>",
  description: "Target scope (global or a discovered service name)",
} as const);

const optScope = defineOption({
  name: "scope",
  type: "string",
  long: "--scope",
  valueHint: "<global|service>",
  description:
    "Resolve values for one env scope while still running the command on the host",
} as const);

const optTarget = defineOption({
  name: "target",
  type: "string",
  long: "--target",
  valueHint: "<host|compose>",
  description:
    "Env view for host commands (default: host rewrites container-oriented addresses for local host execution)",
} as const);

const optShellCommand = defineOption({
  name: "shellCommand",
  type: "string",
  long: "--shell",
  valueHint: "<command>",
  description:
    "Run a shell command string via /bin/sh -lc after env injection so `$VAR` expansion happens inside the child shell",
} as const);

const SECRET_MASK = "***";
const MODERN_ENV_STATUS_CLASSIFICATION = {
  trust_model: "repo_managed_env_config",
  custody: "repo_tracked_env_config",
  portability: "portable_with_out_of_band_key",
  shared_state: "repo_managed_overlay",
} as const;
const MODERN_LOCAL_PLAINTEXT_CLASSIFICATION = {
  trust_model: "compatibility_output",
  custody: "local_plaintext_file",
  portability: "local_only",
  shared_state: "compatibility_only",
} as const;
const MODERN_LOCAL_SECRET_CLASSIFICATION = {
  trust_model: "local_secret_key",
  custody: "local_secret_key",
  portability: "local_only",
  shared_state: "local_only",
} as const;

const listSpec = defineCommand({
  name: "list",
  summary: "List resolved env values for the selected overlay",
  group: "Project",
  options: [optPath, optProject, optEnv, optJson, optShowSecrets, optService],
  positionals: [],
  subcommands: [],
} as const);

const addSpec = defineCommand({
  name: "add",
  summary: "Add or update an env value",
  group: "Project",
  options: [optPath, optProject, optEnv, optSecret, optService],
  positionals: [
    { name: "key", required: false },
    { name: "value", required: false },
  ],
  subcommands: [],
} as const);

const setSpec = defineCommand({
  name: "set",
  summary: "Alias for env add",
  group: "Project",
  options: [optPath, optProject, optEnv, optSecret, optService],
  positionals: [
    { name: "key", required: false },
    { name: "value", required: false },
  ],
  subcommands: [],
} as const);

const materializeSpec = defineCommand({
  name: "materialize",
  summary: "Write a compatibility .env file from the selected overlay",
  group: "Project",
  options: [optPath, optProject, optEnv, optService],
  positionals: [],
  subcommands: [],
} as const);

const execSpec = defineCommand({
  name: "exec",
  summary: "Run a host command with project env injected",
  group: "Project",
  description:
    'Inject the selected Hack env overlay directly into a one-off host command without materializing .hack/.env. To inspect a value, prefer `printenv KEY` or `sh -lc \'printf "%s\\n" "$KEY"\'`; `echo $KEY` expands in your current shell before Hack injects env.',
  options: [
    optPath,
    optProject,
    optEnv,
    optService,
    optTarget,
    optShellCommand,
  ],
  positionals: [{ name: "command", required: false, multiple: true }],
  subcommands: [],
} as const);

const shellSpec = defineCommand({
  name: "shell",
  summary: "Open a host shell with project env injected",
  group: "Project",
  description:
    "Start an interactive host shell with the selected Hack env overlay injected into the process environment.",
  options: [optPath, optProject, optEnv, optService, optTarget],
  positionals: [],
  subcommands: [],
} as const);

const hostExecSpec = defineCommand({
  name: "exec",
  summary: "Run a host command with project env injected",
  group: "Project",
  description:
    'Run a one-off command on the host with the selected Hack env overlay injected. Use --scope when you want service-scoped values without running inside that service container. To inspect a value, prefer `printenv KEY` or `sh -lc \'printf "%s\\n" "$KEY"\'`; `echo $KEY` expands in your current shell before Hack injects env.',
  options: [optPath, optProject, optEnv, optScope, optTarget, optShellCommand],
  positionals: [{ name: "command", required: false, multiple: true }],
  subcommands: [],
} as const);

const hostShellSpec = defineCommand({
  name: "shell",
  summary: "Open a host shell with project env injected",
  group: "Project",
  description:
    "Start an interactive host shell with the selected Hack env overlay injected. Use --scope when you want service-scoped values without running inside that service container.",
  options: [optPath, optProject, optEnv, optScope, optTarget],
  positionals: [],
  subcommands: [],
} as const);

const unsetSpec = defineCommand({
  name: "unset",
  summary: "Remove an env value from the canonical config",
  group: "Project",
  options: [optPath, optProject, optEnv, optService],
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
      value: normalizeGlobalEncryptedFileConfigPath({
        configuredPath: input.storePath,
        defaultPath: DEFAULT_ENCRYPTED_FILE_STORE_PATH,
        legacyRelativePath: LEGACY_RELATIVE_ENCRYPTED_FILE_STORE_PATH,
      }),
    });
  }

  if (input.backend === "encrypted_file" && input.keyPath) {
    await updateGlobalConfig({
      path: "controlPlane.secrets.encryptedFile.keyPath",
      value: normalizeGlobalEncryptedFileConfigPath({
        configuredPath: input.keyPath,
        defaultPath: DEFAULT_ENCRYPTED_FILE_KEY_PATH,
        legacyRelativePath: LEGACY_RELATIVE_ENCRYPTED_FILE_KEY_PATH,
      }),
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

function normalizeGlobalEncryptedFileConfigPath(input: {
  readonly configuredPath: string;
  readonly defaultPath: string;
  readonly legacyRelativePath: string;
}): string {
  const raw = input.configuredPath.trim();
  if (raw.length === 0) {
    return raw;
  }
  if (raw === input.legacyRelativePath) {
    return input.defaultPath;
  }
  if (raw === "~" || raw.startsWith("~/") || raw.startsWith("/")) {
    return raw;
  }

  const home = (process.env.HOME ?? homedir()).trim();
  const globalConfigDir = dirname(resolveGlobalConfigPath());
  const resolvedPath = resolve(globalConfigDir, raw);
  if (home.length > 0 && resolvedPath.startsWith(`${home}/`)) {
    return `~/${relative(home, resolvedPath)}`;
  }
  return resolvedPath;
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

async function loadModernProjectEnv(input: {
  readonly project: ProjectContext;
  readonly envName: string | null | undefined;
}): Promise<Awaited<ReturnType<typeof resolveProjectEnvConfig>>> {
  const serviceNames = await discoverComposeServiceNames({
    composeFile: input.project.composeFile,
  });
  return await resolveProjectEnvConfig({
    projectRoot: input.project.projectRoot,
    projectDir: input.project.projectDir,
    envName: input.envName,
    serviceNames,
  });
}

async function resolveEnvInjection(input: {
  readonly project: ProjectContext;
  readonly projectName: string;
  readonly envName: string | null | undefined;
  readonly serviceName: string | null;
  readonly target: (typeof HOST_ENV_TARGET_VALUES)[number];
}): Promise<{
  readonly env: Record<string, string>;
  readonly effectiveEnvName: string | null;
}> {
  await maybeMigrateLegacyProjectEnv({
    project: input.project,
    projectName: input.projectName,
    reason: "runtime",
  });

  const modern = await loadModernProjectEnv({
    project: input.project,
    envName: input.envName,
  });
  if (modern) {
    const serviceNames = await discoverComposeServiceNames({
      composeFile: input.project.composeFile,
    });
    const env = selectProjectEnvValuesForExecutionTarget({
      resolved: modern,
      scopeName: input.serviceName,
      target: input.target,
    });
    return {
      env: await adaptEnvForHostExecution({
        env,
        target: input.target,
        serviceNames,
      }),
      effectiveEnvName: modern.selection.effectiveEnv,
    };
  }

  const resolved = await loadResolvedEnvState({
    projectDir: input.project.projectDir,
    projectName: input.projectName,
    envName: input.envName,
  });
  if (!resolved) {
    throw new CliUsageError("Unable to resolve project env state.");
  }

  const serviceNames = await discoverComposeServiceNames({
    composeFile: input.project.composeFile,
  });
  return {
    env: await adaptEnvForHostExecution({
      env: selectHackEnvValues({
        resolved,
        serviceName: input.serviceName,
      }),
      target: input.target,
      serviceNames,
    }),
    effectiveEnvName: resolved.envSelection.effectiveEnv,
  };
}

function resolveHostEnvTarget(input: {
  readonly targetOption: string | undefined;
}): (typeof HOST_ENV_TARGET_VALUES)[number] {
  const target = input.targetOption?.trim() || "host";
  if (
    HOST_ENV_TARGET_VALUES.includes(
      target as (typeof HOST_ENV_TARGET_VALUES)[number]
    )
  ) {
    return target as (typeof HOST_ENV_TARGET_VALUES)[number];
  }
  throw new CliUsageError(
    `Invalid --target "${target}". Expected one of: ${HOST_ENV_TARGET_VALUES.join(", ")}`
  );
}

function adaptEnvForHostExecution(input: {
  readonly env: Readonly<Record<string, string>>;
  readonly target: (typeof HOST_ENV_TARGET_VALUES)[number];
  readonly serviceNames: readonly string[];
}): Promise<Record<string, string>> {
  if (input.target !== "host") {
    return Promise.resolve({ ...input.env });
  }

  const composeServiceNames = new Set(input.serviceNames);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.env)) {
    out[key] = rewriteEnvValueForHostExecution({
      key,
      value,
      composeServiceNames,
    });
  }
  return appendHackHostTrustEnvironment(out);
}

function rewriteEnvValueForHostExecution(input: {
  readonly key: string;
  readonly value: string;
  readonly composeServiceNames: ReadonlySet<string>;
}): string {
  const trimmedValue = input.value.trim();
  if (HOST_KEY_PATTERN.test(input.key)) {
    const rewrittenHost = rewriteHostTokenForHostExecution({
      value: trimmedValue,
      composeServiceNames: input.composeServiceNames,
    });
    if (rewrittenHost) {
      return rewrittenHost;
    }
  }

  if (URL_LIKE_KEY_PATTERN.test(input.key)) {
    const rewrittenUrl = rewriteUrlLikeValueForHostExecution({
      value: input.value,
      composeServiceNames: input.composeServiceNames,
    });
    if (rewrittenUrl) {
      return rewrittenUrl;
    }
  }

  return input.value;
}

function rewriteHostTokenForHostExecution(input: {
  readonly value: string;
  readonly composeServiceNames: ReadonlySet<string>;
}): string | null {
  if (CONTAINER_ONLY_HOSTS.has(input.value)) {
    return HOST_LOOPBACK;
  }
  if (input.composeServiceNames.has(input.value)) {
    return HOST_LOOPBACK;
  }
  return null;
}

function rewriteUrlLikeValueForHostExecution(input: {
  readonly value: string;
  readonly composeServiceNames: ReadonlySet<string>;
}): string | null {
  const match = URL_LIKE_VALUE_PATTERN.exec(input.value);
  const host = match?.groups?.host;
  const prefix = match?.groups?.prefix;
  const suffix = match?.groups?.suffix;
  if (!(host && prefix && suffix !== undefined)) {
    return null;
  }

  const rewrittenHost = rewriteHostTokenForHostExecution({
    value: host,
    composeServiceNames: input.composeServiceNames,
  });
  if (!rewrittenHost) {
    return null;
  }
  return `${prefix}${rewrittenHost}${suffix}`;
}

async function maybeMigrateLegacyProjectEnv(input: {
  readonly project: ProjectContext;
  readonly projectName: string;
  readonly reason: "mutation" | "runtime";
}): Promise<boolean> {
  if (
    await projectEnvConfigExists({
      projectDir: input.project.projectDir,
    })
  ) {
    return false;
  }

  const contract = await readHackEnvContract({
    projectDir: input.project.projectDir,
  });
  if (!contract.exists) {
    return false;
  }

  const serviceNames = await discoverComposeServiceNames({
    composeFile: input.project.composeFile,
  });

  if (
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    input.reason === "runtime"
  ) {
    const ok = await confirm({
      message:
        "Legacy env format detected. Migrate to the new Hack env config files now?",
      initialValue: true,
    });
    if (isCancel(ok)) {
      throw new CliUsageError("Canceled.");
    }
    if (!ok) {
      return false;
    }
  }

  const migrated = await migrateLegacyProjectEnv({
    projectRoot: input.project.projectRoot,
    projectDir: input.project.projectDir,
    projectName: input.projectName,
    serviceNames,
    materialize: false,
  });
  if (migrated.legacyDetected && migrated.wroteFiles.length > 0) {
    logger.info({
      message: `Migrated legacy env config to ${migrated.wroteFiles.join(", ")}`,
    });
  }
  return migrated.legacyDetected;
}

async function promptForEnvAddInput(input: {
  readonly project: ProjectContext;
  readonly envName: string | null | undefined;
}): Promise<{
  readonly secret: boolean;
  readonly scope: string;
  readonly key: string;
  readonly value: string;
}> {
  const secretChoice = await select({
    message: "Value kind:",
    options: [
      { label: "Plaintext", value: "plain" },
      { label: "Secret", value: "secret" },
    ],
  });
  if (isCancel(secretChoice)) {
    throw new CliUsageError("Canceled.");
  }

  const serviceNames = await discoverComposeServiceNames({
    composeFile: input.project.composeFile,
  });
  const scopeChoice = await select({
    message: "Target scope:",
    options: [
      { label: "global", value: "global" },
      ...serviceNames.map((service) => ({
        label: service,
        value: service,
      })),
      { label: "custom scope", value: "__custom__" },
    ],
  });
  if (isCancel(scopeChoice)) {
    throw new CliUsageError("Canceled.");
  }

  let scope = scopeChoice;
  if (scopeChoice === "__custom__") {
    const customScope = await text({
      message: "Custom scope name:",
      validate: (value) =>
        (value?.trim().length ?? 0) > 0 ? undefined : "Required",
    });
    if (isCancel(customScope)) {
      throw new CliUsageError("Canceled.");
    }
    scope = customScope.trim();
  }

  const key = await text({
    message: "Env key:",
    validate: (value) =>
      ENV_KEY_PATTERN.test(value?.trim() ?? "") ? undefined : "Invalid env key",
  });
  if (isCancel(key)) {
    throw new CliUsageError("Canceled.");
  }

  const valuePrompt =
    secretChoice === "secret"
      ? await password({
          message: "Secret value:",
          validate: (value) =>
            (value?.trim().length ?? 0) > 0 ? undefined : "Required",
        })
      : await text({
          message: "Value:",
          validate: (value) =>
            (value?.trim().length ?? 0) > 0 ? undefined : "Required",
        });
  if (isCancel(valuePrompt)) {
    throw new CliUsageError("Canceled.");
  }

  return {
    secret: secretChoice === "secret",
    scope,
    key: key.trim(),
    value: valuePrompt,
  };
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

  const modern = await loadModernProjectEnv({
    project,
    envName,
  });
  if (modern) {
    const selectedScope = (() => {
      try {
        return assertValidProjectEnvScopeName({
          scopeName: args.options.service,
        });
      } catch (error: unknown) {
        throw new CliUsageError(
          error instanceof Error ? error.message : "Invalid env scope."
        );
      }
    })();
    const envValues = selectProjectEnvValues({
      resolved: modern,
      scopeName: selectedScope,
    });
    const materialized = await readMaterializedProjectEnv({
      projectDir: project.projectDir,
    });
    const materializedExists = Object.keys(materialized).length > 0;
    if (json) {
      process.stdout.write(
        `${JSON.stringify(
          buildModernEnvJsonPayload({
            project,
            projectName,
            modern,
            selectedScope,
            envValues,
            showSecrets,
            materialized,
            materializedExists,
          }),
          null,
          2
        )}\n`
      );
      return 0;
    }

    await display.kv({
      title: "Env config",
      entries: [
        [
          "env_selection",
          modern.selection.effectiveEnv ?? "default (base only)",
        ],
        ["selected_scope", selectedScope],
        ["files", modern.files.join(", ")],
        [
          "unknown_scopes",
          modern.unknownScopes.length > 0
            ? modern.unknownScopes.join(", ")
            : "none",
        ],
      ],
    });
    await display.section("Resolved env vars");
    for (const [key, value] of Object.entries(envValues)) {
      process.stdout.write(
        `${key}\t${selectedScope}\t${maskModernEnvValue({
          modern,
          scope: selectedScope,
          key,
          value,
          showSecrets,
        })}\n`
      );
    }
    return 0;
  }

  const resolved = await loadResolvedEnvState({
    projectDir: project.projectDir,
    projectName,
    envName,
  });
  if (resolved === null) {
    return 1;
  }

  if (json) {
    writeEnvListJson({
      projectName,
      resolved,
      showSecrets,
    });
    return resolved.missingRequired.length > 0 ? 1 : 0;
  }

  return await renderEnvListDisplay({
    resolved,
    projectDir: project.projectDir,
    showSecrets,
  });
};

function maskModernEnvValue(input: {
  readonly modern: NonNullable<
    Awaited<ReturnType<typeof loadModernProjectEnv>>
  >;
  readonly scope: string;
  readonly key: string;
  readonly value: string;
  readonly showSecrets: boolean;
}): string {
  if (input.showSecrets) {
    return input.value;
  }
  if (
    isModernSecretAtScope({
      modern: input.modern,
      scope: input.scope,
      key: input.key,
    })
  ) {
    return SECRET_MASK;
  }
  return input.value;
}

function isModernSecretAtScope(input: {
  readonly modern: NonNullable<
    Awaited<ReturnType<typeof loadModernProjectEnv>>
  >;
  readonly scope: string;
  readonly key: string;
}): boolean {
  const scopedValue =
    input.scope === "global"
      ? undefined
      : input.modern.merged.values[input.scope]?.[input.key];
  if (scopedValue !== undefined) {
    return isModernSecretStoredValue(scopedValue);
  }
  const globalValue = input.modern.merged.values.global?.[input.key];
  return globalValue !== undefined && isModernSecretStoredValue(globalValue);
}

function isModernSecretStoredValue(value: unknown): boolean {
  return isRecord(value) && typeof value.secure === "string";
}

function buildModernEnvJsonPayload(input: {
  readonly project: ProjectContext;
  readonly projectName: string;
  readonly modern: NonNullable<
    Awaited<ReturnType<typeof loadModernProjectEnv>>
  >;
  readonly selectedScope: string;
  readonly envValues: Readonly<Record<string, string>>;
  readonly showSecrets: boolean;
  readonly materialized: Record<string, string>;
  readonly materializedExists: boolean;
}) {
  return {
    project: input.projectName,
    env_selection: {
      requested: input.modern.selection.requestedEnv,
      default: input.modern.selection.defaultEnv,
      effective: input.modern.selection.effectiveEnv,
      overlay_path: input.modern.selection.overlayPath,
      overlay_exists: input.modern.selection.overlayExists,
    },
    format: "project_env_config_v1",
    status: {
      ...MODERN_ENV_STATUS_CLASSIFICATION,
      summary: "Project env config overlays",
      detail:
        "Hack is reading canonical .hack/hack.env.default.yaml and optional .hack/hack.env.<overlay>.yaml files directly. Runtime injection is the default path; .hack/.env is only a manual compatibility output.",
    },
    storage: {
      local_plaintext: {
        path: input.project.envFile,
        exists: input.materializedExists,
        trust_model: MODERN_LOCAL_PLAINTEXT_CLASSIFICATION.trust_model,
        mirrored_to_backend: false,
        fallback: {
          enabled: false,
          source: "none",
          trust_model: "none",
          classification: MODERN_LOCAL_PLAINTEXT_CLASSIFICATION,
        },
        classification: MODERN_LOCAL_PLAINTEXT_CLASSIFICATION,
      },
      local_secrets: {
        backend: "project_key",
        location: `${resolve(input.project.projectRoot, ".hack.secret.key")} or HACK_ENV_SECRET_KEY`,
        mode: "file_or_env",
        provider: null,
        trust_model: MODERN_LOCAL_SECRET_CLASSIFICATION.trust_model,
        classification: MODERN_LOCAL_SECRET_CLASSIFICATION,
      },
      portable_state: {
        status: "repo_overlay_files",
        trust_model: MODERN_ENV_STATUS_CLASSIFICATION.trust_model,
        message:
          "Canonical values live in .hack/hack.env.default.yaml and optional overlay files. Share the decryption key out of band with .hack.secret.key or HACK_ENV_SECRET_KEY.",
        classification: MODERN_ENV_STATUS_CLASSIFICATION,
      },
      compatibility_mode: {
        plaintext_target: input.project.envFile,
        secret_backend: "project_key",
        plaintext_mirrored_to_backend: false,
        summary:
          "Runtime injects env directly from hack.env.*.yaml by default; .hack/.env is only written by `hack env materialize`.",
      },
    },
    files: input.modern.files,
    scopes: input.modern.declaredScopes,
    unknown_scopes: input.modern.unknownScopes,
    selected_scope: input.selectedScope,
    vars: Object.entries(input.envValues).map(([key, value]) => {
      const resolvedValue = resolveModernStoredValue({
        modern: input.modern,
        scope: input.selectedScope,
        key,
      });
      const secret = resolvedValue
        ? isModernSecretStoredValue(resolvedValue.value)
        : false;
      const services =
        resolvedValue?.scope && resolvedValue.scope !== "global"
          ? [resolvedValue.scope]
          : null;
      return {
        key,
        required: false,
        source: secret ? "keychain" : "plain_env",
        services,
        resolved_from: "project_env_config",
        storage: {
          kind: secret ? "secret" : "plaintext",
          backend: "project_env_config",
          location: input.modern.files.join(", "),
          mode: "yaml",
          trust_model: secret
            ? MODERN_ENV_STATUS_CLASSIFICATION.trust_model
            : MODERN_LOCAL_PLAINTEXT_CLASSIFICATION.trust_model,
          classification: secret
            ? MODERN_ENV_STATUS_CLASSIFICATION
            : MODERN_LOCAL_PLAINTEXT_CLASSIFICATION,
        },
        value: maskModernEnvValue({
          modern: input.modern,
          scope: input.selectedScope,
          key,
          value,
          showSecrets: input.showSecrets,
        }),
      };
    }),
    missing_required: [],
    ...(input.showSecrets
      ? { materialized: input.materialized }
      : { materialized_keys: Object.keys(input.materialized).sort() }),
  };
}

function resolveModernStoredValue(input: {
  readonly modern: NonNullable<
    Awaited<ReturnType<typeof loadModernProjectEnv>>
  >;
  readonly scope: string;
  readonly key: string;
}): { readonly scope: string; readonly value: unknown } | null {
  if (input.scope !== "global") {
    const scopedValue = input.modern.merged.values[input.scope]?.[input.key];
    if (scopedValue !== undefined) {
      return { scope: input.scope, value: scopedValue };
    }
  }

  const globalValue = input.modern.merged.values.global?.[input.key];
  if (globalValue !== undefined) {
    return { scope: "global", value: globalValue };
  }

  return null;
}

function serializeEnvStorageForJson(input: {
  readonly storage: HackEnvStorageSummary;
}) {
  return serializeEnvStorageForJsonShape(input);
}

async function loadResolvedEnvState(input: {
  readonly projectDir: string;
  readonly projectName: string;
  readonly envName: string | null | undefined;
}): Promise<Awaited<ReturnType<typeof resolveHackEnv>> | null> {
  try {
    return await resolveHackEnv({
      projectDir: input.projectDir,
      projectName: input.projectName,
      envName: input.envName,
    });
  } catch (error: unknown) {
    logger.error({
      message:
        error instanceof Error ? error.message : "Unable to resolve env state.",
    });
    return null;
  }
}

async function renderEnvListDisplay(input: {
  readonly resolved: Awaited<ReturnType<typeof resolveHackEnv>>;
  readonly projectDir: string;
  readonly showSecrets: boolean;
}): Promise<number> {
  await display.kv({
    title: "Env storage",
    entries: [
      [
        "env_selection",
        input.resolved.envSelection.effectiveEnv
          ? `${input.resolved.envSelection.effectiveEnv} (base .hack/.env overlaid by ${input.resolved.envSelection.overlayPath})`
          : "base (.hack/.env only)",
      ],
      [
        "contract",
        `${input.resolved.storage.contract.path} (committed metadata only; no values are stored here)`,
      ],
      [
        "local_plaintext",
        `${input.resolved.storage.localPlaintext.path} (${input.resolved.storage.localPlaintext.exists ? "present" : "missing"} plaintext compatibility file for plain_env; existing .env-style workflows still work and gitignore is recommended but not enforced)`,
      ],
      [
        "local_fallback",
        `${input.resolved.storage.localPlaintext.fallback.source} (ambient plaintext fallback when .hack/.env does not provide a plain_env value)`,
      ],
      [
        "local_secrets",
        describeLocalSecretsForDisplay({
          storage: input.resolved.storage.localSecrets,
        }),
      ],
      [
        "compatibility_mode",
        "Plaintext values materialize to .hack/.env. Secret values materialize to the configured secret backend. This preserves current local runtime behavior while portable env stays opt-in.",
      ],
      [
        "portable_state",
        describePortableStateForDisplay({
          storage: input.resolved.storage.portableState,
        }),
      ],
    ],
  });

  if (input.resolved.contract.vars.length === 0) {
    logger.info({
      message: `No ${input.projectDir}/hack.env.json contract found (or it has no vars).`,
    });
    return 0;
  }

  await printEnvWarnings({ warnings: input.resolved.warnings });
  await display.section("Resolved env vars");

  for (const v of input.resolved.values) {
    const value =
      v.source === "keychain" && !input.showSecrets && v.value !== null
        ? "***"
        : (v.value ?? "");
    const required = v.required ? "required" : "optional";
    const source = v.source;
    const from = v.resolvedFrom ?? "missing";
    const storage = describeValueStorageForDisplay({
      value: v,
      storage: input.resolved.storage,
    });
    const services = v.services ? v.services.join(",") : "*";
    process.stdout.write(
      `${v.key}\t${required}\t${source}\t${storage}\t${from}\t${services}\t${value}\n`
    );
  }

  if (input.resolved.missingRequired.length > 0) {
    logger.warn({
      message: `Missing required env: ${input.resolved.missingRequired.map((v) => v.key).join(", ")}`,
    });
    return 1;
  }

  return 0;
}

function writeEnvListJson(input: {
  readonly projectName: string;
  readonly resolved: Awaited<ReturnType<typeof resolveHackEnv>>;
  readonly showSecrets: boolean;
}): void {
  process.stdout.write(
    `${JSON.stringify(
      {
        project: input.projectName,
        env_selection: {
          requested: input.resolved.envSelection.requestedEnv,
          default: input.resolved.envSelection.defaultEnv,
          effective: input.resolved.envSelection.effectiveEnv,
          overlay_path: input.resolved.envSelection.overlayPath,
          overlay_exists: input.resolved.envSelection.overlayExists,
        },
        status: describeEnvAggregateStatusForJson({
          storage: input.resolved.storage,
        }),
        storage: serializeEnvStorageForJson({
          storage: input.resolved.storage,
        }),
        warnings: input.resolved.warnings.map((warning) => ({
          kind: warning.kind,
          key: warning.key,
          overlay_path: warning.overlayPath,
          services: warning.services,
          message: warning.message,
        })),
        vars: input.resolved.values.map((v) => ({
          key: v.key,
          required: v.required,
          source: v.source,
          storage: describeValueStorageForJson({
            value: v,
            storage: input.resolved.storage,
          }),
          services: v.services,
          resolved_from: v.resolvedFrom,
          value:
            v.source === "keychain" && !input.showSecrets && v.value !== null
              ? "***"
              : v.value,
        })),
        missing_required: input.resolved.missingRequired.map((v) => v.key),
      },
      null,
      2
    )}\n`
  );
}

async function printEnvWarnings(input: {
  readonly warnings: Awaited<ReturnType<typeof resolveHackEnv>>["warnings"];
}): Promise<void> {
  if (input.warnings.length === 0) {
    return;
  }

  await display.section("Warnings");
  for (const warning of input.warnings) {
    logger.warn({ message: warning.message });
  }
}

const handleEnvAdd: CommandHandlerFor<typeof addSpec> = async ({
  ctx,
  args,
}): Promise<number> => {
  const project = await resolveProjectForEnv({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
  });
  const projectName = await resolveProjectName(project);
  const envName = resolveRequestedEnvName({
    envOption: args.options.env,
  });
  await maybeMigrateLegacyProjectEnv({
    project,
    projectName,
    reason: "mutation",
  });

  const keyArg = args.positionals.key?.trim();
  const valueArg = args.positionals.value;
  const interactive = !(keyArg || valueArg);
  const prompted = interactive
    ? await promptForEnvAddInput({
        project,
        envName,
      })
    : null;

  const parsedTarget = prompted
    ? { scope: prompted.scope, key: prompted.key }
    : parseProjectEnvTarget({
        keyOrPath: keyArg ?? "",
        scopeOverride: args.options.service,
      });
  const value = prompted
    ? prompted.value
    : await resolveEnvValue({
        key: parsedTarget.key,
        value: valueArg ?? null,
        secret: args.options.secret === true,
      });
  const secret = prompted ? prompted.secret : args.options.secret === true;

  const result = await setProjectEnvValue({
    projectRoot: project.projectRoot,
    projectDir: project.projectDir,
    envName: envName ?? null,
    scope: parsedTarget.scope,
    key: parsedTarget.key,
    value,
    secret,
  });

  logger.success({
    message: [
      result.changed
        ? `Updated ${result.filePath}`
        : `No changes needed in ${result.filePath}`,
      `scope=${result.scope}`,
      result.createdKey ? "generated .hack.secret.key" : null,
    ]
      .filter((value): value is string => typeof value === "string")
      .join(" • "),
  });
  return 0;
};

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
  const envName = resolveRequestedEnvName({
    envOption: args.options.env,
  });

  const modernExists = await projectEnvConfigExists({
    projectDir: project.projectDir,
  });
  if (modernExists) {
    return await handleEnvAdd({
      ctx,
      args: {
        ...args,
        positionals: {
          key: args.positionals.key,
          value: args.positionals.value,
        },
      } as never,
    });
  }

  const storeSecret = args.options.secret === true;
  const runtimeConfig = await readHackEnvRuntimeConfig({
    projectDir: project.projectDir,
  });
  const rawKey = (args.positionals.key ?? "").trim();
  const rawValue = args.positionals.value;
  const [keyFromSpec, valueFromSpec] = parseKeyValueSpec(
    rawValue === undefined ? rawKey : `${rawKey}=${rawValue}`
  );
  const key = await resolveEnvKey({ key: keyFromSpec });
  const mutationSource = storeSecret ? "keychain" : "plain_env";
  const sourceValidation = await validateHackEnvMutationSource({
    projectDir: project.projectDir,
    key,
    attemptedSource: mutationSource,
  });
  if (!sourceValidation.ok) {
    logger.error({ message: sourceValidation.message });
    return 1;
  }
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
      .filter((entry): entry is string => typeof entry === "string")
      .join(" • "),
  });
  return 0;
};

const handleEnvMaterialize: CommandHandlerFor<typeof materializeSpec> = async ({
  ctx,
  args,
}): Promise<number> => {
  const project = await resolveProjectForEnv({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
  });
  const projectName = await resolveProjectName(project);
  await maybeMigrateLegacyProjectEnv({
    project,
    projectName,
    reason: "mutation",
  });
  const envName = resolveRequestedEnvName({
    envOption: args.options.env,
  });
  const serviceNames = await discoverComposeServiceNames({
    composeFile: project.composeFile,
  });
  const result = await materializeProjectEnv({
    projectRoot: project.projectRoot,
    projectDir: project.projectDir,
    envName,
    serviceName: args.options.service?.trim() || null,
    serviceNames,
  });
  logger.success({
    message: `${result.changed ? "Updated" : "No changes needed in"} ${result.envPath}`,
  });
  return 0;
};

function resolveInteractiveShellCommand(): readonly string[] {
  const shellPath = process.env.SHELL?.trim() || "/bin/sh";
  return [shellPath, "-l"];
}

function resolveShellCommandCommand(input: {
  readonly command: string;
}): readonly string[] {
  return ["/bin/sh", "-lc", input.command];
}

function resolveExecutionScopeName(input: {
  readonly scopeName?: string;
  readonly serviceName?: string;
}): string | null {
  const scopeName = input.scopeName?.trim();
  const serviceName = input.serviceName?.trim();
  if (scopeName && serviceName) {
    throw new CliUsageError("Use either --scope or --service, not both.");
  }
  return scopeName || serviceName || null;
}

async function runHostCommandWithInjectedEnv(input: {
  readonly ctx: CliContext;
  readonly pathOpt: string | undefined;
  readonly projectOpt: string | undefined;
  readonly envOpt: string | undefined;
  readonly scopeName?: string;
  readonly serviceName?: string;
  readonly targetOpt: string | undefined;
  readonly command: readonly string[];
  readonly shellCommandOpt?: string;
}): Promise<number> {
  const project = await resolveProjectForEnv({
    ctx: input.ctx,
    pathOpt: input.pathOpt,
    projectOpt: input.projectOpt,
  });
  const projectName = await resolveProjectName(project);
  const envName = resolveRequestedEnvName({
    envOption: input.envOpt,
  });
  const target = resolveHostEnvTarget({
    targetOption: input.targetOpt,
  });
  const shellCommand = input.shellCommandOpt?.trim();
  const positionalCommand = input.command;
  if (shellCommand && positionalCommand.length > 0) {
    throw new CliUsageError("Use either <command...> or --shell, not both.");
  }
  if (!shellCommand && positionalCommand.length === 0) {
    throw new CliUsageError("Command is required.");
  }

  const envState = await resolveEnvInjection({
    project,
    projectName,
    envName,
    serviceName: resolveExecutionScopeName({
      scopeName: input.scopeName,
      serviceName: input.serviceName,
    }),
    target,
  });
  return await run(
    shellCommand
      ? resolveShellCommandCommand({ command: shellCommand })
      : positionalCommand,
    {
      cwd: project.projectRoot,
      env: envState.env,
      stdin: "inherit",
    }
  );
}

async function openHostShellWithInjectedEnv(input: {
  readonly ctx: CliContext;
  readonly pathOpt: string | undefined;
  readonly projectOpt: string | undefined;
  readonly envOpt: string | undefined;
  readonly scopeName?: string;
  readonly serviceName?: string;
  readonly targetOpt: string | undefined;
}): Promise<number> {
  const project = await resolveProjectForEnv({
    ctx: input.ctx,
    pathOpt: input.pathOpt,
    projectOpt: input.projectOpt,
  });
  const projectName = await resolveProjectName(project);
  const envName = resolveRequestedEnvName({
    envOption: input.envOpt,
  });
  const target = resolveHostEnvTarget({
    targetOption: input.targetOpt,
  });
  const envState = await resolveEnvInjection({
    project,
    projectName,
    envName,
    serviceName: resolveExecutionScopeName({
      scopeName: input.scopeName,
      serviceName: input.serviceName,
    }),
    target,
  });

  return await run(resolveInteractiveShellCommand(), {
    cwd: project.projectRoot,
    env: envState.env,
    stdin: "inherit",
  });
}

const handleEnvExec: CommandHandlerFor<typeof execSpec> = async ({
  ctx,
  args,
}): Promise<number> => {
  return await runHostCommandWithInjectedEnv({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
    envOpt: args.options.env,
    serviceName: args.options.service,
    targetOpt: args.options.target,
    command: args.positionals.command,
    shellCommandOpt: args.options.shellCommand,
  });
};

const handleEnvShell: CommandHandlerFor<typeof shellSpec> = async ({
  ctx,
  args,
}): Promise<number> => {
  return await openHostShellWithInjectedEnv({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
    envOpt: args.options.env,
    serviceName: args.options.service,
    targetOpt: args.options.target,
  });
};

const handleHostExec: CommandHandlerFor<typeof hostExecSpec> = async ({
  ctx,
  args,
}): Promise<number> => {
  return await runHostCommandWithInjectedEnv({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
    envOpt: args.options.env,
    scopeName: args.options.scope,
    targetOpt: args.options.target,
    command: args.positionals.command,
    shellCommandOpt: args.options.shellCommand,
  });
};

const handleHostShell: CommandHandlerFor<typeof hostShellSpec> = async ({
  ctx,
  args,
}): Promise<number> => {
  return await openHostShellWithInjectedEnv({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
    envOpt: args.options.env,
    scopeName: args.options.scope,
    targetOpt: args.options.target,
  });
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
  const envName = resolveRequestedEnvName({
    envOption: args.options.env,
  });

  const modernExists = await projectEnvConfigExists({
    projectDir: project.projectDir,
  });
  if (!modernExists) {
    const store = await resolveConfiguredSecretStore({ project, projectName });
    const key = await resolveEnvKey({
      key: (args.positionals.key ?? "").trim(),
    });

    const okLegacy = await confirm({
      message: `Unset "${key}" from ${resolveEnvFilePath({ projectDir: project.projectDir, envName })} and ${formatSecretStoreDescriptor({ descriptor: store.descriptor })}${envName ? ` (env ${envName})` : ""}?`,
      initialValue: true,
    });
    if (isCancel(okLegacy)) {
      return 1;
    }
    if (!okLegacy) {
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
  }

  const parsedTarget = parseProjectEnvTarget({
    keyOrPath: (args.positionals.key ?? "").trim(),
    scopeOverride: args.options.service,
  });

  const ok = await confirm({
    message: `Unset "${parsedTarget.key}" from ${parsedTarget.scope} in ${envName ?? "default"}?`,
    initialValue: true,
  });
  if (isCancel(ok)) {
    return 1;
  }
  if (!ok) {
    return 0;
  }

  const result = await unsetProjectEnvValue({
    projectDir: project.projectDir,
    envName: envName ?? null,
    scope: parsedTarget.scope,
    key: parsedTarget.key,
  });

  logger.success({
    message: result.changed
      ? `Updated ${result.filePath}`
      : `No ${parsedTarget.scope}.${parsedTarget.key} entry to remove`,
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
    withHandler(addSpec, handleEnvAdd),
    withHandler(setSpec, handleEnvSet),
    withHandler(materializeSpec, handleEnvMaterialize),
    withHandler(execSpec, handleEnvExec),
    withHandler(shellSpec, handleEnvShell),
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

export const hostCommand = defineCommand({
  name: "host",
  summary: "Run host-side commands with project env injected",
  group: "Integrations",
  expandInRootHelp: true,
  description:
    "Use hack host when a command should run on your host machine, not inside the compose network, but still needs Hack-resolved env and host-local rewrites.",
  options: [],
  positionals: [],
  subcommands: [
    withHandler(hostExecSpec, handleHostExec),
    withHandler(hostShellSpec, handleHostShell),
  ],
} as const);
