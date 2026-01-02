import {
  autocompleteMultiselect,
  confirm,
  isCancel,
  multiselect,
  note,
  text
} from "@clack/prompts"

import { dirname, resolve } from "node:path"
import { YAML } from "bun"

import { composeLogBackend, lokiLogBackend } from "../backends/log-backend.ts"
import { composeRuntimeBackend } from "../backends/runtime-backend.ts"
import { requestLokiDelete, canReachLoki } from "../ui/loki-logs.ts"
import { logger } from "../ui/logger.ts"
import { display } from "../ui/display.ts"
import { renderProjectConfigJson } from "../templates.ts"
import { exec, run } from "../lib/shell.ts"
import {
  readProjectsRegistry,
  resolveRegisteredProjectByName,
  upsertProjectRegistration
} from "../lib/projects-registry.ts"
import {
  defaultProjectSlugFromPath,
  findProjectContext,
  findRepoRootForInit,
  readProjectConfig,
  readProjectDevHost,
  resolveProjectOauthTld,
  sanitizeBranchSlug,
  sanitizeProjectSlug
} from "../lib/project.ts"
import { openUrl } from "../lib/os.ts"
import { parseJsonLines } from "../lib/json-lines.ts"
import { getString, isRecord } from "../lib/guards.ts"
import { touchBranchUsage } from "../lib/branches.ts"
import { parseTimeInput } from "../lib/time.ts"
import { ensureDir, pathExists, readTextFile, writeTextFileIfChanged } from "../lib/fs.ts"
import { parseDurationMs } from "../lib/duration.ts"
import { buildLogSelector, resolveShouldTryLoki, resolveUseLoki } from "../lib/logs.ts"
import {
  buildSuggestedCommand,
  guessDefaultPort,
  guessRole,
  guessServiceName,
  inferPortFromScript
} from "../init/heuristics.ts"
import { discoverRepo } from "../init/discovery.ts"
import { renderCompose } from "../init/compose.ts"
import { installClaudeHooks } from "../agents/claude.ts"
import { installCodexSkill } from "../agents/codex-skill.ts"
import { installCursorRules } from "../agents/cursor.ts"
import { globalUp } from "../commands/global.ts"
import { upsertAgentDocs } from "../mcp/agent-docs.ts"
import { installMcpConfig } from "../mcp/install.ts"
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
  PROJECT_ENV_FILENAME
} from "../constants.ts"
import {
  optDetach,
  optFollow,
  optNoFollow,
  optBranch,
  optPath,
  optPretty,
  optJson,
  optProject,
  optTail,
  optProfile,
  optSince,
  optUntil
} from "../cli/options.ts"
import { CliUsageError, defineCommand, defineOption, withHandler } from "../cli/command.ts"

import type { ServiceCandidate } from "../init/discovery.ts"
import type { CliContext, CommandArgs } from "../cli/command.ts"
import type { LogStreamContext } from "../ui/log-stream.ts"
import type { McpTarget } from "../mcp/install.ts"

const optManual = defineOption({
  name: "manual",
  type: "boolean",
  long: "--manual",
  description: "Skip discovery and define services manually (or generate a minimal compose in --auto)"
} as const)

const optAuto = defineOption({
  name: "auto",
  type: "boolean",
  long: "--auto",
  description: "Run non-interactive init with sensible defaults"
} as const)

const optName = defineOption({
  name: "name",
  type: "string",
  long: "--name",
  valueHint: "<slug>",
  description: "Project slug (default: repo name)"
} as const)

const optDevHost = defineOption({
  name: "devHost",
  type: "string",
  long: "--dev-host",
  valueHint: "<host>",
  description: "DEV_HOST override"
} as const)

const optOauth = defineOption({
  name: "oauth",
  type: "boolean",
  long: "--oauth",
  description: "Enable OAuth-safe alias host"
} as const)

const optOauthTld = defineOption({
  name: "oauthTld",
  type: "string",
  long: "--oauth-tld",
  valueHint: "<tld>",
  description: "OAuth alias TLD override (default: gy)"
} as const)

const optNoDiscovery = defineOption({
  name: "noDiscovery",
  type: "boolean",
  long: "--no-discovery",
  description: "Skip discovery and generate a minimal compose"
} as const)

const initOptions = [
  optPath,
  optManual,
  optAuto,
  optName,
  optDevHost,
  optOauth,
  optOauthTld,
  optNoDiscovery
] as const
const upOptions = [optPath, optProject, optBranch, optDetach, optProfile] as const
const downOptions = [optPath, optProject, optBranch, optProfile] as const
const restartOptions = [optPath, optProject, optBranch, optProfile] as const
const psOptions = [optPath, optProject, optBranch, optProfile, optJson] as const
const optWorkdir = defineOption({
  name: "workdir",
  type: "string",
  long: "--workdir",
  valueHint: "<path>",
  description: "Working directory inside the container (docker compose run -w)"
} as const)
const runOptions = [optPath, optProject, optBranch, optWorkdir, optProfile] as const
const runPositionals = [
  { name: "service", required: true },
  { name: "cmd", required: false, multiple: true }
] as const
const optLoki = defineOption({
  name: "loki",
  type: "boolean",
  long: "--loki",
  description: "Force Loki backend (do not fall back to docker compose logs)"
} as const)

const optCompose = defineOption({
  name: "compose",
  type: "boolean",
  long: "--compose",
  description: "Read logs directly from docker compose (bypass Loki)"
} as const)

const optServices = defineOption({
  name: "services",
  type: "string",
  long: "--services",
  valueHint: "<csv>",
  description: "Filter Loki logs by service(s), comma-separated (e.g. api,www)"
} as const)

const optQuery = defineOption({
  name: "query",
  type: "string",
  long: "--query",
  valueHint: "<logql>",
  description: "Raw LogQL selector/query (overrides auto selector built from project + services)"
} as const)

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
  optUntil
] as const
const logsPositionals = [{ name: "service", required: false }] as const
const openOptions = [optPath, optProject, optBranch, optJson] as const
const openPositionals = [{ name: "target", required: false }] as const

type InitArgs = CommandArgs<typeof initOptions, readonly []>
type UpArgs = CommandArgs<typeof upOptions, readonly []>
type DownArgs = CommandArgs<typeof downOptions, readonly []>
type RestartArgs = CommandArgs<typeof restartOptions, readonly []>
type PsArgs = CommandArgs<typeof psOptions, readonly []>
type RunArgs = CommandArgs<typeof runOptions, typeof runPositionals>
type LogsArgs = CommandArgs<typeof logsOptions, typeof logsPositionals>
type OpenArgs = CommandArgs<typeof openOptions, typeof openPositionals>

const initSpec = defineCommand({
  name: "init",
  summary: "Initialize a repo (generate .hack/ with compose + config)",
  group: "Project",
  options: initOptions,
  positionals: [],
  subcommands: []
} as const)

export const initCommand = withHandler(initSpec, handleInit)

const upSpec = defineCommand({
  name: "up",
  summary: "Start project services (docker compose up)",
  group: "Project",
  options: upOptions,
  positionals: [],
  subcommands: []
} as const)

export const upCommand = withHandler(upSpec, handleUp)

const downSpec = defineCommand({
  name: "down",
  summary: "Stop project services (docker compose down)",
  group: "Project",
  options: downOptions,
  positionals: [],
  subcommands: []
} as const)

export const downCommand = withHandler(downSpec, handleDown)

const restartSpec = defineCommand({
  name: "restart",
  summary: "Restart project services (down then up)",
  group: "Project",
  options: restartOptions,
  positionals: [],
  subcommands: []
} as const)

export const restartCommand = withHandler(restartSpec, handleRestart)

const psSpec = defineCommand({
  name: "ps",
  summary: "Show project status (docker compose ps)",
  group: "Project",
  options: psOptions,
  positionals: [],
  subcommands: []
} as const)

export const psCommand = withHandler(psSpec, handlePs)

const runSpec = defineCommand({
  name: "run",
  summary: "Run a one-off command in a service container (docker compose run --rm)",
  group: "Project",
  options: runOptions,
  positionals: runPositionals,
  subcommands: []
} as const)

export const runCommand = withHandler(runSpec, handleRun)

const logsSpec = defineCommand({
  name: "logs",
  summary: "Tail logs (compose by default; Loki for queries/history via --loki/--query)",
  group: "Project",
  options: logsOptions,
  positionals: logsPositionals,
  subcommands: []
} as const)

export const logsCommand = withHandler(logsSpec, handleLogs)

const openSpec = defineCommand({
  name: "open",
  summary: "Open a URL for the project (default: https://<project>.hack)",
  group: "Project",
  options: openOptions,
  positionals: openPositionals,
  subcommands: []
} as const)

export const openCommand = withHandler(openSpec, handleOpen)

function resolveStartDir(ctx: CliContext, pathOpt: string | undefined): string {
  return pathOpt ? resolve(ctx.cwd, pathOpt) : ctx.cwd
}

async function resolveProjectForArgs(opts: {
  readonly ctx: CliContext
  readonly pathOpt: string | undefined
  readonly projectOpt: string | undefined
}) {
  if (opts.pathOpt && opts.projectOpt) {
    throw new CliUsageError("Use either --path or --project (not both).")
  }

  if (opts.projectOpt) {
    const name = sanitizeProjectSlug(opts.projectOpt)
    if (name.length === 0) throw new CliUsageError("Invalid --project value.")
    const fromRegistry = await resolveRegisteredProjectByName({ name })
    if (!fromRegistry) {
      throw new CliUsageError(
        `Unknown project "${name}". Run 'hack init' in that repo (or run 'hack projects' to see registered projects).`
      )
    }
    await touchProjectRegistration(fromRegistry)
    return fromRegistry
  }

  const startDir = resolveStartDir(opts.ctx, opts.pathOpt)
  const project = await requireProjectContext(startDir)
  await touchProjectRegistration(project)
  return project
}

function resolveBranchSlug(raw: string | undefined): string | null {
  const trimmed = (raw ?? "").trim()
  if (trimmed.length === 0) return null
  const slug = sanitizeBranchSlug(trimmed)
  return slug.length > 0 ? slug : "branch"
}

