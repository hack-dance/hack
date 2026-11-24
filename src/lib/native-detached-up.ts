import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  type NativeHotReloadNotice,
  parseNativeHotReloadNotice,
  renderNativeHotReloadNotice,
} from "../backends/native-hot-reload-notice.ts";
import {
  type ImageFailure,
  imageBatchFailures,
  NativeImageBatchError,
  NativeImageBlocker,
  type NativeImageBlockerDetail,
  nativeImageBlockerDetail,
} from "../backends/native-image-policy.ts";
import {
  type NativeProfileNotice,
  parseNativeProfileNotice,
  renderNativeProfileNotice,
} from "../backends/native-profile-selection.ts";
import {
  NATIVE_IDLE_POOL_NOTE,
  NATIVE_PROVIDER_PIN_MESSAGE,
} from "../backends/native-runtime-client.ts";
import { CliUsageError } from "../cli/command.ts";
import { writeLifecycleStarted } from "../ui/lifecycle-closing.ts";
import {
  noteActivityFailedServices,
  suppressActivityRecording,
} from "./activity-log.ts";
import type { BranchDroppedSites } from "./branch-hosts.ts";
import { hackReexecEnvironment } from "./child-environment.ts";
import {
  ClosedCliError,
  emitCliResult,
  errorResult,
  HACK_ERROR_CODES,
  HackCliError,
  type HackErrorCode,
  okResult,
} from "./cli-result.ts";
import {
  acceptUpTimingOwnerRelay,
  beginUpTiming,
  closeUpTimingOwnerRelay,
  completeUpTimings,
  upTimingOwnerRelay,
} from "./command-timings.ts";
import { isRecord } from "./guards.ts";
import {
  isNativeDetachedStartPhase,
  NATIVE_DETACHED_HEARTBEAT_MS,
  NativeDetachedStartDeadline,
  type NativeDetachedStartLimits,
  type NativeDetachedStartPhase,
  resolveNativeDetachedStartLimits,
} from "./native-detached-start-deadline.ts";
import { NATIVE_ROOT_DOTENV_IGNORED_NOTICE } from "./native-environment-notices.ts";
import {
  NATIVE_BUILDER_NOT_PREPARED,
  nativeBuilderMissingDetachedRefusal,
} from "./native-image-builder.ts";
import {
  NATIVE_AUTHORED_ATTEMPT_LIMIT,
  NativeAuthoredAttemptLimitError,
} from "./native-up-refusals.ts";

export const NATIVE_DETACHED_OWNER_ARGUMENT =
  "--internal-native-detached-owner";
const SHELL_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Ready = {
  readonly project: string;
  readonly branch: string | null;
  readonly composeProject: string;
  readonly address?: string;
  readonly started: readonly string[];
  readonly completed?: readonly string[];
};
let publishReady: ((ready: Ready) => void) | undefined;
let publishImageBlocker:
  | ((
      detail: NativeImageBlockerDetail | readonly ImageFailure[]
    ) => Promise<void>)
  | undefined;
let publishImageDownloadWait: ((reference: string | null) => void) | undefined;
let publishImageNotice: ((notice: string) => void) | undefined;
let publishProfileNotice: ((notice: NativeProfileNotice) => void) | undefined;
let publishBranchDropped: ((details: BranchDroppedSites) => void) | undefined;
let publishHotReload: ((notice: NativeHotReloadNotice) => void) | undefined;
let publishShellVariables:
  | ((names: readonly string[], ignoredRootDotenv?: boolean) => void)
  | undefined;
type StartupFailure = {
  readonly code: string;
  readonly message?: string;
  readonly service?: string;
  /** Names only: services whose process failed during startup. Never their output. */
  readonly failedServices?: readonly string[];
  readonly startupPhase?: "static-preflight";
};
let publishFailure: ((failure: StartupFailure) => Promise<void>) | undefined;
let publishProgress:
  | ((phase: Exclude<NativeDetachedStartPhase, "launching">) => void)
  | undefined;
let workingImages: readonly string[] = [];
export function reportNativeImageWork(images: readonly string[]): void {
  workingImages = images;
}
let progressHeartbeat: ReturnType<typeof setInterval> | undefined;
let heartbeatIntervalMs = NATIVE_DETACHED_HEARTBEAT_MS;

/** Test fixtures may report image-work heartbeats faster than every 30 s. */
export function setNativeDetachedHeartbeatIntervalForTests(ms: number): void {
  heartbeatIntervalMs = ms;
}

function stopProgressHeartbeat(): void {
  clearInterval(progressHeartbeat);
  progressHeartbeat = undefined;
}

/**
 * Report a startup phase to the launcher (HACK-2351): its name only. While the
 * owner is in `images` (bounded build and load requests) it repeats that
 * report as a heartbeat, so the launcher does not count image work against its
 * budget. A foreground start has no launcher and reports nothing.
 */
export function nativeDetachedUpProgress(phase: string): void {
  if (!(publishProgress && isNativeDetachedStartPhase(phase))) {
    return;
  }
  stopProgressHeartbeat();
  publishProgress(phase);
  if (phase === "images") {
    const report = publishProgress;
    progressHeartbeat = setInterval(
      () => report("images"),
      heartbeatIntervalMs
    );
    progressHeartbeat.unref?.();
  }
}
const FAILURE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const FAILURE_MESSAGE = /^[\x20-\x7e]{1,400}$/;
const FAILURE_SERVICE = /^[A-Za-z0-9_.-]{1,128}$/;
const FAILED_SERVICES_LIMIT = 32;
let failedStartupServices: readonly string[] = [];

