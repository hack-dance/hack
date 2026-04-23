import { dirname, resolve } from "node:path";
import {
  autocompleteMultiselect,
  confirm,
  isCancel,
  multiselect,
  note,
  password,
  select,
  text,
} from "@clack/prompts";
import { YAML } from "bun";
import { installClaudeHooks } from "../agents/claude.ts";
import { installCodexSkill } from "../agents/codex-skill.ts";
import { installCursorRules } from "../agents/cursor.ts";
import { composeLogBackend, lokiLogBackend } from "../backends/log-backend.ts";
import { composeRuntimeBackend } from "../backends/runtime-backend.ts";
import type { CliContext, CommandArgs } from "../cli/command.ts";
import {
  CliUsageError,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";
import {
  optBranch,
  optDetach,
  optEnv,
  optFollow,
  optJson,
  optNoFollow,
  optPath,
  optPretty,
  optProfile,
  optProject,
  optSince,
  optTail,
  optUntil,
} from "../cli/options.ts";
import { globalUp } from "../commands/global.ts";
import {
  DEFAULT_GRAFANA_HOST,
  DEFAULT_INGRESS_NETWORK,
  DEFAULT_OAUTH_ALIAS_TLD,
  DEFAULT_PROJECT_TLD,
  GLOBAL_CADDY_COMPOSE_FILENAME,
  GLOBAL_CADDY_DIR_NAME,
  GLOBAL_HACK_DIR_NAME,
  HACK_PROJECT_DIR_PRIMARY,
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_CONFIG_LEGACY_FILENAME,
  PROJECT_ENV_CONFIG_DEFAULT_FILENAME,
  PROJECT_ENV_CONTRACT_FILENAME,
  PROJECT_ENV_FILENAME,
} from "../constants.ts";
import { readControlPlaneConfig } from "../control-plane/sdk/config.ts";
import { requestDaemonJson } from "../daemon/client.ts";
import { renderCompose } from "../init/compose.ts";
import type { ServiceCandidate } from "../init/discovery.ts";
import { discoverRepo } from "../init/discovery.ts";
import {
  buildSuggestedCommand,
  guessDefaultPort,
  guessRole,
  guessServiceName,
  inferPortFromScript,
} from "../init/heuristics.ts";
import { touchBranchUsage } from "../lib/branches.ts";
import { parseDurationMs } from "../lib/duration.ts";
import {
  isSlimExecutionMode,
  renderSlimModeUnavailableMessage,
} from "../lib/execution-mode.ts";
import {
  ensureDir,
  ensureGitignoreEntry,
  pathExists,
  readTextFile,
  writeTextFileIfChanged,
} from "../lib/fs.ts";
import { getString, isRecord } from "../lib/guards.ts";
import { resolveHackInvocation } from "../lib/hack-cli.ts";
import { resolveHackEnv, upsertDotEnvValue } from "../lib/hack-env.ts";
import { parseJsonLines } from "../lib/json-lines.ts";
import {
  appendLifecycleLogRecord,
  type LifecycleStateEntry,
  readLifecycleState,
  removeLifecycleStateEntry,
  resolveLifecycleComposeProjectName,
  resolveLifecycleLogPath,
  upsertLifecycleStateEntry,
} from "../lib/lifecycle-runtime.ts";
import { appendHackHostTrustEnvironment } from "../lib/local-ca.ts";
import {
  buildLogSelector,
  resolveShouldTryLoki,
  resolveUseLoki,
} from "../lib/logs.ts";
import { readNodesRegistry } from "../lib/nodes-registry.ts";
import { openUrl } from "../lib/os.ts";
import {
  defaultProjectSlugFromPath,
  findProjectContext,
  findRepoRootForInit,
  type ProjectLifecycleCommand,
  type ProjectLifecycleProcess,
  parseEnvConfigSelection,
  readProjectConfig,
  readProjectDevHost,
  resolveProjectOauthTld,
  sanitizeBranchSlug,
  sanitizeProjectSlug,
} from "../lib/project.ts";
import {
  discoverComposeServiceNames,
  migrateLegacyProjectEnv,
  projectEnvConfigExists,
  resolveProjectEnvConfig,
} from "../lib/project-env-config.ts";
import { resolveProjectExecutionTarget } from "../lib/project-execution.ts";
import {
  readProcessSnapshot,
  resolveLifecycleProcessGroupIdsForTmuxState,
  resolveLifecycleStopProcessGroupIds,
} from "../lib/project-lifecycle-processes.ts";
import {
  inspectListeningTcpPorts,
  resolveLifecycleSingletonDecision,
} from "../lib/project-lifecycle-singleton.ts";
import {
  readProjectRuntimeStateEntry,
  removeProjectRuntimeStateEntry,
  upsertProjectRuntimeStateEntry,
} from "../lib/project-runtime-state.ts";
import {
  readProjectsRegistry,
  resolveRegisteredProjectByName,
  upsertProjectRegistration,
} from "../lib/projects-registry.ts";
import {
  formatSecretStoreDescriptor,
  resolveSecretStore,
} from "../lib/secret-store.ts";
import { exec, run as runShell } from "../lib/shell.ts";
import { parseTimeInput } from "../lib/time.ts";
import { upsertAgentDocs } from "../mcp/agent-docs.ts";
import type { McpTarget } from "../mcp/install.ts";
import { installMcpConfig } from "../mcp/install.ts";
import type { MuxBackendName } from "../mux/mux-backend.ts";
import {
  getMuxBackends,
  resolveDefaultBackendName,
  resolveMux,
} from "../mux/mux-resolver.ts";
import { buildLifecycleSessionName } from "../mux/session-names.ts";
import {
  renderProjectConfigJson,
  renderProjectEnvConfigYaml,
} from "../templates.ts";
import { display } from "../ui/display.ts";
import { readLinesFromStream } from "../ui/lines.ts";
import type { LogStreamContext } from "../ui/log-stream.ts";
import { logger } from "../ui/logger.ts";
import { canReachLoki, requestLokiDelete } from "../ui/loki-logs.ts";

/** Regex for valid TLD/service/subdomain labels (lowercase alphanumeric with hyphens). */
const SLUG_LABEL_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Regex to match YAML labels block header. */
const LABELS_LINE_PATTERN = /^(\s*)labels:\s*$/;

/** Regex to extract leading whitespace (indentation). */
const INDENT_PATTERN = /^(\s*)/;

/** Regex to match caddy label line in YAML. */
const CADDY_LABEL_PATTERN = /^(\s*)caddy:\s*(.*)$/;

/** Regex to check if a string starts with a URL scheme (e.g., "http://", "https://"). */
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

const optManual = defineOption({
  name: "manual",
  type: "boolean",
  long: "--manual",
  description:
    "Skip discovery and define services manually (or generate a minimal compose in --auto)",
} as const);

const optAuto = defineOption({
  name: "auto",
  type: "boolean",
  long: "--auto",
  description: "Run non-interactive init with sensible defaults",
} as const);

const optName = defineOption({
  name: "name",
  type: "string",
  long: "--name",
  valueHint: "<slug>",
  description: "Project slug (default: repo name)",
} as const);

const optDevHost = defineOption({
  name: "devHost",
  type: "string",
  long: "--dev-host",
  valueHint: "<host>",
  description: "DEV_HOST override",
} as const);

const optOauth = defineOption({
  name: "oauth",
  type: "boolean",
  long: "--oauth",
  description: "Enable OAuth-safe alias host",
} as const);

const optOauthTld = defineOption({
  name: "oauthTld",
  type: "string",
  long: "--oauth-tld",
  valueHint: "<tld>",
  description: "OAuth alias TLD override (default: gy)",
} as const);

const optNoDiscovery = defineOption({
  name: "noDiscovery",
  type: "boolean",
  long: "--no-discovery",
  description: "Skip discovery and generate a minimal compose",
} as const);

const optTarget = defineOption({
  name: "target",
  type: "string",
  long: "--target",
  valueHint: "<auto|local|remote>",
  description:
    "Execution target routing (auto routes to remote when project execution mode requires it)",
} as const);

const initOptions = [
  optPath,
  optManual,
  optAuto,
  optName,
  optDevHost,
  optOauth,
  optOauthTld,
  optNoDiscovery,
] as const;
const upOptions = [
  optPath,
  optProject,
  optEnv,
  optBranch,
  optDetach,
  optProfile,
  optTarget,
] as const;
const downOptions = [
  optPath,
  optProject,
  optEnv,
  optBranch,
  optProfile,
  optTarget,
] as const;
const restartOptions = [
  optPath,
  optProject,
  optEnv,
  optBranch,
  optProfile,
  optTarget,
] as const;
const psOptions = [
  optPath,
  optProject,
  optBranch,
  optProfile,
  optJson,
] as const;
const optWorkdir = defineOption({
  name: "workdir",
  type: "string",
  long: "--workdir",
  valueHint: "<path>",
  description: "Working directory inside the container (docker compose run -w)",
} as const);
const runOptions = [
  optPath,
  optProject,
  optEnv,
  optBranch,
  optWorkdir,
  optProfile,
] as const;
const runPositionals = [
  { name: "service", required: true },
  { name: "cmd", required: false, multiple: true },
] as const;
const optLoki = defineOption({
  name: "loki",
  type: "boolean",
  long: "--loki",
  description: "Force Loki backend (do not fall back to docker compose logs)",
} as const);

const optCompose = defineOption({
  name: "compose",
  type: "boolean",
  long: "--compose",
  description: "Read logs directly from docker compose (bypass Loki)",
} as const);

const optServices = defineOption({
  name: "services",
  type: "string",
  long: "--services",
  valueHint: "<csv>",
  description: "Filter Loki logs by service(s), comma-separated (e.g. api,www)",
} as const);

const optQuery = defineOption({
  name: "query",
  type: "string",
  long: "--query",
  valueHint: "<logql>",
  description:
    "Raw LogQL selector/query (overrides auto selector built from project + services)",
} as const);

const logsOptions = [
  optPath,
  optProject,
  optBranch,
  optFollow,
  optNoFollow,
  optTail,
  optPretty,
  optJson,
  optProfile,
  optCompose,
  optLoki,
  optServices,
  optQuery,
  optSince,
  optUntil,
] as const;
const logsPositionals = [{ name: "service", required: false }] as const;
const openOptions = [optPath, optProject, optBranch, optJson] as const;
const openPositionals = [{ name: "target", required: false }] as const;

type InitArgs = CommandArgs<typeof initOptions, readonly []>;
type UpArgs = CommandArgs<typeof upOptions, readonly []>;
type DownArgs = CommandArgs<typeof downOptions, readonly []>;
type RestartArgs = CommandArgs<typeof restartOptions, readonly []>;
type PsArgs = CommandArgs<typeof psOptions, readonly []>;
type RunArgs = CommandArgs<typeof runOptions, typeof runPositionals>;
type ExecArgs = CommandArgs<typeof runOptions, typeof runPositionals>;
type LogsArgs = CommandArgs<typeof logsOptions, typeof logsPositionals>;
type OpenArgs = CommandArgs<typeof openOptions, typeof openPositionals>;

const initSpec = defineCommand({
  name: "init",
  summary: "Initialize a repo (generate .hack/ with compose + config)",
  group: "Project",
  options: initOptions,
  positionals: [],
  subcommands: [],
} as const);

export const initCommand = withHandler(initSpec, handleInit);

const upSpec = defineCommand({
  name: "up",
  summary: "Start project services (docker compose up)",
  group: "Project",
  options: upOptions,
  positionals: [],
  subcommands: [],
} as const);

export const upCommand = withHandler(upSpec, handleUp);

const downSpec = defineCommand({
  name: "down",
  summary: "Stop project services (docker compose down)",
  group: "Project",
  options: downOptions,
  positionals: [],
  subcommands: [],
} as const);

export const downCommand = withHandler(downSpec, handleDown);

const restartSpec = defineCommand({
  name: "restart",
  summary: "Restart project services (down then up)",
  group: "Project",
  options: restartOptions,
  positionals: [],
  subcommands: [],
} as const);

export const restartCommand = withHandler(restartSpec, handleRestart);

const psSpec = defineCommand({
  name: "ps",
  summary: "Show project status (docker compose ps)",
  group: "Project",
  options: psOptions,
  positionals: [],
  subcommands: [],
} as const);

export const psCommand = withHandler(psSpec, handlePs);

const runSpec = defineCommand({
  name: "run",
  summary:
    "Run a one-off command in a service container (docker compose run --rm)",
  group: "Project",
  options: runOptions,
  positionals: runPositionals,
  subcommands: [],
} as const);

export const runCommand = withHandler(runSpec, handleRun);

const execSpec = defineCommand({
  name: "exec",
  summary:
    "Run a command in an already-running service container (docker compose exec)",
  group: "Project",
  options: runOptions,
  positionals: runPositionals,
  subcommands: [],
} as const);

export const execCommand = withHandler(execSpec, handleExec);

const logsSpec = defineCommand({
  name: "logs",
  summary:
    "Tail logs (compose by default; Loki for queries/history via --loki/--query)",
  group: "Project",
  options: logsOptions,
  positionals: logsPositionals,
  subcommands: [],
} as const);

export const logsCommand = withHandler(logsSpec, handleLogs);

const openSpec = defineCommand({
  name: "open",
  summary: "Open a URL for the project (default: https://<project>.hack)",
  group: "Project",
  options: openOptions,
  positionals: openPositionals,
  subcommands: [],
} as const);

export const openCommand = withHandler(openSpec, handleOpen);

function resolveStartDir(ctx: CliContext, pathOpt: string | undefined): string {
  return pathOpt ? resolve(ctx.cwd, pathOpt) : ctx.cwd;
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

async function resolveProjectForArgs(opts: {
  readonly ctx: CliContext;
  readonly pathOpt: string | undefined;
  readonly projectOpt: string | undefined;
}) {
  if (opts.pathOpt && opts.projectOpt) {
    throw new CliUsageError("Use either --path or --project (not both).");
  }

  if (opts.projectOpt) {
    const name = sanitizeProjectSlug(opts.projectOpt);
    if (name.length === 0) {
      throw new CliUsageError("Invalid --project value.");
    }
    const fromRegistry = await resolveRegisteredProjectByName({ name });
    if (!fromRegistry) {
      throw new CliUsageError(
        `Unknown project "${name}". Run 'hack init' in that repo (or run 'hack projects' to see registered projects).`
      );
    }
    await touchProjectRegistration(fromRegistry);
    return fromRegistry;
  }

  const startDir = resolveStartDir(opts.ctx, opts.pathOpt);
  const project = await requireProjectContext(startDir);
  await touchProjectRegistration(project);
  return project;
}

function resolveBranchSlug(raw: string | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) {
    return null;
  }
  const slug = sanitizeBranchSlug(trimmed);
  return slug.length > 0 ? slug : "branch";
}

async function resolveComposeProjectName(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly cfg?: Awaited<ReturnType<typeof readProjectConfig>>;
}): Promise<string> {
  const composeName = await readComposeProjectName(opts.project.composeFile);
  if (composeName) {
    return composeName;
  }

  const derived = defaultProjectSlugFromPath(opts.project.projectRoot);
  const cfgName = (opts.cfg?.name ?? derived).trim();
  return cfgName.length > 0 ? cfgName : derived;
}

async function readComposeProjectName(
  composeFile: string
): Promise<string | null> {
  const text = await readTextFile(composeFile);
  if (!text) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }
  const name = getString(parsed, "name");
  const trimmed = name?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

async function buildBranchComposeOverride(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly branch: string;
  readonly devHost: string;
  readonly aliasHost: string | null;
}): Promise<string | null> {
  const yamlText = await readTextFile(opts.project.composeFile);
  if (!yamlText) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlText);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }

  const servicesRaw = parsed.services;
  if (!isRecord(servicesRaw)) {
    return null;
  }

  const baseHosts = [opts.devHost, opts.aliasHost].filter(
    (host): host is string => typeof host === "string" && host.length > 0
  );

  const overrideServices: Record<string, { labels: Record<string, string> }> =
    {};
  let changed = false;

  for (const [serviceName, serviceRaw] of Object.entries(servicesRaw)) {
    if (!isRecord(serviceRaw)) {
      continue;
    }

    const labels = normalizeLabels(serviceRaw.labels);
    if (!labels) {
      continue;
    }

    const caddyRaw = labels.caddy;
    if (typeof caddyRaw !== "string" || caddyRaw.trim().length === 0) {
      continue;
    }

    const rewritten = rewriteCaddyLabelForBranch({
      value: caddyRaw,
      branch: opts.branch,
      baseHosts,
    });
    if (!rewritten.changed) {
      continue;
    }

    labels.caddy = rewritten.value;
    overrideServices[serviceName] = { labels };
    changed = true;
  }

  if (!changed) {
    return null;
  }

  const override = { services: overrideServices };
  const yaml = YAML.stringify(override, null, 2);
  return ensureTrailingNewline(cleanupYaml(yaml));
}

function normalizeLabels(raw: unknown): Record<string, string> | null {
  if (isRecord(raw)) {
    return normalizeLabelRecord(raw);
  }

  if (Array.isArray(raw)) {
    return normalizeLabelList(raw);
  }

  return null;
}

function normalizeLabelRecord(
  raw: Record<string, unknown>
): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      out[k] = String(v);
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function normalizeLabelList(
  raw: readonly unknown[]
): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const item of raw) {
    const parsed = parseLabelEntry({ item });
    if (!parsed) {
      continue;
    }
    out[parsed.key] = parsed.value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function parseLabelEntry(opts: {
  readonly item: unknown;
}): { readonly key: string; readonly value: string } | null {
  if (typeof opts.item !== "string") {
    return null;
  }
  const idx = opts.item.indexOf("=");
  if (idx <= 0) {
    return null;
  }
  const key = opts.item.slice(0, idx).trim();
  if (key.length === 0) {
    return null;
  }
  const value = opts.item.slice(idx + 1).trim();
  return { key, value };
}

function rewriteCaddyLabelForBranch(opts: {
  readonly value: string;
  readonly branch: string;
  readonly baseHosts: readonly string[];
}): { readonly value: string; readonly changed: boolean } {
  const parts = opts.value
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);

  if (parts.length === 0) {
    return { value: opts.value, changed: false };
  }

  const out: string[] = [];
  const seen = new Set<string>();
  let changed = false;

  for (const host of parts) {
    let next = host;
    for (const baseHost of opts.baseHosts) {
      const rewritten = rewriteHostForBranch({
        host,
        branch: opts.branch,
        baseHost,
      });
      if (rewritten.changed) {
        next = rewritten.host;
        changed = true;
        break;
      }
    }

    if (seen.has(next)) {
      continue;
    }
    seen.add(next);
    out.push(next);
  }

  return { value: out.join(", "), changed };
}

function rewriteHostForBranch(opts: {
  readonly host: string;
  readonly branch: string;
  readonly baseHost: string;
}): { readonly host: string; readonly changed: boolean } {
  if (opts.host === opts.baseHost) {
    const next = `${opts.branch}.${opts.baseHost}`;
    return { host: next, changed: next !== opts.host };
  }

  const suffix = `.${opts.baseHost}`;
  if (!opts.host.endsWith(suffix)) {
    return { host: opts.host, changed: false };
  }

  const prefix = opts.host.slice(0, opts.host.length - suffix.length);
  if (prefix === opts.branch || prefix.endsWith(`.${opts.branch}`)) {
    return { host: opts.host, changed: false };
  }

  return { host: `${prefix}.${opts.branch}.${opts.baseHost}`, changed: true };
}

function applyBranchToHost(opts: {
  readonly host: string;
  readonly branch: string;
  readonly baseHosts: readonly string[];
}): string {
  for (const baseHost of opts.baseHosts) {
    const rewritten = rewriteHostForBranch({
      host: opts.host,
      branch: opts.branch,
      baseHost,
    });
    if (rewritten.changed) {
      return rewritten.host;
    }
  }
  return opts.host;
}

function cleanupYaml(yaml: string): string {
  return yaml.replaceAll(/: \n/g, ":\n");
}

