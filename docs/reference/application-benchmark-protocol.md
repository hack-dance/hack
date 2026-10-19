# Matched application benchmark protocol

This page freezes revision 1 of the protocol for the v5 matched application benchmark
(Linear HACK-1169, under WU10 HACK-1123). It fixes the artifacts, host, workloads,
capacities, cache classes, run order, sample counts, observer accounting and budgets
**before** any trial runs. It records no results. No performance or resource claim
follows from this page.

The machine-readable copy is
[`scripts/application-benchmark-protocol.json`](../../scripts/application-benchmark-protocol.json).
[`scripts/check-application-benchmark-protocol.py`](../../scripts/check-application-benchmark-protocol.py)
validates it and judges retained summaries offline. It never starts a runtime or calls
Docker.

A change to anything on this page needs a new protocol revision, made before the
trials it governs. Results from different revisions are never pooled. A cohort that
cannot meet this protocol is reported as inconclusive, not adjusted after the fact.

## Artifacts

Every lane runs an exact released artifact, installed into its own isolated home and
state paths. A lane never uses whatever `hack` is on `PATH`; the M3 host currently has
4.2.0 installed, and that installation is not a lane. Before each cohort, the harness
must verify the SHA-256 digest of each downloaded asset and record the executable's
reported version. A mismatch refuses the cohort.

| Lane | Tag | Commit | Asset | Asset SHA-256 |
| --- | --- | --- | --- | --- |
| `candidate` | `v5.0.0-next.5` (prerelease) | `28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc` | `hack-5.0.0-next.5-darwin-arm64-native.tar.gz` | `ba1da4d349ab70069a1b0775ba671838440b5479cffd1fc2fe41c59816c3df11` |
| `hack-4.1.1` | `v4.1.1` | `74bf0672f41bd3f68a4ce6cba28b9ba15467c2b2` | `hack-4.1.1-darwin-arm64.tar.gz` | `968f75fe66cd84fdf93b0c5b64ca5df02f98c74281b5a9238125b3afd2f3d72b` |
| `hack-4.2.0` | `v4.2.0` | `575847486963db94623e1e7f8cd49acca286c517` | `hack-4.2.0-darwin-arm64.tar.gz` | `c62b533aaddbeaafa594cab682cf10041c9bcaea69e2fe25e33e85df49654a85` |
| `hack-4.2.1` | `v4.2.1` | `5a4c51babb7ef725a30f2f3fd3677081a64bc247` | `hack-4.2.1-darwin-arm64.tar.gz` | `557583d946abcd0dd0a3fa12b2f7b81f18310d594b0699d663ebf239d0d4d729` |
| `compose` | none | none | Docker CLI and Compose on the host | see below |

The candidate is built from `28de2f89`, the `v5.0.0-next.5` tag commit. A later
candidate needs a new revision; it does not inherit this one's results.

## Host and engine

Native stateful benchmarks are host-specific, so one host is frozen. These values were
read from the host on 2026-10-19:

| Item | Value |
| --- | --- |
| Host | `m3-max`: Apple M3 Max, 16 logical CPUs, 128 GiB memory |
| OS | macOS 27.0 |
| Docker CLI | 29.4.0 |
| Docker Compose | v5.1.2 |
| OrbStack | 2.2.3 (build 20963), configured with 16 CPUs and 71680 MiB memory |

Before each cohort, the harness records these values again. If any of them differs,
the cohort is refused and a new revision is needed. Results from another host,
including the M5 Max development host, are not revision-1 results.

Only one stateful benchmark owner may use the host and its runtimes at a time. Other
agents' runtime tests, builds and Docker work must not overlap a cohort. Independent
source-only checks may still run elsewhere.

## Capacities

Each lane runs with the capacity a user gets by default. Capacities are recorded and
reported side by side; they are never used to scale results.

| Lane | Capacity |
| --- | --- |
| `candidate` | native `development` profile: 4 vCPUs, 6144 MiB guest memory, 32 GiB storage, 10 GiB overlay |
| `compose`, `hack-4.1.1`, `hack-4.2.0`, `hack-4.2.1` | the shared OrbStack VM above: 16 CPUs, 71680 MiB memory limit |

The capacities differ. The compared footprint metric is the measured physical footprint
of the whole runtime, not the configured limit. A lower configured limit is not a
footprint result. Any capacity-matched control is a separate experiment with its own
revision.

## Workloads

Two workloads run in every lane. A cohort records each workload's pin, and every lane
in that cohort uses the same pin.

