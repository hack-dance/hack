import { resolve } from "node:path";

import { z } from "zod";
import {
  GLOBAL_ONLY_EXTENSION_IDS,
  PROJECT_CONFIG_FILENAME,
} from "../../constants.ts";
import { resolveGlobalConfigPath } from "../../lib/config-paths.ts";
import { readTextFile } from "../../lib/fs.ts";
import { isRecord } from "../../lib/guards.ts";

const ExtensionEnablementInputSchema = z.object({
  enabled: z.boolean().optional(),
  cliNamespace: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const ExtensionEnablementSchema = z.object({
  enabled: z.boolean().default(false),
  cliNamespace: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).default({}),
});

const SupervisorConfigInputSchema = z.object({
  enabled: z.boolean().optional(),
  maxConcurrentJobs: z.number().int().positive().optional(),
  logsMaxBytes: z.number().int().positive().optional(),
});

const SupervisorConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxConcurrentJobs: z.number().int().positive().default(4),
  logsMaxBytes: z.number().int().positive().default(5_000_000),
});

const TuiLogsConfigInputSchema = z.object({
  maxEntries: z.number().int().positive().optional(),
  maxLines: z.number().int().positive().optional(),
  historyTailStep: z.number().int().positive().optional(),
});

const TuiLogsConfigSchema = z.object({
  maxEntries: z.number().int().positive().default(2000),
  maxLines: z.number().int().positive().default(400),
  historyTailStep: z.number().int().positive().default(200),
});

const TuiConfigInputSchema = z.object({
  logs: TuiLogsConfigInputSchema.optional(),
});

const TuiConfigSchema = z.object({
  logs: TuiLogsConfigSchema.default(TuiLogsConfigSchema.parse({})),
});

const UsageConfigInputSchema = z.object({
  watchIntervalMs: z.number().int().positive().optional(),
  historySize: z.number().int().positive().optional(),
});

const UsageConfigSchema = z.object({
  watchIntervalMs: z.number().int().positive().default(2000),
  historySize: z.number().int().positive().default(24),
});

const DaemonLaunchdConfigInputSchema = z.object({
  installed: z.boolean().optional(),
  runAtLoad: z.boolean().optional(),
  guiSessionOnly: z.boolean().optional(),
});

const DaemonLaunchdConfigSchema = z.object({
  installed: z.boolean().default(false),
  runAtLoad: z.boolean().default(true),
  guiSessionOnly: z.boolean().default(true),
});

const DaemonConfigInputSchema = z.object({
  autoStart: z.boolean().optional(),
  launchd: DaemonLaunchdConfigInputSchema.optional(),
});

const DaemonConfigSchema = z.object({
  autoStart: z.boolean().default(true),
  launchd: DaemonLaunchdConfigSchema.default(
    DaemonLaunchdConfigSchema.parse({})
  ),
});

const GatewayConfigInputSchema = z.object({
  enabled: z.boolean().optional(),
  bind: z.string().optional(),
  port: z.number().int().positive().optional(),
  allowWrites: z.boolean().optional(),
});

const GatewayConfigSchema = z.object({
  enabled: z.boolean().default(false),
  bind: z.string().default("127.0.0.1"),
  port: z.number().int().positive().default(7788),
  allowWrites: z.boolean().default(false),
});

const ClusterConfigInputSchema = z.object({
  defaultNodeId: z.string().optional(),
  staleAfterMs: z.number().int().positive().optional(),
  offlineAfterMs: z.number().int().positive().optional(),
});

const ClusterConfigSchema = z.object({
  defaultNodeId: z.string().optional(),
  staleAfterMs: z.number().int().positive().default(30_000),
  offlineAfterMs: z.number().int().positive().default(120_000),
});

const ProjectExecutionModeSchema = z.enum([
  "local",
  "local_edit_remote_run",
  "remote_devcontainer",
]);

