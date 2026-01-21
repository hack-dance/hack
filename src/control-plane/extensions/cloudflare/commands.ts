import { homedir } from "node:os"
import { resolve } from "node:path"

import { isProcessRunning, removeFileIfExists, waitForProcessExit } from "../../../daemon/process.ts"
import { GLOBAL_CLOUDFLARE_DIR_NAME, GLOBAL_HACK_DIR_NAME } from "../../../constants.ts"
import { ensureDir, pathExists, readTextFile, writeTextFile, writeTextFileIfChanged } from "../../../lib/fs.ts"
import { getString, isRecord } from "../../../lib/guards.ts"
import { display } from "../../../ui/display.ts"
import { resolveGatewayConfig } from "../gateway/config.ts"
import { readControlPlaneConfig } from "../../sdk/config.ts"

import type { ExtensionCommand } from "../types.ts"
import type { ControlPlaneConfig } from "../../sdk/config.ts"

type CloudflareExtensionConfig = {
  readonly hostname?: string
  readonly tunnel?: string
  readonly origin?: string
  readonly sshHostname?: string
  readonly sshOrigin?: string
  readonly credentialsFile?: string
}

type TunnelPrintArgs = {
  hostname?: string
  tunnel?: string
  origin?: string
  sshHostname?: string
  sshOrigin?: string
  credentialsFile?: string
  out?: string
}

type TunnelSetupArgs = TunnelPrintArgs & {
  skipLogin: boolean
  skipCreate: boolean
  skipRoute: boolean
}

type TunnelStartArgs = {
  config?: string
  tunnel?: string
}

type ParseResult =
  | { readonly ok: true; readonly value: TunnelPrintArgs }
  | { readonly ok: false; readonly error: string }

type SetupParseResult =
  | { readonly ok: true; readonly value: TunnelSetupArgs }
  | { readonly ok: false; readonly error: string }

type StartParseResult =
  | { readonly ok: true; readonly value: TunnelStartArgs }
  | { readonly ok: false; readonly error: string }

type AccessSetupArgs = {
  sshHostname?: string
  user?: string
}

type AccessSetupParseResult =
  | { readonly ok: true; readonly value: AccessSetupArgs }
  | { readonly ok: false; readonly error: string }

const DEFAULT_ORIGIN = "http://127.0.0.1:7788"
const DEFAULT_SSH_ORIGIN = "ssh://127.0.0.1:22"
const DEFAULT_TUNNEL = "hack-gateway"
const DEFAULT_CONFIG_PATH = "~/.cloudflared/config.yml"
const CLOUDFLARED_PID_FILENAME = "cloudflared.pid"