/**
 * A refusal raised before the detached owner started any VM work: the same
 * closed CLI error the foreground command would print (HACK-2339), and, for
 * a failed lifecycle hook, the lines the foreground printed about it.
 */
type PrestartRefusal = {
  readonly error: "hack" | "closed" | "usage";
  /** Registered `HackErrorCode`; only for `error: "hack"`. */
  readonly code?: string;
  readonly message: string;
  /** JSON detail of a `HackCliError`, bounded; never for other errors. */
  readonly detail?: unknown;
  /** The failed lifecycle hook's step line, output tail and failure line. */
  readonly hook?: readonly string[];
};
let publishPrestartRefusal:
  | ((refusal: PrestartRefusal) => Promise<void>)
  | undefined;
/** True while the owner is in `up`'s checks before any VM work. */
let prestart = false;
let failedHookLines: readonly string[] = [];
/** A control character other than tab or newline (escape sequences included). */
const CONTROL = /[^\P{Cc}\t\n]/u;
/** A control character other than tab: a hook line never holds a newline. */
const HOOK_CONTROL = /[^\P{Cc}\t]/u;
const HOOK_CONTROLS = /[^\P{Cc}\t]/gu;
/**
 * Above every bounded closed diagnostic, such as a source-size refusal that
 * names ten paths of up to 4096 characters each.
 */
const REFUSAL_MESSAGE_LIMIT = 64 * 1024;
const REFUSAL_DETAIL_LIMIT = 16 * 1024;
const HOOK_LINE_LIMIT = 500;
const HOOK_LINES_LIMIT = 60;
const HOOK_OUTPUT_TAIL = 40;

/** One display line: no control characters but tabs, bounded. */
function hookLine(value: string): string {
  return value.replace(HOOK_CONTROLS, "").slice(0, HOOK_LINE_LIMIT);
}

/**
 * Marks the detached owner's pre-VM phase of `up`: from its first project
 * check until runtime work starts. A closed refusal raised in it reaches the
 * launcher as the foreground would print it; outside it nothing changes.
 */
export function nativeDetachedUpPrestart(active: boolean): void {
  if (!publishPrestartRefusal) {
    return;
  }
  prestart = active;
  if (!active) {
    failedHookLines = [];
  }
}

/** Whether a lifecycle hook's output tail is kept: a detached owner before VM work. */
export function nativeDetachedUpKeepsHookOutput(): boolean {
  return publishPrestartRefusal !== undefined && prestart;
}

/**
 * Record the lines the foreground printed for a failed lifecycle hook: its
 * step line, the last lines of its output and its failure line. Kept only in
 * a detached owner's pre-VM phase, and sent only with that phase's refusal;
 * the launcher writes them to stderr, never into `--json` (HACK-2311).
 */
export function nativeDetachedUpHookFailed(opts: {
  readonly step: string;
  readonly output: readonly string[];
  readonly failure: string;
}): void {
  if (!(publishPrestartRefusal && prestart)) {
    return;
  }
  failedHookLines = [
    opts.step,
    ...opts.output.slice(-HOOK_OUTPUT_TAIL),
    opts.failure,
  ].map(hookLine);
}

/** The closed CLI error the foreground would print, or undefined for any other error. */
function prestartRefusal(error: unknown): PrestartRefusal | undefined {
  const hook = failedHookLines.length > 0 ? failedHookLines : undefined;
  if (error instanceof HackCliError) {
    const detail =
      error.detail === undefined ? undefined : JSON.stringify(error.detail);
    return {
      error: "hack",
      code: error.code,
      message: error.message,
      ...(detail !== undefined && detail.length <= REFUSAL_DETAIL_LIMIT
        ? { detail: JSON.parse(detail) as unknown }
        : {}),
      ...(hook ? { hook } : {}),
    };
  }
  if (error instanceof CliUsageError || error instanceof ClosedCliError) {
    return {
      error: error instanceof CliUsageError ? "usage" : "closed",
      message: error.message,
      ...(hook ? { hook } : {}),
    };
  }
  return;
}

function isRefusalMessage(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= REFUSAL_MESSAGE_LIMIT &&
    !CONTROL.test(value)
  );
}

/** A registered code for a `HackCliError`; no code or detail for the others. */
function isRefusalIdentity(value: Record<string, unknown>): boolean {
  if (value.error === "hack") {
    return (
      typeof value.code === "string" &&
      (HACK_ERROR_CODES as readonly string[]).includes(value.code) &&
      (value.detail === undefined ||
        JSON.stringify(value.detail).length <= REFUSAL_DETAIL_LIMIT)
    );
  }
  return (
    (value.error === "closed" || value.error === "usage") &&
    value.code === undefined &&
    value.detail === undefined
  );
}

function isHookLines(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length > 0 &&
      value.length <= HOOK_LINES_LIMIT &&
      value.every(
        (line) =>
          typeof line === "string" &&
          line.length <= HOOK_LINE_LIMIT &&
          !HOOK_CONTROL.test(line)
      ))
  );
}

