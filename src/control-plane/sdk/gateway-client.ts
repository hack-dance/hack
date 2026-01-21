import { isRecord } from "../../lib/guards.ts"

import type { JobMeta } from "../extensions/supervisor/job-store.ts"
import type { ShellMeta } from "../extensions/supervisor/shell-service.ts"

/**
 * Configuration for `createGatewayClient`.
 */
export type GatewayClientOptions = {
  /** Gateway base URL, e.g. http://127.0.0.1:7788 or https://gateway.example.com */
  readonly baseUrl: string
  /** Gateway token (read or write scope). */
  readonly token: string
  /** Optional request timeout (ms). */
  readonly timeoutMs?: number
}

export type GatewayResponse<T> =
  | { readonly ok: true; readonly status: number; readonly data: T }
  | { readonly ok: false; readonly status: number; readonly error: GatewayError }

export type GatewayError = {
  readonly message: string
  readonly code?: string
  readonly raw?: Record<string, unknown>
}

export type GatewayStatus = {
  readonly status: string
  readonly version: string
  readonly pid: number
  readonly started_at: string
  readonly uptime_ms: number
}

export type GatewayMetrics = {
  readonly status: string
  readonly started_at: string
  readonly uptime_ms: number
  readonly cache_updated_at: string | null
  readonly cache_age_ms: number | null
  readonly last_refresh_at: string | null
  readonly refresh_count: number
  readonly refresh_failures: number
  readonly last_event_at: string | null
  readonly events_seen: number
  readonly streams_active: number
}

export type GatewayProjectsPayload = {
  readonly generated_at: string
  readonly filter: string | null
  readonly include_global: boolean
  readonly include_unregistered: boolean
  readonly projects: readonly Record<string, unknown>[]
}

export type GatewayPsPayload = {
  readonly project: string
  readonly branch: string | null
  readonly composeProject: string
  readonly items: readonly Record<string, unknown>[]
}

export type GatewayJobListResponse = {
  readonly jobs: readonly JobMeta[]
}

export type GatewayJobResponse = {
  readonly job: JobMeta
}

export type GatewayCancelResponse = {
  readonly status: string
}

export type GatewayShellResponse = {
  readonly shell: ShellMeta
}

/**
 * Gateway client helpers for HTTP + WS endpoints.
 */
