import pkg from "../../package.json"
import { Buffer } from "node:buffer"
import { relative, resolve } from "node:path"

import type { ServerWebSocket } from "bun"

import { ensureDir } from "../lib/fs.ts"
import { createDaemonLogger } from "./logger.ts"
import { removeFileIfExists, writeDaemonPid } from "./process.ts"
import { startDockerEventWatcher } from "./docker-events.ts"
import { createRuntimeCache } from "./runtime-cache.ts"
import { loadExtensionManagerForDaemon } from "../control-plane/extensions/daemon.ts"
import { createSupervisorService } from "../control-plane/extensions/supervisor/service.ts"
import { createJobStore } from "../control-plane/extensions/supervisor/job-store.ts"
import { createShellService } from "../control-plane/extensions/supervisor/shell-service.ts"
import type { ShellAttachment, ShellMeta } from "../control-plane/extensions/supervisor/shell-service.ts"
import { appendGatewayAuditEntry } from "../control-plane/extensions/gateway/audit.ts"
import { authenticateGatewayRequest } from "../control-plane/extensions/gateway/auth.ts"
import { resolveGatewayConfig } from "../control-plane/extensions/gateway/config.ts"
import { resolveRegisteredProjectById } from "../lib/projects-registry.ts"

import type { DaemonPaths } from "./paths.ts"
import type { ControlPlaneConfig } from "../control-plane/sdk/config.ts"

type PackageJsonType = {
  readonly name: string
  readonly version: string
} & Record<string, unknown>

const packageJson = pkg as unknown as PackageJsonType

type DaemonMetrics = {
  readonly startedAtMs: number
  lastEventAtMs: number | null
  eventsSeen: number
  streamsActive: number
  lastRefreshAtMs: number | null
  refreshCount: number
  refreshFailures: number
}

