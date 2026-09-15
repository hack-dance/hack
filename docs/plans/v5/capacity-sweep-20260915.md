# CPU and memory capacity sweep — 2026-09-15

## Outcome

Two vCPUs with 4 GiB RAM is the leading smaller configuration for this fixture. Compared with
4 vCPUs/6 GiB, it reduced median combined lifecycle CPU by 13.9%, command time by 10.9%, and observed
VM footprint by 8.5% on the first visit and 11.9% after restart. All configurations passed the workload.

Keep the existing 4-vCPU/6-GiB development pool unchanged pending larger-application acceptance.
The smaller configurations are isolated experimental builds, not new supported profile names or a
resize of existing capacity. The [native disk audit](native-disk-audit-20260915.md), native HTTP
supervisor and other previously qualified defaults remain intact.

## Protocol and isolation

A 2×2 grid compared 2/4 vCPUs and 4/6 GiB guest RAM. Each shape had its own source copy, immutable
binary, candidate root, provider assets and owned persistent disks. Only the two development CPU/RAM
constants differed from commit `1c393469`; all tracked runtime source files and lockfiles were checked.
Storage, overlay, networking, GPU, reclamation policy and service limits stayed the same. Each binary
was built for its own checkout; no checkout-binding, artifact-digest or admission check was bypassed.

The first pass ran 4/6, 2/6, 4/4, 2/4; the second pass reversed that order. Each visit booted the
selected pool, verified guest-visible CPU count and memory, checked the pinned image, ran one excluded
warmup and three measured init/SQLite/web/check lifecycles, then stopped the pool. Only one pool ran
at a time. In total: eight visits, eight excluded warmups and 24 measured lifecycles.

The same pinned image, native HTTP health configuration and 200-request workload were used throughout.
Each service retained a 0.5-CPU quota, 256 MiB memory, 64-PID limit, read-only root and 64 MiB shared
memory. This small dependency-ordered fixture does not saturate all four vCPUs; fewer assigned CPUs
also mean less available parallel capacity for other workloads.

The first measured graph in each visit included a 30-second active-health observation with 31 native
samples. Every window observed exactly 30 health checks. CPU is percent of one host core for the
verified VM engine process; footprint is that process's median physical footprint. CLI-plus-engine
CPU is collected separately around each lifecycle command. It excludes the Python timing parent,
readiness-inspection helpers outside the command bracket, unrelated host work and exited/reparented
processes outside the selected accounting boundaries. This is not whole-host CPU or energy usage.

## Lifecycle results

Each row is the median of six per-trial sums: startup, cleanup retaining data, restore and full
removal. The diagnostic 30-second observation and setup/image preparation are excluded from command
wall time. Combined CPU is summed per trial before taking the median.

| vCPUs / GiB | Command time ms | CLI CPU ms | Engine CPU ms | Combined CPU ms |
| --- | ---: | ---: | ---: | ---: |
| 4 / 6 | 2734.4 | 102.2 | 1469.5 | 1571.6 |
| 2 / 6 | 2468.4 | 97.9 | 1294.6 | 1392.5 |
| 4 / 4 | 2702.3 | 109.5 | 1476.5 | 1588.8 |
| 2 / 4 | 2435.7 | 96.6 | 1257.9 | 1353.4 |

The 2/4 direction held in both visits relative to the matching baseline visit: command time was
13.2% and 7.6% lower, and combined CPU 14.0% and 12.1% lower. Reducing only RAM to 4 GiB at four vCPUs
did not reduce combined lifecycle CPU. Capacity effects are not a simple function of assigned RAM.
[All 96 phase measurements](capacity-lifecycle-20260915.csv) retain visit and trial identity.

## Active-health CPU and footprint

| vCPUs / GiB | First-visit CPU % | Restart CPU % | First-visit footprint MiB | Restart footprint MiB |
| --- | ---: | ---: | ---: | ---: |
| 4 / 6 | 1.278 | 1.310 | 1376.1 | 884.1 |
| 2 / 6 | 1.023 | 1.154 | 1361.3 | 830.9 |
| 4 / 4 | 1.006 | 1.211 | 1334.7 | 831.9 |
| 2 / 4 | 1.155 | 1.142 | 1259.3 | 779.1 |

For 2/4, active-health CPU was 9.6% and 12.8% lower than the matching baseline visits. Physical
footprint fell by about 117 and 105 MiB, not by the full 2 GiB reduction in configured guest capacity.
The 2/6 shape also reduced CPU, so this cohort does not establish a unique CPU optimum.

The much larger within-shape footprint drop after restarting must stay separate from capacity gains.
The first visit used fresh persistent disks and imported the image; the second boot reused the same
pool and already-present image. The loader checks content identity and skips import when present.
Image preparation and cache state are plausible contributors, but their individual contributions
were not isolated. Forward/reverse order is also tied to first/restarted boot state; there is only
one window per shape per boot condition. These short post-start windows do not establish long-run
steady state, tail behavior, or automatic ten-minute idle reclamation.

[All eight windows](capacity-footprint-20260915.csv) retain timing, health counts and measurements.
No new Compose/OrbStack or stable-Hack comparison was run; earlier comparisons remain separate.

## Verification, evidence and remaining work

Every measured trial and warmup passed business responses, persistent SQLite token, fresh restored
container identities, effective limits and owned cleanup. Every visit passed the external pressure,
swap-stability and host-reserve watchdog. Protected configuration fingerprints matched. All four
experimental pools are stopped, and the original qualified executable hash and installed daemon
health were verified afterward. Source behavior on the main candidate did not change; this checkpoint
uses protocol/scalar, link, privacy and whitespace validation rather than unrelated test reruns.

Private evidence:

- `.hack-local/review/wu05/capacity-sweep-resumed-1789508652395522000/`: eight visit references,
  frozen runner, analyzer, 96 phase rows, eight windows and final pool-stop verification.
- `.hack-local/review/wu05/capacity-sweep-1789508354250453000/`: per-shape isolated build logs,
  binary identities and source/lockfile verification.

Preflight failures before measurement exposed two harness requirements: a binary must be built for
its selected checkout, and cloned provider trees must preserve symlink modes as well as file bytes
and directory modes. Digest verification correctly refused the altered copies before VM creation.
The measured run started only after complete copied-tree hashes matched the pinned manifests.

Next qualify the 2-vCPU/4-GiB pool with a larger application and CPU/memory load before changing a
capacity default. Separately test automatic idle reclamation and recovery, including the larger
post-import footprint observed here. The full Event Agent application gates remain open.
