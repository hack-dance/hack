# User Testing

Testing surfaces, tools, and validation concurrency for current Hack work.

## Validation Surface

### CLI and runtime

- Primary tools: `./dist/hack`, repo-local Bun commands, and global `hack` only for installed-runtime orchestration checks.
- Use for: runtime lifecycle, env, tickets, sessions, doctor, daemon, project config, and agent setup.
- Prefer `--json` when validating machine-readable behavior.
- If validating current-branch command behavior, build first and run `./dist/hack` or `bun index.ts` from the repo root.

### macOS companion

- Use Xcode/local app commands for retained desktop flows only: project list/detail, daemon/runtime status, up/down/restart/open, logs entrypoints, doctor/trust guidance, menu bar quick actions, and the Ghostty-backed bottom panel.
- Do not reintroduce tickets UI, hosted auth settings, GitHub/Linear settings, topology/network maps, gateway panes, or org/team/admin surfaces.

### Managed containers

- Use `hackdance/hack:slim` or the release install script for Codex/CI-style environments.
- Inject `HACK_ENV_SECRET_KEY` and verify `hack env list --json` plus `hack host exec -- printenv KEY`.
- Do not rely on `hack global install`, local CA trust, Caddy/CoreDNS, or Loki/Grafana in slim mode.

### Unsupported experimental remote

- Remote/gateway/node/dispatch tests are not core release gates.
- If a change touches these surfaces, isolate tests from local-first gates and verify they do not depend on removed hosted auth, web, GitHub, or Linear systems.

## Validation Concurrency

### CLI validators

- Max concurrent validators: `2`.
- Rationale: project state, tickets state, runtime metadata, and branch/worktree artifacts can race.

### Runtime/lifecycle validators

- Max concurrent validators: `1` per project checkout.
- Rationale: lifecycle sessions, fixed ports, and process groups are intentionally stateful.

### macOS app validators

- Max concurrent validators: `1`.
- Rationale: Xcode/app launch state and menu bar app instances should not overlap.

## Required Proof Patterns

- Env changes: cover overlay order, worktree-local overrides, linked-worktree key lookup, host-vs-compose target mode, and materialization drift.
- Lifecycle changes: cover shell semantics, process groups, stale metadata, singleton full/partial listener conflicts, and doctor recovery guidance.
- Tickets changes: cover offline/stale-local fallback only for transient connectivity; hard remote misconfiguration should surface clearly.
- Agent setup changes: update source renderers and checked-in generated examples, then run setup/MCP tests.
