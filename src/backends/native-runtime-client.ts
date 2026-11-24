import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { childEnvironment } from "../lib/child-environment.ts";
import { ClosedCliError, HackCliError } from "../lib/cli-result.ts";
import { startupTimingSpawn } from "../lib/command-timings.ts";
import { isRecord } from "../lib/guards.ts";
import { normalizeHomeDir, readAbsolutePathOverride } from "../lib/home-dir.ts";
import {
  type NativeProcessRefusal,
  readNativeProcessRefusals,
} from "../lib/native-process-wrappers.ts";
import { stepStoreRuntimeArgs } from "../lib/step-store/location.ts";
import type { SubprocessSignal } from "../lib/subprocess-signal.ts";
import { nativeAdmissionReuseEnvironment } from "./native-admission-reuse.ts";
import { nativeAuthoredExecOptions } from "./native-authored-exec-options.ts";
import { nativeBetaCandidatePointer } from "./native-beta.ts";
import {
  type NativeConfigurationRefusal,
  readNativeConfigurationRefusals,
} from "./native-configuration-refusals.ts";
import { nativeHotReloadEnvironment } from "./native-hot-reload-notice.ts";
import {
  nativeImageRegistryReason,
  pendingImageProofReason,
} from "./native-image-policy.ts";
import {
  type NativePlanChange,
  nativePlanChangeGuidance,
  readNativePlanChange,
} from "./native-plan-change.ts";
import {
  NATIVE_STARTUP_FAILURE_REPLY_BYTES,
  type NativeStartupLogTail,
  readNativeStartupLogs,
} from "./native-startup-logs.ts";
import {
  type NativeStopFailure,
  nativeStopFailureSummary,
  readNativeStopFailures,
} from "./native-stop-diagnostics.ts";

export const NATIVE_BUILD_RETENTION_TIMEOUT_MS = 30 * 60_000 + 5000;

const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const NATIVE_SERVICE = /^[A-Za-z0-9_.-]{1,128}$/;
const NATIVE_TAIL = /^[1-9][0-9]{0,3}$/;
const NATIVE_RUN = /^[a-f0-9]{32}$/;
const NATIVE_HASH = /^[a-f0-9]{64}$/;
interface NativeFailure {
  readonly configurationRefusals?: readonly NativeConfigurationRefusal[];
  readonly code: string;
  readonly logPhase?: NativeLogFailurePhase;
  readonly causeCode?: string;
  /** Fixed runtime text, or fixed guidance rendered from a validated diagnostic. */
  readonly message?: string;
  /** Admitted service the runtime named, as a plain service identifier. */
  readonly service?: string;
  readonly stopFailures?: readonly NativeStopFailure[];
  readonly startupLogs?: readonly NativeStartupLogTail[];
  /** Services and closed fields a process wrapper refused; value-free. */
  readonly processRefusals?: readonly NativeProcessRefusal[];
  readonly planChange?: NativePlanChange;
}

const NATIVE_LOG_PHASES = [
  "admission",
  "periodic-check",
  "final-check",
  "status-line",
  "headers",
  "http-framing",
  "frame-header",
  "payload",
  "timestamp",
] as const;
export type NativeLogFailurePhase = (typeof NATIVE_LOG_PHASES)[number];
function nativeLogPhase(value: unknown): NativeLogFailurePhase | undefined {
  return NATIVE_LOG_PHASES.find((phase) => phase === value);
}

const FIXED_MESSAGE = /^[\x20-\x7e]{1,400}$/;
const FIXED_MESSAGE_LIMIT = 400;
const PROVIDER_SAID = "The provider's own error:";
const PROVIDER_LINE_MINIMUM = 40;
const TRAILING_SLASHES = /\/+$/;

/**
 * Keep a runtime message only when the runtime marked it fixed (a literal that
 * cannot carry runtime values) and it is one bounded printable line.
 */
function fixedNativeMessage(
  value: Record<string, unknown>
): string | undefined {
  const fixed =
    value.message_fixed === true &&
    typeof value.message === "string" &&
    FIXED_MESSAGE.test(value.message)
      ? value.message
      : undefined;
  const said = nativeProviderLine(value);
  if (said === undefined) {
    return fixed;
  }
  if (fixed === undefined) {
    return `${PROVIDER_SAID} ${said}`;
  }
  // Both, while they fit the one bounded line every failure channel accepts;
  // the fixed sentence wins and the provider's line is cut to what is left.
  const room = FIXED_MESSAGE_LIMIT - fixed.length - PROVIDER_SAID.length - 2;
  if (room < PROVIDER_LINE_MINIMUM) {
    return fixed;
  }
  const line = said.length <= room ? said : `${said.slice(0, room - 3)}...`;
  return `${fixed} ${PROVIDER_SAID} ${line}`;
}

/** The only failures a provider's line may accompany. */
const PROVIDER_FAILURES = new Set([
  "provider_command_failed",
  "provider_boot_stalled",
]);
/** A `key=value` token keeps its value only as a short number or one of these words. */
const PLAIN_VALUE = /^(?:\d{0,10}|on|off|true|false|yes|no|none)$/i;
// Up to the last `@` before the first `/`, `?` or `#`: a password may hold an
// `@`, and one in a query must not hide the query's `=` from the next rule.
const URL_CREDENTIALS = /(:\/\/)[^/?#\s]+@/g;
const WHITE_SPACE = /\s+/;
const PROVIDER_LINE_LIMIT = 200;
const LONG_HEX = /[0-9a-fA-F]{12,}/g;

/** One printable ASCII line of 1 to 200 characters, checked character by character. */
function boundedPrintableLine(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) {
      return false;
    }
  }
  return true;
}

/**
 * The provider's own last error line for a failed provider command (HACK-2418).
 * The runtime cleans it; this boundary does not rely on that. The line is
 * accepted only with a provider failure code and only as one printable ASCII
 * line of at most 200 characters, and it is redacted again here: the user's
 * home and temporary directory, the value of a `key=value` token unless it
 * is a short number or a fixed word such as `on` or `false`, a bearer token, a
 * user and password in a URL, and long hexadecimal identifiers.
 */
