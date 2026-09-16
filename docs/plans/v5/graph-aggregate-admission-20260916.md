# Aggregate active graph admission — September 16

Graph run, restore and restart now account for aggregate container limits instead of
reserving the entire workload slot for one acknowledged graph. The combined budget
remains four CPUs, 4 GiB container memory and 32 services in the development profile.
The existing per-service limits and 64-retained-attempt bound remain in force.

Admission holds the provider mutation lease through inspection, durable intent,
creation and start. Other acknowledged graphs contribute the actual CPU and memory
limits read from their ownership-verified containers. Exited containers continue to
reserve their limits until explicit cleanup. Missing, unbounded or unsupported
limits, missing containers, incomplete journals and uncertain graph phases refuse
new work. Ordinary stopped-data-retained and fully removed graphs no longer reserve
compute. Restart also checks that its existing container limits match the reviewed
configuration before starting them again. Source jobs retain their existing exclusive
reservation rule; this does not enable source-job/graph concurrency.

Routing/bridge slots remain separately bounded. Admission does not automatically
pause, evict or delete another branch, and does not treat guest or host idle memory
as proof of available allocation capacity. Host admission and runtime identity checks
remain in force. Arbitrary direct engine mutations are outside this scheduler's
supported contract.

A small TLA+ model in `.hack-local/graph-admission-model/` checked serialized
check/reserve against a one-unit budget: five distinct states passed. Removing the
lock produced a counterexample with both clients checking empty capacity then both
reserving it. This validates the abstract lock requirement, not the entire runtime.
Regression tests cover CPU, memory and service-count boundaries, missing limits,
unbounded limits and changed restart limits. Full/live results follow.

## Verification

Rust default/all-feature tests and strict Clippy passed. The default release build
and Bun typecheck/check/test passed (940 passed, 5 skipped).

Live evidence:
`.hack-local/review/wu07/graph-aggregate-admission-1789598597243054000/`.
Candidate SHA-256:
`33bf794257021a7475e1d4f69903b54ae9464a83857aaa58d04194be6d0a9dc8`.
Two two-service graphs ran simultaneously, each reserving 0.2 CPU and 128 MiB.
Both private bridge slots served distinct persistent UUID tokens. A third graph
requesting four CPUs was rejected with `graph_capacity_reserved` before its attempt
directory existed; both existing graphs still served their original tokens.

Ordinary cleanup of the first graph preserved its volume while the second stayed
reachable. Restoring the first succeeded alongside the second and preserved the
first token. Explicit first-graph removal left the second reachable with its token
unchanged. Final explicit cleanup removed both graphs' volumes, retained the reusable
image, archived/exported their evidence and stopped the VM. Six watchdog samples
showed normal memory pressure and unchanged swapouts; protected global hashes were
unchanged.

This qualifies two concurrent active graphs and resource-budget refusal, not 32
branched worktrees or idle suspension. Still open: larger branch registration and
wake tests, observed admission latency/fault budgets, source-job coexistence policy,
and application-level concurrency/CPU/memory comparisons. Configured limits are
reservations, not measured resident memory or a promise of equal performance.