async function readInternalExtraHostsFile(opts: {
  readonly projectDir: string;
}): Promise<Record<string, string>> {
  const path = resolve(opts.projectDir, ".internal", "extra-hosts.json");
  const text = await readTextFile(path);
  if (!text) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  const out: Record<string, string> = {};
  for (const [keyRaw, valueRaw] of Object.entries(
    parsed as Record<string, unknown>
  )) {
    const key = keyRaw.trim();
    if (key.length === 0) {
      continue;
    }
    if (typeof valueRaw !== "string") {
      continue;
    }
    const value = valueRaw.trim();
    if (value.length === 0) {
      continue;
    }
    out[key] = value;
  }

  return out;
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function buildComposeEnvInterpolation(key: string): string {
  return `\${${key}}`;
}

function isEnvVarRelevantToServices(opts: {
  readonly services: readonly string[];
  readonly varServices: readonly string[] | null;
}): boolean {
  if (!opts.varServices) {
    return true;
  }
  if (opts.services.length === 0) {
    return true;
  }
  const serviceSet = new Set(opts.services);
  return opts.varServices.some((svc) => serviceSet.has(svc));
}

async function maybePromptLegacyProjectEnvMigration(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly projectName: string;
  readonly serviceNames: readonly string[];
}): Promise<boolean> {
  if (
    await projectEnvConfigExists({
      projectDir: opts.project.projectDir,
    })
  ) {
    return false;
  }

  const contractPath = resolve(
    opts.project.projectDir,
    PROJECT_ENV_CONTRACT_FILENAME
  );
  if (!(await pathExists(contractPath))) {
    return false;
  }

  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    logger.warn({
      message:
        "Legacy env format detected. Run `hack doctor --migrate-env-config` to upgrade to the new env config files.",
    });
    return false;
  }

  const shouldMigrate = await confirm({
    message:
      "Legacy env format detected. Migrate to the new Hack env config files now?",
    initialValue: true,
  });
  if (isCancel(shouldMigrate)) {
    throw new Error("Canceled");
  }
  if (!shouldMigrate) {
    return false;
  }

  const migrated = await migrateLegacyProjectEnv({
    projectRoot: opts.project.projectRoot,
    projectDir: opts.project.projectDir,
    projectName: opts.projectName,
    serviceNames: opts.serviceNames,
    materialize: false,
  });
  if (migrated.wroteFiles.length > 0) {
    logger.info({
      message: `Migrated env config: ${migrated.wroteFiles.join(", ")}`,
    });
  }
  return migrated.legacyDetected;
}

async function resolveModernComposeEnvOverrides(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly targetServices: readonly string[];
  readonly allServiceNames: readonly string[];
  readonly envName?: string | null;
}): Promise<{
  readonly composeFiles: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly effectiveEnvName: string | null;
} | null> {
  const modern = await resolveProjectEnvConfig({
    projectRoot: opts.project.projectRoot,
    projectDir: opts.project.projectDir,
    envName: opts.envName,
    serviceNames: opts.allServiceNames,
  });
  if (!modern) {
    return null;
  }

  for (const scope of modern.unknownScopes) {
    logger.warn({
      message: `Env config scope "${scope}" does not match a known service in ${opts.project.composeFile}.`,
    });
  }

  const overrideServices: Record<string, Record<string, unknown>> = {};
  for (const service of opts.targetServices) {
    const env = modern.serviceEnv[service] ?? modern.globalEnv;
    if (Object.keys(env).length === 0) {
      continue;
    }
    overrideServices[service] = { environment: env };
  }

  if (Object.keys(overrideServices).length === 0) {
    return {
      composeFiles: [],
      env: modern.globalEnv,
      effectiveEnvName: modern.selection.effectiveEnv,
    };
  }

  const override = { services: overrideServices };
  const yaml = YAML.stringify(override, null, 2);
  const text = ensureTrailingNewline(cleanupYaml(yaml));
  const overrideDir = resolve(opts.project.projectDir, ".internal");
  await ensureDir(overrideDir);
  const overridePath = resolve(overrideDir, "compose.env.override.yml");
  await writeTextFileIfChanged(overridePath, text);
  return {
    composeFiles: [overridePath],
    env: modern.globalEnv,
    effectiveEnvName: modern.selection.effectiveEnv,
  };
}

async function resolveLifecycleEnvForProject(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly projectName: string;
  readonly envName?: string | null;
}): Promise<Readonly<Record<string, string>>> {
  const serviceNames = await discoverComposeServiceNames({
    composeFile: opts.project.composeFile,
  });
  await maybePromptLegacyProjectEnvMigration({
    project: opts.project,
    projectName: opts.projectName,
    serviceNames,
  });
  const modern = await resolveProjectEnvConfig({
    projectRoot: opts.project.projectRoot,
    projectDir: opts.project.projectDir,
    envName: opts.envName,
    serviceNames,
  });
  if (modern) {
    return modern.globalEnv;
  }

  const envResolved = await resolveHackEnv({
    projectDir: opts.project.projectDir,
    projectName: opts.projectName,
    envName: opts.envName,
  });
  if (envResolved.contractParseError) {
    logger.warn({
      message: `Failed to parse ${envResolved.contractPath}: ${envResolved.contractParseError}`,
    });
  }
  return envResolved.envForCompose;
}

async function resolveComposeEnvOverrides(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly projectName: string;
  readonly targetServices: readonly string[];
  readonly allServiceNames: readonly string[];
  readonly envName?: string | null;
}): Promise<{
  readonly composeFiles: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly effectiveEnvName: string | null;
}> {
  await maybePromptLegacyProjectEnvMigration({
    project: opts.project,
    projectName: opts.projectName,
    serviceNames: opts.allServiceNames,
  });
  const modern = await resolveModernComposeEnvOverrides(opts);
  if (modern) {
    return modern;
  }

  const resolved = await resolveHackEnv({
    projectDir: opts.project.projectDir,
    projectName: opts.projectName,
    envName: opts.envName,
  });
  logRelevantLegacyEnvWarnings({
    resolved,
    targetServices: opts.targetServices,
  });

  if (resolved.contract.vars.length === 0) {
    return {
      composeFiles: [],
      env: {},
      effectiveEnvName: resolved.envSelection.effectiveEnv,
    };
  }

  const shouldRetry = await maybeResolveMissingLegacyEnv({
    resolved,
    targetServices: opts.targetServices,
    projectName: opts.projectName,
    projectDir: opts.project.projectDir,
  });
  if (shouldRetry) {
    return await resolveComposeEnvOverrides(opts);
  }

  const overrideServices: Record<string, Record<string, unknown>> = {};
  for (const service of opts.targetServices) {
    const env: Record<string, string> = {};
    for (const v of resolved.values) {
      if (v.value === null) {
        continue;
      }
      if (
        !isEnvVarRelevantToServices({
          services: [service],
          varServices: v.services,
        })
      ) {
        continue;
      }
      env[v.key] = buildComposeEnvInterpolation(v.key);
    }
    if (Object.keys(env).length > 0) {
      overrideServices[service] = { environment: env };
    }
  }

  if (Object.keys(overrideServices).length === 0) {
    return {
      composeFiles: [],
      env: resolved.envForCompose,
      effectiveEnvName: resolved.envSelection.effectiveEnv,
    };
  }

  const override = { services: overrideServices };
  const yaml = YAML.stringify(override, null, 2);
  const text = ensureTrailingNewline(cleanupYaml(yaml));
  const overrideDir = resolve(opts.project.projectDir, ".internal");
  await ensureDir(overrideDir);
  const overridePath = resolve(overrideDir, "compose.env.override.yml");
  await writeTextFileIfChanged(overridePath, text);

  return {
    composeFiles: [overridePath],
    env: resolved.envForCompose,
    effectiveEnvName: resolved.envSelection.effectiveEnv,
  };
}

function logRelevantLegacyEnvWarnings(opts: {
  readonly resolved: Awaited<ReturnType<typeof resolveHackEnv>>;
  readonly targetServices: readonly string[];
}): void {
  if (opts.resolved.contractParseError) {
    logger.warn({
      message: `Failed to parse ${opts.resolved.contractPath}: ${opts.resolved.contractParseError}`,
    });
  }

  for (const warning of opts.resolved.warnings) {
    if (
      !isEnvVarRelevantToServices({
        services: opts.targetServices,
        varServices: warning.services,
      })
    ) {
      continue;
    }
    logger.warn({ message: warning.message });
  }
}

async function maybeResolveMissingLegacyEnv(opts: {
  readonly resolved: Awaited<ReturnType<typeof resolveHackEnv>>;
  readonly targetServices: readonly string[];
  readonly projectName: string;
  readonly projectDir: string;
}): Promise<boolean> {
  const missingRelevant = opts.resolved.missingRequired.filter((value) =>
    isEnvVarRelevantToServices({
      services: opts.targetServices,
      varServices: value.services,
    })
  );
  if (missingRelevant.length === 0) {
    return false;
  }

  const fixed = await maybePromptToFixMissingEnv({
    missing: missingRelevant,
    envFile: resolve(opts.projectDir, PROJECT_ENV_FILENAME),
    projectName: opts.projectName,
    projectDir: opts.projectDir,
  });
  if (fixed) {
    return true;
  }

  const keys = missingRelevant.map((value) => value.key).join(", ");
  logger.error({
    message: `Missing required env: ${keys}`,
  });
  logger.info({
    message:
      "Run: hack env set KEY=VALUE (or: hack env set --secret KEY=VALUE)",
  });
  throw new Error("Missing required env");
}

async function maybePromptToFixMissingEnv(opts: {
  readonly missing: readonly {
    readonly key: string;
    readonly source: "plain_env" | "keychain";
  }[];
  readonly envFile: string;
  readonly projectName: string;
  readonly projectDir: string;
}): Promise<boolean> {
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    return false;
  }

  await display.panel({
    title: "Missing required env",
    tone: "warn",
    lines: [
      ...opts.missing.map((v) => `- ${v.key} (${v.source})`),
      "",
      "Fill them in now?",
    ],
  });

  const ok = await confirm({
    message: "Set missing env now?",
    initialValue: true,
  });
  if (isCancel(ok)) {
    throw new Error("Canceled");
  }
  if (!ok) {
    return false;
  }

  const secretStore = await resolveSecretStore({
    projectName: opts.projectName,
    projectDir: opts.projectDir,
  });
  const secretLabel = formatSecretStoreDescriptor({
    descriptor: secretStore.descriptor,
  });

  for (const v of opts.missing) {
    const value =
      v.source === "keychain"
        ? await password({
            message: `Value for secret "${v.key}" (${secretLabel}):`,
            validate: (input) =>
              !input || input.length === 0 ? "Required" : undefined,
          })
        : await text({
            message: `Value for "${v.key}" (${opts.envFile}):`,
            validate: (input) =>
              !input || input.length === 0 ? "Required" : undefined,
          });

    if (isCancel(value)) {
      throw new Error("Canceled");
    }

    if (v.source === "keychain") {
      await secretStore.set({ key: v.key, value });
    } else {
      await upsertDotEnvValue({ envFile: opts.envFile, key: v.key, value });
    }
  }

  return true;
}

function resolveLifecycleSessionName(opts: {
  readonly projectName: string;
  readonly branch: string | null;
}): string {
  return buildLifecycleSessionName(opts);
}

function resolveLifecycleCwd(opts: {
  readonly projectRoot: string;
  readonly cwd: string | undefined;
}): string {
  const raw = (opts.cwd ?? "").trim();
  if (raw.length === 0) {
    return opts.projectRoot;
  }
  if (raw.startsWith("/")) {
    return raw;
  }
  return resolve(opts.projectRoot, raw);
}

async function runLifecycleCommands(opts: {
  readonly title: string;
  readonly commands: readonly ProjectLifecycleCommand[] | undefined;
  readonly projectRoot: string;
  readonly env: Readonly<Record<string, string>>;
  readonly projectDir: string;
  readonly composeProject: string;
  readonly onPersistentCommand?: (opts: {
    readonly command: ProjectLifecycleCommand;
    readonly index: number;
    readonly serviceName: string;
  }) => Promise<void>;
}): Promise<number> {
  const commands = opts.commands ?? [];
  for (const [index, cmd] of commands.entries()) {
    const label = cmd.name ? `${cmd.name}: ${cmd.command}` : cmd.command;
    logger.step({ message: `${opts.title}: ${label}` });
    const serviceName = resolveLifecycleCommandServiceName({
      command: cmd,
      index,
    });
    if (cmd.persistent === true && opts.onPersistentCommand) {
      try {
        await opts.onPersistentCommand({
          command: cmd,
          index,
          serviceName,
        });
      } catch (error: unknown) {
        const message =
          error instanceof Error
            ? error.message
            : `Failed to start persistent lifecycle command: ${serviceName}`;
        logger.error({ message });
        return 1;
      }
      continue;
    }
    if (cmd.persistent === true) {
      logger.warn({
        message:
          `Ignoring persistent mode for "${serviceName}" in ${opts.title};` +
          " persistent lifecycle commands are only non-blocking in up.before.",
      });
    }

    const cwd = resolveLifecycleCwd({
      projectRoot: opts.projectRoot,
      cwd: cmd.cwd,
    });

    await appendLifecycleLogRecord({
      projectDir: opts.projectDir,
      composeProject: opts.composeProject,
      record: {
        timestamp: new Date().toISOString(),
        service: serviceName,
        stream: "meta",
        message: `[start] ${opts.title}: ${label}`,
      },
    });

    const proc = Bun.spawn(["sh", "-c", cmd.command], {
      cwd,
      env: await mergeLifecycleCommandEnv(opts.env),
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdoutTask = streamLifecycleCommandOutput({
      stream: proc.stdout,
      output: "stdout",
      projectDir: opts.projectDir,
      composeProject: opts.composeProject,
      service: serviceName,
    });
    const stderrTask = streamLifecycleCommandOutput({
      stream: proc.stderr,
      output: "stderr",
      projectDir: opts.projectDir,
      composeProject: opts.composeProject,
      service: serviceName,
    });

    const exitCode = await proc.exited;
    await Promise.all([stdoutTask, stderrTask]);

    await appendLifecycleLogRecord({
      projectDir: opts.projectDir,
      composeProject: opts.composeProject,
      record: {
        timestamp: new Date().toISOString(),
        service: serviceName,
        stream: "meta",
        message: `[end] ${opts.title}: exit ${exitCode}`,
      },
    });

    if (exitCode !== 0) {
      logger.error({
        message: `${opts.title} failed (exit ${exitCode}): ${label}`,
      });
      return exitCode;
    }
  }
  return 0;
}

type StartedLifecycleProcess = {
  readonly name: string;
  readonly windowName: string;
  readonly logPath: string;
};

function hasPersistentLifecycleCommands(
  commands: readonly ProjectLifecycleCommand[] | undefined
): boolean {
  return (commands ?? []).some((command) => command.persistent === true);
}

async function runLifecycleUpBeforeAndProcesses(opts: {
  readonly title: string;
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
  readonly projectName: string;
  readonly branch: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly composeProject: string;
}): Promise<{ readonly code: number; readonly sessionName: string | null }> {
  const beforeCommands = opts.cfg.lifecycle?.up?.before;
  if (!hasPersistentLifecycleCommands(beforeCommands)) {
    const beforeCode = await runLifecycleCommands({
      title: opts.title,
      commands: beforeCommands,
      projectRoot: opts.project.projectRoot,
      env: opts.env,
      projectDir: opts.project.projectDir,
      composeProject: opts.composeProject,
    });
    if (beforeCode !== 0) {
      return { code: beforeCode, sessionName: null };
    }
    await startLifecycleProcesses({
      project: opts.project,
      cfg: opts.cfg,
      projectName: opts.projectName,
      branch: opts.branch,
      env: opts.env,
      composeProject: opts.composeProject,
    });
    const hasProcesses = (opts.cfg.lifecycle?.processes ?? []).length > 0;
    return {
      code: 0,
      sessionName: hasProcesses
        ? resolveLifecycleSessionName({
            projectName: opts.projectName,
            branch: opts.branch,
          })
        : null,
    };
  }

  const starter = createLifecycleProcessStarter({
    project: opts.project,
    projectName: opts.projectName,
    branch: opts.branch,
    env: opts.env,
    composeProject: opts.composeProject,
  });
  const beforeCode = await runLifecycleCommands({
    title: opts.title,
    commands: beforeCommands,
    projectRoot: opts.project.projectRoot,
    env: opts.env,
    projectDir: opts.project.projectDir,
    composeProject: opts.composeProject,
    onPersistentCommand: async ({ command, serviceName }) => {
      await starter.startFromCommand({
        command,
        serviceName,
      });
    },
  });
  if (beforeCode !== 0) {
    await starter.abort();
    return { code: beforeCode, sessionName: null };
  }

  try {
    await starter.startMany({
      processes: opts.cfg.lifecycle?.processes ?? [],
    });
    await starter.finalize();
  } catch (error: unknown) {
    await starter.abort();
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("Failed to start lifecycle processes");
  }

  return {
    code: 0,
    sessionName: starter.hasStarted() ? starter.sessionName : null,
  };
}

function createLifecycleProcessStarter(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly projectName: string;
  readonly branch: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly composeProject: string;
}): {
  readonly sessionName: string;
  startFromCommand: (opts: {
    readonly command: ProjectLifecycleCommand;
    readonly serviceName: string;
  }) => Promise<void>;
  startMany: (opts: {
    readonly processes: readonly ProjectLifecycleProcess[];
  }) => Promise<void>;
  finalize: () => Promise<void>;
  abort: () => Promise<void>;
  hasStarted: () => boolean;
} {
  const sessionName = resolveLifecycleSessionName({
    projectName: opts.projectName,
    branch: opts.branch,
  });
  const startedProcesses: StartedLifecycleProcess[] = [];
  let backendName: MuxBackendName | null = null;
  let sessionReady = false;
  let existingSessionCleared = false;
  let nextIndex = 0;

  const ensureExistingSessionCleared = async (): Promise<void> => {
    if (existingSessionCleared) {
      return;
    }
    await killLifecycleSessionByName({ sessionName });
    existingSessionCleared = true;
  };

  const ensureSession = async (): Promise<void> => {
    if (sessionReady) {
      return;
    }
    const mux = await resolveMux({ project: opts.project });
    const resolvedBackend = resolveDefaultBackendName({
      mode: mux.mode,
      backends: mux.backends,
    });
    if (!resolvedBackend) {
      throw new Error(
        [
          "No session mux backend available for lifecycle processes.",
          "Install tmux or zellij, or set sessions.mux to auto|tmux|zellij.",
        ].join("\n")
      );
    }
    const backend = mux.backends.get(resolvedBackend);
    if (!backend?.available) {
      throw new Error(`${resolvedBackend} is not available`);
    }
    await ensureExistingSessionCleared();
    const created = await backend.createSession({
      name: sessionName,
      cwd: opts.project.projectRoot,
    });
    if (!created.ok) {
      throw new Error(`Failed to create lifecycle session: ${sessionName}`);
    }
    if (resolvedBackend === "tmux") {
      for (const [key, value] of Object.entries(opts.env)) {
        await exec(["tmux", "set-environment", "-t", sessionName, key, value], {
          stdin: "ignore",
        });
      }
    }
    backendName = resolvedBackend;
    sessionReady = true;
  };

  const startProcess = async (
    process: ProjectLifecycleProcess
  ): Promise<void> => {
    await ensureExistingSessionCleared();
    const singletonDecision = await resolveLifecycleSingletonDecisionForProcess(
      {
        process,
        projectDir: opts.project.projectDir,
        composeProject: opts.composeProject,
      }
    );
    if (singletonDecision.kind === "adopt") {
      logger.info({ message: singletonDecision.message });
      return;
    }
    if (singletonDecision.kind === "fail") {
      throw new Error(singletonDecision.message);
    }

    await ensureSession();
    const started = await startLifecycleProcess({
      backend: backendName as MuxBackendName,
      sessionName,
      projectRoot: opts.project.projectRoot,
      env: opts.env,
      index: nextIndex,
      process,
      projectDir: opts.project.projectDir,
      composeProject: opts.composeProject,
    });
    nextIndex += 1;
    startedProcesses.push(started);
  };

  return {
    sessionName,
    startFromCommand: async ({ command, serviceName }) => {
      await startProcess({
        name: serviceName,
        command: command.command,
        ...(command.cwd ? { cwd: command.cwd } : {}),
        ...(command.singleton ? { singleton: command.singleton } : {}),
      });
    },
    startMany: async ({ processes }) => {
      for (const process of processes) {
        await startProcess(process);
      }
    },
    finalize: async () => {
      if (startedProcesses.length === 0 || !backendName) {
        await removeLifecycleStateEntry({
          projectDir: opts.project.projectDir,
          composeProject: opts.composeProject,
        });
        return;
      }
      await upsertLifecycleStateEntry({
        projectDir: opts.project.projectDir,
        entry: {
          composeProject: opts.composeProject,
          projectName: opts.projectName,
          branch: opts.branch,
          sessionName,
          backend: backendName,
          processes: startedProcesses,
          updatedAt: new Date().toISOString(),
        },
      });
    },
    abort: async () => {
      if (sessionReady) {
        await killLifecycleSessionByName({ sessionName });
      }
      await removeLifecycleStateEntry({
        projectDir: opts.project.projectDir,
        composeProject: opts.composeProject,
      });
    },
    hasStarted: () => startedProcesses.length > 0,
  };
}

async function killLifecycleSessionByName(opts: {
  readonly sessionName: string;
}): Promise<void> {
  const backends = getMuxBackends();
  for (const backend of backends.values()) {
    if (!backend.available) {
      continue;
    }
    const sessions = await backend.listSessions();
    if (!sessions.some((session) => session.name === opts.sessionName)) {
      continue;
    }
    await backend.killSession({ name: opts.sessionName });
  }
}

async function startLifecycleProcesses(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
  readonly projectName: string;
  readonly branch: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly composeProject: string;
}): Promise<void> {
  const processes = opts.cfg.lifecycle?.processes ?? [];
  if (processes.length === 0) {
    await removeLifecycleStateEntry({
      projectDir: opts.project.projectDir,
      composeProject: opts.composeProject,
    });
    return;
  }

  const starter = createLifecycleProcessStarter({
    project: opts.project,
    projectName: opts.projectName,
    branch: opts.branch,
    env: opts.env,
    composeProject: opts.composeProject,
  });
  try {
    await starter.startMany({ processes });
    await starter.finalize();
  } catch (error: unknown) {
    await starter.abort();
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("Failed to start lifecycle processes");
  }
}

