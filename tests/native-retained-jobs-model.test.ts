import { expect, test } from "bun:test";
import { parseLegacyComposeAdoptionReceipt } from "../src/lib/native-compose-adoption-receipt.ts";
import {
  canAdmitDraftEffect,
  type DraftFence,
  decodeVersion7SelectionDraft,
  freshJobResultDraft,
  NEVER_STARTED,
  type ObservationDraft,
} from "./models/native-retained-jobs/contract.ts";
import {
  exploreDraftModel,
  type Fault,
  initialState,
  type State,
  transitions,
  type Violation,
  violation,
} from "./models/native-retained-jobs/model.ts";

const ID_DB = "1".repeat(64);
const ID_JOB = "2".repeat(64);
const ID_APP = "3".repeat(64);
const OLD = "2026-10-08T00:00:01.123456789Z";
const NEW = "2026-10-08T00:00:02.123456789Z";
const FINISHED = "2026-10-08T00:00:03.123456789Z";
function selectionInput() {
  return {
    adoption_receipt_version: 7,
    adoption_generation_version: 7,
    binding_version: 1,
    sourceFamily: "static-pair",
    networkFamily: "default-bridge",
    managed: false,
    typedLocal: false,
    profiles: false,
    routing: false,
    hostHooks: false,
    originals: [
      { name: "db", kind: "service", id: ID_DB, configHash: "4".repeat(64) },
      { name: "seed", kind: "job", id: ID_JOB, configHash: "5".repeat(64) },
      { name: "app", kind: "service", id: ID_APP, configHash: "6".repeat(64) },
    ],
  };
}
function selection() {
  const decoded = decodeVersion7SelectionDraft(selectionInput());
  if (!decoded) {
    throw new Error("Synthetic draft selection refused");
  }
  return decoded;
}
function observations(): ObservationDraft[] {
  return [ID_DB, ID_JOB, ID_APP].map((id) => ({
    id,
    running: id !== ID_JOB,
    paused: false,
    status: id === ID_JOB ? "exited" : "running",
    exitCode: 0,
    startedAt: NEW,
    finishedAt: id === ID_JOB ? FINISHED : NEVER_STARTED,
    restartPolicy: "no",
    maximumRetryCount: 0,
  }));
}
function job(patch: Partial<ObservationDraft>) {
  return observations().map((row) =>
    row.id === ID_JOB ? { ...row, ...patch } : row
  );
}
function result(rows: unknown, started = true, priorStartedAt = OLD) {
  return freshJobResultDraft({
    selection: selection(),
    attempt: { id: ID_JOB, started, priorStartedAt },
    observations: rows,
  });
}
function step(state: State, action: string): State {
  const edge = transitions(state).find((item) => item.action === action);
  if (!edge) {
    throw new Error(`Unavailable model action: ${action}`);
  }
  expect(violation(edge.state)).toBeUndefined();
  return edge.state;
}
function firstReady() {
  let state = initialState();
  for (const action of [
    "JournalStart",
    "StartDb",
    "ObserveDbReady",
    "CapturePriorStart",
    "StartJob:zero",
    "ObserveFreshZero",
    "StartApp",
  ]) {
    state = step(state, action);
  }
  return state;
}
function firstSuccess() {
  return step(firstReady(), "CommitStart");
}