export function nativeProviderLine(
  value: Record<string, unknown>,
  env: Readonly<Record<string, string | undefined>> = process.env
): string | undefined {
  const line = value.provider_line;
  if (
    !(
      typeof value.code === "string" &&
      PROVIDER_FAILURES.has(value.code) &&
      boundedPrintableLine(line)
    )
  ) {
    return;
  }
  let text = line;
  for (const [path, word] of [
    [env.HOME, "~"],
    [env.TMPDIR?.replace(TRAILING_SLASHES, ""), "<tmp>"],
  ] as const) {
    if (path !== undefined && path.length > 2) {
      text = text.split(path).join(word);
    }
  }
  let afterBearer = false;
  const redacted = text
    .split(WHITE_SPACE)
    .filter((token) => token !== "")
    .map((token) => {
      const bearer = afterBearer;
      afterBearer = token.toLowerCase() === "bearer";
      if (bearer) {
        return "<value>";
      }
      // Anything after the first `=` is shown only when it is plainly not a
      // secret; a short value is not safe by being short.
      // URL credentials go first: a password may hold an equals sign.
      const safe = token.replace(URL_CREDENTIALS, "$1<credentials>@");
      const equals = safe.indexOf("=");
      const head = (equals < 0 ? safe : safe.slice(0, equals)).replace(
        LONG_HEX,
        "<id>"
      );
      if (equals < 0) {
        return head;
      }
      const value = safe.slice(equals + 1);
      return `${head}=${PLAIN_VALUE.test(value) ? value : "<value>"}`;
    })
    .join(" ");
  // Redaction can lengthen the line: the bound holds for what is shown.
  return redacted.length <= PROVIDER_LINE_LIMIT
    ? redacted
    : `${redacted.slice(0, PROVIDER_LINE_LIMIT - 3)}...`;
}

const NETWORK_HOST = /^[a-zA-Z0-9_.:[\]-]{1,253}$/;

/**
 * Why a registry layer download's last attempt failed (`network_request` version 2).
 * A closed vocabulary; `http_status` also carries the status code.
 */
const LAYER_FAILURE_REASONS: Readonly<Record<string, string>> = {
  timeout: "the transfer timed out",
  short_read: "the connection ended before the whole layer arrived",
  digest_mismatch: "the layer did not match its digest",
  size_mismatch: "the layer did not match its size",
  http_status: "the registry answered HTTP",
  deadline: "the 360-second image deadline was reached",
};

/** The version-2 reason sentence, or undefined unless every field is closed. */
function layerFailureReason(
  request: Record<string, unknown>
): string | undefined {
  const reason =
    typeof request.reason === "string" &&
    Object.hasOwn(LAYER_FAILURE_REASONS, request.reason)
      ? request.reason
      : undefined;
  if (!reason) {
    return;
  }
  const keys = Object.keys(request).length;
  if (reason !== "http_status") {
    return keys === 4 ? LAYER_FAILURE_REASONS[reason] : undefined;
  }
  return keys === 5 &&
    typeof request.status === "number" &&
    Number.isInteger(request.status) &&
    request.status >= 100 &&
    request.status <= 599
    ? `${LAYER_FAILURE_REASONS[reason]} ${request.status}`
    : undefined;
}

/** Render only a parsed authority and bounded count, never a runtime message or URL. */
function networkRequestFailureMessage(
  value: Record<string, unknown>
): string | undefined {
  const request = value.network_request;
  if (
    !(
      ["registry_image", "setup_download", "setup_download_deadline"].includes(
        typeof value.code === "string" ? value.code : ""
      ) && isRecord(request)
    ) ||
    typeof request.host !== "string" ||
    !NETWORK_HOST.test(request.host) ||
    typeof request.attempts !== "number" ||
    !Number.isInteger(request.attempts) ||
    request.attempts < 0 ||
    request.attempts > 3
  ) {
    return;
  }
  if (request.version === 1 && Object.keys(request).length === 3) {
    return `Network request to ${request.host} failed after ${request.attempts} attempt(s).`;
  }
  const reason =
    request.version === 2 && value.code === "registry_image"
      ? layerFailureReason(request)
      : undefined;
  return reason
    ? `Registry layer download from ${request.host} failed after ${request.attempts} attempt(s): ${reason}.`
    : undefined;
}

/** The native VM pool outlives a failed start; say how to stop it. */
export const NATIVE_IDLE_POOL_NOTE =
  "The native VM pool may still be running; when no other native project uses it, stop it with runtime down --json on this native home.";

/** A state path relative to the native state root, or one final name; never absolute. */
const STATE_COMPONENT =
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,15}$/;

/**
 * Render the closed `invalid_state` location: which state path exists but is not a
 * directory, relative to the native home's `.hack-local` root. Never runtime text.
 */
function stateComponentFailureMessage(
  value: Record<string, unknown>
): string | undefined {
  const component = value.state_component;
  if (
    value.code !== "invalid_state" ||
    !isRecord(component) ||
    Object.keys(component).length !== 2 ||
    component.version !== 1 ||
    typeof component.path !== "string" ||
    component.path.length > 240 ||
    !STATE_COMPONENT.test(component.path)
  ) {
    return;
  }
  return `The native state path ${component.path} exists but is not a directory. Inspect it in the native home; do not delete it to retry.`;
}

const COUNT = (value: unknown, max: number): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= max;

/**
 * Render the closed `bridge_socket_timeout` counts (HACK-2341): how many of the pool's
 * bridge sockets were missing or not yet private when the fresh-boot deadline passed,
 * after the runtime's fixed recovery sentence. Counts only; never paths.
 */
function bridgeSocketsFailureMessage(
  value: Record<string, unknown>
): string | undefined {
  const sockets = value.bridge_sockets;
  if (
    value.code !== "bridge_socket_timeout" ||
    !isRecord(sockets) ||
    Object.keys(sockets).length !== 5 ||
    sockets.version !== 1 ||
    !COUNT(sockets.expected, 32) ||
    sockets.expected === 0 ||
    !COUNT(sockets.missing, 32) ||
    !COUNT(sockets.not_private, 32) ||
    sockets.missing + sockets.not_private > sockets.expected ||
    !COUNT(sockets.budget_seconds, 3600)
  ) {
    return;
  }
  const counts = `At the ${sockets.budget_seconds}-second deadline, bridge sockets missing: ${sockets.missing} of ${sockets.expected}; not yet private: ${sockets.not_private}.`;
  const fixed = fixedNativeMessage(value);
  return fixed ? `${fixed} ${counts}` : counts;
}

const EXEC_STAGES = new Set([
  "create",
  "connect",
  "start",
  "hello",
  "deliver",
  "release",
  "output",
  "inspect",
]);
const EXEC_REASONS: Readonly<Record<string, string>> = {
  deadline: "the deadline passed",
  closed: "the stream closed early",
  io: "a transport error",
  protocol: "an unexpected response",
};
/** Stages at which the environment launcher may already hold every value byte. */
const EXEC_MAY_HAVE_RUN = new Set(["release", "output", "inspect"]);

