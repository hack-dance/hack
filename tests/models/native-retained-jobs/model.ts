/** Finite, test-only model; no filesystem, subprocess, clock or engine access. */
export type Fault =
  | "none"
  | "historical-zero"
  | "nonzero"
  | "recovery-replay"
  | "early-clear"
  | "fence"
  | "deadline"
  | "commit-start-fence"
  | "commit-start-deadline"
  | "commit-stop-fence"
  | "commit-stop-deadline";
type Phase =
  | "idle"
  | "starting"
  | "stopping"
  | "running"
  | "uncertain"
  | "recovering"
  | "stopped";
type JobState = "old-zero" | "running" | "zero" | "nonzero" | "stopped";
type Operation = "start" | "restart" | "stop";
export type State = {
  readonly phase: Phase;
  readonly pending: Operation | null;
  /** Fixed original generation and membership are retained even after interruption. */
  readonly anchor: 1;
  readonly fence: 1 | 2;
  readonly cursor: number;
  readonly attempt: number;
  readonly remaining: number;
  readonly dbRunning: boolean;
  readonly dbReady: boolean;
  readonly appRunning: boolean;
  readonly appAttempt: number;
  readonly job: JobState;
  readonly jobStarts: number;
  readonly priorStart: number;
  readonly captured: boolean;
  readonly spawned: boolean;
  readonly accepted: boolean;
  readonly crashes: number;
  readonly seedWrites: 1;
  readonly originalIds: "db-original,seed-original,app-original";
  readonly unsafeHistorical: boolean;
  readonly unsafeNonzero: boolean;
  readonly unsafeReplay: boolean;
  readonly unsafeFence: boolean;
  readonly unsafeDeadline: boolean;
  readonly unsafeCommitFence: boolean;
  readonly unsafeCommitDeadline: boolean;
};
export type Edge = { readonly action: string; readonly state: State };
export type Violation =
  | "NoHistoricalCompletion"
  | "NoFailedDependencyStart"
  | "NoRecoveryJobReplay"
  | "NoPrematureReceiptClear"
  | "NoForeignEffect"
  | "NoExpiredEffect"
  | "NoForeignCommit"
  | "NoExpiredCommit";

