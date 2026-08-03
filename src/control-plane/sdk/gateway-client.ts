import { isRecord } from "../../lib/guards.ts";

import type { JobMeta } from "../extensions/supervisor/job-store.ts";
import type { ShellMeta } from "../extensions/supervisor/shell-service.ts";

/**
 * Configuration for `createGatewayClient`.
 */
export type GatewayClientOptions = {
  /** Gateway base URL, e.g. http://127.0.0.1:7788 or https://gateway.example.com */
  readonly baseUrl: string;
  /** Gateway token (read or write scope). */
  readonly token: string;
  /** Optional request timeout (ms). */
  readonly timeoutMs?: number;
};

export type GatewayResponse<T> =
  | { readonly ok: true; readonly status: number; readonly data: T }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: GatewayError;
    };

export type GatewayError = {
  readonly message: string;
  readonly code?: string;
  readonly raw?: Record<string, unknown>;
};

export type GatewayStatus = {
  readonly status: string;
  readonly version: string;
  readonly pid: number;
  readonly started_at: string;
  readonly uptime_ms: number;
};

export type GatewayMetrics = {
  readonly status: string;
  readonly started_at: string;
  readonly uptime_ms: number;
  readonly cache_updated_at: string | null;
  readonly cache_age_ms: number | null;
  readonly last_refresh_at: string | null;
  readonly refresh_count: number;
  readonly refresh_requests: number;
  readonly refresh_requests_coalesced: number;
  readonly refresh_failures: number;
  readonly refresh_in_flight: boolean;
  readonly last_refresh_duration_ms: number | null;
  readonly max_refresh_duration_ms: number | null;
  readonly last_event_at: string | null;
  readonly events_seen: number;
  readonly events_relevant: number;
  readonly events_ignored: number;
  readonly inspect_calls: number;
  readonly inspect_ids: number;
  readonly inspect_cache_hits: number;
  readonly inspect_cache_misses: number;
  readonly inspect_full_refreshes: number;
  readonly streams_active: number;
};

export type GatewayProjectsPayload = {
  readonly generated_at: string;
  readonly filter: string | null;
  readonly include_global: boolean;
  readonly include_unregistered: boolean;
  readonly projects: readonly Record<string, unknown>[];
};

export type GatewayPsPayload = {
  readonly project: string;
  readonly branch: string | null;
  readonly composeProject: string;
  readonly items: readonly Record<string, unknown>[];
};

export type GatewayJobListResponse = {
  readonly jobs: readonly JobMeta[];
};

export type GatewayJobResponse = {
  readonly job: JobMeta;
};

export type GatewayCancelResponse = {
  readonly status: string;
};

export type GatewayShellResponse = {
  readonly shell: ShellMeta;
};

export type GatewayNodeStatus = {
  readonly status: string;
  readonly version: string;
  readonly pid: number;
  readonly started_at: string;
  readonly uptime_ms: number;
  readonly node: {
    readonly name: string;
    readonly platform: string;
    readonly arch: string;
    readonly bun: string;
  };
  readonly gateway: {
    readonly enabled: boolean;
    readonly bind: string;
    readonly port: number;
    readonly allowWrites: boolean;
    readonly projects: readonly {
      readonly project_id: string;
      readonly project_name: string;
    }[];
  };
  readonly supervisor: {
    readonly enabled: boolean;
    readonly maxConcurrentJobs: number;
  };
  readonly devcontainers: {
    readonly running: number;
    readonly sessions: readonly {
      readonly id: string;
      readonly project_id: string;
      readonly project_name: string;
      readonly branch: string | null;
      readonly created_at: string;
    }[];
  };
};

export type GatewayNodeWorkspace = {
  readonly projectId: string;
  readonly projectName: string;
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly branch: string | null;
};

export type GatewayNodeBootstrapAuthSource = "native_git";

