# TODO

## Bugs / risks

- [x] Allow `hack open` to accept fully qualified URLs without double scheme.
- [x] Avoid parsing Docker labels via comma‑split in `hack projects` (use `docker inspect`).
- [x] Add registry lock to prevent concurrent `projects.json` clobbering.
- [x] Fix `hack logs` conflict message (`--compose` vs `--loki/--services/--query`).
- [x] Allow custom `dev_host` values in `hack init` (no forced `.hack`).

## Architecture / design improvements

- [x] Add `--json` output for `hack projects`, `hack ps`, and log snapshots.
- [x] Structured log streaming for MCP/TUI integrations (NDJSON start/log/end).
- [ ] Log streaming enhancements (heartbeat + optional schema).
- [x] Formalize backend interfaces (`LogBackend`, `RuntimeBackend`).
- [ ] Optional lightweight daemon for Docker event streaming.
- [x] Add `hack config get/set` for safe `hack.config.json` edits.
- [x] Add `--profile` support to `hack up/down/restart/ps/logs`.
- [x] Add `hack projects prune` to clean missing entries/orphaned containers.

## Command hierarchy

- [x] Add `hack status` shortcut for `hack projects --details`.
- [x] Add `--since/--until` to `hack logs` (Loki only).
- [ ] Add `hack open --service` or `--url` for explicit targeting.

## Features

- [x] Branch builds (worktree-friendly) + `hack branch` commands (see `SPECS/worktrees.md`).
- [x] Show branch instances in `hack projects --details`.
- [x] CoreDNS + internal CA injection for `*.hack` inside containers.
- [x] Optional `hack doctor --fix` for safe auto-remediations.
- [x] Doctor: auto-detect + refresh CoreDNS/Caddy static IP config when `hack-dev` subnet is missing.
- [x] Doctor: verify CoreDNS can resolve external domains (no SERVFAIL) and offer a fix.
- [ ] Global TLS trust for Windows/Linux (defer; separate effort).
- [x] Auto-touch branch `last_used_at` when `--branch` is used.

## Tests (lower priority)

- [x] `hack init` discovery/scaffolding paths.
- [x] `hack logs` backend selection + LogQL selector.
- [x] Registry conflict + concurrency behavior.
- [x] `hack global` install/up/down flows (happy path + failures).
- [x] Log/runtime backend command construction.
- [x] Project config parsing (JSON + error handling).
- [x] CoreDNS config generation (static IP + fallthrough).
- [ ] CoreDNS integration: `.hack` resolution inside container + external DNS forwarding.
- [x] Doctor parsing (resolver + dnsmasq + compose network hygiene).
- [ ] `hack doctor` CoreDNS + Caddy CA checks for regressions.
