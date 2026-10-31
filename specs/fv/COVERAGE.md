# Supervisor verification coverage

- Usage: [supervisor-usage.md](../../docs/supervisor-usage.md).
- Reviewed derivation: [statechart.md](../../docs/statechart.md), committed in
  `c0c96649a492cca26f68a77ecc62d9a8a53517a5`; review corrections committed in
  `7903351ccfb18664ad894ae98ca6371779424935` before the first specification.
- One repository rerun command: **`bun run check:tla`**. See
  [setup](../tla/README.md) for pinned tools and first-run download.
- Product source reviewed and verified: **`08e0412a9fa063c33f4145b569c36afc5810e606`**.
  No uncommitted product differences; this change contains verification only.
- TLC URL: `https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar`.
- Expected and independently verified downloaded SHA-256:
  `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`.
- Actual banner: `TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)`.
- Java: Temurin `17.0.20.1+1`, selected by mise pin `temurin-17.0.20+101`.
  Flags: `-Xmx512m -XX:ActiveProcessorCount=1 -XX:+UseParallelGC -XX:-UsePerfData`,
  TLC `-tool -workers 1 -fp 0 -seed 1`,
  private metadir, 120-second subprocess timeout. Deadlock checking enabled;
  `Idle` permits stutter only after every invocation returns (including rejected
  persistence) and any successful cancellation is acknowledged, or remains unstarted
  because reference deduplication blocks admission. Active states cannot use `Idle`.
  P4 still checks durable progress after an error return. No generated trace specs
  requested.
- Outputs: jar in ignored `.cache/tlaplus/`; raw TLC output on stdout, disposable
  sources/state directories under the system temporary directory and removed.
  Raw execution logs are not committed. TLC requires a local RMI listener.

## Checks and source coverage

All paths in this table are under `src/control-plane/extensions/supervisor/` unless
qualified. The common dependencies are `job-store.ts :: readJobMeta, updateJobStatus,
appendEvent, appendEventInternal` and `src/lib/fs.ts :: readTextFile, writeTextFile`.
The service map is a cancellation-handle registry, not execution ownership.
`StoreFree` explicitly prevents another modeled store call between a terminal
event append and its captured-metadata rewrite. This selects serialized real-code
schedules; it does not add a lock to the product. Process exit and local claims can
still interleave. Independent review caught and resolved an initially missing
restriction before final validation.
`commands.ts` and `src/daemon/server.ts` were reviewed as callers; only direct
same-ID runner composition and service cancellation are replayed.

| Check / property | Transitions and model actions | Source and deterministic replay | Bound / assumptions | Full confirmed source sync |
| --- | --- | --- | --- | --- |
| P1 `SingleRunner` | T2–T5,T13; `Begin`, `Starting`, `Spawn`, `Running`, `Register` | `runner.ts :: runJob`; `service.ts :: createJob, onSpawn`; `singleRunner` replay starts B after A is registered but alive | One stored job, two invocations; serialized store operations; no fairness needed for safety | `08e0412a9fa063c33f4145b569c36afc5810e606` |
| P2 `CancelQuiescent` | T6,T8–T11,T13; `Cancel`, persistence, `Acknowledge`, `Exit`, `Begin` | `runner.ts :: cancel, finish`; `service.ts :: cancelJob`; `cancelQuiescent` checks live child at ack and same-ID restart | One job, two invocations; sticky acknowledgement; signals may be ignored; process exit separate from status | `08e0412a9fa063c33f4145b569c36afc5810e606` |
| P3 `RetryIdempotent` | T2–T5,T11,T13; `Begin`, `Spawn`, `Return` | `runner.ts :: runJob`; `retryIdempotent` executes completed ID again | One job, two sequential invocations; execution counter retains duplicate history; no actual automatic retry loop | `08e0412a9fa063c33f4145b569c36afc5810e606` |
| P4 `ClaimedTerminal` | T6–T12; `Cancel`/`Finish`, persistence, `RejectStatus`, `Return`; reference-only `Recover` | `runner.ts :: finish`; `service.ts :: catch, finally, cancelJob`; `claimedTerminal` injects one status failure and proves later storage availability | One invocation, one finite status rejection; weak fairness described below | `08e0412a9fa063c33f4145b569c36afc5810e606` |
| P5 `CancelWins` | T6–T10; `Cancel`, `Finish`, persistence, `Acknowledge` | `runner.ts :: finish, cancel`; `cancelWins` repeats cancellation then releases process exit | One invocation, successful storage, nonthrowing/nonreentrant callbacks, no external writer | `08e0412a9fa063c33f4145b569c36afc5810e606` |