export type GatewayNodeWorkspaceBootstrap = {
  readonly repoUrl: string;
  readonly projectName?: string;
  readonly projectRoot?: string;
};

export type GatewayNodeWorkspaceResponse = {
  readonly workspace: GatewayNodeWorkspace;
  readonly bootstrapAuthSource?: GatewayNodeBootstrapAuthSource;
};

type GatewayEnsureNodeWorkspaceRequest = {
  readonly project?: string;
  readonly project_id?: string;
  readonly controller_project_id?: string;
  readonly controller_project_name?: string;
  readonly path?: string;
  readonly branch?: string;
  readonly bootstrap?: {
    readonly repo_url: string;
    readonly project_name?: string;
    readonly project_root?: string;
  };
};

export type GatewayNodeGitProbeResponse = {
  readonly repoUrl: string;
  readonly ok: boolean;
  readonly authSource: GatewayNodeBootstrapAuthSource | "none";
  readonly error?: string;
};

export type GatewayNodeDevcontainerSession = {
  readonly id: string;
  readonly workspace: GatewayNodeWorkspace;
  readonly createdAt: string;
  readonly containerId: string | null;
  readonly output: string;
  readonly status: "running" | "stopped" | "failed";
  readonly updatedAt: string;
};

export type GatewayNodeDevcontainerResponse = {
  readonly session: GatewayNodeDevcontainerSession;
};

/**
 * Gateway client helpers for HTTP + WS endpoints.
 */