export type GatewayClient = {
  /** Fetch gateway status. */
  getStatus: () => Promise<GatewayResponse<GatewayStatus>>
  /** Fetch gateway metrics snapshot. */
  getMetrics: () => Promise<GatewayResponse<GatewayMetrics>>
  /**
   * List projects known to the gateway cache.
   *
   * @param opts.filter - Optional project name filter.
   * @param opts.includeGlobal - Include global runtime entries.
   * @param opts.includeUnregistered - Include unregistered runtime projects.
   */
  getProjects: (opts?: {
    readonly filter?: string
    readonly includeGlobal?: boolean
    readonly includeUnregistered?: boolean
  }) => Promise<GatewayResponse<GatewayProjectsPayload>>
  /**
   * List running containers for a compose project.
   *
   * @param opts.composeProject - Compose project id (required).
   * @param opts.project - Optional display project name.
   * @param opts.branch - Optional branch name.
   */
  getPs: (opts: {
    readonly composeProject: string
    readonly project?: string
    readonly branch?: string
  }) => Promise<GatewayResponse<GatewayPsPayload>>
  /**
   * List supervisor jobs for a project.
   *
   * @param opts.projectId - Registered project id.
   */
  listJobs: (opts: { readonly projectId: string }) => Promise<GatewayResponse<GatewayJobListResponse>>
  /**
   * Fetch a single job by id.
   *
   * @param opts.projectId - Registered project id.
   * @param opts.jobId - Job id.
   */
  getJob: (opts: { readonly projectId: string; readonly jobId: string }) => Promise<GatewayResponse<GatewayJobResponse>>
  /**
   * Create a new supervisor job (write token + allowWrites required).
   *
   * @param opts.projectId - Registered project id.
   * @param opts.runner - Optional runner name.
   * @param opts.command - Command argv.
   * @param opts.cwd - Optional working directory.
   * @param opts.env - Optional environment overrides.
   */
  createJob: (opts: {
    readonly projectId: string
    readonly runner?: string
    readonly command: readonly string[]
    readonly cwd?: string
    readonly env?: Record<string, string>
  }) => Promise<GatewayResponse<GatewayJobResponse>>
  /**
   * Cancel a running job (write token + allowWrites required).
   *
   * @param opts.projectId - Registered project id.
   * @param opts.jobId - Job id.
   */
  cancelJob: (opts: { readonly projectId: string; readonly jobId: string }) => Promise<GatewayResponse<GatewayCancelResponse>>
  /**
   * Create a PTY-backed shell (write token + allowWrites required).
   *
   * @param opts.projectId - Registered project id.
   * @param opts.shell - Optional shell path.
   * @param opts.cwd - Optional working directory.
   * @param opts.env - Optional environment overrides.
   * @param opts.cols - Initial columns.
   * @param opts.rows - Initial rows.
   */
  createShell: (opts: {
    readonly projectId: string
    readonly shell?: string
    readonly cwd?: string
    readonly env?: Record<string, string>
    readonly cols?: number
    readonly rows?: number
  }) => Promise<GatewayResponse<GatewayShellResponse>>
  /**
   * Fetch a shell metadata record by id.
   *
   * @param opts.projectId - Registered project id.
   * @param opts.shellId - Shell id.
   */
  getShell: (opts: { readonly projectId: string; readonly shellId: string }) => Promise<GatewayResponse<GatewayShellResponse>>
  /**
   * Open a WebSocket stream for job logs/events.
   *
   * @param opts.projectId - Registered project id.
   * @param opts.jobId - Job id.
   */
  openJobStream: (opts: {
    readonly projectId: string
    readonly jobId: string
  }) => WebSocket
  /**
   * Open a WebSocket stream for an interactive shell.
   *
   * @param opts.projectId - Registered project id.
   * @param opts.shellId - Shell id.
   */
  openShellStream: (opts: {
    readonly projectId: string
    readonly shellId: string
  }) => WebSocket
}

/**
 * Create a Gateway client for orchestrating jobs and shells over HTTP/WS.
 *
 * @param opts.baseUrl - Gateway base URL (e.g. http://127.0.0.1:7788).
 * @param opts.token - Gateway token (read or write scoped).
 * @param opts.timeoutMs - Optional request timeout.
 * @returns Gateway client helpers.
 */