export const CLOUDFLARE_COMMANDS: readonly ExtensionCommand[] = [
  {
    name: "tunnel-print",
    summary: "Print a cloudflared config for the gateway",
    scope: "global",
    handler: async ({ ctx, args }) => {
      const parsed = parseTunnelPrintArgs({ args })
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error })
        return 1
      }

      const defaultOrigin = await resolveDefaultOrigin()
      const globalConfig = (await readControlPlaneConfig({})).config
      const config = resolveTunnelConfig({
        controlPlaneConfig: globalConfig,
        overrides: parsed.value,
        defaultOrigin
      })
      if (!config.hostname) {
        ctx.logger.error({
          message:
            "Missing hostname. Use --hostname or set global config: hack config set --global 'controlPlane.extensions[\"dance.hack.cloudflare\"].config.hostname' <host>."
        })
        return 1
      }

      const yaml = renderCloudflaredConfig({
        tunnel: config.tunnel,
        hostname: config.hostname,
        origin: config.origin,
        ...(config.sshHostname ? { sshHostname: config.sshHostname } : {}),
        ...(config.sshOrigin ? { sshOrigin: config.sshOrigin } : {}),
        ...(config.credentialsFile ? { credentialsFile: config.credentialsFile } : {})
      })

      const outPath = config.out ? resolve(ctx.cwd, config.out) : null
      if (outPath) {
        const result = await writeTextFileIfChanged(outPath, `${yaml}\n`)
        ctx.logger.success({
          message: result.changed ? `Wrote ${outPath}` : `No changes needed: ${outPath}`
        })
      } else {
        process.stdout.write(`${yaml}\n`)
      }

      const nextSteps = buildNextSteps({
        hostname: config.hostname,
        tunnel: config.tunnel,
        outPath: outPath ?? "<path-to-config.yml>",
        credentialsFile: config.credentialsFile,
        ...(config.sshHostname ? { sshHostname: config.sshHostname } : {})
      })

      await display.panel({
        title: "Cloudflare tunnel setup",
        tone: "info",
        lines: nextSteps
      })
      return 0
    }
  },
  {
    name: "tunnel-setup",
    summary: "Create a Cloudflare tunnel and write config",
    scope: "global",
    handler: async ({ ctx, args }) => {
      const parsed = parseTunnelSetupArgs({ args })
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error })
        return 1
      }

      const defaultOrigin = await resolveDefaultOrigin()
      const globalConfig = (await readControlPlaneConfig({})).config
      const config = resolveTunnelConfig({
        controlPlaneConfig: globalConfig,
        overrides: parsed.value,
        defaultOrigin
      })
      if (!config.hostname) {
        ctx.logger.error({
          message:
            "Missing hostname. Use --hostname or set global config: hack config set --global 'controlPlane.extensions[\"dance.hack.cloudflare\"].config.hostname' <host>."
        })
        return 1
      }

      const outPath = resolveOutPath({ cwd: ctx.cwd, raw: config.out ?? DEFAULT_CONFIG_PATH })
      const check = await ensureCloudflared()
      if (!check.ok) {
        ctx.logger.error({ message: check.error })
        return 1
      }

      if (!parsed.value.skipLogin) {
        const login = await runCloudflared({ args: ["tunnel", "login"], inherit: true })
        if (!login.ok) {
          ctx.logger.error({ message: "cloudflared login failed." })
          return 1
        }
      }

      let tunnelId = await findTunnelId({ name: config.tunnel })
      if (!tunnelId && !parsed.value.skipCreate) {
        const created = await runCloudflared({
          args: ["tunnel", "create", config.tunnel],
          inherit: true
        })
        if (!created.ok) {
          ctx.logger.error({ message: "cloudflared tunnel create failed." })
          return 1
        }
        tunnelId = await findTunnelId({ name: config.tunnel })
      }

      if (!tunnelId) {
        ctx.logger.error({ message: `Tunnel "${config.tunnel}" not found.` })
        return 1
      }

      if (!parsed.value.skipRoute) {
        const routed = await runCloudflared({
          args: ["tunnel", "route", "dns", config.tunnel, config.hostname],
          inherit: true
        })
        if (!routed.ok) {
          ctx.logger.warn({ message: "cloudflared route dns failed (it may already exist)." })
        }
        if (config.sshHostname) {
          const routedSsh = await runCloudflared({
            args: ["tunnel", "route", "dns", config.tunnel, config.sshHostname],
            inherit: true
          })
          if (!routedSsh.ok) {
            ctx.logger.warn({
              message: "cloudflared route dns failed for SSH hostname (it may already exist)."
            })
          }
        }
      }

      const credentialsFile = config.credentialsFile ?? await resolveCredentialsFile({ tunnelId })
      const yaml = renderCloudflaredConfig({
        tunnel: tunnelId,
        hostname: config.hostname,
        origin: config.origin,
        ...(config.sshHostname ? { sshHostname: config.sshHostname } : {}),
        ...(config.sshOrigin ? { sshOrigin: config.sshOrigin } : {}),
        ...(credentialsFile ? { credentialsFile } : {})
      })

      const result = await writeTextFileIfChanged(outPath, `${yaml}\n`)
      ctx.logger.success({
        message: result.changed ? `Wrote ${outPath}` : `No changes needed: ${outPath}`
      })

      const nextSteps = [
        `Run tunnel: cloudflared tunnel --config ${outPath} run ${config.tunnel}`,
        "Optional: use Cloudflare Access policies to protect the hostname."
      ]
      await display.panel({ title: "Next steps", tone: "info", lines: nextSteps })
      return 0
    }
  },
  {
    name: "tunnel-start",
    summary: "Start a Cloudflare tunnel in the background",
    scope: "global",
    handler: async ({ ctx, args }) => {
      const parsed = parseTunnelStartArgs({ args })
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error })
        return 1
      }

      const defaultOrigin = await resolveDefaultOrigin()
      const globalConfig = (await readControlPlaneConfig({})).config
      const config = resolveTunnelConfig({
        controlPlaneConfig: globalConfig,
        overrides: { tunnel: parsed.value.tunnel },
        defaultOrigin
      })
      const configPath = resolveOutPath({
        cwd: ctx.cwd,
        raw: parsed.value.config ?? DEFAULT_CONFIG_PATH
      })

      if (!(await pathExists(configPath))) {
        ctx.logger.error({
          message: `Missing config: ${configPath}. Run tunnel-setup or tunnel-print first.`
        })
        return 1
      }

      const check = await ensureCloudflared()
      if (!check.ok) {
        ctx.logger.error({ message: check.error })
        return 1
      }

      const statePaths = resolveCloudflareStatePaths()
      await ensureDir(statePaths.root)

      const existingPid = await readPidFile({ path: statePaths.pidPath })
      if (existingPid && isProcessRunning({ pid: existingPid })) {
        ctx.logger.info({ message: `cloudflared already running (pid ${existingPid}).` })
        return 0
      }

      if (existingPid) {
        await removeFileIfExists({ path: statePaths.pidPath })
      }

      const proc = Bun.spawn(
        ["cloudflared", "tunnel", "--config", configPath, "run", config.tunnel],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          detached: true
        }
      )
      proc.unref()

      if (!Number.isFinite(proc.pid)) {
        ctx.logger.error({ message: "Failed to start cloudflared." })
        return 1
      }

      await writePidFile({ path: statePaths.pidPath, pid: proc.pid })
      ctx.logger.success({ message: `cloudflared started (pid ${proc.pid}).` })
      ctx.logger.info({ message: "Stop with: hack x cloudflare tunnel-stop" })
      return 0
    }
  },
  {
    name: "tunnel-stop",
    summary: "Stop the background Cloudflare tunnel",
    scope: "global",
    handler: async ({ ctx, args }) => {
      const parsed = parseTunnelStopArgs({ args })
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error })
        return 1
      }

      const statePaths = resolveCloudflareStatePaths()
      const pid = await readPidFile({ path: statePaths.pidPath })
      if (!pid) {
        ctx.logger.info({ message: "cloudflared is not running." })
        return 0
      }

      if (!isProcessRunning({ pid })) {
        await removeFileIfExists({ path: statePaths.pidPath })
        ctx.logger.info({ message: "Removed stale cloudflared pid file." })
        return 0
      }

      try {
        process.kill(pid, "SIGTERM")
      } catch {
        ctx.logger.error({ message: `Failed to stop cloudflared (pid ${pid}).` })
        return 1
      }

      const exited = await waitForProcessExit({ pid, timeoutMs: 2_000, pollMs: 200 })
      if (!exited) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          ctx.logger.error({ message: `Failed to force-stop cloudflared (pid ${pid}).` })
          return 1
        }
      }

      await removeFileIfExists({ path: statePaths.pidPath })
      ctx.logger.success({ message: `cloudflared stopped (pid ${pid}).` })
      return 0
    }
  },
  {
    name: "access-setup",
    summary: "Print Cloudflare Access SSH setup steps",
    scope: "global",
    handler: async ({ ctx, args }) => {
      const parsed = parseAccessSetupArgs({ args })
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error })
        return 1
      }

      const globalConfig = (await readControlPlaneConfig({})).config
      const extension = globalConfig.extensions["dance.hack.cloudflare"]
      const configured = extension?.config ?? {}
      const sshHostname = parsed.value.sshHostname ?? getString(configured, "sshHostname")
      if (!sshHostname) {
        ctx.logger.error({
          message:
            "Missing ssh hostname. Pass --ssh-hostname or set controlPlane.extensions[\"dance.hack.cloudflare\"].config.sshHostname in the global config."
        })
        return 1
      }

      const user = parsed.value.user ?? "<user>"
      const lines = [
        "1) Open Zero Trust: https://one.dash.cloudflare.com/",
        "2) Access → Applications → Add an application → Self-hosted",
        `3) Set hostname: ${sshHostname}`,
        "4) Add an Access policy that allows your identity/device",
        `5) Test (desktop): cloudflared access ssh --hostname ${sshHostname}`,
        "6) Optional SSH config:",
        `   Host ${sshHostname}`,
        `     User ${user}`,
        "     ProxyCommand /opt/homebrew/bin/cloudflared access ssh --hostname %h"
      ]

      await display.panel({
        title: "Cloudflare Access (SSH)",
        tone: "info",
        lines
      })
      return 0
    }
  }
]

