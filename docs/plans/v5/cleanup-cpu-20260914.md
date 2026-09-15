# September 14 — Cleanup journal batching and CPU attribution

The final candidate reaches readiness 25% sooner than Compose in the frozen fixture. Guest-local
execution reduced host CPU by 13.5% in an A/B/A control. The final build retains lower observed
engine footprint, but Compose/OrbStack still has lower graph CPU and faster teardown.

Graph cleanup now commits its complete cleanup intent before removing resources, then commits the
final receipt after absence checks and environment-slot retirement. It no longer synchronizes the
entire receipt after each individual removal. Interrupted cleanup still requires reinspection;
it cannot replay the service. The three-container fixture drops from six durable commits to two
for retained-data cleanup, and from seven to two for full removal.

## Recovery and retention

The new live control kills the cleanup driver after container deletion and before any absence
update reaches the journal. It verifies that the durable receipt still says `cleanup-intent` with
a `started` container, the actual container is absent, and the environment slot remains mounted.
Fresh restore is refused until explicit cleanup retires that slot. Repeated cleanup, fresh delivery,
restore and final removal all pass. The existing seven startup/restore SIGKILL boundaries also pass.

All ten live controls passed, including attachment recovery, allocation-pressure cleanup and
prior-boot retirement. The first run passed the new control but reached the existing 64-attempt
active-journal limit during the older crash suite. Supported `graph archive` moved 64 fully removed
attempts after ownership and absence checks; evidence and reserved IDs remain retained. The full
retry passed. This addresses active admission pressure, not retired-environment-intent pruning or
the archive's separate 256-attempt limit.

Live evidence: `.hack-local/review/wu07/cleanup-batching-1789437919807410000/`; the earlier refusal
is retained in `cleanup-batching-1789437823974834000/`. All 65 retry watchdog samples had normal
pressure and unchanged swapouts. The owned VM stopped and protected inputs matched.

## Cleanup-only latency comparison

Source: `f54c130a` plus this checkpoint's cleanup batching change. The release executable hash is
retained with the measurement. All 32 measured trials and four excluded warmups passed the same
frozen protocol as the [previous refresh](performance-refresh-20260914.md). Independent checks
verify identical image/workload/settings, persistent tokens, fresh compute identities and cleanup.
[All measured scalar rows](cleanup-benchmark-20260914.csv) are retained.

Seconds, median of eight rotated trials per lane:

| Lane | Ready + check | Restore + check | Down, retain data | Remove data |
| --- | --- | --- | --- | --- |
| Compose / OrbStack | 1.628 | 1.594 | 0.312 | 0.320 |
| Hack 4.1.1 / OrbStack | 2.080 | 2.090 | 0.788 | 0.845 |
| Hack 4.2.0 / OrbStack | 2.078 | 2.084 | 0.762 | 0.867 |
| Candidate / SmolVM | 1.358 | 1.304 | 0.510 | 0.504 |

Candidate down improved from 0.578 to 0.510 seconds (11.8%) and removal from 0.543 to 0.504 seconds
(7.2%) compared with the preceding cohort. These are separate sessions, not an interleaved old/new
binary experiment; the reduced commit count is established, while the precise latency effect still
includes session variation. Compose remains faster at cleanup. Candidate readiness remains faster
than all three baselines. Its sequential internal HTTP probe remains slower: median per-trial p50
0.093 ms versus Compose's 0.026 ms, and 200-request totals 22.395 versus 12.300 ms.

Latency evidence: `.hack-local/review/wu05/benchmark-1789438057273905000/`. The supported global
daemon pause was restored with a running, compatible status. This is a bounded synthetic graph,
not full-application throughput or equivalent teardown semantics: candidate removal is forced,
while Compose stops gracefully.

## CPU attribution pilot

An initial pilot added web-container cgroup CPU counters around the same native 60-second windows.
One candidate and one Compose observation at the requested 100 ms health cadence produced:

| Component | Candidate | Compose / OrbStack |
| --- | --- | --- |
| Host engine CPU, percent of one core | 48.36% | 36.44% |
| Web cgroup CPU, percent of one core | 11.38% | 23.04% |
| Host engine physical footprint, window median | 887 MiB | 2861 MiB |

