# Native command lease beside a ready owner (HACK-2669)

`hack exec` right after `hack up -d` was refused about one time in six with
`provider_busy` ("recorded holder: start"), even with `hack ps` already
ready. A ready foreground owner keeps running and takes the provider
mutation lease for a moment once a second while it supervises restarts of a
routed service (`bridges::supervise_probes` and `changed_publications`). The
command side took the same lease with one nonblocking attempt
(`Engine::connect`) in two places: the dependency refresh that `hack exec`
and `hack run` send first (`dependency_refresh::selection`), and the exec
itself (`service_exec`). An attempt that landed inside one of the owner's
moments was refused.

The fix makes those acquisitions wait while another holder has the lease, for
at most `COMMAND_LEASE_WAIT` (15 s): `Engine::connect_command`, and
`Engine::connect_command_until` within the command's own budget. Both use the
shared `state::wait_for_acquisition` loop through
`OwnedGuest::connect_until`. Waiting admits nothing: the pool identity,
liveness and boot checks run after acquisition as before. The owner's tick
already skips a round when the lease is busy (`with_available_lease`), so a
command that holds the lease never fails or cancels the owner.

## Model

`CommandLease.tla` has one lease, one ready owner whose tick takes the lease
when it is due and free, holds it for at most `HoldMax` ticks and releases
it, and one command that waits at most `Bound` ticks. The command polls more
often than the owner's tick (5 to 50 ms against one second), so time does not
pass while it waits on a free lease. `Wait = FALSE` is the old single
attempt.

| Config | Result | Shows |
| --- | --- | --- |
| `positive` (`Bound = 4`, `HoldMax = 2`, wait) | 40 distinct states, no error; `Settles` holds under weak fairness | A brief holder never makes the command refuse (`BriefHolderNeverRefuses`); effects only under the command's lease (`NoEffectWithoutLease`); no admission at or after the bound (`NoAdmissionAfterDeadline`) |
| `negative` (no wait) | `BriefHolderNeverRefuses` violated: `cmd = "refused"`, `lease = "owner"`, `elapsed = 0` | The reported refusal |
| `long-holder` (`HoldMax = 5 > Bound`) | `BriefHolderNeverRefuses` violated: `cmd = "refused"`, `lease = "owner"`, `elapsed = 4` | The wait stays bounded; a holder that keeps the lease longer is still refused, with the holder named |
| `admitted-after-wait` | `NeverAdmittedAfterWait` violated: `cmd = "admitted"`, `lease = "command"`, `elapsed = 1` | The command is admitted after it waited out a holder |

[State chart](command-lease.svg) ([source](command-lease.mmd)).

## Code and tests

- `provider/lifecycle.rs`: `COMMAND_LEASE_WAIT`, `OwnedGuest::connect_until`.
- `provider/engine.rs`: `Engine::connect_command`, `Engine::connect_command_until`.
- `provider/graph/service_exec.rs`, `provider/graph/foreground/dependency_refresh.rs`:
  the call sites. The owner's refresh answer starts its 170 s deadline before
  its own lease wait, so it still answers inside the requester's 175 s read
  (a requester that gives up disconnects, and a disconnect cancels the rebind).
- `src/backends/native-project-exec.ts` (75 s) and
  `native-project-dependency-refresh.ts` (200 s): frontend bounds that cover
  the added wait.
- `provider/engine/command_lease_tests.rs`: on a real flock held by another
  thread, `Engine::connect` refuses `provider_busy` naming the holder,
  `Engine::connect_command` waits and gets past acquisition once it is
  released, and a holder that keeps the lease past the deadline is still
  refused `provider_busy` with the holder named.

## Not modelled

Lock fairness between several waiting commands, the owner's longer holds
before its ready line (the frontend waits for readiness first), a second
command holding the lease for its whole command, OS scheduling, and the VM.
The earlier, more severe reports on older heads (a cancelled rebind and a
torn-down run) are not reproduced by this model; they need the real-VM rows.
