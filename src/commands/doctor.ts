import { confirm, isCancel, note, spinner } from "@clack/prompts"
import { dirname, resolve } from "node:path"
import { lookup } from "node:dns/promises"

import { isColorEnabled } from "../ui/terminal.ts"
import { getGumPath } from "../ui/gum.ts"
import { exec, findExecutableInPath, run } from "../lib/shell.ts"
import { findProjectContext, readProjectConfig, readProjectDevHost } from "../lib/project.ts"
import { isMac } from "../lib/os.ts"
import { ensureDir, pathExists, readTextFile, writeTextFileIfChanged } from "../lib/fs.ts"
import { parseDotEnv } from "../lib/env.ts"
import { resolveHackInvocation } from "../lib/hack-cli.ts"
import { removeFileIfExists } from "../daemon/process.ts"
import { resolveDaemonPaths } from "../daemon/paths.ts"
import { readDaemonStatus } from "../daemon/status.ts"
import {
  analyzeComposeNetworkHygiene,
  dnsmasqConfigHasDomain,
  resolverHasNameserver
} from "./doctor-utils.ts"
import {
  DEFAULT_GRAFANA_HOST,
  DEFAULT_INGRESS_NETWORK,
  DEFAULT_INGRESS_GATEWAY,
  DEFAULT_INGRESS_SUBNET,
  DEFAULT_LOGGING_NETWORK,
  DEFAULT_OAUTH_ALIAS_ROOT,
  DEFAULT_PROJECT_TLD,
  GLOBAL_CADDY_COMPOSE_FILENAME,
  GLOBAL_CADDY_DIR_NAME,
  GLOBAL_COREDNS_FILENAME,
  GLOBAL_HACK_DIR_NAME,
  GLOBAL_LOGGING_COMPOSE_FILENAME,
  GLOBAL_LOGGING_DIR_NAME,
  HACK_PROJECT_DIR_PRIMARY
} from "../constants.ts"
import { renderGlobalCaddyCompose, renderGlobalCoreDnsConfig } from "../templates.ts"
import { optPath } from "../cli/options.ts"
import { defineCommand, defineOption, withHandler } from "../cli/command.ts"

import type { CliContext, CommandArgs, CommandHandlerFor } from "../cli/command.ts"

type CheckStatus = "ok" | "warn" | "error"

interface CheckResult {
  readonly name: string
  readonly status: CheckStatus
  readonly message: string
}

interface TimedCheckResult extends CheckResult {
  readonly durationMs: number
}

const optFix = defineOption({
  name: "fix",
  type: "boolean",
  long: "--fix",
  description: "Attempt safe auto-remediations (network + CoreDNS + CA)"
} as const)

const doctorOptions = [optPath, optFix] as const
const doctorPositionals = [] as const

const doctorSpec = defineCommand({
  name: "doctor",
  summary: "Validate local setup (docker, networks, DNS, global infra, project config)",
  group: "Diagnostics",
  options: doctorOptions,
  positionals: doctorPositionals,
  subcommands: []
} as const)

type DoctorArgs = CommandArgs<typeof doctorOptions, typeof doctorPositionals>

