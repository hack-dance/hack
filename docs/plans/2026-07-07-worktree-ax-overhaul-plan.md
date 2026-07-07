# Worktree DX + Agent Experience (AX) Overhaul — Plan

Date: 2026-07-07
Branch: `feat/worktree-ax-overhaul`
Status: in progress

## Goal

Make hack excellent for agent-driven development: worktree workflows that just work
(secret key, branch instances, doctor checks), a single source of truth for agent
instructions with drift enforcement, a machine-readable CLI surface (JSON envelope,
error codes, non-interactive), agent-assisted onboarding (`hack init --with claude|codex`),
and phase-out of tickets from default instructions.

## Acceptance criteria

- All agent instruction surfaces (AGENTS.md/CLAUDE.md snippet, codex skill, cursor rules,
  primer) render from one structured source; a test fails if any surface drifts or if a
  documented command doesn't exist in `CLI_SPEC`.
- `hack setup sync --check` detects STALE content (not just marker presence).
- In a linked worktree: secrets decrypt using the primary/shared key with zero setup;
  hack never silently mints a divergent key; `hack doctor` flags divergent keys and
  cross-checkout dev_host collisions.
- `hack up` in a linked worktree defaults to a branch instance named for the worktree
  branch (opt-out via config/flag) so two checkouts never fight over hostnames.
- `hack up/down/restart/doctor --json` emit `{ok, data?, error?: {code, message}}`;
  errors carry stable codes (e.g. E_DOCKER_UNAVAILABLE, E_CONFIG_PARSE).
- Prompting commands honor `--no-interactive` (and detect non-TTY) with sane defaults
  or structured failure; `hack init` fully scriptable via flags.
- Experimental commands (node/dispatch/gateway/remote) are marked in the spec, hidden
  from default help, and warn on use.
- `hack init --with claude|codex` generates a detailed project-onboarding prompt
  (inventory, deps-container pattern, ops container, exec/env guidance) and hands off
  to the agent CLI.
- Tickets no longer appear in default agent instructions; extension still works.
- Tests never touch the real `~/.hack` (HACK_HOME-style isolation) and full suite,
  lint (`bun x ultracite check`), and build pass.

## Verified findings driving this plan

- Secret key resolution already has a worktree chain: local → shared (git common dir) →
  inherited from primary → `HACK_ENV_SECRET_KEY` (`src/lib/project-env-config.ts:1373-1411`).
  BUT `resolveProjectEnvSharedKeyPath` returns null when the shared FILE doesn't exist, so
  the write path (`ensureProjectEnvSecretKey`, :1413) can mint a fresh checkout-local key in
  a worktree → divergent keys.
- Registry dedupes worktrees by `git rev-parse --git-common-dir` family identity
  (`src/lib/projects-registry.ts:486`), migrates registration if primary path dies. Good.
  No tracking of sibling checkouts; no runtime collision protection (two checkouts, same
  dev_host → caddy routes to last-up).
- `checkAgentDocs` (`src/mcp/agent-docs.ts:89`) only checks marker PRESENCE, never content
  equality with the current render — auto-sync never detects stale content. Repo's own
  CLAUDE.md contains pre-v3 text (`hack env exec`, tickets mandate, remote-as-normal).
- Four hand-maintained instruction renderers: `agents/codex-skill.ts`, `agents/cursor.ts`,
  `agents/primer.ts`, `mcp/agent-docs.ts` (~850 LOC overlapping prose).
- No `--json` on up/down/restart/doctor/init; no error envelope; 73 interactive prompt
  sites without a `--no-interactive` convention; experimental commands sit unmarked in
  `src/cli/spec.ts`.
- `projects-registry.ts`/`config-paths.ts` have no HACK_HOME-style override → tests
  pollute the real `~/.hack/projects.json` (observed stale `/private/tmp/hack-project-*`
  entries on this machine).

## Phases

