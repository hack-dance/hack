import { basename, dirname, resolve } from "node:path";
import {
  DEFAULT_OAUTH_ALIAS_TLD,
  HACK_PROJECT_DIR_LEGACY,
  HACK_PROJECT_DIR_PRIMARY,
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_CONFIG_LEGACY_FILENAME,
  PROJECT_ENV_FILENAME,
} from "../constants.ts";
import { parseDotEnv } from "./env.ts";
import { pathExists, readTextFile } from "./fs.ts";
import { getRecord, getString, isRecord } from "./guards.ts";
import { findUpFile } from "./path.ts";

export type ProjectDirName =
  | typeof HACK_PROJECT_DIR_PRIMARY
  | typeof HACK_PROJECT_DIR_LEGACY;

export interface ProjectContext {
  readonly projectRoot: string;
  readonly projectDirName: ProjectDirName;
  readonly projectDir: string;
  readonly composeFile: string;
  readonly envFile: string;
  readonly configFile: string;
}

export async function findProjectContext(
  startDir: string
): Promise<ProjectContext | null> {
  const primaryRoot = await findUpFile(
    startDir,
    `${HACK_PROJECT_DIR_PRIMARY}/${PROJECT_COMPOSE_FILENAME}`
  );
  if (primaryRoot) {
    return buildProjectContext(primaryRoot, HACK_PROJECT_DIR_PRIMARY);
  }

  const legacyRoot = await findUpFile(
    startDir,
    `${HACK_PROJECT_DIR_LEGACY}/${PROJECT_COMPOSE_FILENAME}`
  );
  if (legacyRoot) {
    return buildProjectContext(legacyRoot, HACK_PROJECT_DIR_LEGACY);
  }

  return null;
}

function buildProjectContext(
  projectRoot: string,
  dirName: ProjectDirName
): ProjectContext {
  const projectDir = resolve(projectRoot, dirName);
  return {
    projectRoot,
    projectDirName: dirName,
    projectDir,
    composeFile: resolve(projectDir, PROJECT_COMPOSE_FILENAME),
    envFile: resolve(projectDir, PROJECT_ENV_FILENAME),
    configFile: resolve(projectDir, PROJECT_CONFIG_FILENAME),
  };
}

export async function findRepoRootForInit(startDir: string): Promise<string> {
  const byPackageJson = await findUpFile(startDir, "package.json");
  if (byPackageJson) {
    return byPackageJson;
  }

  const byGit = await findUpFile(startDir, ".git");
  if (byGit) {
    return byGit;
  }

  return resolve(startDir);
}

export function sanitizeProjectSlug(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const replaced = trimmed
    .replaceAll("_", "-")
    .replaceAll(" ", "-")
    .replaceAll("/", "-");
  const cleaned = replaced.replaceAll(/[^a-z0-9-]/g, "");
  const collapsed = cleaned.replaceAll(/-+/g, "-").replaceAll(/^-|-$/g, "");
  return collapsed.length > 0 ? collapsed : "project";
}

export function normalizeEnvConfigName(input: string): string | null {
  const normalized = input
    .trim()
    .toLowerCase()
    .replaceAll("_", "-")
    .replaceAll(" ", "-")
    .replaceAll("/", "-")
    .replaceAll(/[^a-z0-9-]/g, "")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");
  return normalized.length > 0 ? normalized : null;
}