async function resolveLifecycleSingletonDecisionForProcess(opts: {
  readonly process: ProjectLifecycleProcess;
  readonly projectDir: string;
  readonly composeProject: string;
}): Promise<
  | ReturnType<typeof resolveLifecycleSingletonDecision>
  | Promise<ReturnType<typeof resolveLifecycleSingletonDecision>>
> {
  if (!opts.process.singleton) {
    return { kind: "start" };
  }

  const occupiedPorts = await inspectListeningTcpPorts({
    ports: opts.process.singleton.ports,
  });
  const decision = resolveLifecycleSingletonDecision({
    singleton: opts.process.singleton,
    occupiedPorts,
    serviceName: opts.process.name,
  });

  if (decision.kind === "adopt") {
    await appendLifecycleLogRecord({
      projectDir: opts.projectDir,
      composeProject: opts.composeProject,
      record: {
        timestamp: new Date().toISOString(),
        service: opts.process.name,
        stream: "meta",
        message: `[adopt] ${decision.message}`,
      },
    });
  }

  return decision;
}

async function streamLifecycleCommandOutput(opts: {
  readonly stream: ReadableStream<Uint8Array> | number | null;
  readonly output: "stdout" | "stderr";
  readonly projectDir: string;
  readonly composeProject: string;
  readonly service: string;
}): Promise<void> {
  if (!opts.stream || typeof opts.stream === "number") {
    return;
  }
  for await (const line of readLinesFromStream(opts.stream)) {
    if (opts.output === "stderr") {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
    await appendLifecycleLogRecord({
      projectDir: opts.projectDir,
      composeProject: opts.composeProject,
      record: {
        timestamp: new Date().toISOString(),
        service: opts.service,
        stream: opts.output,
        message: line,
      },
    });
  }
}

async function startLifecycleProcess(opts: {
  readonly backend: MuxBackendName;
  readonly sessionName: string;
  readonly projectRoot: string;
  readonly env: Readonly<Record<string, string>>;
  readonly index: number;
  readonly process: ProjectLifecycleProcess;
  readonly projectDir: string;
  readonly composeProject: string;
}): Promise<{
  readonly name: string;
  readonly windowName: string;
  readonly logPath: string;
  readonly panePid?: number;
  readonly processGroupId?: number;
}> {
  const windowNameRaw = sanitizeBranchSlug(opts.process.name);
  const windowName =
    windowNameRaw.length > 0 ? windowNameRaw : `proc-${opts.index + 1}`;
  const cwd = resolveLifecycleCwd({
    projectRoot: opts.projectRoot,
    cwd: opts.process.cwd,
  });
  const logPath = resolveLifecycleLogPath({
    projectDir: opts.projectDir,
    composeProject: opts.composeProject,
  });
  const wrappedCommand = wrapLifecyclePersistentCommand({
    command: opts.process.command,
    logPath,
    serviceName: opts.process.name,
  });

  if (opts.backend === "tmux") {
    const result = await exec(
      [
        "tmux",
        "new-window",
        "-t",
        opts.sessionName,
        "-n",
        windowName,
        "-c",
        cwd,
        "sh",
        "-c",
        wrappedCommand,
      ],
      { stdin: "ignore" }
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to start lifecycle process "${opts.process.name}": ${result.stderr.trim()}`
      );
    }
    const panePids = await readTmuxPanePids({
      sessionName: opts.sessionName,
      windowName,
    });
    const panePid = panePids[0];
    const processGroupId =
      panePid !== undefined
        ? await readProcessGroupIdForPid({ pid: panePid })
        : null;
    await appendLifecycleLogRecord({
      projectDir: opts.projectDir,
      composeProject: opts.composeProject,
      record: {
        timestamp: new Date().toISOString(),
        service: opts.process.name,
        stream: "meta",
        message: `[start] process launched in tmux:${opts.sessionName}:${windowName}`,
      },
    });
    return {
      name: opts.process.name,
      windowName,
      logPath,
      ...(panePid !== undefined ? { panePid } : {}),
      ...(processGroupId ? { processGroupId } : {}),
    };
  }

  const result = await exec(
    ["zellij", "run", "--", "sh", "-c", wrappedCommand],
    {
      stdin: "ignore",
      cwd,
      env: { ...opts.env, ZELLIJ_SESSION_NAME: opts.sessionName },
    }
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to start lifecycle process "${opts.process.name}": ${result.stderr.trim()}`
    );
  }
  await appendLifecycleLogRecord({
    projectDir: opts.projectDir,
    composeProject: opts.composeProject,
    record: {
      timestamp: new Date().toISOString(),
      service: opts.process.name,
      stream: "meta",
      message: `[start] process launched in zellij:${opts.sessionName}:${windowName}`,
    },
  });
  return {
    name: opts.process.name,
    windowName,
    logPath,
  };
}

async function stopLifecycleProcesses(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
  readonly projectName: string;
  readonly branch: string | null;
  readonly composeProject: string;
}): Promise<void> {
  const lifecycle = opts.cfg.lifecycle;
  if (!lifecycle) {
    await removeLifecycleStateEntry({
      projectDir: opts.project.projectDir,
      composeProject: opts.composeProject,
    });
    return;
  }

  const sessionName = resolveLifecycleSessionName({
    projectName: opts.projectName,
    branch: opts.branch,
  });
  const lifecycleEntries = await readLifecycleState({
    projectDir: opts.project.projectDir,
  });
  const lifecycleEntry =
    lifecycleEntries.find(
      (entry) => entry.composeProject === opts.composeProject
    ) ?? null;

  const backends = getMuxBackends();
  let matchedLiveSession = false;
  for (const backend of backends.values()) {
    if (!backend.available) {
      continue;
    }
    const sessions = await backend.listSessions();
    if (!sessions.some((s) => s.name === sessionName)) {
      continue;
    }
    matchedLiveSession = true;
    if (backend.name === "tmux") {
      await interruptLifecycleTmuxProcesses({
        sessionName,
        lifecycleEntry,
      });
    }
    await backend.killSession({ name: sessionName });
  }

  await terminateLifecycleProcessGroups({
    processGroupIds: await resolveLifecycleStopProcessGroupIdsForEntry({
      matchedLiveSession,
      lifecycleEntry,
    }),
  });

  await removeLifecycleStateEntry({
    projectDir: opts.project.projectDir,
    composeProject: opts.composeProject,
  });
}

async function interruptLifecycleTmuxProcesses(opts: {
  readonly sessionName: string;
  readonly lifecycleEntry: LifecycleStateEntry | null;
}): Promise<void> {
  const processWindows = opts.lifecycleEntry?.processes ?? [];
  if (processWindows.length === 0) {
    return;
  }

  for (const processInfo of processWindows) {
    await exec(
      [
        "tmux",
        "send-keys",
        "-t",
        `${opts.sessionName}:${processInfo.windowName}`,
        "C-c",
      ],
      { stdin: "ignore" }
    );
  }

  await Bun.sleep(750);
  await terminateLifecycleProcessGroups({
    processGroupIds: await resolveLifecycleProcessGroupIds({
      sessionName: opts.sessionName,
      lifecycleEntry: opts.lifecycleEntry,
    }),
  });
}

async function readTmuxPanePids(opts: {
  readonly sessionName: string;
  readonly windowName: string;
}): Promise<number[]> {
  const result = await exec(
    [
      "tmux",
      "list-panes",
      "-t",
      `${opts.sessionName}:${opts.windowName}`,
      "-F",
      "#{pane_pid}",
    ],
    { stdin: "ignore" }
  );
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
}

async function readProcessGroupIdForPid(opts: {
  readonly pid: number;
}): Promise<number | null> {
  const result = await exec(["ps", "-o", "pgid=", "-p", String(opts.pid)], {
    stdin: "ignore",
  });
  if (result.exitCode !== 0) {
    return null;
  }
  const parsed = Number.parseInt(result.stdout.trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function resolveLifecycleProcessGroupIds(opts: {
  readonly sessionName: string;
  readonly lifecycleEntry: LifecycleStateEntry | null;
}): Promise<number[]> {
  const panePidsByWindow = new Map<string, readonly number[]>();
  for (const processInfo of opts.lifecycleEntry?.processes ?? []) {
    const panePids = await readTmuxPanePids({
      sessionName: opts.sessionName,
      windowName: processInfo.windowName,
    });
    panePidsByWindow.set(processInfo.windowName, panePids);
  }

  return resolveLifecycleProcessGroupIdsForTmuxState({
    lifecycleEntry: opts.lifecycleEntry,
    panePidsByWindow,
    snapshot: await readProcessSnapshot(),
  });
}

async function resolveLifecycleStopProcessGroupIdsForEntry(opts: {
  readonly matchedLiveSession: boolean;
  readonly lifecycleEntry: LifecycleStateEntry | null;
}): Promise<number[]> {
  return resolveLifecycleStopProcessGroupIds({
    matchedLiveSession: opts.matchedLiveSession,
    lifecycleEntry: opts.lifecycleEntry,
    snapshot: await readProcessSnapshot(),
  });
}

async function terminateLifecycleProcessGroups(opts: {
  readonly processGroupIds: readonly number[];
}): Promise<void> {
  const groups = [...new Set(opts.processGroupIds)].filter(
    (processGroupId) => processGroupId > 1
  );
  if (groups.length === 0) {
    return;
  }

  for (const processGroupId of groups) {
    try {
      process.kill(-processGroupId, "SIGTERM");
    } catch {
      // Ignore groups that already exited between snapshot and shutdown.
    }
  }

  await Bun.sleep(500);

  for (const processGroupId of groups) {
    try {
      process.kill(-processGroupId, 0);
    } catch {
      continue;
    }
    try {
      process.kill(-processGroupId, "SIGKILL");
    } catch {
      // Ignore groups that exited after the SIGTERM grace period.
    }
  }
}

function resolveLifecycleCommandServiceName(opts: {
  readonly command: ProjectLifecycleCommand;
  readonly index: number;
}): string {
  const fromName = (opts.command.name ?? "").trim();
  if (fromName.length > 0) {
    return fromName;
  }
  return `hook-${opts.index + 1}`;
}

export function wrapLifecyclePersistentCommand(opts: {
  readonly command: string;
  readonly logPath: string;
  readonly serviceName: string;
}): string {
  const logPath = shellSingleQuote(opts.logPath);
  const service = shellSingleQuote(opts.serviceName);
  const command = shellSingleQuote(opts.command);
  return [
    `HACK_LIFECYCLE_LOG=${logPath}`,
    `HACK_LIFECYCLE_SERVICE=${service}`,
    `HACK_LIFECYCLE_COMMAND=${command}`,
    `fifo="$(mktemp -u "\${TMPDIR:-/tmp}/hack-lifecycle.XXXXXX")"`,
    'mkfifo "$fifo"',
    "cleanup_lifecycle() {",
    "  trap - EXIT INT TERM HUP",
    `  if [ -n "\${cmd_pid:-}" ]; then`,
    "    if [ -x /bin/kill ]; then",
    '      /bin/kill -TERM -- "-$cmd_pid" 2>/dev/null || /bin/kill "$cmd_pid" 2>/dev/null || true',
    "    elif [ -x /usr/bin/kill ]; then",
    '      /usr/bin/kill -TERM -- "-$cmd_pid" 2>/dev/null || /usr/bin/kill "$cmd_pid" 2>/dev/null || true',
    "    else",
    '      kill "$cmd_pid" 2>/dev/null || true',
    "    fi",
    '    wait "$cmd_pid" 2>/dev/null || true',
    "  fi",
    `  if [ -n "\${reader_pid:-}" ]; then`,
    '    wait "$reader_pid" 2>/dev/null || true',
    "  fi",
    '  rm -f "$fifo"',
    "}",
    'trap "cleanup_lifecycle; exit 130" INT TERM HUP',
    'trap "cleanup_lifecycle" EXIT',
    "( while IFS= read -r line; do",
    '    printf "%s\\n" "$line"',
    '    printf \'%s\\t%s\\tstdout\\t%s\\n\' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$HACK_LIFECYCLE_SERVICE" "$line" >> "$HACK_LIFECYCLE_LOG"',
    '  done < "$fifo" ) &',
    "reader_pid=$!",
    "if command -v python3 >/dev/null 2>&1; then",
    '  python3 -c \'import os, sys; os.setsid(); os.execvp("sh", ["sh", "-c", sys.argv[1]])\' "$HACK_LIFECYCLE_COMMAND" >"$fifo" 2>&1 &',
    "else",
    '  sh -c "$HACK_LIFECYCLE_COMMAND" >"$fifo" 2>&1 &',
    "fi",
    "cmd_pid=$!",
    'wait "$cmd_pid"',
    "cmd_status=$?",
    'cmd_pid=""',
    'wait "$reader_pid" 2>/dev/null || true',
    'reader_pid=""',
    'rm -f "$fifo"',
    'exit "$cmd_status"',
  ].join("\n");
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function mergeLifecycleCommandEnv(
  override: Readonly<Record<string, string>>
): Promise<Record<string, string>> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      base[key] = value;
    }
  }
  return await appendHackHostTrustEnvironment({ ...base, ...override });
}

async function resolveBranchComposeFiles(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly branch: string;
  readonly devHost: string;
  readonly aliasHost: string | null;
}): Promise<readonly string[]> {
  const override = await buildBranchComposeOverride(opts);
  if (!override) {
    return [opts.project.composeFile];
  }

  const overrideDir = resolve(opts.project.projectDir, ".branch");
  await ensureDir(overrideDir);
  const overridePath = resolve(
    overrideDir,
    `compose.${opts.branch}.override.yml`
  );
  await writeTextFileIfChanged(overridePath, override);
  return [opts.project.composeFile, overridePath];
}

const INTERNAL_CA_CONTAINER_DIR = "/etc/hack/ca";
const INTERNAL_CA_CONTAINER_PATH = `${INTERNAL_CA_CONTAINER_DIR}/caddy-local-authority.crt`;

async function resolveInternalComposeOverride(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
  readonly branch?: string | null;
  readonly devHost?: string | null;
  readonly aliasHost?: string | null;
}): Promise<string | null> {
  const internal = resolveInternalSettings(opts.cfg);

  const managedExtraHosts = await readInternalExtraHostsFile({
    projectDir: opts.project.projectDir,
  });
  if (!shouldBuildInternalOverride({ internal, managedExtraHosts })) {
    return null;
  }

  const services = await readComposeServicesForInternalOverride(
    opts.project.composeFile
  );
  if (services.length === 0) {
    return null;
  }

  const dns = await resolveInternalDnsSettings({
    project: opts.project,
    composeFile: opts.project.composeFile,
    enabled: internal.dns,
    branch: opts.branch ?? null,
    devHost: opts.devHost ?? null,
    aliasHost: opts.aliasHost ?? null,
  });
  const caPath = await resolveInternalTlsCaPath({ enabled: internal.tls });
  if (!(dns.dnsServer || caPath || dns.caddyIp)) {
    return null;
  }

  const extraHosts = buildInternalExtraHosts({
    caddyIp: dns.caddyIp,
    caddyHosts: dns.caddyHosts,
    internalExtraHosts: internal.extraHosts,
    managedExtraHosts,
  });
  const text = renderInternalOverride({
    services,
    dnsServer: dns.dnsServer,
    extraHosts,
    caPath,
  });

  return await writeInternalComposeOverride({
    projectDir: opts.project.projectDir,
    text,
  });
}

function shouldBuildInternalOverride(opts: {
  readonly internal: ReturnType<typeof resolveInternalSettings>;
  readonly managedExtraHosts: Record<string, string>;
}): boolean {
  const internalExtraHosts = opts.internal.extraHosts;
  const hasInternalExtraHosts =
    internalExtraHosts && Object.keys(internalExtraHosts).length > 0;
  const hasManagedExtraHosts = Object.keys(opts.managedExtraHosts).length > 0;
  const hasExtraHosts = hasInternalExtraHosts || hasManagedExtraHosts;
  return opts.internal.dns || opts.internal.tls || hasExtraHosts;
}

type InternalDnsSettings = {
  readonly dnsServer: string | null;
  readonly caddyIp: string | null;
  readonly caddyHosts: readonly string[];
};

async function resolveInternalDnsSettings(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly composeFile: string;
  readonly enabled: boolean;
  readonly branch: string | null;
  readonly devHost: string | null;
  readonly aliasHost: string | null;
}): Promise<InternalDnsSettings> {
  if (!opts.enabled) {
    return { dnsServer: null, caddyIp: null, caddyHosts: [] };
  }

  const dnsServer = await resolveCoreDnsServerWithWarning();
  const caddyIp = await resolveCaddyServerWithWarning();
  const caddyHosts = await resolveCaddyHostsForBranch({
    project: opts.project,
    composeFile: opts.composeFile,
    branch: opts.branch,
    devHost: opts.devHost,
    aliasHost: opts.aliasHost,
  });

  return { dnsServer, caddyIp, caddyHosts };
}

async function resolveCoreDnsServerWithWarning(): Promise<string | null> {
  const dnsServer = await resolveCoreDnsServer();
  if (!dnsServer) {
    logger.warn({
      message:
        "CoreDNS is not reachable; internal DNS for *.hack is disabled. Run `hack global install` (or `hack global up`).",
    });
  }
  return dnsServer;
}

async function resolveCaddyServerWithWarning(): Promise<string | null> {
  const caddyIp = await resolveCaddyServer();
  if (!caddyIp) {
    logger.warn({
      message:
        "Caddy is not reachable; internal *.hack host mappings are disabled. Run `hack global install` (or `hack global up`).",
    });
  }
  return caddyIp;
}

async function resolveCaddyHostsForBranch(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly composeFile: string;
  readonly branch: string | null;
  readonly devHost: string | null;
  readonly aliasHost: string | null;
}): Promise<readonly string[]> {
  const caddyHosts = await readComposeCaddyHosts(opts.composeFile);
  if (!(caddyHosts.length > 0 && opts.branch)) {
    return caddyHosts;
  }

  const devHost =
    opts.devHost ?? (await resolveBranchDevHost({ project: opts.project }));
  const baseHosts = [devHost, opts.aliasHost ?? null].filter(
    (host): host is string => typeof host === "string" && host.length > 0
  );
  if (baseHosts.length === 0) {
    return caddyHosts;
  }

  return applyBranchToHosts({
    hosts: caddyHosts,
    branch: opts.branch,
    baseHosts,
  });
}

async function resolveInternalTlsCaPath(opts: {
  readonly enabled: boolean;
}): Promise<string | null> {
  if (!opts.enabled) {
    return null;
  }

  const caPath = await resolveCaddyLocalCaPath();
  if (!caPath) {
    logger.warn({
      message:
        "Caddy Local CA cert not found; internal TLS trust is disabled. Run `hack global trust` (or `hack global ca`).",
    });
  }
  return caPath;
}

function buildInternalExtraHosts(opts: {
  readonly caddyIp: string | null;
  readonly caddyHosts: readonly string[];
  readonly internalExtraHosts: Record<string, string> | null;
  readonly managedExtraHosts: Record<string, string>;
}): Record<string, string> {
  return {
    ...(opts.caddyIp && opts.caddyHosts.length > 0
      ? buildExtraHostsMap({ hosts: opts.caddyHosts, ip: opts.caddyIp })
      : {}),
    ...(opts.internalExtraHosts ? opts.internalExtraHosts : {}),
    ...opts.managedExtraHosts,
  };
}

function renderInternalOverride(opts: {
  readonly services: readonly InternalOverrideService[];
  readonly dnsServer: string | null;
  readonly extraHosts: Record<string, string>;
  readonly caPath: string | null;
}): string {
  const overrideServices = buildInternalOverrideServices({
    services: opts.services,
    dnsServer: opts.dnsServer,
    extraHosts: opts.extraHosts,
    caPath: opts.caPath,
  });
  const override = { services: overrideServices };
  const yaml = YAML.stringify(override, null, 2);
  return ensureTrailingNewline(cleanupYaml(yaml));
}

interface InternalOverrideService {
  readonly name: string;
  readonly enableInternalDns: boolean;
}

function buildInternalOverrideServices(opts: {
  readonly services: readonly InternalOverrideService[];
  readonly dnsServer: string | null;
  readonly extraHosts: Record<string, string>;
  readonly caPath: string | null;
}): Record<string, Record<string, unknown>> {
  const overrideServices: Record<string, Record<string, unknown>> = {};

  for (const service of opts.services) {
    const entry: Record<string, unknown> = {};
    if (opts.dnsServer && service.enableInternalDns) {
      entry.dns = [opts.dnsServer];
    }
    if (Object.keys(opts.extraHosts).length > 0) {
      entry.extra_hosts = opts.extraHosts;
    }
    if (opts.caPath) {
      entry.volumes = [`${opts.caPath}:${INTERNAL_CA_CONTAINER_PATH}:ro`];
      entry.environment = buildInternalTlsEnvironment();
    }
    overrideServices[service.name] = entry;
  }

  return overrideServices;
}