export async function runDaemon({
  paths,
  foreground
}: {
  readonly paths: DaemonPaths
  readonly foreground: boolean
}): Promise<void> {
  await ensureDir(paths.root)
  await removeFileIfExists({ path: paths.socketPath })
  await writeDaemonPid({ pidPath: paths.pidPath, pid: process.pid })

  const logger = createDaemonLogger({ logPath: paths.logPath, foreground })
  const controlPlane = await loadExtensionManagerForDaemon({ logger })
  if (controlPlane.configError) {
    logger.warn({ message: `Control plane config error: ${controlPlane.configError}` })
  }
  for (const warning of controlPlane.warnings) {
    logger.warn({ message: warning })
  }
  const supervisor = createSupervisorService({ logger })
  const shells = createShellService({ logger })
  const metrics: DaemonMetrics = {
    startedAtMs: Date.now(),
    lastEventAtMs: null,
    eventsSeen: 0,
    streamsActive: 0,
    lastRefreshAtMs: null,
    refreshCount: 0,
    refreshFailures: 0
  }

  const cache = createRuntimeCache({
    onRefresh: snapshot => {
      metrics.lastRefreshAtMs = snapshot.updatedAtMs
      metrics.refreshCount += 1
    }
  })

  await cache.refresh({ reason: "startup" })

  const gatewayResolution = await resolveGatewayConfig()
  for (const warning of gatewayResolution.warnings) {
    logger.warn({ message: warning })
  }

  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleRefresh = ({ reason }: { readonly reason: string }) => {
    if (refreshTimer) return
    refreshTimer = setTimeout(async () => {
      refreshTimer = null
      try {
        await cache.refresh({ reason })
      } catch {
        metrics.refreshFailures += 1
      }
    }, 250)
  }

  const watcher = startDockerEventWatcher({
    onEvent: () => {
      metrics.eventsSeen += 1
      metrics.lastEventAtMs = Date.now()
      scheduleRefresh({ reason: "event" })
    },
    onError: message => logger.warn({ message: `docker events: ${message}` }),
    onExit: exitCode => logger.warn({ message: `docker events exited (${exitCode})` })
  })

  const requestContext = {
    metrics,
    version: packageJson.version,
    pid: process.pid,
    cache,
    supervisor,
    shells
  }

  const websocketHandlers = {
    open: (ws: ServerWebSocket<unknown>) => {
      const state = ws.data as ControlPlaneWsState | undefined
      if (!state) {
        ws.close(1008, "missing_state")
        return
      }
      state.connectedAt = Date.now()
      metrics.streamsActive += 1

      if (state.kind === "shell") {
        const decoder = new TextDecoder()
        const attachment = shells.attachShell({
          shellId: state.shellId,
          onData: data => {
            ws.send(
              JSON.stringify({
                type: "output",
                data: decoder.decode(data)
              })
            )
          },
          onExit: (exitCode, signal) => {
            ws.send(
              JSON.stringify({
                type: "exit",
                exitCode,
                signal
              })
            )
          }
        })
        if (!attachment) {
          ws.close(1008, "shell_not_found")
          return
        }
        state.attachment = attachment
        ws.send(JSON.stringify(buildShellReadyMessage({ meta: attachment.meta })))
      }
    },
    message: async (ws: ServerWebSocket<unknown>, message: string | Uint8Array) => {
      const state = ws.data as ControlPlaneWsState | undefined
      if (!state) {
        ws.close(1008, "missing_state")
        return
      }
      if (state.kind === "job") {
        const parsed = parseWsMessage({ message })
        if (!parsed) {
          ws.send(JSON.stringify({ type: "error", message: "invalid_message" }))
          return
        }
        if (parsed.type !== "hello") {
          ws.send(JSON.stringify({ type: "error", message: "expected_hello" }))
          return
        }
        await startJobStream({
          ws,
          state,
          logsFrom: parsed.logsFrom,
          eventsFrom: parsed.eventsFrom
        })
        return
      }

      const attachment = state.attachment
      if (!attachment) {
        ws.close(1008, "shell_detached")
        return
      }

      const parsed = parseShellClientMessage({ message })
      if (!parsed) {
        if (typeof message === "string" && message.length > 0) {
          attachment.write(message)
        } else if (message instanceof Uint8Array) {
          attachment.write(message)
        }
        return
      }

      if (parsed.type === "hello" || parsed.type === "resize") {
        if (typeof parsed.cols === "number" && typeof parsed.rows === "number") {
          attachment.resize(parsed.cols, parsed.rows)
        }
        return
      }

      if (parsed.type === "input") {
        attachment.write(parsed.data)
        return
      }

      if (parsed.type === "signal") {
        attachment.signal(parsed.signal)
        return
      }

      if (parsed.type === "close") {
        attachment.close()
        return
      }
    },
    close: (ws: ServerWebSocket<unknown>) => {
      const state = ws.data as ControlPlaneWsState | undefined
      if (!state) return
      if (state.kind === "job") {
        stopJobStream({ state })
      } else if (state.attachment) {
        state.attachment.detach()
      }
      metrics.streamsActive = Math.max(0, metrics.streamsActive - 1)
    }
  }

  let server: ReturnType<typeof Bun.serve>
  server = Bun.serve({
    unix: paths.socketPath,
    fetch: req =>
      handleRequest({
        req,
        server,
        ...requestContext
      }),
    websocket: websocketHandlers
  })

  let gatewayServer: ReturnType<typeof Bun.serve> | null = null
  if (gatewayResolution.config.enabled) {
    try {
      gatewayServer = Bun.serve({
        hostname: gatewayResolution.config.bind,
        port: gatewayResolution.config.port,
        fetch: req => {
          if (!gatewayServer) {
            return jsonResponse({ error: "gateway_uninitialized" }, 500)
          }
          return handleGatewayRequest({
            req,
            server: gatewayServer,
            gatewayConfig: gatewayResolution.config,
            gatewayRoot: paths.root,
            ...requestContext
          })
        },
        websocket: websocketHandlers
      })
      const source = gatewayResolution.source
      logger.info({
        message: `Gateway listening on ${gatewayResolution.config.bind}:${gatewayResolution.config.port}`
      })
      if (source) {
        logger.info({
          message: `Gateway config source: ${source.projectName} (${source.projectId})`
        })
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error({ message: `Failed to start gateway: ${message}` })
    }
  }

  const shutdown = async ({ reason }: { readonly reason: string }) => {
    logger.warn({ message: `Shutting down hackd (${reason})` })
    watcher.stop()
    server.stop()
    gatewayServer?.stop()
    await removeFileIfExists({ path: paths.socketPath })
    await removeFileIfExists({ path: paths.pidPath })
    process.exit(0)
  }

  process.on("SIGTERM", () => void shutdown({ reason: "SIGTERM" }))
  process.on("SIGINT", () => void shutdown({ reason: "SIGINT" }))

  logger.info({
    message: `hackd started (pid ${process.pid}, version ${packageJson.version})`
  })
}

async function handleRequest({
  req,
  server,
  metrics,
  version,
  pid,
  cache,
  supervisor,
  shells
}: {
  readonly req: Request
  readonly server: ReturnType<typeof Bun.serve>
  readonly metrics: DaemonMetrics
  readonly version: string
  readonly pid: number
  readonly cache: ReturnType<typeof createRuntimeCache>
  readonly supervisor: ReturnType<typeof createSupervisorService>
  readonly shells: ReturnType<typeof createShellService>
}): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405)
  }

  const url = new URL(req.url)
  const controlPlaneResponse = await handleControlPlaneRequest({
    req,
    url,
    server,
    supervisor,
    shells
  })
  if (controlPlaneResponse) return controlPlaneResponse
  if (url.pathname === "/v1/status") {
    return jsonResponse({
      status: "ok",
      version,
      pid,
      started_at: new Date(metrics.startedAtMs).toISOString(),
      uptime_ms: Date.now() - metrics.startedAtMs
    })
  }

  if (url.pathname === "/v1/metrics") {
    const snapshot = cache.getSnapshot()
    const cacheUpdatedAtMs = snapshot?.updatedAtMs ?? null
    return jsonResponse({
      status: "ok",
      started_at: new Date(metrics.startedAtMs).toISOString(),
      uptime_ms: Date.now() - metrics.startedAtMs,
      cache_updated_at: cacheUpdatedAtMs ? new Date(cacheUpdatedAtMs).toISOString() : null,
      cache_age_ms: cacheUpdatedAtMs ? Date.now() - cacheUpdatedAtMs : null,
      last_refresh_at: metrics.lastRefreshAtMs
        ? new Date(metrics.lastRefreshAtMs).toISOString()
        : null,
      refresh_count: metrics.refreshCount,
      refresh_failures: metrics.refreshFailures,
      last_event_at: metrics.lastEventAtMs ? new Date(metrics.lastEventAtMs).toISOString() : null,
      events_seen: metrics.eventsSeen,
      streams_active: metrics.streamsActive
    })
  }

  if (url.pathname === "/v1/projects") {
    const filter = normalizeQueryParam({ value: url.searchParams.get("filter") })
    const includeGlobal = parseBoolean({ value: url.searchParams.get("include_global") })
    const includeUnregistered = parseBoolean({
      value: url.searchParams.get("include_unregistered")
    })
    const payload = await cache.getProjectsPayload({
      filter,
      includeGlobal,
      includeUnregistered
    })
    return jsonResponse(payload)
  }

  if (url.pathname === "/v1/ps") {
    const composeProject = normalizeQueryParam({
      value: url.searchParams.get("compose_project")
    })
    if (!composeProject) {
      return jsonResponse({ error: "missing_compose_project" }, 400)
    }
    const project = normalizeQueryParam({ value: url.searchParams.get("project") }) ?? composeProject
    const branch = normalizeQueryParam({ value: url.searchParams.get("branch") })
    const payload = cache.getPsPayload({
      composeProject,
      project,
      branch
    })
    return jsonResponse(payload)
  }

  return jsonResponse({ error: "not_found" }, 404)
}