export function parseEnvConfigSelection(
  input: string | undefined
): string | null | undefined {
  if (input === undefined) {
    return undefined;
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const lowered = trimmed.toLowerCase();
  if (lowered === "base" || lowered === "default" || lowered === "none") {
    return null;
  }

  return normalizeEnvConfigName(trimmed);
}

export function sanitizeBranchSlug(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const replaced = trimmed
    .replaceAll("_", "-")
    .replaceAll(" ", "-")
    .replaceAll("/", "-");
  const cleaned = replaced.replaceAll(/[^a-z0-9-]/g, "");
  return cleaned.replaceAll(/-+/g, "-").replaceAll(/^-|-$/g, "");
}

export function defaultProjectSlugFromPath(repoRoot: string): string {
  return sanitizeProjectSlug(basename(repoRoot));
}

export async function readProjectDevHost(
  ctx: ProjectContext
): Promise<string | null> {
  const cfg = await readProjectConfig(ctx);
  if (cfg.devHost) {
    return cfg.devHost;
  }

  // Legacy fallback: older scaffolds wrote DEV_HOST into `.hack/.env`.
  const envText = await readTextFile(ctx.envFile);
  if (!envText) {
    return null;
  }

  const env = parseDotEnv(envText);
  const host = env.DEV_HOST;
  return typeof host === "string" && host.length > 0 ? host : null;
}

export async function readProjectDefaultEnvConfig(opts: {
  readonly projectDir: string;
}): Promise<string | null> {
  const config = await readProjectConfig({
    projectRoot: opts.projectDir,
    projectDirName: HACK_PROJECT_DIR_PRIMARY,
    projectDir: opts.projectDir,
    composeFile: resolve(opts.projectDir, PROJECT_COMPOSE_FILENAME),
    envFile: resolve(opts.projectDir, PROJECT_ENV_FILENAME),
    configFile: resolve(opts.projectDir, PROJECT_CONFIG_FILENAME),
  });
  return config.env?.defaultOverlay ?? config.defaultEnvConfig ?? null;
}

export interface ProjectConfig {
  readonly name?: string;
  readonly devHost?: string;
  readonly defaultEnvConfig?: string;
  readonly env?: {
    readonly defaultOverlay?: string;
  };
  readonly logs?: ProjectLogsConfig;
  readonly oauth?: ProjectOauthConfig;
  readonly internal?: ProjectInternalConfig;
  readonly worktree?: ProjectWorktreeConfig;
  readonly sessions?: ProjectSessionsConfig;
  readonly lifecycle?: ProjectLifecycleConfig;
  readonly ownership: ProjectOwnershipConfig;
  readonly configPath?: string;
  readonly parseError?: string;
}

export type ProjectOwnershipMode = "local" | "shared";
export type ProjectOwnershipOwnerType = "user" | "team" | "organization";
export type ProjectOwnershipManager = "local" | "broker";

export interface ProjectOwnershipConfig {
  readonly mode: ProjectOwnershipMode;
  readonly ownerType: ProjectOwnershipOwnerType;
  readonly ownerId: string | null;
  readonly managedBy: ProjectOwnershipManager;
}

type ParsedProjectOwnership = {
  readonly ownership: ProjectOwnershipConfig;
  readonly parseError?: string;
};

export interface ProjectSessionsConfig {
  /**
   * Mux backend for `hack session`.
   * - "auto" (default): prefer tmux, fall back to zellij.
   * - "tmux": require tmux.
   * - "zellij": require zellij.
   * - "none": disable sessions.
   */
  readonly mux?: string;
}

export interface ProjectLifecycleConfig {
  readonly up?: ProjectLifecycleHooks;
  readonly down?: ProjectLifecycleHooks;
  readonly processes?: readonly ProjectLifecycleProcess[];
}

export type ProjectLifecycleSingletonConflictPolicy = "adopt" | "fail";

export interface ProjectLifecycleSingletonConfig {
  readonly ports: readonly number[];
  readonly onConflict?: ProjectLifecycleSingletonConflictPolicy;
}

export interface ProjectLifecycleHooks {
  readonly before?: readonly ProjectLifecycleCommand[];
  readonly after?: readonly ProjectLifecycleCommand[];
}

export interface ProjectLifecycleCommand {
  readonly name?: string;
  readonly command: string;
  readonly cwd?: string;
  readonly persistent?: boolean;
  readonly singleton?: ProjectLifecycleSingletonConfig;
}

export interface ProjectLifecycleProcess {
  readonly name: string;
  readonly command: string;
  readonly cwd?: string;
  readonly singleton?: ProjectLifecycleSingletonConfig;
}

interface ProjectStartupEntry {
  readonly name?: string;
  readonly run: string;
  readonly cwd?: string;
  readonly persistent?: boolean;
  readonly singleton?: ProjectLifecycleSingletonConfig;
}

export type LogsBackend = "compose" | "loki";

export interface ProjectLogsConfig {
  /**
   * Backend preference when following logs (lowest latency is `compose`).
   * If Loki is unreachable, the CLI may still fall back to docker compose logs unless explicitly forced.
   */
  readonly followBackend?: LogsBackend;

  /**
   * Backend preference when printing logs and exiting (queryable history).
   * If Loki is unreachable, the CLI may fall back to docker compose logs unless explicitly forced.
   */
  readonly snapshotBackend?: LogsBackend;

  /**
   * If true, `hack down` will request deletion of all Loki logs for this project.
   */
  readonly clearOnDown?: boolean;

  /**
   * Optional: keep only the most recent logs when `hack down` runs by pruning Loki logs older than this period.
   * Example: "24h", "168h", "7d"
   */
  readonly retentionPeriod?: string;
}

export interface ProjectOauthConfig {
  /**
   * When enabled, the CLI scaffolder will additionally expose each routed service on a public-suffix alias
   * (e.g. `*.hack.gy`) so OAuth providers like Google accept the redirect origin/URI.
   */
  readonly enabled?: boolean;

  /**
   * Optional override for the alias TLD.
   * Example: `gy` → `sickemail.hack.gy`
   */
  readonly tld?: string;
}

export interface ProjectInternalConfig {
  /**
   * When enabled, containers use CoreDNS to resolve *.hack to the Caddy proxy.
   */
  readonly dns?: boolean;

  /**
   * When enabled, mount the Caddy Local CA into containers and set common SSL env vars.
   */
  readonly tls?: boolean;

  /**
   * Optional extra_hosts to inject into every Compose service via the generated
   * `.hack/.internal/compose.override.yml`.
   *
   * Useful when containers need to reach host-local tunnels (e.g. SSM port-forwards)
   * while preserving the original hostname for TLS SNI/certificate validation.
   *
   * Example:
   * {
   *   "content.staging.livenationapi.com": "host-gateway",
   *   "loyalty.staging.livenationapi.com": "host-gateway"
   * }
   */
  readonly extraHosts?: Record<string, string>;
}

export interface ProjectWorktreeConfig {
  /**
   * When true (default), project commands run from a linked git worktree with
   * no explicit `--branch` default to a branch instance named after the
   * sanitized current git branch. Set to false (`worktree.auto_branch`) to
   * target the base instance from linked worktrees.
   */
  readonly autoBranch?: boolean;
}

/**
 * Resolves whether worktree branch auto-defaulting is enabled (default: true).
 */
export function resolveWorktreeAutoBranch(
  cfg: Pick<ProjectConfig, "worktree"> | undefined
): boolean {
  return cfg?.worktree?.autoBranch !== false;
}

export function resolveProjectOauthTld(
  cfg: ProjectOauthConfig | undefined
): string | null {
  if (!cfg?.enabled) {
    return null;
  }
  const tld = cfg.tld?.trim().toLowerCase();
  return tld && tld.length > 0 ? tld : DEFAULT_OAUTH_ALIAS_TLD;
}

export async function readProjectConfig(
  ctx: ProjectContext
): Promise<ProjectConfig> {
  const jsonPath = resolve(ctx.projectDir, PROJECT_CONFIG_FILENAME);
  const jsonText = await readTextFile(jsonPath);
  if (jsonText !== null) {
    return parseProjectConfigJson({ text: jsonText, path: jsonPath });
  }

  const tomlPath = resolve(ctx.projectDir, PROJECT_CONFIG_LEGACY_FILENAME);
  const tomlText = await readTextFile(tomlPath);
  if (tomlText !== null) {
    return parseProjectConfigToml({ text: tomlText, path: tomlPath });
  }

  return {
    ownership: defaultProjectOwnership(),
  };
}

function parseProjectConfigJson(opts: {
  readonly text: string;
  readonly path: string;
}): ProjectConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.text);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid JSON";
    return {
      parseError: message,
      configPath: opts.path,
      ownership: defaultProjectOwnership(),
    };
  }
  return parseProjectConfigRecord(parsed, opts.path);
}

