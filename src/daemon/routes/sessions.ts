import { exec } from "../../lib/shell.ts";

/** Valid session name pattern: alphanumeric, dash, underscore, or dot */
const SESSION_NAME_PATTERN = /^[\w.-]+$/;

/**
 * Parsed tmux session info.
 */
export interface TmuxSession {
  readonly name: string;
  readonly attached: boolean;
  readonly path: string | null;
  readonly windows: number;
  readonly createdAt: string | null;
}

/**
 * Session create input.
 */
export interface SessionCreateInput {
  readonly name: string;
  readonly cwd?: string;
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

type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/**
 * Handles session API routes.
 *
 * Routes:
 * - GET /v1/sessions - List all tmux sessions
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
 * List all tmux sessions.
 */
async function handleListSessions(): Promise<Response> {
  const sessions = await listTmuxSessions();
  return jsonResponse({ sessions });
}

/**
 * Create a new tmux session.
 */
async function handleCreateSession(opts: {
  readonly req: Request;
}): Promise<Response> {
  const body = await readJsonBody(opts.req);
  if (!body) {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  const parsed = parseSessionCreateInput(body);
  if (!parsed.ok) {
    return jsonResponse({ error: parsed.error }, 400);
  }

  const { name, cwd } = parsed.value;

  // Check if session already exists
  const existing = await findSession({ name });
  if (existing) {
    return jsonResponse({ error: "session_exists", session: existing }, 409);
  }

  // Create session - uses array form for safety (no shell interpolation)
  const args = ["tmux", "new-session", "-d", "-s", name];
  if (cwd) {
    args.push("-c", cwd);
  }

  const result = await exec(args, { stdin: "ignore" });
  if (result.exitCode !== 0) {
    return jsonResponse(
      { error: "create_failed", message: result.stderr.trim() },
      500
    );
  }

  // Return created session
  const session = await findSession({ name });
  return jsonResponse({ session }, 201);
}

/**
 * Get session details by name.
 */
async function handleGetSession(opts: {
  readonly sessionId: string;
}): Promise<Response> {
  const session = await findSession({ name: opts.sessionId });
  if (!session) {
    return jsonResponse({ error: "session_not_found" }, 404);
  }
  return jsonResponse({ session });
}

/**
 * Stop (kill) a tmux session.
 */
async function handleStopSession(opts: {
  readonly sessionId: string;
}): Promise<Response> {
  const session = await findSession({ name: opts.sessionId });
  if (!session) {
    return jsonResponse({ error: "session_not_found" }, 404);
  }

  const result = await exec(["tmux", "kill-session", "-t", opts.sessionId], {
    stdin: "ignore",
  });

  if (result.exitCode !== 0) {
    return jsonResponse(
      { error: "stop_failed", message: result.stderr.trim() },
      500
    );
  }

  return jsonResponse({ status: "stopped", session: opts.sessionId });
}

/**
 * Execute a command in a tmux session.
 * Sends the command followed by Enter.
 */
async function handleExecSession(opts: {
  readonly req: Request;
  readonly sessionId: string;
}): Promise<Response> {
  const session = await findSession({ name: opts.sessionId });
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

  // Uses array form - command is a separate argument, not interpolated
  const result = await exec(
    ["tmux", "send-keys", "-t", opts.sessionId, parsed.value.command, "Enter"],
    { stdin: "ignore" }
  );

  if (result.exitCode !== 0) {
    return jsonResponse(
      { error: "exec_failed", message: result.stderr.trim() },
      500
    );
  }

  return jsonResponse({ status: "sent", session: opts.sessionId });
}

/**
 * Send raw input/keystrokes to a tmux session.
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
  const session = await findSession({ name: opts.sessionId });
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

  // send-keys without trailing Enter - uses array form for safety
  const result = await exec(
    ["tmux", "send-keys", "-t", opts.sessionId, parsed.value.keys],
    { stdin: "ignore" }
  );

  if (result.exitCode !== 0) {
    return jsonResponse(
      { error: "input_failed", message: result.stderr.trim() },
      500
    );
  }

  return jsonResponse({ status: "sent", session: opts.sessionId });
}

/**
 * List all tmux sessions with detailed info.
 */
async function listTmuxSessions(): Promise<TmuxSession[]> {
  const format = [
    "#{session_name}",
    "#{session_attached}",
    "#{session_path}",
    "#{session_windows}",
    "#{session_created}",
  ].join(":");

  const result = await exec(["tmux", "list-sessions", "-F", format], {
    stdin: "ignore",
  });

  if (result.exitCode !== 0) {
    return [];
  }

  const sessions: TmuxSession[] = [];
  for (const line of result.stdout.trim().split("\n")) {
    if (!line) {
      continue;
    }
    const [name, attached, path, windows, created] = line.split(":");
    if (name) {
      sessions.push({
        name,
        attached: attached === "1",
        path: path || null,
        windows: Number.parseInt(windows ?? "1", 10),
        createdAt: created
          ? new Date(Number.parseInt(created, 10) * 1000).toISOString()
          : null,
      });
    }
  }

  return sessions;
}

/**
 * Find a session by name.
 */
async function findSession(opts: {
  readonly name: string;
}): Promise<TmuxSession | null> {
  const sessions = await listTmuxSessions();
  return sessions.find((s) => s.name === opts.name) ?? null;
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

  // Validate session name (tmux restrictions)
  const trimmedName = name.trim();
  if (!SESSION_NAME_PATTERN.test(trimmedName)) {
    return {
      ok: false,
      error:
        "invalid_name: must contain only alphanumeric, dash, underscore, or dot",
    };
  }

  const cwd = typeof body.cwd === "string" ? body.cwd.trim() : undefined;

  return {
    ok: true,
    value: {
      name: trimmedName,
      ...(cwd && cwd.length > 0 ? { cwd } : {}),
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
