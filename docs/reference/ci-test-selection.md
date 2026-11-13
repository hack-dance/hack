# Pull-request CI evidence

A PR uses a light tier by default: typecheck, lint/privacy, secret scan, docs
checks when relevant, and selected Linux unit files on five Linux shards. It runs
no macOS jobs, Docker E2E shards, state-model job or CLI/release build smoke.
Ready Rust-input PRs retain the Linux Candidate core leg and both Linux compiler
hosts (including Rust checks); macOS stays in the heavy tier. This covers
non-Markdown inputs under runtime-core/config-compiler (including pins, fixtures
and generated data), plus all relay-guest inputs. Ready PRs that
change protected CI inputs (including workflows, selectors, scripts, suite helpers,
manifests, lockfiles and Rust toolchains) automatically
run every ordinary PR tier, as `ci:full` would. Ready PRs targeting `main` retain
the full tier, including the Intel compiler. Missing diffs or an unavailable base
policy also fall back to full tiers. Linux unit-test preflight
still prepares its matching compiler. The last Linux shard lists selected macOS
files in its summary as **deferred to the integration run**, before typecheck or
tests can fail. A green test check qualifies only the tests actually run.

Both required names, test and docs site, always report. The named Docker fan-in
passes an expected out-of-scope skip. Adding ci:mac enables the selected macOS
unit pool and native host jobs under their usual input gates; ci:e2e enables the
Docker/runtime-image/lifetime tier under its usual gates. The labels combine.
ci:full selects every unit file and ordinary native/Docker tier, state models and
build smoke. Ordinary `next` pushes and PRs into `next` omit the Intel compiler;
`main` PRs/pushes and explicit full dispatches retain it. Removing a label restores
the default tier, including the protected-input and `main` exceptions. A selector
fallback alone widens files; the independent shell guard also enables full tiers.
Adding/removing labels, pushing, changing readiness or retargeting recomputes
scope; metadata edits can cancel the active run.

The required `test` fan-in also depends on `linux-process-lifetime`. When that
tier is enabled, failure, cancellation, missing results or an unexpected skip
fails `test`, even when every unit shard passed. Its planned out-of-scope skip
passes. Branch rules are unchanged.

Drafts keep the same deferrals even when labeled and both fan-ins fail with
skipped: draft. GitHub accepts skipped required jobs, so a skipped job alone is
not merge protection. Marking ready recomputes the default or labeled plan. Linux
results never qualify deferred macOS evidence.

## Selection and uncertainty

`scripts/ci-test-selection.ts` parses module syntax without executing it. A test
runs when it changed or when any module it imports transitively changed. The
graph follows relative imports, re-exports, literal dynamic imports, CommonJS
imports and the current root/workspace path aliases. Unknown aliases, unresolved
local imports and computed imports keep their dependent tests in the always-run
set. External dependency changes are covered by the lockfile/manifest fallback.
Suite preloads are implicit dependencies: changing one or a module it imports
transitively selects every test. Unresolved preload dependencies also select all.

The always-run set also includes source readers and subprocess-based test
support, contract/protocol/transport/schema/DTO/compatibility tests, source,
wiring, reference and generation checks, and the reasoned exceptions in
`ALWAYS_RUN_TESTS`. Source-reader detection deliberately includes fixture-only
reads: false positives spend minutes rather than omit evidence. Tests that read
docs, CLI reference, environment matrices or generated files must remain in this
set. Add an explicit exception whenever a new observation cannot be recognized
by the source-reader rules.

Tests also always run when an imported source module refers to the CLI entry
point or built binary, launches a process, uses Bun shell execution or creates
a worker. These runtime edges can observe the whole CLI without importing it.
Aliases of the standard process, worker and Bun shell APIs are conservative.

