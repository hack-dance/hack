# Explicit application bridge capacity

A fresh experimental pool can now opt into private application socket capacity:

```sh
./hack-local runtime up --profile development --bridge-sockets 2 --json
```

This requires a build with `native-stream-relay` (alongside `native-http-probe` for graph probes).
The default build and existing ordinary pool remain without application bridges. Capacity is
1–32 sockets and is immutable for that pool: adding it to an existing unbridged pool or changing
the count returns `bridge_conflict` before admission or provider effects. Omitting the option on
subsequent starts preserves the recorded intent; it does not disable bridges. Unsupported builds
refuse to start bridge-enabled pools. Diagnostic status and owned shutdown remain available.

The pool owner receipt records `application_bridge: { slots: N }` before VM creation. Legacy
unbridged receipts omit the field and retain their existing behavior. Older binaries that do not
understand this field must not be used to operate the experimental bridged pool. No in-place pool
migration or capacity update is implemented.

SmolVM receives exactly N `expose` mappings for `/run/hack-local/bridge-00.sock` through the last
reserved slot. Host destinations use the provider's per-VM directory; callers cannot substitute
arbitrary host paths, guest paths or socket direction. The persisted capability audit requires an
exact match to the owner intent. Boot/access audits also require current-user-owned, non-aliased,
private socket files with one link. Read-only observations detect bridge-intent changes, and the
shutdown proof checks that every declared bridge listener has stopped accepting connections.
These checks supplement existing VM/process/disk/boot identity validation; they are not independent
attestation against a hostile same-user process racing state checks.

## Boundary

Capacity authorizes a transport slot, not a graph destination. This change does not automatically
start a relay, publish a loopback TCP port, assign slots to services, or interpret Caddy labels.
Graph-owned slot reservation, durable relay intent, generation-bound targets, stale-target
invalidation and interrupted-operation recovery remain required before application routing.
General guest networking, host credential mounts and production configuration remain unchanged.

The 32-slot ceiling is an experimental capacity bound, not qualification of 32 concurrent routes
or a promise that it covers every many-branch workload. Measure listener/helper overhead and active
traffic before choosing defaults. No bridge capacity is enabled by default.

## Verification

Regression tests cover capacity bounds, durable owner readback, refusal without receipt changes,
malformed owner capacity, legacy owners, exact provider mapping/count/direction/path matching,
private socket permissions/type, and no runtime effects for invalid or unavailable requests.
A fresh isolated source copy uses the implemented CLI; it no longer patches lifecycle create
arguments to bypass the normal boot contract. The live fixture checks two recorded slots, audit
acceptance, refusal of a capacity change while running, ordinary start reusing the recorded intent,
and HTTP traffic through slot zero across graph cleanup and fresh restore. Explicit relay stop
refuses subsequent traffic. The final control also checks listener absence at VM shutdown and a
fresh VM boot preserving capacity with a different boot identity.

The final control passed 128 exact-body HTTP requests at eight-way concurrency, graph cleanup and
fresh restore, explicit relay-stop refusal, archive/export reconciliation, listener absence after
VM shutdown, and a subsequent audited VM boot with the same capacity and a new boot identity.
All 16 pressure/swapout/reserve watchdog samples passed; the experiment ended stopped.
Evidence: `.hack-local/review/wu07/bridge-intent-1789573392623528000/`.
Isolated executable SHA-256: `c0fa25ae45fcbc2f251713015f3ce26979b99f5cd9a61e04e15fabdbe8a40c3c`.
The relay still required explicit experiment-owned startup/termination. This is functional
qualification, not a new resource/performance comparison or automatic route lifecycle acceptance.

A fresh actual-application plan found 14 services, 22 errors and two warnings; see the updated
[compatibility inventory](application-compatibility-20260915.md). Its configuration remained unchanged.
The existing ordinary pool also refused adding capacity with `bridge_conflict`, without altering
its owner receipt. Default/all-feature Rust tests, strict Clippy, release builds and repository
typecheck/check/test passed. CLI reference regeneration produced no stable-v4 reference changes.
