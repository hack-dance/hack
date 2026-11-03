export type LogBackendChoice = "compose" | "loki";

export function resolveShouldTryLoki(opts: {
  readonly forceCompose: boolean;
  readonly wantsLokiExplicit: boolean;
  readonly follow: boolean;
  readonly followBackend: LogBackendChoice;
  readonly snapshotBackend: LogBackendChoice;
}): boolean {
  if (opts.forceCompose) {
    return false;
  }
  if (opts.wantsLokiExplicit) {
    return true;
  }
  return opts.follow
    ? opts.followBackend === "loki"
    : opts.snapshotBackend === "loki";
}

export function resolveUseLoki(opts: {
  readonly forceCompose: boolean;
  readonly wantsLokiExplicit: boolean;
  readonly shouldTryLoki: boolean;
  readonly lokiReachable: boolean;
}): boolean {
  if (opts.wantsLokiExplicit) {
    return true;
  }
  if (opts.forceCompose) {
    return false;
  }
  return opts.shouldTryLoki && opts.lokiReachable;
}

export function buildLogSelector(opts: {
  readonly project: string | null;
  readonly services: readonly string[];
}): string {
  const parts: string[] = [];
  if (opts.project) {
    parts.push(`project=${quoteLogql(opts.project)}`);
  }
  if (opts.services.length === 1) {
    parts.push(`service=${quoteLogql(opts.services[0] ?? "")}`);
  } else if (opts.services.length > 1) {
    const pattern = `^(${opts.services.map(escapeRegex).join("|")})$`;
    parts.push(`service=~${quoteLogql(pattern)}`);
  }

  return `{${parts.join(",")}}`;
}

/**
 * Quote `value` as a LogQL double-quoted string literal.
 *
 * Loki's lexer scans the literal with Go's `text/scanner` (a raw newline ends
 * it with an error) and unquotes it with `strconv.Unquote`. Each character is
 * escaped once: `\` and `"` get a backslash, and control characters use Go
 * escapes, so the unquoted label value equals `value` exactly.
 */
function quoteLogql(value: string): string {
  let out = '"';
  for (const ch of value) {
    out += LOGQL_STRING_ESCAPES[ch] ?? escapeLogqlControl(ch);
  }
  return `${out}"`;
}

const LOGQL_STRING_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\\\",
  '"': '\\"',
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

function escapeLogqlControl(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  if (code < 0x20 || code === 0x7f) {
    return `\\x${code.toString(16).padStart(2, "0")}`;
  }
  return ch;
}

/**
 * Escape RE2 metacharacters so `value` matches only itself inside a regex.
 * Adds exactly one backslash; {@link quoteLogql} then escapes that backslash
 * for the string literal.
 */
function escapeRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Lookback used for a Loki snapshot (`hack logs --no-follow`) when neither
 * `--since` nor `--until` bounds the start.
 *
 * Compose snapshots have no time bound: `docker compose logs --tail N` shows the
 * last N lines of every container, including containers that exited long ago.
 * A short Loki window made a quiet or already-exited service look empty, so the
 * default covers a working day while staying well inside the default 168h
 * retention. Older history needs an explicit `--since`.
 */
export const DEFAULT_LOKI_SNAPSHOT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface LokiQueryWindow {
  readonly start: Date;
  readonly end: Date;
}

/**
 * Resolve the `[start, end]` range for a Loki `query_range` snapshot.
 *
 * An explicit start or end always wins; a missing end is `now`, and a missing
 * start is {@link DEFAULT_LOKI_SNAPSHOT_LOOKBACK_MS} before the end.
 */
export function resolveLokiQueryWindow(opts: {
  readonly start?: Date;
  readonly end?: Date;
  readonly now: Date;
}): LokiQueryWindow {
  const end = opts.end ?? opts.now;
  const start =
    opts.start ?? new Date(end.getTime() - DEFAULT_LOKI_SNAPSHOT_LOOKBACK_MS);
  return { start, end };
}