function isPrestartRefusal(value: unknown): value is PrestartRefusal {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      ["error", "code", "message", "detail", "hook"].includes(key)
    ) &&
    isRefusalMessage(value.message) &&
    isRefusalIdentity(value) &&
    isHookLines(value.hook)
  );
}

/** Written instead of a failed hook's lines when stderr is not a terminal. */
export const NATIVE_HOOK_OUTPUT_TERMINAL_ONLY =
  "The failed lifecycle hook's output is shown only on a terminal; run hack up without -d in a terminal to see it.";

/**
 * What the launcher writes to stderr for a failed hook. Its lines only on a
 * terminal, as the foreground printed them: hook output may carry values,
 * and a non-terminal stderr is often captured (for example as an agent tool's
 * result). Otherwise one fixed line says how to see them. Never stdout.
 */
export function nativePrestartHookLines(opts: {
  readonly lines: readonly string[] | undefined;
  readonly terminal: boolean;
}): readonly string[] {
  if (!opts.lines?.length) {
    return [];
  }
  return opts.terminal ? opts.lines : [NATIVE_HOOK_OUTPUT_TERMINAL_ONLY];
}

/** Write the failed hook's stderr lines and return the refusal's error. */
function reportPrestartRefusal(refusal: PrestartRefusal): Error {
  for (const line of nativePrestartHookLines({
    lines: refusal.hook,
    terminal: process.stderr.isTTY === true,
  })) {
    process.stderr.write(`${line}\n`);
  }
  return prestartRefusalError(refusal);
}

/** The launcher's error for a validated pre-VM refusal: the foreground's own class. */
function prestartRefusalError(refusal: PrestartRefusal): Error {
  if (refusal.error === "hack") {
    return new HackCliError({
      code: refusal.code as HackErrorCode,
      message: refusal.message,
      ...(refusal.detail === undefined ? {} : { detail: refusal.detail }),
    });
  }
  return refusal.error === "usage"
    ? new CliUsageError(refusal.message)
    : new ClosedCliError(refusal.message);
}

/**
 * Record which services failed during a detached startup. Names only: the
 * owner has no terminal, and service output never crosses IPC.
 */
export function nativeDetachedUpFailedServices(names: readonly string[]): void {
  // Only a detached owner reports names; a foreground start keeps none.
  if (!publishFailure) {
    return;
  }
  failedStartupServices = [...new Set(names)]
    .filter((name) => FAILURE_SERVICE.test(name))
    .sort()
    .slice(0, FAILED_SERVICES_LIMIT);
}

/** Only the runtime's validated fixed detail crosses IPC; never an Error's text or logs. */
export async function nativeDetachedUpFailure(error: unknown): Promise<void> {
  if (!publishFailure) {
    return;
  }
  if (error instanceof NativeImageBatchError) {
    await publishImageBlocker?.(error.failures);
    return;
  }
  if (error instanceof NativeImageBlocker) {
    await publishImageBlocker?.(error.observation);
    return;
  }
  if (error instanceof NativeAuthoredAttemptLimitError) {
    await publishFailure({ code: NATIVE_AUTHORED_ATTEMPT_LIMIT });
    return;
  }
  const { nativeRuntimeFailure } = await import(
    "../backends/native-runtime-client.ts"
  );
  const failure = nativeRuntimeFailure(error);
  if (isStartupFailure(failure)) {
    await publishFailure(
      failedStartupServices.length > 0 && failure.service === undefined
        ? { ...failure, failedServices: failedStartupServices }
        : failure
    );
    return;
  }
  // Before any VM work, a closed refusal is exactly what the foreground would
  // print (HACK-2339); anything else, and anything later, stays unconfirmed.
  const refusal = prestart ? prestartRefusal(error) : undefined;
  if (refusal && isPrestartRefusal(refusal)) {
    await publishPrestartRefusal?.(refusal);
  }
}

function isStartupFailure(value: unknown): value is StartupFailure {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      ["code", "message", "service", "failedServices", "startupPhase"].includes(
        key
      )
    ) &&
    typeof value.code === "string" &&
    FAILURE_CODE.test(value.code) &&
    (value.message === undefined ||
      (typeof value.message === "string" &&
        FAILURE_MESSAGE.test(value.message))) &&
    (value.service === undefined ||
      (typeof value.service === "string" &&
        FAILURE_SERVICE.test(value.service))) &&
    (value.failedServices === undefined ||
      (Array.isArray(value.failedServices) &&
        value.failedServices.length > 0 &&
        value.failedServices.length <= FAILED_SERVICES_LIMIT &&
        value.failedServices.every(
          (name) => typeof name === "string" && FAILURE_SERVICE.test(name)
        ))) &&
    (value.startupPhase === undefined ||
      value.startupPhase === "static-preflight")
  );
}

/** The error for a validated startup failure or pre-VM refusal message, if it is one. */
function startupRefusal(value: unknown): Error | undefined {
  const failure = startupFailureMessage(value);
  if (failure) {
    return startupFailureError(failure);
  }
  const refusal = prestartRefusalMessage(value);
  return refusal ? reportPrestartRefusal(refusal) : undefined;
}