export function parseTunnelPrintArgs(opts: { readonly args: readonly string[] }): ParseResult {
  const out: TunnelPrintArgs = {}

  const takeValue = (token: string, value: string | undefined): string | null => {
    if (!value || value.startsWith("-")) return null
    return value
  }

  for (let i = 0; i < opts.args.length; i += 1) {
    const token = opts.args[i] ?? ""
    if (token === "--") {
      return { ok: true, value: out }
    }

    if (token.startsWith("--hostname=")) {
      out.hostname = normalizeValue(token.slice("--hostname=".length))
      continue
    }

    if (token === "--hostname") {
      const value = takeValue(token, opts.args[i + 1])
      if (!value) return { ok: false, error: "--hostname requires a value." }
      out.hostname = normalizeValue(value)
      i += 1
      continue
    }

    if (token.startsWith("--tunnel=")) {
      out.tunnel = normalizeValue(token.slice("--tunnel=".length))
      continue
    }

    if (token === "--tunnel") {
      const value = takeValue(token, opts.args[i + 1])
      if (!value) return { ok: false, error: "--tunnel requires a value." }
      out.tunnel = normalizeValue(value)
      i += 1
      continue
    }

    if (token.startsWith("--origin=")) {
      out.origin = normalizeValue(token.slice("--origin=".length))
      continue
    }

    if (token === "--origin") {
      const value = takeValue(token, opts.args[i + 1])
      if (!value) return { ok: false, error: "--origin requires a value." }
      out.origin = normalizeValue(value)
      i += 1
      continue
    }

    if (token.startsWith("--ssh-hostname=")) {
      out.sshHostname = normalizeValue(token.slice("--ssh-hostname=".length))
      continue
    }

    if (token === "--ssh-hostname") {
      const value = takeValue(token, opts.args[i + 1])
      if (!value) return { ok: false, error: "--ssh-hostname requires a value." }
      out.sshHostname = normalizeValue(value)
      i += 1
      continue
    }

    if (token.startsWith("--ssh-origin=")) {
      out.sshOrigin = normalizeValue(token.slice("--ssh-origin=".length))
      continue
    }

    if (token === "--ssh-origin") {
      const value = takeValue(token, opts.args[i + 1])
      if (!value) return { ok: false, error: "--ssh-origin requires a value." }
      out.sshOrigin = normalizeValue(value)
      i += 1
      continue
    }

    if (token.startsWith("--credentials-file=")) {
      out.credentialsFile = normalizeValue(token.slice("--credentials-file=".length))
      continue
    }

    if (token === "--credentials-file") {
      const value = takeValue(token, opts.args[i + 1])
      if (!value) return { ok: false, error: "--credentials-file requires a value." }
      out.credentialsFile = normalizeValue(value)
      i += 1
      continue
    }

    if (token.startsWith("--out=")) {
      out.out = normalizeValue(token.slice("--out=".length))
      continue
    }

    if (token === "--out") {
      const value = takeValue(token, opts.args[i + 1])
      if (!value) return { ok: false, error: "--out requires a value." }
      out.out = normalizeValue(value)
      i += 1
      continue
    }

    if (token.startsWith("-")) {
      return { ok: false, error: `Unknown option: ${token}` }
    }

    return { ok: false, error: `Unexpected argument: ${token}` }
  }

  return { ok: true, value: out }
}