test("closed draft version7 keeps original IDs and refuses withheld combinations", () => {
  const decoded = selection();
  expect(decoded.originals.map((item) => item.id)).toEqual([
    ID_DB,
    ID_JOB,
    ID_APP,
  ]);
  expect(Object.isFrozen(decoded)).toBe(true);
  expect(Object.isFrozen(decoded.originals[0])).toBe(true);
  for (const delta of [
    { adoption_receipt_version: 5 },
    { adoption_receipt_version: 6 },
    { adoption_generation_version: 6 },
    { adoption_generation_version: "7" },
    { binding_version: 3 },
    { binding_version: 4 },
    { sourceFamily: "generated" },
    { networkFamily: "custom-bridge" },
    { managed: true },
    { typedLocal: true },
    { profiles: true },
    { routing: true },
    { hostHooks: true },
    { unexpected: false },
  ]) {
    expect(
      decodeVersion7SelectionDraft({ ...selectionInput(), ...delta })
    ).toBeUndefined();
  }
  for (const originals of [
    [],
    selectionInput().originals.map((row) => ({ ...row, kind: "service" })),
    [...selectionInput().originals, selectionInput().originals[0]],
    selectionInput().originals.map((row) => ({ ...row, id: ID_DB })),
    selectionInput().originals.map((row) => ({ ...row, configHash: "short" })),
    selectionInput().originals.map((row) => ({ ...row, id: "short" })),
  ]) {
    expect(
      decodeVersion7SelectionDraft({ ...selectionInput(), originals })
    ).toBeUndefined();
  }
});

test("draft7 does not register or upgrade the current production receipt codec", () => {
  const checkout = {
    root: { dev: 1, ino: 1 },
    project: { dev: 1, ino: 2 },
    git: { dev: 1, ino: 3 },
  };
  expect(() =>
    parseLegacyComposeAdoptionReceipt(
      {
        adoption_receipt_version: 7,
        kind: "legacy-compose-adopted",
        checkout,
        prepared: null,
        publication: null,
        pendingOperation: null,
      },
      checkout
    )
  ).toThrow("receipt is invalid");
});

test("untrusted draft projections reject getter fields before invoking them", () => {
  let reads = 0;
  const input = selectionInput();
  Object.defineProperty(input, "adoption_receipt_version", {
    enumerable: true,
    get() {
      reads += 1;
      return 7;
    },
  });
  expect(decodeVersion7SelectionDraft(input)).toBeUndefined();
  expect(reads).toBe(0);
});

test("sparse getter and extra-member arrays cannot become original membership", () => {
  const sparse = selectionInput();
  Reflect.deleteProperty(sparse.originals, "1");
  expect(decodeVersion7SelectionDraft(sparse)).toBeUndefined();
  let reads = 0;
  const getters = selectionInput();
  const first = getters.originals[0];
  Object.defineProperty(getters.originals, "0", {
    enumerable: true,
    get() {
      reads += 1;
      return first;
    },
  });
  expect(decodeVersion7SelectionDraft(getters)).toBeUndefined();
  expect(reads).toBe(0);
  const rows = observations();
  Reflect.deleteProperty(rows, "1");
  expect(result(rows)).toBe("refused");
  const hidden = selectionInput();
  Object.defineProperty(hidden, "extra", { value: true, enumerable: false });
  expect(decodeVersion7SelectionDraft(hidden)).toBeUndefined();
});

test("fresh fast exit0 is valid without an observed intermediate running state", () => {
  expect(result(observations())).toBe("ready");
  expect(result(job({ startedAt: NEW }), false)).toBe("waiting");
  expect(result(job({ startedAt: OLD }))).toBe("waiting");
  expect(result(job({ startedAt: NEVER_STARTED }))).toBe("waiting");
  expect(
    result(job({ running: true, status: "running", finishedAt: NEVER_STARTED }))
  ).toBe("waiting");
  expect(result(job({ exitCode: 17 }))).toBe("failed");
});

test.each([
  ["2026-10-08T00:00:01Z", "2026-10-08T00:00:01.000Z"],
  ["2026-10-08T00:00:01.000000000Z", "2026-10-08T00:00:01Z"],
  ["2026-10-08T00:00:01.1Z", "2026-10-08T00:00:01.100000000Z"],
])("equivalent UTC spellings cannot make historical exit0 fresh: %s -> %s", (
  prior,
  current
) => {
  expect(result(job({ startedAt: current }), true, prior)).toBe("waiting");
});

