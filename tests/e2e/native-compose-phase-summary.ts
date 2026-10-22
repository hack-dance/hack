import { isRecord } from "../../src/lib/guards.ts";

/** Storage phases whose durations size the native storage budget (HACK-1324). */
const STORAGE_PHASES = new Set([
  "storage.proof",
  "storage.enroll",
  "guard.storage",
  "finalize.witnesses",
]);
const PHASE_LINE = /^\{"diagnostic":"native-compose-phase",[^\n]*\}$/;

export type NativeComposeStorageTimings = {
  /** Completed or failed `storage.proof` spans, one per storage carrier proof. */
  readonly proofs: number;
  readonly proofMaxMs: number;
  readonly proofTotalMs: number;
  /** Longest span per storage phase that ended in this command. */
  readonly longestMs: Readonly<Record<string, number>>;
};

/**
 * Summarize the passive `HACK_NATIVE_COMPOSE_PHASE_TRACE=1` lines of one CLI
 * stderr. Only the fixed diagnostic fields are read: phase names come from the
 * closed set above and durations are integers, so the summary carries no
 * value, path or resource name. Malformed or unknown lines are ignored.
 */
export function summarizeNativeComposeStorageTimings(
  stderr: string
): NativeComposeStorageTimings {
  let proofs = 0;
  let proofMaxMs = 0;
  let proofTotalMs = 0;
  const longestMs: Record<string, number> = {};
  for (const line of stderr.split("\n")) {
    if (!PHASE_LINE.test(line)) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      !(
        isRecord(value) &&
        typeof value.phase === "string" &&
        STORAGE_PHASES.has(value.phase) &&
        (value.boundary === "end" || value.boundary === "fail") &&
        Number.isSafeInteger(value.durationMs) &&
        (value.durationMs as number) >= 0
      )
    ) {
      continue;
    }
    const duration = value.durationMs as number;
    longestMs[value.phase] = Math.max(longestMs[value.phase] ?? 0, duration);
    if (value.phase === "storage.proof") {
      proofs += 1;
      proofMaxMs = Math.max(proofMaxMs, duration);
      proofTotalMs += duration;
    }
  }
  return { proofs, proofMaxMs, proofTotalMs, longestMs };
}

/** One fixed log line for a command's storage timings. */
export function describeNativeComposeStorageTimings(
  timings: NativeComposeStorageTimings
): string {
  const longest = [...STORAGE_PHASES]
    .filter((phase) => Object.hasOwn(timings.longestMs, phase))
    .map((phase) => `${phase}=${timings.longestMs[phase]}ms`)
    .join(" ");
  return `storage proofs=${timings.proofs} max=${timings.proofMaxMs}ms total=${timings.proofTotalMs}ms${longest ? ` longest ${longest}` : ""}`;
}
