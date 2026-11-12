# Pull-request CI evidence

A green pull-request `test` check means the selected unit test files passed on
their assigned platforms, and the type, lint and privacy checks passed. It is
not evidence that every unit test or every native host ran. The workflow reports
the selection in its change-scope output. `docker-e2e` retains its separate
scope gate and does not use unit-test dependency selection.

Draft pull requests run secret scanning, type/lint/privacy checks, the docs site
when its inputs changed, and selected unit tests on Linux. They defer Docker
E2E, native compiler/candidate jobs, platform validation, runtime images and
release-build smoke checks. Both fan-ins explicitly fail with `skipped: draft`.
GitHub accepts skipped required jobs, so a skipped job alone would not establish
the intended protection. The required `test` context therefore fails until the
PR is ready and its normal checks pass. Linux-only draft results do not qualify
macOS cases that skip on Linux.

Marking a PR ready starts the normal pull-request set. Converting it back to a
draft, adding or removing a label, and pushing also recompute the plan. The
`ci:full` label selects every test and native job; drafts still defer native and
Docker execution and cannot satisfy the required `test` check.

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
package manifests and selector configuration. Pushes always use this full path.
If the base predates the selector, the bootstrap also runs the full set. Draft
suppression and failing draft fan-ins still apply to a forced full selection.
No PR install script executes while computing scope. The base archive supplies
the working directory, Bun configuration and dependency lockfile for the policy.
Retargeting (`edited`) recomputes scope; other PR metadata edits also cancel
any in-progress PR run and start a new run.

Config, lockfiles, manifests, workflows, scripts, fixtures, scenario/model data,
Rust/guest inputs, unknown paths and deleted modules select the full unit set.
An empty or unavailable diff does too. Documentation Markdown still runs the
always-run set. These rules intentionally sacrifice some savings when a graph
cannot represent a dependency.

Selected files retain the existing macOS/Linux pool classification. No macOS
unit shard starts for an empty selected macOS pool. Source-check tests themselves
can be in the macOS pool, so a small change does not necessarily avoid macOS.
Drafts distribute all selected files across the five Linux shards. Full test
discovery and independent Git enumeration still agree before subset filtering;
duplicate and unknown selections fail, and every selected file runs exactly
once across the active pool shards. Each file retains its suite working
directory and Bun preload.

The candidate job follows its crate, its config-compiler path dependency, guest, launcher, helper/toolchain and CI
inputs. The compiler's native host matrix follows its crate/build/toolchain/CI
inputs. Other compiler checks retain the previous Linux scope. These are job
input gates, separate from the unit import graph.

## Historical replay

Run `bun run ci:selection-replay -- --repository=owner/repository --count=30 --read-logs --plant-failures`.
It prints one JSON record per merged PR: revision, changed paths, full/selected
reason, selected files and platform pools, ready/draft policy, run/attempt counts,
known failed files, hidden failures and evidence gaps. No historical code runs:
source snapshots come from Git objects. Final selections and historical failed
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

Every push to `next` and `main` still runs every unit file, every native compiler
host and the full Docker set. The prerelease workflow still requires a successful
full push run on its exact source SHA, with every required job successful and
no skipped jobs. This change does not alter release or prerelease gates, runner
accounts, paid services or merge policy.
