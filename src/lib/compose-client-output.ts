import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTextOutput } from "../ui/text-output.ts";
import {
  isComposeWarningLine,
  redactComposeOutputLine,
  sensitiveInheritedValues,
} from "./compose-ps-result.ts";
import type { ComposeStartupPhase } from "./compose-startup-budget.ts";

/** How many of the Compose client's last lines a failed start shows. */
export const COMPOSE_CLIENT_TAIL_LINES = 20;
/**
 * The same for a failure in the images phase: a BuildKit failure ends with
 * its `Dockerfile:N` context block and `failed to solve` line, and the
 * failing step's own output sits above them.
 */
export const COMPOSE_CLIENT_IMAGES_TAIL_LINES = 40;
/** Printed after a quoted tail: where the whole client output can be seen. */
export const COMPOSE_CLIENT_FULL_OUTPUT_HINT =
  "For Compose's full output, run `hack up` in the foreground or `hack up --detach --json`.";
/** Printed instead when the tail shows Compose asking a question. */
export const COMPOSE_CLIENT_PROMPT_HINT =
  "Compose asked a question, and a detached `hack up` cannot answer it. Run `hack up` in the foreground to answer it.";
/** How many distinct Compose warnings a successful start repeats. */
export const COMPOSE_CLIENT_WARNING_LINES = 5;
/** Bytes read from each end of the capture; the rest is never loaded. */
const WINDOW_BYTES = 64 * 1024;

const LINE_BREAKS = /[\r\n\u0085\u2028\u2029]+/;
const CONTROL_CHARACTERS = /\p{Cc}/gu;
const LOGRUS_MESSAGE = /\bmsg="((?:[^"\\]|\\.)*)"/;
const WARNING_PREFIX = /^(?:warn(?:ing)?\[\d+\]|warn(?:ing)?:?)\s*/i;
/** A yes/no question such as Compose's `Recreate (data will be lost)? [y/N]`. */
const PROMPT_LINE = /[[(]\s*y\s*\/\s*n\s*[\])]/i;

/**
 * The detached Compose client's own stdout and stderr for one `hack up`.
 *
 * Ownership: {@link openComposeClientCapture} returns an open descriptor to
 * a file that is already unlinked, so the descriptor is the only reference
 * and no crash, signal or kill can leave the file behind. Compose children
 * inherit it and share its offset, so the images and start phases append in
 * order. The opener calls `close` exactly once, after every child that
 * received the descriptor has exited; reads after `close` return nothing.
 * Reads use positioned I/O and never move the shared offset.
 */
export interface ComposeClientCapture {
  readonly fd: number;
  /** Sanitized last lines, oldest first, for a failed start. */
  tail(opts?: {
    readonly lines?: number;
    readonly redactValues?: Iterable<string>;
  }): string[];
  /** Distinct sanitized warning messages, in order, for a successful start. */
  warnings(opts?: {
    readonly limit?: number;
    readonly redactValues?: Iterable<string>;
  }): string[];
  close(): void;
}

