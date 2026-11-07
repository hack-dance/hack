import { log as clackLog } from "@clack/prompts";
import type { GumFields } from "./gum.ts";
import { isGumAvailable, tryGumLog } from "./gum.ts";

export type LogLevel = "debug" | "info" | "warn" | "error" | "success" | "step";

export type LogFieldValue = string | number | boolean;
export type LogFields = Readonly<Record<string, LogFieldValue>>;

export interface LogInput {
  readonly message: string;
  readonly fields?: LogFields;
}

export interface Logger {
  debug(input: LogInput): void;
  info(input: LogInput): void;
  warn(input: LogInput): void;
  error(input: LogInput): void;
  success(input: LogInput): void;
  step(input: LogInput): void;
}

type LoggerBackend = "gum" | "clack" | "console";

const LINE_BREAK = /\r?\n/;

let backendOverride: LoggerBackend | null = null;

/**
 * Force a specific logger backend for the rest of this invocation.
 *
 * Used by `--json` code paths to route human log lines through the plain
 * `console` backend (stderr, no styling) so stdout stays pure JSON.
 */
export function setLoggerBackendOverride(opts: {
  readonly backend: LoggerBackend | null;
}): void {
  backendOverride = opts.backend;
}

function resolveBackend(): LoggerBackend {
  if (backendOverride) {
    return backendOverride;
  }
  const raw = (process.env.HACK_LOGGER ?? "").trim().toLowerCase();
  if (raw === "gum") {
    return "gum";
  }
  if (raw === "clack") {
    return "clack";
  }
  if (raw === "console" || raw === "plain") {
    return "console";
  }
  return isGumAvailable() ? "gum" : "clack";
}

function mergeFields(
  base: LogFields | undefined,
  extra: LogFields | undefined
): LogFields | undefined {
  if (!(base || extra)) {
    return undefined;
  }
  return { ...(base ?? {}), ...(extra ?? {}) };
}

function toGumLevel(level: LogLevel): "debug" | "info" | "warn" | "error" {
  if (level === "debug") {
    return "debug";
  }
  if (level === "warn") {
    return "warn";
  }
  if (level === "error") {
    return "error";
  }
  return "info";
}

function toGumFields(fields: LogFields | undefined): GumFields | undefined {
  return fields;
}

function formatFieldsInline(fields: LogFields | undefined): string {
  if (!fields) {
    return "";
  }
  const parts: string[] = [];
  for (const key of Object.keys(fields).sort()) {
    parts.push(`${key}=${String(fields[key])}`);
  }
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function logWithClack(level: LogLevel, { message, fields }: LogInput): void {
  const suffix = formatFieldsInline(fields);
  const line = `${message}${suffix}`;

  if (level === "debug" || level === "info") {
    clackLog.info(line);
  } else if (level === "warn") {
    clackLog.warn(line);
  } else if (level === "error") {
    clackLog.error(line);
  } else if (level === "success") {
    clackLog.success(line);
  } else {
    clackLog.step(line);
  }
}

function logWithConsole(level: LogLevel, { message, fields }: LogInput): void {
  const suffix = formatFieldsInline(fields);
  const line = `${level.toUpperCase()}: ${message}${suffix}\n`;
  process.stderr.write(line);
}

function resolveGumLogExtra(level: LogLevel): LogFields | undefined {
  if (level === "success") {
    return { status: "success" } satisfies LogFields;
  }
  if (level === "step") {
    return { status: "step" } satisfies LogFields;
  }
  return undefined;
}

/** Width of gum's level label plus its separator, e.g. `INFO `. */
const GUM_CONTINUATION_INDENT = " ".repeat(5);

/**
 * `gum log` joins a multi-line message into one line, on a terminal and when
 * piped. Log only the first line through gum and write the rest to the same
 * stream (gum logs to stderr), indented under the message, so every line
 * break survives. A failed gum call falls back to clack for the whole message.
 */
function logWithGum(level: LogLevel, { message, fields }: LogInput): void {
  const extra = resolveGumLogExtra(level);
  const [first = "", ...rest] = message.split(LINE_BREAK);

  const ok = tryGumLog({
    level: toGumLevel(level),
    message: first,
    fields: toGumFields(mergeFields(fields, extra)),
  });

  if (!ok) {
    // Fallback without throwing.
    logWithClack(level, { message, fields });
    return;
  }
  if (rest.length > 0) {
    process.stderr.write(
      `${rest.map((line) => (line ? `${GUM_CONTINUATION_INDENT}${line}` : line)).join("\n")}\n`
    );
  }
}

export const logger: Logger = (() => {
  const emit = (level: LogLevel, input: LogInput) => {
    const backend = resolveBackend();
    if (backend === "gum") {
      return logWithGum(level, input);
    }
    if (backend === "console") {
      return logWithConsole(level, input);
    }
    return logWithClack(level, input);
  };

  return {
    debug: (input) => emit("debug", input),
    info: (input) => emit("info", input),
    warn: (input) => emit("warn", input),
    error: (input) => emit("error", input),
    success: (input) => emit("success", input),
    step: (input) => emit("step", input),
  } satisfies Logger;
})();