async function resolveComposeProjectName(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>
  readonly cfg?: Awaited<ReturnType<typeof readProjectConfig>>
}): Promise<string> {
  const composeName = await readComposeProjectName(opts.project.composeFile)
  if (composeName) return composeName

  const derived = defaultProjectSlugFromPath(opts.project.projectRoot)
  const cfgName = (opts.cfg?.name ?? derived).trim()
  return cfgName.length > 0 ? cfgName : derived
}

async function readComposeProjectName(composeFile: string): Promise<string | null> {
  const text = await readTextFile(composeFile)
  if (!text) return null

  let parsed: unknown
  try {
    parsed = YAML.parse(text)
  } catch {
    return null
  }

  if (!isRecord(parsed)) return null
  const name = getString(parsed, "name")
  const trimmed = name?.trim() ?? ""
  return trimmed.length > 0 ? trimmed : null
}

async function buildBranchComposeOverride(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>
  readonly branch: string
  readonly devHost: string
  readonly aliasHost: string | null
}): Promise<string | null> {
  const yamlText = await readTextFile(opts.project.composeFile)
  if (!yamlText) return null

  let parsed: unknown
  try {
    parsed = YAML.parse(yamlText)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null

  const servicesRaw = parsed["services"]
  if (!isRecord(servicesRaw)) return null

  const baseHosts = [opts.devHost, opts.aliasHost].filter(
    (host): host is string => typeof host === "string" && host.length > 0
  )

  const overrideServices: Record<string, { labels: Record<string, string> }> = {}
  let changed = false

  for (const [serviceName, serviceRaw] of Object.entries(servicesRaw)) {
    if (!isRecord(serviceRaw)) continue

    const labels = normalizeLabels(serviceRaw["labels"])
    if (!labels) continue

    const caddyRaw = labels["caddy"]
    if (typeof caddyRaw !== "string" || caddyRaw.trim().length === 0) continue

    const rewritten = rewriteCaddyLabelForBranch({
      value: caddyRaw,
      branch: opts.branch,
      baseHosts
    })
    if (!rewritten.changed) continue

    labels["caddy"] = rewritten.value
    overrideServices[serviceName] = { labels }
    changed = true
  }

  if (!changed) return null

  const override = { services: overrideServices }
  const yaml = YAML.stringify(override, null, 2)
  return ensureTrailingNewline(cleanupYaml(yaml))
}

function normalizeLabels(raw: unknown): Record<string, string> | null {
  if (isRecord(raw)) {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        out[k] = String(v)
      }
    }
    return Object.keys(out).length > 0 ? out : null
  }

  if (Array.isArray(raw)) {
    const out: Record<string, string> = {}
    for (const item of raw) {
      if (typeof item !== "string") continue
      const idx = item.indexOf("=")
      if (idx <= 0) continue
      const key = item.slice(0, idx).trim()
      const value = item.slice(idx + 1).trim()
      if (key.length === 0) continue
      out[key] = value
    }
    return Object.keys(out).length > 0 ? out : null
  }

  return null
}

function rewriteCaddyLabelForBranch(opts: {
  readonly value: string
  readonly branch: string
  readonly baseHosts: readonly string[]
}): { readonly value: string; readonly changed: boolean } {
  const parts = opts.value
    .split(",")
    .map(h => h.trim())
    .filter(h => h.length > 0)

  if (parts.length === 0) return { value: opts.value, changed: false }

  const out: string[] = []
  const seen = new Set<string>()
  let changed = false

  for (const host of parts) {
    let next = host
    for (const baseHost of opts.baseHosts) {
      const rewritten = rewriteHostForBranch({ host, branch: opts.branch, baseHost })
      if (rewritten.changed) {
        next = rewritten.host
        changed = true
        break
      }
    }

    if (seen.has(next)) continue
    seen.add(next)
    out.push(next)
  }

  return { value: out.join(", "), changed }
}

function rewriteHostForBranch(opts: {
  readonly host: string
  readonly branch: string
  readonly baseHost: string
}): { readonly host: string; readonly changed: boolean } {
  if (opts.host === opts.baseHost) {
    const next = `${opts.branch}.${opts.baseHost}`
    return { host: next, changed: next !== opts.host }
  }

  const suffix = `.${opts.baseHost}`
  if (!opts.host.endsWith(suffix)) return { host: opts.host, changed: false }

  const prefix = opts.host.slice(0, opts.host.length - suffix.length)
  if (prefix === opts.branch || prefix.endsWith(`.${opts.branch}`)) {
    return { host: opts.host, changed: false }
  }

  return { host: `${prefix}.${opts.branch}.${opts.baseHost}`, changed: true }
}

function applyBranchToHost(opts: {
  readonly host: string
  readonly branch: string
  readonly baseHosts: readonly string[]
}): string {
  for (const baseHost of opts.baseHosts) {
    const rewritten = rewriteHostForBranch({
      host: opts.host,
      branch: opts.branch,
      baseHost
    })
    if (rewritten.changed) return rewritten.host
  }
  return opts.host
}

