import { resolve } from "node:path"

import { resolveHackInvocation } from "../lib/hack-cli.ts"
import { readTextFile, writeTextFileIfChanged } from "../lib/fs.ts"
import { getString, isRecord } from "../lib/guards.ts"
import {
  defaultProjectSlugFromPath,
  findProjectContext,
  readProjectConfig,
  sanitizeProjectSlug
} from "../lib/project.ts"
import { resolveRegisteredProjectByName, upsertProjectRegistration } from "../lib/projects-registry.ts"
import { readControlPlaneConfig } from "../control-plane/sdk/config.ts"
import { logger } from "../ui/logger.ts"
import { display } from "../ui/display.ts"
import { gumChooseOne, gumConfirm, gumInput, isGumAvailable } from "../ui/gum.ts"
import { buildGatewayQrPayload, renderQrPayload } from "../ui/qr.ts"
import { isTty } from "../ui/terminal.ts"
import { CliUsageError, defineCommand, defineOption, withHandler } from "../cli/command.ts"
import { optPath, optProject } from "../cli/options.ts"
import { resolveDaemonPaths } from "../daemon/paths.ts"
import { readDaemonStatus } from "../daemon/status.ts"
import { createGatewayToken } from "../control-plane/extensions/gateway/tokens.ts"
import {
  HACK_PROJECT_DIR_PRIMARY,
  PROJECT_CONFIG_FILENAME,
  PROJECT_CONFIG_LEGACY_FILENAME
} from "../constants.ts"

import type { CliContext, CommandArgs } from "../cli/command.ts"
import type { ControlPlaneConfig } from "../control-plane/sdk/config.ts"
import type { ProjectContext } from "../lib/project.ts"

const gatewaySpec = defineCommand({
  name: "gateway",
  summary: "Manage gateway enablement",
  group: "Extensions",
  options: [],
  positionals: [],
  subcommands: []
} as const)

const toggleOptions = [optPath, optProject] as const

const enableSpec = defineCommand({
  name: "enable",
  summary: "Enable the gateway and start hackd",
  group: "Extensions",
  options: toggleOptions,
  positionals: [],
  subcommands: []
} as const)

const optQr = defineOption({
  name: "qr",
  type: "boolean",
  long: "--qr",
  description: "Force QR output after setup (default)"
} as const)

const optNoQr = defineOption({
  name: "noQr",
  type: "boolean",
  long: "--no-qr",
  description: "Skip QR output after setup"
} as const)

const optYes = defineOption({
  name: "yes",
  type: "boolean",
  long: "--yes",
  description: "Skip confirmation prompts when printing QR payloads"
} as const)

const setupOptions = [optPath, optProject, optQr, optNoQr, optYes] as const

const setupSpec = defineCommand({
  name: "setup",
  summary: "Guided gateway setup (enable + token)",
  group: "Extensions",
  options: setupOptions,
  positionals: [],
  subcommands: []
} as const)

const disableSpec = defineCommand({
  name: "disable",
  summary: "Disable the gateway (does not stop hackd)",
  group: "Extensions",
  options: toggleOptions,
  positionals: [],
  subcommands: []
} as const)

type ToggleArgs = CommandArgs<typeof toggleOptions, readonly []>
type SetupArgs = CommandArgs<typeof setupOptions, readonly []>

const gatewayCommand = defineCommand({
  ...gatewaySpec,
  subcommands: [
    withHandler(enableSpec, handleGatewayEnable),
    withHandler(setupSpec, handleGatewaySetup),
    withHandler(disableSpec, handleGatewayDisable)
  ]
} as const)

export { gatewayCommand }

async function handleGatewayEnable({
  ctx,
  args
}: {
  readonly ctx: CliContext
  readonly args: ToggleArgs
}): Promise<number> {
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project
  })

  const updated = await setGatewayEnabled({ project, enabled: true })
  if (!updated.ok) {
    logger.error({ message: updated.error })
    return 1
  }

  logger.success({ message: updated.changed ? "Gateway enabled." : "Gateway already enabled." })
  const startResult = await startDaemon()
  return startResult
}

