import { isRecord } from "../lib/guards.ts";

const SERVICE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const STAGES = new Set([
  "connect_timeout",
  "connect",
  "timeout",
  "response",
  "worker",
  "transport",
  "deadline",
]);

export interface NativeStopFailure {
  readonly service: string;
  readonly stage: string;
}

/** The native owner verifies service membership; this boundary accepts only the
 * bounded versioned presentation contract. Detail grants no retry authority.
 */
export function readNativeStopFailures(
  value: unknown
): readonly NativeStopFailure[] | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.version !== 1 ||
    !Array.isArray(value.failures) ||
    value.failures.length < 1 ||
    value.failures.length > 32
  ) {
    return;
  }
  const names = new Set<string>();
  const result: NativeStopFailure[] = [];
  for (const failure of value.failures) {
    if (
      !isRecord(failure) ||
      Object.keys(failure).length !== 2 ||
      typeof failure.service !== "string" ||
      failure.service.trim() !== failure.service ||
      !SERVICE.test(failure.service) ||
      names.has(failure.service) ||
      typeof failure.stage !== "string" ||
      !STAGES.has(failure.stage)
    ) {
      return;
    }
    names.add(failure.service);
    result.push({ service: failure.service, stage: failure.stage });
  }
  return result;
}

export function nativeStopFailureSummary(
  failures: readonly NativeStopFailure[] | undefined
): string {
  return failures?.length
    ? ` Stop request diagnostics: ${failures.map(({ service, stage }) => `${service} (${stage})`).join(", ")}. No uncertain stop was replayed.`
    : "";
}