async function handleGatewayRequest(opts: {
  readonly req: Request
  readonly server: ReturnType<typeof Bun.serve>
  readonly gatewayConfig: ControlPlaneConfig["gateway"]
  readonly gatewayRoot: string
  readonly metrics: DaemonMetrics
  readonly version: string
  readonly pid: number
  readonly cache: ReturnType<typeof createRuntimeCache>
  readonly supervisor: ReturnType<typeof createSupervisorService>
  readonly shells: ReturnType<typeof createShellService>
}): Promise<Response> {
  const auth = await authenticateGatewayRequest({
    rootDir: opts.gatewayRoot,
    headers: opts.req.headers
  })

  const url = new URL(opts.req.url)
  const path = `${url.pathname}${url.search}`
  const remote = opts.server.requestIP(opts.req)
  const remoteAddress = remote?.address
  const userAgent = opts.req.headers.get("user-agent") ?? undefined

  if (!auth.ok) {
    const status = 401
    const response = jsonResponse(
      { error: auth.reason === "missing" ? "missing_token" : "invalid_token" },
      status
    )
    void appendGatewayAuditEntry({
      rootDir: opts.gatewayRoot,
      entry: {
        ts: new Date().toISOString(),
        method: opts.req.method,
        path,
        status,
        ...(remoteAddress ? { remoteAddress } : {}),
        ...(userAgent ? { userAgent } : {})
      }
    })
    return response
  }

  const isReadOnly = isGatewayReadOnlyMethod({ method: opts.req.method })
  const isShellStream = isGatewayShellStreamRequest({ url })

  if (!opts.gatewayConfig.allowWrites && !isReadOnly) {
    const status = 403
    const response = jsonResponse({ error: "writes_disabled" }, status)
    void appendGatewayAuditEntry({
      rootDir: opts.gatewayRoot,
      entry: {
        ts: new Date().toISOString(),
        tokenId: auth.tokenId,
        method: opts.req.method,
        path,
        status,
        ...(remoteAddress ? { remoteAddress } : {}),
        ...(userAgent ? { userAgent } : {})
      }
    })
    return response
  }

  if (!isReadOnly && auth.scope !== "write") {
    const status = 403
    const response = jsonResponse({ error: "write_scope_required" }, status)
    void appendGatewayAuditEntry({
      rootDir: opts.gatewayRoot,
      entry: {
        ts: new Date().toISOString(),
        tokenId: auth.tokenId,
        method: opts.req.method,
        path,
        status,
        ...(remoteAddress ? { remoteAddress } : {}),
        ...(userAgent ? { userAgent } : {})
      }
    })
    return response
  }

  if (isShellStream && !opts.gatewayConfig.allowWrites) {
    const status = 403
    const response = jsonResponse({ error: "writes_disabled" }, status)
    void appendGatewayAuditEntry({
      rootDir: opts.gatewayRoot,
      entry: {
        ts: new Date().toISOString(),
        tokenId: auth.tokenId,
        method: opts.req.method,
        path,
        status,
        ...(remoteAddress ? { remoteAddress } : {}),
        ...(userAgent ? { userAgent } : {})
      }
    })
    return response
  }

  if (isShellStream && auth.scope !== "write") {
    const status = 403
    const response = jsonResponse({ error: "write_scope_required" }, status)
    void appendGatewayAuditEntry({
      rootDir: opts.gatewayRoot,
      entry: {
        ts: new Date().toISOString(),
        tokenId: auth.tokenId,
        method: opts.req.method,
        path,
        status,
        ...(remoteAddress ? { remoteAddress } : {}),
        ...(userAgent ? { userAgent } : {})
      }
    })
    return response
  }

  const response = await handleRequest({
    req: opts.req,
    server: opts.server,
    metrics: opts.metrics,
    version: opts.version,
    pid: opts.pid,
    cache: opts.cache,
    supervisor: opts.supervisor,
    shells: opts.shells
  })

  void appendGatewayAuditEntry({
    rootDir: opts.gatewayRoot,
    entry: {
      ts: new Date().toISOString(),
      tokenId: auth.tokenId,
      method: opts.req.method,
      path,
      status: response.status,
      ...(remoteAddress ? { remoteAddress } : {}),
      ...(userAgent ? { userAgent } : {})
    }
  })

  return response
}