function buildInternalTlsEnvironment(): Record<string, string> {
  return {
    SSL_CERT_FILE: INTERNAL_CA_CONTAINER_PATH,
    SSL_CERT_DIR: INTERNAL_CA_CONTAINER_DIR,
    NODE_EXTRA_CA_CERTS: INTERNAL_CA_CONTAINER_PATH,
    REQUESTS_CA_BUNDLE: INTERNAL_CA_CONTAINER_PATH,
    CURL_CA_BUNDLE: INTERNAL_CA_CONTAINER_PATH,
    GIT_SSL_CAINFO: INTERNAL_CA_CONTAINER_PATH,
  };
}

async function writeInternalComposeOverride(opts: {
  readonly projectDir: string;
  readonly text: string;
}): Promise<string> {
  const overrideDir = resolve(opts.projectDir, ".internal");
  await ensureDir(overrideDir);
  const overridePath = resolve(overrideDir, "compose.override.yml");
  await writeTextFileIfChanged(overridePath, opts.text);
  return overridePath;
}

function resolveInternalSettings(
  cfg: Awaited<ReturnType<typeof readProjectConfig>>
): {
  readonly dns: boolean;
  readonly tls: boolean;
  readonly extraHosts: Record<string, string> | null;
} {
  return {
    dns: cfg.internal?.dns ?? true,
    tls: cfg.internal?.tls ?? true,
    extraHosts: cfg.internal?.extraHosts ?? null,
  };
}

async function readComposeServiceNames(
  composeFile: string
): Promise<readonly string[]> {
  const text = await readTextFile(composeFile);
  if (!text) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch {
    return [];
  }

  if (!isRecord(parsed)) {
    return [];
  }
  const servicesRaw = parsed.services;
  if (!isRecord(servicesRaw)) {
    return [];
  }
  return Object.keys(servicesRaw).sort((a, b) => a.localeCompare(b));
}

/**
 * Resolve service metadata used to build `.hack/.internal/compose.override.yml`.
 *
 * DNS override should only be applied to ingress-network services; applying a
 * CoreDNS override to non-ingress services can break external DNS resolution
 * on remote nodes when cross-bridge CoreDNS routing is unavailable.
 */
async function readComposeServicesForInternalOverride(
  composeFile: string
): Promise<readonly InternalOverrideService[]> {
  const text = await readTextFile(composeFile);
  if (!text) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch {
    return [];
  }

  if (!isRecord(parsed)) {
    return [];
  }
  const servicesRaw = parsed.services;
  if (!isRecord(servicesRaw)) {
    return [];
  }

  const out: InternalOverrideService[] = [];
  const names = Object.keys(servicesRaw).sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const definition = servicesRaw[name];
    const networks = parseComposeServiceNetworkNames(definition);
    out.push({
      name,
      enableInternalDns: networks.includes(DEFAULT_INGRESS_NETWORK),
    });
  }
  return out;
}

function parseComposeServiceNetworkNames(value: unknown): readonly string[] {
  if (!isRecord(value)) {
    return [];
  }

  const networks = value.networks;
  if (Array.isArray(networks)) {
    const out: string[] = [];
    for (const entry of networks) {
      const names = parseComposeNetworkEntry(entry);
      for (const name of names) {
        out.push(name);
      }
    }
    return out;
  }

  if (!isRecord(networks)) {
    return [];
  }

  return Object.keys(networks)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseComposeNetworkEntry(value: unknown): readonly string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.keys(value)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function readComposeCaddyHosts(
  composeFile: string
): Promise<readonly string[]> {
  const text = await readTextFile(composeFile);
  if (!text) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch {
    return [];
  }

  if (!isRecord(parsed)) {
    return [];
  }
  const servicesRaw = parsed.services;
  if (!isRecord(servicesRaw)) {
    return [];
  }

  const hosts = new Set<string>();
  for (const serviceRaw of Object.values(servicesRaw)) {
    if (!isRecord(serviceRaw)) {
      continue;
    }
    const labels = normalizeLabels(serviceRaw.labels);
    if (!labels) {
      continue;
    }
    const caddyRaw = labels.caddy;
    if (typeof caddyRaw !== "string") {
      continue;
    }
    for (const host of extractCaddyHosts(caddyRaw)) {
      hosts.add(host);
    }
  }

  return Array.from(hosts).sort((a, b) => a.localeCompare(b));
}

function extractCaddyHosts(value: string): readonly string[] {
  const out: string[] = [];
  for (const part of value.split(",")) {
    let host = part.trim();
    if (!host) {
      continue;
    }

    if (host.startsWith("http://")) {
      host = host.slice("http://".length);
    }
    if (host.startsWith("https://")) {
      host = host.slice("https://".length);
    }
    const slashIdx = host.indexOf("/");
    if (slashIdx !== -1) {
      host = host.slice(0, slashIdx);
    }
    if (host.length === 0) {
      continue;
    }
    if (
      host.includes("*") ||
      host.includes("{") ||
      host.includes("}") ||
      host.includes("$")
    ) {
      continue;
    }
    if (host.includes(":")) {
      continue;
    }

    out.push(host);
  }
  return out;
}

function applyBranchToHosts(opts: {
  readonly hosts: readonly string[];
  readonly branch: string;
  readonly baseHosts: readonly string[];
}): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const host of opts.hosts) {
    const next = applyBranchToHost({
      host,
      branch: opts.branch,
      baseHosts: opts.baseHosts,
    });
    if (seen.has(next)) {
      continue;
    }
    seen.add(next);
    out.push(next);
  }
  return out;
}

function buildExtraHostsMap(opts: {
  readonly hosts: readonly string[];
  readonly ip: string;
}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const host of opts.hosts) {
    out[host] = opts.ip;
  }
  return out;
}

async function resolveCoreDnsServer(): Promise<string | null> {
  const env = (process.env.HACK_COREDNS_IP ?? "").trim();
  if (env.length > 0) {
    return env;
  }

  const home = process.env.HOME;
  if (!home) {
    return null;
  }

  const composePath = resolve(
    home,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_CADDY_DIR_NAME,
    GLOBAL_CADDY_COMPOSE_FILENAME
  );
  if (!(await pathExists(composePath))) {
    return null;
  }

  const ps = await exec(
    ["docker", "compose", "-f", composePath, "ps", "-q", "coredns"],
    {
      cwd: dirname(composePath),
      stdin: "ignore",
    }
  );
  const id = ps.exitCode === 0 ? ps.stdout.trim() : "";
  if (!id) {
    return null;
  }

  const inspect = await exec(
    ["docker", "inspect", "--format", "{{json .NetworkSettings.Networks}}", id],
    {
      stdin: "ignore",
    }
  );
  if (inspect.exitCode !== 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(inspect.stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }

  const network = parsed[DEFAULT_INGRESS_NETWORK];
  if (!isRecord(network)) {
    return null;
  }
  const ip = network.IPAddress;
  return typeof ip === "string" && ip.length > 0 ? ip : null;
}

async function resolveCaddyServer(): Promise<string | null> {
  const env = (process.env.HACK_CADDY_IP ?? "").trim();
  if (env.length > 0) {
    return env;
  }

  const home = process.env.HOME;
  if (!home) {
    return null;
  }

  const composePath = resolve(
    home,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_CADDY_DIR_NAME,
    GLOBAL_CADDY_COMPOSE_FILENAME
  );
  if (!(await pathExists(composePath))) {
    return null;
  }

  const ps = await exec(
    ["docker", "compose", "-f", composePath, "ps", "-q", "caddy"],
    {
      cwd: dirname(composePath),
      stdin: "ignore",
    }
  );
  const id = ps.exitCode === 0 ? ps.stdout.trim() : "";
  if (!id) {
    return null;
  }

  const inspect = await exec(
    ["docker", "inspect", "--format", "{{json .NetworkSettings.Networks}}", id],
    {
      stdin: "ignore",
    }
  );
  if (inspect.exitCode !== 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(inspect.stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }

  const network = parsed[DEFAULT_INGRESS_NETWORK];
  if (!isRecord(network)) {
    return null;
  }
  const ip = network.IPAddress;
  return typeof ip === "string" && ip.length > 0 ? ip : null;
}

async function resolveCaddyLocalCaPath(): Promise<string | null> {
  const home = process.env.HOME;
  if (!home) {
    return null;
  }
  const certPath = resolve(
    home,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_CADDY_DIR_NAME,
    "pki",
    "caddy-local-authority.crt"
  );
  return (await pathExists(certPath)) ? certPath : null;
}

async function resolveBranchDevHost(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
}): Promise<string> {
  const devHost = await readProjectDevHost(opts.project);
  if (devHost) {
    return devHost;
  }
  throw new Error(
    `Missing dev_host in ${opts.project.configFile} (or ${PROJECT_CONFIG_LEGACY_FILENAME}). Run: hack init`
  );
}

function resolveBranchAliasHost(opts: {
  readonly devHost: string;
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
}): string | null {
  const tld = resolveProjectOauthTld(opts.cfg.oauth);
  return tld ? `${opts.devHost}.${tld}` : null;
}

async function touchBranchUsageIfNeeded(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly branch: string | null;
}): Promise<void> {
  if (!opts.branch) {
    return;
  }
  const res = await touchBranchUsage({
    projectDir: opts.project.projectDir,
    branch: opts.branch,
    createIfMissing: true,
  });
  if (res.error) {
    logger.warn({
      message: `Failed to update ${res.path}: ${res.error}`,
    });
  }
}

async function touchProjectRegistration(
  project: Awaited<ReturnType<typeof requireProjectContext>>
): Promise<void> {
  const outcome = await upsertProjectRegistration({ project });
  if (outcome.status === "conflict") {
    logger.warn({
      message: [
        `Project name conflict: "${outcome.conflictName}" is already registered at ${outcome.existing.repoRoot}`,
        `Incoming project dir: ${outcome.incoming.projectDir}`,
        "Tip: rename one project (hack.config.json name) to keep names unique.",
      ].join("\n"),
    });
  }
}

function validateInitProjectSlug(
  value: string | undefined
): string | undefined {
  const v = value?.trim();
  if (!v) {
    return "Required";
  }
  const s = sanitizeProjectSlug(v);
  if (s.length === 0) {
    return "Invalid";
  }
  return undefined;
}

async function promptInitProjectSlug(opts: {
  readonly repoRoot: string;
  readonly nameOption: string | undefined;
}): Promise<string | null> {
  const defaultSlug = defaultProjectSlugFromPath(opts.repoRoot);
  const initialSlug = sanitizeProjectSlug(opts.nameOption ?? defaultSlug);
  const name = await text({
    message: "Project name (slug):",
    initialValue: initialSlug,
    validate: validateInitProjectSlug,
  });
  if (isCancel(name)) {
    return null;
  }
  return sanitizeProjectSlug(name);
}

async function ensureInitProjectSlugUnique(opts: {
  readonly repoRoot: string;
  readonly slug: string;
}): Promise<void> {
  const registry = await readProjectsRegistry();
  const existing = registry.projects.find((p) => p.name === opts.slug) ?? null;
  if (!existing) {
    return;
  }

  const expectedProjectDir = resolve(opts.repoRoot, HACK_PROJECT_DIR_PRIMARY);
  const isSame = existing.projectDir === expectedProjectDir;
  if (isSame) {
    return;
  }

  const stillExists = await pathExists(existing.projectDir);
  if (!stillExists) {
    return;
  }

  throw new Error(
    [
      `Project name "${opts.slug}" is already registered.`,
      `Existing: ${existing.repoRoot}`,
      `This repo: ${opts.repoRoot}`,
      "Tip: choose a different name (or rename the other project).",
    ].join("\n")
  );
}

function validateInitDevHost(value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v) {
    return "Required";
  }
  if (v.includes(" ")) {
    return "No spaces";
  }
  if (v.includes("://")) {
    return "Host only (no scheme)";
  }
  if (v.includes("/")) {
    return "Host only (no path)";
  }
  if (v.includes(":")) {
    return "Host only (no port)";
  }
  return undefined;
}

async function promptInitDevHost(opts: {
  readonly slug: string;
  readonly devHostOption: string | undefined;
}): Promise<string | null> {
  const defaultHost = `${opts.slug}.${DEFAULT_PROJECT_TLD}`;
  const initialHost = (opts.devHostOption ?? defaultHost).trim();
  const devHost = await text({
    message: "DEV_HOST:",
    initialValue: initialHost,
    validate: validateInitDevHost,
  });
  if (isCancel(devHost)) {
    return null;
  }
  return devHost.trim();
}

function validateInitOauthTld(value: string | undefined): string | undefined {
  const v = value?.trim().toLowerCase();
  if (!v) {
    return "Required";
  }
  if (!SLUG_LABEL_PATTERN.test(v)) {
    return "Invalid TLD label";
  }
  return undefined;
}

async function promptInitOauthSettings(opts: {
  readonly oauthEnabledDefault: boolean;
  readonly oauthTldOption: string | undefined;
}): Promise<{ readonly enabled: boolean; readonly tld: string } | null> {
  const enableOauthHost = await confirm({
    message: `Enable OAuth-safe alias host (https://<project>.${DEFAULT_PROJECT_TLD}.${DEFAULT_OAUTH_ALIAS_TLD})?`,
    initialValue: opts.oauthEnabledDefault,
  });
  if (isCancel(enableOauthHost)) {
    return null;
  }

  if (!enableOauthHost) {
    return { enabled: false, tld: DEFAULT_OAUTH_ALIAS_TLD };
  }

  const oauthTld = await text({
    message: "OAuth alias TLD (optional):",
    initialValue: opts.oauthTldOption ?? DEFAULT_OAUTH_ALIAS_TLD,
    validate: validateInitOauthTld,
  });
  if (isCancel(oauthTld)) {
    return null;
  }

  return { enabled: true, tld: String(oauthTld) };
}

function renderInitDiscoveryNote(opts: {
  readonly discovery: Awaited<ReturnType<typeof discoverRepo>>;
}): string {
  const monorepoLine = opts.discovery.isMonorepo
    ? "Monorepo detected."
    : "Single-package repo detected.";
  const signalsLine =
    opts.discovery.signals.length > 0
      ? `Signals: ${opts.discovery.signals.join(", ")}`
      : "Signals: none";

  return [
    `Detected ${opts.discovery.packages.length} package(s) and ${opts.discovery.candidates.length} dev-like script(s).`,
    monorepoLine,
    signalsLine,
  ].join("\n");
}

async function promptInitUseDiscovery(opts: {
  readonly canDiscover: boolean;
  readonly forceManual: boolean;
}): Promise<boolean | null> {
  if (opts.forceManual || !opts.canDiscover) {
    return false;
  }

  const useDiscovery = await confirm({
    message: "Auto-discover dev scripts and generate services?",
    initialValue: true,
  });
  if (isCancel(useDiscovery)) {
    return null;
  }
  return useDiscovery;
}

async function ensureInitHackDir(opts: {
  readonly hackDir: string;
}): Promise<"proceed" | "skip" | null> {
  if (await pathExists(opts.hackDir)) {
    const ok = await confirm({
      message: `${HACK_PROJECT_DIR_PRIMARY}/ already exists. Overwrite scaffold files?`,
      initialValue: false,
    });
    if (isCancel(ok)) {
      return null;
    }
    if (!ok) {
      return "skip";
    }
    return "proceed";
  }

  await ensureDir(opts.hackDir);
  return "proceed";
}

async function handleInit({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: InitArgs;
}): Promise<number> {
  if (args.options.auto) {
    return await handleInitAuto({ ctx, args });
  }

  const startDir = resolveStartDir(ctx, args.options.path);
  const repoRoot = await findRepoRootForInit(startDir);

  const slug = await promptInitProjectSlug({
    repoRoot,
    nameOption: args.options.name,
  });
  if (!slug) {
    return 1;
  }

  await ensureInitProjectSlugUnique({ repoRoot, slug });

  const devHost = await promptInitDevHost({
    slug,
    devHostOption: args.options.devHost,
  });
  if (!devHost) {
    return 1;
  }

  const oauth = await promptInitOauthSettings({
    oauthEnabledDefault:
      args.options.oauth === true || Boolean(args.options.oauthTld),
    oauthTldOption: args.options.oauthTld,
  });
  if (!oauth) {
    return 1;
  }

  const discovery = await discoverRepo(repoRoot);
  const canDiscover = discovery.candidates.length > 0;

  const forceManual = args.options.manual || args.options.noDiscovery;

  if (canDiscover && !forceManual) {
    note(renderInitDiscoveryNote({ discovery }), "Discovery");
  }

  const useDiscovery = await promptInitUseDiscovery({
    canDiscover,
    forceManual,
  });
  if (useDiscovery === null) {
    return 1;
  }

  const hackDir = resolve(repoRoot, HACK_PROJECT_DIR_PRIMARY);
  const composeFile = resolve(hackDir, PROJECT_COMPOSE_FILENAME);
  const configFile = resolve(hackDir, PROJECT_CONFIG_FILENAME);

  const hackDirAction = await ensureInitHackDir({ hackDir });
  if (!hackDirAction) {
    return 1;
  }
  if (hackDirAction === "skip") {
    return 0;
  }

  // Ensure .hack/.internal is gitignored (contains local paths, certs, etc)
  await ensureGitignoreEntry({
    gitignorePath: resolve(repoRoot, ".gitignore"),
    entry: ".hack/.internal/",
    comment: "# hack internal (local overrides)",
  });

  await writeTextFileIfChanged(
    configFile,
    renderProjectConfigJson({
      name: slug,
      devHost,
      oauth: { enabled: oauth.enabled, tld: oauth.tld },
    })
  );

  const compose = useDiscovery
    ? await buildDiscoveredCompose({
        repoRoot,
        devHost,
        projectSlug: slug,
        candidates: discovery.candidates,
        oauth: { enabled: oauth.enabled, tld: oauth.tld },
      })
    : await buildManualCompose({
        repoRoot,
        devHost,
        projectSlug: slug,
        oauth: { enabled: oauth.enabled, tld: oauth.tld },
      });
  await writeTextFileIfChanged(composeFile, compose);

  await writeTextFileIfChanged(
    resolve(hackDir, "README.md"),
    renderHackFolderReadme({
      devHost,
      oauth: { enabled: oauth.enabled, tld: oauth.tld },
    })
  );

  await writeTextFileIfChanged(
    resolve(hackDir, PROJECT_ENV_CONFIG_DEFAULT_FILENAME),
    renderProjectEnvConfigYaml()
  );

  const registration = await upsertProjectRegistration({
    project: {
      projectRoot: repoRoot,
      projectDirName: HACK_PROJECT_DIR_PRIMARY,
      projectDir: hackDir,
      composeFile,
      envFile: resolve(hackDir, PROJECT_ENV_FILENAME),
      configFile,
    },
  });
  if (registration.status === "conflict") {
    throw new Error(
      [
        `Project name conflict: "${registration.conflictName}" is already registered at ${registration.existing.repoRoot}`,
        `Incoming project dir: ${registration.incoming.projectDir}`,
        "Tip: choose a different name in 'hack init'.",
      ].join("\n")
    );
  }

  await maybeSetupAgentIntegrations({ repoRoot });

  note(
    [
      `Wrote: ${HACK_PROJECT_DIR_PRIMARY}/${PROJECT_COMPOSE_FILENAME}`,
      `Wrote: ${HACK_PROJECT_DIR_PRIMARY}/${PROJECT_CONFIG_FILENAME}`,
      `Wrote: ${HACK_PROJECT_DIR_PRIMARY}/README.md`,
      `Wrote: ${HACK_PROJECT_DIR_PRIMARY}/${PROJECT_ENV_CONFIG_DEFAULT_FILENAME}`,
      "",
      "Next:",
      "  hack up",
      "  hack open",
    ].join("\n"),
    "Initialized"
  );

  return 0;
}