function parseTunnelSetupArgs(opts: { readonly args: readonly string[] }): SetupParseResult {
  let skipLogin = false
  let skipCreate = false
  let skipRoute = false
  const filtered: string[] = []

  for (const token of opts.args) {
    if (token === "--skip-login") {
      skipLogin = true
      continue
    }
    if (token === "--skip-create") {
      skipCreate = true
      continue
    }
    if (token === "--skip-route") {
      skipRoute = true
      continue
    }
    filtered.push(token)
  }

  const base = parseTunnelPrintArgs({ args: filtered })
  if (!base.ok) return base

  return {
    ok: true,
    value: {
      ...base.value,
      skipLogin,
      skipCreate,
      skipRoute
    }
  }
}

export function parseTunnelStartArgs(opts: { readonly args: readonly string[] }): StartParseResult {
  const out: TunnelStartArgs = {}

  const takeValue = (token: string, value: string | undefined): string | null => {
    if (!value || value.startsWith("-")) return null
    return value
  }

  for (let i = 0; i < opts.args.length; i += 1) {
    const token = opts.args[i] ?? ""
    if (token === "--") {
      return { ok: true, value: out }
    }

    if (token.startsWith("--config=")) {
      out.config = normalizeValue(token.slice("--config=".length))
      continue
    }

    if (token === "--config") {
      const value = takeValue(token, opts.args[i + 1])
      if (!value) return { ok: false, error: "--config requires a value." }
      out.config = normalizeValue(value)
      i += 1
      continue
    }

    if (token.startsWith("--out=")) {
      out.config = normalizeValue(token.slice("--out=".length))
      continue
    }

    if (token === "--out") {
      const value = takeValue(token, opts.args[i + 1])
      if (!value) return { ok: false, error: "--out requires a value." }
      out.config = normalizeValue(value)
      i += 1
      continue
    }

    if (token.startsWith("--tunnel=")) {
      out.tunnel = normalizeValue(token.slice("--tunnel=".length))
      continue
    }

    if (token === "--tunnel") {
      const value = takeValue(token, opts.args[i + 1])
      if (!value) return { ok: false, error: "--tunnel requires a value." }
      out.tunnel = normalizeValue(value)
      i += 1
      continue
    }

    if (token.startsWith("-")) {
      return { ok: false, error: `Unknown option: ${token}` }
    }

    return { ok: false, error: `Unexpected argument: ${token}` }
  }

  return { ok: true, value: out }
}

