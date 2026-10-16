---
name: hack-repo-work-unit
description: Define acceptance criteria and feedback loops for multi-step Hack repository work, stateful changes, and bounded experiments.
---

# Work units and feedback loops

For a small fix, the request, patch and focused check can be the whole work unit.
For a stateful change, experiment or multi-step task, record a compact contract in
the existing plan or issue before dependent execution:

```text
Goal: observable user outcome and boundary being changed
Acceptance: success behavior, relevant rejection/recovery behavior, measurable limit
Context: source/contract and current baseline; unknowns that affect correctness
Constraints: compatibility, resource budget, isolation and authorization
Evidence: command or observation for each acceptance criterion; what could falsify it
Artifact: patch/docs/report and location of durable results
Exit: completion criteria, experiment budget and any external evidence still required
```

For v5, maintain [work-units.md](../../../docs/plans/v5/work-units.md). Do not overwrite
an earlier objective when a new message adds a follow-up. Capture actionable new work
once with a verification path; do not generate tickets or a second ledger by default.

## Choose the feedback loop

Start with the behavior that could fail. Select the closest independent observation:
CLI output/exit code, persisted readback after restart, a rejected stale owner,
service-level readiness, source-to-model mapping, or measured process-tree usage.
Use the [verification skill](../hack-repo-verify/SKILL.md) to find the existing harness.

Check that the oracle can fail for the intended reason. A known defect or negative
control should trigger the expected signal; a crash, timeout, skip or unavailable
provider must not count as a successful rejection test. Avoid assertions that only
repeat implementation constants or accept the output the implementation just wrote.

For state changes, cover the relevant interleaving, interruption and resume with
data readback. Add TLA+ when a small concurrency/recovery question benefits from
state exploration; ordinary tests are enough for simple deterministic transformations.
Carry useful counterexamples into implementation regression tests.

## Bounded experiments

Write the hypothesis and expected metric change before running. Name the workload,
baseline, source revision, host/runtime, warm/cold state, repetitions, time/resource
budget, correctness checks and cleanup owner. Change one variable where possible.
Stop when the declared question is answered, a safety/resource bound is hit, or the
budget ends; record inconclusive results without promoting them to wins.

Examples: a lifecycle hook fix must affect the same start and still block launch on
hook failure; idle pause must reduce idle consumption and preserve resumed data;
cleanup must reclaim measured allocated bytes while preserving active/shared data.
Each example needs its own fixture and baseline, not a universal numerical threshold.

Close the unit with the result, exact evidence and material limits. Preserve useful
learning in the closest test, doc or existing project record. If fclt is available
and writeback is authorized, use project scope with a concrete artifact; it is not a
prerequisite for finishing. Keep private raw traces out of tracked evidence.