const ExecutionSyncEngineSchema = z.enum(["mutagen", "rsync"]);
const ExecutionSyncDirectionSchema = z.enum(["local_to_remote"]);

const ExecutionSyncConfigInputSchema = z.object({
  engine: ExecutionSyncEngineSchema.optional(),
  direction: ExecutionSyncDirectionSchema.optional(),
  exclude: z.array(z.string()).optional(),
});

const ExecutionSyncConfigSchema = z.object({
  engine: ExecutionSyncEngineSchema.default("mutagen"),
  direction: ExecutionSyncDirectionSchema.default("local_to_remote"),
  exclude: z.array(z.string()).default([]),
});

const ExecutionConfigInputSchema = z.object({
  mode: ProjectExecutionModeSchema.optional(),
  nodeId: z.string().optional(),
  singleActive: z.boolean().optional(),
  sync: ExecutionSyncConfigInputSchema.optional(),
});

const ExecutionConfigSchema = z.object({
  mode: ProjectExecutionModeSchema.default("local"),
  nodeId: z.string().optional(),
  singleActive: z.boolean().default(true),
  sync: ExecutionSyncConfigSchema.default(ExecutionSyncConfigSchema.parse({})),
});

const ProviderRoutingModeSchema = z.enum([
  "existing_only",
  "prefer_existing_then_bootstrap",
  "bootstrap_only",
]);

const ProviderProfileInputSchema = z.object({
  provider: z.string().min(1),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const ProviderProfileSchema = z.object({
  provider: z.string().min(1),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}),
});

const ProvidersConfigInputSchema = z.object({
  defaultProvider: z.string().optional(),
  defaultProfile: z.string().optional(),
  profiles: z.record(z.string(), ProviderProfileInputSchema).optional(),
});

const ProvidersConfigSchema = z.object({
  defaultProvider: z.string().optional(),
  defaultProfile: z.string().optional(),
  profiles: z.record(z.string(), ProviderProfileSchema).default({}),
});

const RoutingBootstrapConfigInputSchema = z.object({
  enabled: z.boolean().optional(),
  setAsProjectNode: z.boolean().optional(),
});

const RoutingBootstrapConfigSchema = z.object({
  enabled: z.boolean().default(false),
  setAsProjectNode: z.boolean().default(false),
});

const RoutingConfigInputSchema = z.object({
  provider: z.string().optional(),
  profile: z.string().optional(),
  mode: ProviderRoutingModeSchema.optional(),
  bootstrap: RoutingBootstrapConfigInputSchema.optional(),
  overrides: z.record(z.string(), z.unknown()).optional(),
});

const RoutingConfigSchema = z.object({
  provider: z.string().optional(),
  profile: z.string().optional(),
  mode: ProviderRoutingModeSchema.default("existing_only"),
  bootstrap: RoutingBootstrapConfigSchema.default(
    RoutingBootstrapConfigSchema.parse({})
  ),
  overrides: z.record(z.string(), z.unknown()).default({}),
});

const SecretsBackendSchema = z.enum(["keychain", "encrypted_file", "cloud"]);
const CloudSecretProviderSchema = z.enum(["aws", "gcp", "azure", "vault"]);

const SecretsEncryptedFileConfigInputSchema = z.object({
  path: z.string().optional(),
  keyPath: z.string().optional(),
});

const SecretsEncryptedFileConfigSchema = z.object({
  path: z.string().default("~/.hack/secrets.enc.json"),
  keyPath: z.string().default("~/.hack/secrets-file.key"),
});

const SecretsCloudConfigInputSchema = z.object({
  provider: CloudSecretProviderSchema.optional(),
  project: z.string().optional(),
  secretPrefix: z.string().optional(),
});

const SecretsCloudConfigSchema = z.object({
  provider: CloudSecretProviderSchema.optional(),
  project: z.string().optional(),
  secretPrefix: z.string().default("hack"),
});

