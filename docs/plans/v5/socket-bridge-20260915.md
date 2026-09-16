# Isolated application socket bridge qualification

The optional `native-stream-relay` feature builds a small ARM64 Linux relay and a host contract-test
binary. The relay connects a private Unix listener to one fixed IPv4/TCP destination. It uses one
process, nonblocking I/O and `poll`, with 32 simultaneous connections and two 16-KiB buffers per
connection. Idle connections expire after the supplied timeout (1–60 seconds); an empty listener
blocks without a polling timer. It handles partial writes, backpressure and directional half-close.
It does not log traffic. Occupied paths are refused, and shutdown removes only the socket inode it
created. A wakeup pipe makes termination reliable even if a signal arrives just before an idle
wait. Startup closes inherited descriptors above standard input/output/error. The owning supervisor must supply a private parent directory and validated destination.

This feature is experimental and is not included in the default candidate build. It does not add
a graph route command, publish TCP ports, resolve hostnames or supply TLS. The relay itself has no
graph ownership knowledge: a future supervisor must bind it to immutable container/network IDs,
invalidate stale targets and stop it before target removal or address reuse.

## Live evidence

An isolated source copy added one explicit SmolVM create argument:
`--expose-socket /run/hack-local/route-probe.sock`. The ordinary candidate source, existing pool and
application configuration were unchanged. The pinned provider exposes this guest socket through
its host transport without enabling general guest networking. The experiment audited the provider's
SQLite VM record read-only and found exactly the expected `expose` declaration. Its retained
`agent.config.json` omits published sockets, so the existing boot audit alone is insufficient for
production bridge ownership. No host credential sockets or directories were mounted.

A single owned graph service listened on its guest network interface. Its inspected endpoint was
used as the relay's fixed destination. Both initial startup and fresh restore passed 64 HTTP requests
at eight-way concurrency through the host Unix socket, with exact response-body checks. The host
socket had mode 0700. Each lifecycle checked the relay's executable and process start identity before
termination; subsequent host requests failed. Ordinary cleanup preceded restore, which supplied a
fresh container identity. Final data removal, archive/export reconciliation and VM shutdown passed.
All 18 host pressure/swapout/reserve watchdog samples passed.

Evidence: `.hack-local/review/wu07/socket-bridge-1789530179247259000/`.
Isolated executable SHA-256: `0d3bcd48ae5c0721896754691d310f9afb0e9e80e8551073b262a5a7cbc78cb2`.
Guest relay SHA-256: `7adc7338ccaea4f4a6741587c4445c428a5bbd8b7e2e2519fb81e8e278391516`.
The relay is 25,024 bytes. After requests, its resident set was 520 KiB on startup and
492 KiB after restore, with one thread and six file descriptors. Two five-second idle observations reported unchanged user/system CPU
jiffies (zero). These short functional observations do not establish a comparative CPU or memory
improvement, and provider bridge overhead was not separately measured.

The first attempt stopped safely before boot because the harness expected `stopped` instead of
`uninitialized`. A subsequent attempt passed transport but mistakenly requested full data removal
before restore; the driver correctly refused restore. Cleanup and shutdown passed. The successful
rerun used ordinary cleanup at that boundary. Failed evidence remains alongside the final run.

Host contract tests cover an 8-MiB half-closed stream, 32 concurrent independent payloads, idle
expiry, occupied sockets, unavailable targets, replacement-path preservation and excess-connection
refusal without disrupting 32 existing streams. An inherited-channel regression verifies the
relay does not retain a parent descriptor. Live instrumentation exposed 12 descriptors before
that fix; the final run verifies six. This is a resource-lifetime correction, not a throughput win. Those byte-stream controls ran on the host; the
live ARM64 bridge controls used HTTP. Neither proves WebSocket or long-lived application-session
acceptance across the provider transport.

## QA and remaining integration

The user selected QA and authorized AWS SSO. A fresh read-only STS identity request succeeded with
`livenation_qa`. No credentials were injected into the guest and no application cloud operation ran.
SSO identity verification does not establish application-specific permissions or lease delivery.

Next work is durable audited bridge intent, lifecycle-bound supervision, stale-destination refusal,
loopback port-conflict handling and teardown/recovery controls. Then qualify hostname/TLS routing,
long-lived sessions, outbound application dependencies and scoped expiring credential injection.
The actual application's 21 plan errors remain until those behaviors are implemented and its
selected configuration uses them. No new Compose/OrbStack or stable-Hack benchmark was run here.

Local validation passed: Rust default and full-feature suites (159 and 169 tests before the final
inherited-descriptor regression), all six final relay contracts, strict Clippy for default/all
features, the isolated release build, and repository typecheck/check/test (940 pass, five skip).
The final C-only hardening and added regression passed focused contracts and all-feature Clippy
before the final live run. Documentation links and whitespace checks also passed.

The subsequent [persisted provider audit](provider-config-audit-20260915.md) now rejects unowned
socket declarations before boot. The earlier isolated bridge recipe intentionally no longer boots
unmodified: a production bridge must first supply explicit durable intent that the audit accepts.