const handleDoctor: CommandHandlerFor<typeof doctorSpec> = async ({ args }): Promise<number> => {
  const results: TimedCheckResult[] = []
  const s = spinner()

  // Tools
  results.push(await runCheck(s, "bun", () => checkTool({ name: "bun", cmd: "bun" })))
  results.push(await runCheck(s, "docker", () => checkTool({ name: "docker", cmd: "docker" })))
  results.push(
    await runCheck(s, "docker compose", () => checkTool({ name: "docker compose", cmd: "docker" }))
  )
  results.push(
    await runCheck(s, "brew", () =>
      checkTool({ name: "brew (optional)", cmd: "brew", optional: true })
    )
  )
  results.push(
    await runCheck(s, "dnsmasq", () =>
      checkTool({ name: "dnsmasq (optional)", cmd: "dnsmasq", optional: true })
    )
  )
  results.push(
    await runCheck(s, "mkcert", () =>
      checkTool({ name: "mkcert (optional)", cmd: "mkcert", optional: true })
    )
  )
  results.push(await runCheck(s, "gum", () => checkOptionalGum()))
  results.push(
    await runCheck(s, "go", () => checkTool({ name: "go (optional)", cmd: "go", optional: true }))
  )
  results.push(
    await runCheck(s, "caddy", () =>
      checkTool({ name: "caddy (optional)", cmd: "caddy", optional: true })
    )
  )
  results.push(
    await runCheck(s, "asdf", () =>
      checkTool({ name: "asdf (optional)", cmd: "asdf", optional: true })
    )
  )

  // Docker running
  results.push(
    await runCheck(s, "docker daemon", () => checkDockerRunning(), {
      timeoutMs: 5000
    })
  )

  // Networks
  results.push(
    await runCheck(
      s,
      `network:${DEFAULT_INGRESS_NETWORK}`,
      () => checkDockerNetwork(DEFAULT_INGRESS_NETWORK),
      {
        timeoutMs: 5000
      }
    )
  )
  results.push(
    await runCheck(
      s,
      `network:${DEFAULT_LOGGING_NETWORK}`,
      () => checkDockerNetwork(DEFAULT_LOGGING_NETWORK),
      {
        timeoutMs: 5000
      }
    )
  )
  results.push(
    await runCheck(
      s,
      `network:${DEFAULT_INGRESS_NETWORK} subnet`,
      () => checkIngressSubnet(),
      {
        timeoutMs: 5000
      }
    )
  )

  // Global files
  results.push(await runCheck(s, "global files", () => checkGlobalFiles()))
  results.push(await runCheck(s, "daemon", () => checkDaemonStatus()))

  if (isMac()) {
    results.push(
      await runCheck(s, `resolver:${DEFAULT_PROJECT_TLD}`, () => checkMacResolverForDomain(DEFAULT_PROJECT_TLD), {
        timeoutMs: 1000
      })
    )
    results.push(
      await runCheck(
        s,
        `resolver:${DEFAULT_OAUTH_ALIAS_ROOT}`,
        () => checkMacResolverForDomain(DEFAULT_OAUTH_ALIAS_ROOT),
        {
          timeoutMs: 1000
        }
      )
    )
    results.push(
      await runCheck(
        s,
        `dnsmasq.conf:${DEFAULT_PROJECT_TLD}`,
        () => checkMacDnsmasqConfigForDomain(DEFAULT_PROJECT_TLD),
        {
          timeoutMs: 1500
        }
      )
    )
    results.push(
      await runCheck(
        s,
        `dnsmasq.conf:${DEFAULT_OAUTH_ALIAS_ROOT}`,
        () => checkMacDnsmasqConfigForDomain(DEFAULT_OAUTH_ALIAS_ROOT),
        {
          timeoutMs: 1500
        }
      )
    )
    results.push(
      await runCheck(s, "dnsmasq:53", () => checkMacDnsmasqPort53(), {
        timeoutMs: 2000
      })
    )
  }

  // DNS (can be very slow if wildcard DNS isn't configured)
  const dns = await runCheck(s, `dns:${DEFAULT_PROJECT_TLD}`, () => checkHackDns(), {
    timeoutMs: 1500
  })
  results.push(dns)

  const oauthDns = await runCheck(s, `dns:${DEFAULT_OAUTH_ALIAS_ROOT}`, () => checkOauthAliasDns(), {
    timeoutMs: 1500
  })
  results.push(oauthDns)

  // Endpoint reachability (best-effort). Skip if DNS isn't set up.
  if (dns.status === "ok") {
    results.push(
      await runCheck(s, "grafana", () => checkGrafanaReachable(), {
        timeoutMs: 2000
      })
    )
  } else {
    results.push({
      name: "grafana",
      status: "warn",
      message: `Skipped reachability (DNS for ${DEFAULT_GRAFANA_HOST} not configured)`,
      durationMs: 0
    })
  }

  results.push(
    await runCheck(s, "coredns forwarding", () => checkCoreDnsForwarding(), {
      timeoutMs: 2000
    })
  )
  results.push(
    await runCheck(s, "caddy local ca", () => checkCaddyLocalCa(), {
      timeoutMs: 1500
    })
  )

  // Project (if in a repo or --path)
  const startDir = args.options.path ? resolve(process.cwd(), args.options.path) : process.cwd()
  const projectCtx = await runCheck(s, "project", () => checkProject({ startDir }))
  results.push(projectCtx)

  if (projectCtx.status === "ok") {
    results.push(await runCheck(s, "compose networks", () => checkComposeNetworkHygiene({ startDir })))
    results.push(await runCheck(s, "DEV_HOST", () => checkDevHost({ startDir })))
  } else {
    results.push({
      name: "DEV_HOST",
      status: "warn",
      message: `Skipped (no ${HACK_PROJECT_DIR_PRIMARY}/ found)`,
      durationMs: 0
    })
  }

  emitSlowChecksNote(results)
  renderMacNote()

  if (args.options.fix) {
    await runDoctorFix()
    note("Re-run: hack doctor", "doctor")
  }

  const hasError = results.some(r => r.status === "error")
  if (hasError) {
    note("Fix the errors above, then rerun: hack doctor", "doctor")
    return 1
  }

  return 0
}