test.each([
  "0001-01-01T00:00:00.000Z",
  "0001-01-01T00:00:00.000000000Z",
])("fractional Docker zero remains never-started/never-finished: %s", (zero) => {
  expect(result(job({ startedAt: zero }))).toBe("waiting");
  expect(result(job({ finishedAt: zero }))).toBe("refused");
  expect(result(job({ startedAt: NEVER_STARTED }), true, zero)).toBe("waiting");
  expect(result(job({ startedAt: NEW }), true, zero)).toBe("ready");
});

test("a genuine one-nanosecond attempt change survives millisecond normalization", () => {
  expect(
    result(job({ startedAt: OLD }), true, "2026-10-08T00:00:01.123456788Z")
  ).toBe("ready");
  expect(
    result(job({ startedAt: "1970-01-01T00:00:00Z" }), true, OLD)
  ).toBe("ready");
});

test.each([
  { paused: true },
  { running: true },
  { status: "dead" },
  { restartPolicy: "on-failure" },
  { maximumRetryCount: 1 },
  { startedAt: "invalid" },
  { startedAt: "2026-02-30T00:00:00Z" },
  { finishedAt: "invalid" },
  { finishedAt: NEVER_STARTED },
  { exitCode: -1 },
  { exitCode: 256 },
  { status: null },
  { id: "short" },
])("invalid original job observation refuses %j", (patch) => {
  const rows = observations().map((row) =>
    row.id === ID_JOB ? { ...row, ...patch } : row
  );
  expect(result(rows)).toBe("refused");
});

test("missing duplicate foreign extra and unknown observation fields refuse", () => {
  const rows = observations();
  for (const changed of [
    rows.slice(1),
    [...rows, rows[0]],
    [rows[0], rows[0], rows[2]],
    rows.map((row) =>
      row.id === ID_JOB ? { ...row, id: "9".repeat(64) } : row
    ),
    rows.map((row) => ({ ...row, unknown: true })),
  ]) {
    expect(result(changed)).toBe("refused");
  }
});

test("all final authority fences and the single absolute deadline must still hold", () => {
  const fence: DraftFence = {
    generation: true,
    source: true,
    engine: true,
    originals: true,
    configuration: true,
  };
  expect(
    canAdmitDraftEffect({ fence, deadline: 10, now: 9, cancelled: false })
  ).toBe(true);
  for (const key of [
    "generation",
    "source",
    "engine",
    "originals",
    "configuration",
  ] as const) {
    expect(
      canAdmitDraftEffect({
        fence: { ...fence, [key]: false },
        deadline: 10,
        now: 9,
        cancelled: false,
      })
    ).toBe(false);
  }
  for (const delta of [
    { now: 10 },
    { now: 11 },
    { deadline: Number.NaN },
    { now: Number.POSITIVE_INFINITY },
    { cancelled: true },
  ]) {
    expect(
      canAdmitDraftEffect({
        fence,
        deadline: 10,
        now: 9,
        cancelled: false,
        ...delta,
      })
    ).toBe(false);
  }
});

test("positive finite exploration reaches success, failure, interruption, recovery and explicit retry", () => {
  const explored = exploreDraftModel();
  expect(explored.complete).toBe(true);
  expect(explored.counterexample).toBeUndefined();
  expect(explored.states).toBe(9248);
  expect(explored.generated).toBe(18_049);
  for (const action of [
    "StartJob:zero",
    "StartJob:running",
    "JobExit:zero",
    "ObserveNonzero",
    "Interrupt",
    "RecoverStopped",
    "CommitStop",
    "CommitStart",
    "JournalRestart",
    "BeginForwardStart",
    "ReplaceFence",
    "DeadlineRefusal",
  ]) {
    expect(explored.reached.has(action)).toBe(true);
  }
});

