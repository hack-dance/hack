# Native startup lock contention

The stopped-pool startup model still covers effect-time lease acquisition
and retained identity verification. This model covers contention at that
acquisition boundary for a provider or image-cache lock. The shared
`state::wait_for_acquisition` loop retries acquisition without executing
the protected operation. A successful lock passes control to the caller's
existing verification and effect. An exhausted wait returns the last
observed contention refusal.

Two contenders use one lock. The first holder keeps it for at most
`StopHold` ticks, then releases. The waiter waits across at most `Bound`
ticks. Time passes for the waiter only while the first holder has the lock:
the real waiter polls every 5 to 50 ms, so it never sits on a free lock
while a tick passes. Weak fairness assumes the waiter keeps taking attempts
and the holder eventually releases. Release during the budget permits
acquisition; expiry never gives the waiter authority. The negative control
admits a waiter while the lock is held. The model abstracts scheduling
latency, cross-lock ordering, filesystem failures and holder-record
durability.

## Another project's stop (HACK-2724)

`hack down` of one project holds the provider lease for its whole graph
stop: about 31 s when a service has the 30 s stop grace limit. Another
project's `hack up -d` waited only `STARTUP_LEASE_WAIT` (5 s) in the
retained-start preflight and in the running-pool resume, then refused
`provider_busy`. The start waits that admit nothing now wait
`START_LEASE_WAIT` (35 s: the grace limit plus 5 s). In these controls one
tick is one second.

The first holder may also be another start that boots the pool
(`Release` leaves `pool` stopped or running). Under the lock the waiter
reads the pool first. A stopped pool is its own to boot (`acquired`). A
pool the peer booted is resumed (`resumed`, `running_start::resume_leased`
under the same lease), where the reviewed version refused its admission
rechecks (`admission_owner_changed`, `foreign_state`). `StopNeverRefuses`
therefore checks two things: no expiry, and no refused boot after a peer's
boot. `NeverExpired` checks only the first, and is a reachability control.

| Config | Constants | Result | Shows |
| --- | --- | --- | --- |
| `positive` | `Bound = 5`, `StopHold = 5` | 31 distinct states, no error; `Settles` holds | No effect while held, no admission or resume at or after the bound |
| `negative` | no ownership check | `NoEffectWhileHeld` violated | A waiter admitted while the lock is held |
| `acquisition-reachable` | `Bound = 5` | `NeverAcquired` violated | Acquisition after a release is reachable |
| `expiry-reachable` | `Bound = 5` | `NeverExpired` violated at `elapsed = 5` | Expiry at the bound is reachable |
| `stop-outlasted` | `Bound = 35`, `StopHold = 31` | 160 distinct states, no error; `StopNeverRefuses` and `Settles` hold | A start outlasts a 31 s project stop or a peer's boot, and boots or resumes after it |
| `old-start-bound` | `Bound = 5`, `StopHold = 31` | `StopNeverRefuses` violated: `waiter = "expired"` at `elapsed = 5` | The reported refusal |
| `stop-past-bound` | `Bound = 35`, `StopHold = 40` | `StopNeverRefuses` violated at `elapsed = 35` | The wait stays bounded: a holder past it is refused, with the holder named |
| `peer-boot-refused` | `ResumeRunning = FALSE` | `StopNeverRefuses` violated: `waiter = "refused"`, `pool = "running"` | The review finding: a boot that waited out a peer's boot refused under the lease |
| `peer-boot-resumed` | `ResumeRunning = TRUE` | `NeverResumed` violated: `waiter = "resumed"`, `pool = "running"` | The resume after a peer's boot is reachable |

## Retained starts across a peer's boot (HACK-2732)

`RetainedGuard.tla` adds the retained-start guard to the peer-boot case.
Retained starts of two projects (`a`, `b`), or three, share one stopped pool. Each takes a
selection in its preflight (`graph retained-preflight`), then sends
`runtime up` bound to it. A start holds the startup lease for its whole boot.
The selection is the pool's stable identity (`token`) plus what boots, stops
and other projects rewrite (`boots`, the phase, `peer`). `PeerChange` is
another project's change outside these runs' identity, under its own lease:
its own share added (which stops an idle pool), or a network or capacity
change. `Eligible` is `checked`: a booting pool is not
eligible, and a replaced owner's token does not match the run's receipt.

On the real VM, the second start failed in about 2 s with
`graph_retained_startup`. Its guard read the pool before the lease, so it saw
the first start's boot in progress (`booting`, or the `owner.pending` of a
record write), or a selection the boot had made stale. Now the guard reads
eligibility and compares the selection only under the lease
(`GuardUnderLease`). A selection that is stale only by the pool's boots, with
the same token and receipt, is `graph_retained_pool_changed`. The CLI then
selects again and retries `runtime up` once (`JoinChanged`), which joins the
running pool. A second change after that retry is reported as it comes,
with the next step named (`Retry hack up (or hack up -d).`), not retried
again: `retained-guard-changed-twice` reaches it, and
`retained-guard-peer-changes` shows it is the only refusal besides a
replaced owner.

