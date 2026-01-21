import { basename, dirname, resolve } from "node:path"

import { findUpFile } from "./path.ts"
import { getRecord, getString, isRecord } from "./guards.ts"
import { pathExists, readTextFile } from "./fs.ts"
import { parseDotEnv } from "./env.ts"
import {
  HACK_PROJECT_DIR_LEGACY,
  HACK_PROJECT_DIR_PRIMARY,
  DEFAULT_OAUTH_ALIAS_TLD,
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_CONFIG_LEGACY_FILENAME,
  PROJECT_ENV_FILENAME
} from "../constants.ts"

export type ProjectDirName = typeof HACK_PROJECT_DIR_PRIMARY | typeof HACK_PROJECT_DIR_LEGACY

export interface ProjectContext {
  readonly projectRoot: string
  readonly projectDirName: ProjectDirName
  readonly projectDir: string
  readonly composeFile: string
  readonly envFile: string
  readonly configFile: string
}

export async function findProjectContext(startDir: string): Promise<ProjectContext | null> {
  const primaryRoot = await findUpFile(
    startDir,
    `${HACK_PROJECT_DIR_PRIMARY}/${PROJECT_COMPOSE_FILENAME}`
  )
  if (primaryRoot) {
    return buildProjectContext(primaryRoot, HACK_PROJECT_DIR_PRIMARY)
  }

  const legacyRoot = await findUpFile(
    startDir,
    `${HACK_PROJECT_DIR_LEGACY}/${PROJECT_COMPOSE_FILENAME}`
  )
  if (legacyRoot) {
    return buildProjectContext(legacyRoot, HACK_PROJECT_DIR_LEGACY)
  }

  return null
}

function buildProjectContext(projectRoot: string, dirName: ProjectDirName): ProjectContext {
  const projectDir = resolve(projectRoot, dirName)
  return {
    projectRoot,
    projectDirName: dirName,
    projectDir,
    composeFile: resolve(projectDir, PROJECT_COMPOSE_FILENAME),
    envFile: resolve(projectDir, PROJECT_ENV_FILENAME),
    configFile: resolve(projectDir, PROJECT_CONFIG_FILENAME)
  }
}

export async function findRepoRootForInit(startDir: string): Promise<string> {
  const byPackageJson = await findUpFile(startDir, "package.json")
  if (byPackageJson) return byPackageJson

  const byGit = await findUpFile(startDir, ".git")
  if (byGit) return byGit

  return resolve(startDir)
}

export function sanitizeProjectSlug(input: string): string {
  const trimmed = input.trim().toLowerCase()
  const replaced = trimmed.replaceAll("_", "-").replaceAll(" ", "-").replaceAll("/", "-")
  const cleaned = replaced.replaceAll(/[^a-z0-9-]/g, "")
  const collapsed = cleaned.replaceAll(/-+/g, "-").replaceAll(/^-|-$/g, "")
  return collapsed.length > 0 ? collapsed : "project"
}

export function sanitizeBranchSlug(input: string): string {
  const trimmed = input.trim().toLowerCase()
  const replaced = trimmed.replaceAll("_", "-").replaceAll(" ", "-").replaceAll("/", "-")
  const cleaned = replaced.replaceAll(/[^a-z0-9-]/g, "")
  return cleaned.replaceAll(/-+/g, "-").replaceAll(/^-|-$/g, "")
}

export function defaultProjectSlugFromPath(repoRoot: string): string {
  return sanitizeProjectSlug(basename(repoRoot))
}

export async function readProjectDevHost(ctx: ProjectContext): Promise<string | null> {
  const cfg = await readProjectConfig(ctx)
  if (cfg.devHost) return cfg.devHost

  // Legacy fallback: older scaffolds wrote DEV_HOST into `.hack/.env`.
  const envText = await readTextFile(ctx.envFile)
  if (!envText) return null

  const env = parseDotEnv(envText)
  const host = env["DEV_HOST"]
  return typeof host === "string" && host.length > 0 ? host : null
}

export interface ProjectConfig {
  readonly name?: string
  readonly devHost?: string
  readonly logs?: ProjectLogsConfig
  readonly oauth?: ProjectOauthConfig
  readonly internal?: ProjectInternalConfig
  readonly configPath?: string
  readonly parseError?: string
}

export type LogsBackend = "compose" | "loki"

export interface ProjectLogsConfig {
  /**
   * Backend preference when following logs (lowest latency is `compose`).
   * If Loki is unreachable, the CLI may still fall back to docker compose logs unless explicitly forced.
   */
  readonly followBackend?: LogsBackend

  /**
   * Backend preference when printing logs and exiting (queryable history).
   * If Loki is unreachable, the CLI may fall back to docker compose logs unless explicitly forced.
   */
  readonly snapshotBackend?: LogsBackend

  /**
   * If true, `hack down` will request deletion of all Loki logs for this project.
   */
  readonly clearOnDown?: boolean

  /**
   * Optional: keep only the most recent logs when `hack down` runs by pruning Loki logs older than this period.
   * Example: "24h", "168h", "7d"
   */
  readonly retentionPeriod?: string
}

export interface ProjectOauthConfig {
  /**
   * When enabled, the CLI scaffolder will additionally expose each routed service on a public-suffix alias
   * (e.g. `*.hack.gy`) so OAuth providers like Google accept the redirect origin/URI.
   */
  readonly enabled?: boolean

  /**
   * Optional override for the alias TLD.
   * Example: `gy` → `sickemail.hack.gy`
   */
  readonly tld?: string
}

