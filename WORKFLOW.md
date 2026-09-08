# Hack CLI Workflow

This repository is the source tree for the Hack CLI and the local-first macOS companion.

## Core expectations

- Use Bun, not npm, pnpm, or yarn.
- Prefer targeted checks before broad workspace runs.
- Keep changes scoped and reviewable.
- Capture real verification for CLI/runtime/env changes.

## Project structure

- `index.ts`, `src/**`: CLI and runtime orchestration
- `packages/cli/**`: packaged CLI build/install scripts and macOS helper commands
- `packages/db/**`: internal database package
- `apps/macos/**`: native desktop app
- `docs/**`, `README.md`: current product docs

## Default validation

```bash
bun run typecheck
bun run test
bun run check
```

Focused checks:

```bash
bun run --cwd packages/cli test
bun run --cwd packages/cli typecheck
bun run --cwd packages/db test
bun run macos:test
```

## Local runtime smoke checks

```bash
bun run install:status
hack --help
```

## Product boundary

Supported:

- local runtime orchestration
- env management
- sessions
- diagnostics
- slim macOS companion

Removed:

- hosted auth/account/org/team flows
- built-in GitHub workflows
- built-in Linear workflows
- web dashboard

Remote/gateway/node/dispatch stay unsupported experimental.
