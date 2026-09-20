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
`bunx ultracite check <paths>`. Rust default gates are `bun run check:local` and
`bun run test:local`. Add `--all-features` to equivalent Cargo commands for feature
changes; the toolchain Rust tasks already enable all features. Keep default coverage.

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
| Native VM/routing/reclamation | candidate guide (local `_docs/docs/plans/v5/development.md`), relevant ledger gate and isolated host fixture; Linux checks cannot qualify macOS effects |
| Resource/performance claims | [performance skill](../hack-repo-performance/SKILL.md), matched workload and measured boundaries |

Read [CI](../../../.github/workflows/ci.yml) for current hosted gates. A local pass
does not mean CI ran. Existing unsupported remote/gateway/native-app checks are
not default local-product requirements; use them only for explicitly scoped work.

## Verify the verifier

Treat unavailable prerequisites, ignored tests, cached results and timeouts explicitly.
TLC must explore the intended states; its negative control must fail the named
invariant with the expected trace, not merely return nonzero. A small abstract model
needs source mapping and implementation regression evidence; use
[hack-repo-tla](../hack-repo-tla/SKILL.md) for model changes or trace checks.

Do not overlap stateful runs against one checkout, daemon, port range or runtime.
Record owned resources before a live run, use bounded fixtures and verify cleanup.
Never hand-edit managed internal state or prune unowned resources to repair a test.
Report exact command, source/executable, host/container context, result, skips/cache
and remaining gate. Do not upgrade a mocked/unit result into live runtime evidence.
