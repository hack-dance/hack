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
| `native::foreground::exec` (authored finite exec, `graph native exec`) | requesting CLI | `lifecycle::await_free_command_lease` (35 s, HACK-2739): waits for a free lease and releases it, no engine connection | none (Ctrl-C ends the process) | before the send; then the fixed 40 s read; frontend 85 s |
| `native::runtime::exec::execute`, `exec::interactive`, `run::execute` (authored) | owner loop | `Engine::connect_command_until` | the owner's guard: signals, publication, pin (and client disconnect for interactive) | counts against the fixed 30 s budget; `execute` maps its expiry to `graph_authored_exec_lease_busy` (HACK-2739) |

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

`ExecStopWait.tla` models this. Every holder keeps the lease for at most
`StopHold` ticks, one tick per second. Y's exec waits up to `Bound` ticks for
the refresh, which only reads, then up to `Bound` ticks for the exec, which
sends the command. With `Holders = 2` a second holder (another project's stop
or start) may take the lease between the refresh and the exec. After the send
the reply may arrive or be lost. `ExpiryUnconfirmed = TRUE` is the old report
of an expiry; `EnforceLease = FALSE` is a control that sends without the lease.
The fix reports an expiry as `not-run`: "nothing ran" at the refresh, "the
command did not run" at the exec, whose refresh already ran.

| Config | Constants | Result | Shows |
| --- | --- | --- | --- |
| `exec-outlasts-stop` | `Bound = 35`, `StopHold = 31`, `Holders = 2` | 352 distinct states, no error; `StopNeverRefuses`, `NoSendWhileHeld`, `UnconfirmedOnlyAfterSend`, `NotRunMeansNotSent` and `Settles` hold | The exec outlasts the 31 s stop and a second holder, and is never refused |
| `old-exec-bound` | `Bound = 15`, old report | `UnconfirmedOnlyAfterSend` violated: `phase = "refused"`, `report = "unconfirmed"`, `sent = FALSE`, `elapsed = 15` | The reported failure |
| `honest-old-bound` | `Bound = 15` | `StopNeverRefuses` violated: `report = "not-run"` at `elapsed = 15` | An honest refusal alone does not fix the wait |
| `exec-past-bound` | `Bound = 35`, `StopHold = 40` | `StopNeverRefuses` violated: `report = "not-run"`, `sent = FALSE` at `elapsed = 35` | The wait stays bounded |
| `exec-past-bound-honest` | `Bound = 35`, `StopHold = 40`, `Holders = 2` | 393 distinct states, no error; the report invariants, `NoSendWhileHeld` and `Settles` hold | That refusal still says the command did not run |
| `exec-ran-after-stop` | `Holders = 1` | `NeverRanAfterStop` violated: `report = "ran"`, `sent = TRUE`, `held = 31` | The exec runs after the full stop |
| `exec-ran-after-peer` | `Holders = 2` | `NeverRanAfterPeer` violated: `report = "ran"`, `holds = 2` | The exec waits out a second holder after the refresh, then runs |
| `exec-unconfirmed-after-send` | `Holders = 2` | `NeverUnconfirmed` violated: `report = "unconfirmed"`, `sent = TRUE` | A reply lost after the send is still unconfirmed |
| `send-while-held` | `EnforceLease = FALSE` | `NoSendWhileHeld` violated: `sentHeld = TRUE`, `phase = "sent"` | The invariant is not vacuous: a send without the lease breaks it |

The owner's own refresh wait (15 s on its loop) is not in this model. When it
expires before the rebind, after another waiter took the lease, the owner
answers `graph_dependency_refresh_lease_busy`, which the CLI also reports as
"nothing ran" (`dependency_refresh::owner_selection_refusal`, tested in
`owner_lease_tests`).

[State chart](exec-stop-wait.svg) ([source](exec-stop-wait.mmd), Pele 1.9.0,
label check PASS).

Tests:

- `provider/engine/command_lease_tests.rs`: the constants (35 s is the
  start's bound, the owner keeps 15 s, `command_lease_deadline` caps a far
  deadline at each). The scaled 300 ms owner wait refuses a stop that still
  holds the lease and returns the exact project-stop message. The test releases
  the stop on the requester's first retry and verifies acquisition. A stop
  past the requester's deadline yields the raw,
  uncaused `provider_busy`.
- `dependency_refresh.rs` `owner_lease_tests`: the refresh's `requested_selection`
  waits out a 600 ms stop with 500 ms of slack for scheduling, unlock, and
  polling at up to 50 ms per interval (HACK-2741). A stop held past the
  deadline yields the exact raw `provider_busy` with no cause. The owner's
  selection refusal maps to `graph_dependency_refresh_lease_busy`, and other
  codes are kept.
- `tests/native-command-lease.test.ts`, `tests/native-project-exec.test.ts`,
  `tests/native-project-dependency-refresh.test.ts`: the progress line (once
  across the refresh and the exec), the refusal for `hack exec` and `hack
  run`, "the command did not run" at the exec step, the owner's pre-effect
  refusal, a wrapped or caused `provider_busy` that stays as it was, the 65 s
  lifetime of fresh exec values, the released admission slot, and the
  frontend bounds.

