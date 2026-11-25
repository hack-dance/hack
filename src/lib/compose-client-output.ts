import { createTextOutput } from "../ui/text-output.ts";
import {
  isComposeWarningLine,
  redactComposeOutputLine,
  sensitiveInheritedValues,
} from "./compose-ps-result.ts";
import type { ComposeStartupPhase } from "./compose-startup-budget.ts";
import type { OutputSink } from "./output-sink.ts";

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
/** Printed instead when Compose asked a question during the failed start. */
export const COMPOSE_CLIENT_PROMPT_HINT =
  "Compose asked a question, and a detached `hack up` cannot answer it. Run `hack up` in the foreground to answer it.";
/**
 * Printed after a successful start's unanswered questions. `hack up` passes
 * no Compose flag that answers them, and some answers (recreating a volume)
 * lose data, so the foreground start is the one way named.
 */
export const COMPOSE_CLIENT_DECLINED_HINT =
  "A detached `hack up` cannot answer Compose's questions, so Compose went on with its default answer. To answer, run `hack up` in the foreground.";
/** How many distinct Compose warnings a successful start repeats. */
export const COMPOSE_CLIENT_WARNING_LINES = 5;
/** How many distinct Compose questions a start repeats. */
export const COMPOSE_CLIENT_QUESTION_LINES = 5;
/** Characters of the client's last lines the capture keeps, across both streams. */
export const COMPOSE_CLIENT_TAIL_CHARS = 64 * 1024;
/** Most of the client's last lines the capture keeps; a failed start quotes at most 40. */
const TAIL_LINES_KEPT = 256;
/**
 * Characters one captured line keeps; the rest of a longer line is dropped.
 * Quoted lines are cut to 240 characters after redaction, far inside this.
 */
export const COMPOSE_CLIENT_LINE_CHARS = 8 * 1024;
/** Distinct warning and question lines kept from the whole output. */
const WARNING_LINES_KEPT = 64;
/** Characters those warning and question lines may hold together. */
export const COMPOSE_CLIENT_WARNING_CHARS = 64 * 1024;

const LINE_BREAKS = /[\r\n\u0085\u2028\u2029]+/;
const CONTROL_CHARACTERS = /\p{Cc}/gu;
const LOGRUS_MESSAGE = /\bmsg="((?:[^"\\]|\\.)*)"/;
const WARNING_PREFIX = /^(?:warn(?:ing)?\[\d+\]|warn(?:ing)?:?)\s*/i;
/** A yes/no choice: `[y/N]`, `[Y/n]`, `(y/N)`, `[yN]`, `[yes/no]`. */
const YES_NO_CHOICE = /[[(]\s*y(?:es)?\s*\/?\s*n(?:o)?\s*[\])]/i;
/** An interactive (survey) prompt, which starts with `? `. */
const SURVEY_PROMPT = /^\?\s+\S/;
/** A BuildKit step line (`#12 …`), whose text is the build's, not a question. */
const BUILD_STEP_LINE = /^#\d+\s/;

/**
 * A question the Compose client asked, such as `Volume "shop_db" exists but
 * doesn't match configuration in compose file. Recreate (data will be
 * lost)?`. Without a terminal on stdin Compose prints the question with no
 * `[y/N]` and no line break, reads end-of-input and goes on with its default
 * answer; with one it shows `? … [y/N]`. Warning and build step lines are
 * never questions.
 */
export function isComposeQuestionLine(line: string): boolean {
  if (BUILD_STEP_LINE.test(line) || isComposeWarningLine(line)) {
    return false;
  }
  return (
    YES_NO_CHOICE.test(line) || SURVEY_PROMPT.test(line) || line.endsWith("?")
  );
}

/** A warning line's message without its log prefix (`WARN[0000]`, `time="…" level=warning msg=`). */
function composeWarningMessage(line: string): string {
  const quoted = LOGRUS_MESSAGE.exec(line)?.[1];
  return (
    quoted === undefined
      ? line.replace(WARNING_PREFIX, "")
      : quoted.replaceAll('\\"', '"')
  ).trim();
}