function cleanupYaml(yaml: string): string {
  return yaml.replaceAll(/: \n/g, ":\n")
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`
}

async function resolveBranchComposeFiles(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>
  readonly branch: string
  readonly devHost: string
  readonly aliasHost: string | null
}): Promise<readonly string[]> {
  const override = await buildBranchComposeOverride(opts)
  if (!override) return [opts.project.composeFile]

  const overrideDir = resolve(opts.project.projectDir, ".branch")
  await ensureDir(overrideDir)
  const overridePath = resolve(overrideDir, `compose.${opts.branch}.override.yml`)
  await writeTextFileIfChanged(overridePath, override)
  return [opts.project.composeFile, overridePath]
}

const INTERNAL_CA_CONTAINER_DIR = "/etc/hack/ca"
const INTERNAL_CA_CONTAINER_PATH = `${INTERNAL_CA_CONTAINER_DIR}/caddy-local-authority.crt`

async function resolveInternalComposeOverride(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>
}): Promise<string | null> {
  const internal = resolveInternalSettings(opts.cfg)
  if (!internal.dns && !internal.tls) return null

  const services = await readComposeServiceNames(opts.project.composeFile)
  if (services.length === 0) return null

  let dnsServer: string | null = null
  if (internal.dns) {
    dnsServer = await resolveCoreDnsServer()
    if (!dnsServer) {
      logger.warn({
        message:
          "CoreDNS is not reachable; internal DNS for *.hack is disabled. Run `hack global install` (or `hack global up`)."
      })
    }
  }

  let caPath: string | null = null
  if (internal.tls) {
    caPath = await resolveCaddyLocalCaPath()
    if (!caPath) {
      logger.warn({
        message:
          "Caddy Local CA cert not found; internal TLS trust is disabled. Run `hack global trust` (or `hack global ca`)."
      })
    }
  }

  if (!dnsServer && !caPath) return null

  const overrideServices: Record<string, Record<string, unknown>> = {}
  for (const service of services) {
    const entry: Record<string, unknown> = {}
    if (dnsServer) {
      entry["dns"] = [dnsServer]
    }
    if (caPath) {
      entry["volumes"] = [`${caPath}:${INTERNAL_CA_CONTAINER_PATH}:ro`]
      entry["environment"] = {
        SSL_CERT_FILE: INTERNAL_CA_CONTAINER_PATH,
        SSL_CERT_DIR: INTERNAL_CA_CONTAINER_DIR,
        NODE_EXTRA_CA_CERTS: INTERNAL_CA_CONTAINER_PATH,
        REQUESTS_CA_BUNDLE: INTERNAL_CA_CONTAINER_PATH,
        CURL_CA_BUNDLE: INTERNAL_CA_CONTAINER_PATH,
        GIT_SSL_CAINFO: INTERNAL_CA_CONTAINER_PATH
      }
    }
    overrideServices[service] = entry
  }

  const override = { services: overrideServices }
  const yaml = YAML.stringify(override, null, 2)
  const text = ensureTrailingNewline(cleanupYaml(yaml))

  const overrideDir = resolve(opts.project.projectDir, ".internal")
  await ensureDir(overrideDir)
  const overridePath = resolve(overrideDir, "compose.override.yml")
  await writeTextFileIfChanged(overridePath, text)
  return overridePath
}

function resolveInternalSettings(cfg: Awaited<ReturnType<typeof readProjectConfig>>): {
  readonly dns: boolean
  readonly tls: boolean
} {
  return {
    dns: cfg.internal?.dns ?? true,
    tls: cfg.internal?.tls ?? true
  }
}

async function readComposeServiceNames(composeFile: string): Promise<readonly string[]> {
  const text = await readTextFile(composeFile)
  if (!text) return []

  let parsed: unknown
  try {
    parsed = YAML.parse(text)
  } catch {
    return []
  }

  if (!isRecord(parsed)) return []
  const servicesRaw = parsed["services"]
  if (!isRecord(servicesRaw)) return []
  return Object.keys(servicesRaw).sort((a, b) => a.localeCompare(b))
}

async function resolveCoreDnsServer(): Promise<string | null> {
  const env = (process.env.HACK_COREDNS_IP ?? "").trim()
  if (env.length > 0) return env

  const home = process.env.HOME
  if (!home) return null

  const composePath = resolve(
    home,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_CADDY_DIR_NAME,
    GLOBAL_CADDY_COMPOSE_FILENAME
  )
  if (!(await pathExists(composePath))) return null

  const ps = await exec(["docker", "compose", "-f", composePath, "ps", "-q", "coredns"], {
    cwd: dirname(composePath),
    stdin: "ignore"
  })
  const id = ps.exitCode === 0 ? ps.stdout.trim() : ""
  if (!id) return null

  const inspect = await exec(["docker", "inspect", "--format", "{{json .NetworkSettings.Networks}}", id], {
    stdin: "ignore"
  })
  if (inspect.exitCode !== 0) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(inspect.stdout)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null

  const network = parsed[DEFAULT_INGRESS_NETWORK]
  if (!isRecord(network)) return null
  const ip = network["IPAddress"]
  return typeof ip === "string" && ip.length > 0 ? ip : null
}

async function resolveCaddyLocalCaPath(): Promise<string | null> {
  const home = process.env.HOME
  if (!home) return null
  const certPath = resolve(
    home,
    GLOBAL_HACK_DIR_NAME,
    GLOBAL_CADDY_DIR_NAME,
    "pki",
    "caddy-local-authority.crt"
  )
  return (await pathExists(certPath)) ? certPath : null
}

async function resolveBranchDevHost(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>
}): Promise<string> {
  const devHost = await readProjectDevHost(opts.project)
  if (devHost) return devHost
  throw new Error(
    `Missing dev_host in ${opts.project.configFile} (or ${PROJECT_CONFIG_LEGACY_FILENAME}). Run: hack init`
  )
}

function resolveBranchAliasHost(opts: {
  readonly devHost: string
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>
}): string | null {
  const tld = resolveProjectOauthTld(opts.cfg.oauth)
  return tld ? `${opts.devHost}.${tld}` : null
}

async function touchBranchUsageIfNeeded(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>
  readonly branch: string | null
}): Promise<void> {
  if (!opts.branch) return
  const res = await touchBranchUsage({
    projectDir: opts.project.projectDir,
    branch: opts.branch,
    createIfMissing: true
  })
  if (res.error) {
    logger.warn({
      message: `Failed to update ${res.path}: ${res.error}`
    })
  }
}

async function touchProjectRegistration(
  project: Awaited<ReturnType<typeof requireProjectContext>>
): Promise<void> {
  const outcome = await upsertProjectRegistration({ project })
  if (outcome.status === "conflict") {
    logger.warn({
      message: [
        `Project name conflict: "${outcome.conflictName}" is already registered at ${outcome.existing.repoRoot}`,
        `Incoming project dir: ${outcome.incoming.projectDir}`,
        "Tip: rename one project (hack.config.json name) to keep names unique."
      ].join("\n")
    })
  }
}

async function handleInit({
  ctx,
  args
}: {
  readonly ctx: CliContext
  readonly args: InitArgs
}): Promise<number> {
  if (args.options.auto) {
    return await handleInitAuto({ ctx, args })
  }

  const startDir = resolveStartDir(ctx, args.options.path)
  const repoRoot = await findRepoRootForInit(startDir)

  const defaultSlug = defaultProjectSlugFromPath(repoRoot)
  const initialSlug = sanitizeProjectSlug(args.options.name ?? defaultSlug)
  const name = await text({
    message: "Project name (slug):",
    initialValue: initialSlug,
    validate: value => {
      const v = value?.trim()
      if (!v) return "Required"
      const s = sanitizeProjectSlug(v)
      if (s.length === 0) return "Invalid"
      return undefined
    }
  })
  if (isCancel(name)) return 1
  const slug = sanitizeProjectSlug(name)

  // Enforce uniqueness of compose project name across registered projects.
  const registry = await readProjectsRegistry()
  const existing = registry.projects.find(p => p.name === slug) ?? null
  if (existing) {
    const expectedProjectDir = resolve(repoRoot, HACK_PROJECT_DIR_PRIMARY)
    const isSame = existing.projectDir === expectedProjectDir
    const stillExists = await pathExists(existing.projectDir)
    if (!isSame && stillExists) {
      throw new Error(
        [
          `Project name "${slug}" is already registered.`,
          `Existing: ${existing.repoRoot}`,
          `This repo: ${repoRoot}`,
          "Tip: choose a different name (or rename the other project)."
        ].join("\n")
      )
    }
  }

  const defaultHost = `${slug}.${DEFAULT_PROJECT_TLD}`
  const initialHost = (args.options.devHost ?? defaultHost).trim()
  const devHost = await text({
    message: "DEV_HOST:",
    initialValue: initialHost,
    validate: value => {
      const v = value?.trim()
      if (!v) return "Required"
      if (v.includes(" ")) return "No spaces"
      if (v.includes("://")) return "Host only (no scheme)"
      if (v.includes("/")) return "Host only (no path)"
      if (v.includes(":")) return "Host only (no port)"
      return undefined
    }
  })
  if (isCancel(devHost)) return 1

  const enableOauthHost = await confirm({
    message: `Enable OAuth-safe alias host (https://<project>.${DEFAULT_PROJECT_TLD}.${DEFAULT_OAUTH_ALIAS_TLD})?`,
    initialValue: args.options.oauth === true || Boolean(args.options.oauthTld)
  })
  if (isCancel(enableOauthHost)) return 1
  const oauthTld =
    enableOauthHost ?
      await text({
        message: "OAuth alias TLD (optional):",
        initialValue: args.options.oauthTld ?? DEFAULT_OAUTH_ALIAS_TLD,
        validate: value => {
          const v = value?.trim().toLowerCase()
          if (!v) return "Required"
          if (!/^[a-z0-9][a-z0-9-]*$/.test(v)) return "Invalid TLD label"
          return undefined
        }
      })
    : DEFAULT_OAUTH_ALIAS_TLD
  if (isCancel(oauthTld)) return 1

  const discovery = await discoverRepo(repoRoot)
  const canDiscover = discovery.candidates.length > 0

  const forceManual = args.options.manual || args.options.noDiscovery

  if (canDiscover && !forceManual) {
    note(
      [
        `Detected ${discovery.packages.length} package(s) and ${discovery.candidates.length} dev-like script(s).`,
        discovery.isMonorepo ? "Monorepo detected." : "Single-package repo detected.",
        discovery.signals.length > 0 ? `Signals: ${discovery.signals.join(", ")}` : "Signals: none"
      ].join("\n"),
      "Discovery"
    )
  }

  const useDiscovery =
    forceManual ? false
    : canDiscover ?
      await confirm({
        message: "Auto-discover dev scripts and generate services?",
        initialValue: true
      })
    : false

  if (isCancel(useDiscovery)) return 1

  const hackDir = resolve(repoRoot, HACK_PROJECT_DIR_PRIMARY)
  const composeFile = resolve(hackDir, PROJECT_COMPOSE_FILENAME)
  const configFile = resolve(hackDir, PROJECT_CONFIG_FILENAME)

  if (await pathExists(hackDir)) {
    const ok = await confirm({
      message: `${HACK_PROJECT_DIR_PRIMARY}/ already exists. Overwrite scaffold files?`,
      initialValue: false
    })
    if (isCancel(ok)) return 1
    if (!ok) return 0
  } else {
    await ensureDir(hackDir)
  }

  await writeTextFileIfChanged(
    configFile,
    renderProjectConfigJson({
      name: slug,
      devHost,
      oauth: { enabled: enableOauthHost, tld: String(oauthTld) }
    })
  )

  const compose =
    useDiscovery ?
      await buildDiscoveredCompose({
        repoRoot,
        devHost,
        projectSlug: slug,
        candidates: discovery.candidates,
        oauth: { enabled: enableOauthHost, tld: String(oauthTld) }
      })
    : await buildManualCompose({
        repoRoot,
        devHost,
        projectSlug: slug,
        oauth: { enabled: enableOauthHost, tld: String(oauthTld) }
      })
  await writeTextFileIfChanged(composeFile, compose)

  await writeTextFileIfChanged(
    resolve(hackDir, "README.md"),
    renderHackFolderReadme({
      devHost,
      oauth: { enabled: enableOauthHost, tld: String(oauthTld) }
    })
  )

  const registration = await upsertProjectRegistration({
    project: {
      projectRoot: repoRoot,
      projectDirName: HACK_PROJECT_DIR_PRIMARY,
      projectDir: hackDir,
      composeFile,
      envFile: resolve(hackDir, PROJECT_ENV_FILENAME),
      configFile
    }
  })
  if (registration.status === "conflict") {
    throw new Error(
      [
        `Project name conflict: "${registration.conflictName}" is already registered at ${registration.existing.repoRoot}`,
        `Incoming project dir: ${registration.incoming.projectDir}`,
        "Tip: choose a different name in 'hack init'."
      ].join("\n")
    )
  }

  await maybeSetupAgentIntegrations({ repoRoot })

  note(
    [
      `Wrote: ${HACK_PROJECT_DIR_PRIMARY}/${PROJECT_COMPOSE_FILENAME}`,
      `Wrote: ${HACK_PROJECT_DIR_PRIMARY}/${PROJECT_CONFIG_FILENAME}`,
      `Wrote: ${HACK_PROJECT_DIR_PRIMARY}/README.md`,
      "",
      "Next:",
      "  hack up",
      "  hack open"
    ].join("\n"),
    "Initialized"
  )

  return 0
}

