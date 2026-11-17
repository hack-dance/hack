import { AsyncLocalStorage } from "node:async_hooks";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { types } from "node:util";
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
/** A V8/JSC frame line only: message text and other lines never count as frames. */
const SOURCE_FRAME =
  /^ {4}at (?:.{0,200} \()?([^\s()]{1,400}\.ts):(\d{1,6}):\d{1,6}\)?$/;
/** Bounds before any matching, so a huge message cannot stall failure handling. */
const MAX_STACK_CHARS = 16_384;
const MAX_FRAME_CHARS = 640;
const MAX_SOURCE_FILES = 8192;
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

/**
 * Whether a value or anything on its prototype chain is a proxy. Checked before any
 * reflection or `instanceof`, which would otherwise run its traps. `types.isProxy`
 * and `Object.getPrototypeOf` on a non-proxy run no user code.
 */
function involvesProxy(value: object): boolean {
  let current: object | null = value;
  for (let depth = 0; current !== null; depth += 1) {
    if (depth === 64 || types.isProxy(current)) {
      return true;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return false;
}

/** One read of an own data property; accessors are never invoked. Callers exclude proxies. */
function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function errorClass(error: unknown): ErrorClass {
  for (const [builtIn, name] of ERROR_CLASSES) {
    if (error instanceof builtIn) {
      return name;
    }
  }
  return "non_error";
}

let sourceInventory: ReadonlySet<string> | undefined;
/**
 * Hack's own `src/` files, relative to it, read once. A site must name one of them,
 * so a forged stack can only point at a real source file, never carry other text.
 * Empty in a compiled bundle, where frames name no checkout files.
 */
function sources(): ReadonlySet<string> {
  if (sourceInventory) {
    return sourceInventory;
  }
  const found = new Set<string>();
  const pending = [""];
  try {
    while (pending.length > 0 && found.size < MAX_SOURCE_FILES) {
      const relative = pending.pop() ?? "";
      for (const entry of readdirSync(join(SOURCE_ROOT, relative), {
        withFileTypes: true,
      })) {
        const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) {
          pending.push(path);
        } else if (entry.isFile() && SITE_PATH.test(path)) {
          found.add(path);
        }
      }
    }
  } catch {
    // No readable source tree: no sites.
  }
  sourceInventory = found;
  return found;
}

const sourceLines = new Map<string, number>();
/** The number of lines in an inventory file, read once; 0 when unreadable. */
function lineCount(relative: string): number {
  let count = sourceLines.get(relative);
  if (count === undefined) {
    try {
      count = readFileSync(join(SOURCE_ROOT, relative), "utf8").split(
        "\n"
      ).length;
    } catch {
      count = 0;
    }
    sourceLines.set(relative, count);
  }
  return count;
}

/**
 * Hack source locations relative to `src/`, from frame lines only, naming files in
 * the source inventory at a line that file has. The checkout prefix, message and
 * any other text never leave. These are hints, not proof: a stack is writable, so
 * code that rewrites it can still name the wrong line of a real file. The lines
 * of the error's own message are skipped, so message text never counts as a
 * frame.
 */
function sourceSites(error: object): string[] {
  const stack = ownData(error, "stack");
  if (typeof stack !== "string") {
    return [];
  }
  const message = ownData(error, "message");
  const headerLines =
    typeof message === "string" ? message.split("\n", 65).length : 1;
  // A message too long to skip within the budget could still hold
  // frame-shaped lines: report no sites rather than misattribute one.
  if (headerLines > 64) {
    return [];
  }
  const sites: string[] = [];
  for (const line of stack
    .slice(0, MAX_STACK_CHARS)
    .split("\n", 64 + headerLines)
    .slice(headerLines)) {
    if (line.length > MAX_FRAME_CHARS) {
      continue;
    }
    const match = SOURCE_FRAME.exec(line);
    const path = match?.[1];
    if (!(path?.startsWith(SOURCE_ROOT) && match?.[2])) {
      continue;
    }
    const relative = path.slice(SOURCE_ROOT.length);
    const lineNumber = Number(match[2]);
    if (
      !sources().has(relative) ||
      lineNumber < 1 ||
      lineNumber > lineCount(relative)
    ) {
      continue;
    }
    sites.push(`${relative}:${match[2]}`);
    if (sites.length === MAX_SITES) {
      break;
    }
  }
  return sites;
}

/** Each field is read once as an own data property; a subclass getter yields null. */
function inspectionFields(
  error: NativeComposeInspectionError
): Pick<Diagnostic, "cause_code" | "inspection" | "elapsed_ms"> {
  const outcome = ownData(error, "outcome");
  const observation = ownData(error, "observation");
  const elapsed = ownData(error, "elapsedMs");
  const cause =
    outcome === "timeout" || outcome === "malformed" ? outcome : "failed";
  return {
    cause_code: INSPECTION_CAUSES[cause],
    inspection:
      observation === "boot-session" || observation === "process-birth"
        ? observation
        : null,
    elapsed_ms:
      typeof elapsed === "number" &&
      Number.isSafeInteger(elapsed) &&
      elapsed >= 0 &&
      elapsed <= 300_000
        ? elapsed
        : null,
  };
}

/**
 * A reissued diagnostic, or the generic refusal for a proxy. A proxy is refused
 * before any reflection, so none of its traps ever runs. Undefined otherwise.
 */
function settledWithoutReflection(
  error: object,
  phase: NativeAuthoredArtifactPhase
): NativeAuthoredArtifactError | undefined {
  const original = issuedDiagnostics.get(error);
  if (original) {
    return closedFailure(original);
  }
  if (involvesProxy(error)) {
    return closedFailure({
      phase,
      cause_code: phase === "action" ? "action_failed" : "artifact_refused",
      inspection: null,
      elapsed_ms: null,
      system_code: null,
      error_class: null,
      sites: [],
    });
  }
  return undefined;
}

function classifyArtifactError(
  error: unknown,
  phase: NativeAuthoredArtifactPhase
): NativeAuthoredArtifactError {
  const isObject =
    (typeof error === "object" && error !== null) ||
    typeof error === "function";
  const settled = isObject ? settledWithoutReflection(error, phase) : undefined;
  if (settled) {
    return settled;
  }
  const base = {
    phase,
    inspection: null,
    elapsed_ms: null,
    system_code: null,
    error_class: errorClass(error),
    sites: isObject ? sourceSites(error) : [],
  } as const;
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
        ownData(error, "code") === "E_NATIVE_COMPOSE_BUSY"
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
  const code = isObject ? ownData(error, "code") : undefined;
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