On PRs, CI executes policy code and dependencies from the base commit, with the
merge checkout supplied only as data. A separate shell rule in the workflow
forces the full set for policy/scripts, workflows, suite helpers, lockfiles,
package manifests and selector configuration. `next` pushes use the same trusted
policy from `event.before`, with the new checkout supplied as data. A missing,
zero, unavailable or non-ancestor base forces full. The base must also have a
successful completed `next` push CI run: missing, running, failed or cancelled
predecessors and API errors force full, so supersession cannot lose coverage.
If the base predates the selector, bootstrap selects the full set. The independent
shell applies PR tiers after either policy path, including old base policies.
On ready PRs its full guard also enables native hosts, macOS shards, Docker, state
models and build smoke; draft fan-ins fail and keep heavy tiers disabled.
No PR install script executes while computing scope. The base archive supplies
the working directory, Bun configuration and dependency lockfile for the policy.
Retargeting (`edited`) recomputes scope; other PR metadata edits also cancel
any in-progress PR run and start a new run.

Config, lockfiles, manifests, workflows, scripts, fixtures, scenario/model data,
Rust/guest inputs, unknown paths and deleted modules select the full unit set.
An empty or unavailable diff does too. Documentation Markdown still runs the
always-run set. These rules intentionally sacrifice some savings when a graph
cannot represent a dependency.

Selected files retain their macOS/Linux pools. Light PRs run only selected Linux
files; selected macOS paths remain in the plan and deferral summary. Integration
pushes and opted-in or automatically full-tier PRs admit macOS shards when their selected pool is
nonempty. Full discovery and independent Git enumeration still agree before
filtering. Duplicate/unknown selections fail. Every selected file runs exactly
once per active host pool or is explicitly deferred. `BOTH_POOL_FILES` deliberately
runs the named daemon files on both hosts so Linux-only cases are exercised too.
Each file retains its suite
working directory and Bun preload.

The candidate job follows its crate, its config-compiler path dependency, guest, launcher, helper/toolchain and CI
inputs. The compiler's native host matrix follows its crate/build/toolchain/CI
inputs. Other compiler checks retain the previous Linux scope. These are job
input gates, separate from the unit import graph.

The Intel compiler lane runs on ready PRs into `main`, `main` pushes and explicit
full dispatches. Native-tier PRs into `next` and ordinary `next` integration runs
retain ARM macOS and both Linux compiler hosts. Intel-specific regressions on
`next` therefore surface during release qualification; the
prerelease gate requires that lane explicitly. macOS ARM qualification remains
separate from candidate tests because their repeated setup is small compared with
the compiler's transport and bundle checks.

`next` pushes share a non-cancelling concurrency group: the active run finishes,
including jobs waiting for macOS capacity. GitHub retains at most one pending run;
a newer push replaces that pending run, so intermediate revisions may not run.
This preserves all selected macOS coverage without changing runner capacity or
the PR layout. It does not reserve macOS slots or guarantee a queue wait bound.
PRs still cancel stale runs for the same PR. `main` pushes retain unique,
non-cancelling groups. Manual full runs have unique groups and cannot be cancelled
by a later `next` push.

## Historical replay

Run `bun run ci:selection-replay -- --repository=owner/repository --count=30 --read-logs --plant-failures`.
It prints one JSON record per merged PR: revision, changed paths, full/selected
reason, selected files and platform pools, ready/draft policy, run/attempt counts,
known failed files, hidden failures and evidence gaps. No historical code runs:
source snapshots come from Git objects. The failure audit models integration
coverage, with light-PR deferrals reported separately. Deferred historical macOS
failures are not PR Linux qualification. Final selections and historical failed
revisions are evaluated separately, so a later fix cannot erase an earlier
selection bug. A label present at merge cannot mask a narrower historical plan.

The replay follows merge time, paginates run/job history and includes rerun
attempts and interrupted unit jobs. It reads structured check annotations and
private checkout evidence: the file runner annotates every non-passing file. Dedicated
native/compiler/Docker jobs retain their own tests and are checked against their
historical input gates. Exit 1 means a known failure would have been hidden.
Exit 2 means history/annotations were missing or a failure could not be attributed
to a file; this is inconclusive, not proof of safety. `--skip-logs` is the limited
inventory mode, disabling historical failure audits. With `--read-logs`, the
replay privately reads checkout and failure logs, including interrupted
runs. It reads checkout's recorded merge SHA and validates its parents before
loading the source tree and its diff against the actual tested base. The run
API's PR head SHA can omit tests added on the base, so it is never substituted
for the tested merge tree. Missing, ambiguous or unavailable checkout evidence
is inconclusive; complete historical failure audits require `--read-logs`.
Each audited job reports its tested checkout revision. The replay combines
annotations with named file outcomes and assertions emitted before cancellation.
A cancelled file without a failure record has an unknown outcome; it is not
counted as a test pass or an observed failure. Logs are never printed. Unit fixtures deliberately
omit a failed file to prove both log and annotation detectors reject it.