async function handleInitAuto({
  ctx,
  args
}: {
  readonly ctx: CliContext
  readonly args: InitArgs
}): Promise<number> {
  const startDir = resolveStartDir(ctx, args.options.path)
  const repoRoot = await findRepoRootForInit(startDir)

  const slug = resolveInitSlug({
    repoRoot,
    nameOpt: args.options.name
  })

  await ensureUniqueProjectSlug({
    repoRoot,
    slug
  })

  const devHost = resolveInitDevHost({
    slug,
    devHostOpt: args.options.devHost
  })

  const oauthEnabled = args.options.oauth === true || Boolean(args.options.oauthTld)
  const oauth = resolveInitOauth({
    enabled: oauthEnabled,
    tldOpt: args.options.oauthTld
  })

  const discovery = await discoverRepo(repoRoot)
  const canDiscover = discovery.candidates.length > 0
  const skipDiscovery = args.options.manual || args.options.noDiscovery
  const useDiscovery = canDiscover && !skipDiscovery

  const hackDir = resolve(repoRoot, HACK_PROJECT_DIR_PRIMARY)
  const composeFile = resolve(hackDir, PROJECT_COMPOSE_FILENAME)
  const configFile = resolve(hackDir, PROJECT_CONFIG_FILENAME)

  if (await pathExists(hackDir)) {
    throw new Error(
      `${HACK_PROJECT_DIR_PRIMARY}/ already exists. Run without --auto to overwrite.`
    )
  }

  await ensureDir(hackDir)

  await writeTextFileIfChanged(
    configFile,
    renderProjectConfigJson({
      name: slug,
      devHost,
      oauth: { enabled: oauth.enabled, tld: oauth.tld }
    })
  )

  const compose = useDiscovery ?
      await buildDiscoveredComposeAuto({
        repoRoot,
        devHost,
        projectSlug: slug,
        candidates: discovery.candidates,
        oauth
      })
    : await buildManualComposeAuto({
        repoRoot,
        devHost,
        projectSlug: slug,
        oauth
      })
  await writeTextFileIfChanged(composeFile, compose)

  await writeTextFileIfChanged(
    resolve(hackDir, "README.md"),
    renderHackFolderReadme({
      devHost,
      oauth: { enabled: oauth.enabled, tld: oauth.tld }
    })
  )

  const registration = await upsertProjectRegistration({
    project: {
      projectRoot: repoRoot,
      projectDirName: HACK_PROJECT_DIR_PRIMARY,
      projectDir: hackDir,
      composeFile,
      envFile: resolve(hackDir, PROJECT_ENV_FILENAME),
      configFile
    }
  })
  if (registration.status === "conflict") {
    throw new Error(
      [
        `Project name conflict: "${registration.conflictName}" is already registered at ${registration.existing.repoRoot}`,
        `Incoming project dir: ${registration.incoming.projectDir}`,
        "Tip: choose a different name in 'hack init'."
      ].join("\n")
    )
  }

  logger.success({
    message: `Initialized ${HACK_PROJECT_DIR_PRIMARY}/ for ${slug}`
  })
  logger.info({
    message: "Next: hack up --detach && hack open"
  })

  return 0
}

function resolveInitSlug(opts: { readonly repoRoot: string; readonly nameOpt?: string }): string {
  const fallback = defaultProjectSlugFromPath(opts.repoRoot)
  const raw = (opts.nameOpt ?? fallback).trim()
  if (!raw) return fallback
  return sanitizeProjectSlug(raw)
}

async function ensureUniqueProjectSlug(opts: {
  readonly repoRoot: string
  readonly slug: string
}): Promise<void> {
  const registry = await readProjectsRegistry()
  const existing = registry.projects.find(p => p.name === opts.slug) ?? null
  if (!existing) return

  const expectedProjectDir = resolve(opts.repoRoot, HACK_PROJECT_DIR_PRIMARY)
  const isSame = existing.projectDir === expectedProjectDir
  const stillExists = await pathExists(existing.projectDir)
  if (!isSame && stillExists) {
    throw new Error(
      [
        `Project name "${opts.slug}" is already registered.`,
        `Existing: ${existing.repoRoot}`,
        `This repo: ${opts.repoRoot}`,
        "Tip: choose a different name (or rename the other project)."
      ].join("\n")
    )
  }
}

function resolveInitDevHost(opts: {
  readonly slug: string
  readonly devHostOpt?: string
}): string {
  const fallback = `${opts.slug}.${DEFAULT_PROJECT_TLD}`
  const raw = (opts.devHostOpt ?? fallback).trim()
  const error = validateDevHost({ value: raw })
  if (error) throw new Error(`Invalid --dev-host: ${error}`)
  return raw
}

function resolveInitOauth(opts: {
  readonly enabled: boolean
  readonly tldOpt?: string
}): { readonly enabled: boolean; readonly tld: string } {
  const raw = (opts.tldOpt ?? DEFAULT_OAUTH_ALIAS_TLD).trim().toLowerCase()
  const error = validateOauthTld({ value: raw })
  if (error) throw new Error(`Invalid --oauth-tld: ${error}`)
  return { enabled: opts.enabled, tld: raw }
}

function validateDevHost(opts: { readonly value: string }): string | null {
  if (!opts.value) return "Required"
  if (opts.value.includes(" ")) return "No spaces"
  if (opts.value.includes("://")) return "Host only (no scheme)"
  if (opts.value.includes("/")) return "Host only (no path)"
  if (opts.value.includes(":")) return "Host only (no port)"
  return null
}

function validateOauthTld(opts: { readonly value: string }): string | null {
  if (!opts.value) return "Required"
  if (!/^[a-z0-9][a-z0-9-]*$/.test(opts.value)) return "Invalid TLD label"
  return null
}

type SetupIntegration = "cursor" | "claude" | "codex" | "agents" | "mcp"

async function maybeSetupAgentIntegrations(opts: { readonly repoRoot: string }): Promise<void> {
  const shouldSetup = await confirm({
    message: "Set up coding agent integrations? (Cursor/Claude/Codex)",
    initialValue: true
  })
  if (isCancel(shouldSetup) || !shouldSetup) return

  const selected = await multiselect<SetupIntegration>({
    message: "Select integrations to install:",
    required: true,
    options: [
      { value: "cursor", label: "Cursor rules (.cursor/rules/hack.mdc)" },
      { value: "claude", label: "Claude Code hooks (.claude/settings.local.json)" },
      { value: "codex", label: "Codex skill (.codex/skills/hack-cli)" },
      { value: "agents", label: "AGENTS.md / CLAUDE.md snippets" },
      { value: "mcp", label: "MCP config (no-shell clients)" }
    ],
    initialValues: ["cursor", "claude", "codex"]
  })
  if (isCancel(selected) || selected.length === 0) return

  const selection = new Set(selected)

  if (selection.has("cursor")) {
    const result = await installCursorRules({ scope: "project", projectRoot: opts.repoRoot })
    logInstallResult({ label: "Cursor rules", status: result.status, path: result.path, message: result.message })
  }

  if (selection.has("claude")) {
    const result = await installClaudeHooks({ scope: "project", projectRoot: opts.repoRoot })
    logInstallResult({ label: "Claude hooks", status: result.status, path: result.path, message: result.message })
  }

  if (selection.has("codex")) {
    const result = await installCodexSkill({ scope: "project", projectRoot: opts.repoRoot })
    logInstallResult({ label: "Codex skill", status: result.status, path: result.path, message: result.message })
  }

  if (selection.has("agents")) {
    const results = await upsertAgentDocs({
      projectRoot: opts.repoRoot,
      targets: ["agents", "claude"]
    })
    for (const result of results) {
      logInstallResult({
        label: "Agent docs",
        status: result.status,
        path: result.path,
        message: result.message
      })
    }
  }

  if (selection.has("mcp")) {
    const targetHints = selected.filter(value => value === "cursor" || value === "claude" || value === "codex")
    const targets = (targetHints.length > 0 ? targetHints : ["cursor", "claude", "codex"]) as McpTarget[]

    const results = await installMcpConfig({
      targets,
      scope: "project",
      projectRoot: opts.repoRoot
    })

    for (const result of results) {
      logInstallResult({
        label: "MCP config",
        status: result.status,
        path: result.path ?? "unknown path",
        message: result.message
      })
    }
  }
}

function logInstallResult(opts: {
  readonly label: string
  readonly status: string
  readonly path: string
  readonly message?: string
}): void {
  if (opts.status === "error") {
    logger.warn({ message: opts.message ?? `Failed to update ${opts.label}` })
    return
  }

  if (opts.status === "noop") {
    logger.info({ message: `No changes for ${opts.label} (${opts.path})` })
    return
  }

  logger.success({ message: `Updated ${opts.label} at ${opts.path}` })
}

interface ComposeWizardInput {
  readonly repoRoot: string
  readonly devHost: string
  readonly projectSlug: string
  readonly candidates: readonly ServiceCandidate[]
  readonly oauth: {
    readonly enabled: boolean
    readonly tld: string
  }
}

function normalizeOauthTld(raw: string): string {
  const t = raw.trim().toLowerCase()
  if (t.length === 0) return DEFAULT_OAUTH_ALIAS_TLD
  if (!/^[a-z0-9][a-z0-9-]*$/.test(t)) return DEFAULT_OAUTH_ALIAS_TLD
  return t
}

function buildCaddyHostLabelValue(opts: {
  readonly primaryHost: string
  readonly oauth: { readonly enabled: boolean; readonly tld: string }
}): string {
  if (!opts.oauth.enabled) return opts.primaryHost
  if (!opts.primaryHost.endsWith(`.${DEFAULT_PROJECT_TLD}`)) return opts.primaryHost

  const tld = normalizeOauthTld(opts.oauth.tld)
  const aliasHost = `${opts.primaryHost}.${tld}`

  const uniq = new Set<string>()
  const out: string[] = []
  for (const host of [opts.primaryHost, aliasHost]) {
    if (uniq.has(host)) continue
    uniq.add(host)
    out.push(host)
  }
  return out.join(", ")
}