function prestartRefusalMessage(value: unknown): PrestartRefusal | undefined {
  return isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.kind === "prestart-refusal" &&
    isPrestartRefusal(value.data)
    ? value.data
    : undefined;
}

function startupFailureMessage(value: unknown): StartupFailure | undefined {
  return isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.kind === "failure" &&
    isStartupFailure(value.data)
    ? value.data
    : undefined;
}

function startupFailureError(failure: StartupFailure): HackCliError {
  noteActivityFailedServices([
    ...(failure.failedServices ?? []),
    failure.service,
  ]);
  if (failure.code === NATIVE_AUTHORED_ATTEMPT_LIMIT) {
    return new NativeAuthoredAttemptLimitError();
  }
  if (failure.code === "provider_pin_changed") {
    return new HackCliError({
      code: "E_STARTUP_INCOMPLETE",
      message: `Native detached startup refused (provider_pin_changed); ${NATIVE_PROVIDER_PIN_MESSAGE}`,
    });
  }
  if (failure.code === NATIVE_BUILDER_NOT_PREPARED) {
    // A detached owner passes only the code; the remedy is the same sentence
    // the foreground refusal, setup and doctor print.
    return new HackCliError({
      code: "E_STARTUP_INCOMPLETE",
      message: `${nativeBuilderMissingDetachedRefusal()} ${NATIVE_IDLE_POOL_NOTE}`,
    });
  }
  let detail = "";
  if (failure.message) {
    detail = failure.service
      ? ` Service ${failure.service}: ${failure.message}`
      : ` Runtime: ${failure.message}`;
  } else if (failure.service) {
    detail = ` Service: ${failure.service}.`;
  }
  if (failure.startupPhase === "static-preflight") {
    return new HackCliError({
      code: "E_STARTUP_INCOMPLETE",
      message: `Native detached startup refused (${failure.code}); nothing was started.${detail} Fix the reported configuration and retry; run hack doctor --native-preflight to list every static blocker.`,
    });
  }
  const failed = failure.failedServices?.length
    ? ` Failed during startup: ${failure.failedServices.join(", ")}. A detached start does not keep service output; run hack up without -d in a terminal to see each failed service's last lines (managed values redacted, not saved).`
    : "";
  return new HackCliError({
    code: "E_STARTUP_INCOMPLETE",
    message: `Native detached startup failed (${failure.code}); inspect hack ps before retrying; retained owners and recovery evidence are preserved.${detail}${failed} ${NATIVE_IDLE_POOL_NOTE}`,
  });
}

/**
 * Hands a profile notice to the launcher when this is a detached owner, whose
 * stderr is not shown; false otherwise, so the caller prints it itself.
 */
export function nativeDetachedUpProfileNotice(
  notice: NativeProfileNotice
): boolean {
  if (!publishProfileNotice) {
    return false;
  }
  publishProfileNotice(notice);
  return true;
}

/**
 * Prints an owner's validated profile notice; true when `value` was one
 * (shown or dropped), so the launcher handles nothing else for it.
 */
function writeProfileNotice(value: unknown): boolean {
  if (!(isRecord(value) && value.kind === "profile-notice")) {
    return false;
  }
  const notice = parseNativeProfileNotice(value.notice);
  const line = notice ? renderNativeProfileNotice(notice) : null;
  if (line) {
    process.stderr.write(`${line}\n`);
  }
  return true;
}

/**
 * Hands a dropped-branch-site notice to the launcher of a detached owner, as
 * names and a count (no hosts); false otherwise, so the caller prints it.
 */
export function nativeDetachedUpBranchDropped(
  details: BranchDroppedSites
): boolean {
  if (!publishBranchDropped) {
    return false;
  }
  publishBranchDropped(details);
  return true;
}

const BRANCH_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SITE_LABEL = /^caddy(?:_\d{1,4})?$/;

/** Names and a bounded count only; anything else is dropped. */
function isBranchDroppedSites(details: unknown): details is BranchDroppedSites {
  if (!isRecord(details)) {
    return false;
  }
  const { branch, service, label, count } = details;
  return (
    typeof branch === "string" &&
    BRANCH_SLUG.test(branch) &&
    typeof service === "string" &&
    SERVICE_NAME.test(service) &&
    typeof label === "string" &&
    SITE_LABEL.test(label) &&
    Number.isSafeInteger(count) &&
    Number(count) > 0 &&
    Number(count) <= 256
  );
}

/** Prints a validated dropped-site notice; true when `value` was one. */
function writeBranchDropped(value: unknown): boolean {
  if (!(isRecord(value) && value.kind === "branch-dropped")) {
    return false;
  }
  const details = value.details;
  if (isBranchDroppedSites(details)) {
    const plural = details.count !== 1;
    process.stderr.write(
      `Branch ${details.branch}: service ${details.service} label ${details.label} drops ${details.count} site${plural ? "s" : ""} outside this project's route namespaces; ${plural ? "they stay" : "it stays"} with the base instance.\n`
    );
  }
  return true;
}

/**
 * Hands the pool's hot-reload notice to the launcher of a detached owner, as
 * two names and a number; false otherwise, so the caller prints it.
 */