| Config | Constants | Result | Shows |
| --- | --- | --- | --- |
| `retained-guard` | `GuardUnderLease`, `JoinChanged` | 22 distinct states, no error; `NoRefusal`, `OneBoot`, `StartsOnItsPool` and `Settles` hold | Both starts reach the pool: one boots it, the other joins |
| `retained-guard-before-lease` | `GuardUnderLease = FALSE` | `NoRefusal` violated: one start `booting`, the other `refused`, `pool = "booting"` | The reported refusal: the preflight read the pool mid-boot |
| `retained-guard-no-join` | `JoinChanged = FALSE` | `NoRefusal` violated: one start `booted`, the other `refused`, `pool = "running"` | Under the lease alone, the stale selection still refuses (also the #1272 `resume_leased` path) |
| `retained-guard-replaced` | `Replace = TRUE` | 38 distinct states, no error; `OneBoot`, `StartsOnItsPool` and `Settles` hold | A replaced owner never starts, even with the retry |
| `retained-guard-replaced-refuses` | `Replace = TRUE` | `NoRefusal` violated with `token = 1` | ... and it is refused, not joined |
| `retained-guard-three` | three starts | 167 distinct states, no error; `NoRefusal`, `OneBoot`, `StartsOnItsPool` and `Settles` hold | One start boots the pool, two select again and join |
| `retained-guard-peer-changes` | `PeerChanges = 2`, `Replace = TRUE` | 761 distinct states, no error; `RefusedOnlyAfterRetry`, `OneBoot`, `StartsOnItsPool` and `Settles` hold | A refusal only for a replaced owner, or after the one retry met another change |
| `retained-guard-changed-twice` | `PeerChanges = 2` | `NoRefusal` violated: `peer = 2`, the start `refused` after its retry | The second change is reachable and reported, not retried without bound |
| `retained-guard-rejoins` | as `retained-guard` | `NeverJoinedAfterRetry` violated: `retried` and `joined` for the same start | The retry, then the join, is reachable |

The model abstracts the lease wait itself (`LeaseWait` covers it), the CLI's
graph confirmation on a running pool, the early leased check in
`Guard::acquire` (the same check under a brief lease, so a stale selection
refuses before any admission work), and the other identity fields, which
the token stands for (the disks, root files and this run's own share refuse
the same way; other projects' shares, the network and capacity are
`PeerChange`).

Code and tests:

- `graph/retained_startup.rs`: `selection` (stable half, then whole-record
  half), `Guard::verify` (takes the startup lease and checks its path), and
  `preflight` (lease first, then `checked`). Tests:
  `preflight_and_the_guard_wait_out_a_peer_boot_instead_of_refusing_it` (the
  unleased read refuses the booting pool, as in `retained-guard-before-lease`;
  the leased read waits it out),
  `a_start_selected_before_a_peer_boot_refuses_as_a_changed_pool_and_its_new_selection_holds`,
  `a_peer_projects_pool_change_is_a_changed_pool_that_a_new_selection_accepts`,
  `a_changed_identity_of_this_runs_pool_still_refuses_and_is_never_a_changed_pool`
  and `preflight_selection_and_held_guard_refuse_a_valid_replacement_owner_before_up`.
- `provider/lifecycle.rs`, `lifecycle/running_start.rs`: every retained check
  after `Guard::acquire` receives the lease the start holds, including the
  `resume_leased` closure.
- `src/backends/native-project-retained-startup.ts`:
  `runtimeUpJoiningChangedPool` and `reselectNativeRetainedStartup`. Tests in
  `tests/native-project-retained-startup.test.ts` and
  `tests/native-project-start.test.ts` (`HACK-2732`: one retry that joins, a
  second changed pool, reported with `NATIVE_RETAINED_POOL_CHANGED_AGAIN`,
  and a replaced owner refuse).
- `graph/unadmitted_owner/tests.rs`:
  `an_owner_on_a_pool_whose_provider_was_lost_is_retired_only_with_its_provider_gone`
  (`down --recover`'s retirement shares `checked`).

[State chart](lease-wait.svg) ([PNG](lease-wait.png), [source](lease-wait.mmd)).

## Code and tests

- `provider/lifecycle.rs`: `START_LEASE_WAIT`, used by
  `graph/retained_startup.rs` (`preflight`), `lifecycle/running_start.rs`
  (`resume`), the pool boot's admission lease and
  `OwnedGuest::connect_cleanup_for_start` (`graph restore-selection`,
  `graph inspect --startup-wait`). `exec` keeps `COMMAND_LEASE_WAIT`;
  `hack ps` and `hack logs` take no wait here.
- `provider/lifecycle.rs`: `startup_admission_lease` reads the pool before
  any recheck and returns `LeasedBoot::Running`, which `start_pool` resumes
  with `running_start::resume_leased`. Test:
  `a_boot_that_waited_out_a_peer_boot_resumes_the_running_pool_under_the_lease`
  (`lifecycle/pressure_tests.rs`), and the step order in
  `start_pool_takes_its_admission_steps_in_the_modelled_order`.
- `provider/state.rs`: `RecordProjectStop` makes a foreground owner's own
  stop record its holder as `project stop` (the owner's arguments named a
  start or nothing). `wait_reporting` prints one
  `hack.lease-wait:begin <holder>` line after 3 s of contention when the CLI
  asks for it. Tests:
  `a_start_waits_out_a_project_stop_past_the_old_bound_and_reports_it_once`
  (scaled 50 times: the holder releases past the old bound, the start is
  admitted), `a_start_wait_past_its_bound_refuses_naming_the_stop_and_a_brief_one_is_silent`
  and `the_receipt_bound_native_cleanup_records_a_project_stop` (behavioural, the
  native owner). The compose owner's stop needs an owned VM, so
  `the_compose_owner_records_its_own_stop_before_taking_the_lease` stays a source guard for it.
- `src/backends/native-start-lease.ts`: the progress line and the refusal
  (holder and a plain retry). Tests: `tests/native-start-lease.test.ts`,
  `tests/native-runtime-client.test.ts` and `tests/native-detached-up.test.ts`
  (`HACK-2724`).

The earlier Rust regression waits on an actual flock, then either acquires
after release or preserves the holder diagnostic on expiry.
