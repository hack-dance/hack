import { isRecord } from "../lib/guards.ts";
import { isColorEnabled } from "./terminal.ts";

/** Matches a service name with instance suffix (e.g., "myservice#1") */
const SERVICE_INSTANCE_REGEX = /^(.*?)(#\d+)$/;

/** Matches ISO 8601 timestamp prefix from log line (e.g., "2024-01-15T12:34:56.789Z") */
const ISO_TIMESTAMP_PREFIX_REGEX =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)([\s\S]*)$/;

/** Extracts time components from ISO timestamp (e.g., "12:34:56" and optional fractional seconds) */
const ISO_TIME_COMPONENTS_REGEX = /T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/;

export type OutputStream = "stdout" | "stderr";

export type LogInputFormat = "auto" | "docker-compose" | "plain";

export function formatPrettyLogLine(opts: {
  readonly line: string;
  readonly stream: OutputStream;
  readonly format?: LogInputFormat;
}): string {
  const format = opts.format ?? "auto";
  const parsed = format === "plain" ? null : splitDockerPrefix(opts.line);

  const service = parsed?.service ?? null;
  const rawPayload = parsed?.payload ?? opts.line;
  const { timestampIso, payload } = splitIsoTimestampPrefix(rawPayload);

  const json = tryParseJson(payload);
  const tty = isColorEnabled();

  const timePrefix = timestampIso
    ? formatTimePrefix({ iso: timestampIso, tty })
    : "";

  const level =
    opts.stream === "stderr"
      ? "error"
      : (parseAnyLevel(json?.level) ??
        parseAnyLevel(json?.lvl) ??
        parseAnyLevel(json?.severity));
  const msg = extractLogMessage({ json, payload });

  const fields = json ? extractFields(json) : null;

  const prefix = service ? formatServicePrefix({ service, tty }) : "";
  const tail = fields ? ` ${formatFields({ fields, tty })}` : "";

  if (!level) {
    return `${timePrefix}${prefix}${msg}${tail}`;
  }

  const head = `${timePrefix}${formatLevel({ level, tty })} ${prefix}${msg}`;
  return head + tail;
}

function formatServicePrefix(opts: {
  readonly service: string;
  readonly tty: boolean;
}): string {
  if (!opts.tty) {
    return `[${opts.service}] `;
  }
  const { base, instance } = splitServiceInstance(opts.service);
  const coloredBase = colorHashed(base);
  const suffix = instance ? color(instance, "dim") : "";
  return `${color("[", "dim")}${coloredBase}${suffix}${color("]", "dim")} `;
}

function splitDockerPrefix(
  line: string
): { readonly service: string; readonly payload: string } | null {
  // Typical docker compose logs format: "<service>  | <payload>"
  const idx = line.indexOf("|");
  if (idx === -1) {
    return null;
  }
  const service = line.slice(0, idx).trim();
  const after = line.slice(idx + 1);
  const payload = after.startsWith(" ") ? after.slice(1) : after;
  if (!service) {
    return null;
  }
  return { service, payload };
}

type JsonLog = Record<string, unknown> & {
  readonly level?: unknown;
  readonly lvl?: unknown;
  readonly severity?: unknown;
  readonly msg?: unknown;
  readonly message?: unknown;
  readonly ts?: unknown;
  readonly time?: unknown;
  readonly timestamp?: unknown;
};

function tryParseJson(text: string): JsonLog | null {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    return isRecord(value) ? (value as JsonLog) : null;
  } catch {
    return null;
  }
}

type LogLevel = "debug" | "info" | "warn" | "error";

function normalizeLevel(raw: string): LogLevel {
  const v = raw.trim().toLowerCase();
  if (v === "debug") {
    return "debug";
  }
  if (v === "warn" || v === "warning") {
    return "warn";
  }
  if (v === "error" || v === "fatal" || v === "panic") {
    return "error";
  }
  return "info";
}

function parseAnyLevel(raw: unknown): LogLevel | null {
  if (typeof raw === "string") {
    return normalizeLevel(raw);
  }
  if (typeof raw === "number") {
    return normalizePinoLevel(raw);
  }
  return null;
}

function normalizePinoLevel(level: number): LogLevel {
  // Pino levels: 10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal
  if (level >= 50) {
    return "error";
  }
  if (level >= 40) {
    return "warn";
  }
  if (level >= 30) {
    return "info";
  }
  return "debug";
}

function extractFields(json: JsonLog): Readonly<Record<string, string>> | null {
  const omit = new Set([
    "level",
    "lvl",
    "severity",
    "msg",
    "message",
    "ts",
    "time",
    "timestamp",
  ]);
  const out: Record<string, string> = {};
  for (const key of Object.keys(json)) {
    if (omit.has(key)) {
      continue;
    }
    const v = json[key];
    if (v === null || v === undefined) {
      continue;
    }
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      out[key] = String(v);
    }
  }
  const keys = Object.keys(out);
  return keys.length > 0 ? out : null;
}

