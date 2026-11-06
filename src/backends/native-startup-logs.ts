import { isRecord } from "../lib/guards.ts";

/**
 * Bounded output of one failed service from a native foreground startup failure
 * reply. It is application output and may contain managed values: it exists only
 * in memory, is redacted by {@link formatNativeStartupLogReport} before display
 * and is never written to disk. The runtime keeps whole lines only.
 */
export interface NativeStartupLogTail {
  readonly service: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

const SERVICE = /^[A-Za-z0-9_.-]{1,128}$/;
/** Runtime contract: at most this many services, each stream at most these bytes. */
export const NATIVE_STARTUP_LOG_SERVICES = 3;
export const NATIVE_STARTUP_LOG_STREAM_BYTES = 4096;
/** Lines the runtime requests per service, stdout and stderr together. */
export const NATIVE_STARTUP_LOG_LINES = 64;
/**
 * Stderr bytes accepted for a reply carrying tails: three services of two 4 KiB
 * streams, even if every character needs a six-byte JSON escape, plus the envelope.
 */
export const NATIVE_STARTUP_FAILURE_REPLY_BYTES = 256 * 1024;
/** Values shorter than this are redacted only as whole tokens; see {@link redactNativeStartupLog}. */
export const NATIVE_STARTUP_LOG_SUBSTRING_MIN = 4;
const MARKER = "[REDACTED]";

/** Accept only the versioned, bounded runtime contract; anything else is dropped whole. */
export function readNativeStartupLogs(
  value: unknown
): readonly NativeStartupLogTail[] | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.version !== 1 ||
    !Array.isArray(value.services) ||
    value.services.length < 1 ||
    value.services.length > NATIVE_STARTUP_LOG_SERVICES
  ) {
    return;
  }
  const names = new Set<string>();
  const result: NativeStartupLogTail[] = [];
  for (const tail of value.services) {
    if (
      !isRecord(tail) ||
      Object.keys(tail).length !== 4 ||
      typeof tail.service !== "string" ||
      !SERVICE.test(tail.service) ||
      names.has(tail.service) ||
      !boundedStream(tail.stdout) ||
      !boundedStream(tail.stderr) ||
      typeof tail.truncated !== "boolean"
    ) {
      return;
    }
    names.add(tail.service);
    result.push({
      service: tail.service,
      stdout: tail.stdout,
      stderr: tail.stderr,
      truncated: tail.truncated,
    });
  }
  return result;
}

function boundedStream(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) <= NATIVE_STARTUP_LOG_STREAM_BYTES
  );
}

// CSI and OSC terminal sequences. They are removed before matching so styling
// inserted inside a printed value cannot hide it from redaction.
const ESCAPE_SEQUENCE =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const SYNTAX = /[\\^$.*+?()[\]{}|/]/g;
const LINE_BREAK = /\r?\n/;

function needles(values: Iterable<string>): {
  readonly substrings: readonly string[];
  readonly tokens: readonly string[];
} {
  const substrings = new Set<string>();
  const tokens = new Set<string>();
  const long = (value: string) =>
    value.length >= NATIVE_STARTUP_LOG_SUBSTRING_MIN;
  for (const raw of values) {
    const value = raw.replace(ESCAPE_SEQUENCE, "");
    if (value === "") {
      continue;
    }
    (long(value) ? substrings : tokens).add(value);
    // An application can print a value JSON-escaped, and a tail can start or end
    // inside a multi-line value. Lines are matched only when long enough, so a
    // short line such as `}` never shreds output.
    const escaped = JSON.stringify(value).slice(1, -1);
    (long(escaped) ? substrings : tokens).add(escaped);
    for (const line of value.split(LINE_BREAK)) {
      for (const form of [line, line.trim()]) {
        if (long(form)) {
          substrings.add(form);
        }
      }
    }
  }
  const order = (a: string, b: string) =>
    b.length - a.length || (a < b ? -1 : 1);
  return {
    substrings: [...substrings].sort(order),
    tokens: [...tokens].sort(order),
  };
}

/**
 * Redact every managed value from application output, conservatively:
 *
 * - Terminal escape sequences are removed first.
 * - Each value of at least {@link NATIVE_STARTUP_LOG_SUBSTRING_MIN} characters is
 *   replaced wherever it occurs, including inside longer words. So is its
 *   JSON-escaped form and each line of a multi-line value that is long enough,
 *   with and without surrounding whitespace. Longer values are replaced first.
 * - A shorter value (one to three characters) is replaced only where it stands as
 *   a whole token, not next to a letter, digit or underscore, so a value such as
 *   `1` or `on` cannot shred unrelated output.
 * - Remaining control characters except tab and newline become U+FFFD.
 */
export function redactNativeStartupLog(
  text: string,
  values: Iterable<string>
): string {
  const { substrings, tokens } = needles(values);
  let result = text.replace(ESCAPE_SEQUENCE, "");
  for (const value of substrings) {
    result = result.split(value).join(MARKER);
  }
  for (const value of tokens) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])${value.replace(SYNTAX, "\\$&")}(?![\\p{L}\\p{N}_])`,
      "gu"
    );
    result = result.replace(pattern, MARKER);
  }
  return result.replace(CONTROL, "�");
}

/**
 * Render failed services' last output for the startup failure report, with every
 * managed value of every service redacted. Returns an empty string when there is
 * nothing to show. The result is for display only; callers must not persist it.
 */
export function formatNativeStartupLogReport(opts: {
  readonly logs: readonly NativeStartupLogTail[];
  readonly managedEnvironment: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
}): string {
  if (opts.logs.length === 0) {
    return "";
  }
  const values = Object.values(opts.managedEnvironment).flatMap((service) =>
    Object.values(service)
  );
  const sections = opts.logs.map((tail) => {
    const streams = (["stdout", "stderr"] as const)
      .filter((stream) => tail[stream] !== "")
      .map(
        (stream) =>
          `--- ${tail.service} ${stream} ---\n${redactNativeStartupLog(tail[stream], values)}`
      );
    if (streams.length === 0) {
      streams.push(`--- ${tail.service} ---\n(no output)`);
    }
    if (tail.truncated) {
      streams.push("(lines over the size bound were omitted)");
    }
    return streams.join("\n");
  });
  return `Last output of failed services (at most ${NATIVE_STARTUP_LOG_LINES} lines each; managed values redacted; not saved):\n${sections.join("\n")}`;
}
