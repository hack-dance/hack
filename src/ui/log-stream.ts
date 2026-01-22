import type { LogJsonEntry } from "./log-json.ts";

export type LogStreamBackend = "compose" | "loki";
export type LogStreamEventType =
  | "start"
  | "log"
  | "heartbeat"
  | "error"
  | "end";

export type LogStreamContext = {
  readonly backend: LogStreamBackend;
  readonly project?: string;
  readonly branch?: string;
  readonly services?: readonly string[];
  readonly follow: boolean;
  readonly since?: string;
  readonly until?: string;
};

export type LogStreamEvent = {
  readonly type: LogStreamEventType;
  readonly ts: string;
  readonly project?: string;
  readonly backend?: LogStreamBackend;
  readonly branch?: string;
  readonly services?: readonly string[];
  readonly follow?: boolean;
  readonly since?: string;
  readonly until?: string;
  readonly entry?: LogJsonEntry;
  readonly message?: string;
  readonly reason?: string;
};

export function buildLogStreamStartEvent(opts: {
  readonly context: LogStreamContext;
}): LogStreamEvent {
  const { context } = opts;
  return {
    type: "start",
    ts: nowIso(),
    ...(context.project ? { project: context.project } : {}),
    backend: context.backend,
    ...(context.branch ? { branch: context.branch } : {}),
    ...(context.services ? { services: context.services } : {}),
    follow: context.follow,
    ...(context.since ? { since: context.since } : {}),
    ...(context.until ? { until: context.until } : {}),
  };
}

export function buildLogStreamLogEvent(opts: {
  readonly context: LogStreamContext;
  readonly entry: LogJsonEntry;
}): LogStreamEvent {
  const { context, entry } = opts;
  const ts = entry.timestamp ?? nowIso();
  return {
    type: "log",
    ts,
    ...(context.project ? { project: context.project } : {}),
    backend: context.backend,
    ...(context.branch ? { branch: context.branch } : {}),
    entry,
  };
}

export function buildLogStreamHeartbeatEvent(opts: {
  readonly context: LogStreamContext;
}): LogStreamEvent {
  const { context } = opts;
  return {
    type: "heartbeat",
    ts: nowIso(),
    ...(context.project ? { project: context.project } : {}),
    backend: context.backend,
    ...(context.branch ? { branch: context.branch } : {}),
  };
}

export function buildLogStreamErrorEvent(opts: {
  readonly context: LogStreamContext;
  readonly message: string;
}): LogStreamEvent {
  const { context, message } = opts;
  return {
    type: "error",
    ts: nowIso(),
    ...(context.project ? { project: context.project } : {}),
    backend: context.backend,
    ...(context.branch ? { branch: context.branch } : {}),
    message,
  };
}

export function buildLogStreamEndEvent(opts: {
  readonly context: LogStreamContext;
  readonly reason?: string;
}): LogStreamEvent {
  const { context, reason } = opts;
  return {
    type: "end",
    ts: nowIso(),
    ...(context.project ? { project: context.project } : {}),
    backend: context.backend,
    ...(context.branch ? { branch: context.branch } : {}),
    ...(reason ? { reason } : {}),
  };
}

export function writeLogStreamEvent(opts: {
  readonly event: LogStreamEvent;
}): void {
  process.stdout.write(`${JSON.stringify(opts.event)}\n`);
}

function nowIso(): string {
  return new Date().toISOString();
}