async function handleControlPlaneRequest(opts: {
  readonly req: Request
  readonly url: URL
  readonly server: ReturnType<typeof Bun.serve>
  readonly supervisor: ReturnType<typeof createSupervisorService>
  readonly shells: ReturnType<typeof createShellService>
}): Promise<Response | null> {
  const segments = opts.url.pathname.split("/").filter(Boolean)
  if (segments[0] !== "control-plane") return null
  if (segments[1] !== "projects") return jsonResponse({ error: "not_found" }, 404)

  const projectId = segments[2]
  if (!projectId) return jsonResponse({ error: "missing_project_id" }, 400)

  const project = await resolveRegisteredProjectById({ id: projectId })
  if (!project) return jsonResponse({ error: "unknown_project" }, 404)

  if (segments[3] === "jobs" && segments[4] && segments[5] === "stream") {
    if (opts.req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "upgrade_required" }, 426)
    }

    const jobId = segments[4]
    const upgraded = opts.server.upgrade(opts.req, {
      data: {
        kind: "job",
        jobId,
        projectDir: project.project.projectDir
      } satisfies JobStreamState
    })
    if (upgraded) {
      return new Response(null, { status: 101 })
    }
    return jsonResponse({ error: "upgrade_failed" }, 400)
  }

  if (segments[3] === "jobs" && segments.length === 4) {
    if (opts.req.method === "GET") {
      const jobs = await opts.supervisor.listJobs({ projectDir: project.project.projectDir })
      return jsonResponse({ jobs })
    }

    const body = await readJsonBody(opts.req)
    if (!body) return jsonResponse({ error: "invalid_json" }, 400)

    const payload = parseJobCreateInput(body)
    if (!payload.ok) return jsonResponse({ error: payload.error }, 400)

    const created = await opts.supervisor.createJob({
      projectDir: project.project.projectDir,
      projectId: project.registration.id,
      projectName: project.registration.name,
      runner: payload.value.runner,
      command: payload.value.command,
      ...(payload.value.cwd ? { cwd: payload.value.cwd } : {}),
      ...(payload.value.env ? { env: payload.value.env } : {})
    })

    return jsonResponse({ job: created.meta }, 201)
  }

  if (segments[3] === "jobs" && segments[4]) {
    const jobId = segments[4]
    if (segments[5] === "cancel") {
      if (opts.req.method !== "POST") {
        return jsonResponse({ error: "method_not_allowed" }, 405)
      }
      const cancelled = await opts.supervisor.cancelJob({
        projectDir: project.project.projectDir,
        jobId
      })
      if (!cancelled.ok && cancelled.status === "not_found") {
        return jsonResponse({ error: "job_not_found" }, 404)
      }
      if (!cancelled.ok && cancelled.status === "not_running") {
        return jsonResponse({ error: "job_not_running" }, 409)
      }
      return jsonResponse({ status: "cancelled" })
    }

    if (opts.req.method !== "GET") {
      return jsonResponse({ error: "method_not_allowed" }, 405)
    }
    const job = await opts.supervisor.getJob({
      projectDir: project.project.projectDir,
      jobId
    })
    if (!job) return jsonResponse({ error: "job_not_found" }, 404)
    return jsonResponse({ job })
  }

  if (segments[3] === "shells" && segments[4] && segments[5] === "stream") {
    if (opts.req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "upgrade_required" }, 426)
    }

    const shellId = segments[4]
    const shell = opts.shells.getShell({ shellId })
    if (!shell || (shell.projectId && shell.projectId !== project.registration.id)) {
      return jsonResponse({ error: "shell_not_found" }, 404)
    }
    const upgraded = opts.server.upgrade(opts.req, {
      data: {
        kind: "shell",
        shellId,
        projectDir: project.project.projectDir
      } satisfies ShellStreamState
    })
    if (upgraded) {
      return new Response(null, { status: 101 })
    }
    return jsonResponse({ error: "upgrade_failed" }, 400)
  }

  if (segments[3] === "shells" && segments.length === 4) {
    if (opts.req.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405)
    }

    const body = await readJsonBody(opts.req)
    if (!body) return jsonResponse({ error: "invalid_json" }, 400)

    const payload = parseShellCreateInput(body)
    if (!payload.ok) return jsonResponse({ error: payload.error }, 400)

    const cwd = resolveShellCwd({
      projectRoot: project.project.projectRoot,
      cwd: payload.value.cwd
    })
    if (!cwd) {
      return jsonResponse({ error: "invalid_cwd" }, 400)
    }

    const created = opts.shells.createShell({
      projectRoot: project.project.projectRoot,
      projectId: project.registration.id,
      projectName: project.registration.name,
      cwd,
      ...(payload.value.env ? { env: payload.value.env } : {}),
      ...(payload.value.shell ? { shell: payload.value.shell } : {}),
      ...(payload.value.cols ? { cols: payload.value.cols } : {}),
      ...(payload.value.rows ? { rows: payload.value.rows } : {})
    })

    if (!created.ok) {
      return jsonResponse({ error: "shell_create_failed", message: created.error }, 500)
    }

    return jsonResponse({ shell: created.shell }, 201)
  }

  if (segments[3] === "shells" && segments[4] && segments.length === 5) {
    const shellId = segments[4]
    if (opts.req.method !== "GET") {
      return jsonResponse({ error: "method_not_allowed" }, 405)
    }

    const shell = opts.shells.getShell({ shellId })
    if (!shell || (shell.projectId && shell.projectId !== project.registration.id)) {
      return jsonResponse({ error: "shell_not_found" }, 404)
    }

    return jsonResponse({ shell })
  }

  return jsonResponse({ error: "not_found" }, 404)
}