export const doctorCommand = withHandler(doctorSpec, handleDoctor)

async function checkTool(opts: {
  readonly name: string
  readonly cmd: string
  readonly optional?: boolean
}): Promise<CheckResult> {
  const path = await findExecutableInPath(opts.cmd)
  return {
    name: opts.name,
    status:
      path ? "ok"
      : opts.optional ? "warn"
      : "error",
    message:
      path ? path
      : opts.optional ? "Not found (optional)"
      : "Not found in PATH"
  }
}

async function checkOptionalGum(): Promise<CheckResult> {
  const gum = getGumPath()
  if (!gum) {
    return {
      name: "gum (optional)",
      status: "warn",
      message: "gum not found (optional)"
    }
  }
  return { name: "gum (optional)", status: "ok", message: gum }
}

async function checkDockerRunning(): Promise<CheckResult> {
  const res = await exec(["docker", "info"], { stdin: "ignore" })
  return {
    name: "docker daemon",
    status: res.exitCode === 0 ? "ok" : "error",
    message: res.exitCode === 0 ? "Docker is running" : "Docker daemon is not reachable"
  }
}

async function checkDockerNetwork(name: string): Promise<CheckResult> {
  const res = await exec(["docker", "network", "inspect", name], { stdin: "ignore" })
  return {
    name: `network:${name}`,
    status: res.exitCode === 0 ? "ok" : "error",
    message:
      res.exitCode === 0 ?
        `Exists (${name})`
      : `Missing (${name}) (run: hack global install)`
  }
}

async function checkIngressSubnet(): Promise<CheckResult> {
  const inspect = await inspectDockerNetwork(DEFAULT_INGRESS_NETWORK)
  if (!inspect.exists) {
    return {
      name: `network:${DEFAULT_INGRESS_NETWORK} subnet`,
      status: "warn",
      message: `Missing ${DEFAULT_INGRESS_NETWORK} (run: hack global install)`
    }
  }

  if (!inspect.hasSubnet) {
    return {
      name: `network:${DEFAULT_INGRESS_NETWORK} subnet`,
      status: "warn",
      message: `Missing subnet ${DEFAULT_INGRESS_SUBNET} (run: hack doctor --fix)`
    }
  }

  return {
    name: `network:${DEFAULT_INGRESS_NETWORK} subnet`,
    status: "ok",
    message: `Subnet ${DEFAULT_INGRESS_SUBNET} present`
  }
}

async function checkGlobalFiles(): Promise<CheckResult> {
  const home = getHomeDir()
  if (!home) {
    return {
      name: "global files",
      status: "error",
      message: "HOME is not set"
    }
  }

  const root = resolve(home, GLOBAL_HACK_DIR_NAME)
  const caddyCompose = resolve(root, GLOBAL_CADDY_DIR_NAME, GLOBAL_CADDY_COMPOSE_FILENAME)
  const loggingCompose = resolve(root, GLOBAL_LOGGING_DIR_NAME, GLOBAL_LOGGING_COMPOSE_FILENAME)

  const ok = (await pathExists(caddyCompose)) && (await pathExists(loggingCompose))
  return {
    name: "global files",
    status: ok ? "ok" : "warn",
    message: ok ? root : `Missing compose files under ${root} (run: hack global install)`
  }
}

async function checkDaemonStatus(): Promise<CheckResult> {
  const paths = resolveDaemonPaths({})
  const status = await readDaemonStatus({ paths })
  if (status.running) {
    return {
      name: "daemon",
      status: "ok",
      message: `hackd running (pid ${status.pid ?? "unknown"})`
    }
  }

  const detail =
    status.pid !== null || status.socketExists
      ? "hackd not running (stale pid/socket)"
      : "hackd not running (run: hack daemon start)"
  return {
    name: "daemon",
    status: "warn",
    message: detail
  }
}

export async function checkCoreDnsForwarding(): Promise<CheckResult> {
  const server = await resolveCoreDnsServer()
  if (!server) {
    return {
      name: "coredns forwarding",
      status: "warn",
      message: "CoreDNS not running (run: hack global up)"
    }
  }

  const ip = await queryDnsARecord({
    hostname: "example.com",
    server,
    port: 53,
    timeoutMs: 900
  })

  return {
    name: "coredns forwarding",
    status: ip ? "ok" : "warn",
    message: ip ? `example.com → ${ip} (via ${server})` : "SERVFAIL (run: hack doctor --fix)"
  }
}

export async function checkCaddyLocalCa(): Promise<CheckResult> {
  const paths = getGlobalPaths()
  const exists = await pathExists(paths.caddyCaCert)
  return {
    name: "caddy local ca",
    status: exists ? "ok" : "warn",
    message: exists ? paths.caddyCaCert : "Missing Caddy Local CA (run: hack doctor --fix)"
  }
}

