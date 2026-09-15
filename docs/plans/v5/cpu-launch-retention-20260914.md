# September 14 — Fixed-work CPU attribution and graph intent retention

The CPU gap is concentrated in repeated container-process launch, not the small HTTP check's
application code. The candidate already has lower observed idle CPU than OrbStack. A larger feature
set can occupy memory while doing little work when idle; it does not predict the CPU cost of the
same process-launch operation.

## Equal completed work

Automatic container health checks are disabled for this diagnostic. Each engine executes exactly
58 successful commands, paced once per second within a 60-second native sampling window. The two
commands are `/bin/true` and the same Bun HTTP check used previously. Startup still verifies the
SQLite workload with 200 requests; shutdown, retained-data restore and fresh compute all pass.
These are diagnostic exec operations through the engine API, not the original latency protocol.

| Engine / command | Host CPU-seconds | Host CPU ms per exec, including idle | Web cgroup CPU-seconds | Median exec wall time |
| --- | --- | --- | --- | --- |
| Candidate / no-op | 5.219 | 89.98 | 0.922 | 84.83 ms |
| Compose / no-op | 3.236 | 55.80 | 0.987 | 32.37 ms |
| Compose / HTTP | 3.865 | 66.64 | 1.964 | 45.19 ms |
| Candidate / HTTP | 5.297 | 91.32 | 1.822 | 98.13 ms |

The candidate's no-op window costs almost as much host CPU as its HTTP window. Web cgroup CPU is
similar or lower, while host CPU is higher. This narrows the problem to runtime/kernel/VM work
outside the application cgroup; it does not yet assign exact shares to `runc`, the engine and the
hypervisor. Native and cgroup counters cover slightly different intervals and must not be directly
subtracted as an exact virtualization bill. The process-launch path is a better target than
removing idle features or changing the check cadence.

All 232 unique exec IDs have confirmed exit code zero, with no automatic health probes. Independent
verification uses enclosing API timestamps and native-window duration to prove every measured exec
falls inside its corresponding native interval despite different clock origins. Workload/image and
inspected limits match, and all graph/data cleanup checks pass. One observation per engine/command
is a diagnostic comparison, not a tail estimate. CPU is percent/time of one core; selected engine
trees exclude the driver, stable daemon and observer, which remain separately measured.

Evidence: `.hack-local/review/wu05/fixed-probes-1789440006633821000/`, including frozen protocol,
per-exec receipts, five completed native windows, cgroup counters, independently checked time
bounds and scalar results. Protected inputs matched and the owned VM stopped.

## Retired graph intents

Removed graphs can now move their validated, value-free environment intents into their retained
archive. Every resource must be absent, every binding must match, and each slot is retired before
movement. Both source and destination directories are synchronized after each rename. A retry
validates the active and already-moved inventories without overwriting an existing record.

Export applies the same checks to older removed archives, so legacy graph-bound intents can be
collected too. The existing bounded export contains their bytes. Verified pruning then removes the
archive only after durable consumed-ID publication; exported evidence and the run-ID reservation
remain. This frees graph-bound slots in the active environment inventory without authorizing
redelivery or making a consumed graph runnable again.

The new live control kills the archive driver immediately after an intent move, retries archival,
rejects a mismatched archived binding, verifies that the export includes the value-free intent and
omits the synthetic managed value, repeats pruning, and proves run-ID reuse is refused. The broader
recovery run reached its 90-second harness deadline while scanning historical intents; the unchanged
prior-boot control passed separately with a finite 240-second budget. This timeout is retained as
harness evidence rather than reported as a product assertion failure or a passing check. The
successful separate receipt is `.hack-local/review/wu07/prior-boot-completion-1789440676432207000/`.

The historical graph sweep exported and pruned 181 removed graphs, leaving no graph-bound intents
in the active inventory. Each prune verified retained export bytes and the durable consumed-ID
reservation. Evidence: `.hack-local/review/wu07/retention-sweep-1789440830441658000/`.
Subsequent benchmark archives are new records, not part of that historical count.

## Standalone retired intents — September 15 completion

The explicit `export_retired` library operation moves an already-absent, value-free standalone
intent to `exports/environment-intents`. It verifies ownership and slot identity, refuses live or
graph-bound delivery, preserves the original bytes, synchronizes both directories, and keeps the
export as a permanent slot-ID reservation. Repeated export and old-lease cleanup remain idempotent.
It does not retire a live lease as a side effect or restore any environment value.

The live fault control passed: live export refused, explicit retirement, actual driver SIGKILL
after the move, retry with identical hash, allocation under the consumed ID refused, synthetic
value absent from exported bytes, and repeated cleanup accepted. The manifest sweep then validated
and exported all 247 prior-boot standalone records, verifying every retained hash and source absence.
Evidence: `.hack-local/review/wu07/standalone-retention-1789442989403350000/`. The VM stopped and
protected global executable/configuration hashes matched. A preceding diagnostic harness attempt
failed on a missing Python import and stopped the VM before performing the control or sweep.

Default and environment-launcher Rust suites each passed 147 tests; strict Clippy passed for both.
The graph archive controls and prior-boot completion receipts remain separate from this new
standalone live control. This closes historical intent retention, not application acceptance.

Further CPU work and the persistent-probe measurements are in the
[runtime alternatives checkpoint](runtime-alternatives-20260915.md).
