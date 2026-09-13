# Checkpoint 01: read-only Rust candidate

Date: September 9, 2026. Branch: `codex/v5-candidate`.

## Reviewable result

The candidate has a Rust core library, a small executable, and a checkout-bound `hack-local`
launcher. It reports its identity and previews isolated workspace paths for a separate project.
It does not parse project configuration, start a daemon/VM/container, synchronize files, or enroll
an environment. The next runtime deliverable is WU02 in the [work units](work-units.md).

The maintained [spec](spec.md) selects SmolVM/libkrun for the first Mac adapter, preserves Docker/
Compose compatibility, and makes speed, source locality, and local/remote ergonomics explicit.
The existing official Hack binary and active real-project checkout remain unchanged.

## Local evidence

- Eight Rust contract/integration tests passed, including real executable invocation without a usable
  PATH, poisoned runtime settings, synthetic secret exclusion, separate namespaces, aliased state,
  foreign checkout, unsupported mutation, invalid UTF-8, and missing-build fallback refusal.
- Rust formatting and Clippy passed. Shell syntax and package JSON checks passed.
- A release build ran from a separate real project. Candidate output named this checkout, project
  Git status matched its before state, and the official executable's SHA-256 remained unchanged.
  No candidate runtime state was created.
- The final release-built identity sample was 406,880 bytes. One hundred `info --json` invocations
  measured 11.08 ms median and 13.08 ms p95 on the development Mac using Rust 1.97.1. This sample
  measures process/launcher/read-only identity cost, not a runtime or application speedup. Raw local
  receipts are kept in ignored `.hack-local/review`.
- Existing `bun run typecheck`, `bun run check`, and `bun run test` succeeded using Bun 1.3.9 and
  Turbo cache hits. The replayed CLI test result was 941 passed, 5 skipped. These cached results
  cover the unchanged TypeScript implementation; the new Rust tests ran separately.
- The existing CLI built freshly to `dist/hack` and reported v4.1.1. CLI reference regeneration
  produced no tracked difference. Candidate commands are documented separately.
- A candidate-core CI job is defined for Linux and macOS, with Rust 1.85.1. Hosted CI and the Rust
  minimum-version run have not executed from this local branch.

## Five-minute demo

From this checkout, run:

```sh
./scripts/build-hack-local.sh
./hack-local info --json
./hack-local plan --project /absolute/path/to/a/separate/project --json
./hack-local up
```

The preview shows canonical source and candidate paths, `runtime_execution_supported: false`, and
zero effects. The final command must return the typed `unsupported_command` error with exit 2.
Use the [development guide](development.md) for the optional current-shell alias and test commands.

## Remaining gates

No product SmolVM adapter, Compose import, durable service, job execution, synchronization, endpoint,
or terminal has shipped in this checkpoint. Prior private experiments are evidence for design,
not an implementation under `hack-local`. Provider packaging/lifecycle is the next unit; native
Linux parity and meaningful repeated runtime performance measurements remain mandatory.