async function checkMacResolverForDomain(domain: string): Promise<CheckResult> {
  const resolverPath = `/etc/resolver/${domain}`
  const exists = await pathExists(resolverPath)
  if (!exists) {
    return {
      name: `resolver:${domain}`,
      status: "warn",
      message: `Missing ${resolverPath} (run: hack global install)`
    }
  }

  const text = (await readTextFile(resolverPath)) ?? ""
  const hasNameserver = resolverHasNameserver({ text, nameserver: "127.0.0.1" })

  return {
    name: `resolver:${domain}`,
    status: hasNameserver ? "ok" : "warn",
    message:
      hasNameserver ? resolverPath : (
        `Unexpected contents in ${resolverPath} (expected "nameserver 127.0.0.1")`
      )
  }
}

async function checkMacDnsmasqConfigForDomain(domain: string): Promise<CheckResult> {
  const desiredLine = `address=/.${domain}/127.0.0.1`

  const brew = await findExecutableInPath("brew")
  if (!brew) {
    return {
      name: `dnsmasq.conf:${domain}`,
      status: "warn",
      message: "Homebrew not found; cannot locate dnsmasq.conf"
    }
  }

  const prefixRes = await exec(["brew", "--prefix"], { stdin: "ignore" })
  const brewPrefix = prefixRes.exitCode === 0 ? prefixRes.stdout.trim() : "/opt/homebrew"
  const dnsmasqConf = resolve(brewPrefix, "etc", "dnsmasq.conf")
  const text = await readTextFile(dnsmasqConf)

  if (text === null) {
    return {
      name: `dnsmasq.conf:${domain}`,
      status: "warn",
      message: `Unable to read ${dnsmasqConf} (run: hack global install)`
    }
  }

  const ok = dnsmasqConfigHasDomain({ text, domain })
  return {
    name: `dnsmasq.conf:${domain}`,
    status: ok ? "ok" : "warn",
    message:
      ok ? dnsmasqConf : `Missing "${desiredLine}" in ${dnsmasqConf} (run: hack global install)`
  }
}

async function checkMacDnsmasqPort53(): Promise<CheckResult> {
  const ip = await queryDnsARecord({
    hostname: DEFAULT_GRAFANA_HOST,
    server: "127.0.0.1",
    port: 53,
    timeoutMs: 900
  })

  if (!ip) {
    return {
      name: "dnsmasq:53",
      status: "warn",
      message: `No DNS response from 127.0.0.1:53 (run: sudo brew services restart dnsmasq)`
    }
  }

  const ok = ip === "127.0.0.1"
  return {
    name: "dnsmasq:53",
    status: ok ? "ok" : "warn",
    message: `${DEFAULT_GRAFANA_HOST} → ${ip} (from 127.0.0.1:53)`
  }
}

async function queryDnsARecord(opts: {
  readonly hostname: string
  readonly server: string
  readonly port: number
  readonly timeoutMs: number
}): Promise<string | null> {
  const { createSocket } = await import("node:dgram")

  const id = Math.floor(Math.random() * 65535)
  const header = Buffer.alloc(12)
  header.writeUInt16BE(id, 0)
  header.writeUInt16BE(0x0100, 2) // recursion desired
  header.writeUInt16BE(1, 4) // QDCOUNT
  header.writeUInt16BE(0, 6) // ANCOUNT
  header.writeUInt16BE(0, 8) // NSCOUNT
  header.writeUInt16BE(0, 10) // ARCOUNT

  const qname = encodeDnsName(opts.hostname)
  const question = Buffer.concat([qname, Buffer.from([0x00, 0x01, 0x00, 0x01])]) // A / IN
  const packet = Buffer.concat([header, question])

  return await new Promise<string | null>(resolve => {
    const socket = createSocket("udp4")

    const finish = (value: string | null) => {
      try {
        socket.close()
      } catch {
        // ignore
      }
      resolve(value)
    }

    const timeout = setTimeout(() => finish(null), opts.timeoutMs)

    socket.on("message", (msg: Buffer) => {
      clearTimeout(timeout)
      finish(parseDnsAResponse({ msg, expectedId: id }))
    })

    socket.send(packet, opts.port, opts.server, (err: Error | null) => {
      if (err) {
        clearTimeout(timeout)
        finish(null)
      }
    })
  })
}

function encodeDnsName(hostname: string): Buffer {
  const parts = hostname.split(".").filter(p => p.length > 0)
  const bytes: number[] = []
  for (const part of parts) {
    const buf = Buffer.from(part, "utf8")
    bytes.push(buf.length)
    for (const b of buf) bytes.push(b)
  }
  bytes.push(0)
  return Buffer.from(bytes)
}