**Event Agent.** The actual application configuration, not a reduced copy. The cohort
records the application commit and a digest of its configuration. Its expected shape is
14 services, 9 HTTP health checks and 2 initializers. A different shape refuses the
cohort until the protocol is revised. Credentials come only through authorized managed
injection; candidate endpoints and data stay isolated from v4, global state and QA.
A lifecycle counts as correct only when:

- every declared long-running service is running and every HTTP health check is healthy;
- both initializers exited 0;
- the routed sign-in page returns HTTP 200;
- a per-run data marker written before the restart reads back after it.

**Small fixture.** A pinned two-service graph: an initializer and a web service, both
on `oven/bun:1.4.2-slim` with `pull never`, the image ID recorded per cohort. The
initializer creates a SQLite schema in a named volume and exits 0. The web service
serves a health endpoint and the current source token, and reloads on a source edit.
A lifecycle counts as correct only when:

- the initializer exits 0 and the web health endpoint returns HTTP 200;
- the check task inserts a per-run row and reads back the expected count;
- that row reads back after the restart;
- a source edit is served within the watcher acknowledgement window.

A lane that cannot run a workload correctly records a failure for that lifecycle. It
is not dropped and its timings are not used. A lane is `not_applicable` only when the
lane cannot express the workload at all, and that reason is recorded.

## Cache classes

| Class | Meaning | Use |
| --- | --- | --- |
| `warm` | Engine or VM running; images, dependency and build caches filled by an earlier correct lifecycle of the same lane; application volumes kept | Budget class |
| `cold-capacity` | Engine or VM stopped before the trial; images and caches kept | Reported separately |
| `cold-cache` | Engine or VM running; images present; dependency and build caches empty | Reported separately |

No trial pulls an image, so image download time never enters a lifecycle. The host page
cache is not flushed, and each receipt says so. Every receipt names its cache class.
Classes are never mixed in one statistic.

## Lifecycle and phases

One lifecycle is: warm startup to full readiness and correctness, the workload's check
and build/test task, an exec, a source reload, a restart to full readiness and data
readback, a steady idle window, sustained application load, shutdown and cleanup
readback. Each phase is timed and reported on its own:

`cold-startup`, `warm-startup`, `restart`, `reload`, `build-test`, `exec`,
`steady-idle`, `sustained-load`, `shutdown`, `cleanup`.

Readiness means the workload's correctness checks pass, not that a process started or
a port opened. Cleanup readback inventories owned containers, processes, sockets and
allocated disk, and keeps persistent data.

## Order and repetitions

Each workload runs 10 rounds. Each round runs every lane once, in the order below. This
is a Williams design for five lanes: every lane takes every position twice, and every
lane runs directly after every other lane exactly twice. It balances position and
first-order carryover, so a lane does not benefit from always running after the same
neighbour. The program floor is five rotated lifecycle runs per lane; this protocol uses
10.

| Round | Order |
| --- | --- |
| 1 | candidate, compose, hack-4.2.1, hack-4.1.1, hack-4.2.0 |
| 2 | compose, hack-4.1.1, candidate, hack-4.2.0, hack-4.2.1 |
| 3 | hack-4.1.1, hack-4.2.0, compose, hack-4.2.1, candidate |
| 4 | hack-4.2.0, hack-4.2.1, hack-4.1.1, candidate, compose |
| 5 | hack-4.2.1, candidate, hack-4.2.0, compose, hack-4.1.1 |
| 6 | hack-4.2.0, hack-4.1.1, hack-4.2.1, compose, candidate |
| 7 | hack-4.2.1, hack-4.2.0, candidate, hack-4.1.1, compose |
| 8 | candidate, hack-4.2.1, compose, hack-4.2.0, hack-4.1.1 |
| 9 | compose, candidate, hack-4.1.1, hack-4.2.1, hack-4.2.0 |
| 10 | hack-4.1.1, compose, hack-4.2.0, candidate, hack-4.2.1 |

Print the same schedule with
`python3 scripts/check-application-benchmark-protocol.py --schedule`.

## Sample counts

- **Lifecycle metrics** (startup, restart, footprint, CPU per task) use the median of
  at least 10 lifecycles per lane, with minimum, maximum and interquartile range.
- **Tail metrics** (info, warm admission, cached status, watcher acknowledgement and
  request latency under load) use the nearest-rank p95 of at least 60 samples per lane,
  per workload. The sample maximum is reported as an upper bound. For any distribution,
  the maximum of n samples is at or above the true p95 with probability 1 − 0.95ⁿ;
  59 samples is the smallest count that reaches 95%.
- A statistic with fewer samples than planned, or fewer than these floors, is
  inconclusive. It is never a pass.

## Measurement boundary

Each lifecycle records:

- wall time per phase and to full readiness;
- CPU seconds for the CLI process tree, every runtime helper, the whole VM (OrbStack or
  the native provider) and the guest, with the sampling window for any CPU percentage;
- CPU per completed task, using a count of completed correct operations;
- physical footprint and peak for the whole runtime, including the VM and every helper.
  RSS sums include shared pages and are not reported as physical memory savings;
- logical and allocated disk, before and after cleanup;
- host load, memory pressure and background CPU at the start, end and every second;
- request latency under sustained load;
- every failure, refusal and retry.

Near-zero CPU percentages are not reported as wins. Unobserved values stay null, and
each summary states its coverage.

## Observer overhead

The sampler runs with the same settings in every lane. Before each cohort, it runs
alone for a control window of at least 600 seconds with no workload, to measure its
own CPU and footprint. During the cohort, its own process-tree CPU is recorded for
each lifecycle and reported as its own line.

Observer cost is never subtracted from a lane. When the candidate and a baseline differ
by less than 2 times the observer's cost for that metric, the comparison is
inconclusive. A summary that does not report observer cost for a compared metric is
inconclusive for that metric.

## Admission and failures

A sample is flagged, not dropped, when build tools run, host load or memory pressure is
above the idle baseline, a security scan or indexing burst is attributed to the run, or
any of these could not be observed. Flagged samples are summarized separately. A
background-contention, low-headroom, failed-correctness or stalled-subscriber control
must produce a flag or failure, not a clean sample.

Every reproducible regression is reported, even where the aggregate looks better. A
regression in a required workflow blocks acceptance until it is fixed or the goal is
explicitly reviewed.

## Budgets

**Comparative budgets.** These are judged in the `warm` class, separately against each
applicable baseline: `compose`, `hack-4.1.1`, `hack-4.2.0` and `hack-4.2.1`. There is no
aggregate score. Ratio is candidate divided by baseline; a ratio at the ceiling passes.

| Metric | Statistic | Ceiling ratio | Program target |
| --- | --- | --- | --- |
| `steady_physical_footprint_bytes` | median | 0.70 | at least 30% lower steady total physical footprint |
| `cpu_seconds_per_task` | median | 0.75 | at least 25% lower CPU per completed matched task |
| `warm_startup_seconds` | median | 0.80 | at least 20% faster median warm startup |
| `warm_restart_seconds` | median | 0.80 | at least 20% faster median warm restart |

**Absolute budgets.** These are candidate-only. They come from the program acceptance
document.

| Metric | Statistic | Budget | Workload |
| --- | --- | --- | --- |
| `info_latency_ms` | p95 | ≤ 100 ms | both |
| `warm_admission_ms` | p95 | ≤ 250 ms | both |
| `cached_status_1000_objects_ms` | p95 | ≤ 150 ms, with 1,000 cached objects | small fixture |
| `idle_control_plane_core_fraction` | mean over 600 s | < 1% of one core | small fixture |
| `watcher_ack_ms` | p95 | ≤ 200 ms | small fixture |

These are acceptance thresholds, not measured achievements.

## Judging a summary

`--evaluate SUMMARY` reads one workload's retained summary and returns one verdict per
budget and baseline: `pass`, `fail`, `not_applicable`, `inconclusive_coverage`,
`inconclusive_samples`, `inconclusive_observer` or `inconclusive_missing`. It exits 0
only when every verdict is `pass` or `not_applicable`. It exits 1 when any verdict
fails or is inconclusive, and 2 when the protocol or summary is invalid. Diagnostics
are closed codes and never repeat input values.

A summary has this shape:

```json
{
  "protocol_revision": 1,
  "workload": "small-fixture",
  "observer_cost": { "cpu_seconds_per_task": 0.02 },
  "lanes": {
    "candidate": { "cpu_seconds_per_task": { "samples": [1.2], "expected": 10 } },
    "compose": { "cpu_seconds_per_task": { "not_applicable": true } }
  }
}
```

## Known limits

The accepted storage-witness startup cost is recorded in
[performance diagnostics](../performance.md#known-v5-limit-storage-witness-startup-cost).
It is part of every candidate warm `up` measured under this protocol, and is not
removed from candidate timings.

## Checks

```sh
python3 scripts/check-application-benchmark-protocol.py
python3 -m unittest discover -s tests/python -p test_application_benchmark_protocol.py
```

The unit tests check the frozen file, the rotation balance, the p95 sample floor and
that this page carries every frozen artifact and budget. They also prove that a
weakened budget, a bad digest, an unbalanced order, too few samples or a missing
observer policy is refused. They run offline, locally and in CI.
