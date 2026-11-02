export type NativeProcessCensusSample = Readonly<{
  phase: "metadata" | "sessions" | "merge" | "census";
  outcome: "complete" | "refused";
  elapsedMs: number;
  rowCount: number | null;
}>;
export type NativeProcessCensusDiagnostics = Readonly<{
  snapshot: () => Readonly<{
    samples: readonly NativeProcessCensusSample[];
    dropped: number;
  }>;
}>;
const collectors = new WeakMap<
  NativeProcessCensusDiagnostics,
  { samples: NativeProcessCensusSample[]; dropped: number }
>();
const SAMPLE_LIMIT = 256;

/** Explicit, bounded in-memory diagnostics. No process identities or error text. */
export function createNativeProcessCensusDiagnostics(): NativeProcessCensusDiagnostics {
  const state = { samples: [] as NativeProcessCensusSample[], dropped: 0 };
  const collector = Object.freeze({
    snapshot: () =>
      Object.freeze({
        samples: Object.freeze([...state.samples]),
        dropped: state.dropped,
      }),
  });
  collectors.set(collector, state);
  return collector;
}

export function beginNativeProcessCensusPhase(opts: {
  diagnostics: NativeProcessCensusDiagnostics | undefined;
  phase: NativeProcessCensusSample["phase"];
}):
  | ((result: {
      outcome: NativeProcessCensusSample["outcome"];
      rowCount?: number;
    }) => void)
  | undefined {
  if (!opts.diagnostics) {
    return;
  }
  const state = collectors.get(opts.diagnostics);
  if (!state) {
    throw new Error("Invalid native census diagnostics collector.");
  }
  const start = performance.now();
  let finished = false;
  return (result) => {
    if (finished) {
      return;
    }
    finished = true;
    if (state.samples.length >= SAMPLE_LIMIT) {
      state.samples.shift();
      state.dropped++;
    }
    state.samples.push(
      Object.freeze({
        phase: opts.phase,
        outcome: result.outcome,
        elapsedMs: Math.max(0, performance.now() - start),
        rowCount: result.rowCount ?? null,
      })
    );
  };
}