const SecretsConfigInputSchema = z.object({
  backend: SecretsBackendSchema.optional(),
  allowEnvAuthRefs: z.boolean().optional(),
  storePlaintextInBackend: z.boolean().optional(),
  encryptedFile: SecretsEncryptedFileConfigInputSchema.optional(),
  cloud: SecretsCloudConfigInputSchema.optional(),
});

const SecretsConfigSchema = z.object({
  backend: SecretsBackendSchema.default("keychain"),
  allowEnvAuthRefs: z.boolean().default(true),
  storePlaintextInBackend: z.boolean().default(false),
  encryptedFile: SecretsEncryptedFileConfigSchema.default(
    SecretsEncryptedFileConfigSchema.parse({})
  ),
  cloud: SecretsCloudConfigSchema.default(SecretsCloudConfigSchema.parse({})),
});

const PreferencesAppearanceInputSchema = z.object({
  theme: z.string().optional(),
});

const PreferencesAppearanceSchema = z.object({
  theme: z.string().default("system"),
});

const PreferencesTerminalInputSchema = z.object({
  defaultApp: z.string().optional(),
});

const PreferencesTerminalSchema = z.object({
  defaultApp: z.string().default("terminal"),
});

const PreferencesEditorInputSchema = z.object({
  defaultApp: z.string().optional(),
});

const PreferencesEditorSchema = z.object({
  defaultApp: z.string().default("cursor"),
});

const PreferencesAgentsInputSchema = z.object({
  defaultApp: z.string().optional(),
  binaryPath: z.string().optional(),
});

const PreferencesAgentsSchema = z.object({
  defaultApp: z.string().default("codex"),
  binaryPath: z.string().default(""),
});

const PreferencesSessionInputSchema = z.object({
  provider: z.string().optional(),
  binaryPath: z.string().optional(),
});

const PreferencesSessionSchema = z.object({
  provider: z.string().default("tmux"),
  binaryPath: z.string().default(""),
});

const PreferencesContainerInputSchema = z.object({
  provider: z.string().optional(),
  binaryPath: z.string().optional(),
});

const PreferencesContainerSchema = z.object({
  provider: z.string().default("docker"),
  binaryPath: z.string().default(""),
});

const PreferencesConfigInputSchema = z.object({
  appearance: PreferencesAppearanceInputSchema.optional(),
  terminal: PreferencesTerminalInputSchema.optional(),
  editor: PreferencesEditorInputSchema.optional(),
  agents: PreferencesAgentsInputSchema.optional(),
  sessions: PreferencesSessionInputSchema.optional(),
  containers: PreferencesContainerInputSchema.optional(),
});

const PreferencesConfigSchema = z.object({
  appearance: PreferencesAppearanceSchema.default(
    PreferencesAppearanceSchema.parse({})
  ),
  terminal: PreferencesTerminalSchema.default(
    PreferencesTerminalSchema.parse({})
  ),
  editor: PreferencesEditorSchema.default(PreferencesEditorSchema.parse({})),
  agents: PreferencesAgentsSchema.default(PreferencesAgentsSchema.parse({})),
  sessions: PreferencesSessionSchema.default(
    PreferencesSessionSchema.parse({})
  ),
  containers: PreferencesContainerSchema.default(
    PreferencesContainerSchema.parse({})
  ),
});

const ControlPlaneConfigInputSchema = z.object({
  extensions: z.record(z.string(), ExtensionEnablementInputSchema).optional(),
  supervisor: SupervisorConfigInputSchema.optional(),
  tui: TuiConfigInputSchema.optional(),
  usage: UsageConfigInputSchema.optional(),
  daemon: DaemonConfigInputSchema.optional(),
  gateway: GatewayConfigInputSchema.optional(),
  cluster: ClusterConfigInputSchema.optional(),
  execution: ExecutionConfigInputSchema.optional(),
  providers: ProvidersConfigInputSchema.optional(),
  routing: RoutingConfigInputSchema.optional(),
  secrets: SecretsConfigInputSchema.optional(),
  nodeId: z.string().optional(),
  preferences: PreferencesConfigInputSchema.optional(),
});