export type GatewayClient = {
  /** Fetch gateway status. */
  getStatus: () => Promise<GatewayResponse<GatewayStatus>>;
  /** Fetch gateway metrics snapshot. */
  getMetrics: () => Promise<GatewayResponse<GatewayMetrics>>;
  /** Fetch node status metadata from a node gateway. */
  getNodeStatus: () => Promise<GatewayResponse<GatewayNodeStatus>>;
  /**
   * List projects known to the gateway cache.
   *
   * @param opts.filter - Optional project name filter.
   * @param opts.includeGlobal - Include global runtime entries.
   * @param opts.includeUnregistered - Include unregistered runtime projects.
   */
  getProjects: (opts?: {
    readonly filter?: string;
    readonly includeGlobal?: boolean;
    readonly includeUnregistered?: boolean;
  }) => Promise<GatewayResponse<GatewayProjectsPayload>>;
  /**
   * List running containers for a compose project.
   *
   * @param opts.composeProject - Compose project id (required).
   * @param opts.project - Optional display project name.
   * @param opts.branch - Optional branch name.
   */
  getPs: (opts: {
    readonly composeProject: string;
    readonly project?: string;
    readonly branch?: string;
  }) => Promise<GatewayResponse<GatewayPsPayload>>;
  /**
   * List supervisor jobs for a project.
   *
   * @param opts.projectId - Registered project id.
   */
  listJobs: (opts: {
    readonly projectId: string;
  }) => Promise<GatewayResponse<GatewayJobListResponse>>;
  /**
   * Fetch a single job by id.
   *
   * @param opts.projectId - Registered project id.
   * @param opts.jobId - Job id.
   */
  getJob: (opts: {
    readonly projectId: string;
    readonly jobId: string;
  }) => Promise<GatewayResponse<GatewayJobResponse>>;
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
    readonly projectId: string;
    readonly runner?: string;
    readonly command: readonly string[];
    readonly cwd?: string;
    readonly env?: Record<string, string>;
  }) => Promise<GatewayResponse<GatewayJobResponse>>;
  /**
   * Cancel a running job (write token + allowWrites required).
   *
   * @param opts.projectId - Registered project id.
   * @param opts.jobId - Job id.
   */
  cancelJob: (opts: {
    readonly projectId: string;
    readonly jobId: string;
  }) => Promise<GatewayResponse<GatewayCancelResponse>>;
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
    readonly projectId: string;
    readonly shell?: string;
    readonly cwd?: string;
    readonly env?: Record<string, string>;
    readonly cols?: number;
    readonly rows?: number;
  }) => Promise<GatewayResponse<GatewayShellResponse>>;
  /**
   * Fetch a shell metadata record by id.
   *
   * @param opts.projectId - Registered project id.
   * @param opts.shellId - Shell id.
   */
  getShell: (opts: {
    readonly projectId: string;
    readonly shellId: string;
  }) => Promise<GatewayResponse<GatewayShellResponse>>;
  /**
   * Ensure a node workspace exists and branch is ready.
   *
   * @param opts.project - Optional project name selector.
   * @param opts.projectId - Optional node-local project id selector.
   * @param opts.path - Optional absolute path selector.
   * @param opts.branch - Optional target branch to checkout/create.
   */
  ensureNodeWorkspace: (opts: {
    readonly project?: string;
    readonly projectId?: string;
    readonly controllerProjectId?: string;
    readonly controllerProjectName?: string;
    readonly path?: string;
    readonly branch?: string;
    readonly bootstrap?: GatewayNodeWorkspaceBootstrap;
  }) => Promise<GatewayResponse<GatewayNodeWorkspaceResponse>>;
  /**
   * Probe node-side Git credential reachability for a repo without mutating workspace state.
   */
  probeNodeGitAccess: (opts: {
    readonly repoUrl: string;
  }) => Promise<GatewayResponse<GatewayNodeGitProbeResponse>>;
  /**
   * Start devcontainer for a node workspace.
   */
  devcontainerUp: (opts: {
    readonly project?: string;
    readonly projectId?: string;
    readonly path?: string;
    readonly branch?: string;
  }) => Promise<GatewayResponse<GatewayNodeDevcontainerResponse>>;
  /**
   * Stop devcontainer by session id.
   */
  devcontainerDown: (opts: {
    readonly id: string;
  }) => Promise<GatewayResponse<GatewayNodeDevcontainerResponse>>;
  /**
   * Fetch devcontainer session state by id.
   */
  getDevcontainer: (opts: {
    readonly id: string;
  }) => Promise<GatewayResponse<GatewayNodeDevcontainerResponse>>;
  /**
   * Open a WebSocket stream for job logs/events.
   *
   * @param opts.projectId - Registered project id.
   * @param opts.jobId - Job id.
   */
  openJobStream: (opts: {
    readonly projectId: string;
    readonly jobId: string;
  }) => WebSocket;
  /**
   * Open a WebSocket stream for an interactive shell.
   *
   * @param opts.projectId - Registered project id.
   * @param opts.shellId - Shell id.
   */
  openShellStream: (opts: {
    readonly projectId: string;
    readonly shellId: string;
  }) => WebSocket;
};

/**
 * Create a Gateway client for orchestrating jobs and shells over HTTP/WS.
 *
 * @param opts.baseUrl - Gateway base URL (e.g. http://127.0.0.1:7788).
 * @param opts.token - Gateway token (read or write scoped).
 * @param opts.timeoutMs - Optional request timeout.
 * @returns Gateway client helpers.
 */