export interface ProjectInternalConfig {
  /**
   * When enabled, containers use CoreDNS to resolve *.hack to the Caddy proxy.
   */
  readonly dns?: boolean

  /**
   * When enabled, mount the Caddy Local CA into containers and set common SSL env vars.
   */
  readonly tls?: boolean

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
  readonly extraHosts?: Record<string, string>
}

export function resolveProjectOauthTld(cfg: ProjectOauthConfig | undefined): string | null {
  if (!cfg?.enabled) return null
  const tld = cfg.tld?.trim().toLowerCase()
  return tld && tld.length > 0 ? tld : DEFAULT_OAUTH_ALIAS_TLD
}

export async function readProjectConfig(ctx: ProjectContext): Promise<ProjectConfig> {
  const jsonPath = resolve(ctx.projectDir, PROJECT_CONFIG_FILENAME)
  const jsonText = await readTextFile(jsonPath)
  if (jsonText !== null) {
    return parseProjectConfigJson({ text: jsonText, path: jsonPath })
  }

  const tomlPath = resolve(ctx.projectDir, PROJECT_CONFIG_LEGACY_FILENAME)
  const tomlText = await readTextFile(tomlPath)
  if (tomlText !== null) {
    return parseProjectConfigToml({ text: tomlText, path: tomlPath })
  }

  return {}
}

function parseProjectConfigJson(opts: { readonly text: string; readonly path: string }): ProjectConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(opts.text)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid JSON"
    return { parseError: message, configPath: opts.path }
  }
  return parseProjectConfigRecord(parsed, opts.path)
}

function parseProjectConfigToml(opts: { readonly text: string; readonly path: string }): ProjectConfig {
  let parsed: unknown
  try {
    parsed = Bun.TOML.parse(opts.text)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid TOML"
    return { parseError: message, configPath: opts.path }
  }
  return parseProjectConfigRecord(parsed, opts.path)
}

function parseProjectConfigRecord(value: unknown, path: string): ProjectConfig {
  if (!isRecord(value)) return { configPath: path }

  const name = getString(value, "name")
  const devHost = getString(value, "dev_host")
  const logs = parseLogsConfig(getRecord(value, "logs"))
  const oauth = parseOauthConfig(getRecord(value, "oauth"))
  const internal = parseInternalConfig(getRecord(value, "internal"))

  return {
    ...(name ? { name } : {}),
    ...(devHost ? { devHost } : {}),
    ...(logs ? { logs } : {}),
    ...(oauth ? { oauth } : {}),
    ...(internal ? { internal } : {}),
    configPath: path
  }
}

function parseLogsConfig(
  value: Record<string, unknown> | undefined
): ProjectLogsConfig | undefined {
  if (!value) return undefined

  const followBackend = parseLogsBackend(getString(value, "follow_backend"))
  const snapshotBackend = parseLogsBackend(getString(value, "snapshot_backend"))
  const clearOnDown = value["clear_on_down"] === true ? true : undefined
  const retentionPeriod = getString(value, "retention_period")

  const out: ProjectLogsConfig = {
    ...(followBackend ? { followBackend } : {}),
    ...(snapshotBackend ? { snapshotBackend } : {}),
    ...(clearOnDown ? { clearOnDown } : {}),
    ...(retentionPeriod ? { retentionPeriod } : {})
  }

  return Object.keys(out).length > 0 ? out : undefined
}

function parseLogsBackend(value: string | undefined): LogsBackend | undefined {
  if (value === "compose") return "compose"
  if (value === "loki") return "loki"
  return undefined
}

function parseOauthConfig(
  value: Record<string, unknown> | undefined
): ProjectOauthConfig | undefined {
  if (!value) return undefined

  const enabled = value["enabled"] === true ? true : undefined
  const tld = getString(value, "tld")?.trim()

  const out: ProjectOauthConfig = {
    ...(enabled ? { enabled } : {}),
    ...(tld && tld.length > 0 ? { tld } : {})
  }

  return Object.keys(out).length > 0 ? out : undefined
}

function parseInternalConfig(
  value: Record<string, unknown> | undefined
): ProjectInternalConfig | undefined {
  if (!value) return undefined

  const dns = parseOptionalBoolean(value["dns"])
  const tls = parseOptionalBoolean(value["tls"])
  const extraHosts = parseStringMap(getRecord(value, "extra_hosts"))

  const out: ProjectInternalConfig = {
    ...(dns !== undefined ? { dns } : {}),
    ...(tls !== undefined ? { tls } : {}),
    ...(extraHosts ? { extraHosts } : {})
  }

  return Object.keys(out).length > 0 ? out : undefined
}

function parseStringMap(value: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!value) return undefined

  const out: Record<string, string> = {}
  for (const [keyRaw, valueRaw] of Object.entries(value)) {
    const key = keyRaw.trim()
    if (key.length === 0) continue
    if (typeof valueRaw !== "string") continue
    const next = valueRaw.trim()
    if (next.length === 0) continue
    out[key] = next
  }

  return Object.keys(out).length > 0 ? out : undefined
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (value === true) return true
  if (value === false) return false
  return undefined
}

export async function hasHackProjectDir(
  repoRoot: string,
  dirName: ProjectDirName
): Promise<boolean> {
  return await pathExists(resolve(repoRoot, dirName))
}

export function projectDirDisplayName(ctx: ProjectContext): string {
  return basename(dirname(ctx.composeFile))
}