function parseDnsAResponse(opts: {
  readonly msg: Buffer
  readonly expectedId: number
}): string | null {
  if (opts.msg.length < 12) return null
  const id = opts.msg.readUInt16BE(0)
  if (id !== opts.expectedId) return null

  const qd = opts.msg.readUInt16BE(4)
  const an = opts.msg.readUInt16BE(6)

  let offset = 12

  for (let i = 0; i < qd; i += 1) {
    offset = skipDnsName(opts.msg, offset)
    offset += 4 // QTYPE + QCLASS
    if (offset > opts.msg.length) return null
  }

  for (let i = 0; i < an; i += 1) {
    offset = skipDnsName(opts.msg, offset)
    if (offset + 10 > opts.msg.length) return null
    const type = opts.msg.readUInt16BE(offset)
    const klass = opts.msg.readUInt16BE(offset + 2)
    const rdlength = opts.msg.readUInt16BE(offset + 8)
    offset += 10
    if (offset + rdlength > opts.msg.length) return null

    if (type === 1 && klass === 1 && rdlength === 4) {
      const a = opts.msg[offset]
      const b = opts.msg[offset + 1]
      const c = opts.msg[offset + 2]
      const d = opts.msg[offset + 3]
      return `${a}.${b}.${c}.${d}`
    }

    offset += rdlength
  }

  return null
}

function skipDnsName(buf: Buffer, startOffset: number): number {
  let offset = startOffset
  while (offset < buf.length) {
    const len = buf[offset]
    if (len === undefined) return offset
    if ((len & 0b1100_0000) === 0b1100_0000) return offset + 2 // pointer
    if (len === 0) return offset + 1
    offset += 1 + len
  }
  return offset
}

async function checkHackDns(): Promise<CheckResult> {
  try {
    const res = await lookup(DEFAULT_GRAFANA_HOST)
    const ok = res.address === "127.0.0.1" || res.address === "::1"
    return {
      name: `dns:${DEFAULT_PROJECT_TLD}`,
      status: ok ? "ok" : "warn",
      message: `${DEFAULT_GRAFANA_HOST} → ${res.address}`
    }
  } catch {
    return {
      name: `dns:${DEFAULT_PROJECT_TLD}`,
      status: "warn",
      message: `Unable to resolve ${DEFAULT_GRAFANA_HOST} (run: hack global install)`
    }
  }
}

async function checkOauthAliasDns(): Promise<CheckResult> {
  const host = `logs.${DEFAULT_OAUTH_ALIAS_ROOT}`
  try {
    const res = await lookup(host)
    const ok = res.address === "127.0.0.1" || res.address === "::1"
    return {
      name: `dns:${DEFAULT_OAUTH_ALIAS_ROOT}`,
      status: ok ? "ok" : "warn",
      message: `${host} → ${res.address}`
    }
  } catch {
    return {
      name: `dns:${DEFAULT_OAUTH_ALIAS_ROOT}`,
      status: "warn",
      message: `Unable to resolve ${host} (run: hack global install)`
    }
  }
}

async function checkGrafanaReachable(): Promise<CheckResult> {
  // Best-effort; TLS may fail if CA isn't trusted. Don't error on this.
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2000)
    const res = await fetch(`http://${DEFAULT_GRAFANA_HOST}`, {
      signal: controller.signal,
      redirect: "manual"
    })
    clearTimeout(timeout)
    return {
      name: "grafana",
      status:
        (
          res.ok ||
          res.status === 301 ||
          res.status === 302 ||
          res.status === 307 ||
          res.status === 308
        ) ?
          "ok"
        : "warn",
      message: `http://${DEFAULT_GRAFANA_HOST} → ${res.status}`
    }
  } catch {
    return {
      name: "grafana",
      status: "warn",
      message: `Unable to reach http://${DEFAULT_GRAFANA_HOST} (is global infra up?)`
    }
  }
}

async function checkProject({ startDir }: { readonly startDir: string }): Promise<CheckResult> {
  const ctx = await findProjectContext(startDir)
  if (ctx) {
    return {
      name: "project",
      status: "ok",
      message: `Found ${HACK_PROJECT_DIR_PRIMARY}/ (or legacy .dev/) at ${dirname(ctx.composeFile)}`
    }
  }
  return {
    name: "project",
    status: "warn",
    message: `No ${HACK_PROJECT_DIR_PRIMARY}/ found in current path (run 'hack init' in a repo)`
  }
}