export function createGatewayClient(opts: GatewayClientOptions): GatewayClient {
  const baseUrl = normalizeBaseUrl({ value: opts.baseUrl })
  const token = opts.token
  const timeoutMs = opts.timeoutMs ?? 5_000

  const requestJson = async <T>(input: {
    readonly method: "GET" | "POST"
    readonly path: string
    readonly query?: Record<string, string | boolean | null>
    readonly body?: Record<string, unknown>
    readonly parse: (value: unknown) => T | null
  }): Promise<GatewayResponse<T>> => {
    const url = buildUrl({ baseUrl, path: input.path, query: input.query })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    const payload =
      input.body && input.method !== "GET" ? JSON.stringify(input.body) : undefined

    try {
      const res = await fetch(url, {
        method: input.method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload ? { "content-type": "application/json" } : {})
        },
        ...(payload ? { body: payload } : {}),
        signal: controller.signal
      })
      const text = await res.text()
      const parsed = safeJsonParse({ text })
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          error: parseGatewayError({ fallback: `HTTP ${res.status}`, body: parsed })
        }
      }

      const data = input.parse(parsed)
      if (!data) {
        return {
          ok: false,
          status: res.status,
          error: { message: "invalid_response", raw: isRecord(parsed) ? parsed : undefined }
        }
      }
      return { ok: true, status: res.status, data }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "request_failed"
      return {
        ok: false,
        status: 0,
        error: { message }
      }
    } finally {
      clearTimeout(timer)
    }
  }

  const getStatus = async (): Promise<GatewayResponse<GatewayStatus>> =>
    await requestJson({ method: "GET", path: "/v1/status", parse: parseStatus })

  const getMetrics = async (): Promise<GatewayResponse<GatewayMetrics>> =>
    await requestJson({ method: "GET", path: "/v1/metrics", parse: parseMetrics })

  const getProjects = async (opts?: {
    readonly filter?: string
    readonly includeGlobal?: boolean
    readonly includeUnregistered?: boolean
  }): Promise<GatewayResponse<GatewayProjectsPayload>> =>
    await requestJson({
      method: "GET",
      path: "/v1/projects",
      query: {
        ...(opts?.filter ? { filter: opts.filter } : {}),
        ...(opts?.includeGlobal !== undefined ? { include_global: opts.includeGlobal } : {}),
        ...(opts?.includeUnregistered !== undefined
          ? { include_unregistered: opts.includeUnregistered }
          : {})
      },
      parse: parseProjects
    })

  const getPs = async (opts: {
    readonly composeProject: string
    readonly project?: string
    readonly branch?: string
  }): Promise<GatewayResponse<GatewayPsPayload>> =>
    await requestJson({
      method: "GET",
      path: "/v1/ps",
      query: {
        compose_project: opts.composeProject,
        ...(opts.project ? { project: opts.project } : {}),
        ...(opts.branch ? { branch: opts.branch } : {})
      },
      parse: parsePs
    })

  const listJobs = async (opts: {
    readonly projectId: string
  }): Promise<GatewayResponse<GatewayJobListResponse>> =>
    await requestJson({
      method: "GET",
      path: `/control-plane/projects/${opts.projectId}/jobs`,
      parse: parseJobList
    })

  const getJob = async (opts: {
    readonly projectId: string
    readonly jobId: string
  }): Promise<GatewayResponse<GatewayJobResponse>> =>
    await requestJson({
      method: "GET",
      path: `/control-plane/projects/${opts.projectId}/jobs/${opts.jobId}`,
      parse: parseJob
    })

  const createJob = async (opts: {
    readonly projectId: string
    readonly runner?: string
    readonly command: readonly string[]
    readonly cwd?: string
    readonly env?: Record<string, string>
  }): Promise<GatewayResponse<GatewayJobResponse>> =>
    await requestJson({
      method: "POST",
      path: `/control-plane/projects/${opts.projectId}/jobs`,
      body: {
        runner: opts.runner ?? "generic",
        command: opts.command,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.env ? { env: opts.env } : {})
      },
      parse: parseJob
    })

  const cancelJob = async (opts: {
    readonly projectId: string
    readonly jobId: string
  }): Promise<GatewayResponse<GatewayCancelResponse>> =>
    await requestJson({
      method: "POST",
      path: `/control-plane/projects/${opts.projectId}/jobs/${opts.jobId}/cancel`,
      parse: parseCancel
    })

  const createShell = async (opts: {
    readonly projectId: string
    readonly shell?: string
    readonly cwd?: string
    readonly env?: Record<string, string>
    readonly cols?: number
    readonly rows?: number
  }): Promise<GatewayResponse<GatewayShellResponse>> =>
    await requestJson({
      method: "POST",
      path: `/control-plane/projects/${opts.projectId}/shells`,
      body: {
        ...(opts.shell ? { shell: opts.shell } : {}),
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.cols !== undefined ? { cols: opts.cols } : {}),
        ...(opts.rows !== undefined ? { rows: opts.rows } : {})
      },
      parse: parseShell
    })

  const getShell = async (opts: {
    readonly projectId: string
    readonly shellId: string
  }): Promise<GatewayResponse<GatewayShellResponse>> =>
    await requestJson({
      method: "GET",
      path: `/control-plane/projects/${opts.projectId}/shells/${opts.shellId}`,
      parse: parseShell
    })

  const openJobStream = (opts: { readonly projectId: string; readonly jobId: string }): WebSocket => {
    const url = buildWebSocketUrl({
      baseUrl,
      path: `/control-plane/projects/${opts.projectId}/jobs/${opts.jobId}/stream`,
      token
    })
    return new WebSocket(url)
  }

  const openShellStream = (opts: {
    readonly projectId: string
    readonly shellId: string
  }): WebSocket => {
    const url = buildWebSocketUrl({
      baseUrl,
      path: `/control-plane/projects/${opts.projectId}/shells/${opts.shellId}/stream`,
      token
    })
    return new WebSocket(url)
  }

  return {
    getStatus,
    getMetrics,
    getProjects,
    getPs,
    listJobs,
    getJob,
    createJob,
    cancelJob,
    createShell,
    getShell,
    openJobStream,
    openShellStream
  }
}