The cgroup and host counters bracket slightly different intervals and measure different scopes.
Their difference must not be presented as an exact virtualization cost. Identical requested cadence
also does not imply identical completed probe counts. This pilot confirms that container CPU alone
cannot explain the candidate's higher host CPU; guest engine work and virtualization need further
attribution. It does not establish a CPU improvement from journal batching, which runs only during
cleanup.

Evidence: `.hack-local/review/wu05/cpu-breakdown-1789437264035814000/`. Three native windows
completed: one empty-pool window and two graph windows. The inherited metadata description mentions
eight graph windows; the frozen protocol and actual samples contain two. Analysis uses the actual
three completed windows. Protected inputs matched and the owned VM stopped.

## Guest-local execution experiment

The next pilot changed only where the identical pinned `runc` bytes were executed. It measured an
original/shared-file window, a guest-tmpfs window, and a restored-original window, followed by
Compose. The read-only executable bind was hash-verified before and after restoration. Health
configuration, workload, image and inspected resource limits remained identical; persistence,
new compute identities and complete fixture cleanup passed for every lane.

| Window | Host engine CPU, one core | Host engine footprint |
| --- | --- | --- |
| Candidate, original shared file | 47.84% | 888 MiB |
| Candidate, verified guest-local file | 42.58% | 976 MiB |
| Candidate, original restored | 50.60% | 987 MiB |
| Compose / OrbStack | 38.39% | 2889 MiB |

The local-file window used 13.5% less host CPU than the mean of the two original-file controls,
and remained 10.9% above Compose. This is one A/B/A experiment, not a tail estimate. Requested
cadence is fixed; completed probes are not counted, so no per-probe saving is claimed. Web cgroup
CPU increased from about 11.4% to 15.1% in the local-file window while host CPU fell. Guest counters
and separate ten-second host stack samples are retained for attribution; blocked-thread stack
counts are not CPU percentages.

Footprint grew across the candidate windows and did not fall when the original file was restored.
The sequence therefore cannot isolate the cache's exact memory cost. Its bounded storage and a
fresh-boot implementation measurement are required before interpreting that difference.

Evidence: `.hack-local/review/wu05/cpu-runc-cache-1789438266467386000/`, including five complete
native windows, four graph receipts, cache-enable/disable acknowledgements, identical executable
hashes, guest counters, host profiles and independent verification. All 191 watchdog samples had
normal pressure and unchanged swapouts. Daemon CPU is omitted for the empty-pool and restored-file
windows because their descendant identities changed; engine identities remained stable. The
original executable view was restored, protected inputs matched, and the owned VM stopped.

The candidate implementation now provisions that cache before starting the engine. The source
artifact remains the pinned host copy. A new private 32 MiB tmpfs holds the verified 16.1 MiB `runc`
file, and both its directory mount and exposed executable bind are read-only. Wrong hashes,
preexisting cache state, unexpected mounts and failed publication refuse engine startup. Failed
setup is retained for owned VM teardown rather than repaired in place. No installed global runtime,
health-check command or health cadence is changed.

## Implementation verification

Both feature-enabled and default Rust suites pass all 147 ordinary tests and strict Clippy.
Repository typecheck, lint, 940 CLI tests (five unsupported integration skips) and the privacy check
pass. The guest script passes shell syntax validation. Eleven live controls pass with the final
cache-enabled release build, including digest/replacement refusal, actual read-only open refusal,
the 32 MiB filesystem cap, all eight driver-kill boundaries and recovery after VM restart.

Live implementation evidence: `.hack-local/review/wu07/runc-cache-1789438830886759000/`. All 68
watchdog samples had normal pressure and unchanged swapouts. Twelve more fully removed attempts
were archived through the supported command; no evidence was deleted. The owned VM stopped and
protected inputs matched. These controls qualify the development-profile implementation, not a
release, native credential provider or full application migration.


## Final-build latency comparison

The cache-enabled release repeats all 32 measured trials and four excluded warmups with the same
frozen protocol. All correctness and independent verification checks pass. This is the final
implementation, including both cleanup batching and guest-local `runc`.
[All final-build latency rows](cached-benchmark-20260914.csv) are retained.

Seconds, median of eight rotated trials per lane:

| Lane | Ready + check | Restore + check | Down, retain data | Remove data |
| --- | --- | --- | --- | --- |
| Compose / OrbStack | 1.624 | 1.596 | 0.314 | 0.323 |
| Hack 4.1.1 / OrbStack | 2.066 | 2.080 | 0.780 | 0.880 |
| Hack 4.2.0 / OrbStack | 2.083 | 2.099 | 0.792 | 0.879 |
| Candidate / SmolVM | 1.217 | 1.197 | 0.454 | 0.471 |

Candidate readiness takes 25.0% less time than Compose, 41.1% less than Hack 4.1.1 and 41.6% less
than Hack 4.2.0. Against the preceding unoptimized candidate cohort, down improves from 0.578 to
0.454 seconds (21.5%) and removal from 0.543 to 0.471 seconds (13.3%). Those before/after figures
span separate cohorts. Compose still cleans up faster. The small sequential HTTP probe remains
slower: candidate p50 0.093 ms and 200-request total 21.738 ms, versus Compose's 0.026 ms and
11.988 ms. These changes do not close the application-load or network-latency gates.

Evidence: `.hack-local/review/wu05/benchmark-1789438990764032000/`, including the exact release
executable hash. All 90 watchdog samples had normal pressure and unchanged swapouts. The owned VM
stopped, protected inputs matched, and the supported daemon pause was restored with a running,
compatible status before resource sampling began.


## Final-build resource comparison

The final release build completed five native windows: one empty-pool window and four graph
windows, each with 31 samples over 60 seconds. There is one observation per engine/cadence;
engine order reverses between the frequent and slow settings. All four graph correctness,
persistence, resource-equivalence and cleanup checks pass. [Component scalar rows](cached-resources-20260914.csv)
retain inactive engines, the stable daemon and observer separately.

| Setting | Candidate CPU, one core | OrbStack CPU, one core | Candidate footprint | OrbStack footprint |
| --- | --- | --- | --- | --- |
| Empty pools | 0.39% | 0.86% | 629 MiB | 2632 MiB |
| 100 ms steady checks | 41.84% | 36.38% | 941 MiB | 2924 MiB |
| 1 s steady checks | 9.18% | 6.76% | 952 MiB | 2907 MiB |

The final frequent-check observation is consistent with the controlled cache reduction, but remains
15.0% above OrbStack CPU. The slow-check observation remains 35.8% above OrbStack. Lowering cadence
reduces both engines' CPU and still trades slower detection for less checking; no default changed.
The candidate's active-engine footprint is about 67–68% lower here. This is summed native physical
footprint of selected process trees, not configured memory, unique whole-host pages or application
memory. The candidate has 4 vCPUs/6 GiB configured; OrbStack reports 16 CPUs/about 68.6 GiB.

The inactive candidate remained around 951 MiB and 0.39–0.44% CPU during the Compose windows.
Graph removal does not reclaim the entire warm VM footprint; pool stop removes the owned process.
Initial empty-pool footprint was 629 MiB versus 611 MiB in the preceding uncached refresh, but
separate-session measurements cannot isolate an exact cache-memory delta. The new cache holds
16.1 MiB of executable bytes within its verified 32 MiB filesystem cap.

All sampled engine and daemon descendant identities remained stable in this cohort. The daemon
used 0.49–2.10% of one core during graph windows and 79–82 MiB; it is separate from engine totals.
The persistent sampler used 0.034–0.048% of one core and about 2 MiB. The additional safety watchdog
remains separate; selected snapshots do not account for every exited or reparented helper.

Evidence: `.hack-local/review/wu05/cached-resources-1789439190720434000/`, including 155 native
samples, four graph receipts, frozen protocol, binary hashes, independent verification and all
175 normal-pressure watchdog samples with unchanged swapouts. Protected inputs matched and the
owned VM stopped. The release hash matches the final latency build.

## Remaining work

- Count completed health probes and attribute cumulative guest/runtime-helper CPU before tuning
  the remaining engine/virtualization cost. Matching requested intervals alone is insufficient
  for a per-probe comparison. The lower-than-OrbStack CPU goal remains open.
- Add verified retirement/export/pruning for environment intents and continued archive retention,
  preserving consumed IDs, interrupted-cleanup recovery and replay refusal. Archival frees active
  slots but does not delete evidence or retire every retention obligation.
- Qualify memory reclamation without interrupting active work or losing persistent data, and
  measure full-application load, network latency and transient helpers. Native credential delivery,
  application compatibility, Linux parity and release packaging retain their existing gates.