async function handleInitAuto({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: InitArgs;
}): Promise<number> {
  const startDir = resolveStartDir(ctx, args.options.path);
  const repoRoot = await findRepoRootForInit(startDir);

  const slug = resolveInitSlug({
    repoRoot,
    nameOpt: args.options.name,
  });

  await ensureUniqueProjectSlug({
    repoRoot,
    slug,
  });

  const devHost = resolveInitDevHost({
    slug,
    devHostOpt: args.options.devHost,
  });

  const oauthEnabled =
    args.options.oauth === true || Boolean(args.options.oauthTld);
  const oauth = resolveInitOauth({
    enabled: oauthEnabled,
    tldOpt: args.options.oauthTld,
  });

  const discovery = await discoverRepo(repoRoot);
  const canDiscover = discovery.candidates.length > 0;
  const skipDiscovery = args.options.manual || args.options.noDiscovery;
  const useDiscovery = canDiscover && !skipDiscovery;

  const hackDir = resolve(repoRoot, HACK_PROJECT_DIR_PRIMARY);
  const composeFile = resolve(hackDir, PROJECT_COMPOSE_FILENAME);
  const configFile = resolve(hackDir, PROJECT_CONFIG_FILENAME);

  if (await pathExists(hackDir)) {
    throw new Error(
      `${HACK_PROJECT_DIR_PRIMARY}/ already exists. Run without --auto to overwrite.`
    );
  }

  await ensureDir(hackDir);

  // Ensure .hack/.internal is gitignored (contains local paths, certs, etc)
  await ensureGitignoreEntry({
    gitignorePath: resolve(repoRoot, ".gitignore"),
    entry: ".hack/.internal/",
    comment: "# hack internal (local overrides)",
  });

  await writeTextFileIfChanged(
    configFile,
    renderProjectConfigJson({
      name: slug,
      devHost,
      oauth: { enabled: oauth.enabled, tld: oauth.tld },
    })
  );

  const compose = useDiscovery
    ? await buildDiscoveredComposeAuto({
        repoRoot,
        devHost,
        projectSlug: slug,
        candidates: discovery.candidates,
        oauth,
      })
    : await buildManualComposeAuto({
        repoRoot,
        devHost,
        projectSlug: slug,
        oauth,
      });
  await writeTextFileIfChanged(composeFile, compose);

  await writeTextFileIfChanged(
    resolve(hackDir, "README.md"),
    renderHackFolderReadme({
      devHost,
      oauth: { enabled: oauth.enabled, tld: oauth.tld },
    })
  );

  await writeTextFileIfChanged(
    resolve(hackDir, PROJECT_ENV_CONFIG_DEFAULT_FILENAME),
    renderProjectEnvConfigYaml()
  );

  const registration = await upsertProjectRegistration({
    project: {
      projectRoot: repoRoot,
      projectDirName: HACK_PROJECT_DIR_PRIMARY,
      projectDir: hackDir,
      composeFile,
      envFile: resolve(hackDir, PROJECT_ENV_FILENAME),
      configFile,
    },
  });
  if (registration.status === "conflict") {
    throw new Error(
      [
        `Project name conflict: "${registration.conflictName}" is already registered at ${registration.existing.repoRoot}`,
        `Incoming project dir: ${registration.incoming.projectDir}`,
        "Tip: choose a different name in 'hack init'.",
      ].join("\n")
    );
  }

  logger.success({
    message: `Initialized ${HACK_PROJECT_DIR_PRIMARY}/ for ${slug}`,
  });
  logger.info({
    message: "Next: hack up --detach && hack open",
  });

  return 0;
}

function resolveInitSlug(opts: {
  readonly repoRoot: string;
  readonly nameOpt?: string;
}): string {
  const fallback = defaultProjectSlugFromPath(opts.repoRoot);
  const raw = (opts.nameOpt ?? fallback).trim();
  if (!raw) {
    return fallback;
  }
  return sanitizeProjectSlug(raw);
}

async function ensureUniqueProjectSlug(opts: {
  readonly repoRoot: string;
  readonly slug: string;
}): Promise<void> {
  const registry = await readProjectsRegistry();
  const existing = registry.projects.find((p) => p.name === opts.slug) ?? null;
  if (!existing) {
    return;
  }

  const expectedProjectDir = resolve(opts.repoRoot, HACK_PROJECT_DIR_PRIMARY);
  const isSame = existing.projectDir === expectedProjectDir;
  const stillExists = await pathExists(existing.projectDir);
  if (!isSame && stillExists) {
    throw new Error(
      [
        `Project name "${opts.slug}" is already registered.`,
        `Existing: ${existing.repoRoot}`,
        `This repo: ${opts.repoRoot}`,
        "Tip: choose a different name (or rename the other project).",
      ].join("\n")
    );
  }
}

function resolveInitDevHost(opts: {
  readonly slug: string;
  readonly devHostOpt?: string;
}): string {
  const fallback = `${opts.slug}.${DEFAULT_PROJECT_TLD}`;
  const raw = (opts.devHostOpt ?? fallback).trim();
  const error = validateDevHost({ value: raw });
  if (error) {
    throw new Error(`Invalid --dev-host: ${error}`);
  }
  return raw;
}

function resolveInitOauth(opts: {
  readonly enabled: boolean;
  readonly tldOpt?: string;
}): { readonly enabled: boolean; readonly tld: string } {
  const raw = (opts.tldOpt ?? DEFAULT_OAUTH_ALIAS_TLD).trim().toLowerCase();
  const error = validateOauthTld({ value: raw });
  if (error) {
    throw new Error(`Invalid --oauth-tld: ${error}`);
  }
  return { enabled: opts.enabled, tld: raw };
}

function validateDevHost(opts: { readonly value: string }): string | null {
  if (!opts.value) {
    return "Required";
  }
  if (opts.value.includes(" ")) {
    return "No spaces";
  }
  if (opts.value.includes("://")) {
    return "Host only (no scheme)";
  }
  if (opts.value.includes("/")) {
    return "Host only (no path)";
  }
  if (opts.value.includes(":")) {
    return "Host only (no port)";
  }
  return null;
}

function validateOauthTld(opts: { readonly value: string }): string | null {
  if (!opts.value) {
    return "Required";
  }
  if (!SLUG_LABEL_PATTERN.test(opts.value)) {
    return "Invalid TLD label";
  }
  return null;
}

type SetupIntegration = "cursor" | "claude" | "codex" | "agents" | "mcp";

async function maybeSetupAgentIntegrations(opts: {
  readonly repoRoot: string;
}): Promise<void> {
  const shouldSetup = await confirm({
    message: "Set up coding agent integrations? (Cursor/Claude/Codex)",
    initialValue: true,
  });
  if (isCancel(shouldSetup) || !shouldSetup) {
    return;
  }

  const selected = await multiselect<SetupIntegration>({
    message: "Select integrations to install:",
    required: true,
    options: [
      { value: "cursor", label: "Cursor rules (.cursor/rules/hack.mdc)" },
      {
        value: "claude",
        label: "Claude Code hooks (.claude/settings.local.json)",
      },
      { value: "codex", label: "Codex skill (.codex/skills/hack-cli)" },
      { value: "agents", label: "AGENTS.md / CLAUDE.md snippets" },
      { value: "mcp", label: "MCP config (no-shell clients)" },
    ],
    initialValues: ["cursor", "claude", "codex"],
  });
  if (isCancel(selected) || selected.length === 0) {
    return;
  }

  const selection = new Set(selected);

  if (selection.has("cursor")) {
    const result = await installCursorRules({
      scope: "project",
      projectRoot: opts.repoRoot,
    });
    logInstallResult({
      label: "Cursor rules",
      status: result.status,
      path: result.path,
      message: result.message,
    });
  }

  if (selection.has("claude")) {
    const result = await installClaudeHooks({
      scope: "project",
      projectRoot: opts.repoRoot,
    });
    logInstallResult({
      label: "Claude hooks",
      status: result.status,
      path: result.path,
      message: result.message,
    });
  }

  if (selection.has("codex")) {
    const result = await installCodexSkill({
      scope: "project",
      projectRoot: opts.repoRoot,
    });
    logInstallResult({
      label: "Codex skill",
      status: result.status,
      path: result.path,
      message: result.message,
    });
  }

  if (selection.has("agents")) {
    const results = await upsertAgentDocs({
      projectRoot: opts.repoRoot,
      targets: ["agents", "claude"],
    });
    for (const result of results) {
      logInstallResult({
        label: "Agent docs",
        status: result.status,
        path: result.path,
        message: result.message,
      });
    }
  }

  if (selection.has("mcp")) {
    const targetHints = selected.filter(
      (value) => value === "cursor" || value === "claude" || value === "codex"
    );
    const targets = (
      targetHints.length > 0 ? targetHints : ["cursor", "claude", "codex"]
    ) as McpTarget[];

    const results = await installMcpConfig({
      targets,
      scope: "project",
      projectRoot: opts.repoRoot,
    });

    for (const result of results) {
      logInstallResult({
        label: "MCP config",
        status: result.status,
        path: result.path ?? "unknown path",
        message: result.message,
      });
    }
  }
}

function logInstallResult(opts: {
  readonly label: string;
  readonly status: string;
  readonly path: string;
  readonly message?: string;
}): void {
  if (opts.status === "error") {
    logger.warn({ message: opts.message ?? `Failed to update ${opts.label}` });
    return;
  }

  if (opts.status === "noop") {
    logger.info({ message: `No changes for ${opts.label} (${opts.path})` });
    return;
  }

  logger.success({ message: `Updated ${opts.label} at ${opts.path}` });
}

interface ComposeWizardInput {
  readonly repoRoot: string;
  readonly devHost: string;
  readonly projectSlug: string;
  readonly candidates: readonly ServiceCandidate[];
  readonly oauth: {
    readonly enabled: boolean;
    readonly tld: string;
  };
}

function normalizeOauthTld(raw: string): string {
  const t = raw.trim().toLowerCase();
  if (t.length === 0) {
    return DEFAULT_OAUTH_ALIAS_TLD;
  }
  if (!SLUG_LABEL_PATTERN.test(t)) {
    return DEFAULT_OAUTH_ALIAS_TLD;
  }
  return t;
}

function buildCaddyHostLabelValue(opts: {
  readonly primaryHost: string;
  readonly oauth: { readonly enabled: boolean; readonly tld: string };
}): string {
  if (!opts.oauth.enabled) {
    return opts.primaryHost;
  }
  if (!opts.primaryHost.endsWith(`.${DEFAULT_PROJECT_TLD}`)) {
    return opts.primaryHost;
  }

  const tld = normalizeOauthTld(opts.oauth.tld);
  const aliasHost = `${opts.primaryHost}.${tld}`;

  const uniq = new Set<string>();
  const out: string[] = [];
  for (const host of [opts.primaryHost, aliasHost]) {
    if (uniq.has(host)) {
      continue;
    }
    uniq.add(host);
    out.push(host);
  }
  return out.join(", ");
}

function splitYamlInlineComment(rawAfter: string): {
  readonly valueRaw: string;
  readonly commentSuffix: string;
} {
  const commentIdx = rawAfter.indexOf(" #");
  if (commentIdx < 0) {
    return { valueRaw: rawAfter.trimEnd(), commentSuffix: "" };
  }

  return {
    valueRaw: rawAfter.slice(0, commentIdx).trimEnd(),
    commentSuffix: rawAfter.slice(commentIdx),
  };
}

function splitCaddyHosts(value: string): string[] {
  return value
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
}

function expandCaddyHostsWithOauthAliases(opts: {
  readonly hosts: readonly string[];
  readonly tld: string;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const host of opts.hosts) {
    if (seen.has(host)) {
      continue;
    }
    seen.add(host);
    out.push(host);
  }

  for (const host of opts.hosts) {
    if (!host.endsWith(`.${DEFAULT_PROJECT_TLD}`)) {
      continue;
    }
    const alias = `${host}.${opts.tld}`;
    if (seen.has(alias)) {
      continue;
    }
    seen.add(alias);
    out.push(alias);
  }

  return out;
}

function maybePatchCaddyLabelLine(opts: {
  readonly line: string;
  readonly tld: string;
}): { readonly line: string; readonly changed: boolean } | null {
  const caddyMatch = CADDY_LABEL_PATTERN.exec(opts.line);
  if (!caddyMatch) {
    return null;
  }

  const indentStr = caddyMatch[1] ?? "";
  const rawAfter = caddyMatch[2] ?? "";

  const { valueRaw, commentSuffix } = splitYamlInlineComment(rawAfter);
  const valueTrimmed = valueRaw.trim();
  const quoted = parseQuotedValue(valueTrimmed);
  const parts = splitCaddyHosts(quoted.value);
  if (parts.length === 0) {
    return null;
  }

  const nextValue = expandCaddyHostsWithOauthAliases({
    hosts: parts,
    tld: opts.tld,
  }).join(", ");
  if (nextValue === quoted.value) {
    return null;
  }

  const formatted = quoted.quote
    ? `${quoted.quote}${nextValue}${quoted.quote}`
    : nextValue;
  return {
    line: `${indentStr}caddy: ${formatted}${commentSuffix}`,
    changed: true,
  };
}

function patchComposeOauthAliasesInCaddyLabels(opts: {
  readonly yamlText: string;
  readonly tld: string;
}): { readonly text: string; readonly changed: boolean } {
  const lines = opts.yamlText.split("\n");
  let inLabels = false;
  let labelsIndent = 0;
  let changed = false;

  const tld = normalizeOauthTld(opts.tld);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    // Don't let blank/comment lines end a block.
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const labelsMatch = LABELS_LINE_PATTERN.exec(line);
    if (labelsMatch) {
      inLabels = true;
      labelsIndent = labelsMatch[1]?.length ?? 0;
      continue;
    }

    if (!inLabels) {
      continue;
    }

    const indent = INDENT_PATTERN.exec(line)?.[1]?.length ?? 0;
    if (indent <= labelsIndent) {
      inLabels = false;
      continue;
    }

    const patched = maybePatchCaddyLabelLine({ line, tld });
    if (patched) {
      changed = true;
      lines[i] = patched.line;
    }
  }

  return { text: lines.join("\n"), changed };
}

async function maybeSyncOauthAliasesInCompose(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
}): Promise<void> {
  const cfg = await readProjectConfig(opts.project);
  if (cfg.parseError) {
    return;
  }
  if (!cfg.oauth?.enabled) {
    return;
  }

  const tld = normalizeOauthTld(cfg.oauth.tld ?? DEFAULT_OAUTH_ALIAS_TLD);

  const yamlText = await readTextFile(opts.project.composeFile);
  if (!yamlText) {
    return;
  }

  const patched = patchComposeOauthAliasesInCaddyLabels({ yamlText, tld });
  if (!patched.changed) {
    return;
  }

  await writeTextFileIfChanged(opts.project.composeFile, patched.text);
}

function unwrapPromptValue<T>(value: T | symbol): T {
  if (isCancel(value)) {
    throw new Error("Canceled");
  }
  return value;
}

const RESERVED_COMPOSE_SERVICE_NAMES = new Set(["db", "redis"]);

function validateComposeServiceName(opts: {
  readonly value: string | undefined;
  readonly defaultName: string;
  readonly usedServiceNames: ReadonlySet<string>;
  readonly reserved?: ReadonlySet<string>;
}): string | undefined {
  const v = opts.value?.trim();
  if (!v) {
    return "Required";
  }
  if (!SLUG_LABEL_PATTERN.test(v)) {
    return "Use lowercase letters, numbers, and '-' only";
  }
  if (opts.reserved?.has(v) === true) {
    return "Reserved name";
  }
  if (opts.usedServiceNames.has(v) && v !== opts.defaultName) {
    return "Duplicate";
  }
  return undefined;
}

function validatePort(value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v) {
    return "Required";
  }
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0 || n >= 65_536) {
    return "Invalid port";
  }
  return undefined;
}

function validateRequiredText(value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v) {
    return "Required";
  }
  return undefined;
}

function validateSubdomain(value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v) {
    return "Required";
  }
  if (v.includes(".")) {
    return "Subdomain only (no dots)";
  }
  if (!SLUG_LABEL_PATTERN.test(v)) {
    return "Invalid subdomain";
  }
  return undefined;
}

async function selectCandidatesForDiscoveredCompose(opts: {
  readonly candidates: readonly ServiceCandidate[];
}): Promise<ServiceCandidate[]> {
  const byId = new Map(opts.candidates.map((c) => [c.id, c] as const));

  const selectedIds = unwrapPromptValue(
    await autocompleteMultiselect<string>({
      message: "Select dev scripts to include as services:",
      required: true,
      options: opts.candidates.map((c) => ({
        value: c.id,
        label: formatCandidateLabel(c),
        hint: formatCandidateHint(c),
      })),
    })
  );

  const selectedCandidates: ServiceCandidate[] = [];
  for (const id of selectedIds) {
    const c = byId.get(id);
    if (c) {
      selectedCandidates.push(c);
    }
  }

  if (selectedCandidates.length === 0) {
    throw new Error("No services selected");
  }

  return selectedCandidates;
}

async function promptDraftForDiscoveredCandidate(opts: {
  readonly candidate: ServiceCandidate;
  readonly usedServiceNames: Set<string>;
}): Promise<AutoComposeDraft> {
  note(
    opts.candidate.scriptCommand,
    `${opts.candidate.packageRelativeDir} (${opts.candidate.scriptName})`
  );

  const defaultName = uniqueName(
    guessServiceName(opts.candidate),
    opts.usedServiceNames
  );
  const defaultRole = guessRole(opts.candidate);

  const role = unwrapPromptValue(
    await select<"http" | "internal">({
      message: `Service role for "${defaultName}":`,
      initialValue: defaultRole,
      options: [
        { value: "http", label: "HTTP (routed via Caddy)" },
        { value: "internal", label: "Internal (not routed via Caddy)" },
      ],
    })
  );

  const name = unwrapPromptValue(
    await text({
      message: "docker compose service name:",
      initialValue: defaultName,
      validate: (value) =>
        validateComposeServiceName({
          value,
          defaultName,
          usedServiceNames: opts.usedServiceNames,
          reserved: RESERVED_COMPOSE_SERVICE_NAMES,
        }),
    })
  );
  opts.usedServiceNames.add(name);

  const inferredPort = inferPortFromScript(opts.candidate.scriptCommand);
  const defaultPort = inferredPort ?? guessDefaultPort(name);

  const portNum =
    role === "http"
      ? Number.parseInt(
          unwrapPromptValue(
            await text({
              message: "Internal HTTP port:",
              initialValue: String(defaultPort),
              validate: validatePort,
            })
          ),
          10
        )
      : undefined;

  const workingDir =
    opts.candidate.packageRelativeDir === "."
      ? "/app"
      : `/app/${opts.candidate.packageRelativeDir}`;

  const suggestedCommand = buildSuggestedCommand({
    candidate: opts.candidate,
    role,
    port: portNum,
  });

  const command = unwrapPromptValue(
    await text({
      message: "Container command:",
      initialValue: suggestedCommand,
      validate: validateRequiredText,
    })
  );

  return {
    name,
    role,
    port: portNum,
    workingDir,
    command,
  };
}

async function promptHttpSubdomainsForDrafts(opts: {
  readonly drafts: AutoComposeDraft[];
  readonly devHost: string;
  readonly primaryDefaultStrategy?: "prefer-www" | "first";
}): Promise<void> {
  const httpDrafts = opts.drafts.filter((d) => d.role === "http");
  if (httpDrafts.length === 0) {
    return;
  }

  const primaryDefault =
    opts.primaryDefaultStrategy === "first"
      ? httpDrafts[0]?.name
      : (httpDrafts.find((d) => d.name === "www")?.name ?? httpDrafts[0]?.name);
  const primary = unwrapPromptValue(
    await select<string>({
      message: `Which service should be routed at https://${opts.devHost}?`,
      initialValue: primaryDefault,
      options: httpDrafts.map((d) => ({
        value: d.name,
        label: d.name,
      })),
    })
  );

  for (const d of httpDrafts) {
    if (d.name === primary) {
      continue;
    }

    const defaultSub = guessSubdomain(d.name);
    const sub = unwrapPromptValue(
      await text({
        message: `Subdomain for "${d.name}" (https://<sub>.${opts.devHost}):`,
        initialValue: defaultSub,
        validate: validateSubdomain,
      })
    );
    d.subdomain = sub;
  }

  const primaryDraft = httpDrafts.find((d) => d.name === primary);
  if (primaryDraft) {
    primaryDraft.subdomain = "";
  }
}

async function buildDiscoveredCompose(
  input: ComposeWizardInput
): Promise<string> {
  const selectedCandidates = await selectCandidatesForDiscoveredCompose({
    candidates: input.candidates,
  });
  const usedServiceNames = new Set<string>();
  const drafts: AutoComposeDraft[] = [];

  for (const candidate of selectedCandidates) {
    drafts.push(
      await promptDraftForDiscoveredCandidate({
        candidate,
        usedServiceNames,
      })
    );
  }

  await promptHttpSubdomainsForDrafts({
    drafts,
    devHost: input.devHost,
  });

  const services = buildServicesFromDrafts({
    drafts,
    devHost: input.devHost,
    oauth: input.oauth,
  });

  return renderCompose({ name: input.projectSlug, services });
}

type AutoComposeDraft = {
  name: string;
  role: "http" | "internal";
  port?: number;
  subdomain?: string;
  workingDir: string;
  command: string;
  image?: string;
};

function buildDiscoveredComposeAuto(input: ComposeWizardInput): string {
  const selectedCandidates = selectAutoCandidates({
    candidates: input.candidates,
  });
  if (selectedCandidates.length === 0) {
    throw new Error("No dev scripts discovered for auto init.");
  }

  const usedServiceNames = new Set<string>();
  const drafts: AutoComposeDraft[] = [];

  for (const candidate of selectedCandidates) {
    const name = resolveAutoServiceName({ candidate, usedServiceNames });
    usedServiceNames.add(name);

    const role = guessRole(candidate);
    const port =
      role === "http"
        ? (inferPortFromScript(candidate.scriptCommand) ??
          guessDefaultPort(name))
        : undefined;
    const workingDir =
      candidate.packageRelativeDir === "."
        ? "/app"
        : `/app/${candidate.packageRelativeDir}`;
    const command = buildSuggestedCommand({ candidate, role, port });

    drafts.push({
      name,
      role,
      port,
      workingDir,
      command,
    });
  }

  assignAutoSubdomains({ drafts });

  const services = buildServicesFromDrafts({
    drafts,
    devHost: input.devHost,
    oauth: input.oauth,
  });

  return renderCompose({ name: input.projectSlug, services });
}

