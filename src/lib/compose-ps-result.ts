/**
 * Reads `docker compose ps --format json` results for commands that report
 * them, keeping the engine's cause instead of a fixed "failed" line.
 *
 * Failures become a {@link HackCliError} with a stable code, so `--json`
 * callers get the `{ok:false, error:{code, message}}` envelope and text
 * callers get one closed line without a stack trace:
 *
 * - `E_DOCKER_UNAVAILABLE`: the Docker CLI is missing, the engine cannot be
 *   reached (not running, wrong socket, connection refused), or the read
 *   ran past Hack's inspection timeout.
 * - `E_PERMISSION`: the engine (or a Compose input) refused access, usually
 *   because the user cannot open the Docker socket.
 * - `E_COMPOSE_OUTPUT_INVALID`: Compose exited 0 but printed output that is
 *   not JSON lines or a JSON array of objects.
 * - `E_COMPOSE_FAILED`: any other non-zero exit.
 *
 * Messages carry at most one line of the engine's error output (the first
 * that is not a Compose warning), with
 * URL credentials and caller-named values (for example the project env
 * values passed to Compose) replaced by `[REDACTED]`. Unparsable stdout is
 * never echoed: container listings can carry commands and labels.
 */

import { HackCliError } from "./cli-result.ts";
import { isRecord } from "./guards.ts";

/** The subset of a subprocess result this module reads. */
export type ComposePsProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type ComposePsRead =
  | { readonly ok: true; readonly entries: Record<string, unknown>[] }
  | { readonly ok: false; readonly error: HackCliError };

/** Exit code Hack's subprocess runner reports when its timeout stopped the child. */
const TIMEOUT_EXIT_CODE = 124;
/** Longest engine line kept in a message; longer lines are cut with "…". */
const ENGINE_LINE_MAX_CHARS = 240;
/** Shorter values are not redacted: they would blank common words. */
const REDACT_MIN_VALUE_CHARS = 4;

const WARNING_LINE = /^warn(ing)?\b|^warn\[|\blevel=warn(ing)?\b/i;
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** Greedy within the authority, so a password containing `@` is covered. */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi;

const ENGINE_PERMISSION_MARKERS = [
  "docker.sock",
  "docker api",
  "docker daemon",
  "docker engine",
  "podman.sock",
];

const ENGINE_UNREACHABLE_MARKERS = [
  "cannot connect to the docker daemon",
  "is the docker daemon running",
  "failed to connect to the docker api",
  "error during connect",
  "connection refused",
  "no such host",
  "context deadline exceeded",
  "i/o timeout",
  "the system cannot find the file specified",
];

/**
 * Classify a finished `docker compose ps --format json` run.
 *
 * @param redactValues Values that must never appear in a message, such as the
 *   env values Hack passed to Compose. Matching substrings become `[REDACTED]`.
 */
export function readComposePsResult(opts: {
  readonly result: ComposePsProcessResult;
  readonly redactValues?: Iterable<string>;
}): ComposePsRead {
  const { result } = opts;
  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: composePsFailureError({
        result,
        redactValues: opts.redactValues,
      }),
    };
  }
  const entries = parseComposePsJson(result.stdout);
  if (entries === null) {
    return {
      ok: false,
      error: new HackCliError({
        code: "E_COMPOSE_OUTPUT_INVALID",
        message:
          "docker compose ps exited 0 but its output is not JSON (output omitted). Hack needs Docker Compose v2; check `docker compose version`.",
      }),
    };
  }
  return { ok: true, entries };
}

/**
 * Run a `docker compose ps --format json` read and classify it. A spawn
 * failure (for example no `docker` on PATH) is reported as
 * `E_DOCKER_UNAVAILABLE` instead of escaping as an unexpected error.
 */
export async function readComposePs(opts: {
  readonly run: () => Promise<ComposePsProcessResult>;
  readonly redactValues?: Iterable<string>;
  /** Whether `docker` resolves on PATH; injectable for tests. */
  readonly dockerOnPath?: () => boolean;
}): Promise<ComposePsRead> {
  let result: ComposePsProcessResult;
  try {
    result = await opts.run();
  } catch (error: unknown) {
    const dockerOnPath =
      opts.dockerOnPath ?? (() => Bun.which("docker") !== null);
    // Only a spawn failure with no `docker` on PATH is a missing CLI. Any
    // other failure (a missing cwd, a bug) is not diagnosed as one.
    if (!(isSpawnNotFound(error) && !dockerOnPath())) {
      throw error;
    }
    return {
      ok: false,
      error: new HackCliError({
        code: "E_DOCKER_UNAVAILABLE",
        message:
          "Could not run `docker compose ps`: the docker CLI is not installed or not on PATH. Install Docker (or fix PATH) and retry.",
      }),
    };
  }
  return readComposePsResult({ result, redactValues: opts.redactValues });
}

function isSpawnNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "EACCES")
  );
}

/**
 * Whether a text-mode caller may retry with plain `docker compose ps`. Only an
 * unclassified Compose failure or unparsable JSON can be a Compose release
 * without JSON output; an unreachable engine or a denied socket fails the
 * same way again, so its classified line is the better report.
 */
