# Lifecycle supervisor ownership model

`LifecycleSupervisor.tla` models one configured command name and at most two
start attempts. The model precedes implementation. The first artifact is a
standalone Rust binary exercised by a fake caller; the CLI remains unchanged.

| Action/property | Source transition | Regression boundary |
| --- | --- | --- |
| `Reserve`, `Publish`, `Spawn`; `DurableBeforeLaunch` | Per-command flock, guard session creation, synced identity before argv spawn | `starts_and_records_identity`; refused publication/spawn cannot run a later command |
| `SupervisorDeath`; `GuardRetainsLock` | Resident guard retains flock and stdout/stderr readers after project supervisor loss | `supervisor_kill_then_recover_stop`; output continues after supervisor SIGKILL |
| `GuardDeath`, `Retry`; `NoDuplicate` | Retained session census refuses a retry even if separately killed guard released its flock | Guard-loss retry and identity refusal regression |
| `Stop`, `Kill`; `NoForeignSignal` | Exact owner/boot/start identity before TERM and KILL; guard remains outside command groups | Wrong-owner/stale-identity refusal; TERM-ignore escalation |
| `ProcessExit`, `Reap` | Session census ignores zombies; reap direct/adopted children; release lock after no live members | Zombie liveness; child changes process group within session |
| `StopUnknown` | Bounded confirmation can report uncertainty while live members remain | Honest unknown recovery outcome, never successful absence |

Positive TLC exploration: 129 distinct states, queue exhausted, depth 11. Negative
control sets `SkipLiveFence = TRUE`; `Retry` then violates `NoDuplicate` with live,
durable and duplicate all true in the same state. Both guard-loss and project-loss
traces can witness this violation; the registry requires the named action and
same-state fields without depending on worker scheduling.

Checker: checksum-pinned TLA+ 1.7.4 artifact (TLC reports version 2.19), Java 17,
two workers and a bounded heap. The maintained runner pins the positive count and
validates the negative invariant/action/witness. Apalache is not qualified here.

Assumptions: flock serialization, atomic/synchronized publication, reliable native
identity and session census, and rechecking identity before effects. Signal delivery
does not imply process exit: `KillPending` can retain live processes, and
`StopUnknown` is distinct from `Exited`. No fairness or eventual exit is assumed.
An identity change blocks signaling. A separately killed guard leaves an orphaned
session; it never grants new launch authority simply because its lock was released.

Omissions: actual filesystem durability, command contents, multi-command rollback,
pipe buffers, descriptor creation races, scheduler latency, resource use, power loss,
PID reuse between observation and signaling, hostile same-user mutation, and
commands escaping their session with `setsid`. Those remain native implementation
or explicitly unsupported boundaries. This finite model does not qualify a shipped
artifact, macOS behavior, CLI integration or the default runner.