function patchComposeOauthAliasesInCaddyLabels(opts: {
  readonly yamlText: string
  readonly tld: string
}): { readonly text: string; readonly changed: boolean } {
  const lines = opts.yamlText.split("\n")
  let inLabels = false
  let labelsIndent = 0
  let changed = false

  const tld = normalizeOauthTld(opts.tld)

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ""
    const trimmed = line.trim()

    // Don't let blank/comment lines end a block.
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue

    const labelsMatch = /^(\s*)labels:\s*$/.exec(line)
    if (labelsMatch) {
      inLabels = true
      labelsIndent = labelsMatch[1]?.length ?? 0
      continue
    }

    if (!inLabels) continue

    const indent = /^(\s*)/.exec(line)?.[1]?.length ?? 0
    if (indent <= labelsIndent) {
      inLabels = false
      continue
    }

    const caddyMatch = /^(\s*)caddy:\s*(.*)$/.exec(line)
    if (!caddyMatch) continue

    const indentStr = caddyMatch[1] ?? ""
    const rawAfter = caddyMatch[2] ?? ""

    const commentIdx = rawAfter.indexOf(" #")
    const valueRaw = (commentIdx >= 0 ? rawAfter.slice(0, commentIdx) : rawAfter).trimEnd()
    const commentSuffix = commentIdx >= 0 ? rawAfter.slice(commentIdx) : ""

    const valueTrimmed = valueRaw.trim()
    const quoted =
      valueTrimmed.startsWith('"') && valueTrimmed.endsWith('"') && valueTrimmed.length >= 2 ?
        { quote: '"', value: valueTrimmed.slice(1, -1) }
      : valueTrimmed.startsWith("'") && valueTrimmed.endsWith("'") && valueTrimmed.length >= 2 ?
        { quote: "'", value: valueTrimmed.slice(1, -1) }
      : { quote: null, value: valueTrimmed }

    const parts = quoted.value.split(",").map(h => h.trim()).filter(h => h.length > 0)
    if (parts.length === 0) continue

    const out: string[] = []
    const seen = new Set<string>()

    for (const host of parts) {
      if (seen.has(host)) continue
      seen.add(host)
      out.push(host)
    }

    for (const host of parts) {
      if (!host.endsWith(`.${DEFAULT_PROJECT_TLD}`)) continue
      const alias = `${host}.${tld}`
      if (seen.has(alias)) continue
      seen.add(alias)
      out.push(alias)
    }

    const nextValue = out.join(", ")
    if (nextValue === quoted.value) continue

    changed = true
    const formatted =
      quoted.quote ?
        `${quoted.quote}${nextValue}${quoted.quote}`
      : nextValue
    lines[i] = `${indentStr}caddy: ${formatted}${commentSuffix}`
  }

  return { text: lines.join("\n"), changed }
}

async function maybeSyncOauthAliasesInCompose(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>
}): Promise<void> {
  const cfg = await readProjectConfig(opts.project)
  if (cfg.parseError) return
  if (!cfg.oauth?.enabled) return

  const tld = normalizeOauthTld(cfg.oauth.tld ?? DEFAULT_OAUTH_ALIAS_TLD)

  const yamlText = await readTextFile(opts.project.composeFile)
  if (!yamlText) return

  const patched = patchComposeOauthAliasesInCaddyLabels({ yamlText, tld })
  if (!patched.changed) return

  await writeTextFileIfChanged(opts.project.composeFile, patched.text)
}

async function buildDiscoveredCompose(input: ComposeWizardInput): Promise<string> {
  const byId = new Map(input.candidates.map(c => [c.id, c] as const))

  const selectedIds = await autocompleteMultiselect<string>({
    message: "Select dev scripts to include as services:",
    required: true,
    options: input.candidates.map(c => ({
      value: c.id,
      label: formatCandidateLabel(c),
      hint: formatCandidateHint(c)
    }))
  })

  if (isCancel(selectedIds)) {
    throw new Error("Canceled")
  }

  const selectedCandidates: ServiceCandidate[] = []
  for (const id of selectedIds) {
    const c = byId.get(id)
    if (c) selectedCandidates.push(c)
  }

  if (selectedCandidates.length === 0) {
    throw new Error("No services selected")
  }

  const usedServiceNames = new Set<string>()
  const drafts: Array<{
    name: string
    role: "http" | "internal"
    port?: number
    subdomain?: string
    workingDir: string
    command: string
  }> = []

  for (const candidate of selectedCandidates) {
    note(candidate.scriptCommand, `${candidate.packageRelativeDir} (${candidate.scriptName})`)

    const defaultName = uniqueName(guessServiceName(candidate), usedServiceNames)
    const defaultRole = guessRole(candidate)

    const role = await select<"http" | "internal">({
      message: `Service role for "${defaultName}":`,
      initialValue: defaultRole,
      options: [
        { value: "http", label: "HTTP (routed via Caddy)" },
        { value: "internal", label: "Internal (not routed via Caddy)" }
      ]
    })
    if (isCancel(role)) throw new Error("Canceled")

    const name = await text({
      message: "docker compose service name:",
      initialValue: defaultName,
      validate: value => {
        const v = value?.trim()
        if (!v) return "Required"
        if (!/^[a-z0-9][a-z0-9-]*$/.test(v)) {
          return "Use lowercase letters, numbers, and '-' only"
        }
        if (v === "db" || v === "redis") return "Reserved name"
        if (usedServiceNames.has(v) && v !== defaultName) return "Duplicate"
        return undefined
      }
    })
    if (isCancel(name)) throw new Error("Canceled")

    usedServiceNames.add(name)

    const inferredPort = inferPortFromScript(candidate.scriptCommand)
    const defaultPort = inferredPort ?? guessDefaultPort(name)

    const port =
      role === "http" ?
        await text({
          message: "Internal HTTP port:",
          initialValue: String(defaultPort),
          validate: value => {
            const v = value?.trim()
            if (!v) return "Required"
            const n = Number.parseInt(v, 10)
            if (!Number.isFinite(n) || n <= 0 || n >= 65536) return "Invalid port"
            return undefined
          }
        })
      : "0"
    if (isCancel(port)) throw new Error("Canceled")

    const portNum = role === "http" ? Number.parseInt(port, 10) : undefined

    const workingDir =
      candidate.packageRelativeDir === "." ? "/app" : `/app/${candidate.packageRelativeDir}`

    const suggestedCommand = buildSuggestedCommand({
      candidate,
      role,
      port: portNum
    })

    const command = await text({
      message: "Container command:",
      initialValue: suggestedCommand,
      validate: value => {
        const v = value?.trim()
        if (!v) return "Required"
        return undefined
      }
    })
    if (isCancel(command)) throw new Error("Canceled")

    drafts.push({
      name,
      role,
      port: portNum,
      workingDir,
      command
    })
  }

  const httpDrafts = drafts.filter(d => d.role === "http")
  if (httpDrafts.length > 0) {
    const primaryDefault = httpDrafts.find(d => d.name === "www")?.name ?? httpDrafts[0]?.name

    const primary = await select<string>({
      message: `Which service should be routed at https://${input.devHost}?`,
      initialValue: primaryDefault,
      options: httpDrafts.map(d => ({
        value: d.name,
        label: d.name
      }))
    })
    if (isCancel(primary)) throw new Error("Canceled")

    for (const d of httpDrafts) {
      if (d.name === primary) continue

      const defaultSub = guessSubdomain(d.name)
      const sub = await text({
        message: `Subdomain for "${d.name}" (https://<sub>.${input.devHost}):`,
        initialValue: defaultSub,
        validate: value => {
          const v = value?.trim()
          if (!v) return "Required"
          if (v.includes(".")) return "Subdomain only (no dots)"
          if (!/^[a-z0-9][a-z0-9-]*$/.test(v)) return "Invalid subdomain"
          return undefined
        }
      })
      if (isCancel(sub)) throw new Error("Canceled")
      d.subdomain = sub
    }

    // Assign primary as root host
    const primaryDraft = httpDrafts.find(d => d.name === primary)
    if (primaryDraft) primaryDraft.subdomain = ""
  }

  const services = drafts.map(d => {
    const env = new Map<string, string>([
      ["CHOKIDAR_USEPOLLING", "true"],
      ["WATCHPACK_POLLING", "true"]
    ])

    const labels = new Map<string, string>()
    const networks = d.role === "http" ? ["hack-dev", "default"] : []

    if (d.role === "http") {
      const port = d.port ?? 3000
      const host =
        d.subdomain && d.subdomain.length > 0 ?
          `${d.subdomain}.${input.devHost}`
        : `${input.devHost}`
      labels.set("caddy", buildCaddyHostLabelValue({ primaryHost: host, oauth: input.oauth }))
      labels.set("caddy.reverse_proxy", `{{upstreams ${port}}}`)
      labels.set("caddy.tls", "internal")
    }

    return {
      name: d.name,
      role: d.role,
      image: "imbios/bun-node:latest",
      workingDir: d.workingDir,
      command: d.command,
      env,
      labels,
      networks
    }
  })

  return renderCompose({ name: input.projectSlug, services })
}

type AutoComposeDraft = {
  name: string
  role: "http" | "internal"
  port?: number
  subdomain?: string
  workingDir: string
  command: string
  image?: string
}

async function buildDiscoveredComposeAuto(input: ComposeWizardInput): Promise<string> {
  const selectedCandidates = selectAutoCandidates({ candidates: input.candidates })
  if (selectedCandidates.length === 0) {
    throw new Error("No dev scripts discovered for auto init.")
  }

  const usedServiceNames = new Set<string>()
  const drafts: AutoComposeDraft[] = []

  for (const candidate of selectedCandidates) {
    const name = resolveAutoServiceName({ candidate, usedServiceNames })
    usedServiceNames.add(name)

    const role = guessRole(candidate)
    const port =
      role === "http" ?
        inferPortFromScript(candidate.scriptCommand) ?? guessDefaultPort(name)
      : undefined
    const workingDir =
      candidate.packageRelativeDir === "." ? "/app" : `/app/${candidate.packageRelativeDir}`
    const command = buildSuggestedCommand({ candidate, role, port })

    drafts.push({
      name,
      role,
      port,
      workingDir,
      command
    })
  }

  assignAutoSubdomains({ drafts })

  const services = buildServicesFromDrafts({
    drafts,
    devHost: input.devHost,
    oauth: input.oauth
  })

  return renderCompose({ name: input.projectSlug, services })
}

interface ManualComposeWizardInput {
  readonly repoRoot: string
  readonly devHost: string
  readonly projectSlug: string
  readonly oauth: {
    readonly enabled: boolean
    readonly tld: string
  }
}

