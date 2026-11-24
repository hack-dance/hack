# Per-service publication model

[State chart](state.svg) · [model](PerServicePublication.tla)

Two services may both be gated under one scheduler lease. A target can
become stale before authorization. Failure, cancellation, down and owner
death can occur at every startup boundary. An uncommitted child exits on
EOF. A committed child is retired through the publication journal. The
run exposes a listener only after it binds and preserves its aggregate
ready boundary.

| Action | Implementation boundary |
| --- | --- |
| Ready | Scheduler `ServiceReady` after observation, cancellation and deadline checks |
| Admit | Planned gated host child and scoped relay validation under the scheduler lease |
| Commit | Publication intent, directory and ready binary checkpoints in `stage_launch` |
| Authorize, Bind, Record | Planned one-shot launch gate and existing listener identity observation |
| EOFExit | Planned pipe close without authorization |
| SelectDeadOwner | `recover-live-owner` enrolls the exact dead process and receipt on the original boot, even before aggregate readiness. The model abstracts that witness check as the selection action. |
| Abort, Retire, Settled | Startup rollback or selected dead-owner cleanup. The publication registry scopes retirement to the selected run. |
| Finish | Aggregate graph readiness and complete publication observation |

TLC 1.7.4 checked 811 distinct states. The controls violate `Safe` at
`Bind` and `Record`. A separate reachability control witnesses an
already-authorized child binding after owner death. Recovery must then
stop the exact committed incarnation. The abstraction assumes atomic journal steps,
a single owner and exact child identity. Down models the owner reaching
cancellation, not concurrent guest mutation under the lease. It does not
test kernel pipes, process identity, filesystem durability or live cleanup.
