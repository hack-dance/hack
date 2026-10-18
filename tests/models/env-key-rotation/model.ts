/** Proposed ordering only. No files, secret bytes, crypto, or production APIs. */
export type Generation = 0 | 1 | 2;
export type Journal = "absent" | "prepared" | "committed";
export type Fault =
  | "none"
  | "unguarded-reader"
  | "late-journal"
  | "early-commit";
export type State = {
  readonly key: Generation;
  readonly store: Generation;
  readonly journal: Journal;
  readonly oldSnapshot: boolean;
  readonly newSnapshot: boolean;
  readonly running: boolean;
  readonly finished: boolean;
  readonly committed: boolean;
};
export type Step = { readonly action: string; readonly state: State };

export const initialState: State = {
  key: 0,
  store: 0,
  journal: "absent",
  oldSnapshot: false,
  newSnapshot: false,
  running: true,
  finished: false,
  committed: false,
};

export function reader(state: State, fault: Fault = "none") {
  if (state.running && !state.finished) {
    return "blocked";
  }
  if (state.journal !== "absent" && fault !== "unguarded-reader") {
    return "blocked";
  }
  return state.key === state.store ? state.key : "mixed";
}

export function violation(state: State, fault: Fault = "none"): string | null {
  if (reader(state, fault) === "mixed") {
    return "reader accepted a mixed generation";
  }
  if (state.journal !== "absent" && !state.oldSnapshot) {
    return "mutation admitted without a durable old snapshot";
  }
  if (state.committed && !state.newSnapshot) {
    return "commit selected a generation without durable payloads";
  }
  if (state.finished && state.key !== (state.committed ? 1 : 0)) {
    return "recovery contradicted the durable commit decision";
  }
  return null;
}

function step(state: State, action: string, patch: Partial<State>): Step {
  return { action, state: { ...state, ...patch } };
}

function writerSteps(state: State, fault: Fault): Step[] {
  if (!state.oldSnapshot) {
    return [
      step(state, "sync-old-and-new-snapshots", {
        oldSnapshot: true,
        newSnapshot: fault !== "early-commit",
      }),
    ];
  }
  if (state.journal === "absent" && state.key === 0) {
    const steps = [
      step(state, "publish-prepared-journal", { journal: "prepared" }),
    ];
    if (fault === "late-journal") {
      steps.push(step(state, "replace-key-before-journal", { key: 1 }));
    }
    return steps;
  }
  if (state.journal === "prepared") {
    if (fault === "early-commit" && state.key === 0) {
      return [
        step(state, "commit-before-payload-sync", {
          journal: "committed",
          committed: true,
        }),
      ];
    }
    if (state.key === 0) {
      return [step(state, "replace-key", { key: 1 })];
    }
    if (state.store === 0) {
      return [step(state, "replace-store", { store: 1 })];
    }
    return [
      step(state, "verify-pair-and-commit", {
        journal: "committed",
        committed: true,
      }),
    ];
  }
  if (state.journal === "committed") {
    return [
      step(state, "archive-journal-then-unlock", {
        journal: "absent",
        finished: true,
        running: false,
      }),
    ];
  }
  return [];
}

export function recoverySteps(state: State): Step[] {
  if (state.running || state.finished || state.key === 2 || state.store === 2) {
    return [];
  }
  if (state.journal === "absent") {
    return state.key === 0 && state.store === 0
      ? [step(state, "no-transaction-to-recover", { finished: true })]
      : [];
  }
  const generation = state.journal === "committed" ? 1 : 0;
  if (!(generation === 0 ? state.oldSnapshot : state.newSnapshot)) {
    return [];
  }
  if (state.key !== generation) {
    return [step(state, "recover-key", { key: generation })];
  }
  if (state.store !== generation) {
    return [step(state, "recover-store", { store: generation })];
  }
  return [
    step(state, "verify-recovered-pair-and-archive", {
      journal: "absent",
      finished: true,
    }),
  ];
}

export function transitions(state: State, fault: Fault = "none"): Step[] {
  if (state.finished) {
    return [];
  }
  if (!state.running) {
    return recoverySteps(state);
  }
  return [
    ...writerSteps(state, fault),
    step(state, "process-crash", { running: false }),
  ];
}

export function explore(fault: Fault = "none") {
  const queue: { state: State; trace: string[] }[] = [
    { state: initialState, trace: [] },
  ];
  const seen = new Set<string>();
  const states: State[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    const identity = JSON.stringify(current.state);
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    states.push(current.state);
    const failed = violation(current.state, fault);
    if (failed) {
      return { states, failure: { reason: failed, trace: current.trace } };
    }
    for (const next of transitions(current.state, fault)) {
      queue.push({ state: next.state, trace: [...current.trace, next.action] });
    }
  }
  return { states, failure: null };
}
