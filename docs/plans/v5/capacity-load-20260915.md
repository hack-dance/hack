# Smaller-capacity load controls — 2026-09-15

## Outcome

The 2-vCPU/4-GiB pool passed a heavier synthetic workload with touched application memory and
parallel computation. Against 4 vCPUs/6 GiB, median combined lifecycle CPU fell 6.0%, command time
fell 11.4%, and post-load VM footprint was 19.1–25.5% lower. The worker batch itself was 2.3% slower.
This supports smaller-capacity efficiency, not a universal throughput win or Event Agent readiness.
Existing capacity defaults remain unchanged pending application and idle-recovery acceptance.

## Workload and evidence

The [isolated capacity builds](capacity-sweep-20260915.md) were reused without source changes.
Four pool visits ran baseline/smaller/smaller/baseline. Each included one excluded warmup and two
measured lifecycles, for eight measured lifecycles and four warmups. Each lifecycle ran the workload
on initial startup and again after persistent-data restore.

The web service filled and retained a 768 MiB buffer and exposed its length and endpoint-byte proof
in the business response. Four concurrent worker threads each filled 128 MiB, checked one byte per
page, and executed 120,000 SHA-256 operations on a 16 KiB block. The analyzer independently checked
each worker's digest and page checksum. The workload then completed 200 HTTP/data checks. SQLite
data had to survive cleanup/restore, and restored containers had to have fresh identities.

The web and worker services each had a 1 GiB memory cap; the worker service had a 2-CPU quota and web
had a 1-CPU quota. Init retained 256 MiB/0.5 CPU. All existing graph and host admission limits stayed
intact. An initial 3-CPU worker request was refused before graph allocation; it was corrected to the
supported 2-CPU limit. Thus this tests a heavier bounded workload, not full four-core throughput or
memory exhaustion. Filled buffers total 1.25 GiB across web and workers; no exact concurrent resident
memory peak is claimed. The post-load sample occurs after workers exit, while web memory remains held.

All eight measured lifecycles and four warmups passed worker results, HTTP responses, retained data,
fresh IDs, effective resource limits and owned cleanup. Each visit recorded 31 native samples over
30 seconds with exactly 30 health checks. Pressure, swap stability, host reserve and protected-file
checks passed. Both pools stopped afterward.

## Results

Each lifecycle row is the median of four per-trial sums across startup, down retaining data, restore
and full removal. Setup, image preparation and the diagnostic observation window are excluded from
command timing. Combined CPU adds CLI/child CPU and the VM engine's command-bracket CPU; it is not
whole-host CPU. Worker-batch wall time includes worker startup and completion inside the application.

| Metric | 4 vCPUs / 6 GiB | 2 vCPUs / 4 GiB |
| --- | ---: | ---: |
| Four-command wall time | 8033.7 ms | 7114.8 ms |
| CLI/child CPU | 295.9 ms | 256.4 ms |
| Engine CPU | 8648.1 ms | 8158.7 ms |
| Combined CPU | 8954.2 ms | 8415.0 ms |
| Worker-batch wall time | 1595.2 ms | 1631.6 ms |
| Post-load engine CPU, two windows | 1.060%, 1.262% | 0.915%, 1.123% |
| Post-load footprint, two windows | 2076.8, 2087.1 MiB | 1547.4, 1687.5 MiB |

The footprint reduction held in both matched visit pairs; variation within the smaller pool remains
visible. These short windows do not establish long-run steady-state memory, automatic reclamation,
peak memory, tail latency or an application-wide regression budget. No Compose/OrbStack comparison
was added. [All 32 phase rows](capacity-load-lifecycle-20260915.csv) and
[four observation windows](capacity-load-footprint-20260915.csv) preserve the measurements.

One earlier cohort stopped during its third visit because the native sampler could not establish a
process identity. The exact failed identity was not established; cleanup and protected-file checks
passed. The incomplete cohort is retained and excluded. The final cohort sampled only the owned VM
and sampler itself; unrelated process trees were removed from the descendant-sampling scope, while
read-only external-root observations remained in the watchdog. No identity check was bypassed.

Final private evidence:
`.hack-local/review/wu05/capacity-load-comparison-1789511076884583000/`.
Interrupted visit: `.hack-local/review/wu05/capacity-load-1789510966283330000/`.

## Refreshed application gate

The registered Event Agent checkout's actual `.hack/docker-compose.yml` was planned with the current
candidate. It declares 12 services, versus 14 in the older qualification copy. The fresh plan has
21 errors: one external network, nine existing route/ownership-label declarations, and eleven
unresolved mount-source declarations; one namespace warning is also present. Application startup
remains blocked. No routing, credential mounts, lifecycle hooks or project source were changed or
executed to bypass those boundaries.

Source commit, dirty-state fingerprint and configuration hashes were recorded and unchanged on
readback. Private evidence: `.hack-local/review/wu07/application-refresh-20260915/registered-plan.json`
and the adjacent identity/preservation records. The older copy's plan and a stale worktree's missing
source refusal are retained separately; neither substitutes for this registered-checkout result.

Next work remains application-compatible networking/routing, scoped environment/credential delivery,
real startup/reload/persistence acceptance, and automatic idle reclamation with recovery. Passing
this load control does not close those gates or authorize resizing the existing development pool.