async function checkDevHost({ startDir }: { readonly startDir: string }): Promise<CheckResult> {
  const ctx = await findProjectContext(startDir)
  if (!ctx) {
    return {
      name: "DEV_HOST",
      status: "warn",
      message: `Missing ${HACK_PROJECT_DIR_PRIMARY}/ (run 'hack init' in a repo)`
    }
  }

  const cfg = await readProjectConfig(ctx)
  const envHost = await readLegacyEnvDevHost(ctx.envFile)
  const configPath = cfg.configPath ?? ctx.configFile

  if (cfg.parseError) {
    return {
      name: "DEV_HOST",
      status: "warn",
      message:
        envHost ?
          `Invalid ${configPath}: ${cfg.parseError} (legacy DEV_HOST=${envHost} in ${ctx.envFile})`
        : `Invalid ${configPath}: ${cfg.parseError}`
    }
  }

  if (cfg.devHost) {
    return {
      name: "DEV_HOST",
      status: "ok",
      message: cfg.devHost
    }
  }

  if (envHost) {
    return {
      name: "DEV_HOST",
      status: "warn",
      message: `Using legacy DEV_HOST=${envHost} from ${ctx.envFile} (move to ${ctx.configFile})`
    }
  }

  const devHost = await readProjectDevHost(ctx)
  return {
    name: "DEV_HOST",
    status: devHost ? "ok" : "warn",
    message: devHost ? devHost : `Missing dev_host in ${configPath}`
  }
}

async function checkComposeNetworkHygiene({
  startDir
}: {
  readonly startDir: string
}): Promise<CheckResult> {
  const ctx = await findProjectContext(startDir)
  if (!ctx) {
    return {
      name: "compose networks",
      status: "warn",
      message: `Skipped (no ${HACK_PROJECT_DIR_PRIMARY}/ found)`
    }
  }

  const yamlText = await readTextFile(ctx.composeFile)
  if (!yamlText) {
    return {
      name: "compose networks",
      status: "warn",
      message: `Unable to read ${ctx.composeFile}`
    }
  }

  const analysis = analyzeComposeNetworkHygiene({ yamlText })
  if ("error" in analysis) {
    const message =
      analysis.error === "invalid-yaml" ? `Invalid YAML in ${ctx.composeFile}`
      : analysis.error === "missing-services" ? `Missing services in ${ctx.composeFile}`
      : `Unexpected compose format in ${ctx.composeFile}`
    return {
      name: "compose networks",
      status: "warn",
      message
    }
  }

  return {
    name: "compose networks",
    status: analysis.offenders.length > 0 ? "warn" : "ok",
    message:
      analysis.offenders.length > 0 ?
        `Internal services attached to ${DEFAULT_INGRESS_NETWORK} without Caddy labels: ${analysis.offenders.join(", ")}`
      : "OK"
  }
}

async function readLegacyEnvDevHost(envFile: string): Promise<string | null> {
  const envText = await readTextFile(envFile)
  if (!envText) return null
  const env = parseDotEnv(envText)
  const host = env["DEV_HOST"]
  return typeof host === "string" && host.length > 0 ? host : null
}

