# Graph-owned bridge reservations

This report records the reservation-only qualification. The subsequent
[managed relay lifecycle](graph-relay-lifecycle-20260916.md) extends the receipt phases and adds
explicit startup plus owned stop/removal to release and graph cleanup. The boundaries below
describe the earlier reservation-only version, not the current optional-feature integration.

Healthy guest endpoints now expose a generation fingerprint that includes pool ownership, graph
attempt/plan/service, VM boot identity, container ID and start time, network/endpoint IDs, address
and port. Restarting the same container changes this generation even when its ID/address remain.
The fingerprint is an observation, not a durable connection authorization or reachability proof.

Pools with explicit bridge capacity support these experimental commands:

```text
hack-local graph reserve-bridge --run-id <run> --service <service> --slot <index> --expect-generation <generation>
hack-local graph bridges --run-id <run>
hack-local graph release-bridge --run-id <run> --slot <index> --expect-reservation <reservation>
hack-local graph reconcile-bridges --run-id <run>
```

Reservation re-inspects the owned graph under the provider operation lease. It requires a committed,
currently healthy endpoint and the exact expected generation. It refuses occupied slots, duplicate
service reservations and out-of-capacity slots. The durable assignment records graph/service,
container/network identities, VM boot, generation and a fresh random reservation token. Release
requires the exact graph/slot/token, so an old request cannot release a later reservation.

`graph bridges` reports whether each committed reservation still matches the observed endpoint.
A stopped/unhealthy/restarted service has no matching current assignment. A detected inconsistent
network attachment still produces the existing identity refusal. Nothing automatically rebinds to
a replacement target. Graph cleanup releases its own reservations before deleting resources;
restore does not automatically recreate them. Stale reservations retain their slots until explicit
release or owned graph cleanup.

## Durable state and recovery

The private pool registry is `run/bridge-assignments/state.json` under candidate state. It is bounded
at the pool's capacity (at most 32 assignments) and 64 KiB, and validates owner, resource identifiers,
unique reservations/services and phase. Only `reserved` is accepted. Future active/uncertain relay
phases must add explicit termination/recovery handling; they cannot be treated as these reservations.

Writes use the existing exclusive pending-file, fsync and atomic-rename protocol. An interrupted
pending journal blocks reuse, inspection and graph cleanup. Explicit `reconcile-bridges` preserves
the exact interrupted bytes in one of eight bounded recovery slots without replay, and retains the
last committed state. If retention fills, it refuses rather than deleting earlier evidence.
No file, socket, process or persistent volume is deleted by reservation reconciliation.

## Boundary before normal route publication

These commands reserve capacity only. They do not launch the native relay, bind loopback TCP ports,
proxy requests, or continuously monitor endpoint identity. `current: true` is a point-in-time
observation. It does not close the inspection-to-connect race, and these receipts must not yet be
used as automatic relay-launch authority. The next implementation must bind relay lifetime to the
graph generation, prevent connections to reused addresses, stop on ownership loss, and reconcile
interrupted start/stop before reusing a slot. TLS/hostname routes and real application acceptance
remain open.

## Qualification

The isolated two-slot control reserved a healthy service, refused duplicate/out-of-capacity
assignments and incorrect release tokens, and ran its separate experiment-owned HTTP relay.
The relay was explicitly stopped before a same-container restart. Restart preserved container ID
but changed endpoint generation; the old assignment reported `current: false`, and reserving with
the old generation was refused. A new reservation had a different token, and the old release token
could not remove it.

An injected partial reservation journal blocked graph cleanup while the container remained running.
Reconciliation preserved the exact bytes and retained the committed replacement assignment without
replay. Ordinary cleanup cleared the assignment; fresh graph restore rejected the earlier generation
and admitted a fresh reservation. Final data removal, archive/export reconciliation, listener
shutdown and a subsequent VM restart/shutdown passed. All 17 pressure/swapout/reserve watchdog
samples passed. The experiment finished stopped.

Evidence: `.hack-local/review/wu07/bridge-assignment-1789574130101947000/`.
Isolated executable SHA-256: `2071b643d0ce60b584bfd87e7af2b8aa6eef7883d82595a4c20e063dfa4f8455`.
The actual relay remained manually controlled by the fixture; this does not qualify automatic relay
invalidation. No comparative performance or footprint claim is made by this unit.

Default/all-feature Rust suites, strict Clippy, release builds, repository typecheck/check/test,
CLI reference generation and documentation link checks passed. Additional boot/graph identity
and CLI-argument controls passed after the live fixture; runtime behavior was unchanged. A fresh
actual-application plan still reports 14 services, 22 errors and two warnings, with its source
configuration unchanged. Evidence:
`.hack-local/review/wu07/bridge-assignment-application-1789574388512287000/`.
