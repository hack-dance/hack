/**
 * Machine-readable CLI result envelope.
 *
 * Commands that support `--json` print exactly one envelope object to stdout:
 * `{ok: true, data}` on success or `{ok: false, error: {code, message,
 * detail?}}` on failure. Exit codes keep their existing 0/1 semantics; the
 * envelope only adds structure, never changes them.
 */

/**
 * Stable machine-readable error codes for `--json` output.
 *
 * Codes are part of the CLI contract: add new ones as failure sites are
 * wired up, never repurpose existing ones.
 */
export type HackErrorCode =
  | "E_DOCKER_UNAVAILABLE"
  | "E_GLOBAL_INFRA_DOWN"
  | "E_CONFIG_PARSE"
  | "E_CONFIG_INVALID"
  | "E_PROJECT_NOT_FOUND"
  | "E_SERVICE_NOT_FOUND"
  | "E_COMPOSE_FAILED"
  | "E_STARTUP_INCOMPLETE"
  | "E_STARTUP_TIMEOUT"
  | "E_LIFECYCLE_FAILED"
  | "E_ENV_KEY_MISSING"
  | "E_PERMISSION"
  | "E_INTERACTIVE_REQUIRED"
  | "E_USAGE"
  | "E_UNEXPECTED";

export type CliResultError = {
  readonly code: HackErrorCode;
  readonly message: string;
  readonly detail?: unknown;
};

export type CliOkResult<T> = {
  readonly ok: true;
  readonly data: T;
};

export type CliErrorResult = {
  readonly ok: false;
  readonly error: CliResultError;
};

export type CliResult<T> = CliOkResult<T> | CliErrorResult;

/**
 * Build a success envelope.
 */
export function okResult<T>(opts: { readonly data: T }): CliOkResult<T> {
  return { ok: true, data: opts.data };
}

/**
 * Build an error envelope with a stable error code.
 */
export function errorResult(opts: {
  readonly code: HackErrorCode;
  readonly message: string;
  readonly detail?: unknown;
}): CliErrorResult {
  return {
    ok: false,
    error: {
      code: opts.code,
      message: opts.message,
      ...(opts.detail === undefined ? {} : { detail: opts.detail }),
    },
  };
}

/**
 * Serialize an envelope for stdout (pretty-printed, trailing newline).
 */
export function renderCliResult(opts: {
  readonly result: CliResult<unknown>;
}): string {
  return `${JSON.stringify(opts.result, null, 2)}\n`;
}

/**
 * Print an envelope to stdout. This is the ONLY thing a `--json` code path
 * should write to stdout.
 */
export function emitCliResult(opts: {
  readonly result: CliResult<unknown>;
}): void {
  process.stdout.write(renderCliResult(opts));
}

/**
 * Map an envelope to the CLI exit code (0 on ok, 1 on error).
 */
export function exitCodeForResult(opts: {
  readonly result: CliResult<unknown>;
}): number {
  return opts.result.ok ? 0 : 1;
}

/**
 * Error subclass that carries a stable {@link HackErrorCode} so `--json`
 * handlers (and the top-level CLI catch) can render a structured envelope.
 */
export class HackCliError extends Error {
  readonly code: HackErrorCode;
  readonly detail?: unknown;

  constructor(opts: {
    readonly code: HackErrorCode;
    readonly message: string;
    readonly detail?: unknown;
  }) {
    super(opts.message);
    this.name = "HackCliError";
    this.code = opts.code;
    this.detail = opts.detail;
  }
}

/**
 * Convert any thrown value into an error envelope, preserving structured
 * codes from {@link HackCliError} and falling back to E_UNEXPECTED.
 */
export function errorResultFromUnknown(opts: {
  readonly error: unknown;
  readonly fallbackCode?: HackErrorCode;
}): CliErrorResult {
  if (opts.error instanceof HackCliError) {
    return errorResult({
      code: opts.error.code,
      message: opts.error.message,
      detail: opts.error.detail,
    });
  }
  const message =
    opts.error instanceof Error ? opts.error.message : String(opts.error);
  return errorResult({
    code: opts.fallbackCode ?? "E_UNEXPECTED",
    message,
  });
}
