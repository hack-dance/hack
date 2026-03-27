
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Coding Style & Naming Conventions

TypeScript (strict). Runtimes: Bun 1.3+, Node 23. Prettier: 2 spaces, no semicolons, double quotes, width 100. Import order: @ianvs/prettier-plugin-sort-imports + Tailwind plugin. ESLint (flat): any disallowed; unused vars warned (prefix \_ to ignore). Naming: React components PascalCase; files kebab-case (e.g., user-profile.ts); packages @repo/<name>. Comments: avoid writing inline comments everywhere, unless absolutely necessary for a todo or an important thing to take note of. Instead write tsdoc style block level comments at the method/class/function/route level. Focus on comments that provide value in regards to better type inference and clarity of usage. Using things like params/returns/etc..

Always default to useing named paramaters in functions eg myFunction({ ctx, other }) vs myFunction(ctx, other)
Never use any types and always default to leveraging generics and smart types to sensure the best possible tpye inference across the project.

<!-- hack:tickets:start -->
## Tickets (git-backed)

This project uses `hack` tickets (extension: `dance.hack.tickets`).

Common commands:
- Create: `hack tickets create --title "..." --body-stdin [--depends-on "T-00001"] [--blocks "T-00002"]`
- List: `hack tickets list`
- Tui: `hack tickets tui`
- Show: `hack tickets show T-00001`
- Update: `hack tickets update T-00001 [--title "..."] [--body "..."] [--depends-on "..."] [--blocks "..."]`
- Status: `hack tickets status T-00001 in_progress`
- Sync: `hack tickets sync`

Recommended body template (Markdown):
```md
## Context
## Goals
## Notes
## Links
```

Tip: use `--body-stdin` for multi-line markdown.

Data lives in `.hack/tickets/` (gitignored on the main branch) and syncs to hidden ref `refs/hack/tickets` by default.
<!-- hack:tickets:end -->

## Project Notes (Obsidian)

This project uses Obsidian for project context, specs, research, and progress tracking.

**Vault**: `~/.vaults/core`
**Project folder**: `30 Projects/Hack CLI/Notes/`

**When to write notes**:
- Project analysis and architecture reviews
- Research findings (e.g., Ghostty VT, libraries, APIs)
- Specs and design decisions
- Session summaries with progress updates
- Any context that should persist across sessions

**How to write notes**:
- Use the `obsidian` skill to interact with the vault
- Name notes with date prefix: `YYYY-MM-DD — Title.md`
- Include tags: `#hack-cli #substrate`

## Landing the Plane (Session Completion)
**When ending a work session**, you MUST complete ALL steps below.

**MANDATORY WORKFLOW:**
1. **File tickets for remaining work** - Create tickets for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Write session summary to Obsidian** - Key decisions, progress, blockers
5. **Hand off** - Provide context for next session

<!-- hack:agent-docs:start -->
## hack CLI (local dev + MCP)

Use `hack` as the single interface for local runtime orchestration (compose, DNS/TLS, logs, persistent project workspaces).

Operating rules:
- Prefer `hack` over raw `docker` / `docker compose` for project workflows.
- Do not start/stop services from Docker Desktop UI for `hack`-managed projects.
- Treat `.hack/.internal` and `.hack/.branch` as hack-managed artifacts; do not hand-edit generated files there.
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

Hostname routing + Caddy labels:
- Primary host comes from `dev_host` (default: `<project>.hack`).
- Subdomain pattern is `<sub>.<dev_host>` (for example: `api.myapp.hack`).
- OAuth alias (when enabled) also routes `<dev_host>.<tld>` and `<sub>.<dev_host>.<tld>` (default tld: `gy`).
- Not every compose service is routable: only services with Caddy labels and on `hack-dev` are exposed.
- Required labels for HTTP services: `caddy`, `caddy.reverse_proxy`, `caddy.tls=internal`.
- Quick checks: `hack open`, `hack open <sub>`, `hack open --json`.

TLS + valid-hostname constraints:
- `hack` uses Caddy internal PKI for HTTPS on routed hosts; trust CA with `hack global trust`.
- `.hack` is local-first and great for dev, but it is not a public suffix.
- Use OAuth alias hosts (for example `*.hack.gy`) when providers require public-suffix-style callback domains.
- Alias hosts are still local-dev routes unless you add an external tunnel/remote ingress path.

Project files (managed vs generated):
- Source-of-truth files: `.hack/docker-compose.yml`, `.hack/hack.config.json`, `.hack/hack.env.json` (if env contract is used).
- Local-only files: `.hack/.env` and `.hack/.internal/` (runtime/local machine state; keep gitignored).
- Generated (do not hand-edit): `.hack/.internal/compose.override.yml`, `.hack/.internal/compose.env.override.yml`, `.hack/.branch/compose.<branch>.override.yml`.
- Managed via CLI: `.hack/.internal/extra-hosts.json` (use `hack internal extra-hosts ...` commands).
- Lifecycle runtime files: `.hack/.internal/lifecycle/state.json`, `.hack/.internal/lifecycle/*.log`.

Advanced networking (extra_hosts + local proxies/tunnels):
- Static host mappings: set `internal.extra_hosts` in `.hack/hack.config.json`.
- Dynamic host mappings: `hack internal extra-hosts set <hostname> <target>` / `unset` / `list`.
- For host-local proxies/tunnels, prefer `host-gateway` as target when possible.
- After mapping changes or proxy IP churn: `hack restart` and then `hack doctor`.

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

Workspaces (mux-managed, tmux-first by default):
- Picker: `hack session` for persistent project workspaces.
- Reuse/create: `hack session start <project>`
- Force isolated agent workspace: `hack session start <project> --new --name agent-1` (`<project>--agent-1`).
- Execute in workspace: `hack session exec <workspace> "<command>"`
- Stop workspace: `hack session stop <workspace>`

Tickets (git-backed):
- Create: `hack tickets create --title "..." --body-stdin`
- List/show: `hack tickets list`, `hack tickets show T-AB12CD34EF`
- Status/sync: `hack tickets status T-AB12CD34EF in_progress`, `hack tickets sync`

Global infra:
- Bootstrap once: `hack global install`
- Start/stop/status: `hack global up`, `hack global down`, `hack global status`
- Use `hack global up` before Loki/Grafana queries if global logging is offline.

Remote nodes + dispatch:
- Pair/register nodes: `hack node pair ...`, then verify with `hack node list` and `hack node status --watch`.
- Repair SSH for remote Git/mutagen: `hack node ssh setup --node <id>`.
- On node host, inspect workspace map via `hack node workspace list|resolve|attach|remove`.
- Inspect/repair controller-side route bridge with `hack node routes status` and `hack node routes repair`.
- Dispatch remote commands: `hack dispatch run --project <name|id> --node default --branch <branch> --runner generic -- "<command>"`.

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
- Project-level hack commands auto-check integration drift and attempt auto-sync (docs/skills/MCP).
- Set `HACK_SETUP_SYNC_MODE=warn` to only warn, or `HACK_SETUP_SYNC_MODE=off` to disable.
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