export function parseAccessSetupArgs(opts: {
  readonly args: readonly string[]
}): AccessSetupParseResult {
  const out: AccessSetupArgs = {}

  const takeValue = (token: string, value: string | undefined): string | null => {
    if (!value || value.startsWith("-")) return null
    return value
  }

  for (let i = 0; i < opts.args.length; i += 1) {
    const token = opts.args[i] ?? ""
    if (token === "--") {
      return { ok: true, value: out }
    }

    if (token.startsWith("--ssh-hostname=")) {
      out.sshHostname = normalizeValue(token.slice("--ssh-hostname=".length))
      continue
    }

    if (token === "--ssh-hostname") {
      const value = takeValue(token, opts.args[i + 1])
      if (!value) return { ok: false, error: "--ssh-hostname requires a value." }
      out.sshHostname = normalizeValue(value)
      i += 1
      continue
    }

    if (token.startsWith("--user=")) {
      out.user = normalizeValue(token.slice("--user=".length))
      continue
    }

    if (token === "--user") {
      const value = takeValue(token, opts.args[i + 1])
      if (!value) return { ok: false, error: "--user requires a value." }
      out.user = normalizeValue(value)
      i += 1
      continue
    }

    if (token.startsWith("-")) {
      return { ok: false, error: `Unknown option: ${token}` }
    }

    return { ok: false, error: `Unexpected argument: ${token}` }
  }

  return { ok: true, value: out }
}

