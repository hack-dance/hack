# Experimental runtime stream framing

This candidate protocol carries application bytes and explicit half-close events
across a mounted Unix/vsock transport. It does not authenticate a service, authorize
an owner or bind a VM boot. Production callers must establish those contracts before
forwarding any application bytes. There is no public CLI or application alias support
attached to this codec yet.

## Wire format

Every frame begins with an eight-byte header: ASCII `HKF1` (four bytes), kind (one
byte), then an unsigned big-endian payload length (three bytes).

| Kind | Value | Payload | Meaning |
| --- | --- | --- | --- |
| DATA | 1 | 1–16,384 bytes | Ordered application bytes in this direction |
| FIN | 2 | Empty | This application's sending half has ended |
| RESET | 3 | Empty | Abort the whole flow; never graceful EOF |

Unknown versions/kinds, zero-length DATA, oversized lengths and nonempty control
frames are errors. DATA and repeated FIN after FIN are errors. RESET may follow FIN
because the other application direction can still fail. Nothing may follow RESET.
Any decoder error is terminal. Raw transport EOF before an explicit complete FIN,
or during a partial header/payload, is truncation rather than application EOF.

## Buffer and delivery ownership

`provider::relay_frame::Decoder` owns one fixed buffer. `push` consumes at most one
frame and reports how many input bytes it used; the caller retains the remainder.
The returned DATA slice borrows the decoder. Drain or safely queue those bytes before
calling it again, and bound that queue independently. Header validation precedes
payload buffering. The encoder validates state and emits at most 16,392 bytes; its
caller must preserve output order and abort on an undeliverable encoded frame.

FIN must reach the application write half only after all preceding DATA has drained.
Continue forwarding the other direction until its FIN or a RESET. Do not translate
FIN into write-half shutdown of the mounted transport: the pinned native provider
path lost buffered bytes under that operation. RESET must cancel both directions
and release only owned flow resources. The codec does not implement that event loop,
connection admission, cancellation, authentication or durable lifecycle ownership.

## Verification

Portable codec tests include independent wire vectors, every split of a small frame,
bytewise maximum-size payloads, coalescing/backpressure, malformed lengths, terminal
states and every truncated prefix. Run the focused Rust filter `provider::relay_frame`.

The ignored macOS integration fixture `mounted_frame_probe` additionally needs an
explicit, fresh private `HACK_LOCAL_FRAME_ROOT` and an external owned-VM watchdog.
Build its static ARM64 guest client from
`packages/runtime-core/tests/fixtures/mounted-frame-client.c` with the pinned Zig
compiler. The fixture uses the real codec and `HostEndpoint` guard to send guest
DATA/FIN to a synthetic TCP server that waits for EOF before echoing 64 KiB.
Two exchanges (including one after VM restart) must pass; an oversized header must
produce RESET without opening a third upstream connection. The fixture is bounded
and sequential; it does not qualify a production asynchronous or multiplexed relay.

A native run against pinned SmolVM 1.14.3 passed these controls with recorded
networking disabled, no raw transport shutdown, and complete owned fixture cleanup.
No throughput, latency or resource improvement is inferred. Owner/boot revocation,
authentication, actual application aliases/TLS, bidirectional backpressure under load
and matched workload benchmarks remain required gates.


The separate [authorization primitive](runtime-relay-auth.md) provides mutual
capability proofs and revocable effect admission. It is not yet wired to the native
framing fixture or a production relay. Frame integrity, private guest provisioning
and actual owner/boot lifecycle registration remain required integration gates.