async function handleGatewaySetup({
  ctx,
  args
}: {
  readonly ctx: CliContext
  readonly args: SetupArgs
}): Promise<number> {
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project
  })

  const identity = await resolveProjectIdentityForQr({ project })

  await display.panel({
    title: "Gateway setup",
    tone: "info",
    lines: [
      `Project: ${identity.projectName}`,
      "This enables remote access for this project.",
      "Steps:",
      "1) Enable gateway in hack.config.json",
      "2) Optionally enable writes for shells/jobs",
      "3) Start/restart hackd",
      "4) Create a token + QR for remote access"
    ]
  })

  const currentConfig = await readControlPlaneConfig({ projectDir: project.projectDir })
  const allowWritesCurrent = currentConfig.config.gateway.allowWrites

  const updated = await setGatewayEnabled({ project, enabled: true })
  if (!updated.ok) {
    logger.error({ message: updated.error })
    return 1
  }

  if (updated.changed) {
    logger.success({ message: "Gateway enabled." })
  } else {
    logger.info({ message: "Gateway already enabled." })
  }

  let allowWrites = allowWritesCurrent
  if (!allowWritesCurrent && isTty() && isGumAvailable()) {
    const confirmed = await gumConfirm({
      prompt: "Enable write access for jobs/shells? (recommended for remote shell)",
      default: false
    })
    if (confirmed.ok && confirmed.value) {
      allowWrites = true
    }
  }

  let allowWritesChanged = false
  if (allowWrites && !allowWritesCurrent) {
    const writeUpdate = await setGatewayAllowWrites({ project, allowWrites: true })
    if (!writeUpdate.ok) {
      logger.error({ message: writeUpdate.error })
      return 1
    }
    allowWritesChanged = writeUpdate.changed
    if (writeUpdate.changed) {
      logger.success({ message: "Gateway writes enabled." })
    }
  }

  if (!allowWrites && !allowWritesCurrent) {
    logger.info({
      message: "Gateway writes remain disabled (shell/jobs require allowWrites + write token)."
    })
  }

  if (updated.changed || allowWritesChanged) {
    const restart = await restartDaemon()
    if (restart !== 0) return restart
  } else {
    await startDaemon({ onRunningMessage: "hackd already running; no restart needed." })
  }

  const scope = await resolveGatewayTokenScope({
    allowWrites
  })
  const label = await resolveGatewayTokenLabel()

  const paths = resolveDaemonPaths({})
  const issued = await createGatewayToken({
    rootDir: paths.root,
    ...(label ? { label } : {}),
    scope
  })

  await display.kv({
    title: "Gateway token",
    entries: [
      ["id", issued.record.id],
      ["label", issued.record.label ?? ""],
      ["scope", issued.record.scope],
      ["created_at", issued.record.createdAt],
      ["token", issued.token]
    ]
  })

  logger.info({ message: "Store this token securely; it cannot be recovered once lost." })
  logger.info({ message: "Export it as HACK_GATEWAY_TOKEN for future use." })

  const printQr = args.options.noQr !== true

  const finalConfig = await readControlPlaneConfig({ projectDir: project.projectDir })
  const gatewayUrl = resolveGatewayUrlForQr({ config: finalConfig.config })

  if (printQr) {
    const payload = buildGatewayQrPayload({
      baseUrl: gatewayUrl,
      token: issued.token,
      projectId: identity.projectId,
      projectName: identity.projectName
    })
    await renderQrPayload({
      label: "Gateway",
      payload,
      sensitive: true,
      yes: args.options.yes === true
    })
  }

  await display.panel({
    title: "Next steps",
    tone: "info",
    lines: [
      `Gateway URL: ${gatewayUrl}`,
      "Remote status: hack remote status",
      "Remote shell: hack x supervisor shell --token <token> (write scope required)",
      "Expose gateway using one of the options below"
    ]
  })
  await renderExposureHints({
    config: finalConfig.config,
    projectName: identity.projectName
  })
  return 0
}

async function handleGatewayDisable({
  ctx,
  args
}: {
  readonly ctx: CliContext
  readonly args: ToggleArgs
}): Promise<number> {
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project
  })

  const updated = await setGatewayEnabled({ project, enabled: false })
  if (!updated.ok) {
    logger.error({ message: updated.error })
    return 1
  }

  logger.success({ message: updated.changed ? "Gateway disabled." : "Gateway already disabled." })
  return 0
}

async function resolveProjectForArgs(opts: {
  readonly ctx: CliContext
  readonly pathOpt: string | undefined
  readonly projectOpt: string | undefined
}): Promise<ProjectContext> {
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

  const startDir = opts.pathOpt ? resolve(opts.ctx.cwd, opts.pathOpt) : opts.ctx.cwd
  const project = await requireProjectContext(startDir)
  await touchProjectRegistration(project)
  return project
}

