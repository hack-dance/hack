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

[State chart](lease-wait.svg) ([source](lease-wait.mmd)).

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
