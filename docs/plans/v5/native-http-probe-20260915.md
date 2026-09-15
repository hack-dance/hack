# Resident native HTTP probe — September 15

The resident probe component is implemented and qualified locally and inside the owned ARM64 VM.
Graph integration now supports explicitly declared native HTTP checks. Existing command checks
retain their semantics.
The [integrated benchmark](native-graph-performance-20260915.md) now measures this path against
Compose command-health checks; the earlier persistent-Bun diagnostic remains separate.

## Implemented contract

`native-http-probe` builds a static Linux ARM64 executable with pinned Zig 0.15.2 and embeds it for
owned, digest-verified guest publication. A host build of the same POSIX source exercises failure cases in Rust tests.
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

## Graph integration

The private candidate build enables `native-http-probe`; pinned Zig 0.15.2 and a host C compiler
are build prerequisites. A manual build without the feature can review declarations but refuses
native probe allocation. Select the behavior explicitly in Compose:

```yaml
healthcheck:
  x-hack-http:
    port: 3000
    path: /health
    interval_ms: 1000
    timeout_ms: 500
    retries: 3
    start_period_ms: 0
```

All six fields are required. The declaration cannot mix with command-health settings. Numeric
UID/GID and long-running service readiness are required. Project mounts cannot replace reserved
runtime paths. The engine command healthcheck is disabled only for this explicit declaration.
The graph starts one resident probe after container start and reads bounded status through the
archive API alongside independent container and exec identity checks. No process starts per read.

The graph receipt records configuration, allocation, generation and exec identity. Durable intent
precedes tmpfs creation, exec creation and start. An ambiguous acknowledgement refuses replay.
Each allocation has a root-owned marker and bounded 64 KiB guest tmpfs. Restart verifies the old
container is stopped and its probe terminated before replacing status and generation. Restore
uses fresh allocation and container identities. Cleanup verifies ownership and termination before
unmounting; repeated cleanup is idempotent. Retained incomplete binary publications remain intact.

Live graph evidence: `.hack-local/review/wu07/graph-native-http-1789499758934310000/`.
Three serial controls passed: non-root readiness, supervisor loss becoming unhealthy, same-container
restart, fresh restore, failed init preventing dependent allocation, and driver interruption at
three allocation/exec acknowledgement boundaries followed by owned cleanup. The VM stopped and
protected installed executable/configuration hashes matched. Scoped non-root environment delivery
and fresh managed values on restore also passed; all ten watchdog samples had normal pressure
and unchanged swapouts. The integrated comparison also passes in both lane orders.

The previous 24–25% CPU advantage belongs to the persistent-Bun diagnostic. The new integrated
comparison observes 84.8–85.5% lower engine CPU and 68.5–68.6% lower physical footprint for this
HTTP workload. Real-application acceptance remains separate.

## Verification

The integration passes 151 ordinary Rust tests without optional features and 156 with
`environment-launcher,native-http-probe`, strict Clippy for both configurations, and the three
serial live graph controls above. The CLI gates pass typecheck, lint/privacy and 940 tests with
five skips. Relative documentation links and whitespace checks pass. The default private release
build succeeds with Rust 1.97.1 and the pinned native toolchain. These checks do not establish
hosted CI, release readiness or full Event Agent acceptance.
