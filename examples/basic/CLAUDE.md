<!-- hack:agent-docs:start -->
## hack CLI (local dev + MCP)

Use `hack` as the single interface for local runtime orchestration (compose, DNS/TLS, logs, sessions).

Operating rules:
- Prefer `hack` over raw `docker` / `docker compose` for project workflows.
- Do not start/stop services from Docker Desktop UI for `hack`-managed projects.
- Use MCP only when shell access is unavailable.
- If runtime state looks wrong, run `hack doctor`, then `hack doctor --fix` before manual repair.

Core objects:
- Project: a repo with `.hack/` config + compose file.
- Service: a compose service (e.g. api, web, worker).
- Instance: a running project; branch instances are separate copies started with `--branch`.

Config + schema:
- Project config: `.hack/hack.config.json`
- Global config: `~/.hack/hack.config.json`
- Schema URL: `https://schemas.hack/hack.config.schema.json`
- Prefer CLI writes: `hack config get <path>`, `hack config set <path> <value>`, `hack config set --global <path> <value>`

Standard workflow:
- If `.hack/` is missing: `hack init`
- Start services: `hack up --detach` (or `hack up -d`)
- Check status: `hack ps` or `hack status`
- Open app URL: `hack open --json`
- Restart: `hack restart`
- Stop services: `hack down`

Logs (default is compose):
- Fast tail: `hack logs --pretty`
- Per-service tail: `hack logs <service>`
- Machine snapshot: `hack logs --json --no-follow`
- Loki history/query: `hack logs --loki --since 2h --pretty` or `hack logs --loki --query '{project="<name>"}'`
- Force compose backend: `hack logs --compose`
- Global infra logs: `hack global logs caddy --no-follow --tail 200`

Lifecycle + startup:
- Put host setup in `.hack/hack.config.json` under `startup`/`lifecycle` (not ad-hoc terminal tabs).
- Use `lifecycle.up.before` for pre-start hooks and `lifecycle.processes` for long-running host tasks.
- Inspect lifecycle status via `hack projects --details` and stream via `hack logs <service-or-process>`.

Sessions (mux-managed):
- Picker: `hack session`
- Start/attach: `hack session start <project>`
- Force isolated agent session: `hack session start <project> --new --name agent-1`
- Execute in session: `hack session exec <session> "<command>"`
- Stop session: `hack session stop <session>`

Tickets (git-backed):
- Create: `hack tickets create --title "..." --body-stdin`
- List/show: `hack tickets list`, `hack tickets show T-00001`
- Status/sync: `hack tickets status T-00001 in_progress`, `hack tickets sync`

Global infra:
- Bootstrap once: `hack global install`
- Start/stop/status: `hack global up`, `hack global down`, `hack global status`
- Use `hack global up` before Loki/Grafana queries if global logging is offline.

When to use a branch instance:
- You need two versions running at once (PR review, experiments, migrations).
- You want to keep a stable environment while testing another branch.
- Use `--branch <name>` on `hack up/open/logs/down` to target it.

Run commands inside services:
- One-off: `hack run <service> <cmd...>` (uses `docker compose run --rm`)
- Example: `hack run api bun test`
- Use `--workdir <path>` to change working dir inside the container.
- Use `hack ps --json` to list services and status.

Project targeting:
- From repo root, commands use that project automatically.
- Else use `--project <name>` (registry) or `--path <repo-root>`.
- List projects: `hack projects --json`

Daemon (optional):
- Start for faster JSON status/ps: `hack daemon start`
- Check status: `hack daemon status`

Docker compose notes:
- Prefer `hack` commands; they include the right files/networks.
- Use `docker compose -f .hack/docker-compose.yml exec <service> <cmd>` only if you need exec into a running container.

Agent integration maintenance:
- Refresh project + user integrations: `hack setup sync --all-scopes`
- Audit integration state only: `hack setup sync --all-scopes --check`
- Remove generated integration artifacts: `hack setup sync --all-scopes --remove`
- After upgrading CLI: `hack update` then `hack setup sync --all-scopes`

Agent setup (CLI-first):
- Cursor rules: `hack setup cursor`
- Claude hooks: `hack setup claude`
- Codex skill: `hack setup codex`
- Tickets skill: `hack setup tickets`
- Refresh all local agent integrations: `hack setup sync --all-scopes`
- Init prompt: `hack agent init` (use --client cursor|claude|codex to open)
- Init patterns: `hack agent patterns`
- MCP (no-shell only): `hack setup mcp`
- MCP install (explicit): `hack mcp install --all --scope project`
<!-- hack:agent-docs:end -->
