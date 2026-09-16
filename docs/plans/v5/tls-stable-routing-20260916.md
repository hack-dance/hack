# Stable TLS routing across branch lifecycle

A fixed shared Caddy configuration can route reservation-derived hostnames to
private Unix publication endpoints without reloading when branches start or stop.
The bounded control passed and avoids the WebSocket disruption observed during
unrelated proxy reloads. This is a verified routing primitive, not complete Hack
hostname or custom-domain parity.

## Routing contract

The fixture accepts exactly 32 lowercase hexadecimal characters as a single label
under `routing-control.hack.test`. An anchored Host regular expression captures only
that reservation, optionally followed by a numeric port. The capture selects a Unix
endpoint beneath a fixed private prefix; arbitrary Host text is never concatenated
into a filesystem path. Strict SNI/Host matching is enabled and the original Host
is forwarded to the application.

In the actual candidate control, the endpoint was the managed path
`/private/tmp/hkp-UID-OWNER12-RESERVATION/frontend`. The native publisher still
verifies the guest reservation handshake. One fixture wildcard certificate covers
all reservation hostnames. Certificate trust is scoped to the test client; this
does not install DNS or modify global trust.

The [Caddy matcher documentation](https://caddyserver.com/docs/caddyfile/matchers)
describes named regular-expression captures. The
[reverse-proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
describes upstream placeholders and Unix transport. Actual adaptation and live
routing were verified against Caddy v2.11.4 rather than inferred from syntax alone.

## Host connection controls

Branch A established a verified TLS WebSocket and echoed masked client text frames.
Starting B returned B's distinct application response while A continued echoing.
Stopping B refused new B traffic while A continued echoing. Reusing B's upstream
slot with reservation C caused an old B publisher to refuse; A remained connected.
Invalid and absent reservation hostnames did not reach either application, and
mismatched SNI/Host returned 421. Retiring A closed its own stream and refused new
A traffic. The admin configuration bytes and ETag stayed identical throughout.
Only one leaf certificate was generated. All processes, native sockets, TLS listener
and generated private runtime/CA were removed after the test.

Evidence: `.hack-local/review/wu07/tls-stable-1789589116342611000/`.

## Actual VM qualification

The existing managed Unix lifecycle control was repeated through this TLS pattern.
One Caddy process with admin disabled stayed running across explicit unpublish,
republish, abrupt publisher death, mismatched-receipt refusal/recovery, bridge
release, VM down, offline unpublish and VM restart. TLS requests after restart
returned the same application token; the complete persistent volume record was
unchanged. Final graph cleanup, archive/export and VM down passed. Protected global
Hack hashes and the memory watchdog passed. The private proxy and generated CA
were removed, and the publication registry was empty.

The first VM attempt incorrectly treated public CA file existence as readiness;
the first TLS handshake failed because certificate setup was not complete. The
harness now waits for a verified handshake. That failed fixture was cleaned up and
its archive/export completed in a separate admitted maintenance boot, followed by
verified down. Neither attempt changed global trust.

Successful VM evidence: `.hack-local/review/wu07/managed-tls-1789589228490450000/`.
Failed-attempt cleanup: `.hack-local/review/wu07/managed-tls-1789589169715230000/`.
Candidate SHA-256: `140f74988b0ad47f641a535279d2656efa8c8d2ba08c7fb37842cbeca7a07395`.
Host helper SHA-256: `22ef923892726290834fb35b8cf40ec103699332807ec060919d83b3055d63ed`.

## Next integration gates

Preserve normal Hack project/service/branch names and custom domains. Reservation
hostnames are not a replacement for that requirement. Next inspect the existing
naming contract and qualify exclusive hostname-to-reservation ownership, atomic
updates, stale-name refusal and connection behavior. Certificate issuance must be
limited to enrolled names with bounded retention; arbitrary Host requests must not
create unlimited certificates or resources. No custom-host routing design is
accepted by this reservation-host control alone.

The Caddy process is still harness-owned. Managed proxy process identity, durable
configuration and recovery, public certificate discovery, naming/DNS integration,
real-app WebSocket/streaming and QA remain open. There is no new CPU/memory performance
claim; a fixed configuration avoids per-branch reloads and uses one certificate in
these fixtures, but matched end-to-end benchmarks remain required.
