# Hack CLI Workflow

This repository is the source tree for the `hack` CLI and related services.

## Core expectations

- Use Bun, not npm, pnpm, or yarn.
- Prefer targeted package or service commands before broad workspace runs.
- Keep changes scoped to the ticket. Do not mix unrelated cleanup into the same branch.
- Work inside the ticket worktree and ticket branch created by Symphony.
- Commit useful checkpoints as you make progress. Do not wait until the very end to create the first commit if the change is substantial.
- Before finishing, make sure the branch is in a state that can be pushed and reviewed cleanly.

## Project structure

- `index.ts`, `src/**`: root CLI entrypoints and orchestration logic
- `packages/cli/**`: packaged CLI build/install scripts and macOS helper commands
- `services/auth-broker/**`: auth broker service
- `packages/db/**`: database package
- `apps/macos/**`: native desktop app
- `docs/**`, `README.md`: user/operator documentation

## Default validation

Start with the narrowest checks that match the files you changed, then run broader checks before handoff.

### Common commands

```bash
bun run typecheck
bun run test
bun run check
```

### Package and service focused commands

```bash
bun run --cwd packages/cli test
bun run --cwd packages/cli typecheck
bun run --cwd packages/cli check

bun run --cwd services/auth-broker test
bun run --cwd services/auth-broker typecheck
bun run --cwd services/auth-broker check

bun run --cwd packages/db test
bun run --cwd packages/db typecheck
bun run --cwd packages/db check
```

### Local install / runtime smoke checks

Use these when the ticket changes install, packaging, startup, or command behavior.

```bash
bun run install:status
bun run install:dev
hack --help
```

### Desktop / macOS work

Only run these when the ticket touches `apps/macos` or macOS-specific packaging.

```bash
bun run macos:test
bun run macos:build
```

## Development guidance

- Prefer root `bun run` scripts for workspace-wide behavior.
- Prefer package-local commands when you are changing a single area.
- If you change CLI behavior, capture at least one realistic command path in tests or a documented smoke check.
- If you change docs or workflow behavior, keep examples accurate with the current CLI surface.
- If you touch build, install, release, or runtime image code, include a smoke check that proves the command still executes.

## Git and PR workflow

- The ticket worktree should already be on a dedicated ticket branch.
- Commit incrementally with clear messages.
- Keep the branch rebased or merge-ready.
- When preparing for merge:
  - make sure validation commands are recorded
  - summarize any residual risk
  - do not mark the work done if CI-critical checks are still unverified

## What to avoid

- Do not introduce Node-only workflows when Bun already covers the use case.
- Do not hand-edit generated artifacts unless the ticket is specifically about generation outputs.
- Do not run broad destructive cleanup across unrelated packages.
- Do not assume macOS-only paths are safe to change without validation.

## Completion checklist

Before handing work back for review:

1. Run targeted validation for the touched area.
2. Run broader validation if the change affects shared runtime, install, orchestration, or release behavior.
3. Make sure the working tree changes are intentional and reviewable.
4. Leave a concise summary of what changed, how it was validated, and any remaining follow-up.
