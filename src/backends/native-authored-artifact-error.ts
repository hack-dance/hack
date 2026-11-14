import { AsyncLocalStorage } from "node:async_hooks";
import { dirname } from "node:path";
import {
  NativeComposeGenerationError,
  NativeComposeInspectionError,
} from "../lib/native-compose-private-state.ts";
import { LifecycleSessionPresenceUnknownError } from "../lib/project-lifecycle-sessions.ts";
import { MuxCommandTimeoutError } from "../mux/mux-backend.ts";

export type NativeAuthoredArtifactPhase =
  | "scope"
  | "directories"
  | "private-store"
  | "action";
type ArtifactCause =
  | "artifact_refused"
  | "lock_busy"
  | "lock_inspection_timeout"
  | "lock_inspection_failed"
  | "lock_inspection_malformed"
  | "mux_timeout"
  | "mux_presence_unknown"
  | "host_deadline"
  | "io_failed"
  | "action_failed";
/** Closed errno names. Anything else reports no system code, never its raw value. */
const SYSTEM_CODES = new Set([
  "E2BIG",
  "EACCES",
  "EADDRINUSE",
  "EADDRNOTAVAIL",
  "EAGAIN",
  "EBADF",
  "EBUSY",
  "ECANCELED",
  "ECHILD",
  "ECONNREFUSED",
  "ECONNRESET",
  "EEXIST",
  "EFAULT",
  "EFBIG",
  "EINTR",
  "EINVAL",
  "EIO",
  "EISDIR",
  "ELOOP",
  "EMFILE",
  "EMLINK",
  "ENAMETOOLONG",
  "ENFILE",
  "ENODEV",
  "ENOENT",
  "ENOEXEC",
  "ENOMEM",
  "ENOSPC",
  "ENOTCONN",
  "ENOTDIR",
  "ENOTEMPTY",
  "ENOTSOCK",
  "ENOTSUP",
  "ENXIO",
  "EOPNOTSUPP",
  "EPERM",
  "EPIPE",
  "EROFS",
  "ESPIPE",
  "ESRCH",
  "ETIMEDOUT",
  "ETXTBSY",
  "EXDEV",
]);
type ErrorClass =
  | "TypeError"
  | "RangeError"
  | "SyntaxError"
  | "ReferenceError"
  | "AggregateError"
  | "DOMException"
  | "Error"
  | "non_error";
const ERROR_CLASSES: readonly [
  abstract new (...args: never[]) => unknown,
  ErrorClass,
][] = [
  [TypeError, "TypeError"],
  [RangeError, "RangeError"],
  [SyntaxError, "SyntaxError"],
  [ReferenceError, "ReferenceError"],
  [AggregateError, "AggregateError"],
  [DOMException, "DOMException"],
  [Error, "Error"],
];
/** Source frames kept per failure; enough for a refusal helper and its callers. */
const MAX_SITES = 4;
const SOURCE_FRAME = /\(?([^\s()]+\.ts):(\d+):\d+\)?\s*$/;
/** This checkout's `src/`; frames outside it (tests, dependencies, a bundle) are dropped. */
const SOURCE_ROOT = `${dirname(import.meta.dir)}/`;
const SITE_PATH = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.ts$/;
const INSPECTION_CAUSES = {
  timeout: "lock_inspection_timeout",
  failed: "lock_inspection_failed",
  malformed: "lock_inspection_malformed",
} as const;
export type NativeAuthoredArtifactDiagnostic = Readonly<{
  phase: NativeAuthoredArtifactPhase;
  cause_code: ArtifactCause;
  inspection: "boot-session" | "process-birth" | null;
  elapsed_ms: number | null;
  system_code: string | null;
  /** Built-in class of the thrown value; subclasses report their nearest built-in. */
  error_class: ErrorClass | null;
  /**
   * Innermost Hack source frames (`backends/file.ts:line`, relative to `src/`).
   * A fixed source location, never a path prefix, message or value. Empty when the
   * error carries no own stack (native fs errors) or runs from a compiled bundle.
   */
  sites: readonly string[];
}>;
type Diagnostic = NativeAuthoredArtifactDiagnostic;
const issuedDiagnostics = new WeakMap<object, Diagnostic>();
const diagnosticObservers = new AsyncLocalStorage<
  (diagnostic: Diagnostic) => void
>();

/** Observe only closed metadata before an outer startup boundary replaces an error. */
export function observeNativeAuthoredArtifactErrors<T>(opts: {
  readonly onDiagnostic: (diagnostic: Diagnostic) => void;
  readonly action: () => T;
}): T {
  return diagnosticObservers.run(opts.onDiagnostic, opts.action);
}

/** A caller's monotonic host-operation budget expired; carries no callback data. */
export class NativeAuthoredHostDeadlineError extends Error {
  constructor() {
    super("Native authored host operation expired; values omitted.");
  }
}

