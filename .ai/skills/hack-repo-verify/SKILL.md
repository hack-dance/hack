---
name: hack-repo-verify
description: Select and run Hack repository tests, model checks, CLI harnesses and native runtime qualification. Use to verify a Hack change or investigate a failing check.
---

# Verify a Hack change

Identify changed behavior and its likely failure before choosing a test. Prefer the
closest regression, then the applicable full gates. Preserve required checks; after
they pass, stop unless new evidence warrants more work. Read-only/document edits
need link, contract and generation checks, not an unrelated runtime exercise.

## Portable and native commands

From repo root, the [toolchain](../../../.hack/README.md) supports these tasks:

```sh
hack run --profile toolchain toolchain -- test tests/tla-result.test.ts
hack run --profile toolchain toolchain -- test
hack run --profile toolchain toolchain -- check
hack run --profile toolchain toolchain -- models
hack run --profile toolchain toolchain -- rust
hack run --profile toolchain toolchain -- rust-check
hack run --profile toolchain toolchain -- build
```

Use the current branch's `./dist/hack` as the outer CLI when testing candidate CLI
behavior; installed Hack may bootstrap the tools but is not current-source proof.
Container `exec bun index.ts ...` exercises source. Container `dist` is Linux-only;
native `bun run build` creates the separate host executable. Execute it after build.

