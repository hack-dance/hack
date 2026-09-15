# Larger graph qualification, September 15

The candidate graph driver now supports **32 services and 32 native HTTP probes**, up from eight.
The driver executes dependency conditions, owns containers and related resources, checks readiness,
and records cleanup/restore state. The original eight-service limit was a conservative candidate
implementation bound, not a SmolVM limit.

Service count remains separate from resource admission. The existing aggregate four-CPU/4-GiB
guard, per-service limits, one-network and eight-volume bounds remain. A 32-service graph must
declare sufficiently small quotas; increasing service count does not admit 32 large containers.
Receipt validation now checks resource counts by kind instead of the old 24-resource total, and
probe validation uses the same 32-service bound. Oversized graphs and aggregate overcommit still fail.

## Failure found and fixed

The first large live graph failed at container startup after 14 containers had been created.
Containerd reported `no space left on device` while creating task metadata under
`/run/hack-local/exec`. The candidate mounted `/run/hack-local` as a 1-MiB tmpfs.

The fresh-boot setup now provides a bounded **16-MiB tmpfs with 4096 inodes**. This is a maximum,
not a preallocation. Engine errors containing ENOSPC's message now report `storage-exhausted`
without returning response values. Existing mounts are still refused rather than remounted under
a live daemon.

## Live result

One guarded 32-service fixture passed with 32 simultaneously running Bun HTTP servers and 32 native
health probes. Each service had a 0.1-CPU quota, 64-MiB memory limit, 32-PID limit, read-only root,
and 16-MiB shared-memory limit. The graph used the explicit `x-hack-isolated` replacement for an
external logical network name; the engine created a fresh owned internal bridge.

Startup and restore both reached healthy readiness for all 32 services. Direct engine inspection
confirmed running containers, exact CPU/memory quotas and the internal bridge. Ordinary cleanup
removed every container and the network; restore produced entirely fresh container/network IDs.
Final cleanup, archive, export and export reconciliation passed. The VM was stopped afterward.
Host pressure, swapout and reserve checks passed; actual application source/configuration hashes
were unchanged.

Runtime metadata used **2464 KiB (2.40625 MiB) and 762 inodes** after both startup and restore.
That exceeds the former 1-MiB limit while staying well below the new bounds. It is metadata usage,
not the VM's total memory footprint or a benchmark against Docker Compose/OrbStack.

Evidence: `.hack-local/review/wu07/isolated-network-1789513537868257000/`.
Executable SHA-256: `a5aff37d16fc495ab94df9a222cd0903049ee5466796de1f6dc511657bff11eb`.
Earlier failed runs and harness corrections remain in adjacent private evidence directories.

Validation: 158 default Rust tests, 163 with environment-launcher/native-http-probe features,
strict Clippy in both configurations, release build, and repository typecheck/check/test gates
passed. CLI tests reported 940 passed and five skipped. Regression cases admit 12/32 small
services, refuse 33 and aggregate CPU/memory overcommit, and validate receipt bounds by kind.

The real 12-service application's count now fits. Its routing, scoped environment delivery,
editable source workflow and actual resource settings still need qualification; see
[the compatibility inventory](application-compatibility-20260915.md). Thirty-two healthy synthetic
HTTP services do not prove that application's behavior or larger-graph crash recovery.
