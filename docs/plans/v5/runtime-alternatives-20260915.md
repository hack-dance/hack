# Runtime alternatives — September 15

Keep the working Docker/containerd/runc path while qualifying alternatives independently. A runtime
must first run the same workload with the same effective limits; failed startup is not a benchmark.

## Candidate defaults and remaining integration

The user requested retaining every verified performance improvement as the candidate default.
The status below separates implemented behavior from diagnostic results requiring integration.

| Change | Candidate status | Evidence / remaining work |
| --- | --- | --- |
| Pinned guest-memory runc cache | Default | A/B/A launch study reduced host CPU 13.5% against the two original-file controls; digest, read-only mount and replacement refusal verified. |
| Cleanup journal batching | Default | Durability and recovery checks pass; no standalone CPU improvement is attributed to this change. |
| Removed graph and retired intent retention cleanup | Implemented; historical sweep complete | Archives preserve evidence and consumed slot IDs; 181 graph records and 247 standalone intents handled. |
| Host memory reclamation | Explicit enabled policy, ten-minute idle window | Existing upstream default made visible per boot; disabled/enabled memory controls and two live graph runs pass. Automatic idle-trigger and real-application qualification remain open. |
| Persistent native HTTP probes | Diagnostic win; product integration open | 24–25% lower gross candidate engine CPU than OrbStack in both lane orders. Implement supervisor, freshness, retry and cleanup semantics, then benchmark that product path. |
| crun / reduced runc parallelism | Not adopted | crun cannot start the fixture; the parallelism A/B/A experiment was inconclusive. Neither is a verified gain. |

The [cleanup and launch report](cleanup-cpu-20260914.md) and
[intent retention report](cpu-launch-retention-20260914.md) retain prior implementation evidence.

## crun compatibility

The first A/B/A attempt completed its original-runc window, then failed at the first crun graph
start. The candidate cleanup and VM shutdown completed and protected inputs matched. No crun
performance result was produced.

- Bundled crun 1.12 rejects the engine's OCI configuration with `unknown version specified`.
  Evidence: `.hack-local/review/wu05/crun-comparison-1789442342407728000/` and
  `.hack-local/review/wu05/crun-compatibility-1789442585954994000/`.
- Official crun 1.29.1 ARM64, without systemd, passes executable/version verification but a bounded
  container start fails with `open io.max: No such file or directory`. The same failure is reproduced
  with an explicitly named, read-only no-op container with CPU, memory and PID limits.
  Evidence: `.hack-local/review/wu05/crun-modern-compatibility-1789442685120539000/`.
