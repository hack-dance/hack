# Supervisor verification walkthrough

This walkthrough describes source revision
`08e0412a9fa063c33f4145b569c36afc5810e606`, before modeling. The supervisor is an
unsupported experimental surface; verification does not change that support status.
See [the reviewed statechart](statechart.md) for transition IDs and property hypotheses.

A caller uses `createSupervisorService().createJob` with a project directory and a
command. The service generates a UUID, writes queued metadata and a creation event,
and starts `runJob` in the background. It returns the original metadata plus a run
promise. The daemon retains one service instance; local command handlers construct
fresh instances. Cancellation handles exist only in the instance that started a job.
Reading metadata is not proof that a local cancellation handle exists.

The runner reads metadata and selects the command, then writes `starting`, appends
`job.starting`, and spawns. It subsequently writes `running` and `job.started` before
calling `onSpawn`. During those awaits the process exists but cancellation is not yet
registered. A spawn failure records `failed`. A storage failure after spawn can leave
a live child without a registered handle; that window is documented, not a recovery
mechanism in the model.

For normal completion the runner waits for process exit and both output streams to
drain. It claims a terminal outcome synchronously, then writes status and event.
Cancellation signals the child and claims `cancelled` before those writes. Whichever
path first claims the outcome owns the shared `terminalWrite` promise. Later accepted
cancellations reuse it; a completed or failed claim makes cancellation return false.
The service reports `not_found` for absent metadata and `not_running` for an absent
local handle or a rejected late cancellation.

A successful cancellation response establishes persisted cancellation metadata and an
event. It does not establish process exit. A child that ignores the signal can keep
executing and leave the run promise pending. Terminal persistence errors reject the
cancel promise immediately; the run reaches that rejected persistence promise only
after process exit and stream drain. Until then its service handle may remain live.
When run rejects, the service preserves the claimed outcome instead of replacing it
with `failed`. Pre-claim startup errors instead reach the failed fallback directly,
which can settle without stopping a spawned child. No automatic recovery retries
the failed terminal persistence operation.

The store reads and rewrites whole metadata files. An event append and its subsequent
metadata update are separate operations. The model must preserve the status/event
boundary. It restricts store interleavings where necessary and does not prove file
atomicity, cross-process coordination, or event sequence uniqueness under concurrent
writers. Existing service tests exercise failures before and after event append.

There is no durable execution claim or retry API. Calling exported `runJob` twice
with the same stored ID creates two independent executions; calling it after terminal
completion also runs again. Resubmitting `createJob` creates a fresh UUID. These are
explicit caller-composition tests for the requested job-wide guarantees, not claims
that the current service contains an automatic retry loop. Automatic attempt count is
one per invocation; no configured retry budget or idempotency key exists.
The daemon client separately retries a failed transmission once after readiness
recovery. A create response lost after acceptance can cause a second UUID to be
created; this transport composition is outside the bounded same-ID runner model.

P2 keeps cancellation acknowledgement sticky across both bounded invocations of the
same job. Its hypothetical reference both waits for exit and prevents re-admission;
the mutation removes only the exit wait. P3 covers same stored ID re-execution,
not T15's distinct UUIDs or logical-request deduplication.

Shells use a separate in-memory map and PTY. `createShell` returns running metadata,
`closeShell` sends a signal and returns a boolean, and the exit handler changes status
to exited, notifies listeners, closes the terminal, and schedules metadata removal.
Neither close nor attachment close waits for exit. Shells never enter the job store;
the job model does not imply durable shell recovery or shell retry guarantees.

## Verification procedure

Use the Bun version pinned by `package.json` and the repository Java selection.
From the repository root, run `bun run check:tla`. The command will verify the pinned
TLC jar, run each actual-code property separately, check passing reference controls
and must-fail mutations, replay the schedules against imported implementation code,
exercise isolated real-code mutations, and rerun the baseline. Tool failures and
unexpected passes must fail the command. Expected reproduced bugs are reported by
name; a successful harness does not mean the stronger product guarantees hold.

The implementation and exact outcomes will be recorded in
`specs/fv/COVERAGE.md`. This pre-model walkthrough intentionally records hypotheses,
not TLC results. Product fixes require a separate change and are outside this task.