/**
 * What a detached `hack up` keeps of the Compose client's own stdout and
 * stderr, fed chunk by chunk through its {@link OutputSink} side.
 *
 * Bounds: nothing is written to disk, and memory stays bounded however much
 * the client prints. The capture keeps the last lines (at most
 * {@link COMPOSE_CLIENT_TAIL_CHARS} characters) for a failed start, and the
 * distinct warning and question lines from the whole output (at most
 * {@link COMPOSE_CLIENT_WARNING_CHARS}) for a successful one, so a warning
 * printed after a long build still shows. Warnings are distinct by message,
 * so repeats under different timestamps take one slot. Each line keeps at
 * most {@link COMPOSE_CLIENT_LINE_CHARS} characters. The two streams are
 * split into lines separately, so their partial lines never mix, and `end`
 * completes a stream's unterminated last line, so a question one phase
 * printed never joins the next phase's first line.
 *
 * Ownership: the opener feeds every phase into one capture and calls
 * `close` after the last phase has settled; writes and reads after `close`
 * do nothing and return nothing.
 */
export interface ComposeClientCapture extends OutputSink {
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
  /** Distinct sanitized questions Compose asked (see {@link isComposeQuestionLine}), in order. */
  questions(opts?: {
    readonly limit?: number;
    readonly redactValues?: Iterable<string>;
  }): string[];
  /** Characters held now, for checking the bounds above. */
  retainedChars(): number;
  close(): void;
}

export function openComposeClientCapture(): ComposeClientCapture {
  let open = true;
  const streams = {
    stdout: { decoder: new TextDecoder(), pending: "" },
    stderr: { decoder: new TextDecoder(), pending: "" },
  };
  let tailLines: string[] = [];
  let tailChars = 0;
  // Warning and question lines, keyed so a repeat takes no second slot.
  let warningLines: string[] = [];
  let warningKeys = new Set<string>();
  let warningChars = 0;
  const noticeKey = (line: string): string | undefined => {
    if (isComposeWarningLine(line)) {
      return `warning:${composeWarningMessage(line)}`;
    }
    return isComposeQuestionLine(line) ? `question:${line}` : undefined;
  };
  const keep = (raw: string) => {
    const line = cleanComposeClientLine(raw);
    if (line.length === 0) {
      return;
    }
    tailLines.push(line);
    tailChars += line.length;
    while (
      tailLines.length > 1 &&
      (tailChars > COMPOSE_CLIENT_TAIL_CHARS ||
        tailLines.length > TAIL_LINES_KEPT)
    ) {
      tailChars -= tailLines.shift()?.length ?? 0;
    }
    const key = noticeKey(line);
    if (
      key !== undefined &&
      !warningKeys.has(key) &&
      warningKeys.size < WARNING_LINES_KEPT &&
      warningChars + line.length <= COMPOSE_CLIENT_WARNING_CHARS
    ) {
      warningKeys.add(key);
      warningLines.push(line);
      warningChars += line.length;
    }
  };
  const append = (stream: { pending: string }, piece: string) => {
    const room = COMPOSE_CLIENT_LINE_CHARS - stream.pending.length;
    if (room > 0) {
      stream.pending += piece.slice(0, room);
    }
  };
  // Lines still waiting for their break, such as a question Compose asked.
  const pending = () =>
    [streams.stdout.pending, streams.stderr.pending]
      .map(cleanComposeClientLine)
      .filter((line) => line.length > 0);
  return {
    write: (chunk, name) => {
      if (!open) {
        return;
      }
      const stream = streams[name];
      const text = stream.decoder.decode(chunk, { stream: true });
      let first = true;
      for (const piece of text.split(LINE_BREAKS)) {
        if (!first) {
          keep(stream.pending);
          stream.pending = "";
        }
        first = false;
        append(stream, piece);
      }
    },
    end: (name) => {
      if (!open) {
        return;
      }
      const stream = streams[name];
      append(stream, stream.decoder.decode());
      keep(stream.pending);
      stream.pending = "";
    },
    tail: (opts) =>
      open
        ? sanitizeComposeClientLines({
            text: [...tailLines, ...pending()].join("\n"),
            redactValues: opts?.redactValues,
          }).slice(-(opts?.lines ?? COMPOSE_CLIENT_TAIL_LINES))
        : [],
    warnings: (opts) =>
      open
        ? composeClientWarnings({
            text: [...warningLines, ...pending()].join("\n"),
            limit: opts?.limit ?? COMPOSE_CLIENT_WARNING_LINES,
            redactValues: opts?.redactValues,
          })
        : [],
    questions: (opts) => {
      if (!open) {
        return [];
      }
      const lines = sanitizeComposeClientLines({
        text: [...warningLines, ...pending()].join("\n"),
        redactValues: opts?.redactValues,
      }).filter(isComposeQuestionLine);
      return [...new Set(lines)].slice(
        0,
        opts?.limit ?? COMPOSE_CLIENT_QUESTION_LINES
      );
    },
    retainedChars: () =>
      tailChars +
      warningChars +
      streams.stdout.pending.length +
      streams.stderr.pending.length,
    close: () => {
      open = false;
      tailLines = [];
      tailChars = 0;
      warningLines = [];
      warningKeys = new Set();
      warningChars = 0;
      streams.stdout.pending = "";
      streams.stderr.pending = "";
    },
  };
}

