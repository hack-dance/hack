# Verified guest endpoint discovery

`graph inspect` now includes a `guest_endpoints` map for healthy services with native HTTP probes.
Each entry contains the current container ID, network ID, private IPv4 address and probe port.
It is explicitly marked `scope: guest-only` and `reachability: not-probed`.

Discovery requires a committed ready receipt, no pending journal, an observed running/healthy
service, and recorded immutable resource IDs. Existing inspection verifies resource ownership,
names, images and network type. The endpoint resolver additionally checks both the container's
attachment and the network's membership record, including endpoint ID and address. An extra or
inconsistent attachment is refused with `graph_endpoint_identity`. Missing, stopped and inactive
resources do not advertise endpoints.

This does not publish a host port or replace Caddy. A loopback health check can remain healthy
after a container loses its network attachment. Host routing must separately establish interface
reachability and revalidate ownership before using a destination; these observations are not
durable connection authority. No command, environment value or raw engine configuration is added
to the inspection result. The existing one-inspection-per-resource request count is unchanged.

## Qualification

The guarded live fixture ran 32 services with 32 native HTTP probes. Inspection returned 32
destinations bound to the inspected container/network IDs. Deliberately disconnecting one owned
container caused discovery to refuse the inconsistent attachment. Cleanup still completed and
returned an empty endpoint map. Restore created fresh container/network identities and returned
32 new bound destinations. The detach/refusal and cleanup checks passed again after restore.
Archive, export and export reconciliation passed, and the VM was stopped. All 24 host watchdog
samples passed pressure, swapout and reserve checks.

Evidence: `.hack-local/review/wu07/guest-endpoints-1789526228154204000/`.
Executable SHA-256: `6172ab826b9b8302c63f838673d9d5f3f4d3895d3b1a8b87ebc113a9e5bd613c`.

Unit controls reject foreign attachments, mismatched network/endpoint IDs, missing membership,
address disagreement, invalid prefixes, non-private/IPv6 addresses and port zero. The Rust default
and feature suites, strict Clippy, release build and repository typecheck/check/test gates passed.
Additional address-boundary cases passed the focused test after the live run. This is functional
qualification, not a new performance comparison.

## Remaining route work

The [isolated socket bridge control](socket-bridge-20260915.md) now proves HTTP transport through
the pinned provider. The current candidate boot contract does not configure an application bridge. Next is an explicitly owned bridge and loopback publisher,
with provider-config auditing, port-conflict refusal, stale-destination invalidation, teardown and
restore tests. TLS, hostname routing and the application's nine Caddy declarations remain open.
The actual application has not been started or silently converted to candidate routes.