function formatFields(opts: {
  readonly fields: Readonly<Record<string, string>>;
  readonly tty: boolean;
}): string {
  const parts: string[] = [];
  for (const key of Object.keys(opts.fields).sort()) {
    const v = opts.fields[key];
    const k = opts.tty ? color(key, "dim") : key;
    parts.push(`${k}=${v}`);
  }
  return parts.join(" ");
}

function formatLevel(opts: {
  readonly level: LogLevel;
  readonly tty: boolean;
}): string {
  const label = getLogLevelLabel(opts.level);

  if (!opts.tty) {
    return `[${label}]`;
  }
  const colored = (
    {
      DEBUG: color(label, "dim"),
      INFO: color(label, "cyan"),
      WARN: color(label, "yellow"),
      ERROR: color(label, "red"),
    } satisfies Record<string, string>
  )[label];
  return `${color("[", "dim")}${colored}${color("]", "dim")}`;
}

type AnsiColor = "dim" | "red" | "yellow" | "cyan";

function color(text: string, kind: AnsiColor): string {
  const code = getAnsiCode(kind);
  return `${code}${text}\x1b[0m`;
}

function colorHashed(text: string): string {
  const palette = [
    33, 39, 45, 69, 75, 81, 87, 93, 99, 105, 111, 141, 147, 153, 159, 165, 171,
    177, 183, 189,
  ] as const;
  const idx = fnv1a32(text) % palette.length;
  const code = palette[idx] ?? 39;
  return `\x1b[1m\x1b[38;5;${code}m${text}\x1b[0m`;
}

function fnv1a32(text: string): number {
  let hash = 0x81_1c_9d_c5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  // Force unsigned 32-bit
  return hash >>> 0;
}

function splitServiceInstance(service: string): {
  readonly base: string;
  readonly instance: string | null;
} {
  const match = service.match(SERVICE_INSTANCE_REGEX);
  if (!match) {
    return { base: service, instance: null };
  }
  const base = match[1] ?? service;
  const instance = match[2] ?? null;
  return { base: base.length > 0 ? base : service, instance };
}

function splitIsoTimestampPrefix(payload: string): {
  readonly timestampIso: string | null;
  readonly payload: string;
} {
  const match = payload.match(ISO_TIMESTAMP_PREFIX_REGEX);
  if (!match) {
    return { timestampIso: null, payload };
  }

  const iso = match[1] ?? null;
  let rest = match[2] ?? "";
  // Docker adds a single separator space; keep any remaining indentation from the container output.
  if (rest.startsWith(" ")) {
    rest = rest.slice(1);
  }
  return { timestampIso: iso, payload: rest };
}

function formatTimePrefix(opts: {
  readonly iso: string;
  readonly tty: boolean;
}): string {
  const label = isoToClock(opts.iso);
  if (!opts.tty) {
    return `[${label}] `;
  }
  return `${color("[", "dim")}${color(label, "dim")}${color("]", "dim")} `;
}

function isoToClock(iso: string): string {
  const match = iso.match(ISO_TIME_COMPONENTS_REGEX);
  if (!match) {
    return iso;
  }
  const hms = match[1] ?? iso;
  const frac = match[2];
  if (!frac) {
    return hms;
  }
  const ms = frac.slice(0, 3).padEnd(3, "0");
  return `${hms}.${ms}`;
}

/**
 * Extracts the log message from a parsed JSON log or falls back to the raw payload.
 */
function extractLogMessage(opts: {
  readonly json: JsonLog | null;
  readonly payload: string;
}): string {
  if (typeof opts.json?.msg === "string") {
    return opts.json.msg;
  }
  if (typeof opts.json?.message === "string") {
    return opts.json.message;
  }
  return opts.payload;
}

/**
 * Returns the uppercase label for a log level.
 */
function getLogLevelLabel(
  level: LogLevel
): "DEBUG" | "WARN" | "ERROR" | "INFO" {
  switch (level) {
    case "debug":
      return "DEBUG";
    case "warn":
      return "WARN";
    case "error":
      return "ERROR";
    default:
      return "INFO";
  }
}

/**
 * Returns the ANSI escape code for a color.
 */
function getAnsiCode(kind: AnsiColor): string {
  switch (kind) {
    case "dim":
      return "\x1b[2m";
    case "red":
      return "\x1b[31m";
    case "yellow":
      return "\x1b[33m";
    case "cyan":
      return "\x1b[36m";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}
