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
at most `COMMAND_LEASE_WAIT` (15 s), through the shared
`state::wait_for_acquisition` loop. Waiting admits nothing: the pool identity,
liveness and boot checks run after acquisition as before. The owner's tick
already skips a round when the lease is busy (`with_available_lease`), so a
command that holds the lease never fails or cancels the owner.

Every waiter passes its caller's check to the loop as `before_attempt`, and
the check runs once more after acquisition. This matters because some waiters
run on a foreground owner's only loop thread, where a wait that checked
nothing would hold Ctrl-C, `hack down` and the restart tick for up to 15 s
(review finding on the first version of this fix).

| Call site | Runs in | Entry | Check | Budget |
| --- | --- | --- | --- | --- |
| `dependency_refresh::request` | requesting CLI | `Engine::connect_command` | none (Ctrl-C ends the process) | wait, then 5 s send and 175 s read; frontend 200 s |
| `dependency_refresh::handle` | owner loop | `Engine::connect_command` | `signals.pending()`, client disconnect, the 170 s answer deadline | the wait counts inside the 170 s answer |
| `service_exec` (compose finite exec) | CLI | `Engine::connect_command` | expiry of fresh per-command values (`managed.deadline()`), if any | exec timeout starts after acquisition; frontend 75 s |
| `service_exec::interactive` (compose) | CLI | `Engine::connect_command_until` | the frontend's `live` check | counts against the interactive deadline |
| `native::runtime::exec::execute`, `exec::interactive`, `run::execute` (authored) | owner loop | `Engine::connect_command_until` | the owner's guard: signals, publication, pin (and client disconnect for interactive) | counts against the fixed 30 s budget |

The authored paths keep the wait inside their 30 s budget on purpose: the
native requester (`request_selected`) reads the owner's answer for a fixed
40 s, so a wait outside the budget could outlast that read. After a full 15 s
wait an authored exec or run has the remaining 15 s. The compose finite exec
instead starts its own timeout after acquisition, and its frontend bound
(75 s) covers the wait.

Fresh per-command values for `hack exec` have a delivery lifetime that starts
when the CLI receives them, before the lease wait. The wait refuses, before
admission, once that lifetime has passed, rather than admit a command whose
values can no longer be delivered. That check has no dedicated test (a
`Managed` value needs the launcher input path); the deadline check itself is
`managed_environment::remaining_until`.

## Model

`CommandLease.tla` has one lease, one ready owner whose tick takes the lease
when it is due and free, holds it for at most `HoldMax` ticks and releases
it, and one command that waits at most `Bound` ticks. The command polls more
often than the owner's tick (5 to 50 ms against one second), so time does not
pass while it waits on a free lease, and a checked waiter sees a pending
signal before time passes. `Wait = FALSE` is the old single attempt.
`Checked = FALSE` is the first version of the fix, which passed no check.

| Config | Result | Shows |
| --- | --- | --- |
| `positive` (`Bound = 4`, `HoldMax = 2`, wait, checked) | 74 distinct states, no error; `Settles` and `SignalSettles` hold under weak fairness | A brief holder never makes the command refuse (`BriefHolderNeverRefuses`); effects only under the command's lease (`NoEffectWithoutLease`); no admission at or after the bound (`NoAdmissionAfterDeadline`); a signal is never held across a tick (`SignalNotHeld`) and admits nothing (`NoAdmissionAfterSignal`) |
| `negative` (no wait) | `BriefHolderNeverRefuses` violated: `cmd = "refused"`, `lease = "owner"`, `elapsed = 0` | The reported refusal |
| `unchecked-signal` (no check) | `SignalNotHeld` violated: `cmd = "waiting"`, `signal = TRUE`, `sigAt = 0`, `elapsed = 1` | The review finding: the owner held a signal behind the wait |
| `unchecked-admission` (no check) | `NoAdmissionAfterSignal` violated: `cmd = "admitted"`, `signal = TRUE`, `lease = "command"` | Without the check a signal during the wait could still be followed by admission |
| `long-holder` (`HoldMax = 5 > Bound`) | `BriefHolderNeverRefuses` violated: `cmd = "refused"`, `lease = "owner"`, `elapsed = 4` | The wait stays bounded; a holder that keeps the lease longer is still refused, with the holder named |
| `admitted-after-wait` | `NeverAdmittedAfterWait` violated: `cmd = "admitted"`, `lease = "command"`, `elapsed = 1` | The command is admitted after it waited out a holder |

[State chart](command-lease.svg) ([source](command-lease.mmd)).

## Code and tests

- `provider/lifecycle.rs`: `COMMAND_LEASE_WAIT`.
- `provider/engine.rs`: `Engine::connect_command` (the bounded acquisition of
  `connect_until` with the 15 s cap and a caller check; the fixture path is
  wrapped by the same loop) and `Engine::connect_command_until` (the same
  wait inside the caller's budget, with the caller's guard).
- The call sites in the table above. The owner's refresh answer starts its
  170 s deadline before its own lease wait, so it still answers inside the
  requester's 175 s read (a requester that gives up disconnects, and a
  disconnect cancels the rebind).
- `src/backends/native-project-exec.ts` (75 s) and
  `native-project-dependency-refresh.ts` (200 s): frontend bounds that cover
  the added wait.
- `provider/engine/command_lease_tests.rs`, on a real flock held by another
  thread: `Engine::connect` refuses `provider_busy` naming the holder;
  `Engine::connect_command` and `Engine::connect_command_until` wait and then
  reach the exact post-acquisition refusal (`process_identity_unavailable`,
  since the fixture pool records no provider process); a holder that keeps
  the lease past the deadline is still refused `provider_busy` with the
  holder named; a caller check that starts refusing ends both waits within
  2 s instead of 15 s; a budget shorter than 15 s bounds the authored wait;
  and the call sites `service_exec` and the refresh `request` wait and get
  past acquisition (each fails if the call site goes back to
  `Engine::connect`).
- `provider/graph/foreground/dependency_refresh.rs` `owner_lease_tests`: the
  owner-side `selection` with the owner's check ends its wait with
  `provider_acquisition_cancelled` once a signal is pending, and the check is
  polled on every attempt.

## Not modelled

Lock fairness between several waiting commands, the owner's longer holds
before its ready line (the frontend waits for readiness first), a second
command holding the lease for its whole command, OS scheduling, and the VM.
The wiring of `signals.pending()` into the owner's check in `handle` is a
single closure covered by review, not by a test that sends a real signal.
The earlier, more severe reports on older heads (a cancelled rebind and a
torn-down run) are not reproduced by this model; they need the real-VM rows.
