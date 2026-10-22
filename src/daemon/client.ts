import pkg from "../../package.json";

import { readControlPlaneConfig } from "../control-plane/sdk/config.ts";
import { isRecord } from "../lib/guards.ts";
import { resolveHackInvocation } from "../lib/hack-cli.ts";
import { canPrompt } from "../lib/interactivity.ts";
import {
  getLaunchdServiceStatus,
  installLaunchdService,
  kickstartLaunchdService,
  resolveLaunchdAccess,
} from "./launchd.ts";
import { resolveDaemonPaths } from "./paths.ts";
import { readDaemonStatus } from "./status.ts";

type PackageJsonType = {
  readonly name: string;
  readonly version: string;
} & Record<string, unknown>;

const packageJson = pkg as unknown as PackageJsonType;
const DAEMON_AUTOSTART_COOLDOWN_MS = 15_000;
const DAEMON_AUTOSTART_WAIT_MS = 3500;
const DAEMON_AUTOSTART_POLL_MS = 125;
const DAEMON_AUTOSTART_MAX_ATTEMPTS = 2;

let lastDaemonAutostartAttemptAtMs = 0;

/**
 * Opt-out: when set to `1`, CLI commands never start hackd implicitly, on any
 * platform, through launchd or directly. That covers the autostart in
 * {@link requestDaemonJson} and the `daemon.autoStart` step of
 * `hack global up`. An explicit `hack daemon start` still works. The bundled
 * `hack-v5` entrypoint sets it; `hack-next` sets only the candidate marker,
 * which denies the same way.
 */
export const DAEMON_AUTOSTART_DISABLE_ENV = "HACK_DAEMON_AUTOSTART_DISABLE";

/**
 * Marker that `hack-next` and the bundled `hack-v5` entrypoint set on every
 * candidate run, on both backends (see `scripts/hack-v5.sh`).
 */
const CANDIDATE_ENTRYPOINT_ENV = "HACK_CANDIDATE_ENTRYPOINT";

export type DaemonAutostartBlockReason = "candidate" | "disabled";

export type DaemonAutostartAccess =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: DaemonAutostartBlockReason;
      readonly message: string;
    };

/**
 * Decides whether this process may start hackd implicitly when a daemon
 * request finds it unavailable.
 *
 * A candidate run never may (HACK-1368). Autostart starts whatever hackd the
 * host resolves, not this process: the per-user launchd plist points at the
 * stable binary, and the direct path runs the first `hack` on PATH. On the
 * Compose backend a candidate also shares the caller's `~/.hack`, so an
 * autostarted stable hackd would run beside the candidate on the same state
 * root. Callers already fall back to direct Docker inspection when the daemon
 * is unavailable, exactly as for a non-interactive run.
 *
 * {@link DAEMON_AUTOSTART_DISABLE_ENV} is checked first, then the candidate
 * marker. Values are trimmed; only `1` disables, and any non-empty marker
 * denies.
 */
export function resolveDaemonAutostartAccess(
  opts: { readonly env?: Readonly<Record<string, string | undefined>> } = {}
): DaemonAutostartAccess {
  const env = opts.env ?? process.env;
  if ((env[DAEMON_AUTOSTART_DISABLE_ENV] ?? "").trim() === "1") {
    return {
      allowed: false,
      reason: "disabled",
      message: `hackd autostart is disabled by ${DAEMON_AUTOSTART_DISABLE_ENV}=1.`,
    };
  }
  if ((env[CANDIDATE_ENTRYPOINT_ENV] ?? "").trim() !== "") {
    return {
      allowed: false,
      reason: "candidate",
      message:
        "hackd autostart is disabled for a candidate run: it would start the stable hackd. Start a daemon explicitly with `hack daemon start` if you need one.",
    };
  }
  return { allowed: true };
}

export type DaemonJsonResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly json: Record<string, unknown> | null;
};

export type DaemonApiProbe = {
  readonly reachable: boolean;
  readonly compatible: boolean;
  readonly version: string | null;
};

export async function requestDaemonJson(opts: {
  readonly path: string;
  readonly query?: Record<string, string | boolean | null>;
  readonly timeoutMs?: number;
  readonly method?: "GET" | "POST";
  readonly body?: Record<string, unknown>;
  readonly allowIncompatible?: boolean;
  readonly autoStart?: boolean;
}): Promise<DaemonJsonResponse | null> {
  const autoStart = opts.autoStart ?? true;
  const paths = resolveDaemonPaths({});
  const daemonReady = await ensureDaemonSocketReady({
    paths,
    autoStart,
  });
  if (!daemonReady) {
    return null;
  }

  if (!opts.allowIncompatible) {
    const compatible = await isDaemonCompatible({
      socketPath: paths.socketPath,
      timeoutMs: opts.timeoutMs,
    });
    if (!compatible) {
      return null;
    }
  }

  const raw = await requestDaemonRaw({
    socketPath: paths.socketPath,
    method: opts.method ?? "GET",
    path: opts.path,
    query: opts.query,
    body: opts.body,
    timeoutMs: opts.timeoutMs ?? 1000,
  });
  return await resolveDaemonJsonResponse({
    raw,
    autoStart,
    paths,
    method: opts.method ?? "GET",
    path: opts.path,
    query: opts.query,
    body: opts.body,
    timeoutMs: opts.timeoutMs ?? 1000,
  });
}

