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
| `native::foreground::one_off` (authored `hack run`) | requesting CLI | `await_free_command_lease` (35 s, HACK-2742) | none | before the send; then the fixed 40 s read; frontend 85 s |
| `native::foreground::interactive` (authored interactive exec) | interactive child | `await_free_command_lease_checked` (35 s, HACK-2742) | the frontend leash | before the send |
| `native::runtime::exec::execute`, `exec::interactive`, `run::execute` (authored) | owner loop | `Engine::connect_command_until` | the owner's guard: signals, publication, pin (and client disconnect for interactive) | counts against the fixed 30 s budget; `owner_command_engine` maps its expiry to `graph_authored_exec_lease_busy` or `graph_authored_run_lease_busy` (HACK-2739, HACK-2742) and a refused guard to `graph_authored_command_not_started` (HACK-2742) |

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
  deadline at each); scaled 50 times, a project stop held 600 ms is refused
  at the owner bound with the exact project-stop message and waited out by
  `connect_command_request`; a stop past the bound is refused with the raw,
  uncaused `provider_busy`.
- `dependency_refresh.rs` `owner_lease_tests`: the same for the refresh's
  `requested_selection`, and the owner's selection refusal mapped to
  `graph_dependency_refresh_lease_busy` while other codes are kept.
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

- `provider/engine/command_lease_tests.rs`, scaled 50 times: the requester's
  wait outlasts a project stop held 600 ms and releases the lease; a stop past
  its bound is refused with the raw, uncaused `provider_busy` naming the stop;
  100 uncontended waits take well under a second, and on a home with no pool
  the wait returns at once and creates no lock file; and the call site,
  `native::foreground::exec`, waits out the stop before it contacts the owner
  (this test fails when the wait is removed).
- `native/runtime/exec_tests.rs`: only `provider_busy` maps to
  `graph_authored_exec_lease_busy`, which passes the reply-code filter, and
  the owner's wait on a real held flock ends in that code.
- `tests/native-authored-project-exec.test.ts`: one progress line, the 85 s
  frontend bound, both pre-effect refusals reported as "nothing ran" with the
  released slot, and other failures (a wrapped `provider_busy` included) still
  unconfirmed with the slot held. `tests/native-runtime-client.test.ts`: the
  owner's code survives the client's closed cause filter.

## Authored `hack run`, interactive exec and the owner's own check (HACK-2742)

HACK-2739 left two authored commands with only the owner's 15 s wait:
one-off `hack run` (`native::foreground::one_off`, owner side
`native/runtime/run.rs`) and interactive `hack exec`
(`native::foreground::interactive`, owner side `exec.rs` `interactive`). Both
reported an expired wait as unconfirmed. A third case covered all three: the
owner's guard (a pending signal, its own `hack down`, a changed publication or
pin) runs before every lease attempt, so it can end the owner's wait. It
returned the plain `refused()`, which the CLI also reported as unconfirmed,
although nothing had been read, touched or started.

- Both requesters now call `await_free_command_lease` before they send. The
  interactive one passes its frontend leash as the check
  (`await_free_command_lease_checked`), so a frontend that is gone ends the
  wait. A refused check is returned as is.
- All three owner paths go through `exec::owner_command_engine`. It runs the
  guard, then `connect_command_until`, and relabels only those failures:
  `graph_authored_exec_lease_busy` or `graph_authored_run_lease_busy` when the
  lease stayed busy, and `graph_authored_command_not_started` when the guard
  refused. Later failures keep their codes.
- `hack run` now has the same 85 s frontend bound as the finite exec (it was
  45 s), its progress line, its not-run refusals and its released admission
  slot.
- The interactive child's stderr is the user's terminal, so its lease-wait
  report goes to its control channel (fd 3) as one closed event line ahead of
  the final report. The CLI prints the usual progress line for an authored
  exec. The final refusal report also carries the holder's closed token for
  an expired requester wait. The requester forwards the owner's pre-effect
  codes as the report code, which carries only one code.

`ExecStopWait.tla` gains `Cancellable` (the owner's check may end the owner
wait) and `CancelUnconfirmed` (the report before the fix). Every earlier
config sets both to `FALSE`; their state counts are unchanged.

| Config | Constants | Result | Shows |
| --- | --- | --- | --- |
| `authored-cancel` | `SecondBound = 15`, `Holders = 2`, `Cancellable = TRUE` | 335 distinct states, no error; `NoSendWhileHeld`, `UnconfirmedOnlyAfterSend`, `NotRunMeansNotSent` and `Settles` hold | A cancelled owner wait sent nothing and is reported as not run |
| `authored-cancel-old` | `CancelUnconfirmed = TRUE` | `UnconfirmedOnlyAfterSend` violated: `cancelled = TRUE`, `report = "unconfirmed"`, `sent = FALSE` | The report before the fix |
| `authored-cancel-reach` | `Cancellable = TRUE` | `NeverCancelled` violated: `cancelled = TRUE`, `report = "not-run"` | The cancel is reachable, so the positive control is not vacuous |

The model's two waits stand for each command's requester and owner waits; the
run and interactive paths have the same shape as the finite exec.

Tests: `command_lease_tests.rs` (the `one_off` call site waits out the stop;
a refused requester check ends the wait with its own error; the refusal's
holder token), `exec_tests.rs` (`owner_wait_refusal` codes; the owner's lease
wait per command; a guard that refuses during or before the wait ends it as
not started within 2 s; a later failure keeps its code),
`tests/native-authored-project-oneoff.test.ts`, `native-command-lease`,
`native-authored-project-exec` (the not-started message),
`native-interactive-exec` (the event line, the report's holder field, the
messages, and a PTY case each for a lease refusal and a not-started refusal),
`native-runtime-client` (the new causes pass the closed filter).

## Storage-backed authored run and exec (HACK-2752)

Two more authored refusals and costs, found on a real VM, sit next to these
waits but are not lease behaviour, so the model is unchanged:

- `run::execute_with` refused a one-off of a service with persistent data
  mounts, or of a project with a live source, with the plain `refused()`; the
  CLI said "unconfirmed". It now answers `graph_authored_run_mounts_unsupported`
  before any record or container, a pre-effect refusal of the same kind as the
  model's `not-run` reports (`run_tests.rs`
  `a_one_off_of_a_storage_backed_service_is_refused_as_unsupported_before_any_effect`).
- A finite exec rechecked the full snapshot, persistent-data witness included,
  before and after each engine transport: eleven snapshots, 22 witness reads,
  about 16 s of a 30 s budget for a storage-backed service. The per-transport
  recheck now skips the witness (`snapshot_unwitnessed_until`); a full snapshot
  runs before the first transport and after the last response, so a witness
  that fails after the command still withholds its output (`exec_tests.rs`
  `finite_exec_proves_the_data_witness_only_before_and_after_its_command`,
  `run_tests.rs` `a_one_off_proves_the_data_witness_only_before_and_after_its_command`).

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
