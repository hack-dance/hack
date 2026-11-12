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

The always-run set also includes source readers and subprocess-based test
support, contract/protocol/transport/schema/DTO/compatibility tests, source,
wiring, reference and generation checks, and the reasoned exceptions in
`ALWAYS_RUN_TESTS`. Source-reader detection deliberately includes fixture-only
reads: false positives spend minutes rather than omit evidence. Tests that read
docs, CLI reference, environment matrices or generated files must remain in this
set. Add an explicit exception whenever a new observation cannot be recognized
by the source-reader rules.

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

The candidate job follows its crate, guest, launcher, helper/toolchain and CI
inputs. The compiler's native host matrix follows its crate/build/toolchain/CI
inputs. Other compiler checks retain the previous Linux scope. These are job
input gates, separate from the unit import graph.

## Historical replay

Run `bun scripts/ci-selection-replay.ts --repository=owner/repository --count=30`.
It prints one JSON record per merged PR: revision, changed paths, full/selected
reason, selected files and platform pools, ready/draft policy, run/attempt counts,
known failed files, hidden failures and evidence gaps. No historical code runs:
source snapshots come from Git objects. Final selections and historical failed
revisions are evaluated separately, so a later fix cannot erase an earlier
selection bug. A label present at merge cannot mask a narrower historical plan.

The replay follows merge time, paginates run/job history and includes rerun
attempts and interrupted unit jobs. It reads structured check annotations rather
than terminal logs: the file runner annotates every non-passing file. Dedicated
native/compiler/Docker jobs retain their own tests and are checked against their
historical input gates. Exit 1 means a known failure would have been hidden.
Exit 2 means history/annotations were missing or a failure could not be attributed
to a file; this is inconclusive, not proof of safety. `--skip-logs` is the limited
inventory mode, disabling per-file failure evidence. With `--read-logs`, the
replay privately reads logs when annotations are incomplete, including interrupted
runs. It checks named file outcomes and assertions emitted before cancellation.
A cancelled file without a failure record has an unknown outcome; it is not
counted as a test pass or an observed failure. Logs are never printed. Unit fixtures deliberately
omit a failed file to prove both log and annotation detectors reject it.

Every push to `next` and `main` still runs every unit file, every native compiler
host and the full Docker set. The prerelease workflow still requires a successful
full push run on its exact source SHA, with every required job successful and
no skipped jobs. This change does not alter release or prerelease gates, runner
accounts, paid services or merge policy.