interface ManualComposeWizardInput {
  readonly repoRoot: string;
  readonly devHost: string;
  readonly projectSlug: string;
  readonly oauth: {
    readonly enabled: boolean;
    readonly tld: string;
  };
}

function validateRepoRelativeWorkingDir(
  value: string | undefined
): string | undefined {
  const v = value?.trim();
  if (!v) {
    return "Required";
  }
  if (v.startsWith("/")) {
    return "Use a repo-relative path (e.g. ., apps/api)";
  }
  return undefined;
}

function buildManualSuggestedCommand(opts: {
  readonly role: "http" | "internal";
  readonly port: number | undefined;
}): string {
  if (opts.role !== "http") {
    return "bun run dev";
  }
  const port = opts.port ?? 3000;
  return `bun run dev -- --port ${port} --host 0.0.0.0`;
}

async function promptManualServiceDraft(opts: {
  readonly defaultName: string;
  readonly usedServiceNames: Set<string>;
}): Promise<AutoComposeDraft> {
  const role = unwrapPromptValue(
    await select<"http" | "internal">({
      message: `Service role for "${opts.defaultName}":`,
      initialValue: "http",
      options: [
        { value: "http", label: "HTTP (routed via Caddy)" },
        { value: "internal", label: "Internal (not routed via Caddy)" },
      ],
    })
  );

  const name = unwrapPromptValue(
    await text({
      message: "docker compose service name:",
      initialValue: opts.defaultName,
      validate: (value) =>
        validateComposeServiceName({
          value,
          defaultName: opts.defaultName,
          usedServiceNames: opts.usedServiceNames,
        }),
    })
  );
  opts.usedServiceNames.add(name);

  const image = unwrapPromptValue(
    await text({
      message: `Image for "${name}":`,
      initialValue: "imbios/bun-node:latest",
      validate: validateRequiredText,
    })
  );

  const workingDirRel = unwrapPromptValue(
    await text({
      message: `Working dir (relative to repo root) for "${name}":`,
      initialValue: ".",
      validate: validateRepoRelativeWorkingDir,
    })
  );

  const portNum =
    role === "http"
      ? Number.parseInt(
          unwrapPromptValue(
            await text({
              message: `Internal HTTP port for "${name}":`,
              initialValue: String(guessDefaultPort(name)),
              validate: validatePort,
            })
          ),
          10
        )
      : undefined;

  const command = unwrapPromptValue(
    await text({
      message: `Container command for "${name}":`,
      initialValue: buildManualSuggestedCommand({ role, port: portNum }),
      validate: validateRequiredText,
    })
  );

  const relRaw = workingDirRel.trim();
  const rel = normalizeRelativePath(relRaw);
  const workingDir = rel === "." ? "/app" : `/app/${rel}`;

  return {
    name,
    role,
    image: image.trim(),
    port: portNum,
    workingDir,
    command,
  };
}

async function buildManualCompose(
  input: ManualComposeWizardInput
): Promise<string> {
  note(
    [
      "No dev scripts were auto-discovered (or you opted out).",
      "Let’s define your services manually. You can always edit the generated compose after.",
    ].join("\n"),
    "Manual services"
  );

  const usedServiceNames = new Set<string>();
  const drafts: AutoComposeDraft[] = [];

  while (true) {
    const defaultName = uniqueName("app", usedServiceNames);

    drafts.push(
      await promptManualServiceDraft({
        defaultName,
        usedServiceNames,
      })
    );

    const more = unwrapPromptValue(
      await confirm({
        message: "Add another service?",
        initialValue: false,
      })
    );
    if (!more) {
      break;
    }
  }

  await promptHttpSubdomainsForDrafts({
    drafts,
    devHost: input.devHost,
    primaryDefaultStrategy: "first",
  });

  const services = buildServicesFromDrafts({
    drafts,
    devHost: input.devHost,
    oauth: input.oauth,
  });

  return renderCompose({ name: input.projectSlug, services });
}

function buildManualComposeAuto(input: ManualComposeWizardInput): string {
  const port = guessDefaultPort("app");
  const drafts: AutoComposeDraft[] = [
    {
      name: "app",
      role: "http",
      port,
      subdomain: "",
      workingDir: "/app",
      command: `bun run dev -- --port ${port} --host 0.0.0.0`,
    },
  ];

  const services = buildServicesFromDrafts({
    drafts,
    devHost: input.devHost,
    oauth: input.oauth,
  });

  return renderCompose({ name: input.projectSlug, services });
}

function formatCandidateLabel(c: ServiceCandidate): string {
  const base = c.packageName ?? c.packageRelativeDir;
  return `${base} → ${c.scriptName}`;
}

function formatCandidateHint(c: ServiceCandidate): string {
  const dir = c.packageRelativeDir;
  const cmd =
    c.scriptCommand.length > 60
      ? `${c.scriptCommand.slice(0, 57)}…`
      : c.scriptCommand;
  return `${dir} · ${cmd}`;
}

function uniqueName(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) {
    return base;
  }
  for (let i = 2; i < 1000; i += 1) {
    const next = `${base}-${i}`;
    if (!used.has(next)) {
      return next;
    }
  }
  return `${base}-${Date.now()}`;
}

function guessSubdomain(serviceName: string): string {
  const n = serviceName.toLowerCase();
  if (n.includes("api")) {
    return "api";
  }
  if (n === "www" || n === "web") {
    return "www";
  }
  return serviceName;
}

function selectAutoCandidates(opts: {
  readonly candidates: readonly ServiceCandidate[];
}): readonly ServiceCandidate[] {
  const devCandidates = opts.candidates.filter(
    (c) => c.scriptName === "dev" || c.scriptName.startsWith("dev:")
  );
  return devCandidates.length > 0 ? devCandidates : opts.candidates;
}

function resolveAutoServiceName(opts: {
  readonly candidate: ServiceCandidate;
  readonly usedServiceNames: ReadonlySet<string>;
}): string {
  const base = guessServiceName(opts.candidate);
  const normalized = base.length > 0 ? base : "app";
  const safe =
    normalized === "db" || normalized === "redis" ? "app" : normalized;
  return uniqueName(safe, opts.usedServiceNames);
}

function assignAutoSubdomains(opts: {
  readonly drafts: AutoComposeDraft[];
}): void {
  const httpDrafts = opts.drafts.filter((d) => d.role === "http");
  if (httpDrafts.length === 0) {
    return;
  }

  const primary = httpDrafts.find((d) => d.name === "www") ?? httpDrafts[0];
  if (primary) {
    primary.subdomain = "";
  }

  const used = new Set<string>();
  for (const draft of httpDrafts) {
    if (draft === primary) {
      continue;
    }
    const base = guessSubdomain(draft.name);
    const subdomain = uniqueSubdomain({ base, used });
    used.add(subdomain);
    draft.subdomain = subdomain;
  }
}

function uniqueSubdomain(opts: {
  readonly base: string;
  readonly used: ReadonlySet<string>;
}): string {
  const seed = sanitizeProjectSlug(opts.base);
  const normalized = seed.length > 0 ? seed : "app";
  if (!opts.used.has(normalized)) {
    return normalized;
  }
  for (let i = 2; i < 1000; i += 1) {
    const next = `${normalized}-${i}`;
    if (!opts.used.has(next)) {
      return next;
    }
  }
  return `${normalized}-${Date.now()}`;
}

function buildServicesFromDrafts(opts: {
  readonly drafts: readonly AutoComposeDraft[];
  readonly devHost: string;
  readonly oauth: { readonly enabled: boolean; readonly tld: string };
}) {
  return opts.drafts.map((d) => {
    const env = new Map<string, string>([
      ["CHOKIDAR_USEPOLLING", "true"],
      ["WATCHPACK_POLLING", "true"],
    ]);

    const labels = new Map<string, string>();
    const networks = d.role === "http" ? ["hack-dev", "default"] : [];

    if (d.role === "http") {
      const port = d.port ?? 3000;
      const host =
        d.subdomain && d.subdomain.length > 0
          ? `${d.subdomain}.${opts.devHost}`
          : `${opts.devHost}`;
      labels.set(
        "caddy",
        buildCaddyHostLabelValue({ primaryHost: host, oauth: opts.oauth })
      );
      labels.set("caddy.reverse_proxy", `{{upstreams ${port}}}`);
      labels.set("caddy.tls", "internal");
    }

    return {
      name: d.name,
      role: d.role,
      image: d.image ?? "imbios/bun-node:latest",
      workingDir: d.workingDir,
      command: d.command,
      env,
      labels,
      networks,
    };
  });
}

function renderHackFolderReadme(opts: {
  readonly devHost: string;
  readonly oauth?: { readonly enabled: boolean; readonly tld: string };
}): string {
  const oauthEnabled = opts.oauth?.enabled === true;
  const oauthTld = oauthEnabled
    ? normalizeOauthTld(opts.oauth?.tld ?? DEFAULT_OAUTH_ALIAS_TLD)
    : null;
  const oauthHost =
    oauthEnabled && oauthTld ? `${opts.devHost}.${oauthTld}` : null;

  return [
    "# hack local dev",
    "",
    "This repo is configured for the `hack` local-dev platform.",
    "",
    "## Networks",
    "",
    "- `hack-dev`: shared ingress network (Caddy routes only services attached to this network).",
    "- `default`: per-project network created by Docker Compose.",
    "",
    "Rules:",
    "- Only attach **HTTP services** you want routable to `hack-dev`.",
    "- Do **not** attach Postgres/Redis to `hack-dev`.",
    "- Avoid `container_name` (breaks multi-repo).",
    "",
    "## Service-to-service connections (important)",
    "",
    "When services run inside Docker containers, `127.0.0.1` / `localhost` refers to **that container**, not the",
    "other services in the compose file.",
    "",
    "So inside containers, use Docker Compose DNS names:",
    "",
    "- Postgres: host `db`, port `5432`",
    "- Redis: host `redis`, port `6379`",
    "",
    "Example env for an app container:",
    "",
    "```yaml",
    "environment:",
    "  DATABASE_URL: postgres://postgres:postgres@db:5432/mydb",
    "  REDIS_URL: redis://redis:6379",
    "```",
    "",
    "If you need to run tools inside an already-running container, prefer `hack exec`:",
    "",
    "```bash",
    "hack exec db -- psql -U postgres -d mydb",
    "hack exec redis -- redis-cli",
    "```",
    "",
    "## Hostnames",
    "",
    `- Primary app: https://${opts.devHost}`,
    `- Subdomains: https://<sub>.${opts.devHost} (e.g. api.${opts.devHost})`,
    ...(oauthHost
      ? [
          "",
          "OAuth note:",
          `- OAuth-safe alias (public suffix): https://${oauthHost}`,
          `- OAuth-safe subdomains: https://<sub>.${oauthHost} (e.g. api.${oauthHost})`,
        ]
      : []),
    "",
    "## Logs (Grafana + Loki)",
    "",
    "- Open Grafana: https://logs.hack",
    "- Default credentials: `admin` / `admin`",
    "",
    "In **Explore**, try queries like:",
    "",
    '- `{project="<compose-project>"}`',
    '- `{project="<compose-project>", service="api"}`',
    "",
    "Tip: `project`/`service` labels come from Docker Compose labels (via Alloy).",
    "",
    "## Adding a routable HTTP service",
    "",
    "Add a service under `services:` in `.hack/docker-compose.yml` and include:",
    "",
    "```yaml",
    "labels:",
    `  caddy: api.${opts.devHost}`,
    '  caddy.reverse_proxy: "{{upstreams 4000}}"',
    "  caddy.tls: internal",
    "networks:",
    "  - hack-dev",
    "  - default",
    "```",
    "",
    "## Adding Postgres / Redis (optional)",
    "",
    "Postgres (default network only):",
    "",
    "```yaml",
    "db:",
    "  image: postgres:17",
    "  environment:",
    "    POSTGRES_USER: postgres",
    "    POSTGRES_PASSWORD: postgres",
    "    POSTGRES_DB: mydb",
    "  volumes:",
    "    - postgres-data:/var/lib/postgresql/data",
    "  networks:",
    "    - default",
    "```",
    "",
    "Redis (default network only):",
    "",
    "```yaml",
    "redis:",
    "  image: bitnami/redis:latest",
    "  environment:",
    '    ALLOW_EMPTY_PASSWORD: "yes"',
    "  volumes:",
    "    - redis-data:/bitnami/redis/data",
    "  networks:",
    "    - default",
    "```",
    "",
    "Add volumes at the bottom:",
    "",
    "```yaml",
    "volumes:",
    "  postgres-data:",
    "  redis-data:",
    "```",
    "",
    "## DB schema tooling (Prisma / Drizzle)",
    "",
    "For DB tooling in a monorepo, the cleanest approach is to run commands inside the project network so you",
    "don’t need to publish DB ports to your host.",
    "",
    "Option A (recommended): create an ops-only service in `.hack/docker-compose.yml`:",
    "",
    "```yaml",
    "db-ops:",
    "  image: imbios/bun-node:latest",
    "  working_dir: /app/packages/db # adjust to your db package",
    "  volumes:",
    "    - ..:/app",
    "  environment:",
    "    DATABASE_URL: postgres://postgres:postgres@db:5432/mydb",
    "  depends_on:",
    "    - db",
    "  networks:",
    "    - default",
    '  profiles: ["ops"]',
    "  # Prisma:",
    "  # command: bunx prisma migrate deploy",
    "  # Drizzle:",
    "  # command: bunx drizzle-kit push",
    "  command: bun run db:push",
    "```",
    "",
    "Then run it on demand:",
    "",
    "```bash",
    "docker compose -f .hack/docker-compose.yml --profile ops run --rm db-ops",
    "```",
    "",
    "Option B: run one-off commands without adding a new service using `hack run`:",
    "",
    "```bash",
    "hack run --workdir /app/packages/db email-sync -- bunx prisma generate",
    "hack run --workdir /app/packages/db email-sync -- bunx prisma migrate dev",
    "hack run --workdir /app/packages/db email-sync -- bunx drizzle-kit push",
    "```",
    "",
    "If your ops service is behind a compose profile, enable it:",
    "",
    "```bash",
    "hack run --profile ops --workdir /app/packages/db db-ops -- bun run db:push",
    "```",
    "",
    "### If you see: “Host version … does not match binary version …”",
    "",
    "That error is from **esbuild** (often triggered by Drizzle tooling compiling `*.ts` config).",
    "It usually means you’re running container commands against a partially mismatched install (common if you try",
    "to share host `node_modules` into a Linux container).",
    "",
    "Best fix: keep host deps on host, and give containers their own deps via a volume:",
    "",
    "```yaml",
    "services:",
    "  www:",
    "    volumes:",
    "      - ..:/app",
    "      - node_modules:/app/node_modules",
    "",
    "volumes:",
    "  node_modules:",
    "```",
    "",
    "Then install once inside the container volume:",
    "",
    "```bash",
    "hack run --workdir /app www -- bun install",
    "```",
    "",
    "",
  ].join("\n");
}

async function requireProjectContext(startDir: string) {
  const ctx = await findProjectContext(startDir);
  if (!ctx) {
    throw new MissingProjectContextError();
  }
  return ctx;
}

class MissingProjectContextError extends Error {
  constructor() {
    super(
      `No ${HACK_PROJECT_DIR_PRIMARY}/ (or legacy .dev/) found. Run: hack init`
    );
    this.name = "MissingProjectContextError";
  }
}

type RemoteLifecycleAction = "up" | "down" | "restart";

/**
 * Resolve whether project lifecycle commands should run locally or dispatch remotely.
 */
async function resolveProjectLifecycleTarget(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly requestedTarget: string | undefined;
}): Promise<ReturnType<typeof resolveProjectExecutionTarget>> {
  const controlPlane = await readControlPlaneConfig({
    projectDir: opts.project.projectDir,
  });
  if (controlPlane.parseError) {
    logger.warn({ message: controlPlane.parseError });
  }
  const registry = await readNodesRegistry();
  return resolveProjectExecutionTarget({
    requestedTarget: opts.requestedTarget,
    controlPlane: controlPlane.config,
    defaultNodeId: registry.defaultNodeId ?? undefined,
  });
}

/**
 * Ensure dispatch can select this project by resolving/refreshing registration id.
 */
async function resolveDispatchProjectSelector(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
}): Promise<string> {
  const registration = await upsertProjectRegistration({
    project: opts.project,
  });
  if (registration.status === "conflict") {
    return registration.existing.id;
  }
  return registration.project.id;
}

/**
 * Build remote lifecycle command args that always force local execution on target node.
 */
function buildRemoteLifecycleCommand(opts: {
  readonly action: RemoteLifecycleAction;
  readonly branch: string | null;
  readonly profiles: readonly string[];
  readonly envName?: string | null;
  readonly detach?: boolean;
}): readonly string[] {
  const args = [opts.action, "--target", "local"] as string[];
  if (opts.envName) {
    args.push("--env", opts.envName);
  }
  if (opts.branch) {
    args.push("--branch", opts.branch);
  }
  if (opts.profiles.length > 0) {
    args.push("--profile", opts.profiles.join(","));
  }
  if (opts.action === "up" && opts.detach === true) {
    args.push("--detach");
  }
  return args;
}

/**
 * Dispatch lifecycle command to remote node when project execution target resolves to remote.
 */
async function runRemoteLifecycleCommand(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly action: RemoteLifecycleAction;
  readonly branch: string | null;
  readonly profiles: readonly string[];
  readonly envName?: string | null;
  readonly requestedTarget: string | undefined;
  readonly detach?: boolean;
}): Promise<number | null> {
  const target = await resolveProjectLifecycleTarget({
    project: opts.project,
    requestedTarget: opts.requestedTarget,
  });
  if (target.resolvedTarget === "local") {
    return null;
  }

  const projectSelector = await resolveDispatchProjectSelector({
    project: opts.project,
  });
  const dispatchNode = target.nodeSelector ?? "default";
  const remoteCommand = buildRemoteLifecycleCommand({
    action: opts.action,
    branch: opts.branch,
    profiles: opts.profiles,
    envName: opts.envName,
    detach: opts.detach,
  });
  const invocation = await resolveHackInvocation();
  const dispatchArgs = [...invocation.args, "dispatch", "run"] as string[];
  dispatchArgs.push("--project", projectSelector);
  dispatchArgs.push("--node", dispatchNode);
  dispatchArgs.push("--runner", "generic");
  if (opts.branch) {
    dispatchArgs.push("--branch", opts.branch);
  }
  dispatchArgs.push("--", "hack", ...remoteCommand);

  logger.step({
    message: `Dispatching remote ${opts.action} on node ${dispatchNode} (${target.reason})`,
  });
  return await runShell([invocation.bin, ...dispatchArgs], {
    cwd: opts.project.projectRoot,
  });
}

async function handleUp({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: UpArgs;
}): Promise<number> {
  let project: Awaited<ReturnType<typeof requireProjectContext>>;
  try {
    project = await resolveProjectForArgs({
      ctx,
      pathOpt: args.options.path,
      projectOpt: args.options.project,
    });
  } catch (error: unknown) {
    if (error instanceof MissingProjectContextError) {
      logger.error({ message: error.message });
      return 1;
    }
    throw error;
  }
  const detach = args.options.detach;
  const envName = resolveRequestedEnvName({
    envOption: args.options.env,
  });
  const branch = resolveBranchSlug(args.options.branch);
  const profiles = parseCsvList(args.options.profile);

  await touchBranchUsageIfNeeded({ project, branch });
  const remoteUpCode = await runRemoteLifecycleCommand({
    project,
    action: "up",
    branch,
    profiles,
    envName,
    requestedTarget: args.options.target,
    detach,
  });
  if (remoteUpCode !== null) {
    return remoteUpCode;
  }
  await maybeSyncOauthAliasesInCompose({ project });

  const cfg = await readProjectConfig(project);
  if (cfg.parseError) {
    const configPath = cfg.configPath ?? project.configFile;
    logger.warn({
      message: `Failed to parse ${configPath}: ${cfg.parseError}`,
    });
  }

  const baseProjectName = await resolveComposeProjectName({ project, cfg });
  const composeProjectName = branch ? `${baseProjectName}--${branch}` : null;
  const projectName = sanitizeProjectSlug(baseProjectName);
  const lifecycleComposeProject = resolveLifecycleComposeProjectName({
    projectName,
    branch,
  });
  const devHost = branch ? await resolveBranchDevHost({ project }) : null;
  const aliasHost =
    branch && devHost ? resolveBranchAliasHost({ devHost, cfg }) : null;
  const internalSettings = resolveInternalSettings(cfg);
  await maybePromptToStartGlobal({ internal: internalSettings });
  const internalOverride = await resolveInternalComposeOverride({
    project,
    cfg,
    branch,
    devHost,
    aliasHost,
  });
  const composeFiles =
    branch && devHost
      ? await resolveBranchComposeFiles({ project, branch, devHost, aliasHost })
      : [project.composeFile];
  const composeFilesWithInternal = internalOverride
    ? [...composeFiles, internalOverride]
    : composeFiles;

  const targetServices = await readComposeServiceNames(project.composeFile);
  const envOverrides = await resolveComposeEnvOverrides({
    project,
    projectName,
    targetServices,
    allServiceNames: targetServices,
    envName,
  });
  const composeFilesWithEnv = [
    ...composeFilesWithInternal,
    ...envOverrides.composeFiles,
  ];

  await persistProjectRuntimeEnvSelection({
    projectDir: project.projectDir,
    composeProject: lifecycleComposeProject,
    envName: envOverrides.effectiveEnvName,
  });

  try {
    const lifecycleUp = await runLifecycleUpBeforeAndProcesses({
      title: "Lifecycle (up before)",
      project,
      cfg,
      projectName,
      branch,
      env: envOverrides.env,
      composeProject: lifecycleComposeProject,
    });
    if (lifecycleUp.code !== 0) {
      return lifecycleUp.code;
    }
    if (lifecycleUp.sessionName) {
      logger.info({
        message: `Lifecycle processes running in session: ${lifecycleUp.sessionName}`,
      });
    }
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to start lifecycle setup";
    logger.error({ message });
    return 1;
  }

  const upCode = await composeRuntimeBackend.up({
    composeFiles: composeFilesWithEnv,
    composeProject: composeProjectName,
    profiles,
    detach,
    cwd: dirname(project.composeFile),
    env: envOverrides.env,
  });
  if (upCode !== 0) {
    await removeProjectRuntimeStateEntry({
      projectDir: project.projectDir,
      composeProject: lifecycleComposeProject,
    });
    return upCode;
  }

  const afterCode = await runLifecycleCommands({
    title: "Lifecycle (up after)",
    commands: cfg.lifecycle?.up?.after,
    projectRoot: project.projectRoot,
    env: envOverrides.env,
    projectDir: project.projectDir,
    composeProject: lifecycleComposeProject,
  });
  return afterCode;
}