For native setup use root `mise.toml`, the Bun pin in `package.json`, and
`bun install --frozen-lockfile`. Native gates are `bun run typecheck`, `bun run check`,
`bun run test`. Focused CLI checks: `bun run --cwd packages/cli typecheck` and
`bun run --cwd packages/cli check`; lint changed tests/scripts explicitly with
`bunx ultracite check <paths>`. These entry points first run
`bun run check:bun-version`, which fails when the running Bun differs from the
`packageManager` pin that CI installs. A Bun ahead of mise's shims on `PATH`
(for example mise's `latest` install) bypasses the checkout's `mise.toml`; use
`mise x bun@<pin> -- bun run <script>` instead. `HACK_ALLOW_BUN_VERSION_MISMATCH=1`
proceeds with a warning for a deliberate experiment; such a result is not CI evidence.
Raw `bun test <paths>` does not run the guard.

CI's "Config compiler" job also runs compiled-bundle CLI checks
(`scripts/check-config-compiler-cli.ts`, `scripts/check-native-*-plan-cli.ts`,
`scripts/check-native-config-import-cli.ts`) that `bun run test` does not. For
compiler, native planning or config-import changes, run them locally after
`bun run build` and `bun run build:config-compiler` with
`bun run check:native-plan-cli`. `tests/native-plan-cli-wiring.test.ts` fails when a
new `scripts/check-native-*-plan-cli.ts` is missing from that command or from CI.
CI also lints those scripts and runs their transport tests; lint changed ones explicitly.

Rust default gates are `bun run check:local` and `bun run test:local`. Add `--all-features` to equivalent Cargo commands for feature
changes; the toolchain Rust tasks already enable all features. Keep default coverage.

Before a full CLI suite, explicitly prepare the ignored compiler with
`bun run build:config-compiler` on the host, or the toolchain `config-compiler` task
inside Linux. Root `test`/`turbo:test`, direct CLI `test`, and no-argument toolchain
`test` check its protocol and usability before launching the suite. An absolute
`HACK_CONFIG_COMPILER_BINARY` selects the caller's compiler and survives Turbo's
environment filtering; no fallback, build or download occurs during preflight.
Host and container `dist` remain separate. This checks compatibility, not exact
source provenance. Raw `bun test <paths>` remains available for focused tests;
it bypasses the suite preflight and does not prepare compiler-dependent fixtures.

All test files share one Bun process. `bunfig.toml` preloads
[the global-state guard](../../../tests/helpers/global-state-guard-preload.ts) for
every `bun test` run: a test or file that leaves the environment, cwd, umask,
exit code, a guarded global function or a process listener changed fails with a
`[global-state-guard]` message naming the file. The guard restores the
environment, cwd, umask and exit code so later files run clean; it keeps
replaced functions and listeners, which may still protect unsettled work. Fix
the named file's restore (`try`/`finally` or `afterEach`), not the later failures.
Restore environment keys with `restoreEnv` from `tests/helpers/env.ts`: Bun keeps
a deleted `HTTP_PROXY`-style key for `fetch` and `Bun.spawn` without `env`, and
the guard reports that as `native env <KEY> changed`.

For release workflow edits, run the pinned syntax/context check also enforced by CI:
`mise x actionlint@1.7.12 -- actionlint -shellcheck= -pyflakes= .github/workflows/ci.yml .github/workflows/release.yml .github/workflows/prerelease.yml .github/workflows/bun-crash-experiment.yml`.
This validates event globs and reusable workflow contexts; Bun YAML parsing alone does not.

`bun run privacy:check` scans Git-tracked files. Stage reviewed new source/tests
before the final gate, or rerun it after staging: an earlier pass does not cover
untracked candidate additions. Keep private artifacts excluded from the index.

## Match the harness to the claim

| Change | Existing loop and required observation |
| --- | --- |
| CLI flags/output/config | Closest `tests/*.test.ts`, then current-source CLI invocation; assert exit, stdout/stderr and rejection |
| Local CLI workflows | `bun run test:e2e:local`; [harness](../../../tests/e2e/harness.ts) provides isolated `HACK_HOME`, temp roots, timeout and cleanup |
| Docker workflows | `bun run test:e2e:local:docker`; use `HACK_E2E_REQUIRE_DOCKER=1` and `HACK_E2E_REQUIRE_TMUX=1` when their availability is acceptance, so missing prerequisites cannot become green skips |
| Env/worktrees | Overlay/target/primary/linked-worktree tests, secret-key inheritance and local overrides |
| Lifecycle/processes | Shell/stdin/TTY, signal/process-group ownership, hook failure, restart and persisted readback |
| Rust state/recovery | `packages/runtime-core/tests/` plus module tests; malformed/stale ownership, crash window, resume and data preservation |
| TLA models | `test:models`, [model mappings](../../../tests/models/tla/README.md), [runner](../../../scripts/check-tla-models.ts) and expected positive/negative controls |
| Consumer instructions | [ownership](../../../docs/agent-guidance.md), `bun run generate:agent-plugins`, affected examples and source/render tests |
| Native authored command slices | `tests/native-authored-command.test.ts` (unsupported matrix), `tests/native-authored-command-dispatch.test.ts`, `tests/native-authored-project-{start,run,observe,logs,exec,recovery}.test.ts` and the [command contract](../../../docs/reference/native-authored-commands.md); the dispatch "source CLI" cases need the prepared compiler (`bun run build:config-compiler` or absolute `HACK_CONFIG_COMPILER_BINARY`) and fail without it; `native-authored-project-start` and `native-authored-project-exec` are nondeterministic on a local macOS host, so a single local pass or failure is not proof; live acceptance runs host-serialized on one prepared macOS provider slot |
| Native VM/routing/reclamation | [candidate guide](../../../docs/guides/native-candidate.md), relevant acceptance gate and isolated host fixture; Linux checks cannot qualify macOS effects |
| Resource/performance claims | [performance skill](../hack-repo-performance/SKILL.md), matched workload and measured boundaries |
| Bun runtime crashes | Read-only history: `bun run ci:bun-crash-census -- --since <UTC> --until <UTC>` (failed test-suite job logs: every `test shard i/n` job, or the `test` job of a run from before the split, since `test` is now the logless fan-in; `--scan-passing` for all; `--job NAME` selects by exact name or a `*` pattern such as `"test shard *"`; a `warning:` line means no job matched or a selected job ran no Bun, so its zero is not evidence). Matched reproduction: the gated [experiment](../../../.github/workflows/bun-crash-experiment.yml), which spends hosted macOS minutes and needs an explicit go-ahead; never loop on a shared host. Its default `focused` mode loops `tests/native-https-owner.test.ts` (where both original segfaults happened); `full` needs a budget of at least 40 minutes because one full suite takes 30-35. A run never starts unless its estimate fits the remaining budget, so read `summary.json` for the verdict and per-mode crash, failure and skipped-for-budget counts. Both share [the classifier](../../../scripts/lib/bun-crash-classify.ts) |

Read [CI](../../../.github/workflows/ci.yml) for current hosted gates. A local pass
does not mean CI ran.

Hosted CI runs the `bun run test` file set on four `test shard i/4` jobs;
the required `test` check is their fan-in and passes only when every shard did.
[`scripts/test-shard-plan.ts`](../../../scripts/test-shard-plan.ts) splits the files
by the durations in `scripts/test-shard-durations.json`. A file with no recorded
duration is planned at 5 s. Each shard runs each of its files in its own
`bun test ./<file>` process and prints a start line and a result line per file.
It stops a file after 12 min, and stops the shard at 30 min or on cancellation.
When it stops early it names the running file, the files not started and the
slowest files. Each shard first checks that the four shards cover the files
`git ls-files` lists exactly once. To reproduce one shard locally, run
`bun scripts/test-shard.ts plan --shard=i/4` or
`bun scripts/test-shard.ts run --shard=i/4`. To check the split after adding
or moving tests, run `bun scripts/test-shard.ts verify --count=4`. To refresh the
durations, download the `test-shard-durations-<i>` artifacts and run
`bun scripts/test-shard.ts update-durations --source=<run> <files>`. A per-file
process does not share module state with other files, unlike one `bun test` run. Existing unsupported remote/gateway/native-app checks are
not default local-product requirements; use them only for explicitly scoped work.

## Verify the verifier

Treat unavailable prerequisites, ignored tests, cached results and timeouts explicitly.
Before an ignored native graph fixture, read its prerequisites in the
[runtime README](../../../packages/runtime-core/README.md). Some fixtures require
a caller-prepared pool: use the managed provider, engine and network-tool setup,
start the required socket capacity, load the pinned image, and verify runtime
status before invoking the test. Record the current-source test executable and
candidate bundle separately. An unprepared-pool failure does not exercise the
scenario; preserve its evidence and fix setup before rerunning.

TLC must explore the intended states; its negative control must fail the named
invariant with the expected trace, not merely return nonzero. A small abstract model
needs source mapping and implementation regression evidence; use
[hack-repo-tla](../hack-repo-tla/SKILL.md) for model changes or trace checks.

Do not overlap stateful runs against one checkout, daemon, port range or runtime.
Record owned resources before a live run, use bounded fixtures and verify cleanup.
Never hand-edit managed internal state or prune unowned resources to repair a test.
Report exact command, source/executable, host/container context, result, skips/cache
and remaining gate. Do not upgrade a mocked/unit result into live runtime evidence.
