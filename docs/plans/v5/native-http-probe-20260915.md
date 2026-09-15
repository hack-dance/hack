# Resident native HTTP probe — September 15

The resident probe component is implemented and qualified locally and inside the owned ARM64 VM.
Graph integration remains open: normal graphs still use their existing command health checks.
The earlier persistent-Bun diagnostic CPU advantage is not yet a benchmark of this native path.

## Implemented contract

`native-http-probe` builds a static Linux ARM64 executable with pinned Zig 0.15.2 and embeds it for
future publication. A host build of the same POSIX source exercises failure cases in Rust tests.
The qualified guest executable is 33,264 bytes, SHA-256
`2022a88e224b1ff5befcd15f6b9ab1c6ad80dc604584b23f08aed7cb0461ddda`.
File size is not process footprint or a CPU measurement.

- One resident process performs explicit HTTP GET checks against IPv4 localhost. Each request
  opens a connection and closes it after bounded response headers; this is persistent process
  lifetime, not connection pooling. Success is HTTP 2xx. Redirects are not followed.
- The total connect/write/header deadline is bounded, including a peer that trickles bytes.
  Response headers are capped at 8 KiB. Paths are capped at 512 ASCII bytes and cannot inject
  headers. TLS, authentication, DNS, response-body assertions and arbitrary commands are outside
  this component's contract.
- Consecutive failures reach the configured retry threshold; success resets failures and restores
  health. Startup grace suppresses failures only until the first success or grace expiry.
  Scheduling avoids accumulating catch-up bursts after a slow check.
- Status is a bounded atomic file containing only version, generation, sequence, health, failure
  count, wall-clock sample time and request duration. It is ephemeral, not durable readiness.
  The reader requires a matching generation and independently confirmed live exec, and rejects
  stale samples or excessive clock skew. Its allowance is interval plus timeout plus one second;
  a sample more than one second in the future also fails closed.
- A private directory and exclusive process lock prevent duplicate starts. A retained status or
  incomplete publication refuses replay; the caller must retire old state after confirming process
  termination and allocate fresh state for restart. SIGTERM/SIGINT interrupt waits without output.
  Core dumps are disabled. The probe does not print paths, requests, responses or error details.

## Live evidence and transport finding

Evidence: `.hack-local/review/wu07/native-http-probe-1789445397082531000/`.
The native binary ran as UID/GID 1001 in a read-only container with 0.5 CPU, 256 MiB memory,
64 PIDs, dropped capabilities, no-new-privileges and no external network. A 64 KiB guest tmpfs
provided its private writable status directory through an explicit bind mount. Status observation
used Docker's archive endpoint; it did not launch a process for each read.

The test observed healthy → three failures/unhealthy → timed-out checks → healthy, refused a
concurrent duplicate, killed only the exec whose executable and cgroup matched the owned fixture,
and confirmed exec termination. Its last healthy file remained, demonstrating why file content
alone is insufficient. Replay was refused. After the stopped container's test state was retired,
a fresh process generation became healthy and container stop terminated it. All three external
watchdog samples had normal pressure and unchanged swapouts; the container was removed, VM stopped,
and stable executable/configuration hashes matched.

Two retained attempts showed that Docker's archive endpoint did not expose status through this
engine's container `Tmpfs` configuration, even though the process was running and the file existed.
A bounded guest tmpfs bind mount solved that visibility issue. Evidence:
`.hack-local/review/wu07/native-http-probe-1789445222520481000/` and
`.hack-local/review/wu07/native-http-probe-1789445298044701000/`.
This finding constrains the graph implementation; do not restore per-check container execs merely
to read status.

## Next integration unit

1. Add an explicit native HTTP declaration to the reviewed project plan; do not reinterpret
   arbitrary shell commands or silently replace image health semantics.
2. Bind probe configuration, private tmpfs allocation, generation and exec identity to durable graph
   intent before effects. Refuse replay after ambiguous creation/start and release only owned state.
3. Start one probe per container incarnation. Read bounded archive status alongside exec/container
   identity and use the existing graph readiness/dependency rules. Supervisor loss must be unhealthy.
4. Cover graph driver loss, stop/restart, restore with fresh IDs, failed init, non-root delivery,
   reserved mount conflicts and cleanup. Do not retain old healthy status across generations.
5. Repeat the fixed completed-work comparison in both lane orders through that product path,
   including status observation, startup/exit, CPU, process footprint and application response time.

The native component is feature-gated and does not yet change candidate graph defaults.