/**
 * Render the closed private exec step (HACK-2357) after the runtime's fixed sentence:
 * which step failed and why. Every field is a closed name; never argv, values or output.
 */
/** The closed `exec_stage` shape, consistent with the error code, or undefined. */
function closedExecStage(
  value: Record<string, unknown>
): { stage: string; reason: string } | undefined {
  const exec = value.exec_stage;
  const uncertain = value.code === "graph_service_exec_uncertain";
  if (!(uncertain || value.code === "graph_service_exec_not_run")) {
    return;
  }
  if (!isRecord(exec) || Object.keys(exec).length !== 4 || exec.version !== 1) {
    return;
  }
  const { stage, reason } = exec;
  if (
    typeof stage !== "string" ||
    !EXEC_STAGES.has(stage) ||
    typeof reason !== "string" ||
    !Object.hasOwn(EXEC_REASONS, reason)
  ) {
    return;
  }
  const mayHaveRun = EXEC_MAY_HAVE_RUN.has(stage);
  return exec.command_may_have_run === mayHaveRun && mayHaveRun === uncertain
    ? { stage, reason }
    : undefined;
}

function execStageFailureMessage(
  value: Record<string, unknown>
): string | undefined {
  const exec = closedExecStage(value);
  if (!exec) {
    return;
  }
  const step = `The ${exec.stage} step failed: ${EXEC_REASONS[exec.reason]}.`;
  const fixed = fixedNativeMessage(value);
  return fixed ? `${fixed} ${step}` : step;
}

/** What an unhealthy probe last observed (route probe diagnostic version 2, HACK-2416). */
// A Map, not an object literal: inherited keys such as "toString" are not reasons.
const PROBE_REASONS: ReadonlyMap<string, string> = new Map([
  ["exec_not_running", "the probe process inside the container was gone"],
  ["exec_exited", "the probe process inside the container exited"],
  ["sample_missing", "the probe never wrote a result"],
  ["sample_invalid", "the probe's result could not be read"],
  ["sample_clock_ahead", "the guest clock was ahead of the host's"],
  ["sample_stale", "the probe's last result was too old"],
  [
    "failures_exhausted",
    "the route answered no request in time, retries exhausted",
  ],
]);
const PROBE_COUNT = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 1e12;

function routeProbeObservation(probe: Record<string, unknown>): string | null {
  const reason =
    typeof probe.reason === "string"
      ? PROBE_REASONS.get(probe.reason)
      : undefined;
  if (!(reason && PROBE_COUNT(probe.since_start_ms))) {
    return null;
  }
  for (const key of ["sequence", "failures", "last_elapsed_ms"]) {
    if (probe[key] !== undefined && !PROBE_COUNT(probe[key])) {
      return null;
    }
  }
  const allowed = new Set([
    "version",
    "port",
    "reason",
    "sequence",
    "failures",
    "last_elapsed_ms",
    "since_start_ms",
  ]);
  if (Object.keys(probe).some((key) => !allowed.has(key))) {
    return null;
  }
  const counts =
    typeof probe.sequence === "number"
      ? ` after ${probe.sequence} requests (${probe.failures ?? 0} failed in a row, the last took ${probe.last_elapsed_ms ?? 0} ms)`
      : "";
  return ` The probe observed that ${reason}${counts}, ${Math.round((probe.since_start_ms as number) / 1000)} s after it started.`;
}

/** Render only the closed inferred-route diagnostic; never runtime error text. */
function routeProbeFailureMessage(
  value: Record<string, unknown>,
  service: string | undefined
): string | undefined {
  const probe = value.route_probe;
  if (
    !(
      service &&
      ["graph_service_failed", "graph_startup_application_failed"].includes(
        typeof value.code === "string" ? value.code : ""
      ) &&
      isRecord(probe)
    ) ||
    typeof probe.port !== "number" ||
    !Number.isSafeInteger(probe.port) ||
    probe.port < 1 ||
    probe.port > 65_535
  ) {
    return;
  }
  let observed = "";
  if (probe.version === 1 && Object.keys(probe).length === 2) {
    observed = "";
  } else if (probe.version === 2) {
    const text = routeProbeObservation(probe);
    if (text === null) {
      return;
    }
    observed = text;
  } else {
    return;
  }
  return `Inferred route probe on port ${probe.port} is unhealthy.${observed} Check hack logs ${service} in the same project/branch, fix the route port, or declare healthcheck.x-hack-http with a longer start_period_ms and a readiness path, within the 300-second graph budget.`;
}

/** Fixed/closed diagnostic text and the validated service a failure carries. */
export function nativeFailureDetail(value: Record<string, unknown>): {
  message?: string;
  service?: string;
} {
  const service =
    typeof value.service === "string" && NATIVE_SERVICE.test(value.service)
      ? value.service
      : undefined;
  const message =
    networkRequestFailureMessage(value) ??
    stateComponentFailureMessage(value) ??
    pendingImageProofReason(value) ??
    bridgeSocketsFailureMessage(value) ??
    execStageFailureMessage(value) ??
    routeProbeFailureMessage(value, service) ??
    fixedNativeMessage(value);
  return {
    ...(message ? { message } : {}),
    ...(service ? { service } : {}),
  };
}

type SafeNativeFailure = Readonly<{
  code: string;
  message?: string;
  service?: string;
  /** Set only by the frontend's effect-free static review, never runtime output. */
  startupPhase?: "static-preflight";
}>;
/** Opaque association: never retain an error, its text, logs, causes or getters. */
const retainedFailures = new WeakMap<object, SafeNativeFailure>();

export function nativeRuntimeFailure(
  error: unknown
): SafeNativeFailure | undefined {
  return typeof error === "object" && error !== null
    ? retainedFailures.get(error)
    : undefined;
}

/** Preserve safe detail through a closed cleanup wrapper without an Error cause. */
export function retainNativeRuntimeFailure<T extends Error>(opts: {
  readonly error: T;
  readonly original: unknown;
}): T {
  const detail = nativeRuntimeFailure(opts.original);
  if (detail) {
    retainedFailures.set(opts.error, detail);
  }
  return opts.error;
}

/**
 * Value-free runtime detail appended after a closed native failure sentence:
 * fixed runtime text or closed probe guidance, and its validated service.
 */