export function nativeDetachedUpHotReload(
  notice: NativeHotReloadNotice
): boolean {
  if (!publishHotReload) {
    return false;
  }
  publishHotReload(notice);
  return true;
}

/** Prints a validated hot-reload notice; true when `value` was one. */
function writeHotReload(value: unknown): boolean {
  if (!(isRecord(value) && value.kind === "hot-reload")) {
    return false;
  }
  const notice = parseNativeHotReloadNotice(value.notice);
  if (notice) {
    process.stderr.write(`${renderNativeHotReloadNotice(notice)}\n`);
  }
  return true;
}

export function reportNativeImageDownloadWait(reference: string | null): void {
  publishImageDownloadWait?.(reference);
  if (reference) {
    const lock = reference === "image-cache" || reference === "image-reclaim";
    const line = lock
      ? `Waiting for the native ${reference === "image-cache" ? "image cache lock" : "image reclamation lock"}.`
      : `Waiting for another start to resolve or download ${reference}.`;
    if (!reportNativeImageNotice(line)) {
      process.stderr.write(`${line}\n`);
    }
  }
}

export function reportNativeImageNotice(notice: string): boolean {
  if (!publishImageNotice) {
    return false;
  }
  publishImageNotice(notice);
  return true;
}

function writeImageNotice(value: unknown): boolean {
  if (
    !(
      isRecord(value) &&
      value.kind === "image-notice" &&
      typeof value.notice === "string" &&
      value.notice.length <= 512 &&
      [...value.notice].every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      })
    )
  ) {
    return false;
  }
  process.stderr.write(`${value.notice}\n`);
  return true;
}

/** Prints any validated owner notice; true when `value` was one. */
function writeOwnerNotice(value: unknown): boolean {
  return (
    writeImageNotice(value) ||
    writeProfileNotice(value) ||
    writeBranchDropped(value) ||
    writeHotReload(value)
  );
}

/** Names-only notice: never accepts or forwards an environment map or output text. */
export function nativeDetachedUpShellVariables(
  names: readonly string[],
  ignoredRootDotenv = false
): boolean {
  if (!publishShellVariables) {
    return false;
  }
  publishShellVariables(names, ignoredRootDotenv);
  return true;
}

export function nativeShellForwardingNotice(names: readonly string[]): string {
  return `Forwarding shell variables: ${names.length ? [...new Set(names)].sort().join(", ") : "(none)"}.`;
}

/** Bound and validate IPC metadata before it reaches a terminal, including on failure. */
function isShellVariables(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 8192 &&
    value.every(
      (name: unknown) =>
        typeof name === "string" && SHELL_VARIABLE_NAME.test(name)
    ) &&
    Buffer.byteLength(JSON.stringify(value)) <= 256 * 1024
  );
}

/** Called only after durable readiness and up.after; contains no private values. */
export function nativeDetachedUpReady(ready: Ready): void {
  closeUpTimingOwnerRelay();
  if (!publishReady) {
    completeUpTimings();
  }
  publishReady?.(ready);
}

/**
 * Keep the existing frontend and Rust foreground owners alive in a new session.
 * IPC is admission to background operation, never runtime ownership authority.
 * Losing the launcher before acceptance requests ordinary owner-mediated stop.
 * After acceptance the existing authenticated down/recovery protocols own lifetime.
 */
let detachedOwnerProcess = false;

/**
 * True inside the detached native owner child. Its `up` arguments carry only
 * the branch slug the launcher resolved, so it must not record that slug as
 * the instance's name (the launcher already recorded the real one).
 */
export function isNativeDetachedOwnerProcess(): boolean {
  return detachedOwnerProcess;
}