async function buildManualCompose(input: ManualComposeWizardInput): Promise<string> {
  note(
    [
      "No dev scripts were auto-discovered (or you opted out).",
      "Let’s define your services manually. You can always edit the generated compose after."
    ].join("\n"),
    "Manual services"
  )

  const usedServiceNames = new Set<string>()
  const drafts: Array<{
    name: string
    role: "http" | "internal"
    image: string
    port?: number
    subdomain?: string
    workingDir: string
    command: string
  }> = []

  while (true) {
    const defaultName = uniqueName("app", usedServiceNames)

    const role = await select<"http" | "internal">({
      message: `Service role for "${defaultName}":`,
      initialValue: "http",
      options: [
        { value: "http", label: "HTTP (routed via Caddy)" },
        { value: "internal", label: "Internal (not routed via Caddy)" }
      ]
    })
    if (isCancel(role)) throw new Error("Canceled")

    const name = await text({
      message: "docker compose service name:",
      initialValue: defaultName,
      validate: value => {
        const v = value?.trim()
        if (!v) return "Required"
        if (!/^[a-z0-9][a-z0-9-]*$/.test(v)) {
          return "Use lowercase letters, numbers, and '-' only"
        }
        if (usedServiceNames.has(v) && v !== defaultName) return "Duplicate"
        return undefined
      }
    })
    if (isCancel(name)) throw new Error("Canceled")
    usedServiceNames.add(name)

    const image = await text({
      message: `Image for "${name}":`,
      initialValue: "imbios/bun-node:latest",
      validate: value => {
        const v = value?.trim()
        if (!v) return "Required"
        return undefined
      }
    })
    if (isCancel(image)) throw new Error("Canceled")

    const workingDirRel = await text({
      message: `Working dir (relative to repo root) for "${name}":`,
      initialValue: ".",
      validate: value => {
        const v = value?.trim()
        if (!v) return "Required"
        if (v.startsWith("/")) return "Use a repo-relative path (e.g. ., apps/web)"
        return undefined
      }
    })
    if (isCancel(workingDirRel)) throw new Error("Canceled")

    const port =
      role === "http" ?
        await text({
          message: `Internal HTTP port for "${name}":`,
          initialValue: String(guessDefaultPort(name)),
          validate: value => {
            const v = value?.trim()
            if (!v) return "Required"
            const n = Number.parseInt(v, 10)
            if (!Number.isFinite(n) || n <= 0 || n >= 65536) return "Invalid port"
            return undefined
          }
        })
      : "0"
    if (isCancel(port)) throw new Error("Canceled")

    const portNum = role === "http" ? Number.parseInt(port, 10) : undefined

    const command = await text({
      message: `Container command for "${name}":`,
      initialValue:
        role === "http" ? `bun run dev -- --port ${portNum ?? 3000} --host 0.0.0.0` : "bun run dev",
      validate: value => {
        const v = value?.trim()
        if (!v) return "Required"
        return undefined
      }
    })
    if (isCancel(command)) throw new Error("Canceled")

    const relRaw = workingDirRel.trim()
    const rel =
      relRaw === "." ? "."
      : relRaw.startsWith("./") ? relRaw.slice(2)
      : relRaw
    const workingDir = rel === "." ? "/app" : `/app/${rel}`

    drafts.push({
      name,
      role,
      image: image.trim(),
      port: portNum,
      workingDir,
      command
    })

    const more = await confirm({
      message: "Add another service?",
      initialValue: false
    })
    if (isCancel(more)) throw new Error("Canceled")
    if (!more) break
  }

  const httpDrafts = drafts.filter(d => d.role === "http")
  if (httpDrafts.length > 0) {
    const primaryDefault = httpDrafts[0]?.name
    const primary = await select<string>({
      message: `Which service should be routed at https://${input.devHost}?`,
      initialValue: primaryDefault,
      options: httpDrafts.map(d => ({ value: d.name, label: d.name }))
    })
    if (isCancel(primary)) throw new Error("Canceled")

    for (const d of httpDrafts) {
      if (d.name === primary) continue
      const defaultSub = guessSubdomain(d.name)
      const sub = await text({
        message: `Subdomain for "${d.name}" (https://<sub>.${input.devHost}):`,
        initialValue: defaultSub,
        validate: value => {
          const v = value?.trim()
          if (!v) return "Required"
          if (v.includes(".")) return "Subdomain only (no dots)"
          if (!/^[a-z0-9][a-z0-9-]*$/.test(v)) return "Invalid subdomain"
          return undefined
        }
      })
      if (isCancel(sub)) throw new Error("Canceled")
      d.subdomain = sub
    }

    const primaryDraft = httpDrafts.find(d => d.name === primary)
    if (primaryDraft) primaryDraft.subdomain = ""
  }

  const services = drafts.map(d => {
    const env = new Map<string, string>([
      ["CHOKIDAR_USEPOLLING", "true"],
      ["WATCHPACK_POLLING", "true"]
    ])

    const labels = new Map<string, string>()
    const networks = d.role === "http" ? ["hack-dev", "default"] : []

    if (d.role === "http") {
      const port = d.port ?? 3000
      const host =
        d.subdomain && d.subdomain.length > 0 ?
          `${d.subdomain}.${input.devHost}`
        : `${input.devHost}`
      labels.set("caddy", buildCaddyHostLabelValue({ primaryHost: host, oauth: input.oauth }))
      labels.set("caddy.reverse_proxy", `{{upstreams ${port}}}`)
      labels.set("caddy.tls", "internal")
    }

    return {
      name: d.name,
      role: d.role,
      image: d.image,
      workingDir: d.workingDir,
      command: d.command,
      env,
      labels,
      networks
    }
  })

  return renderCompose({ name: input.projectSlug, services })
}

async function buildManualComposeAuto(input: ManualComposeWizardInput): Promise<string> {
  const port = guessDefaultPort("app")
  const drafts: AutoComposeDraft[] = [
    {
      name: "app",
      role: "http",
      port,
      subdomain: "",
      workingDir: "/app",
      command: `bun run dev -- --port ${port} --host 0.0.0.0`
    }
  ]

  const services = buildServicesFromDrafts({
    drafts,
    devHost: input.devHost,
    oauth: input.oauth
  })

  return renderCompose({ name: input.projectSlug, services })
}

function formatCandidateLabel(c: ServiceCandidate): string {
  const base = c.packageName ?? c.packageRelativeDir
  return `${base} → ${c.scriptName}`
}

function formatCandidateHint(c: ServiceCandidate): string {
  const dir = c.packageRelativeDir
  const cmd = c.scriptCommand.length > 60 ? `${c.scriptCommand.slice(0, 57)}…` : c.scriptCommand
  return `${dir} · ${cmd}`
}

function uniqueName(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base
  for (let i = 2; i < 1000; i += 1) {
    const next = `${base}-${i}`
    if (!used.has(next)) return next
  }
  return `${base}-${Date.now()}`
}

function guessSubdomain(serviceName: string): string {
  const n = serviceName.toLowerCase()
  if (n.includes("api")) return "api"
  if (n === "www" || n === "web") return "www"
  return serviceName
}

function selectAutoCandidates(opts: {
  readonly candidates: readonly ServiceCandidate[]
}): readonly ServiceCandidate[] {
  const devCandidates = opts.candidates.filter(
    c => c.scriptName === "dev" || c.scriptName.startsWith("dev:")
  )
  return devCandidates.length > 0 ? devCandidates : opts.candidates
}

function resolveAutoServiceName(opts: {
  readonly candidate: ServiceCandidate
  readonly usedServiceNames: ReadonlySet<string>
}): string {
  const base = guessServiceName(opts.candidate)
  const normalized = base.length > 0 ? base : "app"
  const safe = normalized === "db" || normalized === "redis" ? "app" : normalized
  return uniqueName(safe, opts.usedServiceNames)
}

function assignAutoSubdomains(opts: { readonly drafts: AutoComposeDraft[] }): void {
  const httpDrafts = opts.drafts.filter(d => d.role === "http")
  if (httpDrafts.length === 0) return

  const primary = httpDrafts.find(d => d.name === "www") ?? httpDrafts[0]
  if (primary) primary.subdomain = ""

  const used = new Set<string>()
  for (const draft of httpDrafts) {
    if (draft === primary) continue
    const base = guessSubdomain(draft.name)
    const subdomain = uniqueSubdomain({ base, used })
    used.add(subdomain)
    draft.subdomain = subdomain
  }
}

function uniqueSubdomain(opts: { readonly base: string; readonly used: ReadonlySet<string> }): string {
  const seed = sanitizeProjectSlug(opts.base)
  const normalized = seed.length > 0 ? seed : "app"
  if (!opts.used.has(normalized)) return normalized
  for (let i = 2; i < 1000; i += 1) {
    const next = `${normalized}-${i}`
    if (!opts.used.has(next)) return next
  }
  return `${normalized}-${Date.now()}`
}

function buildServicesFromDrafts(opts: {
  readonly drafts: readonly AutoComposeDraft[]
  readonly devHost: string
  readonly oauth: { readonly enabled: boolean; readonly tld: string }
}) {
  return opts.drafts.map(d => {
    const env = new Map<string, string>([
      ["CHOKIDAR_USEPOLLING", "true"],
      ["WATCHPACK_POLLING", "true"]
    ])

    const labels = new Map<string, string>()
    const networks = d.role === "http" ? ["hack-dev", "default"] : []

    if (d.role === "http") {
      const port = d.port ?? 3000
      const host =
        d.subdomain && d.subdomain.length > 0 ?
          `${d.subdomain}.${opts.devHost}`
        : `${opts.devHost}`
      labels.set("caddy", buildCaddyHostLabelValue({ primaryHost: host, oauth: opts.oauth }))
      labels.set("caddy.reverse_proxy", `{{upstreams ${port}}}`)
      labels.set("caddy.tls", "internal")
    }

    return {
      name: d.name,
      role: d.role,
      image: d.image ?? "imbios/bun-node:latest",
      workingDir: d.workingDir,
      command: d.command,
      env,
      labels,
      networks
    }
  })
}