The model abstracts fresh per-command values (their lifetime is now 65 s, so
it covers the exec's whole 35 s wait) and the owner-side waits of interactive
`exec` and `hack run`, which keep 15 s.

## Authored exec beside another project's stop (HACK-2739)

Confirmed on a real VM: while another project's 30 s stop held the provider
lease, `hack exec` in an authored project (`hack.project.json`) exited 1
after 15.1 s with `E_LIFECYCLE_FAILED ... completion is unconfirmed ... No
request was replayed`, and no progress line. The command never ran. An
authored exec sends one request to its owner, and the only lease wait was the
owner's own (`native/runtime/exec.rs` `execute`): 15 s inside a fixed 30 s
budget, on the owner's only loop thread. The requester reads the owner's answer
for a fixed 40 s (`foreground::request_selected`), and a longer owner wait
would also hold up that owner's `hack down` and restart ticks. The CLI turned
every failure, the owner's `provider_busy` included, into "unconfirmed".

The fix moves the long wait to the requesting process, as the Compose refresh
does. `native::foreground::exec` first calls
`lifecycle::await_free_command_lease`, which waits up to
`COMMAND_REQUEST_LEASE_WAIT` (35 s) through the same
`state::wait_for_acquisition` loop (so the same `hack.lease-wait` report), then
releases the lease and sends. It does not use `Engine::connect_command_request`:
that opens an engine connection and runs the pool audit and a version request
after acquisition, which the owner repeats at once, so it would add a full
engine connection to every authored exec. The bare lock attempt costs one
`flock` when the lease is free, and any other failure to take the lock (no
provider state, no lock file) goes on to the owner, which answers as before.
The wait does not read the pool record: while a `runtime down` or a cold start
holds the lock, the requester waits up to 35 s and may refuse `provider_busy`
naming that holder, instead of the owner's quick `runtime_not_running`. That
refusal is pre-effect and bounded, so it is kept. On expiry the requester returns the raw `provider_busy`
naming the holder: nothing was sent. The owner keeps its 15 s; if another
holder took the lease in between and that wait expires, `execute` answers
`graph_authored_exec_lease_busy` before it reads the journal or touches a
container. The CLI reports both as "nothing ran" (`native-authored-project-exec.ts`),
releases a background command's admission slot, and keeps "unconfirmed" for
everything else.

`ExecStopWait.tla` models this path with the same two waits: the first
(`phase = "refresh"`) is the requester's wait, which sends nothing; the second
(`phase = "exec"`) is the owner's, with its own bound `SecondBound = 15`.
`Probe = FALSE` is the authored path before the fix (only the owner's wait).
The Compose configs set `SecondBound = Bound` and `Probe = TRUE`, and their
state counts are unchanged (352 and 393).

| Config | Constants | Result | Shows |
| --- | --- | --- | --- |
| `authored-outlasts-stop` | `Bound = 35`, `SecondBound = 15`, `StopHold = 31`, `Holders = 1` | 192 distinct states, no error; `StopNeverRefuses`, `NoSendWhileHeld`, `UnconfirmedOnlyAfterSend`, `NotRunMeansNotSent` and `Settles` hold | The authored exec outlasts the 31 s stop with the owner's wait kept at 15 s |
| `authored-peer-race` | `StopHold = 40`, `Holders = 2` | 293 distinct states, no error; the report invariants, `NoSendWhileHeld` and `Settles` hold | A second holder that takes the lease after the requester's wait and before the owner's, or a stop past 35 s, is refused as not run; "unconfirmed" only after a send |
| `authored-peer-refused` | `Holders = 2` | `NeverRefusedAtSecondWait` violated: `phase = "refused"`, `report = "not-run"`, `sent = FALSE`, `elapsed = 15`, `holds = 2` | The race is reachable, and the owner's refusal says nothing ran |
| `authored-old` | `Probe = FALSE`, old report | `UnconfirmedOnlyAfterSend` violated: `report = "unconfirmed"`, `sent = FALSE`, `elapsed = 15` | The failure seen on the VM |
| `authored-honest-no-wait` | `Probe = FALSE` | `StopNeverRefuses` violated: `report = "not-run"` at `elapsed = 15` | An honest message without the requester's wait still refuses during the stop |
| `authored-ran-after-stop` | `Holders = 1` | `NeverRanAfterStop` violated: `report = "ran"`, `sent = TRUE`, `held = 31` | The exec runs after the full stop |

`PeerTake` is enabled only between the two waits (`phase = "exec"`), so the
model does not cover a second holder that takes the lease while the
requester's own wait is still running. Such a holder only lengthens a wait
that sends nothing. Its expiry is the requester's not-run refusal, which
`authored-peer-race` already reaches with a stop past the bound
(`StopHold = 40`), so the reports are the same.

[State chart](authored-exec-stop-wait.svg) ([source](authored-exec-stop-wait.mmd),
Pele 1.9.0, label check PASS). It names the model's phases by their authored
roles: `requester` is `phase = "refresh"`, `owner` is `phase = "exec"`.

Tests:

- `provider/engine/command_lease_tests.rs`: the requester waits out a 600 ms
  stop with 500 ms of polling slack (#1286, HACK-2751), then releases the
  lease for the next holder. A stop still holding the lease at the deadline
  gets the raw, uncaused `provider_busy` naming the stop. 100 uncontended waits
  take well under a second, and on a home with no pool the wait returns at once
  and creates no lock file. The call site, `native::foreground::exec`, waits out
  the stop before it contacts the owner (this test fails when the wait is removed).
- `native/runtime/exec_tests.rs`: only `provider_busy` maps to
  `graph_authored_exec_lease_busy`, which passes the reply-code filter, and
  the owner's wait on a real held flock ends in that code.
- `tests/native-authored-project-exec.test.ts`: one progress line, the 85 s
  frontend bound, both pre-effect refusals reported as "nothing ran" with the
  released slot, and other failures (a wrapped `provider_busy` included) still
  unconfirmed with the slot held. `tests/native-runtime-client.test.ts`: the
  owner's code survives the client's closed cause filter.

Not changed: authored one-off `run` and interactive exec keep only the
owner's 15 s wait, and still report an expiry as unconfirmed.

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
