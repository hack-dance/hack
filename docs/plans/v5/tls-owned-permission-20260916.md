# Caddy-owned certificate permission transport

The pinned Caddy v2.11.4 [HTTP permission implementation](https://github.com/caddyserver/caddy/blob/v2.11.4/modules/caddytls/ondemand.go)
accepts an HTTP URL rather than a configurable Unix transport. A bounded host-only
experiment therefore puts the permission HTTP listener inside the same Caddy process
as TLS, forwarding `/ask` to the private Unix authority. Application requests still
use live forward-auth lookup; certificate possession is not route permission.

The permission site must explicitly `bind 127.0.0.1`. The initial version used a
loopback site address without `bind`. On this macOS host it started successfully
while another socket occupied that IPv4 port; its wildcard listener was not proof
that it owned the endpoint used by HTTP permission calls. The collision control
correctly failed the experiment. A repeat captured startup logs; both bounded
processes were killed/reaped by the subprocess timeout path, and their private
homes, native children and listeners were cleaned up. Failed evidence is retained:
`tls-owned-permission-1789593063010600000` and
`tls-owned-permission-1789593125973655000` under `.hack-local/review/wu07/`.
The failed-run cleanup field `caddy_exited:false` describes the never-started normal
Caddy variable; the timed-out collision subprocess was separately killed/reaped.

With the explicit IPv4 bind, an occupied permission port produced a nonzero startup
exit. The successful unchanged Caddy configuration served normal and custom names
through reservation-bound Unix publishers, refused spoofed routing headers and
unknown TLS names, and preserved A's WebSocket across B's start/retirement.

The prototype authority stored admission in SQLite with full synchronous commits
before returning permission. The two-name budget survived closing/reopening the
store and restarting the Unix authority. A third enrolled route could not obtain a
certificate before or after that restart. Retiring B did not refund its consumed
slot; its cached certificate could not route. Authority loss denied new issuance
and cached-certificate application requests. Exactly two leaf certificate files
existed after the controls. This is a distinct-name admission bound, not proof of
bounded certificate bytes or a complete renewal/retirement policy.

Successful evidence: `.hack-local/review/wu07/tls-owned-permission-1789593174497876000/`.
The saved protocol/config, native/Caddy hashes, result and cleanup receipts describe
the exact fixture. Private CA/home, listeners, native sockets and processes were
removed; global protected Hack hashes were unchanged. No VM or actual application
was started, and no global trust was installed.

## Remaining implementation gates

This is a Python/SQLite protocol experiment; the Rust authority still has no
certificate permission endpoint. Implement its durable bounded admission and
inspection, including partial-write recovery and conservative refusal. Qualify
proxy restart and stored-certificate reuse separately from authority restart.
Add byte accounting, renewal and reference-aware retirement before claiming bounded
long-lived TLS storage. The managed proxy must validate ownership/readiness of both
listeners and prevent configuration changes from separating permission-listener
lifetime from TLS. This experiment's private admin endpoint was used only to prove
unchanged configuration; it is not an authorization to expose mutable management.
Compose route translation, DNS/trust ownership and full application parity remain
open. No overall performance claim follows from this transport control.