async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await req.json()
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

type JobCreateInputResult =
  | { readonly ok: true; readonly value: JobCreateInput }
  | { readonly ok: false; readonly error: string }

type JobCreateInput = {
  readonly runner: string
  readonly command: readonly string[]
  readonly cwd?: string
  readonly env?: Record<string, string>
}

function parseJobCreateInput(value: Record<string, unknown>): JobCreateInputResult {
  const runner = typeof value["runner"] === "string" ? value["runner"] : "generic"
  const commandRaw = value["command"]
  const command = Array.isArray(commandRaw) ? commandRaw.filter(item => typeof item === "string") : []
  if (command.length === 0) {
    return { ok: false, error: "missing_command" }
  }

  const cwd = typeof value["cwd"] === "string" ? value["cwd"] : undefined
  const env = parseEnv(value["env"])

  return {
    ok: true,
    value: {
      runner,
      command,
      ...(cwd ? { cwd } : {}),
      ...(env ? { env } : {})
    }
  }
}

type ShellCreateInputResult =
  | { readonly ok: true; readonly value: ShellCreateInput }
  | { readonly ok: false; readonly error: string }

type ShellCreateInput = {
  readonly shell?: string
  readonly cwd?: string
  readonly env?: Record<string, string>
  readonly cols?: number
  readonly rows?: number
}