export function openComposeClientCapture(
  dir: string = tmpdir()
): ComposeClientCapture {
  const path = join(dir, `hack-compose-client-${randomUUID()}.log`);
  // `wx+` refuses an existing name (including a planted symlink).
  const fd = openSync(path, "wx+", 0o600);
  try {
    unlinkSync(path);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  let open = true;
  const read = (from: "head" | "tail") => {
    if (!open) {
      return { text: "", cut: false };
    }
    const size = fstatSync(fd).size;
    const length = Math.min(size, WINDOW_BYTES);
    const buffer = Buffer.alloc(length);
    const position = from === "tail" ? size - length : 0;
    const bytes = readSync(fd, buffer, 0, length, position);
    return {
      text: new TextDecoder().decode(buffer.subarray(0, bytes)),
      cut: size > length,
    };
  };
  return {
    fd,
    tail: (opts) => {
      const { text, cut } = read("tail");
      return sanitizeComposeClientLines({
        text,
        // A window that starts mid-file starts mid-line too.
        dropFirst: cut,
        redactValues: opts?.redactValues,
      }).slice(-(opts?.lines ?? COMPOSE_CLIENT_TAIL_LINES));
    },
    warnings: (opts) => {
      const { text, cut } = read("head");
      const lines = text.split(LINE_BREAKS);
      return composeClientWarnings({
        // A head window that ends mid-file ends mid-line too.
        text: (cut ? lines.slice(0, -1) : lines).join("\n"),
        limit: opts?.limit ?? COMPOSE_CLIENT_WARNING_LINES,
        redactValues: opts?.redactValues,
      });
    },
    close: () => {
      if (open) {
        open = false;
        closeSync(fd);
      }
    },
  };
}

/**
 * {@link openComposeClientCapture}, or undefined when the temporary
 * directory refuses the file: the start then passes the client's lines
 * through as before rather than failing over a display choice.
 */
export function tryOpenComposeClientCapture(
  dir?: string
): ComposeClientCapture | undefined {
  try {
    return openComposeClientCapture(dir);
  } catch {
    return;
  }
}

/**
 * Client text as quotable lines: escapes, control characters and blank
 * lines removed, URL credentials, `redactValues` and inherited values whose
 * names look secret replaced with `[REDACTED]`, each line bounded.
 */
export function sanitizeComposeClientLines(opts: {
  readonly text: string;
  readonly dropFirst?: boolean;
  readonly redactValues?: Iterable<string>;
}): string[] {
  const redactValues = [
    ...(opts.redactValues ?? []),
    ...sensitiveInheritedValues({ env: process.env }),
  ];
  const raw = opts.text.split(LINE_BREAKS);
  return (opts.dropFirst ? raw.slice(1) : raw)
    .map((line) =>
      Bun.stripANSI(line)
        .replaceAll("\t", " ")
        .replaceAll(CONTROL_CHARACTERS, "")
        .trim()
    )
    .filter((line) => line.length > 0)
    .map((line) => redactComposeOutputLine({ line, redactValues }));
}

/**
 * Compose's warning messages (for example an unset interpolation variable)
 * without their log prefix, deduplicated across the two detached phases,
 * which each print them.
 */
export function composeClientWarnings(opts: {
  readonly text: string;
  readonly limit: number;
  readonly redactValues?: Iterable<string>;
}): string[] {
  const seen = new Set<string>();
  for (const line of sanitizeComposeClientLines(opts)) {
    if (!isComposeWarningLine(line)) {
      continue;
    }
    const quoted = LOGRUS_MESSAGE.exec(line)?.[1];
    const message = (
      quoted === undefined
        ? line.replace(WARNING_PREFIX, "")
        : quoted.replaceAll('\\"', '"')
    ).trim();
    if (message.length > 0) {
      seen.add(message);
    }
    if (seen.size >= opts.limit) {
      break;
    }
  }
  return [...seen];
}

/** The failed start's client lines, on stderr, before Hack's own reason. */
export function writeComposeClientTail(
  lines: readonly string[],
  write: (text: string) => void = (text) => process.stderr.write(text)
): void {
  if (lines.length === 0) {
    return;
  }
  const output = createTextOutput({ write });
  output.line(
    `docker compose output (last ${lines.length} ${lines.length === 1 ? "line" : "lines"}):`,
    "faint"
  );
  for (const line of lines) {
    output.line(`  ${line}`);
  }
}

/**
 * A failed start's report from the capture: the client's last lines (more
 * for an images-phase failure), then one hint naming how to see the whole
 * output, or how to answer a question Compose asked. Nothing when the client
 * printed nothing.
 */
export function writeComposeClientFailure(opts: {
  readonly capture: Pick<ComposeClientCapture, "tail">;
  readonly phase: ComposeStartupPhase;
  readonly redactValues?: Iterable<string>;
  readonly write?: (text: string) => void;
}): void {
  const write = opts.write ?? ((text: string) => process.stderr.write(text));
  const lines = opts.capture.tail({
    lines:
      opts.phase === "images"
        ? COMPOSE_CLIENT_IMAGES_TAIL_LINES
        : COMPOSE_CLIENT_TAIL_LINES,
    redactValues: opts.redactValues,
  });
  if (lines.length === 0) {
    return;
  }
  writeComposeClientTail(lines, write);
  createTextOutput({ write }).line(
    lines.some((line) => PROMPT_LINE.test(line))
      ? COMPOSE_CLIENT_PROMPT_HINT
      : COMPOSE_CLIENT_FULL_OUTPUT_HINT,
    "faint"
  );
}

/** Compose warnings from a successful start, one `!` line each, on stderr. */
export function writeComposeClientWarnings(
  warnings: readonly string[],
  write: (text: string) => void = (text) => process.stderr.write(text)
): void {
  const row = createTextOutput({ write }).stepRows([]);
  for (const warning of warnings) {
    row({ name: "compose", status: "warn", detail: warning });
  }
}
