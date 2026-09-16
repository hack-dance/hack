# Normal and custom hostname routing control

The stable reservation-host primitive does not preserve Hack's normal URL contract.
Source review of `src/lib/branch-hosts.ts` and its regression tests establishes:

| Input | Branch | Effective hostname |
| --- | --- | --- |
| `demo.hack` | `feature-x` | `feature-x.demo.hack` |
| `api.demo.hack.gy` | `feature-x` | `api.feature-x.demo.hack.gy` |
| `api.demo.hack` | `api` | `api.api.demo.hack` |
| `api.feature-x.demo.hack` | `feature-x` | unchanged |
| `external.example.com` | `feature-x` | unchanged |

Lists preserve order and deduplicate after rewriting. Runtime metadata uses these
names for project/service URLs and preserves explicitly declared environment keys.
The candidate's Compose parser still rejects existing router/ownership labels;
this experiment does not remove those compatibility errors or adopt labels.

## Bounded protocol experiment

An isolated in-memory lookup mapped `api.feature-x.demo.hack` and
`custom.example.test` to different reservation-bound native Unix publishers. A
single unchanged Caddy configuration consulted it before application proxying and
before on-demand internal certificate issuance. The fixture limited lifetime
admission to two distinct names, even after a name was retired. This intentionally
conservative cap prevents unbounded issuance in the fixture; it is not a product
retention policy.

Caddy stripped any client-supplied endpoint header before the lookup, copied the
successful lookup's endpoint, and removed that internal header before proxying.
A denied lookup terminated the request. The lookup returned paths only from its
enrolled map, never by concatenating arbitrary Host input into a filesystem path.
Strict SNI/Host checking and scoped client trust remained enabled.

Verified controls:

- Normal branch and custom hostnames served distinct applications with the original
  Host and HTTPS forwarding metadata.
- Enrolling another owner for an occupied hostname was refused, as was a third
  distinct name after reaching the two-name lifetime cap.
- A's WebSocket continued echoing while B was enrolled, started and retired.
- Retiring B denied new requests even though its certificate was cached and its
  publisher still existed. A spoofed endpoint header could not bypass denial or
  redirect A to B.
- Eight unenrolled TLS names were rejected. Exactly two leaf certificates existed
  after all controls; no proxy configuration/ETag change occurred.
- Reusing B's upstream slot for a different reservation still failed closed.
- Retiring A's publisher closed A's existing stream. Processes, sockets, listeners
  and generated private CA/runtime directories were removed; protected global Hack
  hashes were unchanged.

The configuration uses documented
[forward-auth response header copying](https://caddyserver.com/docs/caddyfile/directives/forward_auth)
and [on-demand TLS permission checks](https://caddyserver.com/docs/caddyfile/options).
This is a lookup transport experiment, not a new authentication feature.

Private evidence: `.hack-local/review/wu07/tls-hostname-1789589440578982000/`.
Caddy v2.11.4 SHA-256: `07765bfa5cc2b60d3b481c787c2e9d003d5e05e688dffc23ababe5330db18c1b`.
Native helper SHA-256: `22ef923892726290834fb35b8cf40ec103699332807ec060919d83b3055d63ed`.
The exact harness, adapted config, results and cleanup receipt are retained privately.

## Implementation acceptance criteria

The prototype's lookup is an in-process Python map and a loopback HTTP server. It
is not durable, independently supervised or suitable for managed activation. A
reused authority TCP port must not let another process authorize routes or
certificates; use owned private transport where supported and bind proxy lifetime
to proven authority identity. Cached certificates never substitute for a live
hostname ownership check on application requests.

Next implement explicit bounded hostname leases tied to candidate, project/run,
service, generation and reservation. Require normalized-name conflict detection,
compare-and-swap retirement/rebinding, immutable endpoint derivation, durable
recovery and process-exit ordering. Preserve current name rewriting and custom-name
behavior; do not silently convert all users to reservation URLs. Carry forwarding
metadata and declared-environment precedence into real-app acceptance.

Certificate admission/retirement needs a persistent budget, safe reuse, cleanup
receipts and disk accounting. The two-name in-memory cap does not prove a long-lived
certificate store is bounded across restarts. Measure the per-request lookup's CPU,
latency and memory before choosing it over alternatives; this unit provides no
performance improvement claim. Managed proxy/authority integration, Compose label
translation, DNS/trust ownership and actual-app QA remain open.
