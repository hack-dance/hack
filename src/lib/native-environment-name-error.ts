import { displayEnvName } from "./portable-env-name.ts";

const HOST_COMMAND = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const RULE =
  "which is not a portable name (letters, digits and _, not starting with a digit). Rename it in the project configuration. Values omitted.";
/** The sentence each genuine instance was built with; nothing else can set it. */
const rendered = new WeakMap<NativeEnvironmentNameError, string>();

/**
 * The project's own configuration sets an environment variable whose name is
 * not portable (HACK-2219). Names are not secret, so the refusal names it,
 * escaped and bounded; values never appear. Only the static constructors build
 * one, from validated parts, and {@link renderNativeEnvironmentNameError} reads
 * the sentence fixed at construction: changing `message` afterwards, or a
 * lookalike error, cannot carry other text across a redaction boundary.
 */
export class NativeEnvironmentNameError extends Error {
  readonly code = "E_CONFIG_INVALID" as const;
  /** Closed reason for machine output. */
  readonly reason = "environment_name_not_portable" as const;

  private constructor(sentence: string) {
    super(sentence);
    Object.defineProperty(this, "message", {
      value: sentence,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    this.name = "NativeEnvironmentNameError";
    rendered.set(this, sentence);
  }

  /** A host hook or process (`invocation` is its validated contract name). */
  static forHostCommand(opts: {
    readonly invocation: string;
    readonly variable: string;
  }): NativeEnvironmentNameError {
    const command = HOST_COMMAND.test(opts.invocation)
      ? `Host command ${opts.invocation}`
      : "A host command";
    return new NativeEnvironmentNameError(
      `${command} sets environment variable ${displayEnvName(opts.variable)}, ${RULE}`
    );
  }

  /**
   * The compiler's `invalid_environment_key` diagnostic for a key of an
   * `environment` map, from its RFC 6901 pointer; undefined for anything else
   * (for example an invalid `env_ref`).
   */
  static fromCompilerDiagnostic(diagnostic: {
    readonly code: string;
    readonly pointer: string;
  }): NativeEnvironmentNameError | undefined {
    if (diagnostic.code !== "invalid_environment_key") {
      return;
    }
    const tokens = diagnostic.pointer.split("/");
    const key = tokens.at(-1);
    if (
      tokens.length < 3 ||
      tokens[0] !== "" ||
      tokens.at(-2) !== "environment" ||
      key === undefined
    ) {
      return;
    }
    const variable = key.replaceAll("~1", "/").replaceAll("~0", "~");
    const location = tokens.slice(0, -1).join("/");
    return new NativeEnvironmentNameError(
      `Project configuration sets environment variable ${displayEnvName(variable)} at ${displayEnvName(location)}, ${RULE}`
    );
  }
}

/** The construction-time sentence of a genuine instance, else undefined. */
export function renderNativeEnvironmentNameError(
  error: unknown
): string | undefined {
  return error instanceof NativeEnvironmentNameError
    ? rendered.get(error)
    : undefined;
}

/** A genuine instance, for code that passes it across a redaction boundary. */
export function isNativeEnvironmentNameError(
  error: unknown
): error is NativeEnvironmentNameError {
  return renderNativeEnvironmentNameError(error) !== undefined;
}

/** The named refusal among compiler diagnostics, if any. */
export function environmentNameRefusal(
  diagnostics: readonly { readonly code: string; readonly pointer: string }[]
): NativeEnvironmentNameError | undefined {
  for (const diagnostic of diagnostics) {
    const refusal =
      NativeEnvironmentNameError.fromCompilerDiagnostic(diagnostic);
    if (refusal) {
      return refusal;
    }
  }
  return;
}
