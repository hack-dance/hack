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

For v5, [Linear's Hack project](https://linear.app/hackdance/project/hack-8806a1b201f7/overview)
is the planning/status source of truth. Start with the
[program and issue index](https://linear.app/hackdance/document/hack-v5-program-measurable-acceptance-and-source-of-truth-26d5fb362f3e),
which is available even in a fresh checkout without local planning artifacts. Use the local
`_docs/docs/plans/v5/linear-sync.md` mapping to find the existing issue and milestone;
preserve `_docs/docs/plans/v5/work-units.md` and linked source/evidence documents.
While reconciliation is incomplete, consult both and make coverage gaps explicit.
Do not overwrite an earlier objective when a new message adds a follow-up. Capture
new actionable work once with acceptance and a verification path; search existing
issues before creating one. Keep `v5 prerelease.1` readiness distinct from full `v5`
acceptance and do not infer publishing authority from either milestone.
Before rewriting an existing issue, fetch its full detail. List/search descriptions
may be truncated previews; never use them as replacement bodies. Re-fetch full
details after a migration and verify acceptance, source links and dependencies.

At meaningful checkpoints, update the owning Linear issue with the outcome, source
revision/artifact, checks actually executed (including cache/skips), remaining gates
and next action. Summarize failures and changed decisions as well as successes;
distinguish historical backfill from newly verified evidence. Link substantive
research/specifications in project documents so issues remain understandable without
local access. Never upload secret values, private raw logs or sensitive artifacts.
Preserve repository models, tests and reproducible evidence; Linear tracks their
meaning and status, not a replacement copy of source code. Do not mark a parent done
from component tests. If a Linear write fails, retain the pending update locally and
report the unsynced state instead of claiming it was saved.

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
