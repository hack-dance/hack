# Runtime state models

Run `bun run test:models` with Java 17 available and `TLA2TOOLS_JAR` pointing to
TLA+ 1.7.4's `tla2tools.jar`. The runner checks the SHA-256 before executing Java:

```text
936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
```

Official artifact:
https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar

`JAVA_BIN` may select an explicit Java executable. The runner does not install tools
or change global Java settings. CI's Runtime state models job supplies Java and the
pinned artifact. Each check has a 120-second timeout, 512 MiB Java heap, two workers
and bounded output; temporary TLC metadata is removed after success or failure.
No credentials or running VM are needed.

## Graph admission

`graph-admission/Admission.tla` checks the smallest admission race: two clients
competing for one capacity unit. The positive configuration requires the lock
across capacity observation and reservation; the negative configuration removes it.
The positive run must explore all five expected distinct states. The negative run
must produce TLC's invariant-violation exit code, name the `Capacity` invariant and
show both clients occupying the unit. A syntax error, crash, timeout, wrong invariant
or arbitrary nonzero exit is not a successful negative control.

| Model element | Implementation boundary |
| --- | --- |
| `Check` | `provider/graph/admission.rs::check`, under the `OwnedGuest` provider lock |
| `Reserve` | durable preparing receipt and container allocation in graph run/restore |
| `used` | other graphs' retained compute reservations, including exited containers |
| `Retire` | ownership-verified graph cleanup completes before capacity is available |
| `owner` | provider mutation lease held through observation and allocation |
| `Capacity` | combined reservations cannot exceed the admitted capacity |

Paths above are relative to `packages/runtime-core/src/`. The abstraction represents
one capacity dimension; Rust regression tests cover actual CPU, memory and service
limits. It omits crashes, source-job coexistence, engine failures, route lifetime,
filesystem persistence and scheduling fairness. Passing it does not prove those
properties or that all callers hold the lock correctly. Keep the live two-graph
and over-budget controls and ordinary Rust tests as implementation evidence.

When changing admission semantics, review the model and mapping, rerun both controls,
and update expected exploration bounds only with an explanation. Preserve useful
counterexamples as ordinary regression tests. Add recovery and idle/wake models when
their state machines and concrete invariants are defined; do not expand this small
model merely to represent unrelated product behavior.

## Balloon reuse accounting

`balloon-reuse/BalloonReuse.tla` models one guest mapping's unmap, discard,
reuse-accounting restoration, remap, and terminal failure transitions. The positive
model explores seven states. Its invariant requires mapped guest memory to be
outside the host's reusable/discounted accounting state. The negative control omits
reuse accounting and must fail `MappedMemoryAccounted` with both `phase = "mapped"`
and `reusable = TRUE` in the same remap step. Fields appearing in different trace
states, another invariant, or a tool failure do not qualify the negative control.

| Model action | Provider boundary |
| --- | --- |
| `Unmap` | Successful `hv_vm_unmap` in libkrun `balloon_reclaim_range` |
| `Discard` | `MADV_FREE_REUSABLE`; both success and failure are represented |
| `Reuse` | Experimental correction: successful `MADV_FREE_REUSE` before remapping |
| `ReuseFailure` | Refuse a live mapping and stop on failed reuse accounting |
| `Remap` / `RemapFailure` | Successful `hv_vm_map`, or existing fatal remap failure |
| `Stop` | Abstract terminal shutdown of this mapping's owning process |

This is the intended contract for the **experimental correction**, not a claim that
Hack's currently pinned provider implements it. The pinned libkrun commit
`5de9ab51c1bb166af2324de3c9413d00022eb178` omits reuse advice in
`src/hvf/src/lib.rs::balloon_remap_if_reclaimed`. The native accounting control and
initial matched guest results are recorded in the
[provider investigation](../../../docs/plans/v5/balloon-guarded-pair-20260916.md).

The model abstracts the serialized reclaim-map lock and one mapping. It omits PFN
sorting, overlapping ranges, mapping geometry, multiple vCPUs, real kernel return
codes, physical residency, persistent data, performance and process restart. A
passing model cannot replace native accounting, mapping-boundary or guest readback
tests, and must not turn an apparent footprint reduction into a RAM-savings claim.