function renderHackFolderReadme(opts: {
  readonly devHost: string
  readonly oauth?: { readonly enabled: boolean; readonly tld: string }
}): string {
  const oauthEnabled = opts.oauth?.enabled === true
  const oauthTld = oauthEnabled ? normalizeOauthTld(opts.oauth?.tld ?? DEFAULT_OAUTH_ALIAS_TLD) : null
  const oauthHost = oauthEnabled && oauthTld ? `${opts.devHost}.${oauthTld}` : null

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
    "If you need to run tools from your host machine, prefer `docker compose exec` to avoid host port conflicts:",
    "",
    "```bash",
    "docker compose -f .hack/docker-compose.yml exec db psql -U postgres -d mydb",
    "docker compose -f .hack/docker-compose.yml exec redis redis-cli",
    "```",
    "",
    "## Hostnames",
    "",
    `- Primary app: https://${opts.devHost}`,
    `- Subdomains: https://<sub>.${opts.devHost} (e.g. api.${opts.devHost})`,
    ...(oauthHost ?
      [
        "",
        "OAuth note:",
        `- OAuth-safe alias (public suffix): https://${oauthHost}`,
        `- OAuth-safe subdomains: https://<sub>.${oauthHost} (e.g. api.${oauthHost})`
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
    "  profiles: [\"ops\"]",
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
    ""
  ].join("\n")
}

async function requireProjectContext(startDir: string) {
  const ctx = await findProjectContext(startDir)
  if (!ctx) {
    throw new Error(`No ${HACK_PROJECT_DIR_PRIMARY}/ (or legacy .dev/) found. Run: hack init`)
  }
  return ctx
}

async function handleUp({
  ctx,
  args
}: {
  readonly ctx: CliContext
  readonly args: UpArgs
}): Promise<number> {
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project
  })
  const detach = args.options.detach
  const branch = resolveBranchSlug(args.options.branch)
  const profiles = parseCsvList(args.options.profile)

  await touchBranchUsageIfNeeded({ project, branch })
  await maybeSyncOauthAliasesInCompose({ project })

  const cfg = await readProjectConfig(project)
  if (cfg.parseError) {
    const configPath = cfg.configPath ?? project.configFile
    logger.warn({
      message: `Failed to parse ${configPath}: ${cfg.parseError}`
    })
  }

  const baseProjectName = await resolveComposeProjectName({ project, cfg })
  const composeProjectName = branch ? `${baseProjectName}--${branch}` : null
  const devHost = branch ? await resolveBranchDevHost({ project }) : null
  const aliasHost =
    branch && devHost ? resolveBranchAliasHost({ devHost, cfg }) : null
  const internalSettings = resolveInternalSettings(cfg)
  await maybePromptToStartGlobal({ internal: internalSettings })
  const internalOverride = await resolveInternalComposeOverride({ project, cfg })
  const composeFiles =
    branch && devHost ?
      await resolveBranchComposeFiles({ project, branch, devHost, aliasHost })
    : [project.composeFile]
  const composeFilesWithInternal =
    internalOverride ? [...composeFiles, internalOverride] : composeFiles
  return await composeRuntimeBackend.up({
    composeFiles: composeFilesWithInternal,
    composeProject: composeProjectName,
    profiles,
    detach,
    cwd: dirname(project.composeFile)
  })
}

async function maybePromptToStartGlobal(opts: {
  readonly internal: { readonly dns: boolean; readonly tls: boolean }
}): Promise<void> {
  if (!opts.internal.dns) return
  if (!(process.stdin.isTTY && process.stdout.isTTY)) return

  const dnsServer = await resolveCoreDnsServer()
  if (dnsServer) return

  const ok = await confirm({
    message:
      "Global DNS/TLS is not running. Start it now? (runs `hack global up`, may prompt for sudo)",
    initialValue: true
  })
  if (isCancel(ok)) throw new Error("Canceled")
  if (!ok) return

  const exitCode = await globalUp()
  if (exitCode !== 0) {
    logger.warn({
      message: "Global infra failed to start; continuing without internal DNS/TLS."
    })
  }
}

async function handleDown({
  ctx,
  args
}: {
  readonly ctx: CliContext
  readonly args: DownArgs
}): Promise<number> {
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project
  })
  const branch = resolveBranchSlug(args.options.branch)
  const profiles = parseCsvList(args.options.profile)

  await touchBranchUsageIfNeeded({ project, branch })
  const cfg = await readProjectConfig(project)
  if (cfg.parseError) {
    const configPath = cfg.configPath ?? project.configFile
    logger.warn({
      message: `Failed to parse ${configPath}: ${cfg.parseError}`
    })
  }

  const baseProjectName = await resolveComposeProjectName({ project, cfg })
  const composeProjectName = branch ? `${baseProjectName}--${branch}` : null

  const code = await composeRuntimeBackend.down({
    composeFiles: [project.composeFile],
    composeProject: composeProjectName,
    profiles,
    cwd: dirname(project.composeFile)
  })
  if (code !== 0) return code
  await maybeManageProjectLogsAfterDown({ project, branch })
  return 0
}

async function handleRestart({
  ctx,
  args
}: {
  readonly ctx: CliContext
  readonly args: RestartArgs
}): Promise<number> {
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project
  })
  const branch = resolveBranchSlug(args.options.branch)
  const profiles = parseCsvList(args.options.profile)

  await touchBranchUsageIfNeeded({ project, branch })
  const cfg = await readProjectConfig(project)
  if (cfg.parseError) {
    const configPath = cfg.configPath ?? project.configFile
    logger.warn({
      message: `Failed to parse ${configPath}: ${cfg.parseError}`
    })
  }

  const baseProjectName = await resolveComposeProjectName({ project, cfg })
  const composeProjectName = branch ? `${baseProjectName}--${branch}` : null

  const downCode = await composeRuntimeBackend.down({
    composeFiles: [project.composeFile],
    composeProject: composeProjectName,
    profiles,
    cwd: dirname(project.composeFile)
  })
  if (downCode !== 0) return downCode

  await maybeManageProjectLogsAfterDown({ project, branch })

  await maybeSyncOauthAliasesInCompose({ project })

  const devHost = branch ? await resolveBranchDevHost({ project }) : null
  const aliasHost = branch && devHost ? resolveBranchAliasHost({ devHost, cfg }) : null
  const internalOverride = await resolveInternalComposeOverride({ project, cfg })
  const composeFiles =
    branch && devHost ?
      await resolveBranchComposeFiles({ project, branch, devHost, aliasHost })
    : [project.composeFile]
  const composeFilesWithInternal =
    internalOverride ? [...composeFiles, internalOverride] : composeFiles

  return await composeRuntimeBackend.up({
    composeFiles: composeFilesWithInternal,
    composeProject: composeProjectName,
    profiles,
    detach: false,
    cwd: dirname(project.composeFile)
  })
}

async function maybeManageProjectLogsAfterDown(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>
  readonly branch: string | null
}): Promise<void> {
  const cfg = await readProjectConfig(opts.project)
  if (cfg.parseError) {
    const configPath = cfg.configPath ?? opts.project.configFile
    logger.warn({
      message: `Failed to parse ${configPath}: ${cfg.parseError}`
    })
  }
  const baseName = await resolveComposeProjectName({ project: opts.project, cfg })
  const projectName = opts.branch ? `${baseName}--${opts.branch}` : baseName
  const logsCfg = cfg.logs

  if (!logsCfg) return

  const baseUrl = (process.env.HACK_LOKI_URL ?? "http://127.0.0.1:3100").trim()
  const lokiReachable = await canReachLoki({ baseUrl })
  if (!lokiReachable) return

  const selector = buildLogSelector({
    project: projectName.length > 0 ? projectName : null,
    services: []
  })
  const now = Date.now()

  const lookbackMs = 30 * 24 * 60 * 60 * 1000 // 30d (covers the default global retention)
  const lookbackStart = new Date(now - lookbackMs)

  if (logsCfg.clearOnDown) {
    logger.step({ message: "Clearing Loki logs for this project…" })
    const res = await requestLokiDelete({
      baseUrl,
      query: selector,
      start: lookbackStart
    })
    if (!res.ok) {
      logger.warn({ message: res.message })
      return
    }
    logger.success({
      message: "Requested Loki log deletion (may take time due to cancellation window)"
    })
    return
  }

  const retentionRaw = logsCfg.retentionPeriod
  if (!retentionRaw) return

  const retentionMs = parseDurationMs(retentionRaw)
  if (!retentionMs) {
    const configPath = cfg.configPath ?? opts.project.configFile
    logger.warn({
      message: `Invalid logs.retention_period in ${configPath}: "${retentionRaw}" (expected e.g. "24h", "7d")`
    })
    return
  }

  const pruneEndMs = now - retentionMs
  if (pruneEndMs <= lookbackStart.getTime()) return

  logger.step({
    message: `Pruning Loki logs older than ${retentionRaw} for this project…`
  })
  const res = await requestLokiDelete({
    baseUrl,
    query: selector,
    start: lookbackStart,
    end: new Date(pruneEndMs)
  })
  if (!res.ok) {
    logger.warn({ message: res.message })
    return
  }

  logger.success({
    message: "Requested Loki log prune (may take time due to cancellation window)"
  })
}

async function handlePs({
  ctx,
  args
}: {
  readonly ctx: CliContext
  readonly args: PsArgs
}): Promise<number> {
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project
  })
  const branch = resolveBranchSlug(args.options.branch)
  const profiles = parseCsvList(args.options.profile)
  const json = args.options.json === true

  await touchBranchUsageIfNeeded({ project, branch })
  const cfg = await readProjectConfig(project)
  if (cfg.parseError) {
    const configPath = cfg.configPath ?? project.configFile
    logger.warn({
      message: `Failed to parse ${configPath}: ${cfg.parseError}`
    })
  }

  const baseProjectName = await resolveComposeProjectName({ project, cfg })
  const composeProjectName = branch ? `${baseProjectName}--${branch}` : null

  const cwd = dirname(project.composeFile)
  const res = await composeRuntimeBackend.psJson({
    composeFiles: [project.composeFile],
    composeProject: composeProjectName,
    profiles,
    cwd
  })

  if (res.exitCode !== 0) {
    if (json) {
      process.stderr.write("Failed to read docker compose ps JSON output.\n")
      return res.exitCode
    }
    return await composeRuntimeBackend.ps({
      composeFiles: [project.composeFile],
      composeProject: composeProjectName,
      profiles,
      cwd
    })
  }

  const entries = parseJsonLines(res.stdout)
  if (json) {
    const payload = {
      project: baseProjectName,
      branch,
      composeProject: composeProjectName ?? baseProjectName,
      items: entries
    }
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return 0
  }
  const rows = entries.map(e => [
    getString(e, "Service") ?? "",
    getString(e, "Name") ?? "",
    getString(e, "Status") ?? "",
    getString(e, "Ports") ?? ""
  ])

  await display.table({
    columns: ["SERVICE", "NAME", "STATUS", "PORTS"],
    rows
  })

  return 0
}