export function createGatewayClient(opts: GatewayClientOptions): GatewayClient {
  const baseUrl = normalizeBaseUrl({ value: opts.baseUrl });
  const token = opts.token;
  const timeoutMs = opts.timeoutMs ?? 5000;

  const requestJson = async <T>(input: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly query?: Record<string, string | boolean | null>;
    readonly body?: Record<string, unknown>;
    readonly parse: (value: unknown) => T | null;
  }): Promise<GatewayResponse<T>> => {
    const url = buildUrl({ baseUrl, path: input.path, query: input.query });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const payload =
      input.body && input.method !== "GET"
        ? JSON.stringify(input.body)
        : undefined;

    try {
      const res = await fetch(url, {
        method: input.method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload ? { "content-type": "application/json" } : {}),
        },
        ...(payload ? { body: payload } : {}),
        signal: controller.signal,
      });
      const text = await res.text();
      const parsed = safeJsonParse({ text });
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          error: parseGatewayError({
            fallback: `HTTP ${res.status}`,
            body: parsed,
          }),
        };
      }

      const data = input.parse(parsed);
      if (!data) {
        return {
          ok: false,
          status: res.status,
          error: {
            message: "invalid_response",
            raw: isRecord(parsed) ? parsed : undefined,
          },
        };
      }
      return { ok: true, status: res.status, data };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "request_failed";
      return {
        ok: false,
        status: 0,
        error: { message },
      };
    } finally {
      clearTimeout(timer);
    }
  };

  const getStatus = async (): Promise<GatewayResponse<GatewayStatus>> =>
    await requestJson({
      method: "GET",
      path: "/v1/status",
      parse: parseStatus,
    });

  const getMetrics = async (): Promise<GatewayResponse<GatewayMetrics>> =>
    await requestJson({
      method: "GET",
      path: "/v1/metrics",
      parse: parseMetrics,
    });

  const getNodeStatus = async (): Promise<GatewayResponse<GatewayNodeStatus>> =>
    await requestJson({
      method: "GET",
      path: "/v1/node/status",
      parse: parseNodeStatus,
    });

  const getProjects = async (opts?: {
    readonly filter?: string;
    readonly includeGlobal?: boolean;
    readonly includeUnregistered?: boolean;
  }): Promise<GatewayResponse<GatewayProjectsPayload>> =>
    await requestJson({
      method: "GET",
      path: "/v1/projects",
      query: {
        ...(opts?.filter ? { filter: opts.filter } : {}),
        ...(opts?.includeGlobal !== undefined
          ? { include_global: opts.includeGlobal }
          : {}),
        ...(opts?.includeUnregistered !== undefined
          ? { include_unregistered: opts.includeUnregistered }
          : {}),
      },
      parse: parseProjects,
    });

  const getPs = async (opts: {
    readonly composeProject: string;
    readonly project?: string;
    readonly branch?: string;
  }): Promise<GatewayResponse<GatewayPsPayload>> =>
    await requestJson({
      method: "GET",
      path: "/v1/ps",
      query: {
        compose_project: opts.composeProject,
        ...(opts.project ? { project: opts.project } : {}),
        ...(opts.branch ? { branch: opts.branch } : {}),
      },
      parse: parsePs,
    });

  const listJobs = async (opts: {
    readonly projectId: string;
  }): Promise<GatewayResponse<GatewayJobListResponse>> =>
    await requestJson({
      method: "GET",
      path: `/control-plane/projects/${encodeRouteSegment(opts.projectId)}/jobs`,
      parse: parseJobList,
    });

  const getJob = async (opts: {
    readonly projectId: string;
    readonly jobId: string;
  }): Promise<GatewayResponse<GatewayJobResponse>> =>
    await requestJson({
      method: "GET",
      path: `/control-plane/projects/${encodeRouteSegment(opts.projectId)}/jobs/${encodeRouteSegment(opts.jobId)}`,
      parse: parseJob,
    });

  const createJob = async (opts: {
    readonly projectId: string;
    readonly runner?: string;
    readonly command: readonly string[];
    readonly cwd?: string;
    readonly env?: Record<string, string>;
  }): Promise<GatewayResponse<GatewayJobResponse>> =>
    await requestJson({
      method: "POST",
      path: `/control-plane/projects/${encodeRouteSegment(opts.projectId)}/jobs`,
      body: {
        runner: opts.runner ?? "generic",
        command: opts.command,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.env ? { env: opts.env } : {}),
      },
      parse: parseJob,
    });

  const cancelJob = async (opts: {
    readonly projectId: string;
    readonly jobId: string;
  }): Promise<GatewayResponse<GatewayCancelResponse>> =>
    await requestJson({
      method: "POST",
      path: `/control-plane/projects/${encodeRouteSegment(opts.projectId)}/jobs/${encodeRouteSegment(opts.jobId)}/cancel`,
      parse: parseCancel,
    });

  const createShell = async (opts: {
    readonly projectId: string;
    readonly shell?: string;
    readonly cwd?: string;
    readonly env?: Record<string, string>;
    readonly cols?: number;
    readonly rows?: number;
  }): Promise<GatewayResponse<GatewayShellResponse>> =>
    await requestJson({
      method: "POST",
      path: `/control-plane/projects/${encodeRouteSegment(opts.projectId)}/shells`,
      body: {
        ...(opts.shell ? { shell: opts.shell } : {}),
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.cols !== undefined ? { cols: opts.cols } : {}),
        ...(opts.rows !== undefined ? { rows: opts.rows } : {}),
      },
      parse: parseShell,
    });

  const getShell = async (opts: {
    readonly projectId: string;
    readonly shellId: string;
  }): Promise<GatewayResponse<GatewayShellResponse>> =>
    await requestJson({
      method: "GET",
      path: `/control-plane/projects/${encodeRouteSegment(opts.projectId)}/shells/${encodeRouteSegment(opts.shellId)}`,
      parse: parseShell,
    });

  const ensureNodeWorkspace = async (opts: {
    readonly project?: string;
    readonly projectId?: string;
    readonly controllerProjectId?: string;
    readonly controllerProjectName?: string;
    readonly path?: string;
    readonly branch?: string;
    readonly bootstrap?: GatewayNodeWorkspaceBootstrap;
  }): Promise<GatewayResponse<GatewayNodeWorkspaceResponse>> =>
    await requestJson({
      method: "POST",
      path: "/v1/node/workspaces/ensure",
      body: buildEnsureNodeWorkspaceBody(opts),
      parse: parseWorkspaceEnsure,
    });

  const probeNodeGitAccess = async (opts: {
    readonly repoUrl: string;
  }): Promise<GatewayResponse<GatewayNodeGitProbeResponse>> =>
    await requestJson({
      method: "POST",
      path: "/v1/node/git/probe",
      body: {
        repo_url: opts.repoUrl,
      },
      parse: parseNodeGitProbe,
    });

  const devcontainerUp = async (opts: {
    readonly project?: string;
    readonly projectId?: string;
    readonly path?: string;
    readonly branch?: string;
  }): Promise<GatewayResponse<GatewayNodeDevcontainerResponse>> =>
    await requestJson({
      method: "POST",
      path: "/v1/node/devcontainers/up",
      body: {
        ...(opts.project ? { project: opts.project } : {}),
        ...(opts.projectId ? { project_id: opts.projectId } : {}),
        ...(opts.path ? { path: opts.path } : {}),
        ...(opts.branch ? { branch: opts.branch } : {}),
      },
      parse: parseNodeDevcontainer,
    });

  const devcontainerDown = async (opts: {
    readonly id: string;
  }): Promise<GatewayResponse<GatewayNodeDevcontainerResponse>> =>
    await requestJson({
      method: "POST",
      path: "/v1/node/devcontainers/down",
      body: { id: opts.id },
      parse: parseNodeDevcontainer,
    });

  const getDevcontainer = async (opts: {
    readonly id: string;
  }): Promise<GatewayResponse<GatewayNodeDevcontainerResponse>> =>
    await requestJson({
      method: "GET",
      path: `/v1/node/devcontainers/${opts.id}`,
      parse: parseNodeDevcontainer,
    });

  const openJobStream = (opts: {
    readonly projectId: string;
    readonly jobId: string;
  }): WebSocket => {
    const url = buildWebSocketUrl({
      baseUrl,
      path: `/control-plane/projects/${encodeRouteSegment(opts.projectId)}/jobs/${encodeRouteSegment(opts.jobId)}/stream`,
      token,
    });
    return new WebSocket(url);
  };

  const openShellStream = (opts: {
    readonly projectId: string;
    readonly shellId: string;
  }): WebSocket => {
    const url = buildWebSocketUrl({
      baseUrl,
      path: `/control-plane/projects/${encodeRouteSegment(opts.projectId)}/shells/${encodeRouteSegment(opts.shellId)}/stream`,
      token,
    });
    return new WebSocket(url);
  };

  return {
    getStatus,
    getMetrics,
    getNodeStatus,
    getProjects,
    getPs,
    listJobs,
    getJob,
    createJob,
    cancelJob,
    createShell,
    getShell,
    ensureNodeWorkspace,
    probeNodeGitAccess,
    devcontainerUp,
    devcontainerDown,
    getDevcontainer,
    openJobStream,
    openShellStream,
  };
}

