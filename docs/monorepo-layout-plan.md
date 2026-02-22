# Monorepo Layout Plan

## Context

We need to support multiple deployable/runtime units in this repo:

1. CLI runtime (`hack`) with existing source under `/src`.
2. Standalone integration services (for example `/services/auth-broker`).
3. Future shared packages (`/packages/*`) for auth, provider SDKs, and UI contracts.

A direct one-shot move of `/src` to `/packages/cli/src` would break current release, CI,
and local scripts that assume root entrypoints and root-relative imports.

## Decision

Migrate in phases with compatibility shims:

1. **Phase 1 (now): workspace boundary first**
   - Add `/packages/cli` package as canonical CLI workspace.
   - Keep root `index.ts` and root scripts stable.
   - Delegate root entrypoint to `packages/cli`.
2. **Phase 2: physical source move**
   - Move `/src` to `/packages/cli/src`.
   - Update root scripts and release tooling to call `bun --cwd packages/cli ...`.
   - Provide temporary compatibility re-export paths if needed.
3. **Phase 3: CI + release cutover**
   - Update GitHub Actions to run workspace-aware checks:
     - `bun --cwd packages/cli run typecheck`
     - `bun --cwd services/auth-broker run typecheck`
   - Keep root aggregate commands as orchestration wrappers.

## Current State (implemented)

1. Root workspace globs include `services/*` and `packages/*`.
2. `/packages/cli` exists with a typed entrypoint wrapper.
3. Root `index.ts` routes through `/packages/cli/index.ts`, preserving existing behavior.
4. `turbo.json` is in place for workspace task orchestration.
5. Root command surface delegates CLI/macOS/Ghostty/build/install tasks to `packages/cli`.
6. Root quality gates are workspace-aware via Turbo (`typecheck`, `test`, `check`).
7. CI is workspace-aware and runs Turbo gates + CLI/release smoke build.
8. Semantic release prepare now synchronizes workspace package versions.
9. `/packages/db` is scaffolded for Drizzle + Neon-backed shared schema/migrations.
10. `services/auth-broker` hosts Better Auth + GitHub OAuth broker routes with plugin-first Elysia structure.

## Follow-up Work

1. Move `/src` into `/packages/cli/src` and update import graph.
2. Move CLI-focused tests into `/packages/cli/tests` (or add workspace references).
3. Add workspace-scoped release channels only if we need independent package versioning.
4. Add shared package(s) for provider/auth models consumed by CLI + app + services.
5. Add optional Turbo remote cache + cache outputs for long-running integration/e2e tasks.
