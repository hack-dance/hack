# Bounded concurrent cleanup qualification — 2026-09-15

## Decision

Keep sequential container deletion as the candidate default. Two-worker deletion improved cleanup
retaining data, but neither tested policy qualified across the lifecycle. Experimental source and
binaries remain in private evidence; no concurrency change is enabled. Existing dependency-order
scheduling, native HTTP supervision, runc caching, journal batching and reclamation defaults remain.

## Implementation and correctness

The experiment preflighted every container's ownership before deletion, held the outer mutation
lease, checked live VM identity before and after each request, and deleted validated immutable IDs
with at most two scoped workers. Every started worker was joined on failure or panic; later batches
stopped on failure. Durable cleanup intent preceded effects, and confirmed container absence preceded
network, volume, probe and environment retirement.

Two unit controls covered the concurrency bound, joining, failure and panic. Five serial live
controls passed: three native graph controls, partial cleanup with foreign-resource preflight, and
managed-environment cleanup after driver loss. The new interruption control killed the driver after
first-batch replies, before absence updates; it does not prove arbitrary in-flight transport loss.
It verified surviving resources, refused restore during cleanup intent, idempotent retry and fresh
restore. The foreign-name control refused deletion before other owned containers were removed.

The final experiment passed 155 default Rust tests and 160 with both native HTTP and environment
launcher features, plus strict Clippy in both configurations. Repository typecheck, check and test
gates passed; unchanged CLI task-cache results were reused (940 passing tests, five skips). These
checks qualify experimental correctness, not performance or release readiness. The source was
subsequently reverted to the previously qualified baseline.

## Performance evidence

Baseline: dependency-order scheduler commit `0add74a1`. Same pinned init/SQLite/web/check workload,
200 requests before and after restore, native HTTP checks, four vCPUs and 6 GiB VM memory. Each build
received an excluded warmup, followed by four sequential baseline/experiment/baseline triples.
All twelve measured trials passed workload, persistence, fresh-container, resource-limit and owned
cleanup checks. The external pressure/swap watchdog remained admitted; protected configuration
hashes matched and the VM stopped at completion. No agent builds or tests overlapped the cohort.

Final policy applied concurrency only to cleanup retaining data; full removal used the original
sequential code. Medians below compare eight baseline observations with four experimental ones.
[All 48 phase observations](cleanup-comparison-20260915.csv) are recorded separately.

| Phase | Baseline wall ms | Experiment wall ms | Baseline engine CPU ms | Experiment engine CPU ms |
| --- | ---: | ---: | ---: | ---: |
| Startup | 1210.960 | 1140.336 | 691.009 | 589.316 |
| Cleanup retaining data | 506.453 | 458.810 | 149.205 | 124.471 |
| Restore | 1189.496 | 1280.769 | 631.077 | 681.994 |
| Full removal | 488.313 | 562.197 | 130.837 | 160.751 |

Retained-data cleanup median latency fell 9.4% and engine CPU fell 16.6%; all four paired comparisons
improved (7.6–17.2% latency, 14.9–25.8% CPU). However, full-removal median latency rose 15.1% and CPU
rose 22.9%; CPU was higher in all four paired comparisons despite unchanged removal code. Restore
also moved unfavorably in aggregate. This leaves lifecycle carryover, build/order effects and other
confounders unresolved; the measurements do not establish that concurrent deletion caused every
change. They do prevent claiming a qualified overall gain.

An earlier policy made both cleanup modes concurrent. Retained-data cleanup improved in all four
pairs, but full removal worsened in all four (median 491.472 to 527.924 ms; engine CPU 130.445 to
157.871 ms). Restricting concurrency to retained-data cleanup did not resolve qualification.

CPU here measures the VM engine process, not CLI worker CPU or whole-host consumption. This small
warm cohort establishes neither tail latency nor steady memory improvements. Compose, OrbStack and
stable Hack were not remeasured; see the [integrated comparison](native-graph-performance-20260915.md)
and [historical benchmark](benchmark-20260914.md) for those separate results.

Private evidence:

- Both-mode experiment: `.hack-local/review/wu05/cleanup-aba-1789502877767784000/`.
- Retain-only experiment, source patch, worker module, protocol, hashes and analysis:
  `.hack-local/review/wu05/cleanup-aba-1789503201311900000/`.
- Final five live controls: `.hack-local/review/wu07/concurrent-cleanup-1789503108058888000/`.

## Follow-up

The [phase-isolated crossover and CLI CPU attribution](cleanup-cpu-attribution-20260915.md) are now
complete. Reversed trial order did not produce a repeatable overall concurrency win, and the
unchanged full-removal path still varied. Sequential deletion remains the default. The measured
next target is the disk-handle audit subprocess, subject to equivalent ownership/identity controls.
Resource-size sweeps and real-application automatic idle reclamation/recovery remain separate
acceptance work; these experiments do not close those broader gates.
