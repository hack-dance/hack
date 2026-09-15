# Cleanup CPU attribution — 2026-09-15

## Outcome

Concurrent cleanup remains disabled. The phase-isolated crossover did not reproduce a consistent
latency or combined CPU improvement. CLI CPU is material, and the existing disk-handle audit is a
measured next optimization target: standalone `lsof` used a median 59.9 ms CPU and 80.2 ms wall time.
No runtime defaults changed in this investigation.

## Phase-isolated crossover

The [previous experiment](concurrent-cleanup-20260915.md) changed the build for the entire lifecycle.
This control used the retained-data-only experimental binary for just the target phase. Setup,
startup, restore and all other phases used the qualified dependency-order baseline. Each target
(`down` and full `remove`) ran eight fresh fixtures in ABBA/BAAB order, four observations per build.
Two excluded lifecycle warmups preceded the cohort. Per-phase binary hashes were verified.

The same native HTTP init/SQLite/web/check fixture, image, four-vCPU/6-GiB VM and service limits were
retained. Every measured trial and warmup passed 200 requests before and after restore, stable SQLite
token, fresh container IDs, effective limits and owned cleanup. Protected configuration hashes
matched, pressure remained normal with unchanged swapouts, and the VM stopped after each cohort.

An isolated Python timing process collected child resource usage for each CLI command, including
its reaped descendants such as `lsof`. It excluded the Python timing parent and unrelated watchdog
children. Engine counters were sampled both immediately around the timed command and around the
whole phase including readiness inspection. The table uses command-only engine counters. Combined
CPU adds CLI and engine CPU per observation before taking the median; it is not whole-host CPU.

| Target phase/build | Command wall ms | CLI CPU ms | Engine CPU ms | Combined CPU ms |
| --- | ---: | ---: | ---: | ---: |
| Retain data / baseline | 654.1 | 93.4 | 121.0 | 214.4 |
| Retain data / experiment | 670.2 | 85.4 | 132.8 | 218.3 |
| Full removal / baseline | 612.7 | 86.5 | 110.2 | 198.1 |
| Full removal / experiment | 596.3 | 92.7 | 136.3 | 229.0 |

Retained-data combined CPU improved 11.8% in the ABBA block but worsened 11.7% in BAAB; command
latency improved 10.0% then worsened 16.4%. Full removal used sequential deletion in both binaries,
yet its combined CPU was higher by 8.2% and 32.5% in the two blocks. This unchanged-path control
prevents attributing all observed differences to concurrency. Build, order and runtime variation
remain confounded. There is no repeatable overall win to adopt.

The timing wrapper and per-phase executable replacement alter this protocol's wall-time envelope;
absolute timings must not be compared directly with the earlier unwrapped cohort. Warmups do not
remove every executable-replacement effect. The CPU accounting improvement is useful even though
this crossover does not establish the cause of the prior regression. CLI peak RSS was roughly
9.6 MB, a peak-process metric rather than persistent or aggregate footprint.

[All 64 phase rows](cleanup-crossover-20260915.csv) preserve target assignment, actual phase variant,
command timing, CLI CPU, engine CPU, combined CPU and peak RSS.

## Disk-audit attribution

A separate empty-VM cohort ran eight alternating pairs of the exact existing `lsof -n -P -p PID -F n`
audit and `hack-local runtime engine-info --json`. The target was the freshly verified owned VM PID;
every audit observed both expected disk names. Source inspection confirms that engine-info enters
`Observer::connect`, which invokes the retained boot/config/disk audit.

| Read-only operation | Median wall ms | Median CLI CPU ms | CPU range ms |
| --- | ---: | ---: | ---: |
| Existing disk-handle `lsof` | 80.2 | 59.9 | 58.1–67.6 |
| Entire engine-info command | 131.4 | 69.7 | 66.8–85.8 |

These are separate measurements, not nested exclusive spans: their ratio is not an exact attribution
percentage for graph cleanup. They nevertheless identify a substantial subprocess cost that is
independent of Docker deletion throughput. No audit was skipped or cached, and no performance gain
from an alternative has yet been measured. [All 16 observations](disk-audit-cpu-20260915.csv) are retained.

Private evidence:

- `.hack-local/review/wu05/cleanup-crossover-1789506678292141000/`: frozen protocol, child usage,
  per-phase identities, 16 measured trials, two warmups, analyzer and cleanup/watchdog evidence.
- `.hack-local/review/wu05/audit-attribution-1789506825204015000/`: frozen audit protocol, eight
  alternating pairs, analysis and cleanup/watchdog evidence.

## Next bounded implementation

Evaluate native enumeration of the owned VM's file descriptors for the boot audit. Preserve fresh
process identity checks around observation, exact expected disk checks and fail-closed behavior on
incomplete/truncated enumeration, permission failure, disappearance or PID reuse. Bound allocations
and descriptor counts; do not weaken the separate shutdown check for handles held by other processes.
Require owned/missing-disk and identity/race controls, then matched normal-build command latency and
CLI-plus-engine CPU measurements before adoption. Native enumeration is a candidate approach, not
yet an implemented or qualified improvement.

The qualified baseline executable hash was restored and verified. The installed Hack daemon remains
running and API-compatible. No source behavior changed, so this checkpoint uses scalar/protocol,
link, privacy and whitespace checks rather than rerunning unrelated runtime suites. Resource-size
sweeps and full-application idle reclamation/recovery remain open.