async function maybePromptToStartGlobal(opts: {
  readonly internal: { readonly dns: boolean; readonly tls: boolean };
}): Promise<void> {
  if (!opts.internal.dns) {
    return;
  }
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    return;
  }

  const dnsServer = await resolveCoreDnsServer();
  if (dnsServer) {
    return;
  }

  const ok = await confirm({
    message:
      "Global DNS/TLS is not running. Start it now? (runs `hack global up`, may prompt for sudo)",
    initialValue: true,
  });
  if (isCancel(ok)) {
    throw new Error("Canceled");
  }
  if (!ok) {
    return;
  }

  const exitCode = await globalUp();
  if (exitCode !== 0) {
    logger.warn({
      message:
        "Global infra failed to start; continuing without internal DNS/TLS.",
    });
  }
}

async function handleDown({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: DownArgs;
}): Promise<number> {
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
  });
  const envName = resolveRequestedEnvName({
    envOption: args.options.env,
  });
  const branch = resolveBranchSlug(args.options.branch);
  const profiles = parseCsvList(args.options.profile);

  await touchBranchUsageIfNeeded({ project, branch });
  const remoteDownCode = await runRemoteLifecycleCommand({
    project,
    action: "down",
    branch,
    profiles,
    envName,
    requestedTarget: args.options.target,
  });
  if (remoteDownCode !== null) {
    return remoteDownCode;
  }
  const cfg = await readProjectConfig(project);
  if (cfg.parseError) {
    const configPath = cfg.configPath ?? project.configFile;
    logger.warn({
      message: `Failed to parse ${configPath}: ${cfg.parseError}`,
    });
  }

  const baseProjectName = await resolveComposeProjectName({ project, cfg });
  const composeProjectName = branch ? `${baseProjectName}--${branch}` : null;

  const projectName = sanitizeProjectSlug(baseProjectName);
  const lifecycleComposeProject = resolveLifecycleComposeProjectName({
    projectName,
    branch,
  });
  const effectiveEnvName = await resolveStoredRuntimeEnvName({
    requestedEnvName: envName,
    projectDir: project.projectDir,
    composeProject: lifecycleComposeProject,
  });
  const lifecycleEnv = await resolveLifecycleEnvForProject({
    project,
    projectName,
    envName: effectiveEnvName,
  });

  const beforeCode = await runLifecycleCommands({
    title: "Lifecycle (down before)",
    commands: cfg.lifecycle?.down?.before,
    projectRoot: project.projectRoot,
    env: lifecycleEnv,
    projectDir: project.projectDir,
    composeProject: lifecycleComposeProject,
  });
  if (beforeCode !== 0) {
    return beforeCode;
  }

  const code = await composeRuntimeBackend.down({
    composeFiles: [project.composeFile],
    composeProject: composeProjectName,
    profiles,
    cwd: dirname(project.composeFile),
  });

  try {
    await stopLifecycleProcesses({
      project,
      cfg,
      projectName,
      branch,
      composeProject: lifecycleComposeProject,
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to stop lifecycle processes";
    logger.warn({ message });
  }

  if (code !== 0) {
    return code;
  }
  await removeProjectRuntimeStateEntry({
    projectDir: project.projectDir,
    composeProject: lifecycleComposeProject,
  });
  await maybeManageProjectLogsAfterDown({ project, branch });

  const afterCode = await runLifecycleCommands({
    title: "Lifecycle (down after)",
    commands: cfg.lifecycle?.down?.after,
    projectRoot: project.projectRoot,
    env: lifecycleEnv,
    projectDir: project.projectDir,
    composeProject: lifecycleComposeProject,
  });
  return afterCode;
}

async function runRestartDownPhase(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
  readonly projectName: string;
  readonly composeProjectName: string | null;
  readonly lifecycleComposeProject: string;
  readonly profiles: readonly string[];
  readonly branch: string | null;
  readonly envForCompose: Readonly<Record<string, string>>;
}): Promise<number> {
  const downBefore = await runLifecycleCommands({
    title: "Lifecycle (restart down before)",
    commands: opts.cfg.lifecycle?.down?.before,
    projectRoot: opts.project.projectRoot,
    env: opts.envForCompose,
    projectDir: opts.project.projectDir,
    composeProject: opts.lifecycleComposeProject,
  });
  if (downBefore !== 0) {
    return downBefore;
  }

  const downCode = await composeRuntimeBackend.down({
    composeFiles: [opts.project.composeFile],
    composeProject: opts.composeProjectName,
    profiles: opts.profiles,
    cwd: dirname(opts.project.composeFile),
  });
  try {
    await stopLifecycleProcesses({
      project: opts.project,
      cfg: opts.cfg,
      projectName: opts.projectName,
      branch: opts.branch,
      composeProject: opts.lifecycleComposeProject,
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to stop lifecycle processes";
    logger.warn({ message });
  }
  if (downCode !== 0) {
    return downCode;
  }

  await maybeManageProjectLogsAfterDown({
    project: opts.project,
    branch: opts.branch,
  });

  const downAfter = await runLifecycleCommands({
    title: "Lifecycle (restart down after)",
    commands: opts.cfg.lifecycle?.down?.after,
    projectRoot: opts.project.projectRoot,
    env: opts.envForCompose,
    projectDir: opts.project.projectDir,
    composeProject: opts.lifecycleComposeProject,
  });
  return downAfter;
}

async function runRestartUpPhase(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
  readonly projectName: string;
  readonly composeProjectName: string | null;
  readonly lifecycleComposeProject: string;
  readonly profiles: readonly string[];
  readonly branch: string | null;
  readonly envName?: string | null;
}): Promise<number> {
  await maybeSyncOauthAliasesInCompose({ project: opts.project });

  const devHost = opts.branch
    ? await resolveBranchDevHost({ project: opts.project })
    : null;
  const aliasHost =
    opts.branch && devHost
      ? resolveBranchAliasHost({ devHost, cfg: opts.cfg })
      : null;
  const internalOverride = await resolveInternalComposeOverride({
    project: opts.project,
    cfg: opts.cfg,
    branch: opts.branch,
    devHost,
    aliasHost,
  });
  const composeFiles =
    opts.branch && devHost
      ? await resolveBranchComposeFiles({
          project: opts.project,
          branch: opts.branch,
          devHost,
          aliasHost,
        })
      : [opts.project.composeFile];
  const composeFilesWithInternal = internalOverride
    ? [...composeFiles, internalOverride]
    : composeFiles;

  const targetServices = await readComposeServiceNames(
    opts.project.composeFile
  );
  const envOverrides = await resolveComposeEnvOverrides({
    project: opts.project,
    projectName: opts.projectName,
    targetServices,
    allServiceNames: targetServices,
    envName: opts.envName,
  });
  const composeFilesWithEnv = [
    ...composeFilesWithInternal,
    ...envOverrides.composeFiles,
  ];

  await persistProjectRuntimeEnvSelection({
    projectDir: opts.project.projectDir,
    composeProject: opts.lifecycleComposeProject,
    envName: envOverrides.effectiveEnvName,
  });

  try {
    const lifecycleUp = await runLifecycleUpBeforeAndProcesses({
      title: "Lifecycle (restart up before)",
      project: opts.project,
      cfg: opts.cfg,
      projectName: opts.projectName,
      branch: opts.branch,
      env: envOverrides.env,
      composeProject: opts.lifecycleComposeProject,
    });
    if (lifecycleUp.code !== 0) {
      return lifecycleUp.code;
    }
    if (lifecycleUp.sessionName) {
      logger.info({
        message: `Lifecycle processes running in session: ${lifecycleUp.sessionName}`,
      });
    }
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to start lifecycle setup";
    logger.error({ message });
    return 1;
  }

  const upCode = await composeRuntimeBackend.up({
    composeFiles: composeFilesWithEnv,
    composeProject: opts.composeProjectName,
    profiles: opts.profiles,
    detach: false,
    cwd: dirname(opts.project.composeFile),
    env: envOverrides.env,
  });
  if (upCode !== 0) {
    await removeProjectRuntimeStateEntry({
      projectDir: opts.project.projectDir,
      composeProject: opts.lifecycleComposeProject,
    });
    return upCode;
  }

  const upAfter = await runLifecycleCommands({
    title: "Lifecycle (restart up after)",
    commands: opts.cfg.lifecycle?.up?.after,
    projectRoot: opts.project.projectRoot,
    env: envOverrides.env,
    projectDir: opts.project.projectDir,
    composeProject: opts.lifecycleComposeProject,
  });
  return upAfter;
}

async function handleRestart({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: RestartArgs;
}): Promise<number> {
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
  });
  const envName = resolveRequestedEnvName({
    envOption: args.options.env,
  });
  const branch = resolveBranchSlug(args.options.branch);
  const profiles = parseCsvList(args.options.profile);

  await touchBranchUsageIfNeeded({ project, branch });
  const remoteRestartCode = await runRemoteLifecycleCommand({
    project,
    action: "restart",
    branch,
    profiles,
    envName,
    requestedTarget: args.options.target,
  });
  if (remoteRestartCode !== null) {
    return remoteRestartCode;
  }
  const cfg = await readProjectConfig(project);
  if (cfg.parseError) {
    const configPath = cfg.configPath ?? project.configFile;
    logger.warn({
      message: `Failed to parse ${configPath}: ${cfg.parseError}`,
    });
  }

  const baseProjectName = await resolveComposeProjectName({ project, cfg });
  const composeProjectName = branch ? `${baseProjectName}--${branch}` : null;

  const projectName = sanitizeProjectSlug(baseProjectName);
  const lifecycleComposeProject = resolveLifecycleComposeProjectName({
    projectName,
    branch,
  });
  const effectiveEnvName = await resolveStoredRuntimeEnvName({
    requestedEnvName: envName,
    projectDir: project.projectDir,
    composeProject: lifecycleComposeProject,
  });
  const lifecycleEnv = await resolveLifecycleEnvForProject({
    project,
    projectName,
    envName: effectiveEnvName,
  });

  const downCode = await runRestartDownPhase({
    project,
    cfg,
    projectName,
    composeProjectName,
    lifecycleComposeProject,
    profiles,
    branch,
    envForCompose: lifecycleEnv,
  });
  if (downCode !== 0) {
    return downCode;
  }

  await removeProjectRuntimeStateEntry({
    projectDir: project.projectDir,
    composeProject: lifecycleComposeProject,
  });

  return await runRestartUpPhase({
    project,
    cfg,
    projectName,
    composeProjectName,
    lifecycleComposeProject,
    profiles,
    branch,
    envName: effectiveEnvName,
  });
}

export async function resolveStoredRuntimeEnvName(opts: {
  readonly requestedEnvName: string | null | undefined;
  readonly projectDir: string;
  readonly composeProject: string;
}): Promise<string | null | undefined> {
  if (opts.requestedEnvName !== undefined) {
    return opts.requestedEnvName;
  }

  const state = await readProjectRuntimeStateEntry({
    projectDir: opts.projectDir,
    composeProject: opts.composeProject,
  });
  return state?.envName ?? undefined;
}

async function persistProjectRuntimeEnvSelection(opts: {
  readonly projectDir: string;
  readonly composeProject: string;
  readonly envName: string | null;
}): Promise<void> {
  await upsertProjectRuntimeStateEntry({
    projectDir: opts.projectDir,
    entry: {
      composeProject: opts.composeProject,
      envName: opts.envName,
      updatedAt: new Date().toISOString(),
    },
  });
}

async function maybeManageProjectLogsAfterDown(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly branch: string | null;
}): Promise<void> {
  const cfg = await readProjectConfig(opts.project);
  if (cfg.parseError) {
    const configPath = cfg.configPath ?? opts.project.configFile;
    logger.warn({
      message: `Failed to parse ${configPath}: ${cfg.parseError}`,
    });
  }
  const baseName = await resolveComposeProjectName({
    project: opts.project,
    cfg,
  });
  const projectName = opts.branch ? `${baseName}--${opts.branch}` : baseName;
  const logsCfg = cfg.logs;

  if (!logsCfg) {
    return;
  }

  const baseUrl = (process.env.HACK_LOKI_URL ?? "http://127.0.0.1:3100").trim();
  const lokiReachable = await canReachLoki({ baseUrl });
  if (!lokiReachable) {
    return;
  }

  const selector = buildLogSelector({
    project: projectName.length > 0 ? projectName : null,
    services: [],
  });
  const now = Date.now();

  const lookbackMs = 30 * 24 * 60 * 60 * 1000; // 30d (covers the default global retention)
  const lookbackStart = new Date(now - lookbackMs);

  if (logsCfg.clearOnDown) {
    logger.step({ message: "Clearing Loki logs for this project…" });
    const res = await requestLokiDelete({
      baseUrl,
      query: selector,
      start: lookbackStart,
    });
    if (!res.ok) {
      logger.warn({ message: res.message });
      return;
    }
    logger.success({
      message:
        "Requested Loki log deletion (may take time due to cancellation window)",
    });
    return;
  }

  const retentionRaw = logsCfg.retentionPeriod;
  if (!retentionRaw) {
    return;
  }

  const retentionMs = parseDurationMs(retentionRaw);
  if (!retentionMs) {
    const configPath = cfg.configPath ?? opts.project.configFile;
    logger.warn({
      message: `Invalid logs.retention_period in ${configPath}: "${retentionRaw}" (expected e.g. "24h", "7d")`,
    });
    return;
  }

  const pruneEndMs = now - retentionMs;
  if (pruneEndMs <= lookbackStart.getTime()) {
    return;
  }

  logger.step({
    message: `Pruning Loki logs older than ${retentionRaw} for this project…`,
  });
  const res = await requestLokiDelete({
    baseUrl,
    query: selector,
    start: lookbackStart,
    end: new Date(pruneEndMs),
  });
  if (!res.ok) {
    logger.warn({ message: res.message });
    return;
  }

  logger.success({
    message:
      "Requested Loki log prune (may take time due to cancellation window)",
  });
}

async function handlePs({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: PsArgs;
}): Promise<number> {
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
  });
  const branch = resolveBranchSlug(args.options.branch);
  const profiles = parseCsvList(args.options.profile);
  const json = args.options.json === true;

  await touchBranchUsageIfNeeded({ project, branch });
  const cfg = await readProjectConfig(project);
  if (cfg.parseError) {
    const configPath = cfg.configPath ?? project.configFile;
    logger.warn({
      message: `Failed to parse ${configPath}: ${cfg.parseError}`,
    });
  }

  const baseProjectName = await resolveComposeProjectName({ project, cfg });
  const composeProjectName = branch ? `${baseProjectName}--${branch}` : null;

  const cwd = dirname(project.composeFile);

  if (json) {
    const daemon = await requestDaemonJson({
      path: "/v1/ps",
      query: {
        compose_project: composeProjectName ?? baseProjectName,
        project: baseProjectName,
        branch,
      },
    });
    if (daemon?.ok && daemon.json) {
      process.stdout.write(`${JSON.stringify(daemon.json, null, 2)}\n`);
      return 0;
    }
  }

  const res = await composeRuntimeBackend.psJson({
    composeFiles: [project.composeFile],
    composeProject: composeProjectName,
    profiles,
    cwd,
  });

  if (res.exitCode !== 0) {
    if (json) {
      process.stderr.write("Failed to read docker compose ps JSON output.\n");
      return res.exitCode;
    }
    return await composeRuntimeBackend.ps({
      composeFiles: [project.composeFile],
      composeProject: composeProjectName,
      profiles,
      cwd,
    });
  }

  const entries = parseJsonLines(res.stdout);
  if (json) {
    const payload = {
      project: baseProjectName,
      branch,
      composeProject: composeProjectName ?? baseProjectName,
      items: entries,
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  const rows = entries.map((e) => [
    getString(e, "Service") ?? "",
    getString(e, "Name") ?? "",
    getString(e, "Status") ?? "",
    getString(e, "Ports") ?? "",
  ]);

  await display.table({
    columns: ["SERVICE", "NAME", "STATUS", "PORTS"],
    rows,
  });

  return 0;
}

async function handleRun({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: RunArgs;
}): Promise<number> {
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
  });
  const branch = resolveBranchSlug(args.options.branch);
  const envName = resolveRequestedEnvName({
    envOption: args.options.env,
  });

  await touchBranchUsageIfNeeded({ project, branch });
  const service = (args.positionals.service ?? "").trim();
  if (service.length === 0) {
    throw new CliUsageError("Missing required argument: service");
  }

  const workdir = (args.options.workdir ?? "").trim();
  const profiles = parseCsvList(args.options.profile);
  const cmdArgs = args.positionals.cmd;

  const cfg = await readProjectConfig(project);
  if (cfg.parseError) {
    const configPath = cfg.configPath ?? project.configFile;
    logger.warn({
      message: `Failed to parse ${configPath}: ${cfg.parseError}`,
    });
  }

  const baseProjectName = await resolveComposeProjectName({ project, cfg });
  const composeProjectName = branch ? `${baseProjectName}--${branch}` : null;
  const devHost = branch ? await resolveBranchDevHost({ project }) : null;
  const aliasHost =
    branch && devHost ? resolveBranchAliasHost({ devHost, cfg }) : null;
  const internalOverride = await resolveInternalComposeOverride({
    project,
    cfg,
    branch,
    devHost,
    aliasHost,
  });
  const composeFiles = internalOverride
    ? [project.composeFile, internalOverride]
    : [project.composeFile];

  const projectName = sanitizeProjectSlug(baseProjectName);
  const allServiceNames = await readComposeServiceNames(project.composeFile);
  const envOverrides = await resolveComposeEnvOverrides({
    project,
    projectName,
    targetServices: [service],
    allServiceNames,
    envName,
  });
  const composeFilesWithEnv = [...composeFiles, ...envOverrides.composeFiles];
  const stackIsRunning = await resolveCanSkipRunDependencies({
    composeFiles: composeFilesWithEnv,
    composeProjectKey: composeProjectName ?? baseProjectName,
    composeProject: composeProjectName,
    project,
    profiles,
    effectiveEnvName: envOverrides.effectiveEnvName,
    service,
  });
  return await composeRuntimeBackend.run({
    composeFiles: composeFilesWithEnv,
    composeProject: composeProjectName,
    profiles,
    service,
    noDeps: stackIsRunning,
    workdir: workdir.length > 0 ? workdir : undefined,
    cmdArgs,
    cwd: dirname(project.composeFile),
    env: envOverrides.env,
  });
}