function parseShellCreateInput(value: Record<string, unknown>): ShellCreateInputResult {
  const shell = typeof value["shell"] === "string" ? value["shell"].trim() : undefined
  const cwd = typeof value["cwd"] === "string" ? value["cwd"] : undefined
  const cols = typeof value["cols"] === "number" && Number.isFinite(value["cols"]) ? value["cols"] : undefined
  const rows = typeof value["rows"] === "number" && Number.isFinite(value["rows"]) ? value["rows"] : undefined
  const env = parseEnv(value["env"])

  if (cols !== undefined && cols <= 0) return { ok: false, error: "invalid_cols" }
  if (rows !== undefined && rows <= 0) return { ok: false, error: "invalid_rows" }

  return {
    ok: true,
    value: {
      ...(shell ? { shell } : {}),
      ...(cwd ? { cwd } : {}),
      ...(env ? { env } : {}),
      ...(cols !== undefined ? { cols } : {}),
      ...(rows !== undefined ? { rows } : {})
    }
  }
}

function parseEnv(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const out: Record<string, string> = {}
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === "string") out[key] = val
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function resolveShellCwd(opts: {
  readonly projectRoot: string
  readonly cwd?: string
}): string | null {
  const raw = (opts.cwd ?? "").trim()
  if (raw.length === 0) return opts.projectRoot
  const resolved = resolve(opts.projectRoot, raw)
  const relativePath = relative(opts.projectRoot, resolved)
  if (relativePath.startsWith("..")) {
    return null
  }
  return resolved
}

type JobStreamState = {
  kind: "job"
  jobId: string
  projectDir: string
  logsOffset?: number
  eventsSeq?: number
  logTimer?: ReturnType<typeof setInterval>
  eventTimer?: ReturnType<typeof setInterval>
  heartbeatTimer?: ReturnType<typeof setInterval>
  connectedAt?: number
}

type ShellStreamState = {
  kind: "shell"
  shellId: string
  projectDir: string
  attachment?: ShellAttachment
  connectedAt?: number
}

type ControlPlaneWsState = JobStreamState | ShellStreamState