function buildEnsureNodeWorkspaceBody(opts: {
  readonly project?: string;
  readonly projectId?: string;
  readonly controllerProjectId?: string;
  readonly controllerProjectName?: string;
  readonly path?: string;
  readonly branch?: string;
  readonly bootstrap?: GatewayNodeWorkspaceBootstrap;
}): GatewayEnsureNodeWorkspaceRequest {
  return {
    ...(opts.project ? { project: opts.project } : {}),
    ...(opts.projectId ? { project_id: opts.projectId } : {}),
    ...(opts.controllerProjectId
      ? { controller_project_id: opts.controllerProjectId }
      : {}),
    ...(opts.controllerProjectName
      ? { controller_project_name: opts.controllerProjectName }
      : {}),
    ...(opts.path ? { path: opts.path } : {}),
    ...(opts.branch ? { branch: opts.branch } : {}),
    ...(opts.bootstrap
      ? { bootstrap: buildGatewayWorkspaceBootstrap(opts.bootstrap) }
      : {}),
  };
}

function buildGatewayWorkspaceBootstrap(
  bootstrap: GatewayNodeWorkspaceBootstrap
): GatewayEnsureNodeWorkspaceRequest["bootstrap"] {
  return {
    repo_url: bootstrap.repoUrl,
    ...(bootstrap.projectName ? { project_name: bootstrap.projectName } : {}),
    ...(bootstrap.projectRoot ? { project_root: bootstrap.projectRoot } : {}),
  };
}