export async function runNativeDetachedOwner(opts: {
  readonly args: string[];
  readonly run: (args: string[]) => Promise<number>;
}): Promise<number> {
  if (!(process.send && process.connected) || publishReady) {
    return 1;
  }
  detachedOwnerProcess = true;
  // This owner re-runs `up` and lives as long as the services; the launcher
  // that started it records the action (HACK-2218).
  suppressActivityRecording();
  let ready = false;
  let accepted = false;
  let stopping = false;
  const requestStop = () => {
    if (!stopping) {
      stopping = true;
      process.kill(process.pid, "SIGTERM");
    }
  };
  const disconnected = () => {
    if (!accepted) {
      requestStop();
    }
  };
  const send = (
    value:
      | string
      | { readonly kind: "ready"; readonly data: Ready }
      | {
          readonly kind: "shell-variables";
          readonly names: readonly string[];
          readonly ignoredRootDotenv?: true;
        }
      | { readonly kind: "failure"; readonly data: StartupFailure }
      | {
          readonly kind: "profile-notice";
          readonly notice: NativeProfileNotice;
        }
      | {
          readonly kind: "branch-dropped";
          readonly details: BranchDroppedSites;
        }
      | {
          readonly kind: "hot-reload";
          readonly notice: NativeHotReloadNotice;
        }
      | {
          readonly kind: "image-blocker";
          readonly detail: NativeImageBlockerDetail | readonly ImageFailure[];
        }
      | {
          readonly kind: "image-download-wait";
          readonly reference: string | null;
        }
      | { readonly kind: "image-notice"; readonly notice: string }
      | { readonly kind: "prestart-refusal"; readonly data: PrestartRefusal }
      | {
          readonly kind: "progress";
          readonly images?: readonly string[];
          readonly phase: Exclude<NativeDetachedStartPhase, "launching">;
        }
  ): Promise<void> =>
    new Promise((resolve) => {
      if (!(process.send && process.connected)) {
        disconnected();
        resolve();
        return;
      }
      try {
        process.send(value, undefined, undefined, (error) => {
          if (error) {
            disconnected();
          }
          resolve();
        });
      } catch {
        disconnected();
        resolve();
      }
    });
  const message = (value: unknown) => {
    if (value === "cancel") {
      requestStop();
      return;
    }
    if (value !== "accept" || !ready || accepted || stopping) {
      return;
    }
    accepted = true;
    send("accepted");
  };
  process.on("disconnect", disconnected);
  process.on("message", message);
  publishReady = (data) => {
    if (ready || stopping) {
      return;
    }
    ready = true;
    send({ kind: "ready", data });
  };
  publishShellVariables = (names, ignoredRootDotenv) => {
    if (!stopping) {
      send({
        kind: "shell-variables",
        names,
        ...(ignoredRootDotenv ? { ignoredRootDotenv: true as const } : {}),
      });
    }
  };
  publishImageBlocker = async (detail) => {
    if (!(ready || stopping)) {
      await send({ kind: "image-blocker", detail });
    }
  };
  publishImageDownloadWait = (reference) => {
    if (!(ready || stopping)) {
      void send({ kind: "image-download-wait", reference });
    }
  };
  publishImageNotice = (notice) => {
    if (!stopping) {
      send({ kind: "image-notice", notice });
    }
  };
  publishProfileNotice = (notice) => {
    if (!stopping) {
      send({ kind: "profile-notice", notice });
    }
  };
  publishBranchDropped = (details) => {
    if (!stopping) {
      send({ kind: "branch-dropped", details });
    }
  };
  publishHotReload = (notice) => {
    if (!stopping) {
      send({ kind: "hot-reload", notice });
    }
  };
  // A fresh owner starts with no names from any earlier attempt.
  failedStartupServices = [];
  publishFailure = async (data) => {
    if (!(ready || stopping)) {
      await send({ kind: "failure", data });
    }
  };
  prestart = false;
  failedHookLines = [];
  publishPrestartRefusal = async (data) => {
    if (!(ready || stopping)) {
      await send({ kind: "prestart-refusal", data });
    }
  };
  publishProgress = (phase) => {
    if (ready || stopping) {
      stopProgressHeartbeat();
      return;
    }
    send({
      kind: "progress",
      phase,
      ...(phase === "images" && workingImages.length
        ? { images: workingImages }
        : {}),
    });
  };
  try {
    return await opts.run(await acceptUpTimingOwnerRelay(opts.args));
  } finally {
    stopping = true;
    closeUpTimingOwnerRelay();
    workingImages = [];
    publishReady = undefined;
    publishShellVariables = undefined;
    publishProfileNotice = undefined;
    publishImageNotice = undefined;
    publishImageDownloadWait = undefined;
    publishImageBlocker = undefined;
    publishBranchDropped = undefined;
    publishHotReload = undefined;
    publishFailure = undefined;
    failedStartupServices = [];
    publishPrestartRefusal = undefined;
    prestart = false;
    failedHookLines = [];
    publishProgress = undefined;
    stopProgressHeartbeat();
    process.off("disconnect", disconnected);
    process.off("message", message);
    if (process.connected) {
      process.disconnect?.();
    }
  }
}

function isReady(value: unknown): value is Ready {
  return (
    isRecord(value) &&
    typeof value.project === "string" &&
    (value.branch === null || typeof value.branch === "string") &&
    typeof value.composeProject === "string" &&
    Array.isArray(value.started) &&
    value.started.length <= 256 &&
    value.started.every((name: unknown) => typeof name === "string") &&
    (value.completed === undefined ||
      (Array.isArray(value.completed) &&
        value.completed.length <= 256 &&
        value.completed.every((name: unknown) => typeof name === "string")))
  );
}

/**
 * The detached owner child's arguments: the whole-project command and only the
 * selection options it needs, each as one `--name=value` argument. Values are
 * names and paths the caller already parsed; no shell, env value or secret.
 */
export function nativeDetachedOwnerArgs(opts: {
  readonly action: "up" | "restart";
  readonly options: {
    readonly path?: string;
    readonly project?: string;
    readonly branch?: string;
    readonly env?: string;
    readonly profile?: string;
    readonly refreshImages?: boolean;
    readonly offline?: boolean;
  };
}): string[] {
  const args: string[] = [opts.action];
  for (const name of ["path", "project", "branch", "env", "profile"] as const) {
    const value = opts.options[name];
    if (value !== undefined) {
      args.push(`--${name}=${value}`);
    }
  }
  if (opts.options.refreshImages) {
    args.push("--refresh-images");
  }
  if (opts.options.offline) {
    args.push("--offline");
  }
  return args;
}

function nativeReadyAddress(address: unknown): string | undefined {
  const url = typeof address === "string" ? URL.parse(address) : null;
  return url?.protocol === "https:" && !url.username && !url.password
    ? url.origin
    : undefined;
}