function parseProjectConfigToml(opts: {
  readonly text: string;
  readonly path: string;
}): ProjectConfig {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(opts.text);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid TOML";
    return {
      parseError: message,
      configPath: opts.path,
      ownership: defaultProjectOwnership(),
    };
  }
  return parseProjectConfigRecord(parsed, opts.path);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Project config parsing keeps schema migration and legacy compatibility explicit in one parser.
function parseProjectConfigRecord(value: unknown, path: string): ProjectConfig {
  if (!isRecord(value)) {
    return {
      configPath: path,
      parseError: "Project config root must be an object.",
      ownership: defaultProjectOwnership(),
    };
  }

  const name = getString(value, "name");
  const devHost = getString(value, "dev_host");
  const envConfig = getRecord(value, "env");
  const defaultEnvConfigRaw =
    getString(value, "defaultEnvConfig") ??
    getString(value, "default_env_config");
  const envDefaultOverlayRaw =
    (envConfig ? getString(envConfig, "defaultOverlay") : undefined) ??
    (envConfig ? getString(envConfig, "default_overlay") : undefined);
  const logs = parseLogsConfig(getRecord(value, "logs"));
  const oauth = parseOauthConfig(getRecord(value, "oauth"));
  const internal = parseInternalConfig(getRecord(value, "internal"));
  const worktree = parseWorktreeConfig(getRecord(value, "worktree"));
  const sessions = parseSessionsConfig(getRecord(value, "sessions"));
  const lifecycleBase = parseLifecycleConfig(getRecord(value, "lifecycle"));
  const startup = parseStartupEntries(value.startup);
  const lifecycle = mergeLifecycleWithStartup({
    lifecycle: lifecycleBase,
    startup,
  });
  const parsedOwnership = parseProjectOwnership(value.ownership);
  const defaultEnvConfig =
    typeof defaultEnvConfigRaw === "string"
      ? normalizeEnvConfigName(defaultEnvConfigRaw)
      : null;
  const envDefaultOverlay =
    typeof envDefaultOverlayRaw === "string"
      ? normalizeEnvConfigName(envDefaultOverlayRaw)
      : null;
  const parseErrors = [
    ...(defaultEnvConfigRaw && defaultEnvConfig === null
      ? [
          "Project defaultEnvConfig/default_env_config must be a non-empty env name.",
        ]
      : []),
    ...(envDefaultOverlayRaw && envDefaultOverlay === null
      ? [
          "Project env.defaultOverlay/default_overlay must be a non-empty env name.",
        ]
      : []),
    ...(parsedOwnership.parseError ? [parsedOwnership.parseError] : []),
  ];

  return {
    ...(name ? { name } : {}),
    ...(devHost ? { devHost } : {}),
    ...(defaultEnvConfig ? { defaultEnvConfig } : {}),
    ...(envDefaultOverlay
      ? { env: { defaultOverlay: envDefaultOverlay } }
      : {}),
    ...(logs ? { logs } : {}),
    ...(oauth ? { oauth } : {}),
    ...(internal ? { internal } : {}),
    ...(worktree ? { worktree } : {}),
    ...(sessions ? { sessions } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    ownership: parsedOwnership.ownership,
    ...(parseErrors.length > 0 ? { parseError: parseErrors.join(" ") } : {}),
    configPath: path,
  };
}

export function defaultProjectOwnership(): ProjectOwnershipConfig {
  return {
    mode: "local",
    ownerType: "user",
    ownerId: null,
    managedBy: "local",
  };
}

function parseProjectOwnership(value: unknown): ParsedProjectOwnership {
  if (value === undefined) {
    return { ownership: defaultProjectOwnership() };
  }
  if (!isRecord(value)) {
    return {
      ownership: defaultProjectOwnership(),
      parseError: "Project ownership must be an object.",
    };
  }

  const modeValue = value.mode;
  const mode = parseProjectOwnershipMode(
    typeof modeValue === "string" ? modeValue : undefined
  );
  if (modeValue !== undefined && mode === undefined) {
    return {
      ownership: defaultProjectOwnership(),
      parseError: "Project ownership.mode must be 'local' or 'shared'.",
    };
  }
  if (modeValue === undefined) {
    if (value.owner_type !== undefined || value.owner_id !== undefined) {
      return {
        ownership: defaultProjectOwnership(),
        parseError:
          "Project ownership.mode is required when ownership.owner_type or ownership.owner_id is set.",
      };
    }
    return { ownership: defaultProjectOwnership() };
  }
  if (mode === "local") {
    return { ownership: defaultProjectOwnership() };
  }

  const ownerTypeValue = value.owner_type;
  const ownerType = parseProjectOwnershipOwnerType(
    typeof ownerTypeValue === "string" ? ownerTypeValue : undefined
  );
  if (ownerType === undefined) {
    return {
      ownership: defaultProjectOwnership(),
      parseError:
        "Project ownership.owner_type must be 'user', 'team', or 'organization'.",
    };
  }
  if (ownerType === "user") {
    return {
      ownership: defaultProjectOwnership(),
      parseError:
        "Project shared ownership.owner_type must be 'team' or 'organization'.",
    };
  }

  const ownerIdValue = value.owner_id;
  if (
    ownerIdValue !== undefined &&
    ownerIdValue !== null &&
    typeof ownerIdValue !== "string"
  ) {
    return {
      ownership: defaultProjectOwnership(),
      parseError: "Project ownership.owner_id must be a string when provided.",
    };
  }
  const ownerId = normalizeProjectOwnerId(ownerIdValue);
  if (ownerId === null) {
    return {
      ownership: defaultProjectOwnership(),
      parseError:
        "Project shared ownership.owner_id must be a non-empty string.",
    };
  }

  return {
    ownership: {
      mode: "shared",
      ownerType,
      ownerId,
      managedBy: "broker",
    },
  };
}

function parseProjectOwnershipMode(
  value: string | undefined
): ProjectOwnershipMode | undefined {
  if (value === "local" || value === "shared") {
    return value;
  }
  return undefined;
}

function parseProjectOwnershipOwnerType(
  value: string | undefined
): ProjectOwnershipOwnerType | undefined {
  if (value === "user" || value === "team" || value === "organization") {
    return value;
  }
  return undefined;
}

function normalizeProjectOwnerId(
  value: string | null | undefined
): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function parseStartupEntries(
  value: unknown
): readonly ProjectStartupEntry[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const out: ProjectStartupEntry[] = [];
  for (const entry of value) {
    const parsed = parseStartupEntry(entry);
    if (parsed) {
      out.push(parsed);
    }
  }
  return out.length > 0 ? out : undefined;
}

function parseStartupEntry(value: unknown): ProjectStartupEntry | null {
  if (typeof value === "string") {
    const run = value.trim();
    return run.length > 0 ? { run } : null;
  }
  if (!isRecord(value)) {
    return null;
  }

  const run =
    getString(value, "run")?.trim() ?? getString(value, "command")?.trim();
  if (!run) {
    return null;
  }
  const name = getString(value, "name")?.trim();
  const cwd = getString(value, "cwd")?.trim();
  const persistent = value.persistent === true ? true : undefined;
  const singleton = parseLifecycleSingletonConfig(
    getRecord(value, "singleton")
  );

  return {
    ...(name && name.length > 0 ? { name } : {}),
    run,
    ...(cwd && cwd.length > 0 ? { cwd } : {}),
    ...(persistent ? { persistent } : {}),
    ...(singleton ? { singleton } : {}),
  };
}

function mergeLifecycleWithStartup(opts: {
  readonly lifecycle: ProjectLifecycleConfig | undefined;
  readonly startup: readonly ProjectStartupEntry[] | undefined;
}): ProjectLifecycleConfig | undefined {
  const startup = mapStartupEntriesToLifecycle({
    entries: opts.startup ?? [],
  });
  if (
    !opts.lifecycle &&
    startup.before.length === 0 &&
    startup.processes.length === 0
  ) {
    return undefined;
  }

  const lifecycleUpBefore = opts.lifecycle?.up?.before ?? [];
  const lifecycleUpAfter = opts.lifecycle?.up?.after;
  const lifecycleDownBefore = opts.lifecycle?.down?.before;
  const lifecycleDownAfter = opts.lifecycle?.down?.after;
  const lifecycleProcesses = opts.lifecycle?.processes ?? [];

  const upBefore = [...lifecycleUpBefore, ...startup.before];
  const processes = [...lifecycleProcesses, ...startup.processes];

  return buildLifecycleConfig({
    upBefore,
    upAfter: lifecycleUpAfter,
    downBefore: lifecycleDownBefore,
    downAfter: lifecycleDownAfter,
    processes,
  });
}

function mapStartupEntriesToLifecycle(opts: {
  readonly entries: readonly ProjectStartupEntry[];
}): {
  readonly before: readonly ProjectLifecycleCommand[];
  readonly processes: readonly ProjectLifecycleProcess[];
} {
  const before: ProjectLifecycleCommand[] = [];
  const processes: ProjectLifecycleProcess[] = [];
  let generatedProcessIndex = 0;

  for (const entry of opts.entries) {
    if (entry.persistent) {
      generatedProcessIndex += 1;
      processes.push({
        name: entry.name ?? `startup-${generatedProcessIndex}`,
        command: entry.run,
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
        ...(entry.singleton ? { singleton: entry.singleton } : {}),
      });
      continue;
    }

    before.push({
      ...(entry.name ? { name: entry.name } : {}),
      command: entry.run,
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
      ...(entry.singleton ? { singleton: entry.singleton } : {}),
    });
  }

  return { before, processes };
}

function buildLifecycleConfig(opts: {
  readonly upBefore: readonly ProjectLifecycleCommand[];
  readonly upAfter: readonly ProjectLifecycleCommand[] | undefined;
  readonly downBefore: readonly ProjectLifecycleCommand[] | undefined;
  readonly downAfter: readonly ProjectLifecycleCommand[] | undefined;
  readonly processes: readonly ProjectLifecycleProcess[];
}): ProjectLifecycleConfig | undefined {
  const lifecycle: ProjectLifecycleConfig = {
    ...(opts.upBefore.length > 0 || opts.upAfter
      ? {
          up: {
            ...(opts.upBefore.length > 0 ? { before: opts.upBefore } : {}),
            ...(opts.upAfter ? { after: opts.upAfter } : {}),
          },
        }
      : {}),
    ...(opts.downBefore || opts.downAfter
      ? {
          down: {
            ...(opts.downBefore ? { before: opts.downBefore } : {}),
            ...(opts.downAfter ? { after: opts.downAfter } : {}),
          },
        }
      : {}),
    ...(opts.processes.length > 0 ? { processes: opts.processes } : {}),
  };

  return Object.keys(lifecycle).length > 0 ? lifecycle : undefined;
}

function parseLifecycleConfig(
  value: Record<string, unknown> | undefined
): ProjectLifecycleConfig | undefined {
  if (!value) {
    return undefined;
  }

  const up = parseLifecycleHooks(getRecord(value, "up"));
  const down = parseLifecycleHooks(getRecord(value, "down"));
  const processes = parseLifecycleProcesses(value.processes);

  const out: ProjectLifecycleConfig = {
    ...(up ? { up } : {}),
    ...(down ? { down } : {}),
    ...(processes ? { processes } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseLifecycleHooks(
  value: Record<string, unknown> | undefined
): ProjectLifecycleHooks | undefined {
  if (!value) {
    return undefined;
  }

  const before = parseLifecycleCommands(value.before);
  const after = parseLifecycleCommands(value.after);
  const out: ProjectLifecycleHooks = {
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseLifecycleCommands(
  value: unknown
): readonly ProjectLifecycleCommand[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const out: ProjectLifecycleCommand[] = [];
  for (const entry of value) {
    const parsed = parseLifecycleCommand(entry);
    if (parsed) {
      out.push(parsed);
    }
  }

  return out.length > 0 ? out : undefined;
}

function parseLifecycleCommand(value: unknown): ProjectLifecycleCommand | null {
  if (typeof value === "string") {
    const command = value.trim();
    return command.length > 0 ? { command } : null;
  }
  if (!isRecord(value)) {
    return null;
  }

  const command = getString(value, "command")?.trim();
  if (!command) {
    return null;
  }
  const name = getString(value, "name")?.trim();
  const cwd = getString(value, "cwd")?.trim();
  const persistent = value.persistent === true ? true : undefined;
  const singleton = parseLifecycleSingletonConfig(
    getRecord(value, "singleton")
  );

  return {
    ...(name && name.length > 0 ? { name } : {}),
    command,
    ...(cwd && cwd.length > 0 ? { cwd } : {}),
    ...(persistent ? { persistent } : {}),
    ...(singleton ? { singleton } : {}),
  };
}

function parseLifecycleProcesses(
  value: unknown
): readonly ProjectLifecycleProcess[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const out: ProjectLifecycleProcess[] = [];
  for (const entry of value) {
    const parsed = parseLifecycleProcess(entry);
    if (parsed) {
      out.push(parsed);
    }
  }

  return out.length > 0 ? out : undefined;
}

function parseLifecycleProcess(value: unknown): ProjectLifecycleProcess | null {
  if (!isRecord(value)) {
    return null;
  }

  const name = getString(value, "name")?.trim();
  const command = getString(value, "command")?.trim();
  if (!(name && command)) {
    return null;
  }
  const cwd = getString(value, "cwd")?.trim();
  const singleton = parseLifecycleSingletonConfig(
    getRecord(value, "singleton")
  );

  return {
    name,
    command,
    ...(cwd && cwd.length > 0 ? { cwd } : {}),
    ...(singleton ? { singleton } : {}),
  };
}

function parseLifecycleSingletonConfig(
  value: Record<string, unknown> | undefined
): ProjectLifecycleSingletonConfig | undefined {
  if (!value) {
    return undefined;
  }

  const portsRaw = value.ports;
  if (!Array.isArray(portsRaw)) {
    return undefined;
  }

  const ports = [
    ...new Set(
      portsRaw.flatMap((entry) => {
        if (typeof entry !== "number" || !Number.isInteger(entry)) {
          return [];
        }
        return entry > 0 ? [entry] : [];
      })
    ),
  ];
  if (ports.length === 0) {
    return undefined;
  }

  const onConflictRaw = getString(value, "onConflict")?.trim();
  const onConflict =
    onConflictRaw === "adopt" || onConflictRaw === "fail"
      ? onConflictRaw
      : undefined;

  return {
    ports,
    ...(onConflict ? { onConflict } : {}),
  };
}

function parseWorktreeConfig(
  value: Record<string, unknown> | undefined
): ProjectWorktreeConfig | undefined {
  if (!value) {
    return undefined;
  }

  const autoBranch = parseOptionalBoolean(
    value.auto_branch ?? value.autoBranch
  );

  const out: ProjectWorktreeConfig = {
    ...(autoBranch !== undefined ? { autoBranch } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseSessionsConfig(
  value: Record<string, unknown> | undefined
): ProjectSessionsConfig | undefined {
  if (!value) {
    return undefined;
  }

  const mux = getString(value, "mux");
  const out: ProjectSessionsConfig = {
    ...(mux ? { mux } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseLogsConfig(
  value: Record<string, unknown> | undefined
): ProjectLogsConfig | undefined {
  if (!value) {
    return undefined;
  }

  const followBackend = parseLogsBackend(getString(value, "follow_backend"));
  const snapshotBackend = parseLogsBackend(
    getString(value, "snapshot_backend")
  );
  const clearOnDown = value.clear_on_down === true ? true : undefined;
  const retentionPeriod = getString(value, "retention_period");

  const out: ProjectLogsConfig = {
    ...(followBackend ? { followBackend } : {}),
    ...(snapshotBackend ? { snapshotBackend } : {}),
    ...(clearOnDown ? { clearOnDown } : {}),
    ...(retentionPeriod ? { retentionPeriod } : {}),
  };

  return Object.keys(out).length > 0 ? out : undefined;
}

function parseLogsBackend(value: string | undefined): LogsBackend | undefined {
  if (value === "compose") {
    return "compose";
  }
  if (value === "loki") {
    return "loki";
  }
  return undefined;
}

function parseOauthConfig(
  value: Record<string, unknown> | undefined
): ProjectOauthConfig | undefined {
  if (!value) {
    return undefined;
  }

  const enabled = value.enabled === true ? true : undefined;
  const tld = getString(value, "tld")?.trim();

  const out: ProjectOauthConfig = {
    ...(enabled ? { enabled } : {}),
    ...(tld && tld.length > 0 ? { tld } : {}),
  };

  return Object.keys(out).length > 0 ? out : undefined;
}

function parseInternalConfig(
  value: Record<string, unknown> | undefined
): ProjectInternalConfig | undefined {
  if (!value) {
    return undefined;
  }

  const dns = parseOptionalBoolean(value.dns);
  const tls = parseOptionalBoolean(value.tls);
  const extraHosts = parseStringMap(getRecord(value, "extra_hosts"));

  const out: ProjectInternalConfig = {
    ...(dns !== undefined ? { dns } : {}),
    ...(tls !== undefined ? { tls } : {}),
    ...(extraHosts ? { extraHosts } : {}),
  };

  return Object.keys(out).length > 0 ? out : undefined;
}

function parseStringMap(
  value: Record<string, unknown> | undefined
): Record<string, string> | undefined {
  if (!value) {
    return undefined;
  }

  const out: Record<string, string> = {};
  for (const [keyRaw, valueRaw] of Object.entries(value)) {
    const key = keyRaw.trim();
    if (key.length === 0) {
      continue;
    }
    if (typeof valueRaw !== "string") {
      continue;
    }
    const next = valueRaw.trim();
    if (next.length === 0) {
      continue;
    }
    out[key] = next;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (value === true) {
    return true;
  }
  if (value === false) {
    return false;
  }
  return undefined;
}

export async function hasHackProjectDir(
  repoRoot: string,
  dirName: ProjectDirName
): Promise<boolean> {
  return await pathExists(resolve(repoRoot, dirName));
}

export function projectDirDisplayName(ctx: ProjectContext): string {
  return basename(dirname(ctx.composeFile));
}
