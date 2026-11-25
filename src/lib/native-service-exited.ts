import type { NativeStartupLogTail } from "../backends/native-startup-logs.ts";
import { HackCliError } from "./cli-result.ts";
import { isRecord } from "./guards.ts";

/**
 * A native start that failed because a service's own process exited
 * (HACK-2194): the most common first failure, such as a missing package script.
 *
 * The runtime reports the exit status beside each failed service's bounded
 * output tail. When at least one failed service exited, `hack up` reports the
 * failure as {@link NATIVE_SERVICE_EXITED} with each service's name and exit
 * code instead of the runtime's own code (which may name a later engine call,
 * such as `engine_rejected`). Only after the failed start's cleanup was
 * confirmed: no owner of the attempt is left for recovery, so the message does
 * not say that retained owners are preserved (a discarded start reports any
 * volumes it kept on its own line). Names and exit codes are value-free and may
 * cross the detached owner's IPC; output never does.
 */
export const NATIVE_SERVICE_EXITED = "service_exited";

/** One service whose process exited during startup, and its exit status. */
export interface NativeExitedService {
  readonly service: string;
  readonly exitCode: number;
}

const SERVICE = /^[A-Za-z0-9_.-]{1,128}$/;
/** The runtime reports at most three failed services' tails. */
export const NATIVE_EXITED_SERVICES_LIMIT = 3;

/** The exited services among a failure reply's tails, in the runtime's order. */
export function nativeExitedServices(
  logs: readonly NativeStartupLogTail[]
): readonly NativeExitedService[] {
  return logs.flatMap((tail) =>
    tail.exitCode === undefined
      ? []
      : [{ service: tail.service, exitCode: tail.exitCode }]
  );
}

/** Validate exited services received over IPC: names and safe integers only. */
export function isNativeExitedServices(
  value: unknown
): value is readonly NativeExitedService[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > NATIVE_EXITED_SERVICES_LIMIT
  ) {
    return false;
  }
  const names = new Set<string>();
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).length !== 2 ||
      typeof entry.service !== "string" ||
      !SERVICE.test(entry.service) ||
      names.has(entry.service) ||
      typeof entry.exitCode !== "number" ||
      !Number.isSafeInteger(entry.exitCode)
    ) {
      return false;
    }
    names.add(entry.service);
  }
  return true;
}

/**
 * `E_SERVICE_EXITED`. `detail` is the `--json` contract: `reason`, `services`
 * (name and exit code, in the runtime's order, the startup failure first),
 * `alsoFailed` (other failed services without an exit status) and the
 * runtime's own `nativeCode` when it reported one.
 */
export class NativeServiceExitedError extends HackCliError {
  readonly exited: readonly NativeExitedService[];
  readonly alsoFailed: readonly string[];
  readonly nativeCode: string | undefined;

  constructor(opts: {
    readonly exited: readonly NativeExitedService[];
    readonly alsoFailed?: readonly string[];
    readonly nativeCode?: string;
    /** A detached start: point at foreground `up` for the output. */
    readonly detached: boolean;
  }) {
    const exited = opts.exited.slice(0, NATIVE_EXITED_SERVICES_LIMIT);
    const alsoFailed = [...new Set(opts.alsoFailed ?? [])]
      .filter(
        (name) =>
          SERVICE.test(name) && !exited.some((one) => one.service === name)
      )
      .sort();
    super({
      code: "E_SERVICE_EXITED",
      message: nativeServiceExitedMessage({
        exited,
        alsoFailed,
        detached: opts.detached,
      }),
      detail: {
        reason: NATIVE_SERVICE_EXITED,
        services: exited.map((one) => ({
          name: one.service,
          exitCode: one.exitCode,
        })),
        ...(alsoFailed.length > 0 ? { alsoFailed } : {}),
        ...(opts.nativeCode ? { nativeCode: opts.nativeCode } : {}),
      },
    });
    this.exited = exited;
    this.alsoFailed = alsoFailed;
    this.nativeCode = opts.nativeCode;
  }
}

/** The fixed, value-free sentence for exited services. */
export function nativeServiceExitedMessage(opts: {
  readonly exited: readonly NativeExitedService[];
  readonly alsoFailed?: readonly string[];
  readonly detached: boolean;
}): string {
  const exits = opts.exited.map(
    (one) =>
      `Service ${one.service} exited with code ${one.exitCode} ${
        one.exitCode === 0 ? "before it was ready" : "during startup"
      }.`
  );
  const also = opts.alsoFailed?.length
    ? ` Also failed during startup: ${opts.alsoFailed.join(", ")}.`
    : "";
  const next = opts.detached
    ? " A detached start does not keep service output; run hack up without -d in a terminal to see the last lines (managed values redacted, not saved)."
    : " Fix the service's command or configuration and run hack up again.";
  return `${exits.join(" ")}${also} The failed start was stopped.${next}`;
}