`--plant-failures` independently follows static relative runtime imports/exports
from an omitted test and adds a virtual failing edit to a source dependency,
preferring a transitive edge. It recomputes selection with only the source path
added to the diff; the test itself stays unchanged. The expected failing test
must be selected or covered by a full fallback, otherwise the replay exits 1.
A subset without a source witness is inconclusive (exit 2). Full plans use an already covered
test edit and provide no reverse-import evidence. Historical code never executes.
The report names the expected failing test, edited dependency, edge depth,
original coverage and resulting mode. This synthetic check exercises selection
edges; it does not execute the planted failure or prove every runtime dependency.
Historical subset counts and real failures within those subsets must accompany
the zero-hidden-failure result; full fallbacks alone provide no selection proof.
The replay mirrors the workflow's protected-input guard but models the deployed
policy, rather than treating every pre-deployment base as a bootstrap full run.
Transient GitHub read errors (timeouts, connection resets and HTTP 502/503/504)
have at most three attempts, each bounded to 60 seconds. Authentication, quota,
missing resources and output-guard refusals fail immediately; no raw logs print.

Every `main` push retains the full test, Docker and release-host matrix. A manual
`gh workflow run ci.yml --ref next -f full=true` obtains release evidence at the
current `next` SHA. Freeze merges first and wait for that run before dispatching
the prerelease. Every prerelease now needs this explicit full run. The plan and
publish gates require successful `selection_mode=full` and
`ci_evidence=release-full` steps in the `test` fan-in, every compiler architecture,
every shard and every other job successful, with no skips. Full unit selection
alone is not release evidence. Missing or subset-only evidence refuses the plan
and prints the full-dispatch command. Required CI statuses must belong to that
run's suite and the exact jobs of its latest attempt; cancelled/failed full
attempts cannot expose an older green result. Newer failed, cancelled or unfinished
scoped attempts also block older full evidence; only successful scoped runs may
be skipped. For a newer scoped push at the same SHA, the refusal also names the
run and tells the operator to wait for success or use `gh run rerun RUN_ID`.
An older full run cannot supersede that red or unfinished evidence. A new full
dispatch can supersede it once the dispatch succeeds.
External app requirements retain
their own exact-head/app identity checks. Stable release preparation remains
push-only on `main` and rejects cancellation.

Bun download caches are keyed by OS, architecture, Bun pin and lockfile. Cargo
registry/target and Zig build caches also include the runner image, Rust/Zig pins
and Cargo locks, with separate candidate/compiler target trees. No build, test or
qualification step is skipped on a cache hit. Source changes still go through
Cargo's fingerprint checks. Hosted timings, rather than a cache hit alone,
determine whether these caches save time.
Native caches restore on PRs and save only on trusted pushes or manual dispatches,
avoiding a separate multi-GB target cache for every PR. Image OS remains in the key;
routine image version updates do not create new entries. Native cache transfer
time is part of the hosted comparison.

The storage activation command file has a temporary 20-minute hosted budget and
runs first in its shard after a 12-minute timeout on a slow hosted Mac. Other
files keep their 12-minute budget, explicit CLI limits override the exception,
and the 30-minute shard deadline still wins. This adds bounded headroom, not a
measured speedup; splitting the eight-case file remains the next cost reduction.

Lead readiness uses a clean persistent review, answered/resolved bot findings and
green Linux jobs. Pending macOS/Docker jobs are listed, not awaited. The lead tests
combined heads on a Mac, merges batches, and the next push qualifies their selected
platform/Docker integration evidence. Problems found there become follow-up PRs.
Nothing merges between a prerelease dispatch and publish.