function parseTunnelStopArgs(opts: {
  readonly args: readonly string[]
}): { readonly ok: true } | { readonly ok: false; readonly error: string } {
  if (opts.args.length === 0) return { ok: true }
  const token = opts.args[0] ?? ""
  if (token.startsWith("-")) {
    return { ok: false, error: `Unknown option: ${token}` }
  }
  return { ok: false, error: `Unexpected argument: ${token}` }
}

function resolveTunnelConfig(opts: {
  readonly controlPlaneConfig: ControlPlaneConfig
  readonly overrides: TunnelPrintArgs
  readonly defaultOrigin?: string
}): Required<Pick<CloudflareExtensionConfig, "tunnel" | "origin">> &
  CloudflareExtensionConfig & { readonly out?: string } {
  const configured = readExtensionConfig({ controlPlaneConfig: opts.controlPlaneConfig })
  const hostname = opts.overrides.hostname ?? configured.hostname
  const tunnel = opts.overrides.tunnel ?? configured.tunnel ?? DEFAULT_TUNNEL
  const origin = opts.overrides.origin ?? configured.origin ?? opts.defaultOrigin ?? DEFAULT_ORIGIN
  const sshHostname = opts.overrides.sshHostname ?? configured.sshHostname
  const sshOrigin =
    opts.overrides.sshOrigin ??
    configured.sshOrigin ??
    (sshHostname ? DEFAULT_SSH_ORIGIN : undefined)
  const credentialsFile = opts.overrides.credentialsFile ?? configured.credentialsFile
  const out = opts.overrides.out

  return {
    ...(hostname ? { hostname } : {}),
    tunnel,
    origin,
    ...(sshHostname ? { sshHostname } : {}),
    ...(sshOrigin ? { sshOrigin } : {}),
    ...(credentialsFile ? { credentialsFile } : {}),
    ...(out ? { out } : {})
  }
}

function readExtensionConfig(opts: {
  readonly controlPlaneConfig: ControlPlaneConfig
}): CloudflareExtensionConfig {
  const raw = opts.controlPlaneConfig.extensions?.["dance.hack.cloudflare"]
  if (!raw || !isRecord(raw)) return {}
  const config = raw["config"]
  if (!config || !isRecord(config)) return {}
  return {
    hostname: getString(config, "hostname") ?? undefined,
    tunnel: getString(config, "tunnel") ?? undefined,
    origin: getString(config, "origin") ?? undefined,
    sshHostname: getString(config, "sshHostname") ?? undefined,
    sshOrigin: getString(config, "sshOrigin") ?? undefined,
    credentialsFile: getString(config, "credentialsFile") ?? undefined
  }
}

function renderCloudflaredConfig(opts: {
  readonly tunnel: string
  readonly hostname: string
  readonly origin: string
  readonly sshHostname?: string
  readonly sshOrigin?: string
  readonly credentialsFile?: string
}): string {
  const ingress: string[] = [
    `  - hostname: ${opts.hostname}`,
    `    service: ${opts.origin}`
  ]
  if (opts.sshHostname) {
    const sshOrigin = opts.sshOrigin ?? DEFAULT_SSH_ORIGIN
    ingress.push(`  - hostname: ${opts.sshHostname}`)
    ingress.push(`    service: ${sshOrigin}`)
  }

  const lines = [
    `tunnel: ${opts.tunnel}`,
    ...(opts.credentialsFile ? [`credentials-file: ${opts.credentialsFile}`] : []),
    "ingress:",
    ...ingress,
    "  - service: http_status:404"
  ]
  return lines.join("\n")
}