export function nativeFailureNote(detail: {
  readonly message?: string;
  readonly service?: string;
}): string {
  if (detail.service && detail.message) {
    return ` Service ${detail.service}: ${detail.message}`;
  }
  if (detail.message) {
    return ` Runtime: ${detail.message}`;
  }
  return detail.service ? ` Service: ${detail.service}.` : "";
}

/**
 * Structured native codes remain safe to inspect without exposing subprocess
 * diagnostics. The message is closed, so the CLI prints it without a stack.
 */
export class NativeRuntimeRequestError extends ClosedCliError {
  /** Owned request child ended by a terminal stop signal, independent of frontend event ordering. */
  readonly stopSignal: "SIGINT" | "SIGTERM" | undefined;
  readonly nativeCode: string | undefined;
  readonly nativeCauseCode: string | undefined;
  /** Fixed/closed diagnostic text; see {@link nativeFailureNote}. */
  readonly nativeMessage: string | undefined;
  readonly nativeService: string | undefined;
  readonly nativeStopFailures: readonly NativeStopFailure[] | undefined;
  readonly nativeConfigurationRefusals:
    | readonly NativeConfigurationRefusal[]
    | undefined;

  constructor(opts: {
    readonly stopSignal?: "SIGINT" | "SIGTERM";
    readonly message: string;
    readonly nativeCode?: string;
    readonly nativeCauseCode?: string;
    /** Only safe text admitted by nativeFailureDetail; this can cross IPC. */
    readonly nativeMessage?: string;
    readonly nativeService?: string;
    readonly nativeStopFailures?: readonly NativeStopFailure[];
    readonly nativeConfigurationRefusals?: readonly NativeConfigurationRefusal[];
    readonly nativeStartupPhase?: "static-preflight";
  }) {
    super(opts.message);
    this.stopSignal = opts.stopSignal;
    this.nativeCode = opts.nativeCode;
    this.nativeCauseCode = opts.nativeCauseCode;
    this.nativeMessage = opts.nativeMessage;
    this.nativeService = opts.nativeService;
    this.nativeStopFailures = opts.nativeStopFailures;
    this.nativeConfigurationRefusals = opts.nativeConfigurationRefusals;
    if (opts.nativeCode && ERROR_CODE.test(opts.nativeCode)) {
      retainedFailures.set(
        this,
        Object.freeze({
          code: opts.nativeCode,
          ...(opts.nativeStartupPhase === "static-preflight"
            ? { startupPhase: "static-preflight" as const }
            : {}),
          ...nativeFailureDetail({
            message: opts.nativeMessage,
            message_fixed: true,
            service: opts.nativeService,
          }),
        })
      );
    }
  }
}

/** Preserve owned-child stop evidence through wrappers that replace other runtime failures. */
export function isNativeRuntimeStopError(
  error: unknown
): error is NativeRuntimeRequestError {
  return (
    error instanceof NativeRuntimeRequestError && error.stopSignal !== undefined
  );
}

/** Classify a child stop independently of when the frontend's signal handler is scheduled. */
function throwIfNativeRuntimeStopped(signal: SubprocessSignal | null): void {
  if (signal === "SIGINT" || signal === "SIGTERM") {
    throw new NativeRuntimeRequestError({
      message:
        "Native runtime request was interrupted; its outcome may be uncertain. No request was replayed.",
      stopSignal: signal,
    });
  }
}

/**
 * Native inspection code for a run whose journal is exactly absent and whose
 * foreground owner is not published: no runtime state was ever reserved. It is
 * point-in-time only; a caller must separately prove the run's consumer settled
 * (or cannot exist) before treating it as retirement authority.
 */
export const NATIVE_GRAPH_UNRESERVED = "native_graph_unreserved";

/** Native code for a read against a candidate runtime that is not running. */
export const NATIVE_RUNTIME_NOT_RUNNING = "runtime_not_running";

/**
 * True when a native request was refused because the candidate runtime is not
 * running. Direct requests report this before guest access. Authored foreground
 * control first authenticates its saved journal and owner, then wraps the same
 * runtime refusal in its fixed control code. Neither form supplies live health.
 * A read-only caller must still recheck its saved selection and executable.
 */
export function isNativeRuntimeNotRunning(error: unknown): boolean {
  return (
    error instanceof NativeRuntimeRequestError &&
    nativeCodesReportRuntimeNotRunning(error)
  );
}

/**
 * True when a bounded native code pair reports a stopped runtime, either
 * directly or wrapped by authored foreground control (see
 * {@link isNativeRuntimeNotRunning}). Callers that carry the codes without the
 * request error, such as a failed foreground start, classify with this.
 */
export function nativeCodesReportRuntimeNotRunning(codes: {
  readonly nativeCode?: string;
  readonly nativeCauseCode?: string;
}): boolean {
  return (
    codes.nativeCode === NATIVE_RUNTIME_NOT_RUNNING ||
    (codes.nativeCode === "native_graph_foreground" &&
      codes.nativeCauseCode === NATIVE_RUNTIME_NOT_RUNNING)
  );
}

export interface NativeRuntimeSelection {
  readonly binary: string;
  readonly home: string;
}

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_PRIVATE_INPUT_BYTES = 256 * 1024;
// Configuration refusals can originate during planning or startup, including
// authored graph native plan/frontend-plan. Keep the same bounded envelope for
// every structured error; startup output still requires its explicit decoder.
const MAX_NATIVE_FAILURE_BYTES = 1024 * 1024;

/**
 * Exit-relative bound on draining an owned native child's stdout and stderr.
 *
 * The native runtime writes its closed error code (and any response or
 * readiness line) before it exits, so those bytes are already in the pipes
 * when the exit is observed; with no other writer, EOF follows immediately
 * and the drain ends there. This bound only ends a drain that EOF cannot end:
 * a descendant that inherited a pipe and keeps it open. It is measured from
 * the observed exit, not from spawn, and is deliberately generous so that a
 * heavily oversubscribed host still schedules the pipe readers before it
 * expires. A 250 ms bound lost the closed code under load for the foreground
 * graph owner (HACK-1350) and for bounded one-shot requests (HACK-1387).
 * Shared by {@link invokeNativeRuntime} and the foreground graph owner. The
 * documented floor is 5 s; `tests/native-runtime-client.test.ts` fails if the
 * bound drops below it (HACK-1425).
 */
export const NATIVE_EXIT_DRAIN_BOUND_MS = 5000;
const REQUEST_BUDGET_REFUSAL =
  "Native runtime request exceeds its input or time budget.";