export function initialState(): State {
  return Object.freeze({
    phase: "idle",
    pending: null,
    anchor: 1,
    fence: 1,
    cursor: 0,
    attempt: 0,
    remaining: 3,
    dbRunning: false,
    dbReady: false,
    appRunning: false,
    appAttempt: 0,
    job: "old-zero",
    jobStarts: 0,
    priorStart: 0,
    captured: false,
    spawned: false,
    accepted: false,
    crashes: 0,
    seedWrites: 1,
    originalIds: "db-original,seed-original,app-original",
    unsafeHistorical: false,
    unsafeNonzero: false,
    unsafeReplay: false,
    unsafeFence: false,
    unsafeDeadline: false,
    unsafeCommitFence: false,
    unsafeCommitDeadline: false,
  });
}
function admitted(s: State, fault: Fault): boolean {
  return (
    (s.fence === 1 || fault === "fence") &&
    (s.remaining > 0 || fault === "deadline")
  );
}
function next(s: State, change: Partial<State>): State {
  return Object.freeze({ ...s, ...change });
}
function effect(s: State, change: Partial<State>): State {
  return next(s, {
    ...change,
    unsafeFence: s.unsafeFence || s.fence !== 1,
    unsafeDeadline: s.unsafeDeadline || s.remaining === 0,
    unsafeReplay:
      s.unsafeReplay ||
      (s.phase === "recovering" &&
        typeof change.jobStarts === "number" &&
        change.jobStarts > s.jobStarts),
  });
}
function commitAdmitted(
  s: State,
  fault: Fault,
  operation: "start" | "stop"
): boolean {
  return (
    (s.fence === 1 || fault === `commit-${operation}-fence`) &&
    (s.remaining > 0 || fault === `commit-${operation}-deadline`)
  );
}
/** Publication is an authority/deadline boundary even when it spawns no child. */
function commit(s: State, change: Partial<State>): State {
  return next(s, {
    ...change,
    unsafeCommitFence: s.unsafeCommitFence || s.fence !== 1,
    unsafeCommitDeadline: s.unsafeCommitDeadline || s.remaining === 0,
  });
}
function startPhase(s: State, fault: Fault): readonly Edge[] {
  if (
    !(s.cursor === 3
      ? commitAdmitted(s, fault, "start")
      : admitted(s, fault))
  ) {
    return [];
  }
  if (s.cursor === 0) {
    return s.dbRunning
      ? [
          {
            action: "ObserveDbReady",
            state: next(s, { dbReady: true, cursor: 1 }),
          },
        ]
      : [{ action: "StartDb", state: effect(s, { dbRunning: true }) }];
  }
  if (s.cursor === 1) {
    return jobPhase(s, fault);
  }
  if (s.cursor === 2 && s.accepted) {
    return [
      {
        action: "StartApp",
        state: effect(s, {
          appRunning: true,
          appAttempt: s.attempt,
          cursor: 3,
          unsafeHistorical:
            s.unsafeHistorical || !(s.spawned && s.jobStarts !== s.priorStart),
          unsafeNonzero: s.unsafeNonzero || s.job === "nonzero",
        }),
      },
    ];
  }
  if (
    s.cursor === 3 &&
    s.dbRunning &&
    s.dbReady &&
    s.appRunning &&
    s.job === "zero" &&
    s.spawned &&
    s.jobStarts !== s.priorStart
  ) {
    return [
      {
        action: "CommitStart",
        state: commit(s, { phase: "running", pending: null }),
      },
    ];
  }
  return [];
}
function jobPhase(s: State, fault: Fault): readonly Edge[] {
  const edges: Edge[] = [];
  if (fault === "historical-zero" && s.job === "old-zero") {
    edges.push({
      action: "AcceptHistoricalZero",
      state: next(s, { cursor: 2, accepted: true }),
    });
  }
  if (!s.captured) {
    edges.push({
      action: "CapturePriorStart",
      state: next(s, { priorStart: s.jobStarts, captured: true }),
    });
  } else if (!s.spawned && s.dbRunning && s.dbReady) {
    for (const job of ["running", "zero", "nonzero"] as const) {
      edges.push({
        action: `StartJob:${job}`,
        state: effect(s, { job, jobStarts: s.jobStarts + 1, spawned: true }),
      });
    }
  } else if (s.spawned && s.job === "zero" && s.jobStarts !== s.priorStart) {
    edges.push({
      action: "ObserveFreshZero",
      state: next(s, { cursor: 2, accepted: true }),
    });
  } else if (s.job === "nonzero") {
    edges.push({
      action: "ObserveNonzero",
      state: next(s, { phase: "uncertain", accepted: false }),
    });
    if (fault === "nonzero") {
      edges.push({
        action: "IgnoreNonzero",
        state: next(s, { cursor: 2, accepted: true }),
      });
    }
  }
  return edges;
}
function stopPhase(s: State, fault: Fault): readonly Edge[] {
  const finalStop =
    s.cursor === -1 &&
    !(s.phase === "stopping" && s.pending === "restart");
  if (
    !(finalStop
      ? commitAdmitted(s, fault, "stop")
      : admitted(s, fault))
  ) {
    return [];
  }
  const edges: Edge[] = [];
  if (
    fault === "recovery-replay" &&
    s.phase === "recovering" &&
    s.jobStarts < 3
  ) {
    edges.push({
      action: "ReplayJobDuringRecovery",
      state: effect(s, { jobStarts: s.jobStarts + 1 }),
    });
  }
  if (s.cursor === 2) {
    edges.push({
      action: "StopApp",
      state: effect(s, { appRunning: false, cursor: 1 }),
    });
  } else if (s.cursor === 1) {
    edges.push({
      action: "StopJob",
      state: effect(s, { job: "stopped", cursor: 0 }),
    });
  } else if (s.cursor === 0) {
    edges.push({
      action: "StopDb",
      state: effect(s, { dbRunning: false, dbReady: false, cursor: -1 }),
    });
    if (fault === "early-clear" && s.dbRunning) {
      edges.push({
        action: "ClearBeforeLastStop",
        state: next(s, { pending: null, phase: "stopped" }),
      });
    }
  } else if (!(s.dbRunning || s.appRunning) && s.job === "stopped") {
    if (s.phase === "stopping" && s.pending === "restart") {
      // Same invocation and same aggregate budget: stopping cannot refill it.
      edges.push({
        action: "BeginForwardStart",
        state: next(s, {
          phase: "starting",
          cursor: 0,
          captured: false,
          spawned: false,
          accepted: false,
        }),
      });
    } else {
      edges.push({
        action: "CommitStop",
        state: commit(s, { phase: "stopped", pending: null, accepted: false }),
      });
    }
  }
  return edges;
}