/** Result of one Loki snapshot as reported to {@link runLokiSnapshotWithFallback}. */
export interface LokiSnapshotOutcome {
  readonly exitCode: number;
  /** Log entries Loki returned; zero for a failed query. */
  readonly entryCount: number;
  /**
   * True only when the snapshot was empty and the caller asked to defer empty
   * results: nothing was written to stdout, so another backend may answer.
   */
  readonly deferred: boolean;
}

/**
 * Project selection the user gave `hack logs`, repeated in a suggested
 * `hack logs --compose` command so it targets the same project and instance.
 */
export interface LogsCommandTarget {
  readonly path?: string;
  readonly project?: string;
  readonly branch?: string;
}

/**
 * Everything else the user gave `hack logs` that selects or shapes its output,
 * repeated in a suggested `hack logs --compose` command. Each field is set only
 * when the user passed it. `--services`, `--query`, `--since` and `--until`
 * are Loki-only (`--compose` refuses them), and the compose backend reads one
 * service or all of them, so a selector the suggestion cannot apply is named
 * in {@link ComposeLogsSuggestion.omitted} instead of being dropped silently.
 */
export interface LogsCommandSelectors {
  /** Services from `--services` plus the positional, deduplicated, in order. */
  readonly services?: readonly string[];
  readonly tail?: number;
  readonly profiles?: readonly string[];
  readonly pretty?: boolean;
  readonly json?: boolean;
  readonly query?: string;
  readonly since?: string;
  readonly until?: string;
}

/** A `hack logs --compose` command and the selectors it could not carry. */
export interface ComposeLogsSuggestion {
  readonly command: string;
  /** Selectors with no compose equivalent, rendered as the user passed them. */
  readonly omitted: readonly string[];
}

/**
 * Run a Loki snapshot and handle an empty result.
 *
 * Alloy discovers containers by polling Docker, so a one-shot service that
 * exits (and is removed) between polls never reaches Loki even though
 * `docker compose logs` still shows its output. When Loki was chosen
 * implicitly (project default `logs.snapshotBackend`), an empty snapshot falls
 * back to the compose backend before any output is written, so stdout carries
 * exactly one backend's stream. When Loki was requested explicitly (`--loki`,
 * `--services`, `--query`, `--since`, `--until`), the Loki result stands and a
 * one-line hint on stderr points at `hack logs --compose --no-follow`.
 */
export async function runLokiSnapshotWithFallback(opts: {
  readonly wantsLokiExplicit: boolean;
  readonly query: string;
  readonly target: LogsCommandTarget;
  readonly selectors: LogsCommandSelectors;
  readonly runLoki: (opts: {
    readonly deferEmpty: boolean;
  }) => Promise<LokiSnapshotOutcome>;
  readonly runCompose: () => Promise<number>;
  readonly writeNotice: (line: string) => void;
}): Promise<number> {
  if (opts.wantsLokiExplicit) {
    const outcome = await opts.runLoki({ deferEmpty: false });
    if (outcome.exitCode === 0 && outcome.entryCount === 0) {
      opts.writeNotice(
        renderEmptyLokiSnapshotNotice({
          action: "hint",
          query: opts.query,
          target: opts.target,
          selectors: opts.selectors,
        })
      );
    }
    return outcome.exitCode;
  }

  const outcome = await opts.runLoki({ deferEmpty: true });
  if (!outcome.deferred) {
    return outcome.exitCode;
  }
  opts.writeNotice(
    renderEmptyLokiSnapshotNotice({
      action: "fallback",
      query: opts.query,
      target: opts.target,
      selectors: opts.selectors,
    })
  );
  return await opts.runCompose();
}

const EMPTY_LOKI_REASON =
  "a short-lived container can exit before Alloy discovers it, and older logs sit outside the queried window";

/** One-line stderr notice for an empty Loki snapshot. */
export function renderEmptyLokiSnapshotNotice(opts: {
  readonly action: "fallback" | "hint";
  readonly query: string;
  readonly target: LogsCommandTarget;
  readonly selectors: LogsCommandSelectors;
}): string {
  if (opts.action === "fallback") {
    return `Loki returned no log entries for ${opts.query}; showing docker compose logs instead (${EMPTY_LOKI_REASON}).`;
  }
  const suggestion = renderComposeLogsSuggestion({
    follow: false,
    target: opts.target,
    selectors: opts.selectors,
  });
  return `Loki returned no log entries for ${opts.query} (${EMPTY_LOKI_REASON}); try \`${suggestion.command}\`.${renderOmittedSelectors(suggestion)}`;
}