function closedFailure(diagnostic: Diagnostic): NativeAuthoredArtifactError {
  const failure = new NativeAuthoredArtifactError(diagnostic);
  issuedDiagnostics.set(failure, failure.diagnostic);
  try {
    const observed: unknown = diagnosticObservers.getStore()?.(
      failure.diagnostic
    );
    void Promise.resolve(observed).catch(() => undefined);
  } catch {
    // Optional diagnostics never change admission or recovery outcomes.
  }
  return failure;
}

/** Fixed refusal plus closed diagnostic fields; raw child, callback and filesystem errors stay private. */
export class NativeAuthoredArtifactError extends Error {
  readonly diagnostic: Diagnostic;
  constructor(diagnostic: Diagnostic) {
    super(
      "Native authored run artifact is unsafe, changed, or owned by another run; inspect native state before retrying. Values omitted."
    );
    this.diagnostic = Object.freeze({
      ...diagnostic,
      sites: Object.freeze([...diagnostic.sites]),
    });
  }
}

/** Preserve the innermost diagnostic without retaining an arbitrary error, stack or path as its cause. */
export function nativeAuthoredArtifactError(
  error: unknown,
  phase: NativeAuthoredArtifactPhase
): NativeAuthoredArtifactError {
  try {
    return classifyArtifactError(error, phase);
  } catch {
    // Even a rejected proxy's prototype/descriptor traps remain private.
    return closedFailure({
      phase,
      cause_code: "action_failed",
      inspection: null,
      elapsed_ms: null,
      system_code: null,
      error_class: null,
      sites: [],
    });
  }
}

/** Read only own data properties: getters and proxy traps never run here. */
function ownData(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function errorClass(error: unknown): ErrorClass | null {
  try {
    for (const [builtIn, name] of ERROR_CLASSES) {
      if (error instanceof builtIn) {
        return name;
      }
    }
    return "non_error";
  } catch {
    return null;
  }
}

/** Keep Hack source locations relative to `src/`; the checkout prefix never leaves. */
function sourceSites(error: unknown): string[] {
  if (typeof error !== "object" || error === null) {
    return [];
  }
  const stack = ownData(error, "stack");
  if (typeof stack !== "string") {
    return [];
  }
  const sites: string[] = [];
  for (const line of stack.split("\n", 64)) {
    const match = SOURCE_FRAME.exec(line);
    const path = match?.[1];
    if (!(path?.startsWith(SOURCE_ROOT) && match?.[2])) {
      continue;
    }
    const relative = path.slice(SOURCE_ROOT.length);
    if (!SITE_PATH.test(relative) || match[2].length > 6) {
      continue;
    }
    sites.push(`${relative}:${match[2]}`);
    if (sites.length === MAX_SITES) {
      break;
    }
  }
  return sites;
}

function inspectionFields(
  error: NativeComposeInspectionError
): Pick<Diagnostic, "cause_code" | "inspection" | "elapsed_ms"> {
  const cause =
    error.outcome === "timeout" || error.outcome === "malformed"
      ? error.outcome
      : "failed";
  return {
    cause_code: INSPECTION_CAUSES[cause],
    inspection:
      error.observation === "boot-session" ||
      error.observation === "process-birth"
        ? error.observation
        : null,
    elapsed_ms:
      Number.isSafeInteger(error.elapsedMs) &&
      error.elapsedMs >= 0 &&
      error.elapsedMs <= 300_000
        ? error.elapsedMs
        : null,
  };
}

function classifyArtifactError(
  error: unknown,
  phase: NativeAuthoredArtifactPhase
): NativeAuthoredArtifactError {
  const base = {
    phase,
    inspection: null,
    elapsed_ms: null,
    system_code: null,
    error_class: errorClass(error),
    sites: sourceSites(error),
  } as const;
  if (typeof error === "object" && error !== null) {
    const original = issuedDiagnostics.get(error);
    if (original) {
      return closedFailure(original);
    }
  }
  if (error instanceof NativeComposeInspectionError) {
    return closedFailure({
      ...base,
      ...inspectionFields(error),
    });
  }
  if (error instanceof NativeComposeGenerationError) {
    return closedFailure({
      ...base,
      cause_code:
        error.code === "E_NATIVE_COMPOSE_BUSY"
          ? "lock_busy"
          : "artifact_refused",
    });
  }
  if (error instanceof NativeAuthoredHostDeadlineError) {
    return closedFailure({ ...base, cause_code: "host_deadline" });
  }
  if (error instanceof MuxCommandTimeoutError) {
    return closedFailure({
      ...base,
      cause_code: "mux_timeout",
    });
  }
  if (error instanceof LifecycleSessionPresenceUnknownError) {
    return closedFailure({
      ...base,
      cause_code: "mux_presence_unknown",
    });
  }
  // An arbitrary callback can reject with a proxy. Its traps are not diagnostics.
  const code =
    typeof error === "object" && error !== null
      ? ownData(error, "code")
      : undefined;
  if (typeof code === "string" && SYSTEM_CODES.has(code)) {
    return closedFailure({
      ...base,
      cause_code: "io_failed",
      system_code: code,
    });
  }
  return closedFailure({
    ...base,
    cause_code: phase === "action" ? "action_failed" : "artifact_refused",
  });
}
