<!-- hack:agent-docs:start -->
## hack CLI (local dev + MCP)

Use `hack` as the single interface for local dev. It manages docker compose, TLS/DNS, and logs.

Concepts:
- Project: a repo with `.hack/` config + compose file.
- Service: a docker compose service (e.g. api, web, worker).
- Instance: a running project; branch instances are separate copies started with `--branch`.

When to use a branch instance:
- You need two versions running at once (PR review, experiments, migrations).
- You want to keep a stable environment while testing another branch.
- Use `--branch <name>` on `hack up/open/logs/down` to target it.

Standard workflow:
- If `.hack/` is missing: `hack init`
- Start services: `hack up --detach`
- Check status: `hack ps` or `hack projects status`
- Open app: `hack open` (use `--json` for machine parsing)
- Stop services: `hack down`

Logs and search:
- Tail compose logs: `hack logs --pretty` or `hack logs <service>`
- Snapshot for agents: `hack logs --json --no-follow`
- Loki history: `hack logs --loki --since 2h --pretty`
- Filter Loki services: `hack logs --loki --services api,web`
- Raw LogQL: `hack logs --loki --query '{project="<name>"}'`
- Force compose logs: `hack logs --compose`
- If Loki is unavailable, start global logs: `hack global up`

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

Agent setup (CLI-first):
- Cursor rules: `hack setup cursor`
- Claude hooks: `hack setup claude`
- Codex skill: `hack setup codex`
- Init prompt: `hack agent init` (use --client cursor|claude|codex to open)
- Init patterns: `hack agent patterns`
- MCP (no-shell only): `hack setup mcp`
<!-- hack:agent-docs:end -->
