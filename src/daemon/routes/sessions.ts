import { exec } from "../../lib/shell.ts";
import {
  buildTailscaleSshCommand,
  getTailscaleStatus,
} from "../../lib/tailscale.ts";
import type { MuxBackendName, MuxSession } from "../../mux/mux-backend.ts";
import {
  resolveDefaultBackendName,
  resolveMux,
} from "../../mux/mux-resolver.ts";

/** Valid session name pattern: alphanumeric, dash, underscore */
const SESSION_NAME_PATTERN = /^[\w-]+$/;

/**
 * Parsed mux session info.
 */
export type DaemonSession = MuxSession;

/**
 * Session create input.
 */
export interface SessionCreateInput {
  readonly name: string;
  readonly cwd?: string;
  readonly backend?: MuxBackendName;
}

/**
 * Session exec input.
 */
export interface SessionExecInput {
  readonly command: string;
}

/**
 * Session input (raw keystrokes).
 */
export interface SessionInputPayload {
  readonly keys: string;
}

/**
 * Connection info for SSH access to sessions.
 */
export interface SessionConnectionInfo {
  /** Tailscale DNS name if available */
  readonly tailscaleDnsName: string | null;
  /** Tailscale SSH command if available */
  readonly tailscaleSshCommand: string | null;
  /** Whether Tailscale is ready for SSH */
  readonly tailscaleReady: boolean;
  /** Machine hostname */
  readonly hostname: string | null;
}

type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/**
 * Handles session API routes.
 *
 * Routes:
 * - GET /v1/sessions - List all sessions
 * - POST /v1/sessions - Create a new session
 * - GET /v1/sessions/:id - Get session details
 * - POST /v1/sessions/:id/stop - Stop (kill) session
 * - POST /v1/sessions/:id/exec - Execute command in session
 * - POST /v1/sessions/:id/input - Send raw input/keystrokes
 *
 * @returns Response if route matched, null otherwise
 */
export async function handleSessionRoutes(opts: {
  readonly req: Request;
  readonly url: URL;
}): Promise<Response | null> {
  const segments = opts.url.pathname.split("/").filter(Boolean);

  // Must start with v1/sessions
  if (segments[0] !== "v1" || segments[1] !== "sessions") {
    return null;
  }

  // GET /v1/sessions - list sessions
  if (segments.length === 2 && opts.req.method === "GET") {
    return await handleListSessions();
  }

  // POST /v1/sessions - create session
  if (segments.length === 2 && opts.req.method === "POST") {
    return await handleCreateSession({ req: opts.req });
  }

  const sessionId = segments[2];
  if (!sessionId) {
    return jsonResponse({ error: "missing_session_id" }, 400);
  }

  // GET /v1/sessions/:id - get session details
  if (segments.length === 3 && opts.req.method === "GET") {
    return await handleGetSession({ sessionId });
  }

  // POST /v1/sessions/:id/stop - stop session
  if (segments[3] === "stop" && opts.req.method === "POST") {
    return await handleStopSession({ sessionId });
  }

  // POST /v1/sessions/:id/exec - execute command
  if (segments[3] === "exec" && opts.req.method === "POST") {
    return await handleExecSession({ req: opts.req, sessionId });
  }

  // POST /v1/sessions/:id/input - send raw input
  if (segments[3] === "input" && opts.req.method === "POST") {
    return await handleInputSession({ req: opts.req, sessionId });
  }

  return jsonResponse({ error: "not_found" }, 404);
}

/**
 * List all sessions.
 */
async function handleListSessions(): Promise<Response> {
  const mux = await resolveMux({ project: null });
  const [sessions, connectionInfo] = await Promise.all([
    mux.mode === "none" ? Promise.resolve([] as const) : listSessions({ mux }),
    getConnectionInfo(),
  ]);
  return jsonResponse({ sessions, connection: connectionInfo });
}

/**
 * Create a new session.
 */
