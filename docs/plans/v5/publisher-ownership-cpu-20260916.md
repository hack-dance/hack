# Publisher ownership experiment and buffer-reset benchmark

Two bounded follow-ups were completed against the native loopback publisher from `2fa76b34`.
No production behavior changed. Full-buffer clearing remains the default because the tested
state-only reset did not demonstrate a CPU or latency improvement.

## CPU experiment

Both variants were compiled with the repository host flags (`-O2 -std=c11 -Wall -Wextra -Werror`).
The only source difference was clearing connection metadata instead of zeroing the full flow
structure on release. Each cohort ran 5,000 sequential TCP connections with a 64-byte request,
through the native publisher and an in-process Unix test server. Three paired cohorts per mode
alternated variant order. Valid requests checked exact response bytes; rejected handshakes checked
that no response/application payload was accepted. All 60,000 connections in the corrected cohort
completed their assertions.

CPU is the helper child's reaped user+system usage (`RUSAGE_CHILDREN` deltas), including startup and
shutdown. The Python client/server run in the parent and are excluded from that CPU figure, while
wall time includes their scheduling. These are component measurements on the current Mac, not
whole-application or Docker/Compose comparisons.

| Mode | Baseline median CPU | State-only median CPU | Median wall, baseline → state-only |
| --- | ---: | ---: | ---: |
| Valid request | 0.220845 s | 0.224288 s (+1.6%) | 0.5140 s → 0.5147 s |
| Rejected handshake | 0.143911 s | 0.144232 s (+0.2%) | 0.4073 s → 0.4228 s |

Paired CPU changes were +0.43%, +2.14%, +0.37% for valid requests and +1.79%, +0.22%, −2.12%
for rejected handshakes. This small cohort is not evidence of a statistically established regression,
but it gives no reason to adopt state-only clearing. About 85% of baseline helper CPU was system
time in this connection-churn fixture. That observation does not locate the whole application's
CPU cost or establish that HTTP is the bottleneck. Profile real workloads and connection reuse
before selecting another transport optimization.

An earlier client-active-close attempt exhausted macOS ephemeral ports (`EADDRNOTAVAIL`). Its
partial samples are excluded. The corrected fixture lets the server close completed requests and
keeps connection teardown as the measured operation. Every helper was terminated and reaped, and
the test Unix sockets/directories were removed. This does not claim that kernel TIME_WAIT entries
vanished immediately. No VM or application volume was created by these experiments.

## Foreground exec ownership experiment

A private launcher took an exclusive operation lock with close-on-exec, recorded its own native
PID/UID/start time using the same libproc fields as the runtime, and waited at a test gate. The
negative control killed only this unreaped direct child before exec. No listener appeared and the
lock became available.

The positive control exec'd the native publisher in place. Independent libproc observation verified
the same PID, UID and start timestamp, with the executable path changed to the expected helper.
The operation lock was available after exec. Verified direct-child shutdown released the loopback
port. This supports a foreground managed-launch design where identity intent precedes exec, avoiding
the unrecorded-child window of detached spawning. It is not yet a managed CLI implementation.

Remaining lifecycle design must cover durable intent, executable staging/ownership, interruption
before and during exec, port conflicts, exact-reservation cleanup, VM-down behavior and offline
retirement. Startup identity continuity alone does not authorize signalling an arbitrary PID. macOS
has no pidfd-style atomic identity-and-signal primitive in the existing runtime; a private native
control channel or equivalent lifecycle authority needs qualification before claiming strict
cleanup isolation. No global process, configuration or installed Hack was changed.

## Evidence

Private evidence: `.hack-local/review/wu07/publisher-ownership-cpu-1789583527095916000/`.
It contains both source/binary variants, complete corrected raw samples, the excluded attempt log,
summary calculations, and the ownership probe source/results. The benchmark and both ownership
controls exited successfully. This documentation-only unit requires no repeat of unrelated runtime
suites; the source/native tests from the preceding implementation remain their original evidence.

Next: implement the managed publisher lifecycle using the verified startup contract and explicitly
resolve stop/cleanup authority. Same-boot relay recovery improvements, routing/TLS, QA application
parity, matched benchmarks, disk retention and branch suspension remain open.
