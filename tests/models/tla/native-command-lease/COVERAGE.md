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
| `dependency_refresh::request` | requesting CLI | `Engine::connect_command_request` (35 s, HACK-2729) | none (Ctrl-C ends the process) | wait, then 5 s send and 175 s read; frontend 220 s |
| `dependency_refresh::handle` | owner loop | `Engine::connect_command` | `signals.pending()`, client disconnect, the 170 s answer deadline | the wait counts inside the 170 s answer |
| `service_exec` (`graph exec`, finite exec) | requesting CLI | `Engine::connect_command_request` (35 s, HACK-2729) | expiry of fresh per-command values (`managed.deadline()`), if any | exec timeout starts after acquisition; frontend 95 s |
| `service_exec::interactive` (compose) | CLI | `Engine::connect_command_until` | the frontend's `live` check | counts against the interactive deadline |
| `native::runtime::exec::execute`, `exec::interactive`, `run::execute` (authored) | owner loop | `Engine::connect_command_until` | the owner's guard: signals, publication, pin (and client disconnect for interactive) | counts against the fixed 30 s budget |

The authored paths keep the wait inside their 30 s budget on purpose: the
native requester (`request_selected`) reads the owner's answer for a fixed
40 s, so a wait outside the budget could outlast that read. After a full 15 s
wait an authored exec or run has the remaining 15 s. The compose finite exec
instead starts its own timeout after acquisition, and its frontend bound
(95 s since HACK-2729) covers the wait.

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

## Exec beside another project's stop (HACK-2729)

Project X ran `hack down`. Its `web` service ignores SIGTERM and has the 30 s
stop grace, so X's owner held the provider lease for about 31 s. Project Y,
ready and routed, ran `hack exec` during that stop. After 15.1 s the exec
failed: "Native dependency refresh identity or outcome is unconfirmed ...
provider_busy", with no progress line. Nothing had run: the refresh's
requesting process never took the lease, so it never sent anything to Y's
owner. The CLI mapped every refresh failure, this one included, to
"unconfirmed".

The requesting side now waits `COMMAND_REQUEST_LEASE_WAIT`, which is
`START_LEASE_WAIT` (35 s, the stop grace limit plus 5 s), through
`Engine::connect_command_request`. That covers the refresh selection
(`dependency_refresh::requested_selection`) and `graph exec`
(`service_exec`). Both run in a short-lived requesting process that holds
nothing and serves no loop. The owner-side waits keep `COMMAND_LEASE_WAIT`
(15 s), because they block the owner's only loop. The CLI asks for the
lease-wait report on both requests (`onLeaseWait`) and prints one progress
line per command. On expiry the requester's own refusal is a raw
`provider_busy` with no cause: every owner refusal reaches it wrapped in
`refused()`, and the exec's lease is the first thing `graph exec` takes. The
CLI reports exactly that refusal as "nothing ran", with the holder and a
retry (`native-command-lease.ts`). Everything else keeps its report,
"unconfirmed" included, where the request was sent.

`ExecStopWait.tla` models this. The stop holds the lease for at most
`StopHold` ticks, one tick per second. Y's exec waits up to `Bound` ticks for
the refresh, which only reads, then up to `Bound` ticks for the exec, which
sends the command. After the send the reply may arrive or be lost.
`ExpiryUnconfirmed = TRUE` is the old report of an expiry.

| Config | Constants | Result | Shows |
| --- | --- | --- | --- |
| `exec-outlasts-stop` | `Bound = 35`, `StopHold = 31` | 192 distinct states, no error; `StopNeverRefuses`, `NoSendWhileHeld`, `UnconfirmedOnlyAfterSend`, `NothingRanMeansNothingSent` and `Settles` hold | The exec outlasts the 31 s stop and is never refused |
| `old-exec-bound` | `Bound = 15`, `ExpiryUnconfirmed = TRUE` | `UnconfirmedOnlyAfterSend` violated: `phase = "refused"`, `report = "unconfirmed"`, `sent = FALSE`, `elapsed = 15` | The reported failure |
| `honest-old-bound` | `Bound = 15` | `StopNeverRefuses` violated: `report = "nothing-ran"` at `elapsed = 15` | An honest refusal alone does not fix the wait |
| `exec-past-bound` | `Bound = 35`, `StopHold = 40` | `StopNeverRefuses` violated: `report = "nothing-ran"`, `sent = FALSE` at `elapsed = 35` | The wait stays bounded |
| `exec-past-bound-honest` | `Bound = 35`, `StopHold = 40` | 214 distinct states, no error; the report invariants and `Settles` hold | That refusal still says nothing ran |
| `exec-ran-after-stop` | `Bound = 35`, `StopHold = 31` | `NeverRanAfterStop` violated: `report = "ran"`, `sent = TRUE`, `held = 31` | The exec runs after the full stop |
| `exec-unconfirmed-after-send` | `Bound = 35`, `StopHold = 31` | `NeverUnconfirmed` violated: `report = "unconfirmed"`, `sent = TRUE` | A reply lost after the send is still unconfirmed |

[State chart](exec-stop-wait.svg) ([source](exec-stop-wait.mmd), Pele 1.9.0,
label check PASS).

Tests:

- `provider/engine/command_lease_tests.rs`: the constants (35 s is the
  start's bound, the owner keeps 15 s, `command_lease_deadline` caps a far
  deadline at each); scaled 50 times, a project stop held 600 ms is refused
  at the owner bound with the exact project-stop message and waited out by
  `connect_command_request`; a stop past the bound is refused with the raw,
  uncaused `provider_busy`.
- `dependency_refresh.rs` `owner_lease_tests`: the same for the refresh's
  `requested_selection`.
- `tests/native-command-lease.test.ts`, `tests/native-project-exec.test.ts`,
  `tests/native-project-dependency-refresh.test.ts`: the progress line (once
  across the refresh and the exec), the refusal for `hack exec` and `hack
  run`, a wrapped or caused `provider_busy` that stays as it was, and the
  frontend bounds.

The model abstracts a second holder that arrives between the refresh and the
exec (the exec's own wait covers it the same way), fresh per-command values
whose 30 s lifetime can end the exec's wait first, and the owner-side waits
of interactive `exec` and `hack run`, which keep 15 s.

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
- `src/backends/native-project-exec.ts` (95 s, was 75 s) and
  `native-project-dependency-refresh.ts` (220 s, was 200 s): frontend bounds
  that cover the added wait.
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
