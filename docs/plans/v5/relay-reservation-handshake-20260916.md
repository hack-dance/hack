# Reservation-bound relay transport

The optional native stream relay accepts `--reservation <32 lowercase hex characters>`, after
optional `--netns PID START_TICKS`. A guarded connection must first send exactly the 36-byte header
`HKR1` followed by that reservation. The relay incrementally checks the header before creating a
backend socket. A mismatch or early EOF closes the connection without contacting the application.
After a matching header and successful backend connection, the client receives byte `0x01` before
application response bytes. The header and acknowledgement do not reach the application.

This binds a host publisher to a specific relay reservation even when the provider reuses a Unix
socket slot. It is a generation discriminator, not a general remote authentication protocol. The
publisher must verify the acknowledgement before treating the stream as established. The existing
unguarded primitive remains available; graph-managed relays have not yet switched to this protocol.
Managed opt-in/persistence and the loopback listener remain the next integration steps.

Handshake storage uses the existing bounded stream buffer. Partial handshakes have a fixed deadline
of the smaller of one second and the configured stream idle limit; receiving more fragments does
not renew that deadline. Existing 32-connection and 16 KiB-per-direction bounds, nonblocking connect,
backpressure, half-close, target-process watch and idle expiry remain in effect. An empty listener
still blocks without a timer. No background process or persistent retention store was added.

## Verification

Host contracts cover fragmented headers with no early backend connection, coalesced application
payload, acknowledgement ordering, transparent replies and half-close. A listener rebound at the
same socket path rejects the previous reservation, rejects an ordinary HTTP preface, times out an
incomplete header and accepts the current reservation. Invalid reservation arguments fail before
socket creation. Existing large-stream, connection-capacity, idle, descriptor, namespace and shutdown
controls remain in the suite.

ARM64 evidence: `.hack-local/review/wu07/relay-handshake-1789581897528252000/`.
Optional-feature candidate SHA-256:
`17a536d62aaac824264475c300adbd9f14e92761eb51c3df9af609e9cf7327ac`.

The fixture copied the current relay executable into a distinct owned tmpfs allocation, pinned it
to the running application namespace, and used the provider's second published Unix socket. A
matching reservation served the application's HTTP token. Verified helper shutdown closed a held
connection and removed its guest socket. A new helper reused that socket with a different
reservation: the old reservation was refused and the new one served HTTP. A partial header closed
in approximately 1.004 seconds as observed through the host/provider bridge.

The helper's user/system CPU counters remained `0 0` across approximately 3.04 seconds while a
quiescent client was held. This is tick-resolution component evidence, not proof of zero CPU usage
or a whole-application comparison with Compose/OrbStack. All seven resource-watchdog samples passed.
The explicit helper allocation was removed after verified shutdown; graph cleanup, fixture volume
removal, archive/export/reconciliation and VM shutdown passed. Protected global configuration was
unchanged. This test stages a helper explicitly; it does not qualify graph-managed guarded startup
or host TCP publication yet.

Default/all-feature Rust suites (including 11 native stream-relay host contracts), strict Clippy,
default release build, repository typecheck/check/test (940 passes, five skips), documentation links
and privacy checks passed. Full verification logs are retained with the live evidence.

## Next integration

Persist the selected transport contract with graph relay intent and refuse to publish an old raw
relay as guarded. Add an owned loopback publisher with exact reservation binding, local port
collision refusal, bounded buffers/connections, stale-slot invalidation and listener/process
cleanup. Verify this through the managed CLI, then extend routing/TLS and matched application tests.