async function runDoctorFix(): Promise<void> {
  const ok = await confirm({
    message: "Attempt safe auto-remediations now? (network + CoreDNS + CA)",
    initialValue: true
  })
  if (isCancel(ok)) throw new Error("Canceled")
  if (!ok) return

  const dockerOk = await exec(["docker", "info"], { stdin: "ignore" })
  if (dockerOk.exitCode !== 0) {
    note("Docker is not reachable; cannot apply fixes.", "doctor")
    return
  }

  const daemonPaths = resolveDaemonPaths({})
  const daemonStatus = await readDaemonStatus({ paths: daemonPaths })
  if (!daemonStatus.running) {
    if (daemonStatus.pid !== null || daemonStatus.socketExists) {
      const okStale = await confirm({
        message: "Remove stale hackd pid/socket files?",
        initialValue: true
      })
      if (isCancel(okStale)) throw new Error("Canceled")
      if (okStale) {
        await removeFileIfExists({ path: daemonPaths.pidPath })
        await removeFileIfExists({ path: daemonPaths.socketPath })
      }
    }

    const okStart = await confirm({
      message: "Start hackd now?",
      initialValue: true
    })
    if (isCancel(okStart)) throw new Error("Canceled")
    if (okStart) {
      const invocation = await resolveHackInvocation()
      await run(
        [invocation.bin, ...invocation.args, "daemon", "start"],
        { stdin: "inherit" }
      )
    }
  }

  const paths = getGlobalPaths()
  await ensureDir(paths.caddyDir)

  const ingress = await inspectDockerNetwork(DEFAULT_INGRESS_NETWORK)
  if (!ingress.exists || !ingress.hasSubnet) {
    const action = ingress.exists ? "Recreate" : "Create"
    const okNetwork = await confirm({
      message: `${action} ${DEFAULT_INGRESS_NETWORK} with subnet ${DEFAULT_INGRESS_SUBNET}?`,
      initialValue: true
    })
    if (isCancel(okNetwork)) throw new Error("Canceled")
    if (okNetwork) {
      if (ingress.exists) {
        await run(["docker", "network", "rm", DEFAULT_INGRESS_NETWORK], { stdin: "inherit" })
      }
      await run(
        [
          "docker",
          "network",
          "create",
          DEFAULT_INGRESS_NETWORK,
          "--subnet",
          DEFAULT_INGRESS_SUBNET,
          "--gateway",
          DEFAULT_INGRESS_GATEWAY
        ],
        { stdin: "inherit" }
      )
    }
  }

  const logging = await inspectDockerNetwork(DEFAULT_LOGGING_NETWORK)
  if (!logging.exists) {
    await run(["docker", "network", "create", DEFAULT_LOGGING_NETWORK], { stdin: "inherit" })
  }

  const useStaticIps = false
  await writeWithPromptIfDifferent(
    paths.caddyCompose,
    renderGlobalCaddyCompose({
      useStaticCoreDnsIp: useStaticIps,
      useStaticCaddyIp: useStaticIps
    })
  )
  await writeWithPromptIfDifferent(
    paths.coreDnsConfig,
    renderGlobalCoreDnsConfig({ useStaticCaddyIp: useStaticIps })
  )

  if (await pathExists(paths.caddyCompose)) {
    await run(["docker", "compose", "-f", paths.caddyCompose, "up", "-d", "--remove-orphans"], {
      cwd: dirname(paths.caddyCompose),
      stdin: "inherit"
    })
  }

  if (!(await pathExists(paths.caddyCaCert))) {
    const okCa = await confirm({
      message: "Export Caddy Local CA cert for container trust?",
      initialValue: true
    })
    if (isCancel(okCa)) throw new Error("Canceled")
    if (okCa) {
      await exportCaddyLocalCaCert({ paths })
    }
  }
}

async function inspectDockerNetwork(name: string): Promise<{ exists: boolean; hasSubnet: boolean }> {
  const res = await exec(["docker", "network", "inspect", name], { stdin: "ignore" })
  if (res.exitCode !== 0) return { exists: false, hasSubnet: false }
  return {
    exists: true,
    hasSubnet: networkHasSubnet(res.stdout, DEFAULT_INGRESS_SUBNET)
  }
}

function networkHasSubnet(raw: string, subnet: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  if (!Array.isArray(parsed)) return false
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue
    const ipam = (item as { IPAM?: { Config?: Array<{ Subnet?: string }> } }).IPAM
    const configs = ipam?.Config ?? []
    if (configs.some(cfg => cfg?.Subnet === subnet)) return true
  }
  return false
}

async function resolveCoreDnsServer(): Promise<string | null> {
  const paths = getGlobalPaths()
  if (!(await pathExists(paths.caddyCompose))) return null

  const ps = await exec(["docker", "compose", "-f", paths.caddyCompose, "ps", "-q", "coredns"], {
    cwd: dirname(paths.caddyCompose),
    stdin: "ignore"
  })
  const id = ps.exitCode === 0 ? ps.stdout.trim() : ""
  if (!id) return null

  const inspect = await exec(
    ["docker", "inspect", "--format", "{{json .NetworkSettings.Networks}}", id],
    { stdin: "ignore" }
  )
  if (inspect.exitCode !== 0) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(inspect.stdout)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const network = (parsed as Record<string, { IPAddress?: string }>)[DEFAULT_INGRESS_NETWORK]
  if (!network) return null
  return typeof network.IPAddress === "string" && network.IPAddress.length > 0 ?
      network.IPAddress
    : null
}

async function exportCaddyLocalCaCert(opts: { readonly paths: GlobalPaths }): Promise<void> {
  const ps = await exec(["docker", "compose", "-f", opts.paths.caddyCompose, "ps", "-q", "caddy"], {
    cwd: dirname(opts.paths.caddyCompose),
    stdin: "ignore"
  })
  const id = ps.exitCode === 0 ? ps.stdout.trim() : ""
  if (!id) {
    note("Unable to locate running Caddy container for CA export.", "doctor")
    return
  }

  await ensureDir(dirname(opts.paths.caddyCaCert))
  await run(
    ["docker", "cp", `${id}:/data/caddy/pki/authorities/local/root.crt`, opts.paths.caddyCaCert],
    { stdin: "inherit" }
  )
}

