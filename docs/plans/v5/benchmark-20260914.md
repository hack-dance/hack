# September 14, 2026 — Warm graph benchmark and follow-up review

The candidate reaches a usable small graph faster in this cohort, but direct Compose tears it
down faster and its internal HTTP probe has lower latency. This supports continuing the candidate;
it does not establish a full application, whole-host memory, or provider winner.

All 32 measured trials passed: eight per lane, one excluded warmup per lane, and rotated order
so every lane occupies each position twice. No measured sample in this corrected cohort was dropped.
The source under test is `fceb3a2fa96a841a6e484e65d9258d18ca623031` with its release binary; subsequent report edits
change documentation only. [Per-trial measurements](benchmark-20260914.csv) preserve the ranges.

## Results

Seconds, median with observed minimum–maximum; eight observations per cell. These are descriptive
results from one short host session, not confidence bounds or a population-level tail estimate.

| Lane | Fresh ready + check | Down, retain data | Restore + check | Remove data |
| --- | --- | --- | --- | --- |
| Docker Compose / OrbStack | 1.550 (1.492–1.603) | 0.282 (0.274–0.320) | 1.540 (1.512–1.586) | 0.275 (0.259–0.366) |
| Hack 4.1.1 / OrbStack | 2.162 (1.962–2.388) | 0.835 (0.793–1.345) | 2.250 (2.222–2.314) | 0.926 (0.758–0.966) |
| Hack 4.2.0 / OrbStack | 2.217 (2.127–2.604) | 0.843 (0.679–0.927) | 2.237 (1.963–2.342) | 0.882 (0.687–1.407) |
| V5 candidate / SmolVM | 1.282 (1.254–1.328) | 0.529 (0.450–0.584) | 1.291 (1.262–1.373) | 0.514 (0.482–0.604) |

Candidate fresh readiness is 17.3% lower than Compose, 40.7% lower than 4.1.1, and 42.2% lower
than 4.2.0 by ratio of medians. Restore is 16.1%, 42.6%, and 42.3% lower respectively. The two
stable versions are broadly similar here; this sample does not establish a meaningful release
regression. Candidate teardown takes about 0.25 seconds longer than direct Compose. Its driver
currently uses forced container removal, while Compose uses graceful stop; teardown semantics
and inspection work differ, so these numbers are workflow timings rather than equivalent stop APIs.

The HTTP probe below is the median of each fresh trial's reported per-request p50/p95 and its
200-request total, in milliseconds. It is sequential, internal bridge traffic and tiny SQLite
reads, with no concurrency, TLS or sustained load. Do not reinterpret it as saturated throughput.

| Lane | Request p50 | Request p95 | 200-request total |
| --- | --- | --- | --- |
| Docker Compose / OrbStack | 0.027 | 0.086 | 12.311 |
| Hack 4.1.1 / OrbStack | 0.024 | 0.077 | 11.137 |
| Hack 4.2.0 / OrbStack | 0.024 | 0.070 | 10.567 |
| V5 candidate / SmolVM | 0.081 | 0.107 | 20.786 |

The candidate's small HTTP loop is slower despite its faster end-to-end readiness. Engine/network
and VM configuration differ; this does not isolate the cause. Real application load and reload
remain required before changing the provider decision.

## Frozen protocol and comparability

- Host: Apple M3 Max, 128 GiB RAM, macOS 26.2 (25C56). No concurrent builds or application workloads
  were started during measurement. OrbStack had no running containers between trials.
- Baselines use the current OrbStack setup: Docker 29.4.0, Compose 5.1.2, 16 reported CPUs and
  73,705,746,432 bytes reported engine memory. Candidate uses the owned development SmolVM pool,
  4 vCPUs / 6 GiB, Docker 29.5.2, API 1.54. Both engines are Linux arm64. These are the actual
  end-to-end configurations, not a controlled comparison of just the CLI or just the hypervisor.
  The candidate also uses Docker internally.
- Same preloaded Bun 1.3.14 image archive, verified identical image configuration and rootfs layer
  diff IDs across engines. OrbStack reports a manifest descriptor ID while the candidate reports
  the archive configuration ID; those IDs are intentionally different. No pull or build is timed.
- Same init/SQLite/web/check commands and common workload digest
  `0322dd066328593edd662a19a3bea882d2c214598662e09a73417bb47827a29c`. Init inserts a random token only if absent; web reads the
  database; check validates 200 HTTP responses. Every restore used new container IDs and retained
  the original token. Init completion and web health precede check execution.
- Every container: 0.5 CPU, 256 MiB RAM, 64 PIDs, read-only root, 64 MiB shared memory,
  16 MiB `/tmp` with noexec/nosuid, all capabilities dropped, no-new-privileges, and bounded
  1 MiB / one-file JSON logs. Actual inspected settings match across every service and phase.
  Private bridge and named data volume; no host ports, routing/TLS, source mount or secrets.
- Stable/Compose fixtures label check `hack.service.one-shot=true`; candidate declares
  `check=completed`. This is an explicit completion contract, not a change to application work.
- Timed phases start at CLI invocation and include readiness/resource inspection; ready includes
  the complete 200-request check. Down retains data; restore repeats readiness with existing data;
  remove confirms absence. Stable uses `hack up/down`; its explicit data-removal phase also checks
  ownership and removes the exact fixture volume through Docker. Compose uses `up/down/down -v`.
  Candidate uses graph run/cleanup/restore/cleanup-remove-data. Archival and saving evidence occur
  outside timing. Planning, engine boot and image loading are excluded.
- Engine pools remain warm across the cohort. Eight rotated rounds balance order but do not erase
  cache effects. There is no cold-engine, first-install, source edit, full build, terminal or remote
  comparison in this report.

