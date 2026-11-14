import { AsyncLocalStorage } from "node:async_hooks";
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
const SYSTEM_CODES = new Set([
  "EACCES",
  "EAGAIN",
  "EBUSY",
  "EEXIST",
  "EIO",
  "EMFILE",
  "ENFILE",
  "ENOENT",
  "ENOSPC",
  "EPERM",
]);
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
    this.diagnostic = Object.freeze({ ...diagnostic });
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
    });
  }
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
  let code: unknown;
  try {
    code =
      typeof error === "object" && error !== null
        ? Object.getOwnPropertyDescriptor(error, "code")?.value
        : undefined;
  } catch {
    // An arbitrary callback can reject with a proxy. Its traps are not diagnostics.
    code = undefined;
  }
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
