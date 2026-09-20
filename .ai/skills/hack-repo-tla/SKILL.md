---
name: hack-repo-tla
description: Model and check stateful workflow correctness with TLA+, including concurrency, retries, leases, crash recovery, and recorded execution traces. Use for formal-model requests or risky state transitions; skip routine stateless edits.
---

# Hack TLA+ checks

For maintained Hack models, start with `hack run --profile toolchain toolchain -- models`.
The [model contracts](../../../tests/models/tla/README.md) and
[verification skill](../hack-repo-verify/SKILL.md) define CI and implementation evidence.
This self-contained copy is maintained in this repository; no global skill is required.

Use a small executable model to answer a concrete correctness question. Follow the user's scope; formal modeling does not authorize production changes or require a separate approval for ordinary model edits.

## Choose the work

- For a new model, identify the property, relevant source operations, atomic boundaries, finite bounds, and failure assumptions. Reuse an existing model where possible. `scripts/new-agent-spec` offers optional starting templates; do not scaffold over an existing specification.
- For source modeling or changes to variables/actions, read [model-review.md](references/model-review.md). Retain memory, ownership, persistence, and failure details when they affect the property under investigation.
- For recorded runs, read [trace-mapping.md](references/trace-mapping.md). Trace replay checks the supplied observations, not all possible executions.

## Check and connect to code

1. Write or update the `.tla` and matching `.cfg` together. Every action must specify the next value of every modeled variable, directly or through `UNCHANGED`. Start with safety; add fairness only when justified by the actual scheduler/protocol.
2. Use TLC for small finite models. Use Apalache when bounded symbolic checking adds value; it may require type annotations and supports a different subset. A TLC pass does not imply Apalache compatibility.
3. Check a valid model and an intentional violation of the property. Inspect exit status and checker diagnostics: parse errors, zero initial states, timeout, and incomplete searches are not successful verification. Preserve useful negative controls in CI.
4. Map counterexamples to ordinary implementation tests. Record model bounds, assumptions, source mapping, and what remains unverified. A passing abstract model does not prove the implementation, performance, filesystem durability, or production behavior.

Keep mature models with the repository's tests and CI. Once relevant checks pass, continue implementation; do not repeatedly broaden the model without a new failure or unanswered question.

## Commands

Run helpers from this skill directory; use absolute script paths from other working directories.

- `scripts/ensure-tla-tools`: install both checksum-pinned tools and their mise Java runtimes.
- `scripts/new-agent-spec <template> --name <Module> --output-dir <dir>`: optional scaffold; rewrite its `.cfg` after replacing the model.
- `scripts/run-tlc <spec.tla> --config <model.cfg>`: TLC, default 2 workers and 512 MiB maximum heap; configurable with `--workers` and `--heap-mb`.
- `scripts/run-apalache <spec.tla> --config <model.cfg> --length 10`: bounded symbolic check.
- `scripts/validate-trace <spec.tla> <trace.json> [--config <constants.cfg>]`: check `Init`, each `Next` transition, and complete trace visitation. Only raw consecutive transitions are supported; filter or explicitly model stuttering and explain that choice.
- `scripts/spec-to-tests <trace.json>`: create a regression checklist; inspect it and implement meaningful assertions.

Python 3.12+ and mise are required. Tool downloads stay in `.local/`, or `TLA_AGENT_CHECKS_HOME`. TLC-only commands do not install Apalache. Installation uses `mise install`; execution uses an explicit `mise exec` pin. Never change global Java selection from these helpers. Run large or uncertain models with an external wall-time limit; start with the bounded defaults.

For upgrades, versions, verification commands, and optional MCP choices, read [toolchain.md](references/toolchain.md).

For source comparisons or a bounded Specula evaluation, read [research-review.md](references/research-review.md).

## Source and artifact ownership

Maintain Hack model sources in `tests/models/tla/<topic>/`: `.tla` modules,
`positive.cfg`, `negative.cfg`, and deliberately sanitized regression fixtures.
Register maintained models in `scripts/check-tla-models.ts` (runtime contracts in
`scripts/lib/tla-runtime-models.ts`), with exact exploration bounds, named failing
invariants, same-state counterexample witnesses, source mappings and omissions.
Do not use `.hack-local` or ignored planning directories as the only home of a
maintained model. Keep independent state machines small; consolidate the runner
and contracts rather than combining unrelated models into one specification.

`.hack-local/` remains wholly ignored. For new work use `runs/<work-unit>/<run-id>/`
for logs, raw traces, receipts and benchmark output; `review/<work-unit>/<run-id>/`
for private review bundles; and `target/` for reusable build output. Tool downloads
stay in the helper's ignored `.local/`. Preserve existing runtime paths and local
archives unless their ownership and callers have been checked before relocation.
Never broadly unignore `.tla`, `.cfg` or `.json` there: generated trace modules can
embed captured state and credentials. Promote only individually reviewed sources.

Run checkers in temporary or ignored directories. The maintained runner copies
sources into temporary scratch space and removes it on either outcome. Raw live
traces, VM checkpoints, env snapshots, logs and review transcripts are private by
default. Reduce useful failures to synthetic fixtures or concise reviewed findings;
an ignored file is not encrypted, and ignore rules do not remove already tracked
content. Verify candidate paths with `git check-ignore` and review the actual diff
before committing; never force-add a private run directory.