test.each([
  {
    fault: "historical-zero",
    invariant: "NoHistoricalCompletion",
    witness: "StartApp",
  },
  {
    fault: "nonzero",
    invariant: "NoFailedDependencyStart",
    witness: "StartApp",
  },
  {
    fault: "recovery-replay",
    invariant: "NoRecoveryJobReplay",
    witness: "ReplayJobDuringRecovery",
  },
  {
    fault: "early-clear",
    invariant: "NoPrematureReceiptClear",
    witness: "ClearBeforeLastStop",
  },
  { fault: "fence", invariant: "NoForeignEffect", witness: "StartDb" },
  { fault: "deadline", invariant: "NoExpiredEffect", witness: "StartDb" },
  {
    fault: "commit-start-fence",
    invariant: "NoForeignCommit",
    witness: "CommitStart",
  },
  {
    fault: "commit-start-deadline",
    invariant: "NoExpiredCommit",
    witness: "CommitStart",
  },
  {
    fault: "commit-stop-fence",
    invariant: "NoForeignCommit",
    witness: "CommitStop",
  },
  {
    fault: "commit-stop-deadline",
    invariant: "NoExpiredCommit",
    witness: "CommitStop",
  },
] satisfies readonly {
  fault: Fault;
  invariant: Violation;
  witness: string;
}[])("guard removal %j requires its named same-transition counterexample", ({
  fault,
  invariant,
  witness,
}) => {
  const explored = exploreDraftModel(fault);
  expect(explored.complete).toBe(false);
  expect(explored.counterexample?.invariant).toBe(invariant);
  expect(explored.counterexample?.trace.at(-1)?.action).toBe(witness);
  expect(explored.counterexample?.trace.length).toBeGreaterThan(1);
  if (fault.startsWith("commit-")) {
    // Only the final publication guard is removed; every engine effect remains admitted.
    expect(
      explored.counterexample?.trace.every(
        (edge) => !(edge.state.unsafeFence || edge.state.unsafeDeadline)
      )
    ).toBe(true);
    expect(explored.counterexample?.trace.at(-2)?.state.pending).not.toBeNull();
    expect(explored.counterexample?.trace.at(-1)?.state.pending).toBeNull();
  }
});

test.each(["start", "stop"] as const)("final %s publication refuses new fence/deadline drift and preserves pending", (
  operation
) => {
  let ready = firstReady();
  if (operation === "stop") {
    ready = step(step(ready, "CommitStart"), "JournalStop");
    for (const action of ["StopApp", "StopJob", "StopDb"]) {
      ready = step(ready, action);
    }
  }
  const commitAction = operation === "start" ? "CommitStart" : "CommitStop";
  expect(transitions(ready).some((edge) => edge.action === commitAction)).toBe(
    true
  );
  const changed = step(ready, "ReplaceFence");
  let expired = ready;
  for (const action of ["Tick", "Tick", "Tick"]) {
    expired = step(expired, action);
  }
  for (const blocked of [changed, expired]) {
    expect(transitions(blocked).some((edge) => edge.action === commitAction)).toBe(
      false
    );
    expect(blocked.pending).toBe(operation);
    expect(blocked.anchor).toBe(ready.anchor);
    expect(blocked.originalIds).toBe(ready.originalIds);
    expect(violation(blocked)).toBeUndefined();
  }
});

test("restart stops in reverse order then starts forward with a new admitted job attempt", () => {
  let state = step(firstSuccess(), "JournalRestart");
  const remaining = state.remaining;
  for (const action of [
    "StopApp",
    "StopJob",
    "StopDb",
    "BeginForwardStart",
    "StartDb",
    "ObserveDbReady",
    "CapturePriorStart",
  ]) {
    state = step(state, action);
    expect(state.pending).toBe("restart");
    expect(state.remaining).toBe(remaining);
  }
  expect(state.priorStart).toBe(1);
  for (const action of [
    "StartJob:zero",
    "ObserveFreshZero",
    "StartApp",
    "CommitStart",
  ]) {
    state = step(state, action);
  }
  expect(state.phase).toBe("running");
  expect(state.jobStarts).toBe(2);
  expect(state.seedWrites).toBe(1);
  expect(state.originalIds).toBe(initialState().originalIds);
});