## Correctness, cleanup and resource evidence

The independent post-run audit verifies all 32 rows, four excluded warmups, one common workload
hash, identical inspected settings, changed compute IDs, unchanged database tokens, frozen protocol
hash, and successful cleanup. All owned containers, networks and volumes are absent; the candidate
VM is stopped with no live provider process. No benchmark project registrations remain.

The 2-second watchdog recorded 94 observations, normal memory pressure throughout and unchanged
swapout counters. Peak sampled owned-provider physical footprint was
958,744,280 bytes
(914.3 MiB).
This is not a ten-minute idle floor or a matched memory comparison with shared OrbStack.
Captured application inputs and global configuration hashes are unchanged. Global registry identities
and configuration are unchanged; normal `lastSeenAt` observation timestamps changed. Raw registry
snapshots are retained privately, and only fixture-owned stale registrations were pruned.

The final raw evidence directory is `.hack-local/review/wu05/benchmark-1789414107167633000/`:
`protocol.py`, `metadata.json`, `image-equivalence.json`, `samples.json`, `warmups.json`,
`calls.json`, `watchdog.json`, `protected-comparison.json`, `final-status.json`, and `verified.json`.
The frozen protocol SHA-256 is `ebdb15e34e28a938ad6ab603906bee4d38f3b1386ab12aa648051524c9b06fb0`.
Reproduction requires the same prepared VM/image assets and fresh bounded host admission; substituting
an arbitrary tagged image is not a reproduction. Private host paths and inventories stay out of Git.

Image archive SHA-256: `74bb8d8c567eb02d5019ac0117efff81571c67d66899e6ad9b6c6cdf74d5dbfe`.
- Preserved Hack 4.1.1 executable: `88dcd63068f80a6acf48ca7c788d0899ee49a999df97029607776a28b1314fed`.
- Installed Hack 4.2.0 executable: `c7bb2abba1548478e523981cd596d47b8a26811aa38530bd616cdb08a5b655e3`.
- Candidate release executable: `4baced37aa74b548c328606db7e2f32f0bfa6d4ca0b53cb80c18f80ba33f90dd`.

## Excluded attempts and new findings

Pilots exposed an image descriptor/configuration-ID distinction, a source/state overlap rejection,
and OrbStack's much larger default shared-memory allocation. The final protocol verifies image
content, uses external owned fixtures, and explicitly matches shared memory. Global discovery can
register visible fixture projects even with isolated CLI homes; cleanup verifies ownership, retains
fixture evidence under a renamed path, and prunes only stale fixture registrations. Registry auditing
compares all fields except `lastSeenAt`, with full private snapshots retained.

An earlier cohort, `benchmark-1789413770609815000`, completed 30 trials before 4.1.1 returned
`E_STARTUP_INCOMPLETE` for check. That fixture lacked the supported one-shot label. The original
failure's container exit state/logs were not captured before removal, so the exact cause remains
unproven; no stable-product defect is claimed. A diagnostic repeat,
`benchmark-1789414023439510000`, was intentionally interrupted once the declaration gap was found.
Failure capture and cleanup were strengthened; the final fresh cohort uses explicit completion
semantics in all lanes. Neither earlier attempt contributes timings to the final table. Their
artifacts remain, including the failure and deliberate interruption.

## Follow-ups completed and remaining work

The graph retention follow-ups are implemented: explicit pending-export reconciliation, verified
archive pruning after durable consumed-ID publication, interrupted consumed-ID publication recovery,
idempotent pruning, retained exports and replay refusal. The live suite also kills the owned VM
abruptly and verifies committed database data after explicit recovery, in addition to five graph
client SIGKILL boundaries. Physical host power loss/torn filesystem writes are not qualified.

Validation: 118 Rust tests pass (13 opt-in tests excluded from the ordinary suite), plus the bounded
live controls in `live-1789412593555594000`, release build, rustfmt, all-target clippy and CLI reference
generation. The existing TypeScript typecheck/check/test gates passed earlier on unchanged TypeScript;
this follow-up does not add TypeScript behavior. Privacy and document/link checks cover this report.
This is local evidence, not a claim that hosted CI, packaging or release qualification has completed.

Global Hack was updated through its existing Homebrew installation to 4.2.0. The original 4.1.1
keg/executable is preserved privately for this comparison. After measurement, supported daemon start
repaired its stale launchd executable path to the installed binary; the running daemon is reachable,
API-compatible and verified at 4.2.0. The v5 candidate remains checkout-local and is not installed.

| Work unit | Review outcome / next acceptance gate |
| --- | --- |
| WU01–04 | Foundation and bounded runtime/job components implemented; application execution gates remain distinct. |
| WU05–06 | Source and immutable-job components have live evidence; remaining synchronization/cache/cleanup acceptance stays open. |
| WU07 | Graph readiness, persistent restart/restore, process loss, export and retention controls pass. Next: actual application source/build, managed environment, lifecycle and routing. |
| WU08 | Durable terminal and event-stream work remains planned. |
| WU09 | Hetzner target/access selected; native Linux/SSH adapter and reconnect qualification remain open. |
| WU10 | This bounded warm-graph comparison is complete. Full application reload/build/load, idle/reclamation windows, cold capacity and remote comparisons remain open. |
| WU11 | Compatibility, migration, packaging and release qualification remain open. No merge or release occurred. |

The critical path is application source/build and managed environment delivery into the graph,
then Event Agent startup/reload/lifecycle verification. The HTTP latency difference is an actionable
measurement follow-up, not a reason to discard the current candidate on this microbenchmark alone.
