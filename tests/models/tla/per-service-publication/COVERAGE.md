# Per-service publication model

[State chart](state.svg) · [model](PerServicePublication.tla)

Two services may independently report readiness. Failure, cancellation and
owner death can occur after any prefix of readiness, admission, connection
and record. Retirement drains the run's intents. The successful boundary
requires every required listener to be observed. The negative control allows
a run to record an address before its listener exists.

| Action | Implementation boundary |
| --- | --- |
| Ready | Scheduler `ServiceReady` event after observation, cancellation and deadline checks |
| Admit | Planned reservation and launch authority scoped to one ready service |
| Connect, Record | Planned verified listener observation and address exposure |
| Abort, Retire, Settled | Startup failure, cancellation or owner recovery, followed by retirement of the run's intents |
| Finish | Aggregate graph readiness and complete publication observation |

TLC 1.7.4 found 105 distinct states with no errors. The negative control
violates `Safe` at `Record`. This model is a contract for the WIP handoff.
It abstracts generation and process identity, journal durability, engine
leases and the progress of recovery. No model state stands in for a Mac
runtime result.