test("nonzero immediately fences dependents and recovery never changes attempt counters", () => {
  let state = initialState();
  for (const action of [
    "JournalStart",
    "StartDb",
    "ObserveDbReady",
    "CapturePriorStart",
    "StartJob:nonzero",
    "ObserveNonzero",
  ]) {
    state = step(state, action);
  }
  expect(state.phase).toBe("uncertain");
  expect(state.pending).toBe("start");
  expect(state.appAttempt).toBe(0);
  expect(
    transitions(state).some((edge) => edge.action.startsWith("Start"))
  ).toBe(false);
  const starts = state.jobStarts;
  const pending = state.pending;
  for (const action of [
    "RecoverStopped",
    "StopApp",
    "StopJob",
    "StopDb",
    "CommitStop",
  ]) {
    state = step(state, action);
    expect(state.jobStarts).toBe(starts);
    expect(state.seedWrites).toBe(1);
    if (action !== "CommitStop") {
      expect(state.pending).toBe(pending);
    }
  }
  expect(state.pending).toBeNull();
  expect(state.phase).toBe("stopped");
  state = step(state, "JournalStart");
  expect(state.attempt).toBe(2);
  expect(state.pending).toBe("start");
});

test("interruption at every first-start boundary retains the same anchor until explicit stop recovery", () => {
  let state = step(initialState(), "JournalStart");
  for (const action of [
    "StartDb",
    "ObserveDbReady",
    "CapturePriorStart",
    "StartJob:zero",
    "ObserveFreshZero",
    "StartApp",
  ]) {
    const interrupted = step(state, "Interrupt");
    expect(interrupted.pending).toBe("start");
    expect(interrupted.anchor).toBe(state.anchor);
    expect(interrupted.originalIds).toBe(state.originalIds);
    expect(
      transitions(interrupted).some((edge) => edge.action === "JournalStart")
    ).toBe(false);
    let recovered = interrupted;
    for (const stop of [
      "RecoverStopped",
      "StopApp",
      "StopJob",
      "StopDb",
      "CommitStop",
    ]) {
      recovered = step(recovered, stop);
    }
    expect(recovered.jobStarts).toBe(state.jobStarts);
    expect(recovered.seedWrites).toBe(1);
    expect(recovered.pending).toBeNull();
    state = step(state, action);
  }
});

test("awaited stop phases cannot reset the restart aggregate deadline", () => {
  let state = step(firstSuccess(), "JournalRestart");
  for (const action of [
    "StopApp",
    "Tick",
    "StopJob",
    "Tick",
    "StopDb",
    "Tick",
  ]) {
    state = step(state, action);
  }
  expect(state.remaining).toBe(0);
  expect(
    transitions(state).some((edge) => edge.action === "BeginForwardStart")
  ).toBe(false);
  state = step(state, "DeadlineRefusal");
  expect(state.pending).toBe("restart");
  expect(state.phase).toBe("uncertain");
});

test("authority or deadline drift after observing fresh completion blocks the dependent effect", () => {
  let state = step(initialState(), "JournalStart");
  for (const action of [
    "StartDb",
    "ObserveDbReady",
    "CapturePriorStart",
    "StartJob:zero",
    "ObserveFreshZero",
  ]) {
    state = step(state, action);
  }
  const changed = step(state, "ReplaceFence");
  expect(transitions(changed).some((edge) => edge.action === "StartApp")).toBe(
    false
  );
  let expired = state;
  for (const action of ["Tick", "Tick", "Tick"]) {
    expired = step(expired, action);
  }
  expect(transitions(expired).some((edge) => edge.action === "StartApp")).toBe(
    false
  );
  expect(changed.pending).toBe("start");
  expect(expired.pending).toBe("start");
});