const SYSTEM_ENVIRONMENT = ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME"];

/** Explicit candidate selection never redirects installed v4 or starts Docker. */
export function resolveNativeRuntimeSelection(
  env: Readonly<Record<string, string | undefined>> = process.env
): NativeRuntimeSelection | null {
  if (env.HACK_RUNTIME_BACKEND !== "native") {
    return null;
  }
  return resolveNativeSetupSelection(env);
}

/** Native setup is explicit even when the project uses the Compose backend. */
export function resolveNativeSetupSelection(
  env: Readonly<Record<string, string | undefined>> = process.env
): NativeRuntimeSelection {
  let binary = env.HACK_NATIVE_BINARY?.trim();
  if (!binary) {
    const adjacent = join(dirname(process.execPath), "hack-native");
    try {
      accessSync(adjacent, constants.X_OK);
      binary = adjacent;
    } catch {
      binary = undefined;
    }
  }
  if (!(binary && isAbsolute(binary))) {
    throw new ClosedCliError(
      `Native runtime requires an adjacent bundled hack-native or an absolute HACK_NATIVE_BINARY path. ${nativeBetaCandidatePointer()}`
    );
  }
  const home = resolveNativeHome(env);
  return { binary, home };
}

/** Selecting a home never creates it. Explicit isolation overrides fail closed. */
export function resolveNativeHome(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const explicit = readAbsolutePathOverride({
    name: "HACK_NATIVE_HOME",
    value: env.HACK_NATIVE_HOME,
  });
  if (explicit) {
    return explicit;
  }
  const hackHome = readAbsolutePathOverride({
    name: "HACK_HOME",
    value: env.HACK_HOME,
  });
  if (hackHome) {
    return join(hackHome, "native-runtime");
  }
  const userHome = normalizeHomeDir(env.HOME) ?? normalizeHomeDir(homedir());
  if (!userHome) {
    throw new ClosedCliError(
      "Native runtime needs an absolute HOME, HACK_HOME or HACK_NATIVE_HOME."
    );
  }
  return join(userHome, ".hack", "native-runtime");
}

/**
 * Bounded one-shot control requests. Private input travels only over stdin;
 * subprocess diagnostics are omitted because they can contain application data.
 * A failed or timed-out mutation has an uncertain outcome and is never replayed.
 */
export async function invokeNativeRuntime(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onImageWait?: (
    waiting: boolean,
    reference?: string,
    working?: boolean
  ) => void;
  readonly privateInput?: Uint8Array;
  /** Graph exec and run-service return command exit status alongside JSON. */
  readonly serviceExecResponse?: boolean;
  /** Native authored status must finish when its owned child exits or admission is canceled. */
  readonly boundNativeStatusDrain?: boolean;
  /** Finite authored logs bind output drains to their exact read child. */
  readonly boundNativeAuthoredLogsDrain?: boolean;
  /** Finite authored exec closes stdin and binds output to its exact request child. */
  readonly boundNativeAuthoredExecDrain?: boolean;
  /** Finite authored one-off run shares exec's closed argv domain under the one-off action. */
  readonly boundNativeAuthoredOneOffDrain?: boolean;
  /** Native source planning and journal inspection also bind pipe lifetime to their owned read child. */
  readonly boundNativeAuthoredReadDrain?: boolean;
  /** Explicit recovery requests have their own closed argv domain and never accept private input. */
  readonly boundNativeAuthoredRecoveryDrain?: "selection" | "cleanup";
  /**
   * Test seam for a bound drain: how long after the child's observed exit a
   * pipe a descendant still holds keeps being read. Production callers leave
   * it at {@link NATIVE_EXIT_DRAIN_BOUND_MS}; EOF ends the drain earlier.
   */
  readonly exitDrainBoundMs?: number;
  /**
   * `"own"` starts the request in its own process group, so a terminal's
   * Ctrl-C, which reaches the whole foreground group, reaches only the caller.
   * The caller then decides what the interrupt means. A restart stopping its
   * old run uses this (HACK-1953): its frontend handles SIGINT and lets the
   * committed stop finish. The caller's `signal`, timeout and cleanup still
   * end the child.
   */
  readonly processGroup?: "inherit" | "own";
}): Promise<unknown> {
  if (opts.signal?.aborted) {
    throw new NativeRuntimeRequestError({
      message:
        "Native runtime request was canceled before admission; no request was started.",
    });
  }
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const bound = boundDrainSelection(opts);
  const exitDrainBoundMs = exitDrainBound(opts.exitDrainBoundMs);
  if (
    !(
      validExecResponseSelection(opts.args, opts.serviceExecResponse) &&
      validBoundDrainSelection(
        opts.args,
        bound,
        opts.privateInput !== undefined
      ) &&
      Number.isSafeInteger(exitDrainBoundMs) &&
      exitDrainBoundMs >= 1
    )
  ) {
    // Internal invariant: callers build these argv shapes; no user input selects them.
    throw new Error(REQUEST_BUDGET_REFUSAL);
  }
  const runtimeCommand = opts.args[0] === "runtime" ? opts.args[1] : undefined;
  const imageBatch = runtimeCommand === "ensure-images";
  let maxTimeoutMs = 600_000;
  if (imageBatch) {
    maxTimeoutMs = 3_600_000;
  } else if (runtimeCommand === "retain-build-bases") {
    maxTimeoutMs = NATIVE_BUILD_RETENTION_TIMEOUT_MS;
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > maxTimeoutMs ||
    (opts.privateInput?.byteLength ?? 0) > MAX_PRIVATE_INPUT_BYTES
  ) {
    // A selected startup timeout or the managed environment size can exceed these bounds.
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message: REQUEST_BUDGET_REFUSAL,
    });
  }
  const env: Record<string, string> = {};
  for (const key of SYSTEM_ENVIRONMENT) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  // The two user settings a runtime request carries in its environment, both
  // for `runtime up` only; an invalid value throws here, before the
  // subprocess exists.
  Object.assign(env, nativeHotReloadEnvironment(opts.args));
  Object.assign(env, nativeAdmissionReuseEnvironment(opts.args));
  if (opts.onImageWait) {
    env.HACK_INTERNAL_REPORT_IMAGE_WAIT = imageBatch ? "batch" : "1";
  }
  const child = startupTimingSpawn(
    [
      opts.runtime.binary,
      "--candidate-root",
      opts.runtime.home,
      // HACK-2461: the per-user step store, only with HACK_STEP_STORE=on.
      ...stepStoreRuntimeArgs(),
      ...opts.args,
    ],
    {
      cwd: opts.cwd,
      env: childEnvironment(env),
      stdin: opts.privateInput ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: opts.processGroup === "own",
    }
  );
  // A descendant may inherit a pipe after the owned child exits. The child's
  // exit, not that writer's EOF, bounds draining (see
  // NATIVE_EXIT_DRAIN_BOUND_MS); its own closed code and response are already
  // in the pipes at exit, so EOF normally ends the drain long before the bound.
  const drain = bound === undefined ? undefined : new AbortController();
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  if (drain) {
    void child.exited.then(() => {
      drainTimer = setTimeout(() => drain.abort(), exitDrainBoundMs);
    });
  }
  const failureDetails = readNativeFailure(
    child.stderr,
    drain?.signal,
    undefined,
    false,
    opts.onImageWait
  );
  let timedOut = false;
  let canceled = false;
  const cancel = () => {
    canceled = true;
    drain?.abort();
    child.kill("SIGKILL");
  };
  opts.signal?.addEventListener("abort", cancel, { once: true });
  if (opts.signal?.aborted) {
    cancel();
  }
  const timer = setTimeout(() => {
    timedOut = true;
    drain?.abort();
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const inputFailure = await writeNativePrivateInput(
      child.stdin,
      opts.privateInput
    );
    const bytes = await readBoundedOutput(child.stdout, drain?.signal);
    const code = await child.exited;
    const failure = await failureDetails;
    if (canceled) {
      throw new NativeRuntimeRequestError({
        message:
          "Native runtime request was canceled; its outcome may be uncertain. No request was replayed.",
      });
    }
    throwIfNativeRuntimeStopped(child.signalCode);
    if (outputBound(bound) && drain?.signal.aborted) {
      throw new NativeRuntimeRequestError({
        message:
          "Native authored command output did not settle; no output was admitted. Command effects may have occurred; no request was replayed.",
      });
    }
    rethrowNativeInputFailure(inputFailure, {
      interrupted: timedOut,
      code,
      nativeCode: failure?.code,
    });
    return completionResponse(
      bytes,
      code,
      timedOut,
      failure,
      opts.serviceExecResponse
    );
  } finally {
    opts.signal?.removeEventListener("abort", cancel);
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    clearTimeout(drainTimer);
    drain?.abort();
    if (commandBound(bound)) {
      await failureDetails;
    }
  }
}