/**
 * How long a Loki follow waits for its first entry before
 * {@link renderEmptyLokiFollowNotice} is shown. Loki's tail endpoint sends
 * recent history as soon as it connects, so a socket that stays quiet this
 * long means Loki holds nothing recent for the selector. One Alloy discovery
 * poll (5s) plus its push batch fits inside it.
 */
export const LOKI_FOLLOW_EMPTY_NOTICE_DELAY_MS = 8000;

/**
 * One-line stderr notice for a Loki follow that has received no entries yet.
 * Following continues; the notice points at the compose backend, which also
 * shows containers Alloy never shipped.
 */
export function renderEmptyLokiFollowNotice(opts: {
  readonly query: string;
  readonly target: LogsCommandTarget;
  readonly selectors: LogsCommandSelectors;
}): string {
  const suggestion = renderComposeLogsSuggestion({
    follow: true,
    target: opts.target,
    selectors: opts.selectors,
  });
  return `Loki has sent no log entries for ${opts.query} yet (${EMPTY_LOKI_REASON}); still following. Try \`${suggestion.command}\`.${renderOmittedSelectors(suggestion)}`;
}

function renderOmittedSelectors(suggestion: ComposeLogsSuggestion): string {
  if (suggestion.omitted.length === 0) {
    return "";
  }
  return ` The compose backend has no equivalent for ${formatList(suggestion.omitted)}.`;
}

function formatList(items: readonly string[]): string {
  if (items.length <= 1) {
    return items.join("");
  }
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
}

/**
 * Render the `hack logs --compose` command that matches the current
 * invocation: the same follow mode, project selection and every selector the
 * compose backend accepts (`--tail`, `--profile`, `--pretty`, `--json` and a
 * single service). A selector it cannot apply (`--query`, `--since`,
 * `--until`, or more than one service) is listed in `omitted`. A value is
 * single-quoted for POSIX shells when it has characters outside a safe set.
 */
export function renderComposeLogsSuggestion(opts: {
  readonly follow: boolean;
  readonly target: LogsCommandTarget;
  readonly selectors: LogsCommandSelectors;
}): ComposeLogsSuggestion {
  const words = ["hack", "logs", "--compose"];
  if (!opts.follow) {
    words.push("--no-follow");
  }
  const flags = [
    ["--path", opts.target.path],
    ["--project", opts.target.project],
    ["--branch", opts.target.branch],
  ] as const;
  for (const [flag, value] of flags) {
    const trimmed = (value ?? "").trim();
    if (trimmed.length > 0) {
      words.push(flag, quoteShellWord(trimmed));
    }
  }
  const selectors = opts.selectors;
  if (selectors.tail !== undefined) {
    words.push("--tail", String(selectors.tail));
  }
  const profiles = trimmedWords(selectors.profiles);
  if (profiles.length > 0) {
    words.push("--profile", quoteShellWord(profiles.join(",")));
  }
  if (selectors.pretty) {
    words.push("--pretty");
  }
  if (selectors.json) {
    words.push("--json");
  }

  const omitted: string[] = [];
  const services = trimmedWords(selectors.services);
  if (services.length === 1) {
    words.push(quoteShellWord(services[0] ?? ""));
  } else if (services.length > 1) {
    omitted.push(`--services ${quoteShellWord(services.join(","))}`);
  }
  const lokiOnly = [
    ["--query", selectors.query],
    ["--since", selectors.since],
    ["--until", selectors.until],
  ] as const;
  for (const [flag, value] of lokiOnly) {
    if (value !== undefined) {
      omitted.push(`${flag} ${quoteShellWord(value)}`);
    }
  }
  return { command: words.join(" "), omitted };
}

function trimmedWords(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

const SHELL_SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function quoteShellWord(value: string): string {
  if (SHELL_SAFE_WORD.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