type JobStreamHello = {
  readonly type: "hello"
  readonly logsFrom?: number
  readonly eventsFrom?: number
}

type JobStreamMessage = JobStreamHello

function parseWsMessage(opts: { readonly message: string | Uint8Array }): JobStreamMessage | null {
  const text =
    typeof opts.message === "string" ? opts.message : new TextDecoder().decode(opts.message)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const record = parsed as Record<string, unknown>
  if (record["type"] !== "hello") return null
  const logsFrom = typeof record["logsFrom"] === "number" ? record["logsFrom"] : undefined
  const eventsFrom = typeof record["eventsFrom"] === "number" ? record["eventsFrom"] : undefined
  return {
    type: "hello",
    ...(logsFrom !== undefined ? { logsFrom } : {}),
    ...(eventsFrom !== undefined ? { eventsFrom } : {})
  }
}

type ShellClientMessage =
  | { readonly type: "hello"; readonly cols?: number; readonly rows?: number }
  | { readonly type: "input"; readonly data: string }
  | { readonly type: "resize"; readonly cols: number; readonly rows: number }
  | { readonly type: "signal"; readonly signal: NodeJS.Signals }
  | { readonly type: "close" }

type ShellReadyMessage = {
  readonly type: "ready"
  readonly shellId: string
  readonly cols: number
  readonly rows: number
  readonly cwd: string
  readonly shell: string
  readonly status: string
}