async function handleRun({
  ctx,
  args
}: {
  readonly ctx: CliContext
  readonly args: RunArgs
}): Promise<number> {
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project
  })
  const branch = resolveBranchSlug(args.options.branch)

  await touchBranchUsageIfNeeded({ project, branch })
  const service = (args.positionals.service ?? "").trim()
  if (service.length === 0) throw new CliUsageError("Missing required argument: service")

  const workdir = (args.options.workdir ?? "").trim()
  const profiles = parseCsvList(args.options.profile)
  const cmdArgs = args.positionals.cmd

  const cfg = await readProjectConfig(project)
  if (cfg.parseError) {
    const configPath = cfg.configPath ?? project.configFile
    logger.warn({
      message: `Failed to parse ${configPath}: ${cfg.parseError}`
    })
  }

  const baseProjectName = branch ? await resolveComposeProjectName({ project, cfg }) : null
  const composeProjectName = branch && baseProjectName ? `${baseProjectName}--${branch}` : null
  const internalOverride = await resolveInternalComposeOverride({ project, cfg })
  const composeFiles = internalOverride ? [project.composeFile, internalOverride] : [project.composeFile]
  return await composeRuntimeBackend.run({
    composeFiles,
    composeProject: composeProjectName,
    profiles,
    service,
    workdir: workdir.length > 0 ? workdir : undefined,
    cmdArgs,
    cwd: dirname(project.composeFile)
  })
}

async function handleLogs({
  ctx,
  args
}: {
  readonly ctx: CliContext
  readonly args: LogsArgs
}): Promise<number> {
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project
  })
  const branch = resolveBranchSlug(args.options.branch)
  const follow = args.options.noFollow ? false : true
  const tail = args.options.tail ?? 200
  const service = args.positionals.service
  const profiles = parseCsvList(args.options.profile)
  const json = args.options.json === true
  const format = json ? "json" : args.options.pretty ? "pretty" : "plain"
  const timeRange = parseLogTimeRange({
    since: args.options.since,
    until: args.options.until
  })

  await touchBranchUsageIfNeeded({ project, branch })
  const wantsLokiExplicit =
    args.options.loki ||
    args.options.services !== undefined ||
    args.options.query !== undefined ||
    args.options.since !== undefined ||
    args.options.until !== undefined

  if (args.options.compose && wantsLokiExplicit) {
    process.stderr.write("Cannot combine --compose with --loki/--services/--query/--since/--until.\n")
    return 1
  }
  if (json && args.options.pretty) {
    process.stderr.write("Cannot combine --json with --pretty.\n")
    return 1
  }
  if (timeRange.error) {
    process.stderr.write(`${timeRange.error}\n`)
    return 1
  }
  if (follow && timeRange.end) {
    process.stderr.write("Cannot combine --until with --follow.\n")
    return 1
  }
  const baseUrl = (process.env.HACK_LOKI_URL ?? "http://127.0.0.1:3100").trim()
  const cfg = await readProjectConfig(project)
  if (cfg.parseError) {
    const configPath = cfg.configPath ?? project.configFile
    logger.warn({
      message: `Failed to parse ${configPath}: ${cfg.parseError}`
    })
  }
  const baseProjectName = await resolveComposeProjectName({ project, cfg })
  const projectNameForPrefix = branch ? `${baseProjectName}--${branch}` : baseProjectName
  const followBackend = cfg.logs?.followBackend ?? "compose"
  const snapshotBackend = cfg.logs?.snapshotBackend ?? "loki"

  const shouldTryLoki = resolveShouldTryLoki({
    forceCompose: args.options.compose === true,
    wantsLokiExplicit,
    follow,
    followBackend,
    snapshotBackend
  })

  const lokiReachable = shouldTryLoki ? await lokiLogBackend.isAvailable({ baseUrl }) : false

  const useLoki = resolveUseLoki({
    forceCompose: args.options.compose === true,
    wantsLokiExplicit,
    shouldTryLoki,
    lokiReachable
  })

  if (useLoki) {
    if (!lokiReachable) {
      process.stderr.write(`Loki is not reachable at ${baseUrl}.\n`)
      process.stderr.write(
        "Tip: run `hack global install` (or `hack global up`) and ensure Loki is reachable.\n"
      )
      return 1
    }

    const projectName = projectNameForPrefix

    const services = parseCsvList(args.options.services)
    const serviceFromPositional = typeof service === "string" ? service.trim() : ""
    const allServices =
      serviceFromPositional.length > 0 && !services.includes(serviceFromPositional) ?
        [...services, serviceFromPositional]
      : services
    const streamContext: LogStreamContext | undefined =
      json ?
        {
          backend: "loki",
          project: projectNameForPrefix.length > 0 ? projectNameForPrefix : undefined,
          branch: branch ?? undefined,
          services: allServices.length > 0 ? allServices : undefined,
          follow,
          since: args.options.since,
          until: args.options.until
        }
      : undefined

    const query =
      typeof args.options.query === "string" && args.options.query.trim().length > 0 ?
        args.options.query.trim()
      : buildLogSelector({
          project: projectName.length > 0 ? projectName : null,
          services: allServices
        })

    const showProjectPrefix = true

    return await lokiLogBackend.run({
      baseUrl,
      query,
      follow,
      tail,
      format,
      showProjectPrefix,
      streamContext,
      start: timeRange.start ?? undefined,
      end: timeRange.end ?? undefined
    })
  }

  // Fallback to docker compose logs when Loki isn't available.
  const streamContext: LogStreamContext | undefined =
    json ?
      {
        backend: "compose",
        project: projectNameForPrefix.length > 0 ? projectNameForPrefix : undefined,
        branch: branch ?? undefined,
        services:
          typeof service === "string" && service.trim().length > 0 ?
            [service.trim()]
          : undefined,
        follow,
        since: args.options.since,
        until: args.options.until
      }
    : undefined

  return await composeLogBackend.run({
    composeFile: project.composeFile,
    cwd: dirname(project.composeFile),
    follow,
    tail,
    service,
    projectName: projectNameForPrefix.length > 0 ? projectNameForPrefix : undefined,
    composeProject: branch ? projectNameForPrefix : undefined,
    profiles,
    format,
    streamContext
  })
}

function parseCsvList(value: string | undefined): string[] {
  const raw = (value ?? "").trim()
  if (raw.length === 0) return []
  const parts = raw
    .split(",")
    .map(p => p.trim())
    .filter(p => p.length > 0)
  const uniq = new Set<string>()
  const out: string[] = []
  for (const p of parts) {
    if (uniq.has(p)) continue
    uniq.add(p)
    out.push(p)
  }
  return out
}

function parseLogTimeRange(opts: {
  readonly since: string | undefined
  readonly until: string | undefined
}): { readonly start: Date | null; readonly end: Date | null; readonly error?: string } {
  const sinceRaw = (opts.since ?? "").trim()
  const untilRaw = (opts.until ?? "").trim()

  if (sinceRaw.length === 0 && untilRaw.length === 0) {
    return { start: null, end: null }
  }

  const now = new Date()
  const start = sinceRaw.length > 0 ? parseTimeInput(sinceRaw, now) : null
  if (sinceRaw.length > 0 && !start) {
    return {
      start: null,
      end: null,
      error: `Invalid --since: "${sinceRaw}" (expected RFC3339 or duration like 15m)`
    }
  }

  const end = untilRaw.length > 0 ? parseTimeInput(untilRaw, now) : null
  if (untilRaw.length > 0 && !end) {
    return {
      start: null,
      end: null,
      error: `Invalid --until: "${untilRaw}" (expected RFC3339 or duration like 15m)`
    }
  }

  if (start && end && start.getTime() > end.getTime()) {
    return {
      start,
      end,
      error: "--since must be before --until."
    }
  }

  return { start, end }
}

async function handleOpen({
  ctx,
  args
}: {
  readonly ctx: CliContext
  readonly args: OpenArgs
}): Promise<number> {
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project
  })
  const branch = resolveBranchSlug(args.options.branch)
  const json = args.options.json === true
  const derivedHost = `${defaultProjectSlugFromPath(project.projectRoot)}.${DEFAULT_PROJECT_TLD}`
  const devHost = (await readProjectDevHost(project)) ?? derivedHost
  await touchBranchUsageIfNeeded({ project, branch })
  const cfg = await readProjectConfig(project)
  if (cfg.parseError) {
    const configPath = cfg.configPath ?? project.configFile
    if (json) {
      process.stderr.write(`Failed to parse ${configPath}: ${cfg.parseError}\n`)
    } else {
      logger.warn({
        message: `Failed to parse ${configPath}: ${cfg.parseError}`
      })
    }
  }
  const aliasHost = resolveBranchAliasHost({ devHost, cfg })
  const baseHosts = [devHost, aliasHost].filter(
    (host): host is string => typeof host === "string" && host.length > 0
  )

  const targetRaw = (args.positionals.target ?? "").trim()
  const rawHost =
    targetRaw === "" || targetRaw === "www" ? devHost
    : targetRaw.includes(".") ? targetRaw
    : `${targetRaw}.${devHost}`
  const resolvedHost =
    branch ? applyBranchToHost({ host: rawHost, branch, baseHosts }) : rawHost
  const url =
    targetRaw === "logs" ? `https://${DEFAULT_GRAFANA_HOST}`
    : hasUrlScheme(targetRaw) ? targetRaw
    : `https://${resolvedHost}`

  if (json) {
    process.stdout.write(`${JSON.stringify({ url }, null, 2)}\n`)
    return 0
  }

  logger.step({ message: `Opening ${url}` })
  return await openUrl(url)
}

function hasUrlScheme(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)
}