/**
 * Starts (or restarts) hackd automatically when autoStart is enabled and the daemon is unavailable.
 *
 * Uses launchd on macOS for startup/login persistence and process keepalive, with bounded retries
 * and cooldown to avoid runaway restart loops. When launchd access is denied (an isolated
 * HACK_HOME; see `resolveLaunchdAccess`), it starts hackd directly instead.
 *
 * Non-interactive invocations (no TTY, HACK_NO_INTERACTIVE, --no-interactive)
 * never autostart: callers fall back to direct docker inspection instead of
 * blocking a scripted/agent run on daemon spawn side effects. Candidate runs
 * and {@link DAEMON_AUTOSTART_DISABLE_ENV} never autostart either; see
 * {@link resolveDaemonAutostartAccess}. That check runs before anything else,
 * so a denied run reads no config and touches neither launchd nor PATH.
 */
async function ensureDaemonReady(opts: {
  readonly paths: ReturnType<typeof resolveDaemonPaths>;
}): Promise<boolean> {
  if (!resolveDaemonAutostartAccess().allowed) {
    return false;
  }
  if (!canPrompt()) {
    return false;
  }

  const controlPlane = await readControlPlaneConfig({});
  if (!controlPlane.config.daemon.autoStart) {
    return false;
  }

  const now = Date.now();
  const timeSinceLastAttempt = now - lastDaemonAutostartAttemptAtMs;
  if (
    timeSinceLastAttempt >= 0 &&
    timeSinceLastAttempt < DAEMON_AUTOSTART_COOLDOWN_MS
  ) {
    return false;
  }
  lastDaemonAutostartAttemptAtMs = now;

  // An isolated HACK_HOME does not own the per-user launchd service, so it
  // starts hackd directly under its own state root, as on Linux. Refusing to
  // autostart would leave isolated runs without the daemon they configured,
  // and the direct path touches nothing outside HACK_HOME (HACK-1313).
  if (process.platform === "darwin" && resolveLaunchdAccess().allowed) {
    const launched = await ensureLaunchdDaemonReady({
      paths: opts.paths,
      runAtLoad: controlPlane.config.daemon.launchd.runAtLoad,
      guiSessionOnly: controlPlane.config.daemon.launchd.guiSessionOnly,
    });
    if (launched) {
      return true;
    }
  }

  for (let attempt = 0; attempt < DAEMON_AUTOSTART_MAX_ATTEMPTS; attempt += 1) {
    const started = await startDaemonViaCli();
    if (!started) {
      continue;
    }
    const ready = await waitForDaemonSocket({
      paths: opts.paths,
      timeoutMs: DAEMON_AUTOSTART_WAIT_MS,
    });
    if (ready) {
      return true;
    }
  }

  return false;
}

async function ensureDaemonSocketReady(opts: {
  readonly paths: ReturnType<typeof resolveDaemonPaths>;
  readonly autoStart: boolean;
}): Promise<boolean> {
  const status = await readDaemonStatus({ paths: opts.paths });
  if (status.socketExists) {
    return true;
  }
  if (!opts.autoStart) {
    return false;
  }
  return await ensureDaemonReady({ paths: opts.paths });
}

export async function probeDaemonApi(opts: {
  readonly socketPath: string;
  readonly timeoutMs?: number;
}): Promise<DaemonApiProbe> {
  const raw = await requestDaemonRaw({
    socketPath: opts.socketPath,
    method: "GET",
    path: "/v1/status",
    timeoutMs: opts.timeoutMs ?? 1000,
  });
  if (!raw) {
    return {
      reachable: false,
      compatible: false,
      version: null,
    };
  }

  const json = safeJsonParse({
    text: raw.body,
  });
  const version = json ? json.version : null;
  return {
    reachable: true,
    compatible: typeof version === "string" && version === packageJson.version,
    version: typeof version === "string" ? version : null,
  };
}

/**
 * Ensures launchd manages hackd and kicks it when needed.
 */
