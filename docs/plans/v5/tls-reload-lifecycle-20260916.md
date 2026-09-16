# TLS reload and connection lifetime controls

Managed TLS cannot assume a successful proxy reload preserves unrelated branch
connections. An isolated Caddy v2.11.4 control demonstrated that adding an unrelated
route closes an already established WebSocket through a reservation-bound Unix
publisher. This is a concrete multi-branch parity constraint before enabling shared
TLS routing by default.

## Controls and observations

A private mode-0600 Unix admin socket, isolated generated CA and high loopback TLS
port were used. The client trusted only the fixture's public CA certificate. All
application traffic crossed the native reservation handshake and Unix frontend.
The backend performed a WebSocket upgrade and echoed masked client text frames.

- A failed configuration load (unknown handler, HTTP 500) preserved the existing
  configuration ETag, HTTP route and active WebSocket echo.
- A valid unrelated-route addition succeeded and immediately closed the existing
  WebSocket under default settings.
- Reapplying an older configuration with its stale ETag returned HTTP 412 and did
  not overwrite the newer configuration.
- Removing the application route refused new TLS/application traffic and closed
  its existing WebSocket while the publisher itself was still alive.
- With an explicit two-second `stream_close_delay`, the unrelated reload initially
  preserved echo, then closed the stream after 2.002 seconds. This is delayed
  disconnection, not durable connection preservation.
- In that delayed configuration, stopping the retired publisher closed the stream
  in approximately 1.6 ms; publisher retirement need not wait for old proxy config
  expiry to stop branch traffic.

The [Caddy reverse-proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
describes configuration-bound WebSocket lifetimes and the optional close delay.
The [configuration API](https://caddyserver.com/docs/api) supports ETag/If-Match
checks on `/config/` updates. These controls used that API, not `/load` as an
assumed conditional transaction. The measured behavior is specific to the tested
binary and fixture.

All test processes were stopped and reaped, native sockets removed, and the TLS
listener closed. Each generated private runtime/CA directory was removed. Global
Hack configuration/executable hashes remained unchanged; no global trust or DNS
changes were made. Two earlier harness attempts used overly narrow expectations
(HTTP 400 instead of the observed 500, and an HTTP response instead of TLS rejection
after removal); both completed cleanup before the corrected controls were run.

## Evidence

- Default reload: `.hack-local/review/wu07/tls-reload-1789588956553410000/`.
- Bounded delay: `.hack-local/review/wu07/tls-reload-delay-1789588977675915000/`.
- Caddy SHA-256: `07765bfa5cc2b60d3b481c787c2e9d003d5e05e688dffc23ababe5330db18c1b`.
- Native helper SHA-256: `22ef923892726290834fb35b8cf40ec103699332807ec060919d83b3055d63ed`.

Each successful evidence directory contains the exact harness, adapted configuration,
result, cleanup receipt and Caddy log. No CPU/RAM advantage or managed TLS completion
is claimed. This unit changes the qualification plan, not runtime defaults.

## Next bounded experiment

Test a shared TLS configuration whose branch routing can change without loading a
new Caddy configuration. A reservation-derived hostname and Unix endpoint may permit
stable wildcard routing; this is a hypothesis, not an accepted implementation.
Require exact hostname/path validation, scoped trust, old-reservation refusal,
active WebSocket survival when a second branch starts/stops, and complete cleanup.
Custom hostnames and existing Hack naming contracts remain parity requirements even
if a reservation-hostname primitive passes. If stable routing cannot meet those
requirements, evaluate a bounded routing layer and measure its CPU/memory cost.

Managed proxy process identity, startup/recovery journals, configuration/certificate
retention, actual-app TLS/streaming, QA and matched resource benchmarking remain open.