- The downloaded release digest is
  `ab65ff781690b12d4cb8eab1551cb43bb6d2d49d3eafb1100046652c46703ad0`.
  Source: [official ARM64 release](https://github.com/containers/crun/releases/tag/1.29.1).
  The experiment transfers verified bytes into a private guest tmpfs and overlays only the runtime
  executable for the owned VM. Installed provider files and global Hack remain unchanged.
- The pinned [ARM64 kernel configuration](https://github.com/smol-machines/libkrunfw/blob/55bb7c5273178826240b39e907475fb6011afd8e/config-libkrunfw_aarch64)
  enables block cgroups but disables `CONFIG_BLK_DEV_THROTTLING`. This is consistent with the missing
  `io.max` file. Live readback shows `io` both available and enabled at the cgroup root, with no
  `io.max` files in the inspected first two levels. Evidence:
  `.hack-local/review/wu07/standalone-retention-1789442989403350000/cgroup-capability.json`.
  OCI-spec inspection remains necessary before selecting a fix. Do not disable requested resource
  limits to manufacture compatibility.

One diagnostic retry also encountered a retained empty experimental directory after reboot. The
harness now places its cache under the already-owned, fresh `/run/hack-local` tmpfs. The failed
attempt is retained; it is not evidence against the runtime itself.

Next: inspect live controller availability and the exact value-free resource portion of the
generated OCI specification, then qualify an appropriate runtime/kernel or configuration fix.
Only after compatibility passes should crun enter the equal-work CPU/latency comparison.

## Persistent HTTP probe experiment

The independent diagnostic uses one Bun exec to perform 58 HTTP checks at one-second intervals,
instead of launching Bun through the runtime 58 times. Its launch, checks and termination are
included in the native measurement window. Both engines run the same command and container
limits, with automatic health checks disabled and the existing data/restore correctness checks.

This evaluates an explicit persistent HTTP-probe capability. It does not authorize replacing
arbitrary shell health commands or claiming that supervisor recovery and health-state semantics
have been implemented. CPU, footprint, completed checks and cleanup must all pass before a result
is promoted from the private experiment.

The first completed cohort passed all 116 checks, interval containment, data restore, fresh compute,
cleanup and protected-input checks. All 112 watchdog observations had normal pressure and unchanged
swapouts. Evidence: `.hack-local/review/wu05/persistent-probes-1789442711187302000/`, including
`verified-persistent-probes.json`, raw native samples and the frozen driver.

| Engine | Host CPU-seconds / 58 checks | CPU, percent of one core | Median engine footprint | Median application HTTP time |
| --- | --- | --- | --- | --- |
| Candidate | 1.069 | 1.781% | 791.94 MiB | 0.507 ms |
| OrbStack / Compose | 1.410 | 2.350% | 2565.10 MiB | 0.601 ms |

Candidate gross engine CPU is 24.2% lower in this cohort. Relative to the earlier separate
58-exec HTTP cohort (5.297 CPU-seconds), candidate CPU is about 79.8% lower. These are different
cohorts and the latter deliberately changes process lifetime; it is not a drop-in shell-health
performance claim. Empty-pool subtraction gives 14.14 versus 14.84 incremental host CPU ms per
check: much of the gross advantage comes from lower baseline CPU. Footprint counts selected engine
process trees; driver, observer and stable daemon are separately measured. The unchanged 4-vCPU /
6-GiB candidate and 16-vCPU / approximately 68.6-GiB OrbStack allocations remain a limitation.

The measurement includes the persistent process's launch and exit. All check timestamps lie in
their one-second schedule; enclosing host timestamps prove the entire exec fits within the native
window. A second cohort with the lane order reversed passed the same checks and another 112
watchdog observations. Candidate CPU was 1.075 versus 1.438 CPU-seconds, or 25.3% lower; footprint
was 782.58 versus 2576.18 MiB. Evidence:
`.hack-local/review/wu05/persistent-probes-reversed-1789443090829558000/verified-persistent-probes.json`.
Across both orders, 232 successful HTTP checks and four complete native workload windows support
the 24–25% gross engine CPU advantage for this diagnostic. The second empty-pool window had stable
daemon child churn, so its daemon CPU is omitted; selected engine identities stayed stable.
The [scalar comparison](runtime-alternatives-20260915.csv) contains both cohorts.

Product follow-up: add explicitly declared persistent HTTP/TCP probes with a bounded supervisor,
fresh readiness after restart, timeout/retry semantics, probe failure and supervisor-loss tests,
and complete cancellation/cleanup. Keep arbitrary command-based health checks unchanged. Repeat
the same comparison through that product path before claiming the reduction for normal graph use.

## macOS reclamation capability

An ignored-test-only boot helper compares `SMOLVM_BALLOON_RECLAIM=0` and `1`.
Both test modes disable automatic idle reclamation and use the same explicit 1024 MiB
balloon inflation/deflation. Each retains a 128 MiB known nonzero pattern, allocates and frees a
second 384 MiB pattern, then reallocates and checks both. Independent host hashing confirms the
full expected pattern sizes, not just agreement between two potentially incomplete writes.

| Stage | Reclamation disabled | Reclamation enabled |
| --- | --- | --- |
| Before allocation | 695.8 MiB | 648.4 MiB |
| Both patterns allocated | 1245.5 MiB | 1223.5 MiB |
| 384 MiB released | 1247.3 MiB | 846.6 MiB |
| After inflation / deflation | 1225.0 MiB | 798.0 MiB |
| Reallocated, both patterns verified | 1652.5 MiB | 1227.0 MiB |
| Files and test mount removed | 1650.5 MiB | 861.0 MiB |

Each stage is the median of five native observations. Selected-process CPU from the final before
sample to the final cleaned sample was 8.005 seconds disabled versus 7.886 seconds enabled. That
includes allocation, hashing, balloon handling, reuse, cleanup and observation waits; two boots do
not establish a CPU improvement or production latency bound. Both modes kept one stable provider
identity, all 66 watchdog observations had normal pressure and unchanged swapouts, protected hashes
matched, and both VMs stopped. The [scalar observations](reclamation-20260915.csv) retain the data.
Evidence: `.hack-local/review/wu07/reclamation-1789443409797638000/verified-reclamation.json`.

A subsequent launch-path audit corrected the earlier default attribution: `machine start` calls
`start_vm_named`, then `ensure_running_with_full_config`; the pinned manager sets
`SMOLVM_BALLOON_RECLAIM=1` whenever idle reclamation is enabled. Normal candidate boots already
inherited that policy. The disabled experimental control is therefore not the previous normal
candidate default, and the table does not establish an additional default-to-default memory win.
The candidate now explicitly requests reclamation with the same ten-minute idle window and records
that policy before boot. Runtime status reports the recorded policy; legacy receipts report null
until a fresh boot rather than claiming a retroactive upgrade.

The live graph regression passed six 1024 MiB inflation/deflation cycles across initial startup and
fresh restore. Two non-root services retained and checked 64 MiB each after every pulse. Scoped
health and expiry, PID1 signal forwarding and exit codes, persistent volume counter 1 to 2, fresh
container/slot identities, and cleanup all passed. Evidence:
`.hack-local/review/wu07/graph-reclamation-1789444306861555000/`.
The same six cycles also passed through the rebuilt normal CLI boot, with recorded policy
`enabled=true, idle_minutes=10` and no experimental boot override:
`.hack-local/review/wu07/graph-default-reclamation-1789444548254892000/`.
Both external watchdogs retained normal pressure and unchanged swapouts; the candidate stopped
and protected stable executable/configuration hashes matched after each run.
This extends synthetic memory correctness to the owned graph fixture. It does not qualify the real
application, the automatic ten-minute idle trigger, or a resumed-latency bound.

The remaining provider work is the [SmolVM audit](smolvm-optimization-audit-20260914.md): automatic
idle-cycle qualification, allocation sweeps and profiling of the remaining launch path.
