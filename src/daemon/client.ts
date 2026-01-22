import pkg from "../../package.json";

import { isRecord } from "../lib/guards.ts";
import { resolveDaemonPaths } from "./paths.ts";
import { readDaemonStatus } from "./status.ts";

type PackageJsonType = {
  readonly name: string;
  readonly version: string;
} & Record<string, unknown>;

const packageJson = pkg as unknown as PackageJsonType;

export type DaemonJsonResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly json: Record<string, unknown> | null;
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
  if (!status.socketExists) {
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
  if (!raw) {
    return null;
  }

  const json = safeJsonParse({ text: raw.body });
  return {
    ok: raw.statusCode >= 200 && raw.statusCode < 300,
    status: raw.statusCode,
    json,
  };
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
