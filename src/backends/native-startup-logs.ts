import { isRecord } from "../lib/guards.ts";
import type { NativeManagedFile } from "./native-project-input.ts";

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

/** String leaves of a parsed JSON document, depth-first, without keys. */
function jsonStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      jsonStrings(item, out);
    }
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) {
      jsonStrings(item, out);
    }
  }
}

/**
 * Redaction values of private credential file members. Every file contributes
 * its whole text (whose lines are matched too) and, when it is JSON, each string
 * value long enough to match as a substring, such as a refresh token, client
 * secret or private key. A service whose file is not UTF-8 text, or looks like
 * JSON but does not parse, cannot be redacted reliably: it is reported so its
 * output is withheld.
 */
function credentialFileValues(
  managedFiles: Readonly<Record<string, readonly NativeManagedFile[]>>
): {
  readonly values: readonly string[];
  readonly withheld: ReadonlySet<string>;
} {
  const values: string[] = [];
  const withheld = new Set<string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const [service, files] of Object.entries(managedFiles)) {
    for (const file of files) {
      let text: string;
      try {
        text = decoder.decode(file.content);
      } catch {
        withheld.add(service);
        continue;
      }
      values.push(text);
      const trimmed = text.trim();
      if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        withheld.add(service);
        continue;
      }
      const strings: string[] = [];
      jsonStrings(parsed, strings);
      values.push(
        ...strings.filter(
          (value) => value.length >= NATIVE_STARTUP_LOG_SUBSTRING_MIN
        )
      );
    }
  }
  return { values, withheld };
}

/**
 * Render failed services' last output for the startup failure report, with every
 * managed value and every private credential file value of every service
 * redacted. A service holding a credential file that cannot be turned into
 * redaction values has its output withheld. Returns an empty string when there
 * is nothing to show. The result is for display only; callers must not persist it.
 */
export function formatNativeStartupLogReport(opts: {
  readonly logs: readonly NativeStartupLogTail[];
  readonly managedEnvironment: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  readonly managedFiles?: Readonly<
    Record<string, readonly NativeManagedFile[]>
  >;
}): string {
  if (opts.logs.length === 0) {
    return "";
  }
  const credentials = credentialFileValues(opts.managedFiles ?? {});
  const values = [
    ...Object.values(opts.managedEnvironment).flatMap((service) =>
      Object.values(service)
    ),
    ...credentials.values,
  ];
  const sections = opts.logs.map((tail) => {
    if (credentials.withheld.has(tail.service)) {
      return `--- ${tail.service} ---\n(output withheld: this service received credential files that could not be redacted; run hack logs ${tail.service} to read it)`;
    }
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
