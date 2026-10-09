import { AsyncLocalStorage } from "node:async_hooks";
import { writeSync } from "node:fs";

export const NATIVE_COMPOSE_PHASE_TRACE = "HACK_NATIVE_COMPOSE_PHASE_TRACE";
const PHASES = [
  "oneoff.post-remove-owned",
  "oneoff.post-remove-fresh",
  "oneoff.post-remove-guard",
  "storage.enroll",
  "guard.fresh-before",
  "guard.ownership",
  "guard.storage",
  "guard.fresh-after",
  "finish.pending",
  "finish.witness-work",
  "finalize.fresh",
  "finalize.generation",
  "finalize.projection",
  "finalize.owned",
  "finalize.remember-storage",
  "finalize.witnesses",
  "finalize.pending",
  "finalize.pending-check",
  "finalize.before-complete",
  "finalize.save",
] as const;
type Phase = (typeof PHASES)[number];
const RECORD_LIMIT = 256;
const BYTE_LIMIT = 64 * 1024;
type Trace = ReturnType<typeof createNativeComposePhaseTrace>;
const context = new AsyncLocalStorage<Trace | undefined>();

/**
 * Passive, bounded observations only. A begin line precedes the original await;
 * end/fail describes that await, never command success or cleanup authority.
 * Clock/output failure disables observations without replacing the result.
 */
export function createNativeComposePhaseTrace(opts: {
  readonly write: (line: string) => void;
  readonly now?: () => number;
}) {
  const write = opts.write;
  const now = opts.now ?? (() => performance.now());
  let origin: number | undefined;
  let previous = 0;
  let sequence = 0;
  let spans = 0;
  let bytes = 0;
  let disabled = false;
  function time(): number | undefined {
    if (disabled) {
      return;
    }
    try {
      const current = now();
      if (!(typeof current === "number" && Number.isFinite(current))) {
        disabled = true;
        return;
      }
      origin ??= current;
      const elapsed = current - origin;
      if (!(Number.isFinite(elapsed) && elapsed >= previous && elapsed >= 0)) {
        disabled = true;
        return;
      }
      previous = elapsed;
      return elapsed;
    } catch {
      disabled = true;
      return;
    }
  }
  function emit(
    phase: Phase,
    span: number,
    boundary: "begin" | "end" | "fail",
    started: number
  ) {
    const elapsed = time();
    if (elapsed === undefined) {
      return;
    }
    try {
      const line = `${JSON.stringify({
        diagnostic: "native-compose-phase",
        version: 1,
        sequence: sequence + 1,
        span,
        phase,
        boundary,
        elapsedMs: Math.round(elapsed),
        durationMs: boundary === "begin" ? null : Math.round(elapsed - started),
      })}\n`;
      const size = Buffer.byteLength(line);
      if (sequence >= RECORD_LIMIT || bytes + size > BYTE_LIMIT) {
        disabled = true;
        return;
      }
      sequence += 1;
      bytes += size;
      write(line);
    } catch {
      disabled = true;
    }
  }
  return {
    async measure<T>(phase: Phase, operation: () => Promise<T>): Promise<T> {
      const started = time();
      if (started === undefined || !PHASES.some((value) => value === phase)) {
        return await operation();
      }
      const span = ++spans;
      emit(phase, span, "begin", started);
      try {
        const result = await operation();
        emit(phase, span, "end", started);
        return result;
      } catch (error) {
        emit(phase, span, "fail", started);
        throw error;
      }
    },
  };
}

/** Consume the launch flag before children inherit it; concurrent requests stay separate. */
export function withNativeComposePhaseTrace<T>(operation: () => Promise<T>) {
  let trace: Trace | undefined;
  try {
    const enabled = process.env[NATIVE_COMPOSE_PHASE_TRACE] === "1";
    delete process.env[NATIVE_COMPOSE_PHASE_TRACE];
    if (enabled) {
      trace = createNativeComposePhaseTrace({
        write: (line) => {
          writeSync(2, line);
        },
      });
    }
  } catch {
    // Diagnostic setup never changes selection, results or effect authority.
  }
  return context.run(trace, operation);
}

/** The fixed phase never comes from authored inputs, resource identity or an error. */
export function measureNativeComposePhase<T>(
  phase: Phase,
  operation: () => Promise<T>
): Promise<T> {
  return context.getStore()?.measure(phase, operation) ?? operation();
}