const ControlPlaneConfigSchema = z.object({
  extensions: z.record(z.string(), ExtensionEnablementSchema).default({}),
  supervisor: SupervisorConfigSchema.default(SupervisorConfigSchema.parse({})),
  tui: TuiConfigSchema.default(TuiConfigSchema.parse({})),
  usage: UsageConfigSchema.default(UsageConfigSchema.parse({})),
  daemon: DaemonConfigSchema.default(DaemonConfigSchema.parse({})),
  gateway: GatewayConfigSchema.default(GatewayConfigSchema.parse({})),
  cluster: ClusterConfigSchema.default(ClusterConfigSchema.parse({})),
  execution: ExecutionConfigSchema.default(ExecutionConfigSchema.parse({})),
  providers: ProvidersConfigSchema.default(ProvidersConfigSchema.parse({})),
  routing: RoutingConfigSchema.optional(),
  secrets: SecretsConfigSchema.default(SecretsConfigSchema.parse({})),
  nodeId: z.string().optional(),
  preferences: PreferencesConfigSchema.default(
    PreferencesConfigSchema.parse({})
  ),
});

export type ControlPlaneConfig = z.infer<typeof ControlPlaneConfigSchema>;
export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;
export type DaemonLaunchdConfig = z.infer<typeof DaemonLaunchdConfigSchema>;
export type ClusterConfig = z.infer<typeof ClusterConfigSchema>;
export type ProjectExecutionMode = z.infer<typeof ProjectExecutionModeSchema>;
export type ExecutionSyncEngine = z.infer<typeof ExecutionSyncEngineSchema>;
export type ExecutionSyncDirection = z.infer<
  typeof ExecutionSyncDirectionSchema
>;
export type ExecutionSyncConfig = z.infer<typeof ExecutionSyncConfigSchema>;
export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;
export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>;
export type ProviderProfileConfig = z.infer<typeof ProviderProfileSchema>;
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;
export type RoutingBootstrapConfig = z.infer<
  typeof RoutingBootstrapConfigSchema
>;
export type ProviderRoutingMode = z.infer<typeof ProviderRoutingModeSchema>;
export type SecretsConfig = z.infer<typeof SecretsConfigSchema>;
export type SecretsBackend = z.infer<typeof SecretsBackendSchema>;
export type CloudSecretProvider = z.infer<typeof CloudSecretProviderSchema>;

type ControlPlaneConfigInput = z.infer<typeof ControlPlaneConfigInputSchema>;

export type ControlPlaneConfigResult = {
  readonly config: ControlPlaneConfig;
  readonly parseError?: string;
};

/**
 * Create a fully-defaulted control-plane config object.
 */
export function createDefaultControlPlaneConfig(): ControlPlaneConfig {
  return ControlPlaneConfigSchema.parse({});
}

/**
 * Load control-plane configuration from global config plus optional project overrides.
 *
 * @param opts.projectDir - Optional project directory to read overrides from.
 * @returns Parsed control-plane config and optional parse error message.
 */
export async function readControlPlaneConfig(opts: {
  readonly projectDir?: string;
}): Promise<ControlPlaneConfigResult> {
  const globalLayer = await readControlPlaneLayer({
    path: resolveGlobalConfigPath(),
    label: "Global config",
  });

  const projectLayer = opts.projectDir
    ? await readControlPlaneLayer({
        path: resolve(opts.projectDir, PROJECT_CONFIG_FILENAME),
        label: "Project config",
      })
    : { config: {} };

  const config = mergeControlPlaneLayers({
    global: globalLayer.config,
    project: projectLayer.config,
  });

  const parseError = joinParseErrors({
    errors: [globalLayer.parseError, projectLayer.parseError],
  });

  return parseError ? { config, parseError } : { config };
}