export function composePsTextFallbackAllowed(error: HackCliError): boolean {
  return (
    error.code === "E_COMPOSE_FAILED" ||
    error.code === "E_COMPOSE_OUTPUT_INVALID"
  );
}

/**
 * Values Hack added to (or changed in) the environment it passed to Compose,
 * so error lines that echo them can be redacted. Inherited process values are
 * left alone: they are the caller's own environment, and redacting them (for
 * example HOME) would blank useful socket paths.
 */
export function composeEnvValuesToRedact(opts: {
  readonly env: Readonly<Record<string, string>> | undefined;
  readonly inherited?: Readonly<Record<string, string | undefined>>;
}): string[] {
  if (!opts.env) {
    return [];
  }
  const inherited = opts.inherited ?? process.env;
  return Object.entries(opts.env)
    .filter(([key, value]) => inherited[key] !== value)
    .map(([, value]) => value);
}

/**
 * Parse Compose ps JSON strictly. Compose v2.21+ prints one object per line;
 * older v2 releases print one JSON array. Returns null when any non-empty
 * line is not an object or an array of objects.
 */
export function parseComposePsJson(
  stdout: string
): Record<string, unknown>[] | null {
  const entries: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return null;
    }
    if (isRecord(value)) {
      entries.push(value);
      continue;
    }
    if (Array.isArray(value) && value.every(isRecord)) {
      entries.push(...value);
      continue;
    }
    return null;
  }
  return entries;
}

function composePsFailureError(opts: {
  readonly result: ComposePsProcessResult;
  readonly redactValues?: Iterable<string>;
}): HackCliError {
  const line = firstEngineLine({
    result: opts.result,
    redactValues: opts.redactValues,
  });
  const said = line === null ? "" : ` Engine said: ${line}`;
  const lower = `${opts.result.stderr}\n${opts.result.stdout}`.toLowerCase();

  if (lower.includes("permission denied")) {
    const engine = ENGINE_PERMISSION_MARKERS.some((m) => lower.includes(m));
    return new HackCliError({
      code: "E_PERMISSION",
      message: engine
        ? `Permission denied connecting to the Docker engine: your user cannot open its socket. Add your user to the docker group and start a new login session, or select an engine you can use with \`docker context use\`, then retry.${said}`
        : `docker compose ps was denied access to a file or socket it needs. Fix the permission named below and retry.${said}`,
    });
  }
  if (opts.result.exitCode === TIMEOUT_EXIT_CODE) {
    return new HackCliError({
      code: "E_DOCKER_UNAVAILABLE",
      message: `docker compose ps did not finish within Hack's inspection time limit, so it was stopped. The Docker engine may be hung or heavily loaded; check \`docker info\` and retry.${said}`,
    });
  }
  if (ENGINE_UNREACHABLE_MARKERS.some((m) => lower.includes(m))) {
    return new HackCliError({
      code: "E_DOCKER_UNAVAILABLE",
      message: `The Docker engine is not reachable. Start Docker, or check \`docker context ls\` and DOCKER_HOST point at a running engine, then retry.${said}`,
    });
  }
  return new HackCliError({
    code: "E_COMPOSE_FAILED",
    message: `docker compose ps failed (exit ${opts.result.exitCode}).${said === "" ? " It printed no error output." : said}`,
  });
}

/**
 * First non-warning line of stderr (stdout only when stderr is empty), without ANSI escapes, with
 * URL credentials and `redactValues` replaced, cut to a bounded length.
 */
export function firstEngineLine(opts: {
  readonly result: ComposePsProcessResult;
  readonly redactValues?: Iterable<string>;
}): string | null {
  // stdout is read only when stderr is empty: on a failed ps it may hold
  // partial container JSON (commands, labels).
  const stderrLines = cleanLines(opts.result.stderr);
  const lines =
    stderrLines.length > 0 ? stderrLines : cleanLines(opts.result.stdout);
  // Compose prints warnings (an obsolete `version`, an unset variable) before
  // the error; they must not take the cause's place.
  const source = lines.find((line) => !isWarningLine(line)) ?? lines[0];
  if (source === undefined) {
    return null;
  }
  let line = source.replace(
    URL_USERINFO,
    (_match, scheme: string) => `${scheme}[REDACTED]@`
  );
  const values = [...(opts.redactValues ?? [])]
    .filter((value) => value.length >= REDACT_MIN_VALUE_CHARS)
    .sort((a, b) => b.length - a.length);
  for (const value of values) {
    line = line.split(value).join("[REDACTED]");
  }
  return line.length > ENGINE_LINE_MAX_CHARS
    ? `${line.slice(0, ENGINE_LINE_MAX_CHARS - 1)}…`
    : line;
}

function cleanLines(text: string): string[] {
  return text
    .split("\n")
    .map((raw) => raw.replace(ANSI_ESCAPE, "").trim())
    .filter((line) => line.length > 0);
}

/** Compose/Docker warning lines: `WARN[0000] …`, `level=warning …`, `warning: …`. */
function isWarningLine(line: string): boolean {
  return WARNING_LINE.test(line);
}
