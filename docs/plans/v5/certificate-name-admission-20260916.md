# Durable certificate-name admission

The experimental managed authority accepts an explicit
`--certificate-name-limit N` (1–4096). Without the flag, certificate permission
remains disabled. With it, `/ask?domain=NAME` requires a verified live publication,
a durable admission slot and a second unchanged live observation before success.
Routing still independently verifies ownership on every request, including requests
using cached certificates. This does not configure a global proxy or install trust.

The budget is bound to the pool owner and serialized by a separate lifetime lock.
Its private JSON history is at most 1 MiB; the atomic pending write, file fsync,
rename and parent fsync complete before permission is returned. Repeated admitted
names do not consume another slot or rewrite history. Restart must use the same
recorded limit. The receipt survives authority and VM down, and names are not
refunded when publications retire or issuance fails. A refused post-commit live
recheck may therefore conservatively consume a slot. No capacity reset, certificate
cleanup or automatic deletion is inferred from lack of a current publication.

Partial/pending, malformed, foreign-owner, changed or oversized history refuses
admission, including names admitted earlier. An existing budget directory without
its committed history cannot initialize a fresh empty budget. Crash recovery of
partial budget writes and explicit reviewed limit changes remain open; refusal
preserves the evidence. Normal live routing does not require certificate admission
history, so corrupt history prevents new permissions without treating cached
certificates as permission to bypass routing checks.

`runtime certificate-admission --json` inspects admitted names, configured limit,
remaining capacity and receipt ceiling. Its scope is admission history, not actual
certificate files/bytes, renewal accounting or resource reclamation. Admission
inspection is read-only and cannot enable issuance.

The closest regressions cover duplicate-name reuse, limit persistence, concurrent
writer refusal, changed-limit/owner refusal and partial/corrupt history. The existing
transport contract retains refusal of `/ask` when the feature is not enabled.

The selected proxy topology is the previously qualified
[Caddy-owned permission listener](tls-owned-permission-20260916.md). Keep an explicit
loopback bind and a fixed process/configuration lifetime; a bare site address is not
proof of listener ownership. Certificate byte accounting, renewal/retirement,
managed proxy activation, Compose route translation and real-app acceptance remain
open. A name count alone is not proof of bounded long-lived certificate storage.

## Live qualification

Evidence: `.hack-local/review/wu07/certificate-admission-1789593596683126000/`.
Exact isolated ARM64 candidate SHA-256:
`e6218c87a7238fec654187edd9529dee8b835a990d87db26362480f5313de655`.
The saved protocol uses an actual two-service VM graph, three live names on a
managed Unix publication, a two-name budget, and a Caddy-owned explicitly bound
permission listener forwarding to the Rust authority.

- Two names received scoped TLS certificates; the third live name was denied.
- A test-owned partial pending budget denied permission for an already admitted
  name while ordinary live lookup continued. Exact fixture restoration recovered
  admission without refunding slots.
- Proxy restart reused the same two certificate files (identical path/content
  hashes). Authority crash/recovery/restart and later VM down/up retained the same
  budget. Third-name issuance remained refused.
- Retirement/rebind denied cached-certificate routing for the retired custom name.
  The application data token survived VM restart and graph restore.
- Managed authority shutdown, publication cleanup, graph archive/export/reconcile,
  proxy/listener shutdown, private CA/home removal and final stopped readback passed.
  Admission history remains intentionally retained, with two consumed slots.

All 14 watchdog samples met pressure/swap/headroom requirements, and protected
global hashes were unchanged. The 100 fresh Unix lookup requests measured 0.355 ms
median, 0.376 ms p95 and final authority RSS 8240 KiB; displayed CPU remained at
0.04 seconds during the three-second idle window. These are lookup observations,
not certificate issuance throughput or an overall Compose performance comparison.
Required checks passed: default/all-feature Rust tests and strict Clippy, default
release build, Bun typecheck/check/test (940 pass, 5 skip), CLI reference generation,
and an additional focused missing-history refusal regression.

The actual application plan was refreshed in
`.hack-local/review/wu07/certificate-admission-application-1789593674025153000/`.
It remains incompatible at 14 services, 22 errors and two warnings; source/config
and dirty-state fingerprints are unchanged. This checkpoint does not remove its
nine route-label, twelve unresolved-mount and one external-network blockers or
prove application startup, reload, terminals, credentials or resource parity.