type ControlPlaneConfigLayer = {
  readonly config: ControlPlaneConfigInput;
  readonly parseError?: string;
};

async function readControlPlaneLayer(opts: {
  readonly path: string;
  readonly label: string;
}): Promise<ControlPlaneConfigLayer> {
  const text = await readTextFile(opts.path);
  if (text === null) {
    return { config: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid JSON";
    return {
      config: {},
      parseError: `${opts.label} parse error (${opts.path}): ${message}`,
    };
  }

  if (!isRecord(parsed)) {
    return {
      config: {},
      parseError: `${opts.label} parse error (${opts.path}): invalid config shape`,
    };
  }

  const controlPlaneRaw = parsed.controlPlane;
  const result = ControlPlaneConfigInputSchema.safeParse(controlPlaneRaw ?? {});
  if (!result.success) {
    return {
      config: {},
      parseError: `${opts.label} controlPlane error (${opts.path}): ${result.error.message}`,
    };
  }

  return { config: result.data };
}

function mergeControlPlaneLayers(opts: {
  readonly global: ControlPlaneConfigInput;
  readonly project: ControlPlaneConfigInput;
}): ControlPlaneConfig {
  const merged = mergeRecords({
    base: opts.global as Record<string, unknown>,
    override: opts.project as Record<string, unknown>,
  });

  const mergedExtensions = mergeExtensions({
    global: opts.global.extensions,
    project: opts.project.extensions,
  });
  merged.extensions = mergedExtensions;

  const globalGateway = isRecord(opts.global.gateway)
    ? opts.global.gateway
    : {};
  const projectGateway = isRecord(opts.project.gateway)
    ? opts.project.gateway
    : {};
  const projectEnabled = projectGateway.enabled;
  const gatewayEnabled =
    typeof projectEnabled === "boolean" ? projectEnabled : false;
  merged.gateway = { ...globalGateway, enabled: gatewayEnabled };

  let projectNodeId: string | undefined;
  if (typeof opts.project.nodeId === "string") {
    projectNodeId = opts.project.nodeId;
  } else if (typeof opts.project.execution?.nodeId === "string") {
    projectNodeId = opts.project.execution.nodeId;
  }
  merged.nodeId = projectNodeId;
  merged.routing = isRecord(opts.project.routing)
    ? opts.project.routing
    : undefined;

  return ControlPlaneConfigSchema.parse(merged);
}

function mergeExtensions(opts: {
  readonly global: ControlPlaneConfigInput["extensions"];
  readonly project: ControlPlaneConfigInput["extensions"];
}): Record<string, unknown> {
  const globalExtensions = isRecord(opts.global) ? opts.global : {};
  const projectExtensions = isRecord(opts.project) ? opts.project : {};
  const merged = mergeRecords({
    base: globalExtensions,
    override: projectExtensions,
  });

  const globalOnlyIds = new Set(GLOBAL_ONLY_EXTENSION_IDS);
  for (const extensionId of globalOnlyIds) {
    if (extensionId in globalExtensions) {
      merged[extensionId] = globalExtensions[extensionId];
    } else if (extensionId in merged) {
      delete merged[extensionId];
    }
  }

  return merged;
}

function mergeRecords(opts: {
  readonly base: Record<string, unknown>;
  readonly override: Record<string, unknown>;
}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...opts.base };
  for (const [key, value] of Object.entries(opts.override)) {
    if (value === undefined) {
      continue;
    }
    const existing = out[key];
    if (isRecord(existing) && isRecord(value)) {
      out[key] = mergeRecords({
        base: existing,
        override: value,
      });
      continue;
    }
    out[key] = value;
  }
  return out;
}

function joinParseErrors(opts: {
  readonly errors: readonly (string | undefined)[];
}): string | undefined {
  const parts = opts.errors.filter(
    (value): value is string => typeof value === "string"
  );
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join(" | ");
}
