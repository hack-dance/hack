# Graph launch and cleanup profiling — September 15

The remaining cleanup delay is concentrated in engine container/network deletion, not ownership
verification. Normal-build lifecycle measurements also show lower candidate engine CPU despite
longer cleanup wall time. The next targeted experiment is to avoid unnecessary scheduler sleep
after dependency progress, then evaluate bounded concurrent container deletion. Neither change is
implemented or qualified by this profiling unit.

## Evidence and scope

Source baseline: `5583c405`. A private copy of the Rust crate added nested, fixed-label timing spans
around engine requests, ownership verification, guest execution, journal writes and graph phases.
It logged no request paths, IDs, arguments or payloads. The diagnostic executable occupied only the
checkout's candidate build path during its run; a finally block restored the qualified executable.
Its SHA-256 matches the binary from the preceding integrated native HTTP benchmark.

- Diagnostic evidence: `.hack-local/review/wu05/graph-phase-profile-1789500616691535000/`.
  Frozen harness, instrumentation preparation script, source manifest and analysis are retained.
- Normal-build evidence: `.hack-local/review/wu05/graph-lifecycle-cpu-1789500720230802000/`.
  Frozen harness, raw calls/counters, independent analysis and protected-input comparisons remain.
- [Normal-build scalar observations](graph-lifecycle-cpu-20260915.csv) contain all 32 phase rows.

Each cohort has four candidate and four Compose trials in C/O, O/C, C/O, O/C order. They use the
same pinned ARM64 image configuration/rootfs, business workload, container limits and native-versus-CMD
HTTP checks as the [integrated comparison](native-graph-performance-20260915.md). Each startup and
restore completes 200 application requests, preserves the database token, uses fresh container IDs,
and verifies cleanup. There are no steady-state sampling windows in this study.

Native process CPU counters bracket each whole phase, including readiness inspection. They measure
gross engine CPU, not CLI CPU or isolated container cost. Engine identities remain stable. The
candidate has 4 vCPUs/6 GiB while OrbStack reports 16 vCPUs/68.6 GiB. Candidate cleanup force-removes
owned containers; Compose stops gracefully. These semantic and capacity differences limit claims.
Both engines stay running, and the installed daemon remains active throughout. No builds or tests
run alongside either cohort.

Both cohorts pass all eight trials, effective resource/image checks, data/identity checks and owned
cleanup. Each has 30 watchdog samples with normal memory pressure and unchanged swapouts. Protected
inputs match; both owned VM runs end stopped. Diagnostic timings include observer overhead and are
used for attribution, not as improvement measurements.

## Normal-build lifecycle results

Medians of four trials per lane. Wall time includes the harness's readiness inspection; it is not
just the CLI subprocess duration. CPU is total native engine CPU consumed over that phase.

| Phase | Candidate wall | Compose wall | Candidate CPU | Compose CPU | Candidate CPU reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| Startup + completed workload | 1.308 s | 2.657 s | 0.639 CPU-s | 1.237 CPU-s | 48% |
| Restore + completed workload | 1.321 s | 2.591 s | 0.613 CPU-s | 1.163 CPU-s | 47% |
| Cleanup retaining data | 0.496 s | 0.330 s | 0.128 CPU-s | 0.279 CPU-s | 54% |
| Cleanup removing data | 0.450 s | 0.311 s | 0.118 CPU-s | 0.297 CPU-s | 60% |

Longer elapsed cleanup does not imply higher CPU. These phase results extend the earlier
steady-state HTTP result; they are not a new optimization gain versus the previous candidate.
Four trials do not establish tail latency or universal platform superiority.

## Where time goes

The diagnostic analysis subtracts direct child spans to avoid double counting nested operations.
The table gives median exclusive durations inside the candidate cleanup command. Medians across
categories do not necessarily sum to the median command duration.

| Cleanup component | Retain data | Remove data |
| --- | ---: | ---: |
| Three container DELETE requests | 137 ms | 137 ms |
| Network DELETE request | 120 ms | 112 ms |
| Engine connection/setup, excluding instrumented children | 67 ms | 69 ms |
| Guest probe-storage cleanup, excluding nested ownership checks | 39 ms | 34 ms |
| Two durable journal writes | 19 ms | 20 ms |
| Ownership verification across the command | 5 ms | 6 ms |
| Whole cleanup CLI command | 406 ms | 411 ms |

Ownership checks are a small share of cleanup; removing them would trade correctness for little
benefit. The two journal commits retain their crash-recovery purpose. Engine connection setup
includes the retained boot/config/disk audit; source inspection shows an `lsof` invocation, but
its isolated duration was not measured here. Reusing a connection would need a design that retains
fresh ownership and boot checks, not merely a cached assertion.

Startup's main measured components are three container starts (299 ms), 23 journal writes
(215 ms), engine setup (96 ms), and about 57 ms each in native probe exec start and guest execution.
Restore has 289 ms in container starts and 200 ms across 22 journal writes. Unattributed exclusive
graph time is 323 ms for startup and 220 ms for restore; it includes scheduling and other graph
work, so it must not all be labeled idle waiting.

## Next bounded experiments

1. **Progress-aware readiness scheduling.** The current executor sleeps 100 ms at the end of each
   unfinished pass, even when starting a service has unblocked a dependency earlier in lexical order.
   Evaluate an immediate next pass only after bounded progress, retaining backoff when waiting.
   Require tests for dependency ordering, failed/uncertain starts, deadlines and no busy polling;
   qualify normal binary A/B/A latency and CPU before retaining a change.
2. **Bounded concurrent container cleanup.** Container deletes currently run sequentially. Evaluate
   a small bounded batch after complete durable cleanup intent and ownership checks. Network/volume
   removal must wait for confirmed container absence. Require interruption and partial-failure
   controls, preserved receipts, idempotent cleanup and matched CPU/latency evidence.
3. **Separate connection and journal work only if needed.** Profile the boot audit and individual
   commit boundaries before proposing reuse or fewer commits. Do not relax ownership or durability
   based on aggregate timings.

Existing runc caching, cleanup batching, reclamation policy and explicit native HTTP defaults are
unchanged. vCPU/memory sweeps and full-application idle reclamation/recovery remain separate open units.