/** One client line without escapes, tabs, control characters or edge space. */
function cleanComposeClientLine(line: string): string {
  return Bun.stripANSI(line)
    .replaceAll("\t", " ")
    .replaceAll(CONTROL_CHARACTERS, "")
    .trim();
}

/**
 * Client text as quotable lines: escapes, control characters and blank
 * lines removed, URL credentials, `redactValues` and inherited values whose
 * names look secret replaced with `[REDACTED]`, each line bounded.
 */
export function sanitizeComposeClientLines(opts: {
  readonly text: string;
  readonly redactValues?: Iterable<string>;
}): string[] {
  const redactValues = [
    ...(opts.redactValues ?? []),
    ...sensitiveInheritedValues({ env: process.env }),
  ];
  return opts.text
    .split(LINE_BREAKS)
    .map(cleanComposeClientLine)
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
    const message = composeWarningMessage(line);
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
 * for an images-phase failure), then any question Compose asked that those
 * lines no longer show, then one hint naming how to see the whole output, or
 * how to answer the question. Nothing when the client printed nothing.
 */
export function writeComposeClientFailure(opts: {
  readonly capture: Pick<ComposeClientCapture, "tail" | "questions">;
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
  const questions = opts.capture.questions({
    redactValues: opts.redactValues,
  });
  if (lines.length === 0 && questions.length === 0) {
    return;
  }
  writeComposeClientTail(lines, write);
  const output = createTextOutput({ write });
  for (const question of questions) {
    if (!lines.includes(question)) {
      output.line(`Compose asked earlier: ${question}`);
    }
  }
  output.line(
    questions.length > 0 || lines.some(isComposeQuestionLine)
      ? COMPOSE_CLIENT_PROMPT_HINT
      : COMPOSE_CLIENT_FULL_OUTPUT_HINT,
    "faint"
  );
}

/**
 * Questions Compose asked during a successful start, which a detached start
 * left unanswered: one `!` line each, then how to answer them, on stderr.
 */
export function writeComposeClientQuestions(
  questions: readonly string[],
  write: (text: string) => void = (text) => process.stderr.write(text)
): void {
  if (questions.length === 0) {
    return;
  }
  const output = createTextOutput({ write });
  const row = output.stepRows([]);
  for (const question of questions) {
    row({
      name: "compose",
      status: "warn",
      detail: `unanswered question: ${question}`,
    });
  }
  output.line(COMPOSE_CLIENT_DECLINED_HINT, "faint");
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