/** The exit-relative drain bound in effect: the test seam's value, else the shared constant. */
function exitDrainBound(selected: number | undefined): number {
  return selected ?? NATIVE_EXIT_DRAIN_BOUND_MS;
}

/** One bound output drain per request; the public flags remain the callers' contract. */
type BoundDrain =
  | "status"
  | "exec"
  | "one-off"
  | "logs"
  | "read"
  | "recovery-selection"
  | "recovery-cleanup";
/** Exec and one-off run carry command output and join their failure reader after settlement. */
function commandBound(bound: BoundDrain | "conflict" | undefined): boolean {
  return bound === "exec" || bound === "one-off";
}
/** Logs and command drains must settle before any captured bytes are admitted. */
function outputBound(bound: BoundDrain | "conflict" | undefined): boolean {
  return bound === "logs" || commandBound(bound);
}

/**
 * Fold the drain flags into one selection. More than one selected flag is a
 * conflict that no argv shape can satisfy, so it reports a reserved value that
 * the validator refuses.
 */
function boundDrainSelection(opts: {
  readonly boundNativeStatusDrain?: boolean;
  readonly boundNativeAuthoredExecDrain?: boolean;
  readonly boundNativeAuthoredOneOffDrain?: boolean;
  readonly boundNativeAuthoredLogsDrain?: boolean;
  readonly boundNativeAuthoredReadDrain?: boolean;
  readonly boundNativeAuthoredRecoveryDrain?: "selection" | "cleanup";
}): BoundDrain | "conflict" | undefined {
  const selected: BoundDrain[] = [];
  if (opts.boundNativeStatusDrain) {
    selected.push("status");
  }
  if (opts.boundNativeAuthoredExecDrain) {
    selected.push("exec");
  }
  if (opts.boundNativeAuthoredOneOffDrain) {
    selected.push("one-off");
  }
  if (opts.boundNativeAuthoredLogsDrain) {
    selected.push("logs");
  }
  if (opts.boundNativeAuthoredReadDrain) {
    selected.push("read");
  }
  if (opts.boundNativeAuthoredRecoveryDrain !== undefined) {
    selected.push(`recovery-${opts.boundNativeAuthoredRecoveryDrain}`);
  }
  if (selected.length > 1) {
    return "conflict";
  }
  return selected[0];
}

function validBoundDrainSelection(
  args: readonly string[],
  bound: BoundDrain | "conflict" | undefined,
  privateInput: boolean
): boolean {
  switch (bound) {
    case undefined:
      return true;
    case "status":
      return validNativeStatusDrainSelection(args);
    case "exec":
      return validNativeAuthoredExecDrainSelection(args, privateInput, "exec");
    case "one-off":
      return validNativeAuthoredExecDrainSelection(
        args,
        privateInput,
        "one-off"
      );
    case "logs":
      return validNativeAuthoredLogsDrainSelection(args, privateInput);
    case "read":
      return validNativeAuthoredReadDrainSelection(args, privateInput);
    case "recovery-selection":
      return validNativeAuthoredRecoveryDrainSelection(
        args,
        "selection",
        privateInput
      );
    case "recovery-cleanup":
      return validNativeAuthoredRecoveryDrainSelection(
        args,
        "cleanup",
        privateInput
      );
    default:
      return false;
  }
}

function validNativeAuthoredLogsDrainSelection(
  args: readonly string[],
  privateInput: boolean
): boolean {
  const tail = args[8] ?? "";
  return (
    !privateInput &&
    args.length === 10 &&
    args[0] === "graph" &&
    args[1] === "native" &&
    args[2] === "logs" &&
    args[3] === "--run-id" &&
    NATIVE_RUN.test(args[4] ?? "") &&
    args[5] === "--service" &&
    NATIVE_SERVICE.test(args[6] ?? "") &&
    args[7] === "--tail" &&
    NATIVE_TAIL.test(tail) &&
    Number(tail) <= 1000 &&
    args[9] === "--json"
  );
}

