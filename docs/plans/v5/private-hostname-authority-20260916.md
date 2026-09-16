# Persistent private hostname authority

The candidate adds a foreground Unix HTTP authority:

```text
hack-local runtime serve-hostnames --socket /absolute/private-directory/authority.sock
```

A supervisor must supply a pipe on stdin and keep its write end open. A terminal or
regular file is refused. Closing the owner pipe ends the authority, closes clients
and removes only the socket inode it created. The caller supplies an existing private
owned directory; occupied paths are never adopted or removed. The socket is mode
0600. This is not an installed daemon or automatic runtime default.

The single-threaded nonblocking loop bounds active clients to 32, request headers
to 4 KiB and each connection to one second, including response delivery. It blocks
without an idle timeout when no clients are active. Every accepted request is a
fresh live publication observation; there is no stale-claim cache and no CLI child
process per request. Provider-lock contention returns 503 immediately rather than
waiting or treating the name as unowned.

## Protocol

- `GET /lookup?hostname=NAME` returns the existing point-in-time JSON observation.
- `GET /route` requires one `X-Forwarded-Host` header. Success returns the verified
  private path in `X-Hack-Endpoint` with an empty body, suitable for Caddy's private
  forward-auth lookup. Optional numeric ports are parsed separately from the name.
- Missing or unverifiable publications return 403. Invalid methods, paths, duplicate
  headers, bodies, transfer encoding and malformed hostnames return 400. Oversized
  or expired requests are closed. One response is served per connection.
- Certificate permission (`/ask`) is deliberately absent. A live route alone does
  not establish durable certificate admission/retention authority.

Caddy must strip client-supplied endpoint headers, copy the successful authority's
header and remove that internal header before forwarding to the application. The
socket's private directory is the transport access boundary; it does not add a
separate same-user authentication system.

## Verification

The parser regression covers supported lookups and malformed requests. The actual
process contract checks an occupied socket, slow-client isolation/expiry, oversized
request closure, owner EOF, mode 0600, and preservation of a replacement file.
Managed VM, TLS and performance controls are recorded below.

## Remaining lifecycle gates

Abrupt termination can leave the socket. Startup refuses it, and no automatic
adoption or deletion is implemented. A managed supervisor needs durable process and
socket receipts, verified exit and crash recovery before this becomes a default.
The owner-pipe foreground contract provides orderly lifetime control only.

Every request still performs bounded receipt reads, helper hashing and native process
checks. The provider lock can cause temporary 503 responses during unrelated graph
operations; availability under branch churn remains a parity gate. Safe event-based
invalidation or a read-snapshot design needs separate verification before relaxing
checks. This transport is not application health proof and does not eliminate the
point-in-time boundary of lookup. Managed proxy ownership, certificate budgets,
Compose route/metadata translation, naming/DNS and actual-app qualification remain
open. Full Docker/Compose speed/resource comparisons remain required.

## Completed live qualification

The persistent authority resolved real managed VM publications and returned their
verified Unix endpoints to Caddy. Scoped verified TLS served the application through
Caddy's private forward-auth request; a client-supplied endpoint header was ignored.
After hostname reassignment, TLS served the second service without restarting the
authority. A dead publisher returned 403 through both the authority and TLS path.
Partial/replaced identity controls retained the existing non-mutating refusals.
Holding the actual provider operation lock returned 503, and `/ask` returned 400.

The full publication lifecycle passed with unchanged application token and volume
record across restart. Caddy stopped first, then owner-pipe EOF exited the authority
and removed its socket. The private authority/Caddy home and generated CA were
removed. Final graph cleanup, archive/export and VM down passed; publication state
was empty without a pending journal. All 14 watchdog samples and global protected
hashes passed.

Evidence: `.hack-local/review/wu07/hostname-authority-1789590906295416000/`.
Candidate SHA-256: `f4c94a9129414bbc0c89ce001bc4cdcb5800f18fa7832a7c5369e393ac44e00e`.

In the same bounded fixture, 25 CLI wrapper lookups measured 10.10 ms median,
10.90 ms p95 and 0.199 seconds total child CPU. One hundred fresh Unix HTTP lookups
through the persistent authority measured 0.328 ms median and 0.379 ms p95, about
31 times lower median latency. Both paths performed the full live checks; neither
used a lookup cache. Sample counts differ and this is a sequential microbenchmark,
not application throughput or a matched Docker/Compose comparison.

Authority RSS after the sample was 7,888 KiB (about 7.7 MiB). Displayed cumulative
CPU increased from 0.01 to 0.04 seconds for the 100 requests and remained 0.04 after
three idle seconds. The display resolution and short interval do not prove zero
idle CPU or precise per-request CPU usage. Idle control-path code blocks in poll
with no timer when no client remains.

Default/all-feature Rust suites, strict Clippy, default native-HTTP release and Bun
typecheck/check/tests passed (940 pass, 5 skip). The final default transport contract
also passed, and CLI reference generation left stable-CLI documentation unchanged.
Managed authority crash recovery and branch-churn availability remain required
before any default activation.