function parseShellClientMessage(opts: {
  readonly message: string | Uint8Array
}): ShellClientMessage | null {
  if (typeof opts.message !== "string") {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(opts.message)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const record = parsed as Record<string, unknown>
  const type = record["type"]
  if (type === "hello") {
    const cols = typeof record["cols"] === "number" ? record["cols"] : undefined
    const rows = typeof record["rows"] === "number" ? record["rows"] : undefined
    return { type: "hello", ...(cols !== undefined ? { cols } : {}), ...(rows !== undefined ? { rows } : {}) }
  }
  if (type === "input") {
    const data = record["data"]
    if (typeof data !== "string") return null
    return { type: "input", data }
  }
  if (type === "resize") {
    const cols = record["cols"]
    const rows = record["rows"]
    if (typeof cols !== "number" || typeof rows !== "number") return null
    return { type: "resize", cols, rows }
  }
  if (type === "signal") {
    const signal = record["signal"]
    if (!isShellSignal(signal)) return null
    return { type: "signal", signal }
  }
  if (type === "close") {
    return { type: "close" }
  }
  return null
}

const SHELL_SIGNALS: readonly NodeJS.Signals[] = [
  "SIGINT",
  "SIGTERM",
  "SIGKILL",
  "SIGHUP",
  "SIGQUIT",
  "SIGUSR1",
  "SIGUSR2",
  "SIGTSTP"
]

function isShellSignal(value: unknown): value is NodeJS.Signals {
  return typeof value === "string" && SHELL_SIGNALS.includes(value as NodeJS.Signals)
}

function buildShellReadyMessage(opts: { readonly meta: ShellMeta }): ShellReadyMessage {
  return {
    type: "ready",
    shellId: opts.meta.shellId,
    cols: opts.meta.cols,
    rows: opts.meta.rows,
    cwd: opts.meta.cwd,
    shell: opts.meta.shell,
    status: opts.meta.status
  }
}

async function startJobStream(opts: {
  readonly ws: ServerWebSocket<unknown>
  readonly state: JobStreamState
  readonly logsFrom?: number
  readonly eventsFrom?: number
}): Promise<void> {
  stopJobStream({ state: opts.state })
  opts.state.logsOffset = opts.logsFrom ?? 0
  opts.state.eventsSeq = opts.eventsFrom ?? 0

  const store = await createJobStore({ projectDir: opts.state.projectDir })
  const meta = await store.readJobMeta({ jobId: opts.state.jobId })
  if (!meta) {
    opts.ws.send(JSON.stringify({ type: "error", message: "job_not_found" }))
    opts.ws.close(1008, "job_not_found")
    return
  }

  await sendJobReady(opts)
  await flushLogsOnce(opts)
  await flushEventsOnce(opts)

  opts.state.logTimer = setInterval(() => {
    void flushLogsOnce(opts)
  }, 500)
  opts.state.eventTimer = setInterval(() => {
    void flushEventsOnce(opts)
  }, 500)
  opts.state.heartbeatTimer = setInterval(() => {
    sendJobHeartbeat(opts)
  }, 5000)
}

function stopJobStream(opts: { readonly state: JobStreamState }): void {
  if (opts.state.logTimer) {
    clearInterval(opts.state.logTimer)
    opts.state.logTimer = undefined
  }
  if (opts.state.eventTimer) {
    clearInterval(opts.state.eventTimer)
    opts.state.eventTimer = undefined
  }
  if (opts.state.heartbeatTimer) {
    clearInterval(opts.state.heartbeatTimer)
    opts.state.heartbeatTimer = undefined
  }
}

async function sendJobReady(opts: {
  readonly ws: ServerWebSocket<unknown>
  readonly state: JobStreamState
}): Promise<void> {
  opts.ws.send(
    JSON.stringify({
      type: "ready",
      logsOffset: opts.state.logsOffset ?? 0,
      eventsSeq: opts.state.eventsSeq ?? 0
    })
  )
}

function sendJobHeartbeat(opts: {
  readonly ws: ServerWebSocket<unknown>
  readonly state: JobStreamState
}): void {
  opts.ws.send(
    JSON.stringify({
      type: "heartbeat",
      ts: new Date().toISOString(),
      logsOffset: opts.state.logsOffset ?? 0,
      eventsSeq: opts.state.eventsSeq ?? 0
    })
  )
}

async function flushLogsOnce(opts: {
  readonly ws: ServerWebSocket<unknown>
  readonly state: JobStreamState
  readonly logsFrom?: number
  readonly eventsFrom?: number
}): Promise<void> {
  const store = await createJobStore({ projectDir: opts.state.projectDir })
  const paths = store.getJobPaths({ jobId: opts.state.jobId })
  const offset = opts.state.logsOffset ?? 0
  const chunk = await readFileChunk({ path: paths.combinedPath, offset })
  if (!chunk) return
  opts.state.logsOffset = chunk.nextOffset
  opts.ws.send(
    JSON.stringify({
      type: "log",
      stream: "combined",
      offset: chunk.nextOffset,
      data: chunk.data
    })
  )
}

async function flushEventsOnce(opts: {
  readonly ws: ServerWebSocket<unknown>
  readonly state: JobStreamState
  readonly logsFrom?: number
  readonly eventsFrom?: number
}): Promise<void> {
  const store = await createJobStore({ projectDir: opts.state.projectDir })
  const events = await store.readEvents({ jobId: opts.state.jobId })
  const next = events.filter(event => event.seq > (opts.state.eventsSeq ?? 0))
  for (const event of next) {
    opts.state.eventsSeq = event.seq
    opts.ws.send(
      JSON.stringify({
        type: "event",
        seq: event.seq,
        event
      })
    )
  }
}

async function readFileChunk(opts: {
  readonly path: string
  readonly offset: number
}): Promise<{ readonly data: string; readonly nextOffset: number } | null> {
  try {
    const file = Bun.file(opts.path)
    const stat = await file.stat()
    const size = stat.size
    if (size <= opts.offset) return null
    const slice = file.slice(opts.offset, size)
    const data = await slice.text()
    return { data, nextOffset: size }
  } catch {
    return null
  }
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  const payload = JSON.stringify(body, null, 2)
  return new Response(payload, {
    status,
    headers: {
      "content-type": "application/json",
      "content-length": `${Buffer.byteLength(payload)}`
    }
  })
}

function parseBoolean(opts: { readonly value: string | null }): boolean {
  if (!opts.value) return false
  const normalized = opts.value.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes"
}

function normalizeQueryParam(opts: { readonly value: string | null }): string | null {
  const trimmed = opts.value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : null
}

function isGatewayReadOnlyMethod(opts: { readonly method: string }): boolean {
  const method = opts.method.toUpperCase()
  return method === "GET" || method === "HEAD"
}

function isGatewayShellStreamRequest(opts: { readonly url: URL }): boolean {
  const segments = opts.url.pathname.split("/").filter(Boolean)
  return segments[0] === "control-plane" &&
    segments[1] === "projects" &&
    segments[3] === "shells" &&
    segments[5] === "stream"
}