type GlobalPaths = {
  readonly root: string
  readonly caddyDir: string
  readonly caddyCompose: string
  readonly coreDnsConfig: string
  readonly caddyCaCert: string
  readonly loggingCompose: string
}

function getGlobalPaths(): GlobalPaths {
  const home = getHomeDir()
  if (!home) {
    throw new Error("HOME is not set")
  }
  const root = resolve(home, GLOBAL_HACK_DIR_NAME)
  const caddyDir = resolve(root, GLOBAL_CADDY_DIR_NAME)
  const caddyCompose = resolve(caddyDir, GLOBAL_CADDY_COMPOSE_FILENAME)
  const coreDnsConfig = resolve(caddyDir, GLOBAL_COREDNS_FILENAME)
  const caddyCaCert = resolve(caddyDir, "pki", "caddy-local-authority.crt")
  const loggingCompose = resolve(root, GLOBAL_LOGGING_DIR_NAME, GLOBAL_LOGGING_COMPOSE_FILENAME)
  return {
    root,
    caddyDir,
    caddyCompose,
    coreDnsConfig,
    caddyCaCert,
    loggingCompose
  }
}

async function writeWithPromptIfDifferent(absolutePath: string, content: string): Promise<void> {
  const existing = await readTextFile(absolutePath)
  if (existing === content) return

  if (existing !== null) {
    const ok = await confirm({
      message: `Overwrite existing file?\n${absolutePath}`,
      initialValue: true
    })
    if (isCancel(ok)) throw new Error("Canceled")
    if (!ok) return
  }

  await ensureDir(dirname(absolutePath))
  await writeTextFileIfChanged(absolutePath, content)
}

function emitSlowChecksNote(results: readonly TimedCheckResult[]): void {
  const slow = results.filter(r => r.durationMs >= 500).map(r => `${r.name} (${r.durationMs}ms)`)
  if (slow.length === 0) return
  note(slow.join("\n"), "Slow checks")
}

function formatTimedResult(opts: {
  readonly result: CheckResult
  readonly durationMs: number
}): string {
  const enableColor = isColorEnabled()

  const RESET = "\x1b[0m"
  const BOLD = "\x1b[1m"
  const DIM = "\x1b[2m"
  const GREEN = "\x1b[32m"
  const YELLOW = "\x1b[33m"
  const RED = "\x1b[31m"

  const color = (code: string, text: string) => (enableColor ? `${code}${text}${RESET}` : text)

  const icon =
    opts.result.status === "ok" ? color(GREEN, "✓")
    : opts.result.status === "warn" ? color(YELLOW, "!")
    : color(RED, "✗")

  const name = enableColor ? `${BOLD}${opts.result.name}${RESET}` : opts.result.name
  const dur = opts.durationMs >= 250 ? color(DIM, ` (${opts.durationMs}ms)`) : ""

  return `${icon} ${name}: ${opts.result.message}${dur}`
}

function renderMacNote(): void {
  if (isMac()) {
    note(
      [
        "macOS tip:",
        `- wildcard DNS: /etc/resolver/${DEFAULT_PROJECT_TLD} + dnsmasq address=/.${DEFAULT_PROJECT_TLD}/127.0.0.1`,
        `- OAuth alias DNS: /etc/resolver/${DEFAULT_OAUTH_ALIAS_ROOT} + dnsmasq address=/.${DEFAULT_OAUTH_ALIAS_ROOT}/127.0.0.1`
      ].join("\n"),
      "doctor"
    )
  }
}

// Keep macOS guidance at the end so it doesn't push other output off-screen.
// (Called from the command handler.)
async function runCheck(
  s: ReturnType<typeof spinner>,
  name: string,
  fn: () => Promise<CheckResult>,
  opts?: { readonly timeoutMs?: number }
): Promise<TimedCheckResult> {
  const start = Date.now()
  s.start(name)
  try {
    const res =
      opts?.timeoutMs ?
        await Promise.race([
          fn(),
          new Promise<CheckResult>(resolve =>
            setTimeout(() => resolve({ name, status: "warn", message: "Timed out" }), opts.timeoutMs)
          )
        ])
      : await fn()
    const durationMs = Date.now() - start
    s.stop(formatTimedResult({ result: res, durationMs }))
    return { ...res, durationMs }
  } catch (err: unknown) {
    const durationMs = Date.now() - start
    const message = err instanceof Error ? err.message : "Unknown error"
    const res: CheckResult = { name, status: "error", message }
    s.stop(formatTimedResult({ result: res, durationMs }))
    return { ...res, durationMs }
  }
}

function getHomeDir(): string | null {
  return process.env.HOME ?? null
}