function buildNextSteps(opts: {
  readonly hostname: string
  readonly tunnel: string
  readonly outPath: string
  readonly credentialsFile?: string
  readonly sshHostname?: string
}): readonly string[] {
  const lines: string[] = [
    "1) Authenticate: cloudflared tunnel login",
    `2) Create tunnel: cloudflared tunnel create ${opts.tunnel}`,
    `3) Route DNS: cloudflared tunnel route dns ${opts.tunnel} ${opts.hostname}`
  ]

  if (opts.sshHostname) {
    lines.push(`4) Route SSH DNS: cloudflared tunnel route dns ${opts.tunnel} ${opts.sshHostname}`)
    lines.push("5) SSH connect (desktop): cloudflared access ssh --hostname <ssh-hostname>")
    lines.push(
      "   Or add to ~/.ssh/config: ProxyCommand cloudflared access ssh --hostname %h"
    )
    lines.push(`6) Run tunnel: cloudflared tunnel --config ${opts.outPath} run ${opts.tunnel}`)
  } else {
    lines.push(`4) Run tunnel: cloudflared tunnel --config ${opts.outPath} run ${opts.tunnel}`)
  }

  if (!opts.credentialsFile) {
    lines.push("Note: credentials-file is optional if ~/.cloudflared/<tunnel-id>.json exists.")
  }

  return lines
}

function normalizeValue(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function resolveOutPath(opts: { readonly cwd: string; readonly raw: string }): string {
  const raw = opts.raw.trim()
  if (raw.startsWith("~/")) {
    return resolve(homedir(), raw.slice(2))
  }
  return resolve(opts.cwd, raw)
}

async function resolveDefaultOrigin(): Promise<string> {
  const resolved = await resolveGatewayConfig()
  const bind = resolved.config.bind === "0.0.0.0" ? "127.0.0.1" : resolved.config.bind
  const host = bind.includes(":") ? `[${bind}]` : bind
  return `http://${host}:${resolved.config.port}`
}

type CloudflareStatePaths = {
  readonly root: string
  readonly pidPath: string
}

function resolveCloudflareStatePaths(): CloudflareStatePaths {
  const baseHome = (process.env.HOME ?? homedir()).trim()
  const root = resolve(baseHome, GLOBAL_HACK_DIR_NAME, GLOBAL_CLOUDFLARE_DIR_NAME)
  return {
    root,
    pidPath: resolve(root, CLOUDFLARED_PID_FILENAME)
  }
}

async function readPidFile(opts: { readonly path: string }): Promise<number | null> {
  const text = await readTextFile(opts.path)
  if (!text) return null
  const value = Number.parseInt(text.trim(), 10)
  return Number.isFinite(value) ? value : null
}

async function writePidFile(opts: { readonly path: string; readonly pid: number }): Promise<void> {
  await writeTextFile(opts.path, `${opts.pid}\n`)
}

async function ensureCloudflared(): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  const result = await runCloudflared({ args: ["--version"], inherit: false })
  if (!result.ok) {
    return { ok: false, error: "cloudflared not found. Install with: brew install cloudflare/cloudflare/cloudflared" }
  }
  return { ok: true }
}

async function runCloudflared(opts: {
  readonly args: readonly string[]
  readonly inherit: boolean
}): Promise<{ readonly ok: boolean; readonly stdout?: string }> {
  const proc = Bun.spawn(["cloudflared", ...opts.args], {
    stdin: opts.inherit ? "inherit" : "ignore",
    stdout: opts.inherit ? "inherit" : "pipe",
    stderr: "inherit"
  })

  const stdout = opts.inherit ? undefined : await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  return { ok: exitCode === 0, ...(stdout ? { stdout } : {}) }
}

async function findTunnelId(opts: { readonly name: string }): Promise<string | null> {
  const result = await runCloudflared({ args: ["tunnel", "list", "--output", "json"], inherit: false })
  if (!result.ok || !result.stdout) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  for (const item of parsed) {
    if (!isRecord(item)) continue
    const name = getString(item, "name")
    if (name !== opts.name) continue
    const id = getString(item, "id")
    if (id) return id
  }
  return null
}

async function resolveCredentialsFile(opts: { readonly tunnelId: string }): Promise<string | undefined> {
  const candidate = resolve(homedir(), ".cloudflared", `${opts.tunnelId}.json`)
  return (await pathExists(candidate)) ? candidate : undefined
}
