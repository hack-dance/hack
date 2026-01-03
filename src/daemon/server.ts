import pkg from "../../package.json"
import { Buffer } from "node:buffer"

import { ensureDir } from "../lib/fs.ts"
import { createDaemonLogger } from "./logger.ts"
import { removeFileIfExists, writeDaemonPid } from "./process.ts"
import { startDockerEventWatcher } from "./docker-events.ts"
import { createRuntimeCache } from "./runtime-cache.ts"

import type { DaemonPaths } from "./paths.ts"

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

  const server = Bun.serve({
    unix: paths.socketPath,
    fetch: req =>
      handleRequest({
        req,
        metrics,
        version: packageJson.version,
        pid: process.pid,
        cache
      })
  })

  const shutdown = async ({ reason }: { readonly reason: string }) => {
    logger.warn({ message: `Shutting down hackd (${reason})` })
    watcher.stop()
    server.stop()
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
  metrics,
  version,
  pid,
  cache
}: {
  readonly req: Request
  readonly metrics: DaemonMetrics
  readonly version: string
  readonly pid: number
  readonly cache: ReturnType<typeof createRuntimeCache>
}): Promise<Response> {
  if (req.method !== "GET") {
    return jsonResponse({ error: "method_not_allowed" }, 405)
  }

  const url = new URL(req.url)
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