function validNativeStatusDrainSelection(args: readonly string[]): boolean {
  return (
    args.length === 8 &&
    args[0] === "graph" &&
    args[1] === "native" &&
    args[2] === "control" &&
    args[3] === "--run-id" &&
    NATIVE_RUN.test(args[4] ?? "") &&
    args[5] === "--action" &&
    (args[6] === "status" || args[6] === "observe") &&
    args[7] === "--json"
  );
}

function validNativeAuthoredReadDrainSelection(
  args: readonly string[],
  privateInput: boolean
): boolean {
  return (
    !privateInput &&
    args.length === 6 &&
    args[0] === "graph" &&
    args[1] === "native" &&
    args[5] === "--json" &&
    ((["plan", "frontend-plan"].includes(args[2] ?? "") &&
      args[3] === "--source-file" &&
      isAbsolute(args[4] ?? "")) ||
      (args[2] === "inspect" &&
        args[3] === "--run-id" &&
        NATIVE_RUN.test(args[4] ?? "")))
  );
}

function validNativeAuthoredRecoveryDrainSelection(
  args: readonly string[],
  selected: "selection" | "cleanup",
  privateInput: boolean
): boolean {
  return (
    !privateInput &&
    args[0] === "graph" &&
    args[1] === "native" &&
    args[3] === "--run-id" &&
    NATIVE_RUN.test(args[4] ?? "") &&
    ((selected === "selection" &&
      args.length === 6 &&
      args[2] === "recovery-selection" &&
      args[5] === "--json") ||
      (selected === "cleanup" &&
        args.length === 10 &&
        args[2] === "recover-live-owner" &&
        args[5] === "--expect-receipt" &&
        NATIVE_HASH.test(args[6] ?? "") &&
        args[7] === "--expect-owner" &&
        NATIVE_HASH.test(args[8] ?? "") &&
        args[9] === "--json"))
  );
}

export const NATIVE_PROVIDER_PIN_MESSAGE =
  "This native home was prepared with a different provider version than this build's pin. Use the native executor from the release that started its pool to run runtime down --json on this home. Preserve the home for its retained data and prepare a fresh home for this build; see docs/guides/native-candidate.md.";

function nativeFailureMessage(failure: NativeFailure | undefined): string {
  if (failure?.code === "provider_pin_changed") {
    return `Native runtime request failed (provider_pin_changed); ${NATIVE_PROVIDER_PIN_MESSAGE}`;
  }
  const code = failure
    ? ` (${failure.code}${failure.causeCode ? `: ${failure.causeCode}` : ""})`
    : "";
  const guidance = failure
    ? nativePlanChangeGuidance(failure.code, failure.planChange)
    : undefined;
  return `Native runtime request failed${code}; ${guidance ?? "inspect owned state before retrying."}${failure ? nativeFailureNote(failure) : ""}${nativeStopFailureSummary(failure?.stopFailures)}`;
}

function completionResponse(
  bytes: Uint8Array,
  code: number,
  timedOut: boolean,
  failure: NativeFailure | undefined,
  serviceExecResponse?: boolean
): unknown {
  if (serviceExecResponse && !timedOut && !failure) {
    return parseExecCompletion(bytes, code);
  }
  if (timedOut || code !== 0 || (serviceExecResponse && failure)) {
    throw new NativeRuntimeRequestError({
      message: timedOut
        ? "Native runtime request timed out; inspect owned state before retrying."
        : nativeFailureMessage(failure),
      nativeCode: timedOut ? "native_request_timeout" : failure?.code,
      nativeCauseCode: timedOut ? undefined : failure?.causeCode,
      nativeMessage: timedOut ? undefined : failure?.message,
      nativeService: timedOut ? undefined : failure?.service,
      nativeStopFailures: timedOut ? undefined : failure?.stopFailures,
      nativeConfigurationRefusals: timedOut
        ? undefined
        : failure?.configurationRefusals,
    });
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new ClosedCliError(
      "Native runtime returned an invalid control response."
    );
  }
}

function validExecResponseSelection(
  args: readonly string[],
  selected?: boolean
): boolean {
  if (!selected) {
    return true;
  }
  const separator = args.indexOf("--");
  return (
    args[0] === "graph" &&
    ["exec", "run-service"].includes(args[1] ?? "") &&
    separator > 2 &&
    args.slice(2, separator).includes("--json")
  );
}

function parseExecCompletion(bytes: Uint8Array, code: number): unknown {
  let execResult: unknown;
  try {
    execResult = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    /* Refuse below without echoing output. */
  }
  if (
    isRecord(execResult) &&
    Number.isInteger(execResult.exit_code) &&
    execResult.exit_code === code &&
    code >= 0 &&
    code <= 255 &&
    typeof execResult.stdout_base64 === "string" &&
    typeof execResult.stderr_base64 === "string" &&
    typeof execResult.truncated === "boolean"
  ) {
    return execResult;
  }
  throw new ClosedCliError(
    "Native exec returned an invalid or inconsistent completion response; command effects may have occurred."
  );
}

async function readBoundedOutput(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) {
    cancel();
  }
  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) {
        break;
      }
      total += chunk.byteLength;
      if (total > MAX_OUTPUT_BYTES) {
        throw new ClosedCliError(
          "Native runtime control response exceeds its output budget."
        );
      }
      chunks.push(chunk);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function nativeFailureCause(input: {
  readonly code: string;
  readonly cause: unknown;
}): string | undefined {
  if (typeof input.cause !== "string" || !ERROR_CODE.test(input.cause)) {
    return undefined;
  }
  if (
    (input.code.startsWith("registry_") ||
      input.code === "image_tag_offline_missing") &&
    nativeImageRegistryReason(input.cause)
  ) {
    return input.cause;
  }
  return ["graph_one_off_failed", "graph_owner_recovery"].includes(
    input.code
  ) ||
    (input.code === "native_graph_foreground" &&
      (input.cause === NATIVE_RUNTIME_NOT_RUNNING ||
        input.cause === "graph_status_changed"))
    ? input.cause
    : undefined;
}

