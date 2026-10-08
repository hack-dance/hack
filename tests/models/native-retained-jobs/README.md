# Retained completed-job owner draft

This is an executable **offline draft**, not production version-7 support. Run:

```sh
bun test tests/native-retained-jobs-model.test.ts
```

The test-only protocol projection and finite TypeScript model import no engine,
filesystem, process runner or credential owner. The closest test also checks that
the current production receipt codec still rejects version 7. These checks do not
activate adoption, mutate receipts or qualify real Docker jobs. This is not a TLA+
or TLC result.

## Proposed wire boundary

Reserve both `adoption_receipt_version: 7` and
`adoption_generation_version: 7` for a candidate containing explicit jobs. Keep the
existing receipt fields (`kind`, `checkout`, `prepared`, `publication`,
`pendingOperation`) and manifest fields (`kind`, `projectRoot`, `id`, `binding`,
`runtimeConfig`, `sourceFiles`, `files`) with their exact existing anchors and
validators. No decoder or writer is changed here. The full saved wire remains
owned by the generation/receipt implementation; `contract.ts` validates only the
proposed version, supported family and original-membership projection.

The first retained-job family is a static authored pair, default bridge and
binding version 1. Custom bridges, generated sources, managed values, typed local
inputs, profiles, routes and host hooks remain unqualified. Existing versions 1–6
keep their meanings; neither version 5 health nor version 6 static-bridge admission
grants job authority. The pending selection's existing `services` array denotes
every original workload name, including jobs. Roles come from the held compiler
candidate, never new labels or inferred names. Names, full IDs, runtime config
hashes, source/artifact identities, volume witnesses and the default network remain
the original owner's obligations. A format downgrade is not rollback.

## Attempt and completion contract

1. Under the existing mutation lease, bind the whole ordered selection to the exact
   generation and durable pending receipt **before** any child. Capture each job's
   prior `StartedAt` immediately before its admitted exact-ID start. Keep attempt
   observations invocation-local; do not add secret-derived fingerprints or job
   telemetry to immutable original identity.
2. Check direct dependency conditions before starting their consumer. Services use
   `started`/`ready`; jobs require completion of this newly admitted attempt. A
   settled successful start child plus changed, valid, nonzero `StartedAt` and exact
   ID/exit zero is required. Fast exit zero is valid without observing running.
   Historical exit zero without this start cannot unblock a consumer. A known
   nonzero exit refuses immediately, with no dependent start in that attempt.
3. Recheck source, candidate/generation, receipt, engine, original membership and
   configuration after awaited probes, before every effect and before clearing
   pending. The caller's single absolute deadline covers reverse stop, forward
   start, observations and completion; stages do not refill it. Job policy `no`
   and retry count zero must hold before start and during observation. Preserving
   authored restart omission does not invent an image/runtime default.
4. A failed child, nonzero job, cancellation, malformed observation, changed owner
   or incomplete postcondition preserves pending. Ordinary retry cannot resume it.
   Explicit `down --recover` stops exact originals in reverse order, checks the
   whole stopped postcondition and final authority, then clears that pending
   anchor. It never starts/replays jobs. A later explicit start is a new attempt.
5. Restart stops in reverse topological order and starts forward on the same IDs.
   Final start readiness distinguishes live services from fresh exited-zero jobs;
   requiring every workload to remain running is incorrect. Stopped rollback
   retains originals/data and restores the exact held legacy pair.

`freshJobResultDraft` refuses malformed, duplicate, missing, foreign or extra rows,
wrong restart facts and impossible terminal status. It compares validated UTC
seconds plus all nine nanosecond digits, so equivalent fractional spellings and
fractional Docker-zero timestamps cannot establish a new attempt. A real
one-nanosecond change remains distinct; no monotonic clock ordering is assumed.
Within the same-daemon cooperative observation boundary, a changed timestamp is
not a general exactly-once, hostile-engine or clock-authentication guarantee. The
future owner must mint the admitted-attempt capability; a caller boolean in this
offline draft is not that capability.

## Finite exploration and counterexamples

One graph contains `db` (exec-ready service), `seed` (completion job) and `app`
(completed-job consumer). Bounds are two explicit start/restart invocations, one
interrupt and two fence identities. Each invocation has three abstract elapsed
clock ticks; time advances nondeterministically between actions. These are model
bounds, not workload resource caps or production deadlines. Explicit recovery is
a separate caller invocation with its own budget and the same original pending
anchor. Recovery may itself time out; no fairness or eventual cleanup is asserted.

