/**
 * Value-free diagnostics for closed refusals.
 *
 * A closed refusal keeps a fixed, value-free message, so the fault behind it
 * would otherwise be lost to tests and debugging. These helpers keep only the
 * fault's class name and identifier-shaped errno code (for example
 * `Error:EACCES`), never its message or path, as a non-enumerable own property
 * rather than `cause`. Envelopes, printed errors and serializers therefore stay
 * unchanged.
 */

/** Non-enumerable own property holding a refusal's diagnostic. */
const DIAGNOSTIC_PROPERTY = "diagnosticCause";
const DIAGNOSTIC_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const DIAGNOSTIC = /^[A-Za-z][A-Za-z0-9]{0,63}(?::[A-Z][A-Z0-9_]{0,63})?$/;

/** Class name and identifier-shaped code of `error`; never its message. */
export function valueFreeErrorDiagnostic(error: unknown): string {
  if (!(error instanceof Error)) {
    return error === null ? "null" : typeof error;
  }
  const name = DIAGNOSTIC_NAME.test(error.name) ? error.name : "Error";
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" && DIAGNOSTIC_CODE.test(code)
    ? `${name}:${code}`
    : name;
}

/**
 * Attach `diagnostic` to `target` as a non-enumerable own property, or
 * `fallback` when `diagnostic` is not identifier-shaped.
 */
export function attachValueFreeDiagnostic(opts: {
  readonly target: object;
  readonly diagnostic: string;
  readonly fallback: string;
}): void {
  Object.defineProperty(opts.target, DIAGNOSTIC_PROPERTY, {
    value: DIAGNOSTIC.test(opts.diagnostic) ? opts.diagnostic : opts.fallback,
    enumerable: false,
  });
}

/** The attached diagnostic of `target`, or undefined when none is valid. */
export function readValueFreeDiagnostic(target: object): string | undefined {
  const diagnostic: unknown = Reflect.get(target, DIAGNOSTIC_PROPERTY);
  return typeof diagnostic === "string" && DIAGNOSTIC.test(diagnostic)
    ? diagnostic
    : undefined;
}