function normalizeBaseUrl(opts: { readonly value: string }): string {
  const trimmed = opts.value.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function buildUrl(opts: {
  readonly baseUrl: string;
  readonly path: string;
  readonly query?: Record<string, string | boolean | null>;
}): URL {
  const url = new URL(opts.path, opts.baseUrl);
  if (opts.query) {
    for (const [key, value] of Object.entries(opts.query)) {
      if (value === null) {
        continue;
      }
      if (typeof value === "boolean") {
        url.searchParams.set(key, value ? "true" : "false");
      } else {
        url.searchParams.set(key, value);
      }
    }
  }
  return url;
}

function buildWebSocketUrl(opts: {
  readonly baseUrl: string;
  readonly path: string;
  readonly token?: string;
}): string {
  const url = new URL(opts.path, opts.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (opts.token) {
    url.searchParams.set("token", opts.token);
  }
  return url.toString();
}

function encodeRouteSegment(value: string): string {
  return encodeURIComponent(value);
}

function safeJsonParse(opts: { readonly text: string }): unknown {
  const trimmed = opts.text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function parseGatewayError(opts: {
  readonly fallback: string;
  readonly body: unknown;
}): GatewayError {
  if (!isRecord(opts.body)) {
    return { message: opts.fallback };
  }
  const code =
    typeof opts.body.error === "string" ? opts.body.error : undefined;
  const errorMessage =
    typeof opts.body.error === "string" ? opts.body.error : undefined;
  const message =
    typeof opts.body.message === "string"
      ? opts.body.message
      : (errorMessage ?? opts.fallback);
  return { message, ...(code ? { code } : {}), raw: opts.body };
}

function parseStatus(value: unknown): GatewayStatus | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.status !== "string" || typeof value.version !== "string") {
    return null;
  }
  return value as GatewayStatus;
}

function parseMetrics(value: unknown): GatewayMetrics | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.status !== "string") {
    return null;
  }
  return value as GatewayMetrics;
}