/**
 * Feed the owner's phase reports into the start's clocks and reject through
 * `expire` once one runs out (HACK-2351). Phase reports never resolve a start.
 */
function watchStartDeadline(opts: {
  readonly child: ReturnType<typeof spawn>;
  readonly limits: NativeDetachedStartLimits;
  readonly heartbeatStaleMs: number | undefined;
  readonly expire: (error: HackCliError | NativeImageBlocker) => void;
}): ReturnType<typeof setInterval> {
  // One monotonic clock: a wall clock change must not move either limit.
  const deadline = new NativeDetachedStartDeadline({
    limits: opts.limits,
    now: performance.now(),
    heartbeatStaleMs: opts.heartbeatStaleMs,
  });
  let waiting: NativeImageBlockerDetail | undefined;
  opts.child.on("message", (value: unknown) => {
    if (isRecord(value) && value.kind === "image-download-wait") {
      const detail = {
        missing: value.reference,
        present: null,
        downloading: true,
      };
      waiting = nativeImageBlockerDetail(detail) ? detail : undefined;
    }
    if (
      isRecord(value) &&
      (Object.keys(value).length === 2 ||
        (value.phase === "images" && Array.isArray(value.images))) &&
      value.kind === "progress" &&
      isNativeDetachedStartPhase(value.phase)
    ) {
      deadline.observe(value.phase, performance.now());
    }
  });
  return setInterval(
    () => {
      const now = performance.now();
      const expiry = deadline.check(now);
      if (expiry) {
        opts.expire(
          waiting
            ? new NativeImageBlocker(waiting)
            : deadline.timeoutError(expiry, now)
        );
      }
    },
    Math.min(1000, Math.max(50, Math.floor(opts.limits.budgetMs / 20)))
  );
}

/** The launch's limits: an explicit override, else the configured ones. */
function launchLimits(
  override: NativeDetachedStartLimits | undefined
): NativeDetachedStartLimits {
  return override ?? resolveNativeDetachedStartLimits(process.env);
}

/** Upper bound for handing the `cancel` message to a live local IPC channel. */
const CANCEL_SEND_MS = 5000;

