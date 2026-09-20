# Model review

Use this when deriving a model from code or changing its shape.

Describe the intended property independently of the current implementation. Map actions to source operations and state why each is atomic. A lock, syscall, or sequence of writes is not automatically one indivisible action: expose relevant scheduling and crash boundaries. Include release/reuse, failed publication, cancellation, and stale ownership when they can violate the property.

When adding a variable, update declarations, `Init`, the state tuple, type invariant, and every branch of every action. An auxiliary observation should not accidentally constrain existing transitions.

When splitting an action, represent the intermediate state, preserve intended data dependencies, update `Next` and types, and re-evaluate interleavings and fairness. Splitting can change behavior; do not describe it as semantics-preserving without checking that claim. Choose routine names from context rather than pausing for approval.

Avoid vacuous checks: confirm nonempty initial states, reachable interesting transitions, and a negative control that violates the intended invariant. State constraints and small bounds can hide failures; document them. Never remove a failing transition, weaken an invariant, or add fairness merely to get a green run.

Evidence should connect property → model action → source operation → regression test. Keep genuine implementation defects separate from abstraction mistakes. Exhaustive checking of a finite instance, bounded symbolic checking, observed trace conformance, and a general proof are different claims.

Inspiration: [TLA+ AgentSkills](https://github.com/tlaplus/AgentSkills), especially source modeling, adding variables, and splitting actions. Apply selectively: broad exclusions of memory/error handling do not fit reclamation or crash-recovery work.