async function ensureLaunchdDaemonReady(opts: {
  readonly paths: ReturnType<typeof resolveDaemonPaths>;
  readonly runAtLoad: boolean;
  readonly guiSessionOnly: boolean;
}): Promise<boolean> {
  const launchdStatus = await getLaunchdServiceStatus({
    paths: opts.paths,
  });
  if (!launchdStatus.installed) {
    const install = await installLaunchdService({
      paths: opts.paths,
      config: {
        installed: true,
        runAtLoad: opts.runAtLoad,
        guiSessionOnly: opts.guiSessionOnly,
      },
    });
    if (!install.ok) {
      return false;
    }
  }

  const kick = await kickstartLaunchdService();
  if (!kick.ok) {
    return false;
  }

  return await waitForDaemonSocket({
    paths: opts.paths,
    timeoutMs: DAEMON_AUTOSTART_WAIT_MS,
  });
}

/**
 * Starts hackd through the current CLI invocation path.
 *
 * Spawns fully detached (stdio ignored + unref) so the parent process never
 * inherits pipes held open by the daemon; readiness is verified separately
 * by {@link waitForDaemonSocket} with a bounded timeout.
 */
async function startDaemonViaCli(): Promise<boolean> {
  const invocation = await resolveHackInvocation();
  try {
    const proc = Bun.spawn(
      [invocation.bin, ...invocation.args, "daemon", "start"],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }
    );
    proc.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for hackd's unix socket to appear.
 */
async function waitForDaemonSocket(opts: {
  readonly paths: ReturnType<typeof resolveDaemonPaths>;
  readonly timeoutMs: number;
}): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < opts.timeoutMs) {
    const status = await readDaemonStatus({ paths: opts.paths });
    if (status.socketExists) {
      return true;
    }
    await Bun.sleep(DAEMON_AUTOSTART_POLL_MS);
  }
  const finalStatus = await readDaemonStatus({ paths: opts.paths });
  return finalStatus.socketExists;
}

async function isDaemonCompatible(opts: {
  readonly socketPath: string;
  readonly timeoutMs?: number;
}): Promise<boolean> {
  const raw = await requestDaemonRaw({
    socketPath: opts.socketPath,
    method: "GET",
    path: "/v1/status",
    timeoutMs: opts.timeoutMs ?? 1000,
  });
  if (!raw) {
    return false;
  }
  const json = safeJsonParse({ text: raw.body });
  const version = json ? json.version : null;
  return typeof version === "string" && version === packageJson.version;
}

async function requestDaemonRaw(opts: {
  readonly socketPath: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query?: Record<string, string | boolean | null>;
  readonly body?: Record<string, unknown>;
  readonly timeoutMs: number;
}): Promise<{ readonly statusCode: number; readonly body: string } | null> {
  const queryString = buildQueryString({ query: opts.query });
  const pathWithQuery = queryString ? `${opts.path}?${queryString}` : opts.path;
  const url = new URL(pathWithQuery, "http://localhost");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);

  const payload =
    opts.body && opts.method !== "GET" ? JSON.stringify(opts.body) : undefined;

  try {
    const res = await fetch(url, {
      method: opts.method,
      unix: opts.socketPath,
      ...(payload
        ? {
            body: payload,
            headers: { "content-type": "application/json" },
          }
        : {}),
      signal: controller.signal,
    });
    const body = await res.text();
    return { statusCode: res.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveDaemonJsonResponse(opts: {
  readonly raw: { readonly statusCode: number; readonly body: string } | null;
  readonly autoStart: boolean;
  readonly paths: ReturnType<typeof resolveDaemonPaths>;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query?: Record<string, string | boolean | null>;
  readonly body?: Record<string, unknown>;
  readonly timeoutMs: number;
}): Promise<DaemonJsonResponse | null> {
  if (opts.raw) {
    return buildDaemonJsonResponse({ raw: opts.raw });
  }
  if (!opts.autoStart) {
    return null;
  }

  const restarted = await ensureDaemonReady({ paths: opts.paths });
  if (!restarted) {
    return null;
  }
  const retry = await requestDaemonRaw({
    socketPath: opts.paths.socketPath,
    method: opts.method,
    path: opts.path,
    query: opts.query,
    body: opts.body,
    timeoutMs: opts.timeoutMs,
  });
  if (!retry) {
    return null;
  }
  return buildDaemonJsonResponse({ raw: retry });
}

function buildDaemonJsonResponse(opts: {
  readonly raw: { readonly statusCode: number; readonly body: string };
}): DaemonJsonResponse {
  const json = safeJsonParse({ text: opts.raw.body });
  return {
    ok: opts.raw.statusCode >= 200 && opts.raw.statusCode < 300,
    status: opts.raw.statusCode,
    json,
  };
}

function buildQueryString(opts: {
  readonly query: Record<string, string | boolean | null> | undefined;
}): string {
  if (!opts.query) {
    return "";
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(opts.query)) {
    if (value === null) {
      continue;
    }
    if (typeof value === "boolean") {
      params.set(key, value ? "true" : "false");
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      continue;
    }
    params.set(key, trimmed);
  }
  return params.toString();
}

function safeJsonParse(opts: {
  readonly text: string;
}): Record<string, unknown> | null {
  const trimmed = opts.text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
