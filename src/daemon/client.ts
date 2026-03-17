import pkg from "../../package.json";

import { readControlPlaneConfig } from "../control-plane/sdk/config.ts";
import { isRecord } from "../lib/guards.ts";
import { resolveHackInvocation } from "../lib/hack-cli.ts";
import { exec } from "../lib/shell.ts";
import {
  getLaunchdServiceStatus,
  installLaunchdService,
  kickstartLaunchdService,
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
}): Promise<DaemonJsonResponse | null> {
  const paths = resolveDaemonPaths({});
  const status = await readDaemonStatus({ paths });
  if (!status.running) {
    const started = await ensureDaemonReady({ paths });
    if (!(started || status.socketExists)) {
      return null;
    }
  }

  if (!opts.allowIncompatible) {
    const probe = await probeDaemonApi({
      socketPath: paths.socketPath,
      timeoutMs: opts.timeoutMs,
    });
    if (!probe.compatible) {
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
  if (!raw) {
    const restarted = await ensureDaemonReady({ paths });
    if (!restarted) {
      return null;
    }
    const retry = await requestDaemonRaw({
      socketPath: paths.socketPath,
      method: opts.method ?? "GET",
      path: opts.path,
      query: opts.query,
      body: opts.body,
      timeoutMs: opts.timeoutMs ?? 1000,
    });
    if (!retry) {
      return null;
    }
    const retryJson = safeJsonParse({ text: retry.body });
    return {
      ok: retry.statusCode >= 200 && retry.statusCode < 300,
      status: retry.statusCode,
      json: retryJson,
    };
  }

  const json = safeJsonParse({ text: raw.body });
  return {
    ok: raw.statusCode >= 200 && raw.statusCode < 300,
    status: raw.statusCode,
    json,
  };
}

/**
 * Starts (or restarts) hackd automatically when autoStart is enabled and the daemon is unavailable.
 *
 * Uses launchd on macOS for startup/login persistence and process keepalive, with bounded retries
 * and cooldown to avoid runaway restart loops.
 */
async function ensureDaemonReady(opts: {
  readonly paths: ReturnType<typeof resolveDaemonPaths>;
}): Promise<boolean> {
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

  if (process.platform === "darwin") {
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
 */
async function startDaemonViaCli(): Promise<boolean> {
  const invocation = await resolveHackInvocation();
  const result = await exec(
    [invocation.bin, ...invocation.args, "daemon", "start"],
    {
      stdin: "ignore",
    }
  );
  return result.exitCode === 0;
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
  const json = safeJsonParse({ text: raw.body });
  const version = json ? json.version : null;
  return {
    reachable: true,
    compatible: typeof version === "string" && version === packageJson.version,
    version: typeof version === "string" ? version : null,
  };
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