All checks use [SupervisorJob.tla](../tla/SupervisorJob.tla); actual configs are
`specs/tla/P1.cfg` through `P5.cfg`. Replay functions are in
`tests/supervisor-formal-replay.test.ts`, importing actual runner/store/service code.
Process exit and signal delivery are controlled dependencies; filesystem operations
use the real store. No timer selects a schedule. Subprocess timeouts only detect hangs.

P4 uses the actual **terminal outcome claim**, not a nonexistent queue ownership
claim. Weak fairness is explicit for runnable continuations, status/event persistence,
exit, stream drain, acknowledgement, and reference recovery when enabled. Thus the
environment must eventually let processes exit, streams reach EOF, and nonfailed I/O
complete; no fairness forces a cancellation or a fault. One transient rejection may
disable actual persistence forever because there is no recovery action. The additional
`reference/P4SuccessfulIO.cfg` uses actual code with failures disabled and passes.
Fairness cannot establish unconditional job termination for arbitrary commands.

## Must-fail controls

Every config keeps its property enabled and changes behavior. Each is run by
`bun run check:tla`; its expected kind and exact name are checked by the generic
manifest/harness. P1–P4 have separately passing hypothetical controls before mutation.

| Check | Checked-in mutation | Deliberate model break | Required failure | Corresponding isolated real-code break |
| --- | --- | --- | --- | --- |
| P1 | `specs/tla/mutations/P1.cfg` | Remove reference exclusive admission | exit 12, `Invariant SingleRunner is violated.` | Remove scratch active-status admission guard; two live children |
| P2 | `specs/tla/mutations/P2.cfg` | Permit acknowledgement before exit, retain reference duplicate-admission protection | exit 12, `Invariant CancelQuiescent is violated.` | Remove scratch `await proc.exited` from cancellation, retain terminal-ID admission guard |
| P3 | `specs/tla/mutations/P3.cfg` | Remove reference one-admission guard | exit 12, `Invariant RetryIdempotent is violated.` | Remove scratch terminal-ID guard; second sequential spawn |
| P4 | `specs/tla/mutations/P4.cfg` | Remove reference recovery after the one rejected write | exit 13, `Temporal property ClaimedTerminal was violated.` | Remove scratch one-time retry of terminal status write |
| P5 | `specs/tla/mutations/P5.cfg` | Remove existing terminal outcome memoization | exit 12, `Invariant CancelWins is violated.` | Remove `if (terminalWrite) return terminalWrite`; completion overwrites cancellation |

Scratch reference guards reproduce the particular replay schedules; they are not
concurrent lock implementations. In particular, a status read/check is not atomic
reservation and cannot prove general P1/P2 admission safety. The model's hypothetical
reference admission is atomic; neither reference is presented as a product fix.
Original product files remain unchanged. Text anchors must match exactly once, then
the same behavioral oracle must pass with the reference and fail with the mutation.
A hash mismatch, parse error, timeout, or unrelated test failure cannot count.

## Evidence and outcomes

Observed on 2026-10-23. Distinct-state counts describe this finite abstraction and
its fixed configuration, not explored product schedules. Baseline and restored runs
matched. Each TLC invocation completed in seconds, below its 120-second limit.

