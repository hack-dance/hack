# Repo review

Date: 2025-01-XX

## Findings (bugs/risks)

### Medium
- [fixed] `hack open` always prefixes `https://` when `target` contains a dot, which breaks full URLs such as `http://localhost:3000` or `https://foo.bar/path`. It produces `https://http://...` and opens an invalid URL. Consider detecting an explicit scheme first. (`src/commands/project.ts:1549`)
- [fixed] `hack projects` parses Docker labels by splitting on commas, which will mis-parse labels containing commas and can hide or misattribute services/projects. Use `docker inspect` JSON labels or a more robust parser. (`src/commands/projects.ts:329`)
- [fixed] The project registry update path (`projects.json`) has no locking or merge; concurrent CLI invocations can clobber updates and drop entries. Consider a file lock or read-modify-write with retry. (`src/lib/projects-registry.ts:182`)

### Low
- [fixed] `hack init` rejects `dev_host` values not ending in `.hack` even though README suggests custom dev hosts are supported. This is a UX mismatch that forces manual edits. (`src/commands/project.ts:327`)
- [fixed] `hack logs --compose` conflict message mentions `--project`, but `--project` isn’t an option for `hack logs`. This is confusing during error handling. (`src/commands/project.ts:1396`)
- [fixed] Loki reachability uses a hard 800ms timeout; on slow boot or high load this can cause false negatives and unnecessary fallbacks. Consider a configurable or slightly longer timeout. (`src/ui/loki-logs.ts:19`)

## Test coverage gaps

- No automated coverage for `hack init` discovery/scaffolding paths (service inference, Compose generation, OAuth alias labels).
- No tests for registry concurrency or conflict handling in `projects.json`.
- No tests around `hack logs` backend selection (compose vs Loki) and LogQL selector building.
- Minimal coverage for `hack global` flows (install/up/down, DNS/TLS helpers).

## Architecture and design opportunities

- **Structured outputs**: add `--json` for `hack projects`, `hack ps`, `hack logs` (snapshot mode) to enable MCP/TUI/app integrations without parsing human output.
- **Backend abstraction**: formalize a `LogBackend` interface (`compose`, `loki`) and a `RuntimeBackend` (`docker compose`) to keep core logic portable and testable.
- **State/event model**: optional lightweight daemon that subscribes to Docker events and streams project/service state changes to UIs.
- **Config UX**: add `hack config get/set` (or `hack project config`) to validate and mutate `hack.config.json` safely.
- **Compose profile parity**: extend `hack up/down/restart/ps/logs` with `--profile` to mirror `hack run` behavior.
- **Project hygiene**: add `hack projects prune` to remove missing entries and stop orphaned containers/networks.

## Command hierarchy ideas

- `hack status` as a shortcut for `hack projects --details`.
- `hack logs` could accept `--since` / `--until` (Loki only) to align with Grafana usage.
- `hack open` could accept `--service <name>` or `--url <url>` for explicit control.

## Additional feature ideas

- **Multi-worktree support**: a helper to create and name worktrees with unique `hack.config.json` names.
- **Global TLS**: add Linux and Windows trust helpers (best-effort) or a `hack global trust --export` mode.
- **Diagnostics**: `hack doctor --fix` to apply safe auto-remediations (dnsmasq config, CA trust export).