The prior `a59c23d3` positive model exhausted **9,248 distinct states / 18,049
generated states**. Timestamp and final-publication guard corrections are awaiting
their focused validation; prior counts are not a pass claim for those amendments.
Reachability checks require healthy observation, fast and running job completion,
known failure, interruption, stopped recovery, finalization and explicit restart.
SQL continuity is represented by a fixed seed witness (`seedWrites = 1`); the job
attempt counter changes independently. No SQL statement or data repair executes.

Each control removes one guard and must fail its exact named invariant on the
same final transition; a parser error, unrelated throw or empty exploration fails
the test.

| Removed guard | Required counterexample |
| --- | --- |
| New admitted job attempt | `NoHistoricalCompletion`: accept old zero, then start app without a new job start |
| Nonzero refuses before consumer | `NoFailedDependencyStart`: ignore exit 17, then start app |
| Recovery never starts jobs | `NoRecoveryJobReplay`: interrupted pending start, explicit recovery, new job start counter |
| Stop postcondition before clearing pending | `NoPrematureReceiptClear`: clear the receipt with the original DB still running |
| Fresh effect authority | `NoForeignEffect`: replace the selected fence, then start an original |
| Effect aggregate deadline | `NoExpiredEffect`: consume all elapsed budget, then start an original |
| Final start authority only | `NoForeignCommit`: complete admitted effects, replace the fence, then clear pending in `CommitStart` |
| Final start deadline only | `NoExpiredCommit`: complete admitted effects, exhaust the budget, then clear pending in `CommitStart` |
| Final stop authority only | `NoForeignCommit`: complete admitted stops, replace the fence, then clear pending in `CommitStop` |
| Final stop deadline only | `NoExpiredCommit`: complete admitted stops, exhaust the budget, then clear pending in `CommitStop` |

Commit controls keep every engine-effect guard enabled. Publication records its
own authority/deadline facts independently, so no-child receipt clearing cannot
pass merely because the last engine operation was admitted earlier.

## Source correspondence and omissions

This branch starts at canonical `a950057f4d3b07f744f1d685659ea8a0dd319dca`.
The separately reviewed v5/v6 seams are immutable
`6364937d4904e24f385424789e3d260715f1d960`; canonical activation/acceptance of that
stack is a separate gate. The pure mapper is reviewed
`afac91e7942f0e27f3d114f0c522eab2ee19ad20` and remains on its separate branch.

| Model boundary | Future implementation seam at reviewed 636 |
| --- | --- |
| `JournalStart` / `JournalRestart` / `JournalStop` | `native-compose-adoption-generation.ts`: durable whole-selection pending operation before callback; version/membership/source anchors remain unchanged |
| `StartDb` / `ObserveDbReady` | `native-compose-adoption-execution.ts`: exact-ID child followed by explicit service readiness observation |
| `CapturePriorStart` / `StartJob` / `ObserveFreshZero` | New job branch of that scheduler and closed v7 observation codec; v5's running-only predicate cannot implement this |
| `ObserveNonzero` / `Interrupt` / `DeadlineRefusal` | Retain pending and fence ordinary replay; real process settlement remains the shared runner's obligation |
| `StopApp` / `StopJob` / `StopDb` / `RecoverStopped` | Same retained scheduler's reverse exact-ID stop, never Compose recreation, job restart or object deletion |
| `CommitStart` / `CommitStop` | Generation owner's fresh receipt/source/runtime checks, then role-aware final postcondition before clearing pending |

The abstraction treats journal commits and individual admitted engine operations
as atomic, with interruption between them. DB readiness is a separate action;
autonomous job exit is separate from observation. Fence substitution summarizes
the complete held generation/source/engine/resource/configuration tuple; the
protocol tests separately exercise each component. It does not model fsync/inode
durability, lock/process/PID settlement, hard links, arbitrary external restarts,
daemon reboot, unreliable clocks, actual health tools, volume content/witnesses,
two simultaneous checkouts or real SQL. It does not prove receipt parsing, existing
wire migration, rollback, guest cancellation, runtime performance or live adoption.

Required later acceptance is the source-reviewed production v7 owner plus a
maintained two-worktree exact-ID fixture: seed SQL once, keep attempt counters
separate, prove fresh ordering and exit-17 zero dependent starts, interrupt/recover
without replay, restart/down/up and stopped rollback, preserve sibling data/IDs,
and restore an independently captured original engine inventory. Unknown outcome
must retain recovery roots. Refusal cases alone do not complete that work.