### Phase 1 — Instruction single source + drift enforcement (keystone)
- New `src/agents/instruction-source.ts`: structured sections (id, title, bullets,
  audience tags: full|primer|rules). All four renderers consume it; surface-specific
  framing (frontmatter, headers) stays in each renderer.
- Content updates while consolidating: drop tickets from default sections (one optional
  pointer max), keep experimental warning prominent, add linked-worktree section
  (key inheritance, branch instances per worktree), keep host exec/--scope semantics.
- Fix `checkAgentDocs` to compare rendered snippet vs on-disk marker content (report
  `stale` status); `setup sync --check` surfaces stale; auto-sync repairs stale.
- Drift tests: every `hack <cmd>` mentioned in rendered surfaces exists in CLI_SPEC;
  banned stale patterns (`hack env exec`, `--service` on host exec, tickets-in-default);
  all surfaces share the canonical section content.

### Phase 2 — Worktree DX
- Write-path key fix: new resolveProjectEnvSharedKeyLocation (location even when file
  absent); `ensureProjectEnvSecretKey` in a linked worktree writes to shared location or
  adopts primary's key; never silently create a divergent checkout-local key (loud warning
  + explicit override only).
- `hack up` in a linked worktree with no `--branch`: default to sanitized worktree branch
  name as branch instance; notice logged; opt-out `worktree.auto_branch=false` in config
  or `--branch main-instance` explicit. `open/logs/down` resolve the same default.
- `hack doctor`: divergent-key check across `git worktree list` checkouts; duplicate
  dev_host detection across running compose projects of the same family.
- Registry: record sibling checkouts (worktrees array on the entry); show in
  `hack projects --details`.
- Tests: worktree-first key creation, degraded git detection, up-in-worktree defaulting,
  doctor checks (fixture repos with worktrees).

### Phase 3 — AX CLI surface
- `src/lib/cli-result.ts`: envelope helpers + `HackErrorCode` union; wire into
  up/down/restart/doctor `--json`.
- `--no-interactive` global convention (flag + `HACK_NO_INTERACTIVE` + non-TTY detect)
  via a `canPrompt()` helper; apply to init/global/setup/env prompt sites.
- Spec: `experimental: true` on node/dispatch/gateway/remote; default help hides them
  behind an "experimental (unsupported)" one-liner; runtime warning banner on use.
- Respect `NO_COLOR` in gum/logger/help.

### Phase 4 — Agent-assisted onboarding
- `hack init --with claude|codex|both` (and `hack agent onboard` for existing projects):
  render a detailed setup prompt: inventory steps (services, ports, dbs, package manager),
  which hack features to use, deps-container pattern (named node_modules volume so
  macOS-host installs never leak into linux containers), ops/tooling container pattern,
  `hack run` vs `exec` vs `host exec` vs env overlays guidance, verification loop
  (up → open --json → logs). Launch agent CLI if present, else print prompt.
- `docs/guides/agent-first-setup.md` + surface via `hack agent patterns` and the
  instruction source (Phase 1 section).

### Phase 5 — Tickets phase-out + cleanup
- Docs: tickets marked optional/legacy; removed from README quickstart and repo CLAUDE.md;
  `hack setup tickets` prints a deprecation-leaning note. Commands keep working.
- HACK_HOME-style isolation for global paths (`config-paths.ts`); tests use it; prune
  command or doctor fix for dead registry paths.
- planet-animations data out of src/ (or lazy import); deprecation TODOs on legacy .env
  migration; refresh repo CLAUDE.md/AGENTS.md via new sync.

### Phase 6 — Verification
- Full `bun test`, `bun x ultracite check`, build, `hack setup sync --all-scopes --check`.
- Live smoke: temp repo + linked worktree → init, env add --secret, up --detach in both,
  open --json, doctor, down. Document verified vs assumed in the PR description.

## Execution notes

- Phases 1 and 2 run in parallel (disjoint files). 3 → 4 → 5 sequential (shared files:
  project.ts, instruction source). Phase 6 gates the whole branch.
- Every phase lands with tests in the same change; run targeted tests during phases,
  full gates at 6.
