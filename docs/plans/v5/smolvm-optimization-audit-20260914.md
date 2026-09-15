# SmolVM optimization audit — September 14

The adapter has enough control for the next measurements, but its configuration is not yet
qualified as optimal. Audit the pinned 1.14.3 implementation, not a feature list from current main.
The inspected SmolVM commit is `f233d46e8cc34e51543c4f463c2cea7622827093`; its libkrun
submodule is `5de9ab51c1bb166af2324de3c9413d00022eb178`. No provider defaults changed in this audit.

## Actual configuration and available controls

| Area | Current adapter | Finding / action |
| --- | --- | --- |
| CPU and RAM | Explicit 4 vCPU / 6144 MiB development profile; separate frozen research profile | Sweep vCPU counts independently of RAM, with repeated equal completed work and unchanged container limits. More vCPUs need not lower CPU per operation. |
| Engine transport | SmolVM Docker bridge: host Unix socket → vsock → guest Docker Unix socket | Already avoids a host TCP connection. Measure API-only requests separately from exec; a different RPC encoding does not itself remove container-process launch. |
| Application data | Guest ext4 storage for Docker/containerd; source generations copied into guest storage | Keep hot runtime/application data off host shared filesystems. Read-only `runc` tmpfs cache already qualified. Profile remaining virtiofs activity before caching more binaries. |
| virtiofs DAX | Architecture-dependent upstream default | Pinned source returns a zero DAX window on ARM64 because the bundled guest lacks the required support. Enabling an environment flag cannot provide DAX here. |
| Block I/O | Upstream synchronous default | Pinned asynchronous mode uses Linux io_uring and rejects non-Linux hosts. It is not a missing Mac switch. Retain durability semantics. |
| Idle memory | Upstream ten-minute idle balloon policy; clean environment does not pass reclaim overrides | macOS stage-2 unmap reclamation is opt-in (`SMOLVM_BALLOON_RECLAIM=1`) and currently absent. The default still uses a madvise fallback; do not call this proof of effective host reclamation. Qualify actual release and subsequent reuse. |
| VM control | Upstream control socket supports balloon, pause, checkpoint and restore when available | Availability is not application-safe snapshot proof. Preserve fresh credentials, disk ownership, boot identity and graph recovery semantics. |
| Networking / GPU / translation | No general guest networking, GPU, CUDA or Rosetta enabled for this native ARM64 fixture | These capabilities do not target the measured local no-op exec cost. Network variants need a separate workload before selection. |
| Lower-level access | Pinned CLI process adapter with controlled guest setup | Enough for allocation, locality and reclaim experiments. VMM internals or kernel changes require a separately pinned provider build; direct libkrun integration remains contingent on a measured gap. |

Source: [virtiofs policy](https://github.com/smol-machines/smolvm/blob/f233d46e8cc34e51543c4f463c2cea7622827093/src/agent/virtiofs.rs),
[resource validation](https://github.com/smol-machines/smolvm/blob/f233d46e8cc34e51543c4f463c2cea7622827093/src/data/resources.rs),
[vsock bridge](https://github.com/smol-machines/smolvm/blob/f233d46e8cc34e51543c4f463c2cea7622827093/src/agent/vsock_service.rs),
[launcher and idle policy](https://github.com/smol-machines/smolvm/blob/f233d46e8cc34e51543c4f463c2cea7622827093/src/agent/launcher.rs),
[macOS reclamation](https://github.com/smol-machines/libkrun/blob/5de9ab51c1bb166af2324de3c9413d00022eb178/src/hvf/src/lib.rs#L833).
The bundled dylib contains the reclamation setting, which corroborates availability but does not
prove activation or correctness under load.

## Ordered qualification work

1. API-only control completed: 174 successful `GET /version` requests within each 60-second
   window consumed 2.066 candidate versus 2.000 OrbStack host CPU-seconds. Median wall time for
   each three-request group was 18.15 versus 15.64 ms. Both windows passed timing bounds,
   workload/persistence, protected-input and cleanup checks; 112 watchdog observations retained
   normal pressure and unchanged swapouts. Evidence:
   `.hack-local/review/wu05/api-only-1789441576067862000/verified-api-only.json`.
   This small gross difference contrasts with 5.219 versus 3.236 CPU-seconds for 58 no-op execs.
   Different endpoints and cohorts prevent subtraction into exact transport/launch shares;
   the result supports investigating process-launch work before replacing HTTP.
   Attribute host CPU to guest runtime, shared filesystem workers and vCPU activity before a
   protocol or provider replacement. A cheap GET is a transport lower bound, not an exec endpoint.
2. Qualify opt-in macOS reclamation in an owned test VM: allocate and touch memory, release it,
   observe host physical footprint and balloon state, then reallocate and verify contents and
   application persistence. Measure refault CPU and resumed latency as well as idle footprint;
   retain the original default unless a repeatable net benefit passes recovery controls.
3. Run an allocation sweep with equal completed operations, alternating order and fresh cohorts.
   Keep image, engine, memory, container quotas and workloads fixed. Record throughput and latency
   alongside CPU per operation; a lower CPU rate from doing less work is not a win.
4. Profile the remaining launch cost. A temporary `GOMAXPROCS=1` runc A/B/A pilot was inconclusive:
   58 HTTP execs consumed 5.962 / 5.239 / 5.102 host CPU-seconds. The restored control outperformed
   the treatment, so the production runtime setting remains unchanged. Evidence:
   `.hack-local/review/wu05/runtime-parallelism-1789440893683318000/verified-fixed-work.json`.

The current engine-only comparison already shows lower candidate idle CPU and footprint, but
higher CPU per repeated exec. Neither the smaller feature set nor a VM boot-time claim predicts
which engine is cheaper for that operation. Full application and remote qualification remain open.

September 15 follow-up: the [runtime alternatives checkpoint](runtime-alternatives-20260915.md)
records crun compatibility failures, a repeated persistent-probe CPU advantage, and successful
synthetic opt-in memory release/reuse. Product probe supervision and application reclamation
qualification remain open; production runtime defaults have not changed.