async function handleExec({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: ExecArgs;
}): Promise<number> {
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
  });
  const branch = resolveBranchSlug(args.options.branch);
  const envName = resolveRequestedEnvName({
    envOption: args.options.env,
  });

  await touchBranchUsageIfNeeded({ project, branch });
  const service = (args.positionals.service ?? "").trim();
  if (service.length === 0) {
    throw new CliUsageError("Missing required argument: service");
  }

  const workdir = (args.options.workdir ?? "").trim();
  const profiles = parseCsvList(args.options.profile);
  const cmdArgs = args.positionals.cmd;
  if (cmdArgs.length === 0) {
    throw new CliUsageError("Command is required.");
  }

  const cfg = await readProjectConfig(project);
  if (cfg.parseError) {
    const configPath = cfg.configPath ?? project.configFile;
    logger.warn({
      message: `Failed to parse ${configPath}: ${cfg.parseError}`,
    });
  }

  const baseProjectName = await resolveComposeProjectName({ project, cfg });
  const composeProjectName = branch ? `${baseProjectName}--${branch}` : null;
  const devHost = branch ? await resolveBranchDevHost({ project }) : null;
  const aliasHost =
    branch && devHost ? resolveBranchAliasHost({ devHost, cfg }) : null;
  const internalOverride = await resolveInternalComposeOverride({
    project,
    cfg,
    branch,
    devHost,
    aliasHost,
  });
  const composeFiles = internalOverride
    ? [project.composeFile, internalOverride]
    : [project.composeFile];

  const projectName = sanitizeProjectSlug(baseProjectName);
  const lifecycleComposeProject = resolveLifecycleComposeProjectName({
    projectName,
    branch,
  });
  const allServiceNames = await readComposeServiceNames(project.composeFile);
  const envOverrides = await resolveComposeEnvOverrides({
    project,
    projectName,
    targetServices: [service],
    allServiceNames,
    envName,
  });
  const composeFilesWithEnv = [...composeFiles, ...envOverrides.composeFiles];
  const execReady = await resolveExecTargetReady({
    composeFiles: composeFilesWithEnv,
    composeProjectKey: lifecycleComposeProject,
    composeProject: composeProjectName,
    project,
    profiles,
    effectiveEnvName: envOverrides.effectiveEnvName,
    service,
  });
  if (!execReady.ok) {
    throw new CliUsageError(execReady.message);
  }

  return await composeRuntimeBackend.exec({
    composeFiles: composeFilesWithEnv,
    composeProject: composeProjectName,
    profiles,
    service,
    workdir: workdir.length > 0 ? workdir : undefined,
    cmdArgs,
    cwd: dirname(project.composeFile),
    env: envOverrides.env,
  });
}

async function resolveCanSkipRunDependencies(opts: {
  readonly composeFiles: readonly string[];
  readonly composeProjectKey: string;
  readonly composeProject: string | null;
  readonly profiles: readonly string[];
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly effectiveEnvName: string | null;
  readonly service: string;
}): Promise<boolean> {
  const runtimeState = await readProjectRuntimeStateEntry({
    projectDir: opts.project.projectDir,
    composeProject: opts.composeProjectKey,
  });
  if (runtimeState && runtimeState.envName !== opts.effectiveEnvName) {
    return false;
  }

  const psResult = await composeRuntimeBackend.psJson({
    composeFiles: opts.composeFiles,
    composeProject: opts.composeProject,
    profiles: opts.profiles,
    cwd: dirname(opts.project.composeFile),
  });
  if (psResult.exitCode !== 0) {
    return false;
  }

  const runningServices = parseJsonLines(psResult.stdout);
  return runningServices.some((entry) => {
    const service = getString(entry, "Service")?.trim();
    const state = getString(entry, "State")?.trim().toLowerCase();
    return service === opts.service && state === "running";
  });
}

async function resolveExecTargetReady(opts: {
  readonly composeFiles: readonly string[];
  readonly composeProjectKey: string;
  readonly composeProject: string | null;
  readonly profiles: readonly string[];
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly effectiveEnvName: string | null;
  readonly service: string;
}): Promise<
  { readonly ok: true } | { readonly ok: false; readonly message: string }
> {
  const runtimeState = await readProjectRuntimeStateEntry({
    projectDir: opts.project.projectDir,
    composeProject: opts.composeProjectKey,
  });
  if (runtimeState && runtimeState.envName !== opts.effectiveEnvName) {
    const runningEnv = runtimeState.envName ?? "base";
    const requestedEnv = opts.effectiveEnvName ?? "base";
    return {
      ok: false,
      message: `The running stack uses env ${runningEnv}, but this exec request resolves to ${requestedEnv}. Restart the stack with the requested env or omit --env.`,
    };
  }

  const psResult = await composeRuntimeBackend.psJson({
    composeFiles: opts.composeFiles,
    composeProject: opts.composeProject,
    profiles: opts.profiles,
    cwd: dirname(opts.project.composeFile),
  });
  if (psResult.exitCode !== 0) {
    return {
      ok: false,
      message:
        "Unable to inspect running services for this project. Start the stack with `hack up -d` before using `hack exec`.",
    };
  }

  const runningServices = parseJsonLines(psResult.stdout);
  const targetIsRunning = runningServices.some((entry) => {
    const service = getString(entry, "Service")?.trim();
    const state = getString(entry, "State")?.trim().toLowerCase();
    return service === opts.service && state === "running";
  });
  if (!targetIsRunning) {
    return {
      ok: false,
      message: `Service "${opts.service}" is not running. Start the stack with \`hack up -d\` or use \`hack run ${opts.service} ...\` for a one-off container.`,
    };
  }

  return { ok: true };
}

function computeWantsLokiExplicit(opts: {
  readonly options: {
    readonly loki: boolean | undefined;
    readonly services: string | undefined;
    readonly query: string | undefined;
    readonly since: string | undefined;
    readonly until: string | undefined;
  };
}): boolean {
  return (
    opts.options.loki === true ||
    opts.options.services !== undefined ||
    opts.options.query !== undefined ||
    opts.options.since !== undefined ||
    opts.options.until !== undefined
  );
}

function validateLogsArgs(opts: {
  readonly forceCompose: boolean;
  readonly wantsLokiExplicit: boolean;
  readonly json: boolean;
  readonly pretty: boolean | undefined;
  readonly follow: boolean;
  readonly timeRange: ReturnType<typeof parseLogTimeRange>;
}): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  if (opts.forceCompose && opts.wantsLokiExplicit) {
    return {
      ok: false,
      message:
        "Cannot combine --compose with --loki/--services/--query/--since/--until.",
    };
  }
  if (opts.json && opts.pretty) {
    return { ok: false, message: "Cannot combine --json with --pretty." };
  }
  if (opts.timeRange.error) {
    return { ok: false, message: opts.timeRange.error };
  }
  if (opts.follow && opts.timeRange.end) {
    return { ok: false, message: "Cannot combine --until with --follow." };
  }

  return { ok: true };
}

function resolveLokiServices(opts: {
  readonly servicesOpt: readonly string[];
  readonly positionalService: string | undefined;
}): string[] {
  const serviceFromPositional = (opts.positionalService ?? "").trim();
  if (serviceFromPositional.length === 0) {
    return [...opts.servicesOpt];
  }
  if (opts.servicesOpt.includes(serviceFromPositional)) {
    return [...opts.servicesOpt];
  }
  return [...opts.servicesOpt, serviceFromPositional];
}

function buildLogStreamContext(opts: {
  readonly json: boolean;
  readonly backend: "loki" | "compose";
  readonly projectNameForPrefix: string;
  readonly branch: string | null;
  readonly services: readonly string[] | undefined;
  readonly follow: boolean;
  readonly since: string | undefined;
  readonly until: string | undefined;
}): LogStreamContext | undefined {
  if (!opts.json) {
    return undefined;
  }

  return {
    backend: opts.backend,
    project:
      opts.projectNameForPrefix.length > 0
        ? opts.projectNameForPrefix
        : undefined,
    branch: opts.branch ?? undefined,
    services:
      opts.services && opts.services.length > 0
        ? [...opts.services]
        : undefined,
    follow: opts.follow,
    since: opts.since,
    until: opts.until,
  };
}

function resolveLokiQuery(opts: {
  readonly queryOpt: string | undefined;
  readonly projectNameForPrefix: string;
  readonly services: readonly string[];
}): string {
  const queryRaw = (opts.queryOpt ?? "").trim();
  if (queryRaw.length > 0) {
    return queryRaw;
  }

  return buildLogSelector({
    project:
      opts.projectNameForPrefix.length > 0 ? opts.projectNameForPrefix : null,
    services: [...opts.services],
  });
}

async function runLogsWithLoki(opts: {
  readonly baseUrl: string;
  readonly lokiReachable: boolean;
  readonly projectNameForPrefix: string;
  readonly branch: string | null;
  readonly json: boolean;
  readonly follow: boolean;
  readonly tail: number;
  readonly format: ReturnType<typeof resolveLogFormat>;
  readonly timeRange: ReturnType<typeof parseLogTimeRange>;
  readonly servicesOpt: string | undefined;
  readonly positionalService: string | undefined;
  readonly queryOpt: string | undefined;
  readonly since: string | undefined;
  readonly until: string | undefined;
}): Promise<number> {
  if (isSlimExecutionMode()) {
    process.stderr.write(
      `${renderSlimModeUnavailableMessage({
        feature: "Loki-backed project logs",
        alternative:
          "Use `hack logs --compose` when a Docker-backed compose runtime is available.",
      })}\n`
    );
    return 1;
  }

  if (!opts.lokiReachable) {
    process.stderr.write(`Loki is not reachable at ${opts.baseUrl}.\n`);
    process.stderr.write(
      "Tip: run `hack global install` (or `hack global up`) and ensure Loki is reachable.\n"
    );
    return 1;
  }

  const services = resolveLokiServices({
    servicesOpt: parseCsvList(opts.servicesOpt),
    positionalService: opts.positionalService,
  });

  const streamContext = buildLogStreamContext({
    json: opts.json,
    backend: "loki",
    projectNameForPrefix: opts.projectNameForPrefix,
    branch: opts.branch,
    services,
    follow: opts.follow,
    since: opts.since,
    until: opts.until,
  });

  const query = resolveLokiQuery({
    queryOpt: opts.queryOpt,
    projectNameForPrefix: opts.projectNameForPrefix,
    services,
  });

  return await lokiLogBackend.run({
    baseUrl: opts.baseUrl,
    query,
    follow: opts.follow,
    tail: opts.tail,
    format: opts.format,
    showProjectPrefix: true,
    streamContext,
    start: opts.timeRange.start ?? undefined,
    end: opts.timeRange.end ?? undefined,
  });
}

async function runLogsWithCompose(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly projectNameForPrefix: string;
  readonly composeProject: string | undefined;
  readonly branch: string | null;
  readonly json: boolean;
  readonly follow: boolean;
  readonly tail: number;
  readonly service: string | undefined;
  readonly profiles: readonly string[];
  readonly format: ReturnType<typeof resolveLogFormat>;
  readonly since: string | undefined;
  readonly until: string | undefined;
}): Promise<number> {
  const serviceTrimmed = (opts.service ?? "").trim();
  const servicesForContext =
    serviceTrimmed.length > 0 ? [serviceTrimmed] : undefined;
  const lifecycleComposeProject =
    opts.composeProject ?? opts.projectNameForPrefix;
  const lifecycle = await resolveLifecycleLogCompanion({
    projectDir: opts.project.projectDir,
    composeProject: lifecycleComposeProject,
    service: serviceTrimmed.length > 0 ? serviceTrimmed : undefined,
    follow: opts.follow,
  });
  const streamContext = buildLogStreamContext({
    json: opts.json,
    backend: "compose",
    projectNameForPrefix: opts.projectNameForPrefix,
    branch: opts.branch,
    services: servicesForContext,
    follow: opts.follow,
    since: opts.since,
    until: opts.until,
  });

  return await composeLogBackend.run({
    composeFile: opts.project.composeFile,
    cwd: dirname(opts.project.composeFile),
    follow: opts.follow,
    tail: opts.tail,
    service: opts.service,
    projectName:
      opts.projectNameForPrefix.length > 0
        ? opts.projectNameForPrefix
        : undefined,
    composeProject: opts.composeProject,
    profiles: opts.profiles,
    format: opts.format,
    streamContext,
    lifecycle,
  });
}

async function resolveLifecycleLogCompanion(opts: {
  readonly projectDir: string;
  readonly composeProject: string;
  readonly service: string | undefined;
  readonly follow: boolean;
}): Promise<
  | {
      readonly logPath: string;
      readonly service?: string;
      readonly composeDisabled?: boolean;
    }
  | undefined
> {
  const logPath = resolveLifecycleLogPath({
    projectDir: opts.projectDir,
    composeProject: opts.composeProject,
  });
  const state = await readLifecycleState({ projectDir: opts.projectDir });
  const entry =
    state.find((item) => item.composeProject === opts.composeProject) ?? null;
  const persistentServices = new Set(
    (entry?.processes ?? []).map((process) => process.name)
  );
  const requested = (opts.service ?? "").trim();
  const hasLogFile = await pathExists(logPath);

  if (requested.length > 0) {
    if (persistentServices.has(requested)) {
      return {
        logPath,
        service: requested,
        composeDisabled: true,
      };
    }
    const composeServices = await readComposeServiceNames(
      resolve(opts.projectDir, PROJECT_COMPOSE_FILENAME)
    );
    const composeHasService = composeServices.includes(requested);

    if (composeHasService) {
      if (!(entry || hasLogFile || opts.follow)) {
        return undefined;
      }
      return {
        logPath,
        service: requested,
      };
    }

    if (!(entry || hasLogFile || opts.follow)) {
      return undefined;
    }

    return {
      logPath,
      service: requested,
      composeDisabled: true,
    };
  }

  if (entry) {
    return { logPath };
  }

  if (!(hasLogFile || opts.follow)) {
    return undefined;
  }

  return { logPath };
}

async function handleLogs({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: LogsArgs;
}): Promise<number> {
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
  });
  const branch = resolveBranchSlug(args.options.branch);
  const follow = !args.options.noFollow;
  const tail = args.options.tail ?? 200;
  const service = args.positionals.service;
  const profiles = parseCsvList(args.options.profile);
  const json = args.options.json === true;
  const format = resolveLogFormat({ json, pretty: args.options.pretty });
  const timeRange = parseLogTimeRange({
    since: args.options.since,
    until: args.options.until,
  });

  await touchBranchUsageIfNeeded({ project, branch });
  const wantsLokiExplicit = computeWantsLokiExplicit({ options: args.options });
  const validation = validateLogsArgs({
    forceCompose: args.options.compose === true,
    wantsLokiExplicit,
    json,
    pretty: args.options.pretty,
    follow,
    timeRange,
  });
  if (!validation.ok) {
    process.stderr.write(`${validation.message}\n`);
    return 1;
  }
  const baseUrl = (process.env.HACK_LOKI_URL ?? "http://127.0.0.1:3100").trim();
  const cfg = await readProjectConfig(project);
  if (cfg.parseError) {
    const configPath = cfg.configPath ?? project.configFile;
    logger.warn({
      message: `Failed to parse ${configPath}: ${cfg.parseError}`,
    });
  }
  const baseProjectName = await resolveComposeProjectName({ project, cfg });
  const projectNameForPrefix = branch
    ? `${baseProjectName}--${branch}`
    : baseProjectName;
  const followBackend = cfg.logs?.followBackend ?? "compose";
  const snapshotBackend = cfg.logs?.snapshotBackend ?? "loki";

  const shouldTryLoki = resolveShouldTryLoki({
    forceCompose: args.options.compose === true,
    wantsLokiExplicit,
    follow,
    followBackend,
    snapshotBackend,
  });

  const lokiReachable = shouldTryLoki
    ? await lokiLogBackend.isAvailable({ baseUrl })
    : false;

  const useLoki = resolveUseLoki({
    forceCompose: args.options.compose === true,
    wantsLokiExplicit,
    shouldTryLoki,
    lokiReachable,
  });

  if (useLoki) {
    return await runLogsWithLoki({
      baseUrl,
      lokiReachable,
      projectNameForPrefix,
      branch,
      json,
      follow,
      tail,
      format,
      timeRange,
      servicesOpt: args.options.services,
      positionalService: typeof service === "string" ? service : undefined,
      queryOpt: args.options.query,
      since: args.options.since,
      until: args.options.until,
    });
  }

  // Fallback to docker compose logs when Loki isn't available.
  return await runLogsWithCompose({
    project,
    projectNameForPrefix,
    composeProject: branch ? projectNameForPrefix : undefined,
    branch,
    json,
    follow,
    tail,
    service: typeof service === "string" ? service : undefined,
    profiles,
    format,
    since: args.options.since,
    until: args.options.until,
  });
}

function parseCsvList(value: string | undefined): string[] {
  const raw = (value ?? "").trim();
  if (raw.length === 0) {
    return [];
  }
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const uniq = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (uniq.has(p)) {
      continue;
    }
    uniq.add(p);
    out.push(p);
  }
  return out;
}

function parseLogTimeRange(opts: {
  readonly since: string | undefined;
  readonly until: string | undefined;
}): {
  readonly start: Date | null;
  readonly end: Date | null;
  readonly error?: string;
} {
  const sinceRaw = (opts.since ?? "").trim();
  const untilRaw = (opts.until ?? "").trim();

  if (sinceRaw.length === 0 && untilRaw.length === 0) {
    return { start: null, end: null };
  }

  const now = new Date();
  const start = sinceRaw.length > 0 ? parseTimeInput(sinceRaw, now) : null;
  if (sinceRaw.length > 0 && !start) {
    return {
      start: null,
      end: null,
      error: `Invalid --since: "${sinceRaw}" (expected RFC3339 or duration like 15m)`,
    };
  }

  const end = untilRaw.length > 0 ? parseTimeInput(untilRaw, now) : null;
  if (untilRaw.length > 0 && !end) {
    return {
      start: null,
      end: null,
      error: `Invalid --until: "${untilRaw}" (expected RFC3339 or duration like 15m)`,
    };
  }

  if (start && end && start.getTime() > end.getTime()) {
    return {
      start,
      end,
      error: "--since must be before --until.",
    };
  }

  return { start, end };
}

async function handleOpen({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: OpenArgs;
}): Promise<number> {
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
  });
  const branch = resolveBranchSlug(args.options.branch);
  const json = args.options.json === true;
  const derivedHost = `${defaultProjectSlugFromPath(project.projectRoot)}.${DEFAULT_PROJECT_TLD}`;
  const devHost = (await readProjectDevHost(project)) ?? derivedHost;
  await touchBranchUsageIfNeeded({ project, branch });
  const cfg = await readProjectConfig(project);
  if (cfg.parseError) {
    const configPath = cfg.configPath ?? project.configFile;
    if (json) {
      process.stderr.write(
        `Failed to parse ${configPath}: ${cfg.parseError}\n`
      );
    } else {
      logger.warn({
        message: `Failed to parse ${configPath}: ${cfg.parseError}`,
      });
    }
  }
  const aliasHost = resolveBranchAliasHost({ devHost, cfg });
  const baseHosts = [devHost, aliasHost].filter(
    (host): host is string => typeof host === "string" && host.length > 0
  );

  const targetRaw = (args.positionals.target ?? "").trim();
  const rawHost = resolveRawHost({ targetRaw, devHost });
  const resolvedHost = branch
    ? applyBranchToHost({ host: rawHost, branch, baseHosts })
    : rawHost;
  const url = resolveOpenUrl({ targetRaw, resolvedHost });

  if (json) {
    process.stdout.write(`${JSON.stringify({ url }, null, 2)}\n`);
    return 0;
  }

  logger.step({ message: `Opening ${url}` });
  return await openUrl(url);
}

function hasUrlScheme(value: string): boolean {
  return URL_SCHEME_PATTERN.test(value);
}

/**
 * Parses a potentially quoted string value and returns the quote character and inner value.
 */
function parseQuotedValue(valueTrimmed: string): {
  quote: string | null;
  value: string;
} {
  if (
    valueTrimmed.startsWith('"') &&
    valueTrimmed.endsWith('"') &&
    valueTrimmed.length >= 2
  ) {
    return { quote: '"', value: valueTrimmed.slice(1, -1) };
  }
  if (
    valueTrimmed.startsWith("'") &&
    valueTrimmed.endsWith("'") &&
    valueTrimmed.length >= 2
  ) {
    return { quote: "'", value: valueTrimmed.slice(1, -1) };
  }
  return { quote: null, value: valueTrimmed };
}

/**
 * Normalizes a relative path by removing "./" prefix if present.
 */
function normalizeRelativePath(relRaw: string): string {
  if (relRaw === ".") {
    return ".";
  }
  if (relRaw.startsWith("./")) {
    return relRaw.slice(2);
  }
  return relRaw;
}

/**
 * Resolves the log output format based on options.
 */
function resolveLogFormat(opts: {
  readonly json: boolean;
  readonly pretty: boolean | undefined;
}): "json" | "pretty" | "plain" {
  if (opts.json) {
    return "json";
  }
  if (opts.pretty) {
    return "pretty";
  }
  return "plain";
}

/**
 * Resolves the raw host from target input for the open command.
 */
function resolveRawHost(opts: {
  readonly targetRaw: string;
  readonly devHost: string;
}): string {
  if (opts.targetRaw === "" || opts.targetRaw === "www") {
    return opts.devHost;
  }
  if (opts.targetRaw.includes(".")) {
    return opts.targetRaw;
  }
  return `${opts.targetRaw}.${opts.devHost}`;
}

/**
 * Resolves the final URL to open based on target input.
 */
function resolveOpenUrl(opts: {
  readonly targetRaw: string;
  readonly resolvedHost: string;
}): string {
  if (opts.targetRaw === "logs") {
    return `https://${DEFAULT_GRAFANA_HOST}`;
  }
  if (hasUrlScheme(opts.targetRaw)) {
    return opts.targetRaw;
  }
  return `https://${opts.resolvedHost}`;
}
