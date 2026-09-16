# Reservation-specific TLS upstream control

An isolated Caddy control reproduced a stale routing hazard: a TLS hostname targeting
an ordinary loopback TCP port served a different application after that port was
reused. The existing reservation handshake protects the publisher's guest upstream;
it cannot protect a reverse proxy that reaches an unrelated replacement listener
before that handshake. Managed TLS must not use reusable TCP ports as application
identity.

The optional native stream relay now supports a private Unix frontend:

```text
stream-relay --publish-unix FRONTEND_SOCKET UPSTREAM_SOCKET RESERVATION IDLE_MS
```

It also accepts the existing private `--control PATH TOKEN` shutdown channel. The
frontend requires an absolute path with a private, caller-owned immediate parent;
a symlink parent or occupied socket refuses. The same guarded upstream handshake,
32-connection bound, backpressure, half-close and event-driven idle behavior apply.
Graceful shutdown removes only the socket inode created by that process, leaving
replacements and the upstream intact. This is a foreground primitive, not a new
managed CLI publication mode. The caller must allocate a fresh frontend path per
reservation and never reuse that path for another application.

## Live control

Native Caddy v2.11.4 used an isolated private home, generated fixture CA, high
loopback TLS port, disabled admin endpoint and trust installation. The client
trusted only that fixture's public root certificate. The
[Caddy global options](https://caddyserver.com/docs/caddyfile/options) and
[Unix reverse-proxy upstream syntax](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
were applied with explicit original Host forwarding.

Two fixed TLS names targeted different reservation-specific Unix frontends. With
application A active, its route served A with the original Host and HTTPS forwarded
protocol. The guarded upstream socket and backend TCP port were then reused for B.
The old, still-running A publisher refused the new reservation (HTTP 502). After A
was stopped and its frontend removed, A's unchanged TLS route still returned 502;
B's separate route served B. Default certificate trust, wrong SNI and mismatched
HTTP Host controls refused. No global DNS, trust, runtime configuration or installed
Hack executable was changed.

During one three-second idle sample, Caddy's RSS was 44,624 KiB and each of the two
native helpers was 1,888 KiB. Reported cumulative CPU time did not increase at the
`ps` display resolution. These are short host-only observations, not zero-CPU proof,
VM memory accounting or a matched Docker/Compose performance comparison.

All fixture children exited and were reaped; native sockets and TLS listener were
absent. The fixture's private runtime and generated CA were removed. Protected
Hack configuration/executable hashes were unchanged.

Private evidence:

- TCP counterexample: `.hack-local/review/wu07/tls-routing-1789587616463290000/`.
- Unix control: `.hack-local/review/wu07/tls-unix-1789588026267948000/`.
- Native helper SHA-256: `8a94ef86fef56173d3b04a591f7285d8d05036099b8b2a7ed04c0dd331b52e07`.

## Verification and remaining work

The native regression covers exact 2 MiB streaming, half-close, occupied frontend
preservation, replacement-file preservation, graceful removal, and refusal of
nonprivate or symlink parents. All 18 native contracts pass. Default/all-feature
Rust tests, strict Clippy, default native-HTTP release and Bun typecheck/check/tests
passed (940 pass, 5 skip).

Managed publication still uses its existing TCP mode. Before managed Unix/TLS use,
add durable frontend socket identity and abrupt-death recovery; bind route lifetime
to reservation lifetime; bound proxy configuration/certificate retention; and test
reload, shutdown and crash ordering. Same-user malicious path replacement is not a
security boundary established by this control. Actual VM/app TLS, WebSocket and
streaming behavior, DNS/trust ownership, scoped QA and matched resource benchmarks
remain open. No default feature or supported parity claim changes in this unit.

## Durable frontend identity follow-up

Unix frontend startup now creates `FRONTEND_SOCKET.identity` before reporting ready.
The private, exclusive receipt contains `HKPF1 PID DEVICE INODE RESERVATION` followed
by a newline; both receipt and parent directory are fsynced. A preexisting receipt
blocks startup without overwriting it, and the newly bound frontend is removed.
Graceful shutdown removes only the original receipt inode. Controlled TCP publisher
receipts retain their existing `HKPC1` format through the shared writer.

The added native contract kills and reaps the actual publisher after readiness,
then verifies the exact socket identity and reservation receipt survived. It also
checks occupied-receipt preservation, no false readiness on refusal, and graceful
receipt/socket removal. The test harness removes only its own crash fixture; this
is not proof that managed cleanup supports Unix endpoints yet. Incomplete receipt
writes and a bind-before-receipt crash remain ambiguous and must fail closed.

The next integration must persist frontend mode in managed intent, derive its path
from the reservation, verify this receipt after observed process exit, and cover
normal release, abrupt death, journal recovery, VM down and replacement preservation.
The foreground primitive alone does not enable managed TLS.

Follow-up verification: all 19 native contracts, default/all-feature Rust suites,
strict Clippy, default native-HTTP release and Bun gates passed (940 pass, 5 skip).
The TLS control was rerun with native SHA-256 `22ef923892726290834fb35b8cf40ec103699332807ec060919d83b3055d63ed`
and again passed stale-route, replacement-route, scoped trust and cleanup checks.
Evidence: `.hack-local/review/wu07/tls-unix-1789588384788359000/`.
