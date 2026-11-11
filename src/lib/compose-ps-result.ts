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
 * Only a recognized Docker client connection error (denied socket, engine
 * unreachable) is quoted: one stderr line that starts with the client's own
 * error opening, with URL credentials, the env
 * values Hack passed to Compose and secret-looking inherited values replaced
 * by `[REDACTED]`. Other Compose output is omitted: Compose can expand
 * project `${VAR}` references, including inherited secrets, into its errors.
 * Stdout is never quoted: container listings can carry commands and labels.
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

const SENSITIVE_ENV_NAME = /^HACK_ENV_|SECRET|TOKEN|PASSW|CREDENTIAL|AUTH|KEY/i;
const OUTPUT_OMITTED =
  "Its output is omitted because Compose can expand project values into it; run `docker compose ps` in the project (or `hack ps` without --json) to see it.";

/**
 * How the Docker client itself begins a connection error (lowercased). Only a
 * line starting with one of these is quoted; the marker lists below only
 * classify.
 */
const CLIENT_PERMISSION_OPENINGS = [
  "permission denied while trying to connect to the docker",
] as const;
const CLIENT_UNREACHABLE_OPENINGS = [
  "cannot connect to the docker daemon",
  "failed to connect to the docker api",
  "error during connect",
] as const;

/** Classification only: these may appear inside Compose-generated text. */
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
  /** Defaults to `process.env`; see {@link sensitiveInheritedValues}. */
  readonly inheritedEnv?: Readonly<Record<string, string | undefined>>;
}): ComposePsRead {
  const { result } = opts;
  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: composePsFailureError({
        result,
        redactValues: opts.redactValues,
        inheritedEnv: opts.inheritedEnv,
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
  readonly inheritedEnv?: Readonly<Record<string, string | undefined>>;
}): HackCliError {
  const { result } = opts;
  const lower = `${result.stderr}\n${result.stdout}`.toLowerCase();
  const redactValues = [
    ...(opts.redactValues ?? []),
    ...sensitiveInheritedValues({ env: opts.inheritedEnv ?? process.env }),
  ];
  // Quote only a line that starts the way the Docker client starts its own
  // connection errors. Markers elsewhere in a line prove nothing: Compose can
  // expand project `${VAR}` references (from the environment or the project
  // `.env`) into its errors, next to text like "no such host".
  const said = (openings: readonly string[]): string => {
    const line = engineErrorLine({
      stderr: result.stderr,
      matches: (lowerLine) => openings.some((o) => lowerLine.startsWith(o)),
      redactValues,
    });
    return line === null ? "" : ` Engine said: ${line}`;
  };

  if (lower.includes("permission denied")) {
    if (ENGINE_PERMISSION_MARKERS.some((m) => lower.includes(m))) {
      return new HackCliError({
        code: "E_PERMISSION",
        message: `Permission denied connecting to the Docker engine: your user cannot open its socket. Add your user to the docker group and start a new login session, or select an engine you can use with \`docker context use\`, then retry.${said(CLIENT_PERMISSION_OPENINGS)}`,
      });
    }
    return new HackCliError({
      code: "E_PERMISSION",
      message: `docker compose ps was denied access to a file or socket it needs. ${OUTPUT_OMITTED}`,
    });
  }
  if (result.exitCode === TIMEOUT_EXIT_CODE) {
    return new HackCliError({
      code: "E_DOCKER_UNAVAILABLE",
      message:
        "docker compose ps did not finish within Hack's inspection time limit, so it was stopped. The Docker engine may be hung or heavily loaded; check `docker info` and retry.",
    });
  }
  if (ENGINE_UNREACHABLE_MARKERS.some((m) => lower.includes(m))) {
    return new HackCliError({
      code: "E_DOCKER_UNAVAILABLE",
      message: `The Docker engine is not reachable. Start Docker, or check \`docker context ls\` and DOCKER_HOST point at a running engine, then retry.${said(CLIENT_UNREACHABLE_OPENINGS)}`,
    });
  }
  return new HackCliError({
    code: "E_COMPOSE_FAILED",
    message: `docker compose ps failed (exit ${result.exitCode}). ${OUTPUT_OMITTED}`,
  });
}

/**
 * Inherited environment values that look secret, by name: `HACK_ENV_*` and
 * names containing SECRET, TOKEN, PASSWORD/PASSWD, CREDENTIAL, AUTH or KEY.
 * They are redacted even from recognized engine lines.
 */
export function sensitiveInheritedValues(opts: {
  readonly env: Readonly<Record<string, string | undefined>>;
}): string[] {
  return Object.entries(opts.env)
    .filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && SENSITIVE_ENV_NAME.test(entry[0])
    )
    .map(([, value]) => value);
}

/**
 * First non-warning stderr line that `matches` (given the lowercased line),
 * without ANSI escapes, with URL credentials and `redactValues` replaced, cut
 * to a bounded length. Null when no line matches. Stdout is never read: on a
 * failed ps it may hold partial container JSON (commands, labels).
 */
export function engineErrorLine(opts: {
  readonly stderr: string;
  readonly matches: (lowerLine: string) => boolean;
  readonly redactValues?: Iterable<string>;
}): string | null {
  const source = cleanLines(opts.stderr).find(
    (line) => !isWarningLine(line) && opts.matches(line.toLowerCase())
  );
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