/** Validate a parsed stderr reply; bounded startup logs only when the caller accepts them. */
function nativeFailureFromReply(
  value: unknown,
  startupLogs: boolean
): NativeFailure | undefined {
  if (
    !(
      isRecord(value) &&
      typeof value.code === "string" &&
      ERROR_CODE.test(value.code)
    )
  ) {
    return;
  }
  const causeCode = nativeFailureCause({
    code: value.code,
    cause: value.cause_code,
  });
  const planChange = readNativePlanChange(value.plan_change);
  const logPhase = nativeLogPhase(value.log_phase);
  return {
    code: value.code,
    ...(logPhase ? { logPhase } : {}),
    ...(causeCode ? { causeCode } : {}),
    ...nativeFailureDetail(value),
    configurationRefusals: readNativeConfigurationRefusals(
      value.configuration_refusals
    ),
    ...(planChange ? { planChange } : {}),
    ...(["engine_protocol", "engine_rejected", "engine_not_found"].includes(
      value.code === "graph_owner_recovery" &&
        typeof value.cause_code === "string"
        ? value.cause_code
        : value.code
    )
      ? { stopFailures: readNativeStopFailures(value.stop_failures) }
      : {}),
    ...(startupLogs && value.startup_logs !== undefined
      ? { startupLogs: readNativeStartupLogs(value.startup_logs) }
      : {}),
    ...processRefusalsOf(value.process_refusals),
  };
}
function processRefusalsOf(value: unknown): {
  readonly processRefusals?: readonly NativeProcessRefusal[];
} {
  const processRefusals =
    value === undefined ? undefined : readNativeProcessRefusals(value);
  return processRefusals ? { processRefusals } : {};
}

/** Only bounded native error codes leave this boundary, never stderr messages. */
async function readNativeFailure(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  limit = MAX_NATIVE_FAILURE_BYTES,
  startupLogs = false,
  onImageWait?: (
    waiting: boolean,
    reference?: string,
    working?: boolean
  ) => void
): Promise<NativeFailure | undefined> {
  const reader = stream.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) {
    cancel();
  }
  const waiting = new Set<string | undefined>();
  let bytes = 0;
  let text = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      bytes += result.value.byteLength;
      if (bytes <= limit) {
        text += decoder.decode(result.value, { stream: true });
        if (onImageWait) {
          while (text.startsWith("hack.image-wait:")) {
            const newline = text.indexOf("\n");
            if (newline === -1) {
              break;
            }
            const [state, reference] = text.slice(0, newline).split(" ", 2);
            if (
              state === "hack.image-wait:working" ||
              state === "hack.image-wait:finished"
            ) {
              onImageWait(state === "hack.image-wait:working", reference, true);
              text = text.slice(newline + 1);
              continue;
            }
            if (
              state === "hack.image-wait:begin" ||
              state === "hack.image-wait:end"
            ) {
              const active = state.endsWith(":begin");
              if (active) {
                waiting.add(reference);
              } else {
                waiting.delete(reference);
              }
              onImageWait(active, reference);
            } else {
              break;
            }
            text = text.slice(newline + 1);
          }
        }
      }
    }
    if (bytes > limit) {
      return;
    }
    return nativeFailureFromReply(
      JSON.parse(text + decoder.decode()),
      startupLogs
    );
  } catch {
    return;
  } finally {
    for (const reference of waiting) {
      onImageWait?.(false, reference);
    }
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export async function readNativeFailureCode(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): Promise<string | undefined> {
  return (await readNativeFailure(stream, signal))?.code;
}

/**
 * Like {@link readNativeFailureCode}, plus the bounded cause code it allows and
 * the value-free detail of {@link nativeFailureNote}.
 */
export async function readNativeFailureCodes(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): Promise<
  | {
      readonly code: string;
      readonly logPhase?: NativeLogFailurePhase;
      readonly causeCode?: string;
      readonly message?: string;
      readonly service?: string;
    }
  | undefined
> {
  const failure = await readNativeFailure(stream, signal);
  return failure === undefined
    ? undefined
    : {
        code: failure.code,
        ...(failure.logPhase ? { logPhase: failure.logPhase } : {}),
        ...(failure.causeCode ? { causeCode: failure.causeCode } : {}),
        ...(failure.message ? { message: failure.message } : {}),
        ...(failure.service ? { service: failure.service } : {}),
      };
}

/**
 * Like {@link readNativeFailureCodes} for a foreground startup reply, which may
 * also carry failed services' bounded output. That output can contain managed
 * values: the caller must redact it before display and never persist it.
 */
export async function readNativeStartupFailure(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): Promise<
  | {
      readonly code: string;
      readonly causeCode?: string;
      readonly message?: string;
      readonly service?: string;
      readonly startupLogs?: readonly NativeStartupLogTail[];
      readonly processRefusals?: readonly NativeProcessRefusal[];
    }
  | undefined
> {
  const failure = await readNativeFailure(
    stream,
    signal,
    Math.max(NATIVE_STARTUP_FAILURE_REPLY_BYTES, MAX_NATIVE_FAILURE_BYTES),
    true
  );
  return failure === undefined
    ? undefined
    : {
        code: failure.code,
        ...(failure.causeCode ? { causeCode: failure.causeCode } : {}),
        ...(failure.message ? { message: failure.message } : {}),
        ...(failure.service ? { service: failure.service } : {}),
        ...(failure.startupLogs ? { startupLogs: failure.startupLogs } : {}),
        ...(failure.processRefusals
          ? { processRefusals: failure.processRefusals }
          : {}),
      };
}

/** Capture delivery failure while the caller drains and reaps the receiver, never replaying input. */
export async function writeNativePrivateInput(
  sink: Pick<Bun.FileSink, "write" | "end"> | number | null | undefined,
  input: Uint8Array | undefined
): Promise<{ error: unknown } | undefined> {
  if (!(input && sink) || typeof sink === "number") {
    return;
  }
  try {
    sink.write(input);
    await sink.end();
  } catch (error) {
    return { error };
  }
}

/** Only a confirmed receiver rejection or interruption supersedes a delivery error. */
export function rethrowNativeInputFailure(
  failure: { error: unknown } | undefined,
  result: { interrupted: boolean; code: number; nativeCode: string | undefined }
): void {
  if (
    failure &&
    !result.interrupted &&
    !(result.code !== 0 && result.nativeCode)
  ) {
    throw failure.error;
  }
}

function validNativeAuthoredExecDrainSelection(
  args: readonly string[],
  privateInput: boolean,
  action: "exec" | "one-off"
): boolean {
  const workdir = args[7] === "--workdir" ? args[8] : undefined;
  const json = workdir === undefined ? 7 : 9;
  return (
    !privateInput &&
    args[0] === "graph" &&
    args[1] === "native" &&
    args[2] === action &&
    args[3] === "--run-id" &&
    NATIVE_RUN.test(args[4] ?? "") &&
    args[5] === "--service" &&
    args[json] === "--json" &&
    args[json + 1] === "--" &&
    nativeAuthoredExecOptions(args[6], args.slice(json + 2), workdir)
  );
}