async function handleCreateSession(opts: {
  readonly req: Request;
}): Promise<Response> {
  const mux = await resolveMux({ project: null });
  if (mux.mode === "none") {
    return jsonResponse({ error: "sessions_disabled" }, 503);
  }

  const body = await readJsonBody(opts.req);
  if (!body) {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const parsed = parseSessionCreateInput(body);
  if (!parsed.ok) {
    return jsonResponse({ error: parsed.error }, 400);
  }

  const { name, cwd, backend: backendRequested } = parsed.value;
  const backendName =
    backendRequested ??
    resolveDefaultBackendName({ mode: mux.mode, backends: mux.backends });
  if (!backendName) {
    return jsonResponse({ error: "no_backend_available" }, 503);
  }
  const backend = mux.backends.get(backendName);
  if (!backend?.available) {
    return jsonResponse({ error: "backend_unavailable" }, 503);
  }

  // Check if session already exists
  const existing = await findSession({ mux, name });
  if (existing) {
    return jsonResponse({ error: "session_exists", session: existing }, 409);
  }

  const create = await backend.createSession({ name, cwd });
  if (!create.ok) {
    return jsonResponse(
      { error: create.error, message: create.stderr ?? "" },
      500
    );
  }

  const session = create.session ?? (await findSession({ mux, name }));
  return jsonResponse({ session }, 201);
}

/**
 * Get session details by name.
 */
async function handleGetSession(opts: {
  readonly sessionId: string;
}): Promise<Response> {
  const mux = await resolveMux({ project: null });
  const [session, connectionInfo] = await Promise.all([
    findSession({ mux, name: opts.sessionId }),
    getConnectionInfo({ sessionName: opts.sessionId }),
  ]);
  if (!session) {
    return jsonResponse({ error: "session_not_found" }, 404);
  }
  return jsonResponse({ session, connection: connectionInfo });
}

/**
 * Stop (kill) a session.
 */
async function handleStopSession(opts: {
  readonly sessionId: string;
}): Promise<Response> {
  const mux = await resolveMux({ project: null });
  const session = await findSession({ mux, name: opts.sessionId });
  if (!session) {
    return jsonResponse({ error: "session_not_found" }, 404);
  }

  const backend = mux.backends.get(session.backend);
  if (!backend?.available) {
    return jsonResponse({ error: "backend_unavailable" }, 503);
  }
  const result = await backend.killSession({ name: opts.sessionId });

  if (result.exitCode !== 0) {
    return jsonResponse(
      { error: "stop_failed", message: result.stderr.trim() },
      500
    );
  }

  return jsonResponse({ status: "stopped", session: opts.sessionId });
}

/**
 * Execute a command in a session.
 * Sends the command followed by Enter.
 */
async function handleExecSession(opts: {
  readonly req: Request;
  readonly sessionId: string;
}): Promise<Response> {
  const mux = await resolveMux({ project: null });
  const session = await findSession({ mux, name: opts.sessionId });
  if (!session) {
    return jsonResponse({ error: "session_not_found" }, 404);
  }

  const body = await readJsonBody(opts.req);
  if (!body) {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const parsed = parseSessionExecInput(body);
  if (!parsed.ok) {
    return jsonResponse({ error: parsed.error }, 400);
  }

  const backend = mux.backends.get(session.backend);
  if (!backend?.available) {
    return jsonResponse({ error: "backend_unavailable" }, 503);
  }
  const result = await backend.execInSession({
    name: opts.sessionId,
    command: parsed.value.command,
  });

  if (result.exitCode !== 0) {
    return jsonResponse(
      { error: "exec_failed", message: result.stderr.trim() },
      500
    );
  }

  return jsonResponse({ status: "sent", session: opts.sessionId });
}

/**
 * Send raw input/keystrokes to a session.
 * Does NOT automatically append Enter - allows sending key sequences like:
 * - "C-c" (Ctrl+C)
 * - "C-d" (Ctrl+D)
 * - "Escape"
 * - "Up", "Down", "Left", "Right"
 * - "Tab"
 * - Raw text without Enter
 */
async function handleInputSession(opts: {
  readonly req: Request;
  readonly sessionId: string;
}): Promise<Response> {
  const mux = await resolveMux({ project: null });
  const session = await findSession({ mux, name: opts.sessionId });
  if (!session) {
    return jsonResponse({ error: "session_not_found" }, 404);
  }

  const body = await readJsonBody(opts.req);
  if (!body) {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const parsed = parseSessionInputPayload(body);
  if (!parsed.ok) {
    return jsonResponse({ error: parsed.error }, 400);
  }

  const backend = mux.backends.get(session.backend);
  if (!backend?.available) {
    return jsonResponse({ error: "backend_unavailable" }, 503);
  }
  const result = await backend.sendInput({
    name: opts.sessionId,
    keys: parsed.value.keys,
  });

  if (result.exitCode !== 0) {
    return jsonResponse(
      { error: "input_failed", message: result.stderr.trim() },
      500
    );
  }

  return jsonResponse({ status: "sent", session: opts.sessionId });
}

/**
 * Find a session by name.
 */
async function findSession(opts: {
  readonly mux: Awaited<ReturnType<typeof resolveMux>>;
  readonly name: string;
}): Promise<DaemonSession | null> {
  const sessions = await listSessions({ mux: opts.mux });
  return sessions.find((s) => s.name === opts.name) ?? null;
}

async function listSessions(opts: {
  readonly mux: Awaited<ReturnType<typeof resolveMux>>;
}): Promise<readonly DaemonSession[]> {
  const sessions: DaemonSession[] = [];
  for (const backend of opts.mux.backends.values()) {
    if (!backend?.available) {
      continue;
    }
    sessions.push(...(await backend.listSessions()));
  }
  return sessions;
}

/**
 * Get connection info for SSH access.
 *
 * @param opts.sessionName - Optional session name for building SSH command
 */
async function getConnectionInfo(_opts?: {
  readonly sessionName?: string;
}): Promise<SessionConnectionInfo> {
  const [tsStatus, hostnameResult] = await Promise.all([
    getTailscaleStatus(),
    exec(["hostname"], { stdin: "ignore" }),
  ]);

  const hostname =
    hostnameResult.exitCode === 0 ? hostnameResult.stdout.trim() : null;

  const tailscaleReady = tsStatus.installed && tsStatus.loggedIn;
  const tailscaleDnsName = tsStatus.dnsName;

  let tailscaleSshCommand: string | null = null;
  if (tailscaleReady && tailscaleDnsName) {
    tailscaleSshCommand = buildTailscaleSshCommand({
      dnsName: tailscaleDnsName,
    });
  }

  return {
    tailscaleDnsName,
    tailscaleSshCommand,
    tailscaleReady,
    hostname,
  };
}

/**
 * Parse session create input.
 */
function parseSessionCreateInput(
  body: Record<string, unknown>
): ParseResult<SessionCreateInput> {
  const name = body.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    return { ok: false, error: "missing_name" };
  }

  // Validate session name (alphanumeric, dash, underscore, dot)
  const trimmedName = name.trim();
  if (!SESSION_NAME_PATTERN.test(trimmedName)) {
    return {
      ok: false,
      error:
        "invalid_name: must contain only alphanumeric, dash, or underscore",
    };
  }

  const cwd = typeof body.cwd === "string" ? body.cwd.trim() : undefined;
  const backend =
    body.backend === "tmux" || body.backend === "zellij"
      ? (body.backend as MuxBackendName)
      : undefined;

  return {
    ok: true,
    value: {
      name: trimmedName,
      ...(cwd && cwd.length > 0 ? { cwd } : {}),
      ...(backend ? { backend } : {}),
    },
  };
}

/**
 * Parse session exec input.
 */
function parseSessionExecInput(
  body: Record<string, unknown>
): ParseResult<SessionExecInput> {
  const command = body.command;
  if (typeof command !== "string" || command.length === 0) {
    return { ok: false, error: "missing_command" };
  }

  return {
    ok: true,
    value: { command },
  };
}

/**
 * Parse session input payload.
 */
function parseSessionInputPayload(
  body: Record<string, unknown>
): ParseResult<SessionInputPayload> {
  const keys = body.keys;
  if (typeof keys !== "string" || keys.length === 0) {
    return { ok: false, error: "missing_keys" };
  }

  return {
    ok: true,
    value: { keys },
  };
}

/**
 * Read and parse JSON body from request.
 */
async function readJsonBody(
  req: Request
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await req.json();
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Create JSON response with proper headers.
 */
function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  const payload = JSON.stringify(body, null, 2);
  return new Response(payload, {
    status,
    headers: {
      "content-type": "application/json",
      "content-length": `${Buffer.byteLength(payload)}`,
    },
  });
}
