import type { LogJsonEntry } from "./log-json.ts";

/**
 * Schema id of the `hack logs --json` ndjson stream. It appears once, on the
 * first (`start`) line. A finished stream closes with exactly one `end` line;
 * a stream without one was interrupted (for example, the reader killed it).
 * See docs/reference/logs-json.md.
 */
export const LOG_STREAM_SCHEMA = "hack.logs.v1";

export type LogStreamBackend = "compose" | "loki" | "native";
export type LogStreamEventType =
  | "start"
  | "log"
  | "notice"
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
  /**
   * `--max-line-bytes`: the UTF-8 byte bound for each entry's `message` and
   * `raw`. A longer entry keeps a prefix and gains `truncated: true`.
   */
  readonly maxLineBytes?: number;
};

export type LogStreamEvent = {
  readonly schema?: typeof LOG_STREAM_SCHEMA;
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
  readonly phase?: string;
  readonly max_line_bytes?: number;
};

export function buildLogStreamStartEvent(opts: {
  readonly context: LogStreamContext;
}): LogStreamEvent {
  const { context } = opts;
  return {
    schema: LOG_STREAM_SCHEMA,
    type: "start",
    ts: nowIso(),
    ...(context.project ? { project: context.project } : {}),
    backend: context.backend,
    ...(context.branch ? { branch: context.branch } : {}),
    ...(context.services ? { services: context.services } : {}),
    follow: context.follow,
    ...(context.since ? { since: context.since } : {}),
    ...(context.until ? { until: context.until } : {}),
    ...(context.maxLineBytes === undefined
      ? {}
      : { max_line_bytes: context.maxLineBytes }),
  };
}

export function buildLogStreamLogEvent(opts: {
  readonly context: LogStreamContext;
  readonly entry: LogJsonEntry;
}): LogStreamEvent {
  const { context } = opts;
  const entry =
    context.maxLineBytes === undefined
      ? opts.entry
      : capLogEntry({ entry: opts.entry, maxBytes: context.maxLineBytes });
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
  readonly phase?: string;
  readonly message?: string;
}): LogStreamEvent {
  const { context, reason, phase, message } = opts;
  return {
    type: "end",
    ts: nowIso(),
    ...(context.project ? { project: context.project } : {}),
    backend: context.backend,
    ...(context.branch ? { branch: context.branch } : {}),
    ...(reason ? { reason } : {}),
    ...(phase ? { phase } : {}),
    ...(message ? { message } : {}),
  };
}

export function writeLogStreamEvent(opts: {
  readonly event: LogStreamEvent;
}): void {
  process.stdout.write(`${JSON.stringify(opts.event)}\n`);
}

/**
 * Bound an entry's `message` and `raw` to `maxBytes` UTF-8 bytes each, cutting
 * on a character boundary. A capped entry gains `truncated: true` and drops
 * `fields`, which were parsed from the oversized line and are unbounded.
 */
export function capLogEntry(opts: {
  readonly entry: LogJsonEntry;
  readonly maxBytes: number;
}): LogJsonEntry {
  const message = utf8Prefix({
    text: opts.entry.message,
    maxBytes: opts.maxBytes,
  });
  const raw = utf8Prefix({ text: opts.entry.raw, maxBytes: opts.maxBytes });
  if (!(message.cut || raw.cut)) {
    return opts.entry;
  }
  const { fields: _fields, ...rest } = opts.entry;
  return { ...rest, message: message.text, raw: raw.text, truncated: true };
}

const encoder = new TextEncoder();

function utf8Prefix(opts: {
  readonly text: string;
  readonly maxBytes: number;
}): { readonly text: string; readonly cut: boolean } {
  // Each UTF-16 unit encodes to at most 3 bytes, so short text never needs a scan.
  if (opts.text.length * 3 <= opts.maxBytes) {
    return { text: opts.text, cut: false };
  }
  if (encoder.encode(opts.text).length <= opts.maxBytes) {
    return { text: opts.text, cut: false };
  }
  let bytes = 0;
  let end = 0;
  for (const char of opts.text) {
    const size = utf8Length(char.codePointAt(0) ?? 0);
    if (bytes + size > opts.maxBytes) {
      break;
    }
    bytes += size;
    end += char.length;
  }
  return { text: opts.text.slice(0, end), cut: true };
}

function utf8Length(code: number): number {
  if (code < 0x80) {
    return 1;
  }
  if (code < 0x8_00) {
    return 2;
  }
  return code < 0x1_00_00 ? 3 : 4;
}

function nowIso(): string {
  return new Date().toISOString();
}