function newInvocation(s: State): readonly Edge[] {
  const edges: Edge[] = [];
  if (
    (s.phase === "idle" || s.phase === "stopped") &&
    s.fence === 1 &&
    s.attempt < 2
  ) {
    edges.push({
      action: "JournalStart",
      state: next(s, {
        pending: "start",
        phase: "starting",
        attempt: s.attempt + 1,
        cursor: 0,
        captured: false,
        spawned: false,
        accepted: false,
        remaining: 3,
      }),
    });
  }
  if (s.phase === "running" && s.fence === 1) {
    edges.push({
      action: "JournalStop",
      state: next(s, {
        pending: "stop",
        phase: "stopping",
        cursor: 2,
        remaining: 3,
      }),
    });
    if (s.attempt < 2) {
      edges.push({
        action: "JournalRestart",
        state: next(s, {
          pending: "restart",
          phase: "stopping",
          attempt: s.attempt + 1,
          cursor: 2,
          remaining: 3,
        }),
      });
    }
  }
  return edges;
}

function pendingTransitions(s: State): readonly Edge[] {
  const edges: Edge[] = [];
  if (s.pending !== null) {
    if (s.fence === 1) {
      edges.push({ action: "ReplaceFence", state: next(s, { fence: 2 }) });
    }
    if (s.phase !== "uncertain" && s.remaining > 0) {
      edges.push({
        action: "Tick",
        state: next(s, { remaining: s.remaining - 1 }),
      });
    }
    if (s.phase !== "uncertain" && s.remaining === 0) {
      edges.push({
        action: "DeadlineRefusal",
        state: next(s, { phase: "uncertain" }),
      });
    }
    if (s.phase !== "uncertain" && s.crashes === 0) {
      edges.push({
        action: "Interrupt",
        state: next(s, {
          phase: "uncertain",
          crashes: 1,
          captured: false,
          spawned: false,
        }),
      });
    }
    if (s.phase === "uncertain" && s.fence === 1) {
      // Separate explicit down --recover command; old pending selection stays exact.
      edges.push({
        action: "RecoverStopped",
        state: next(s, { phase: "recovering", cursor: 2, remaining: 3 }),
      });
    }
  }
  return edges;
}

export function transitions(s: State, fault: Fault = "none"): readonly Edge[] {
  const edges: Edge[] = [...newInvocation(s), ...pendingTransitions(s)];
  if (s.job === "running") {
    for (const job of ["zero", "nonzero"] as const) {
      edges.push({ action: `JobExit:${job}`, state: next(s, { job }) });
    }
  }
  if (s.phase === "starting") {
    edges.push(...startPhase(s, fault));
  }
  if (s.phase === "stopping" || s.phase === "recovering") {
    edges.push(...stopPhase(s, fault));
  }
  return edges;
}

export function violation(s: State): Violation | undefined {
  if (s.unsafeHistorical) {
    return "NoHistoricalCompletion";
  }
  if (s.unsafeNonzero) {
    return "NoFailedDependencyStart";
  }
  if (s.unsafeReplay) {
    return "NoRecoveryJobReplay";
  }
  if (
    s.phase === "stopped" &&
    s.pending === null &&
    (s.dbRunning || s.appRunning || s.job === "running")
  ) {
    return "NoPrematureReceiptClear";
  }
  if (s.unsafeFence) {
    return "NoForeignEffect";
  }
  if (s.unsafeDeadline) {
    return "NoExpiredEffect";
  }
  if (s.unsafeCommitFence) {
    return "NoForeignCommit";
  }
  if (s.unsafeCommitDeadline) {
    return "NoExpiredCommit";
  }
  return undefined;
}
export type Exploration = {
  readonly complete: boolean;
  readonly states: number;
  readonly generated: number;
  readonly reached: ReadonlySet<string>;
  readonly counterexample?: {
    readonly invariant: Violation;
    readonly trace: readonly Edge[];
  };
};

/** Exhausts one finite instance; guard-removal failures preserve the exact first witness. */
export function exploreDraftModel(fault: Fault = "none"): Exploration {
  const first = initialState();
  const queue: { state: State; trace: readonly Edge[] }[] = [
    { state: first, trace: [] },
  ];
  const visited = new Set([JSON.stringify(first)]);
  const reached = new Set<string>();
  let generated = 1;
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (!current) {
      throw new Error("Finite retained-job exploration lost a state");
    }
    const failed = violation(current.state);
    if (failed) {
      return {
        complete: false,
        states: visited.size,
        generated,
        reached,
        counterexample: { invariant: failed, trace: current.trace },
      };
    }
    for (const edge of transitions(current.state, fault)) {
      generated += 1;
      reached.add(edge.action);
      const key = JSON.stringify(edge.state);
      if (!visited.has(key)) {
        visited.add(key);
        queue.push({ state: edge.state, trace: [...current.trace, edge] });
      }
    }
  }
  return { complete: true, states: visited.size, generated, reached };
}
