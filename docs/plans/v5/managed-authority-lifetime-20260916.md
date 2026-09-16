# Runtime-bound hostname authority

`runtime serve-managed-hostnames` adds an explicit foreground authority using one
private endpoint derived from the verified pool owner token. It requires an owner
pipe and a running pool. `runtime managed-hostname-authority --json` reports its
endpoint and receipt state without starting it. This is an experimental opt-in;
automatic proxy/authority startup and global trust installation are not introduced.

Managed startup holds the provider operation lock through socket binding and durable
receipt creation. `runtime down` takes that same lock and stops the managed authority
before application publications and guest quiescence, including an already-stopped
pool with leftover host resources. Uncertain ownership or shutdown blocks teardown
and preserves evidence. Unmanaged authorities at explicit arbitrary paths remain
under their existing owner pipe; pool teardown does not discover or stop them.

`runtime stop-hostname-authority --socket PATH --expect-sha256 HASH --json` first
checks the exact receipt, native process identity and socket inode. It registers a
native exit watch before identity verification, then sends a private POST bound to
the server's in-memory receipt fingerprint. The transport has bounded connect/request
timeouts, no proxy, redirects or retries. HTTP status is not completion: the native
exit event and absence of both socket and receipt are required. No PID signal is
sent. A dead owner uses the existing conservative recovery path; uncertain PID reuse
refuses. This control endpoint cannot be selected by the public forward-auth route.

The deterministic empty parent directory remains available for reuse, bounded to
one directory per pool owner. Recovery does not recursively remove it or unknown
contents. Unknown/partial startup receipts still refuse. Unexpected provider death
does not automatically reap an authority; explicit down/recovery and the owner pipe
remain the available lifetime controls.

An actual-child contract covers wrong-fingerprint refusal both through the command
and the transport, followed by verified cooperative process exit and file cleanup.
The bounded TLA+ model in `.hack-local/authority-lifetime-model/` checks startup/down
ordering: nine states preserve no authority after down. Removing the startup lock
produces the expected counterexample (down completes before a previously checked
startup binds). This models the serialization requirement, not all OS/filesystem
behavior or unexpected provider death.

## Qualification

Live evidence: `.hack-local/review/wu07/authority-managed-1789592764988958000/`;
exact isolated candidate SHA-256
`c9b90cb653a70daf8822b0750a22f2efc6595c9746379dc57fd0991e8c1fb4b7`.
The saved protocol runs two actual application services with managed Unix
publications and a private TLS proxy. Duplicate authority startup refused. Crash
recovery, wrong/stale fingerprint refusal, TLS restoration through an unchanged
proxy and unrelated-branch routing checks passed. Runtime down observed authority
exit and removed socket/receipt; startup with a valid owner pipe while the pool was
stopped refused. After reboot, a fresh managed authority served the restored
application with its original persistent token. Explicit fixture data cleanup,
archive/export/reconcile, private proxy/CA cleanup and final stopped readback passed.
The empty per-pool authority directory is retained for reuse as designed.

The first attempt (`authority-managed-1789592687580413000`) exposed a harness
assumption: a retired publication check expected HTTP 403 after pool down had
correctly stopped the authority. The check now distinguishes live-authority refusal
from confirmed authority exit and file absence. Its unfinished graph was cleaned
up and archived/exported in the separate admitted maintenance run
`authority-managed-interrupted-cleanup-1789592750491644000`. The failed attempt is
retained and is not counted as a passing cohort.

All 14 successful-run watchdog samples had normal memory pressure, unchanged
swapouts and required headroom; global protected hashes were unchanged. The 100
fresh Unix HTTP lookups measured 0.354 ms median, 0.394 ms p95 and final authority
RSS 8096 KiB. Displayed CPU stayed at 0.04 seconds across the three-second idle
window. This is component evidence, not full-application CPU or overall runtime
performance. Required local gates passed: default/all-feature Rust tests and strict
Clippy, default release build, Bun typecheck/check/test (940 pass, 5 skip), and CLI
reference generation. An additional actual-child replacement-socket stop refusal
was checked after the live run.

The actual Event Agent plan was refreshed without modifying source/configuration or
its dirty-state fingerprint. Evidence:
`.hack-local/review/wu07/authority-managed-application-1789592654521788000/`.
It remains at 14 services, 22 errors (nine route/owner-label declarations, twelve
unresolved mounts, one external network) and two metadata warnings. Application
startup, credentials, reload, lifecycle, terminal and full resource comparisons
remain unexercised. Managed proxy startup, certificate budget/retirement and route
translation remain the next routing integration work; this unit does not remove
those compatibility refusals.
