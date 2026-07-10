# hack CLI end-to-end harness

Drives the ACTUAL working-tree CLI (`bun <repoRoot>/index.ts <args>`, non-TTY
by design) against a disposable turborepo-style Bun monorepo, so changes to
init/env/worktrees/lifecycle/doctor are verified against real behavior — not
just unit tests.

## Running

```sh
bun run test:e2e:local              # tier 1 (no docker required)
bun run test:e2e:local:docker       # tier 1 + tier 2 (docker + real global infra)

bun tests/e2e/run.ts --list         # list scenarios
bun tests/e2e/run.ts --only=init    # run a subset by name
HACK_E2E_KEEP=1 bun tests/e2e/run.ts --only=doctor   # keep temp dirs for debugging
HACK_E2E_REQUIRE_TMUX=1 bun tests/e2e/run.ts --only=lifecycle-session-recovery
```

Exit codes: `0` all pass/skip, `1` any scenario failed, `2` isolation canary
failed (nothing ran).

## Isolation model (HACK_HOME)

Every CLI invocation runs with `HACK_HOME=<fresh tempdir>` plus
`HACK_SETUP_SYNC_MODE=off`, `HACK_NO_INTERACTIVE=1`, `NO_COLOR=1`,
`TERM=dumb`, and stdin closed. Global state (projects registry, global
config) must land under `HACK_HOME`, never under the real `~/.hack`.

Because the CLI must honor `HACK_HOME` for this to be safe, the runner
executes a fail-fast canary before any scenario:

1. **Probe A (read-only)** — `hack config get --global name` with `HACK_HOME`
   set; the CLI must report its global-config path under the temp dir. If it
   doesn't, `HACK_HOME` is not honored and the whole run aborts (exit 2)
   without writing anything.
2. **Probe B (write)** — a throwaway canary project is registered via
   `hack config get name`; the canary name must NOT appear in the real
   `~/.hack/projects.json` afterwards (the entry is removed best-effort if it
   does — a targeted removal, so concurrent legitimate registry writes are
   never clobbered) and a `projects.json` containing the canary must appear
   under `HACK_HOME`.

If the canary fails, fix the `HACK_HOME` override seam
(`src/lib/config-paths.ts`, `src/lib/projects-registry.ts`) before trusting
any e2e result.

## Tiers

- **Tier 1 (`local`)** — runs everywhere; no docker needed:
  `automation-check`, `init`, `env-secrets`, `worktree-secrets`,
  `worktree-registry`, `worktree-branch-default`, `agent-docs-sync`,
  `doctor` (doctor tolerates missing docker — it must report, not crash), and
  `lifecycle-session-recovery`. The lifecycle recovery scenario skips when
  tmux is unavailable unless `HACK_E2E_REQUIRE_TMUX=1` makes that capability
  mandatory (as it is in the dedicated Docker/tmux CI job).
- **Tier 2 (`docker`)** — opt-in via `HACK_E2E_DOCKER=1`; requires a running
  docker daemon, the machine's global `hack-dev` network (`hack global
  install`), and pulls `oven/bun:1`: `up-down`, `lifecycle-host-process`,
  `worktree-parallel-up`. When docker or the network is missing these SKIP
  with a reason instead of failing. Lifecycle host processes only start via
  `hack up` (no standalone lifecycle command), which is why that scenario is
  tier 2.

## Fixture

`fixture.ts` scaffolds, per scenario, a fresh git repo with:

- root `package.json` (workspaces `apps/*`, `packages/*`) + `turbo.json`
- `apps/web` / `apps/api` — `Bun.serve` servers ("ok web" / JSON) with
  Dockerfiles; compose runs them via `oven/bun:1` + volume mount (no build
  step) for speed
- `packages/shared` — tiny ts lib consumed by both apps (relative import so
  containers need no `bun install`)
- optional `.hack/` (hack.config.json, docker-compose.yml with caddy labels
  `caddy` / `caddy.reverse_proxy` / `caddy.tls=internal` on the `hack-dev`
  network, `hack.env.default.yaml`) following `src/templates.ts`; project
  name/dev_host are random (`e2e-<hex>.hack`) so runs can never collide with
  real projects
- helpers for linked worktrees (`git worktree add`) and commits

## Cleanup guarantees

- Per scenario, the fixture temp root and the `HACK_HOME` temp dir are
  removed in a `finally` (skip with `HACK_E2E_KEEP=1`).
- Docker scenarios run `hack down` (primary + branch instances) AND a raw
  `docker compose -p <project> down --volumes --remove-orphans` sweep in
  their own `finally`, keyed by the random fixture name.
- The canary restores the real registry snapshot best-effort if a leak is
  ever detected (and aborts the run).

## Adding a scenario

1. Create `tests/e2e/scenarios/<name>.ts` exporting a `Scenario`
   (`name`, `tier`, `summary`, `run(ctx)`); files must NOT end in `.test.ts`
   (the unit runner globs `tests/**/*.test.ts`).
2. Use `ctx.cli({ args, cwd })` for every CLI call (isolation is applied for
   you), `expect`/`expectExit`/`extractJsonObject` from `harness.ts` for
   assertions, and `ctx.skip("reason")` for legitimate environment gaps.
3. Build fixtures with `createMonorepoFixture` under `ctx.tempRoot`.
4. Register it in the `ALL_SCENARIOS` list in `run.ts`.
5. Docker scenarios: call `requireDockerPreconditions` first and wrap the
   body in `try/finally` with `downBestEffort`.
