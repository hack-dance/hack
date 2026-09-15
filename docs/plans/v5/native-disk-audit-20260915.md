# Native disk-handle audit — 2026-09-15

## Decision and behavior

Use native macOS descriptor inspection for the candidate's boot/config/disk audit. It replaces the
per-connection `lsof` subprocess while preserving a fresh observation on every audit. The previous
[CPU attribution](cleanup-cpu-attribution-20260915.md) identified that subprocess as a substantial
host-side cost. Sequential graph cleanup and all previously qualified defaults remain enabled.

The audit verifies PID/start time/UID/executable before and after enumeration. It reads at most
4096 descriptors into a 32 KiB buffer, rejects failed, partial or capacity-filling results, and
requires exact-size vnode responses. Expected disks must be regular, singly linked files owned by
the current user. Each held descriptor must match the canonical expected path and device/inode;
expected file identity is rechecked afterward. Non-UTF-8 paths are handled without lossy decoding.
A missing disk, failed descriptor observation or identity mismatch refuses the operation. There is
no cached assertion or fallback that bypasses this check.

The SDK `proc_fileinfo`/`vnode_info_path` layout is represented with C layout and checked against
native return sizes. The installed SDK reports a 24-byte file-info prefix and 1200-byte combined
record. The implementation uses the existing libc dependency. The separate shutdown `lsof` check
for disk handles held by any process is unchanged; checking only the VM's descriptors would not
prove safe shutdown.

## Correctness evidence

Regression controls cover bounded/truncated descriptor responses, two held owned disks, an existing
but unopened disk, a same-path file replacement, stale process identity and an exited process.
The real child-process test exercises native enumeration rather than a mocked success path.
Enumeration is not an atomic kernel snapshot: any observed vnode-read failure is refused, and the
process/file rechecks narrow but cannot eliminate every possible concurrent change.

Four serial live graph controls passed with the native audit: three native HTTP graph controls and
managed-environment cleanup after driver loss. They cover VM boot, readiness, supervisor loss,
same-container restart, fresh restore, failed init and owned cleanup through the existing scenarios.
They are not a full Event Agent qualification or exhaustive kernel race/permission testing.

155 default Rust tests and 160 with `environment-launcher,native-http-probe` passed. Both
configurations passed strict Clippy. The final compatibility adjustment was covered by the default
suite and focused feature-enabled regression rerun. Repository typecheck/check/test passed, including
940 CLI tests and five skips. The native-only release executable was used for performance trials.

Live evidence: `.hack-local/review/wu07/native-disk-audit-1789507595305246000/`.

## Matched lifecycle comparison

Baseline is the previously qualified dependency-order build with the `lsof` audit. Eight measured
trials used ABBA/BAAB ordering after one excluded warmup per build. The binary was selected once per
fresh fixture, with hashes checked for every phase. Each trial ran startup, cleanup retaining data,
restore and full removal on the same pinned init/SQLite/web/check workload, native HTTP checks,
four-vCPU/6-GiB VM and service limits. No builds or tests overlapped measurement.

All trials and warmups passed 200 requests before and after restore, stable SQLite data, fresh
container identities, effective resource limits and owned cleanup. The external watchdog recorded
29 samples with normal pressure and unchanged swapouts. Protected configuration hashes matched;
the test VM stopped and the qualified native executable was restored afterward.

CLI CPU includes the command and its reaped children, excluding the isolated Python timing parent.
Engine CPU is sampled around each command. Combined CPU is their sum per observation, not whole-host
CPU. Command wall time excludes the outer Python wrapper startup. The separate phase-wall column in
[all 32 observations](native-disk-audit-20260915.csv) includes readiness inspection and wrapper costs.
Do not compare those wall envelopes directly with earlier unwrapped benchmarks.

| Median per command | lsof wall ms | Native wall ms | lsof CLI CPU ms | Native CLI CPU ms | lsof combined CPU ms | Native combined CPU ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Startup | 1172.0 | 1026.8 | 110.8 | 37.0 | 791.2 | 616.4 |
| Cleanup retaining data | 440.4 | 318.7 | 74.7 | 13.2 | 198.4 | 122.4 |
| Restore | 1078.9 | 1063.6 | 100.3 | 39.7 | 700.6 | 732.4 |
| Full removal | 436.9 | 387.7 | 77.2 | 15.1 | 196.7 | 155.3 |

For the sum of all four commands per trial, median CLI CPU fell from 362.2 to 110.4 ms (69.5%),
combined CPU from 1894.2 to 1740.2 ms (8.1%), and command wall time from 3113.4 to 2850.5 ms (8.4%).
Both order blocks improved: combined CPU fell 11.1% and 10.8%, command wall time fell 12.1% and 7.1%,
and CLI CPU fell 69.5% in each. These block figures compare arithmetic means, not the pooled medians.

Engine CPU alone did not improve: lifecycle block means rose 3.0% and 2.6%. Restore combined CPU and
command latency also varied by order, so no per-phase CPU non-regression or universal latency win
is claimed. The measured overall reduction supports retaining the audit change. This small warm
cohort does not establish tail latency or real-application performance. No steady-state memory gain,
new Compose/OrbStack comparison or stable-Hack comparison is claimed.

Private protocol, hashes, observations and analyzer:
`.hack-local/review/wu05/native-audit-comparison-1789507627865978000/`.
The historical raw variant name `concurrent` in that inherited harness means the native-audit binary;
container deletion stayed sequential in both builds. The public scalar file uses `lsof`/`native`.

## Remaining work

The [initial resource-size sweep](capacity-sweep-20260915.md) is complete using this baseline.
The smaller 2-vCPU/4-GiB pool needs larger-application/load acceptance; automatic idle reclamation
with real-application recovery remains open. Concurrent cleanup remains disabled after
its separate unsuccessful qualification; this CPU gain does not qualify that experiment.