async function requireProjectContext(startDir: string): Promise<ProjectContext> {
  const ctx = await findProjectContext(startDir)
  if (!ctx) {
    throw new Error(`No ${HACK_PROJECT_DIR_PRIMARY}/ (or legacy .dev/) found. Run: hack init`)
  }
  return ctx
}

async function touchProjectRegistration(project: ProjectContext): Promise<void> {
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

async function resolveProjectIdentityForQr(opts: {
  readonly project: ProjectContext
}): Promise<{ readonly projectId?: string; readonly projectName: string }> {
  const config = await readProjectConfig(opts.project)
  const defaultName = defaultProjectSlugFromPath(opts.project.projectRoot)
  const projectName = (config.name ?? "").trim() || defaultName

  const outcome = await upsertProjectRegistration({ project: opts.project })
  if (outcome.status === "conflict") {
    return { projectName }
  }

  return { projectId: outcome.project.id, projectName: outcome.project.name }
}

type ConfigReadResult =
  | { readonly ok: true; readonly path: string; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly error: string }

async function readConfigJsonForGateway(opts: {
  readonly project: ProjectContext
}): Promise<ConfigReadResult> {
  const jsonPath = resolve(opts.project.projectDir, PROJECT_CONFIG_FILENAME)
  const jsonText = await readTextFile(jsonPath)
  if (jsonText === null) {
    const tomlPath = resolve(opts.project.projectDir, PROJECT_CONFIG_LEGACY_FILENAME)
    const tomlText = await readTextFile(tomlPath)
    if (tomlText !== null) {
      return {
        ok: false,
        error: `Legacy config found at ${tomlPath}. Convert to ${PROJECT_CONFIG_FILENAME} to use gateway commands.`
      }
    }
    return { ok: false, error: `Missing ${PROJECT_CONFIG_FILENAME}. Run: hack init` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid JSON"
    return { ok: false, error: `Failed to parse ${jsonPath}: ${message}` }
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: `Expected ${jsonPath} to be an object.` }
  }

  return { ok: true, path: jsonPath, value: parsed }
}

async function setGatewayEnabled(opts: {
  readonly project: ProjectContext
  readonly enabled: boolean
}): Promise<{ readonly ok: true; readonly changed: boolean } | { readonly ok: false; readonly error: string }> {
  const read = await readConfigJsonForGateway({ project: opts.project })
  if (!read.ok) return read

  const updates = [
    { path: ["controlPlane", "gateway", "enabled"], value: opts.enabled },
    {
      path: ["controlPlane", "extensions", "dance.hack.gateway", "enabled"],
      value: opts.enabled
    }
  ]

  for (const update of updates) {
    const result = setPathValue({
      target: read.value,
      path: update.path,
      value: update.value
    })
    if (result.error) return { ok: false, error: result.error }
  }

  const nextText = `${JSON.stringify(read.value, null, 2)}\n`
  const result = await writeTextFileIfChanged(read.path, nextText)
  return { ok: true, changed: result.changed }
}

async function setGatewayAllowWrites(opts: {
  readonly project: ProjectContext
  readonly allowWrites: boolean
}): Promise<{ readonly ok: true; readonly changed: boolean } | { readonly ok: false; readonly error: string }> {
  const read = await readConfigJsonForGateway({ project: opts.project })
  if (!read.ok) return read

  const result = setPathValue({
    target: read.value,
    path: ["controlPlane", "gateway", "allowWrites"],
    value: opts.allowWrites
  })
  if (result.error) return { ok: false, error: result.error }

  const nextText = `${JSON.stringify(read.value, null, 2)}\n`
  const update = await writeTextFileIfChanged(read.path, nextText)
  return { ok: true, changed: update.changed }
}

function setPathValue(opts: {
  readonly target: Record<string, unknown>
  readonly path: readonly string[]
  readonly value: unknown
}): { readonly error?: string } {
  let current: Record<string, unknown> = opts.target
  for (let i = 0; i < opts.path.length - 1; i += 1) {
    const key = opts.path[i] ?? ""
    const existing = current[key]
    if (existing === undefined) {
      const next: Record<string, unknown> = {}
      current[key] = next
      current = next
      continue
    }
    if (!isRecord(existing)) {
      return {
        error: `Cannot set ${opts.path.join(".")}: ${opts.path.slice(0, i + 1).join(".")} is not an object.`
      }
    }
    current = existing
  }

  const lastKey = opts.path[opts.path.length - 1] ?? ""
  current[lastKey] = opts.value
  return {}
}

function resolveGatewayUrlForQr(opts: { readonly config: ControlPlaneConfig }): string {
  const cloudflareExtension = opts.config.extensions["dance.hack.cloudflare"]
  const config = cloudflareExtension?.config ?? {}
  const hostname = getString(config, "hostname")
  if (hostname && hostname.trim().length > 0) {
    const trimmed = hostname.trim()
    return trimmed.includes("://") ? trimmed : `https://${trimmed}`
  }

  const bind = opts.config.gateway.bind
  const host = bind.includes(":") ? `[${bind}]` : bind
  return `http://${host}:${opts.config.gateway.port}`
}

async function renderExposureHints(opts: {
  readonly config: ControlPlaneConfig
  readonly projectName: string
}): Promise<void> {
  const port = opts.config.gateway.port
  const bind = opts.config.gateway.bind
  const exposeHost = resolveExposeHost({ bind })

  const lines: string[] = [
    "Pick one to expose the gateway:",
    "SSH (ad-hoc, local port forward):",
    `  ssh -L ${port}:${exposeHost}:${port} <user>@<host>`,
    "Cloudflare Tunnel (Zero Trust, good for phones):",
    buildCloudflareHint({ config: opts.config, projectName: opts.projectName }),
    "Tailscale (VPN, good for SSH access):",
    buildTailscaleHint({ config: opts.config })
  ]

  await display.panel({
    title: "Expose gateway",
    tone: "info",
    lines
  })
}

function resolveExposeHost(opts: { readonly bind: string }): string {
  const trimmed = opts.bind.trim()
  const host =
    trimmed === "0.0.0.0" || trimmed === "" ? "127.0.0.1"
    : trimmed === "::" ? "127.0.0.1"
    : trimmed
  return host.includes(":") ? `[${host}]` : host
}

function buildCloudflareHint(opts: {
  readonly config: ControlPlaneConfig
  readonly projectName: string
}): string {
  const extension = opts.config.extensions["dance.hack.cloudflare"]
  if (!extension?.enabled) {
    return "  Enable: hack config set 'controlPlane.extensions[\"dance.hack.cloudflare\"].enabled' true"
  }

  const hostname = getString(extension.config ?? {}, "hostname")
  if (hostname) {
    return `  Use: https://${hostname} (start with: hack x cloudflare tunnel-start)`
  }

  return "  Setup: hack x cloudflare tunnel-setup --hostname gateway.example.com"
}

function buildTailscaleHint(opts: { readonly config: ControlPlaneConfig }): string {
  const extension = opts.config.extensions["dance.hack.tailscale"]
  if (!extension?.enabled) {
    return "  Enable: hack config set 'controlPlane.extensions[\"dance.hack.tailscale\"].enabled' true"
  }

  return "  Setup: hack x tailscale setup"
}

async function resolveGatewayTokenScope(opts: {
  readonly allowWrites: boolean
}): Promise<"read" | "write"> {
  if (!opts.allowWrites) return "read"
  if (!isTty() || !isGumAvailable()) return "write"

  const choice = await gumChooseOne({
    header: "Token scope",
    options: ["write", "read"],
    selectIfOne: true
  })
  if (!choice.ok) return "write"
  return choice.value === "read" ? "read" : "write"
}

async function resolveGatewayTokenLabel(): Promise<string | undefined> {
  if (!isTty() || !isGumAvailable()) return undefined
  const label = await gumInput({
    prompt: "Token label (optional):",
    placeholder: "e.g. phone, agent, laptop"
  })
  if (!label.ok) return undefined
  return label.value.trim() || undefined
}

async function startDaemon(opts?: { readonly onRunningMessage?: string }): Promise<number> {
  const paths = resolveDaemonPaths({})
  const status = await readDaemonStatus({ paths })
  if (status.running) {
    logger.info({
      message: opts?.onRunningMessage ?? "hackd already running; restart to apply gateway config."
    })
    return 0
  }

  const invocation = await resolveHackInvocation()
  const cmd = [...invocation.args, "daemon", "start"]
  const proc = Bun.spawn([invocation.bin, ...cmd], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit"
  })
  return await proc.exited
}

async function restartDaemon(): Promise<number> {
  const invocation = await resolveHackInvocation()
  const stop = Bun.spawn([invocation.bin, ...invocation.args, "daemon", "stop"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  })
  const stopExit = await stop.exited
  if (stopExit !== 0) {
    logger.warn({ message: "hackd stop did not exit cleanly; continuing with start." })
  }

  const start = Bun.spawn([invocation.bin, ...invocation.args, "daemon", "start"], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit"
  })
  return await start.exited
}