/** Wait for `promise`, but never longer than `ms` (default 120 s). */
async function settleWithin(
  promise: Promise<void>,
  ms = 120_000
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

/**
 * Launch only parsed, whole-project native `up` or `restart` arguments; no
 * shell or secret argv. The child becomes the detached owner; this launcher
 * returns once the child reports durable readiness. With `json`, it prints
 * one result envelope with the same fields as Compose (`data.action`,
 * `data.services`, `durationMs`).
 */
export async function startNativeDetachedUp(opts: {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly json: boolean;
  /** The command the child runs, reported as `data.action`. Defaults to `up`. */
  readonly action?: "up" | "restart";
  /** Synthetic process fixtures may replace the CLI invocation. */
  readonly invocation?: readonly string[];
  /** Overrides the configured limits; see `native-detached-start-deadline.ts`. */
  readonly limits?: NativeDetachedStartLimits;
  /** How long image work may go without a heartbeat (tests shorten it). */
  readonly heartbeatStaleMs?: number;
  /** How long a timed-out launch waits for its owner to exit (tests shorten it). */
  readonly unwindMs?: number;
}): Promise<number> {
  const limits = launchLimits(opts.limits);
  const invocation = opts.invocation ?? [
    process.execPath,
    ...(Bun.main.startsWith("/$bunfs/")
      ? []
      : [fileURLToPath(new URL("../../index.ts", import.meta.url))]),
    NATIVE_DETACHED_OWNER_ARGUMENT,
  ];
  const startedAt = Date.now();
  const action = opts.action ?? "up";
  const executable = invocation[0];
  if (!executable) {
    throw new Error("Missing detached owner executable.");
  }
  const relay = upTimingOwnerRelay();
  const ownerArgs = [
    ...invocation.slice(1),
    ...(relay ? [relay.argument] : []),
    ...opts.args,
  ];
  const child = spawn(executable, ownerArgs, {
    cwd: opts.cwd,
    detached: true,
    // Application/hook output may contain secrets. Never persist it or mix it
    // with the launcher's JSON. Service logs remain available through hack logs.
    stdio: ["ignore", "ignore", "ignore", "ipc", ...(relay ? [relay.fd] : [])],
    serialization: "json",
    env: hackReexecEnvironment(process.env),
  });
  let ready: Ready | undefined;
  let acceptedTiming: (() => void) | undefined;
  let committed = false;
  const result = Promise.withResolvers<Ready>();
  let failed = false;
  let cancellationCode: number | undefined;
  let shellVariablesReported = false;
  let exitGrace: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  let timedOut = false;
  const fail = () => {
    if (committed || failed) {
      return;
    }
    failed = true;
    result.reject(
      new HackCliError({
        code: "E_STARTUP_INCOMPLETE",
        message:
          "Native detached startup was not confirmed. Inspect hack ps before retrying; retained owners and recovery evidence are preserved.",
      })
    );
  };
  const cancel = (code: number) => {
    if (committed || failed) {
      return;
    }
    failed = true;
    cancellationCode = code;
    result.reject(
      new HackCliError({
        code: "E_CANCELLED",
        message:
          "Native detached startup interrupted; ordinary owned stop was requested. Inspect hack ps before retrying.",
      })
    );
  };
  const interrupt = () => cancel(130);
  const terminate = () => cancel(143);
  child.on("error", fail);
  // Drain buffered IPC after exit, but don't wait for a descendant that
  // inherited the channel descriptor to release it on the full startup timer.
  child.on("exit", () => {
    if (!(committed || failed)) {
      exitGrace = setTimeout(fail, 1500);
    }
  });
  const channelClosed = () => {
    clearTimeout(exitGrace);
    fail();
  };
  child.on("close", channelClosed);
  child.on("disconnect", channelClosed);
  child.on("message", (value: unknown) => {
    if (failed) {
      return;
    }
    let imageBlocked: NativeImageBatchError | NativeImageBlocker | undefined;
    if (!ready && isRecord(value) && value.kind === "image-blocker") {
      if (imageBatchFailures(value.detail)) {
        imageBlocked = new NativeImageBatchError(value.detail);
      } else if (nativeImageBlockerDetail(value.detail)) {
        imageBlocked = new NativeImageBlocker(value.detail);
      }
    }
    const refused = ready ? undefined : (imageBlocked ?? startupRefusal(value));
    if (refused) {
      failed = true;
      result.reject(refused);
      return;
    }
    if (writeOwnerNotice(value)) {
      return;
    }
    if (isRecord(value) && value.kind === "shell-variables") {
      if (
        !shellVariablesReported &&
        Object.keys(value).every((key) =>
          ["kind", "names", "ignoredRootDotenv"].includes(key)
        ) &&
        (value.ignoredRootDotenv === undefined ||
          value.ignoredRootDotenv === true) &&
        isShellVariables(value.names)
      ) {
        shellVariablesReported = true;
        process.stderr.write(`${nativeShellForwardingNotice(value.names)}\n`);
        if (value.ignoredRootDotenv === true) {
          process.stderr.write(`${NATIVE_ROOT_DOTENV_IGNORED_NOTICE}\n`);
        }
      }
      return;
    }
    if (
      !ready &&
      isRecord(value) &&
      value.kind === "ready" &&
      isReady(value.data)
    ) {
      ready = value.data;
      acceptedTiming = beginUpTiming("cli.owner.accept");
      child.send("accept", (error) => {
        if (error) {
          fail();
        }
      });
    } else if (value === "accepted" && ready) {
      committed = true;
      acceptedTiming?.();
      result.resolve(ready);
    }
  });
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  const timer = watchStartDeadline({
    child,
    limits,
    heartbeatStaleMs: opts.heartbeatStaleMs,
    expire: (error) => {
      if (!(committed || failed)) {
        failed = true;
        timedOut = true;
        result.reject(error);
      }
    },
  });
  try {
    const data = await result.promise;
    const resultTiming = beginUpTiming("cli.result.prepare");
    const durationMs = Date.now() - startedAt;
    if (opts.json) {
      const services = {
        started: [...data.started].sort(),
        completed: [...(data.completed ?? [])].sort(),
        stopped: [],
        failed: [],
      };
      resultTiming?.();
      emitCliResult({
        result: okResult({
          data: {
            action,
            project: data.project,
            branch: data.branch,
            composeProject: data.composeProject,
            services,
            durationMs,
            timings: completeUpTimings(),
          },
        }),
      });
    } else if (action === "up") {
      const url = nativeReadyAddress(data.address);
      resultTiming?.();
      completeUpTimings();
      writeLifecycleStarted({
        url,
        backend: "native",
        durationMs,
      });
    } else {
      process.stdout.write(
        "Project restarted and is ready. Use hack ps, hack logs SERVICE --no-follow, and hack down.\n"
      );
    }
    return 0;
  } catch (error) {
    if (cancellationCode === undefined || !(error instanceof HackCliError)) {
      throw error;
    }
    if (opts.json) {
      emitCliResult({
        result: errorResult({ code: error.code, message: error.message }),
      });
    } else {
      process.stderr.write(`${error.message}\n`);
    }
    return cancellationCode;
  } finally {
    clearInterval(timer);
    clearTimeout(exitGrace);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    // Before commit this disconnect triggers graceful shutdown in the exact
    // child. Never kill a retained owner, infer cleanup, or replay startup.
    if (child.connected) {
      if (committed) {
        child.disconnect();
      } else {
        // Acceptance may already be queued when the caller cancels. Explicit
        // cancellation requests stop even if the child accepted just before
        // it observed disconnection; disconnection alone cannot undo that.
        // The CLI exits explicitly once this command returns, so wait (bounded)
        // until the message has been handed to the channel.
        // A closed channel or an exited child ends the wait as well: then the
        // callback may never run, and there is nobody left to deliver to.
        const sent = new Promise<void>((resolve) => {
          child.once("disconnect", resolve);
          child.send("cancel", () => {
            if (child.connected) {
              child.disconnect();
            }
            resolve();
          });
        });
        await settleWithin(Promise.race([sent, exited]), CANCEL_SEND_MS);
      }
    }
    // After a timeout, give the owner a bounded chance to stop what it started
    // before this command returns; `hack down` waits for a start still unwinding.
    await settleWithin(timedOut ? exited : Promise.resolve(), opts.unwindMs);
    child.unref();
  }
}
