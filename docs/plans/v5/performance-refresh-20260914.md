# September 14 — Current candidate performance refresh

The current candidate retains its small-graph readiness advantage. It reaches readiness about 15%
faster than direct Compose and 34% faster than installed Hack 4.2.0 in this cohort. Compose still
removes the graph faster, and the candidate's tiny internal HTTP loop remains slower. These results
support continued development; they do not establish a full-application or equal-capacity winner.

## Current latency cohort

Source checkpoint: `a0ed1fc0`. All 32 measured trials and four excluded warmups passed. The eight
rounds rotate four lanes so every lane occupies each position twice. The protocol hash matches the
[earlier frozen benchmark](benchmark-20260914.md) exactly. Image configuration/rootfs, workload,
inspected container limits, persistence, new compute identities and cleanup were independently
checked. [Per-trial scalar results](benchmark-refresh-20260914.csv) retain every measured row.

Seconds, median of eight trials per lane:

| Lane | Ready + check | Restore + check | Down, retain data | Remove data |
| --- | --- | --- | --- | --- |
| Compose / OrbStack | 1.570 | 1.543 | 0.294 | 0.316 |
| Hack 4.1.1 / OrbStack | 2.014 | 2.023 | 0.803 | 0.836 |
| Hack 4.2.0 / OrbStack | 2.036 | 2.006 | 0.769 | 0.866 |
| Candidate / SmolVM | 1.338 | 1.283 | 0.578 | 0.543 |

The candidate's readiness reduction is 14.7%, 33.5% and 34.3% against the three baselines;
restore reduction is 16.9%, 36.6% and 36.1%. Candidate down takes 0.284 seconds longer than Compose.
The candidate uses forced removal with ownership/readback checks; Compose uses graceful stop.
These are end-to-end workflow measurements with different teardown semantics.

The candidate's median per-request p50 is 0.090 ms versus 0.025 ms for Compose; the median
200-request total is 21.989 ms versus 11.531 ms. This is sequential internal bridge traffic over
tiny SQLite reads, not sustained throughput, TLS, concurrency or application response time.

Candidate readiness was 1.282 seconds in the earlier cohort and is 1.338 seconds here. Eight
observations per lane across separate sessions do not isolate a code regression. Both the earlier
and current results remain available; no samples were combined or selectively discarded.

## Resource comparison

The follow-up uses a persistent native sampler with exact executable/process identity checks,
completion markers and 31 samples over each 60-second window. It observes the candidate, both
OrbStack roots and the stable daemon with all current descendants from the first sample. Exited or
reparented helpers and shared-page accounting remain limitations. CPU is percent of one core;
physical footprint is the sum of native process footprint, not configured RAM or whole-host usage.

Each engine runs the same graph twice at each health cadence, reversing engine order on the
repeat. The frequent setting is 100 ms. The alternative explicitly requests 100 ms startup checks
and 1-second steady checks. Slower steady checks trade later failure detection for less probe work;
no user defaults were changed. Windows observe an otherwise idle web service after the correctness
probe, rather than a sustained application load. The safety watchdog remains separate from the
persistent sampler and its overhead is not counted as resident runtime cost.

All nine windows completed: one empty-pool observation and eight graph windows, with two
observations per engine/cadence. CPU below is the mean of those two windows, followed by their
range. Footprint is the range of the two per-window medians. [Component scalar results](resources-refresh-20260914.csv)
include inactive engines, the stable daemon and the sampler separately.

| Setting | Candidate CPU, one core | OrbStack CPU, one core | Candidate footprint | OrbStack footprint |
| --- | --- | --- | --- | --- |
| Empty pools, one window | 0.41% | 0.93% | 611 MiB | 2617 MiB |
| 100 ms steady checks | 48.90% (47.80–50.00) | 37.41% (36.34–38.48) | 905–946 MiB | 2890–2965 MiB |
| 1 s steady checks | 10.41% (10.37–10.46) | 6.95% (6.94–6.96) | 908–952 MiB | 2771–2831 MiB |

The cadence change reduces CPU by 78.7% for the candidate and 81.4% for OrbStack. It is available
to both and is not an exclusive candidate advantage. Candidate CPU remains about 31% higher at
100 ms and 50% higher at 1 second. These measurements identify an optimization target; they do
not isolate container execution, engine scheduling and virtualization costs. Two windows per cell
are a repeatability check, not a statistical tail estimate or proof of a memory leak.

The empty-pool observation is a warm 60-second window, not a new ten-minute floor test. After
the candidate's final graph/data cleanup, its inactive pool still occupied about 952 MiB during
the last Compose window, compared with 611 MiB initially; CPU returned to about 0.43% of one core.
Stopping the VM removed its owned process footprint. This does not prove filesystem-cache
reclamation, and the observed retention alone does not establish a leak.

The stable daemon is separate from the engine totals. Its observed footprint spans 77–83 MiB;
valid windows show 0.50–2.60% of one core. One candidate/frequent window captured an additional
short-lived zellij child. That window's daemon CPU total is deliberately unavailable because its
process identities changed. Its snapshots and footprint remain in the data; engine identities
were unchanged in every window. Complete sampled trees do not account for all exited helpers.

The persistent sampler uses 0.032–0.051% of one core and roughly 1.9–2.0 MiB. The separate safety
observer uses approximately 0.99–1.72% of one core in these windows. This collection therefore
still has material instrumentation cost relative to empty-pool CPU. No observer cost is presented
as resident candidate overhead or subtracted from an engine's measured counters.

The development candidate has 4 vCPUs and 6 GiB configured RAM. Current OrbStack reports 16 CPUs
and 73,705,746,432 bytes of engine memory, with its broader UI/helper functionality. Both run Linux
arm64 Docker engines. This compares the user's existing setups, not matched hypervisor capacity.

## Evidence and open gates

Latency evidence: `.hack-local/review/wu05/benchmark-1789435857497477000/`, including the frozen
protocol, raw trials, image equivalence, executable hashes, independent verification and cleanup.
All 90 watchdog samples had normal pressure and unchanged swapout counters. Peak sampled candidate
footprint was 912.2 MiB. Discovery was paused through the supported daemon command during the
latency cohort and restored afterward with a compatible API. The initial wrapper refused an
unsupported `--json` flag before any daemon change or measured trial; that attempt is retained.

Resource evidence: `.hack-local/review/wu05/matched-resources-1789436073725091000/`, including
279 native samples, completion markers, exact commands, hashes, all eight graph/persistence
receipts, analysis and the identified daemon-CPU omission. All 301 watchdog samples had normal
pressure and unchanged swapout counters. Owned fixture resources were removed, protected inputs
matched, and the candidate VM stopped. The stable daemon remains running with a compatible API.
The updated sampler comparison closes the selected-descendant measurement gap at sample times;
transient-helper CPU accounting remains open.

The fresh Event Agent plan still has 14 services and 22 errors: 12 unresolved mount sources,
nine external route/owner-label conflicts and one external network, plus two metadata warnings.
Application startup, reload and real credential delivery remain blocked or unexercised; no such
execution was attempted through these incompatible plan gates.

The recent managed-delivery and seven driver-SIGKILL controls qualify component behavior. This
benchmark runs the ordinary synthetic graph without managed credentials. Native provider/CLI
integration, retired-intent pruning, in-place restart, real application startup/reload/load,
durable terminals, Linux/SSH parity and packaging remain open. Lower small-graph footprint cannot
substitute for those gates or prove that the fourteen-service application fits the bounded profile.