| Check | Actual baseline TLC | Passing control(s) | Mutation TLC | Actual replay / source mutation | Restored baseline | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | exit 12; named violation; 71 states before counterexample | hypothetical reference: 268 states, exit 0 | exit 12; same named violation | named violation / reference pass then named violation | same expected violation | **bug**: requested low-level job-wide guarantee absent |
| P2 | exit 12; named violation; 192 states before counterexample | hypothetical reference: 67 states, exit 0 | exit 12; 50 states; same named violation | named violation / reference pass then named violation | same expected violation | **bug**: requested stronger guarantee; current metadata-only contract is explicit |
| P3 | exit 12; named violation; 45 states before counterexample | hypothetical reference: 35 states, exit 0 | exit 12; same named violation | named violation / reference pass then named violation | same expected violation | **bug**: same-ID idempotency absent; no job retry policy implemented |
| P4 | exit 13; named temporal violation; 41 states | hypothetical recovery: 61 states; actual successful-I/O: 35 states; both exit 0 | exit 13; same named violation | named violation / reference pass then named violation | same expected violation | **bug** under finite persistence failure; **in sync** conditional successful-I/O progress |
| P5 | exit 0; 35 states | actual code is the passing control | exit 12; 38 states; named violation | pass / named violation after removing memoization | pass | **in sync** within one invocation |

For each strict replay, a passing property requires exit 0 and exactly one passing
test. A violation requires exit 1, exactly one failing test, the exact property marker,
and its `PropertyViolation` error. The outer test/harness explicitly expects the
known finding. Zero wrapper exit means reproducible evidence, **not product green**.
All five model and implementation mutations demonstrated their intended failures.

After restricting `Idle` to settled invocations and reference-blocked admissions,
`bun run check:tla` retained all named violations, passing controls, replays, and
restored baselines. A disposable model with `Starting` disabled under `P5.cfg`
reported `Deadlock reached.` with exit 11, confirming that active-state deadlocks
are detected. The disposable control was removed; product source is unchanged.

## Findings and limits

- **F1 / P1:** starting a second exported `runJob` for one stored ID while the first
  child is alive launches another child. Harm: duplicate command side effects.
  Ordinary `createJob` creates a new UUID and calls the runner once; this replay is
  a low-level composition gap, not evidence of duplicate UUID scheduling by the service.
- **F2 / P2:** cancel can acknowledge while its child is alive, and a later runner
  call can execute the cancelled ID. Harm: work continues or restarts after cancel.
  Existing documentation promises terminal persistence rather than process exit.
- **F3 / P3:** rerunning a completed stored ID spawns again. No idempotency key,
  attempt counter, retry limit, or backoff exists. One invocation spawns at most once;
  this does not establish a job-wide retry budget. Duplicate create-request handling
  after a lost POST response creates a different UUID and is outside this model.
- **F4 / P4:** a transient cancelled-status write failure rejects cancellation;
  after exit/drain the run rejects and the service drops its handle. Metadata remains
  running with no terminal event despite restored store availability. Harm: stale
  observable state without automatic recovery. No successful cancel was acknowledged.
- **F5 / additional real-code characterization:** after spawn, a rejected `running`
  status write or `job.started` write makes the service fallback resolve the run as
  failed while the child remains alive and cancellation returns `not_running`.
  `tests/supervisor-startup-replay.test.ts` deterministically reproduces both paths
  through the actual service/store and a controlled process. The repository check
  runs these two cases once. This is extra bug evidence, not a sixth model property
  or a claim of formal coverage of startup errors. Harm: an unmanaged live child.
- Shell creation, close, exit, and expiry were source-reviewed as separate in-memory
  transitions (T16). There is no shell job claim or retry protocol. No shell model,
  PTY behavior proof, or general shell cleanup guarantee is claimed.
- Not covered: process groups/descendants, daemon crashes/restarts, arbitrary commands
  that never exit, corruption, partial writes beyond the finite status fault,
  arbitrary concurrent store writers, global event sequence uniqueness, and transport
  authorization. Existing runner/service tests additionally exercise partial event
  persistence; they do not make this small model exhaustive.
- Product fixes: none. No introducing commit is assigned to these longstanding gaps.

## Maintenance

Initial verification sync is `08e0412a9fa063c33f4145b569c36afc5810e606` for every row.
The artifact-only documentation/checker commits do not advance that source marker.
After source changes, use `tlaplus-workbench-maintain`: inspect the covered diff,
new callers/writers and renamed paths, update/review the saved chart, run the command
including mutations and replays, and advance only confirmed per-check sync markers.
Do not weaken a property or accept unexpected passes merely to make the wrapper green.