function normalizeBaseUrl(opts: { readonly value: string }): string {
  const trimmed = opts.value.trim()
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed
}

function buildUrl(opts: {
  readonly baseUrl: string
  readonly path: string
  readonly query?: Record<string, string | boolean | null>
}): URL {
  const url = new URL(opts.path, opts.baseUrl)
  if (opts.query) {
    for (const [key, value] of Object.entries(opts.query)) {
      if (value === null) continue
      if (typeof value === "boolean") {
        url.searchParams.set(key, value ? "true" : "false")
      } else {
        url.searchParams.set(key, value)
      }
    }
  }
  return url
}

function buildWebSocketUrl(opts: {
  readonly baseUrl: string
  readonly path: string
  readonly token?: string
}): string {
  const url = new URL(opts.path, opts.baseUrl)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  if (opts.token) {
    url.searchParams.set("token", opts.token)
  }
  return url.toString()
}

function safeJsonParse(opts: { readonly text: string }): unknown {
  const trimmed = opts.text.trim()
  if (trimmed.length === 0) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

function parseGatewayError(opts: {
  readonly fallback: string
  readonly body: unknown
}): GatewayError {
  if (!isRecord(opts.body)) {
    return { message: opts.fallback }
  }
  const code = typeof opts.body["error"] === "string" ? opts.body["error"] : undefined
  const message = typeof opts.body["message"] === "string" ? opts.body["message"] : opts.fallback
  return { message, ...(code ? { code } : {}), raw: opts.body }
}

function parseStatus(value: unknown): GatewayStatus | null {
  if (!isRecord(value)) return null
  if (typeof value["status"] !== "string" || typeof value["version"] !== "string") return null
  return value as GatewayStatus
}

function parseMetrics(value: unknown): GatewayMetrics | null {
  if (!isRecord(value)) return null
  if (typeof value["status"] !== "string") return null
  return value as GatewayMetrics
}

function parseProjects(value: unknown): GatewayProjectsPayload | null {
  if (!isRecord(value)) return null
  if (!Array.isArray(value["projects"])) return null
  return value as GatewayProjectsPayload
}

function parsePs(value: unknown): GatewayPsPayload | null {
  if (!isRecord(value)) return null
  if (!Array.isArray(value["items"])) return null
  return value as GatewayPsPayload
}

function parseJobList(value: unknown): GatewayJobListResponse | null {
  if (!isRecord(value)) return null
  if (!Array.isArray(value["jobs"])) return null
  return value as GatewayJobListResponse
}

function parseJob(value: unknown): GatewayJobResponse | null {
  if (!isRecord(value)) return null
  if (!isRecord(value["job"]) || typeof value["job"]["jobId"] !== "string") return null
  return value as GatewayJobResponse
}

function parseCancel(value: unknown): GatewayCancelResponse | null {
  if (!isRecord(value)) return null
  if (typeof value["status"] !== "string") return null
  return value as GatewayCancelResponse
}

function parseShell(value: unknown): GatewayShellResponse | null {
  if (!isRecord(value)) return null
  if (!isRecord(value["shell"]) || typeof value["shell"]["shellId"] !== "string") return null
  return value as GatewayShellResponse
}
