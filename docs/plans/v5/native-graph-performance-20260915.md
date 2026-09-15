# Integrated native HTTP graph performance — September 15

The native HTTP graph path uses 84.8–85.5% less gross engine CPU and 68.5–68.6% less physical
footprint than the normal Compose command-health path in this bounded M3 comparison. This is the
first measurement of the integrated native implementation, distinct from the earlier persistent-Bun
diagnostic. It qualifies this HTTP-check workload on this host, not every application or runtime.

## Protocol and acceptance

Private evidence: `.hack-local/review/wu05/native-graph-health-1789499916367078000/`.
The directory retains the frozen protocol, binary/sampler hashes, process identities and counters,
application reports, configuration checks, phase timings, watchdog and independent analysis.
`integrated-summary.json` and `native-summary.json` are derived from those raw records.

The same pinned ARM64 Bun image configuration/rootfs and init → SQLite/web → 200-request check
workload run with 0.5 CPU, 256 MiB memory, 64 PIDs, read-only rootfs and 64 MiB shared-memory limits
per container. Candidate native HTTP and Compose CMD/Bun HTTP both target `/health`, with one-second
interval, 500 ms timeout and three failures. The native path adds its owned 64 KiB status tmpfs.
Candidate command health is explicitly `NONE`; native graph health and Compose engine health both
verify healthy. This compares the intended resident-probe implementation with the existing command
implementation, not two identical probe processes.

One empty-pools window precedes four 60-second windows in candidate, Compose, Compose, candidate
order. Each has 31 native samples, stable engine process identities, and no overlapping builds or
tests. A native sampler and an external watchdog are measured separately. Both engines remain
running; only one lane has the application workload. Gross engine CPU includes background engine
activity and is not baseline-subtracted. The candidate has 4 vCPUs/6 GiB; OrbStack reports 16
vCPUs/68.6 GiB. This capacity difference and background activity limit generalization.

The application records each health request. Counter reads bracket sampling and may include boundary
requests. Native completes 60 checks per bracket, Compose 58; median intervals are 1003–1004 ms
and 1049–1050 ms respectively. These are equal configured cadence, not exact equal-work windows.
Initial probe launch and exit are outside steady-state CPU windows; graph phase timings include
startup/readiness and cleanup separately. No isolated HTTP latency improvement is claimed.

All four trials complete the 200-request workload, preserve the database token on restore, use fresh
container IDs, and remove owned resources. Candidate graph receipts are archived. All 178 watchdog
samples show normal memory pressure and unchanged swapouts. Protected inputs match and the candidate
VM is stopped; the installed Hack daemon remains running and API-compatible.

## Results

CPU percentage uses one full core as 100%. Footprint is the median sum of native physical footprints
for the candidate VM process or the two OrbStack engine processes, not a whole-host memory total.

| Trial | Engine CPU seconds / 60 s | CPU, one core | Physical footprint | Observed health checks |
| --- | ---: | ---: | ---: | ---: |
| Candidate first | 0.533 | 0.888% | 847.0 MiB | 60 |
| Compose first | 3.681 | 6.134% | 2685.8 MiB | 58 |
| Compose reverse | 3.987 | 6.644% | 2750.7 MiB | 58 |
| Candidate reverse | 0.607 | 1.012% | 863.3 MiB | 60 |

The paired CPU reductions are 85.5% and 84.8%; footprint reductions are 68.5% and 68.6%.
Empty-pools CPU was 0.430% for candidate and 0.969% for OrbStack, with 632.3 and 2469.1 MiB
footprints. Background CPU varies between windows, so subtracting one idle sample would overstate
precision. The stable Hack daemon is separate: 0.47–1.16% CPU during workload windows and about
85 MiB footprint. Sampler CPU is 0.037–0.053% with about 2 MiB footprint.

| Graph phase | Candidate, two trials | Compose, two trials |
| --- | ---: | ---: |
| Startup through completed workload | 1.274–1.302 s | 2.540–2.658 s |
| Restore through completed workload | 1.206–1.317 s | 2.553–2.570 s |
| Cleanup retaining data | 0.433–0.472 s | 0.344–0.366 s |
| Cleanup removing data | 0.452–0.473 s | 0.312–0.313 s |

Startup/restore are faster in these two observations, while cleanup is slower. These phase samples
are too few for a general startup or cleanup regression budget. Application response medians vary:
candidate 0.046–0.093 ms, Compose 0.024–0.057 ms across initial and restored runs. CPU/footprint
improvements do not establish an application latency win.

## Defaults and next work

The private build includes the native supervisor. Projects select it through the explicit
[`healthcheck.x-hack-http` declaration](native-http-probe-20260915.md); existing command checks keep
their semantics. Pinned runc caching, cleanup batching and recorded memory reclamation remain enabled.
No Docker/containerd replacement is needed for this measured improvement. The result is consistent
with avoiding repeated health-command process launches, though this comparison does not isolate
every component of the runtime difference.

[Launch/cleanup profiling](graph-phase-profile-20260915.md) is complete and includes a normal-build
lifecycle CPU cohort. [Dependency-ordered scheduling](dependency-scheduler-20260915.md) is also
qualified for lower startup/restore latency with essentially flat median CPU. Next units are bounded concurrent cleanup,
vCPU and memory sweeps with the same workload,
and automatic ten-minute idle reclamation with real-application recovery. The full Event Agent
compatibility and acceptance gates remain open. Historical Hack 4.1.1/4.2.0 comparisons remain in
[the earlier benchmark](benchmark-20260914.md); those versions were not remeasured here.