function parseProjects(value: unknown): GatewayProjectsPayload | null {
  if (!isRecord(value)) {
    return null;
  }
  if (!Array.isArray(value.projects)) {
    return null;
  }
  return value as GatewayProjectsPayload;
}

function parsePs(value: unknown): GatewayPsPayload | null {
  if (!isRecord(value)) {
    return null;
  }
  if (!Array.isArray(value.items)) {
    return null;
  }
  return value as GatewayPsPayload;
}

function parseJobList(value: unknown): GatewayJobListResponse | null {
  if (!isRecord(value)) {
    return null;
  }
  if (!Array.isArray(value.jobs)) {
    return null;
  }
  return value as GatewayJobListResponse;
}

function parseJob(value: unknown): GatewayJobResponse | null {
  if (!isRecord(value)) {
    return null;
  }
  if (!isRecord(value.job) || typeof value.job.jobId !== "string") {
    return null;
  }
  return value as GatewayJobResponse;
}

function parseCancel(value: unknown): GatewayCancelResponse | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.status !== "string") {
    return null;
  }
  return value as GatewayCancelResponse;
}

function parseShell(value: unknown): GatewayShellResponse | null {
  if (!isRecord(value)) {
    return null;
  }
  if (!isRecord(value.shell) || typeof value.shell.shellId !== "string") {
    return null;
  }
  return value as GatewayShellResponse;
}

function parseNodeStatus(value: unknown): GatewayNodeStatus | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.status !== "string" ||
    typeof value.version !== "string" ||
    !isRecord(value.node) ||
    !isRecord(value.gateway) ||
    !isRecord(value.supervisor) ||
    !isRecord(value.devcontainers)
  ) {
    return null;
  }
  return value as GatewayNodeStatus;
}

function parseWorkspaceEnsure(
  value: unknown
): GatewayNodeWorkspaceResponse | null {
  if (!(isRecord(value) && isRecord(value.workspace))) {
    return null;
  }
  if (
    typeof value.workspace.projectId !== "string" ||
    typeof value.workspace.projectName !== "string" ||
    typeof value.workspace.projectRoot !== "string" ||
    typeof value.workspace.projectDir !== "string"
  ) {
    return null;
  }
  const bootstrapAuthSource =
    value.bootstrap_auth_source === "native_git"
      ? value.bootstrap_auth_source
      : undefined;
  return {
    workspace: value.workspace as GatewayNodeWorkspace,
    ...(bootstrapAuthSource ? { bootstrapAuthSource } : {}),
  };
}

function parseNodeGitProbe(value: unknown): GatewayNodeGitProbeResponse | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.repo_url !== "string" ||
    typeof value.ok !== "boolean" ||
    !(value.auth_source === "native_git" || value.auth_source === "none")
  ) {
    return null;
  }
  const error = typeof value.error === "string" ? value.error : undefined;
  return {
    repoUrl: value.repo_url,
    ok: value.ok,
    authSource: value.auth_source,
    ...(error ? { error } : {}),
  };
}

function parseNodeDevcontainer(
  value: unknown
): GatewayNodeDevcontainerResponse | null {
  if (!(isRecord(value) && isRecord(value.session))) {
    return null;
  }
  if (
    typeof value.session.id !== "string" ||
    !isRecord(value.session.workspace) ||
    typeof value.session.output !== "string"
  ) {
    return null;
  }
  return value as GatewayNodeDevcontainerResponse;
}
