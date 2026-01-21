<a id="readme-top"></a>

<!-- PROJECT LOGO -->
<br />
<div align="center">
<pre style="font-family:monospace;padding:0;margin:0;white-space:pre;font-size:12px;background:none!important;">
 █████   █████   █████████     █████████  █████   ████
░░███   ░░███   ███░░░░░███   ███░░░░░███░░███   ███░ 
 ░███    ░███  ░███    ░███  ███     ░░░  ░███  ███   
 ░███████████  ░███████████ ░███          ░███████    
 ░███░░░░░███  ░███░░░░░███ ░███          ░███░░███   
 ░███    ░███  ░███    ░███ ░░███     ███ ░███ ░░███  
 █████   █████ █████   █████ ░░█████████  █████ ░░████
░░░░░   ░░░░░ ░░░░░   ░░░░░   ░░░░░░░░░  ░░░░░   ░░░░ 
</p>
<br/>
</div>
  <p align="center">
    Opinionated local-dev orchestration for running <b>multiple projects</b> at the same time without port conflicts.
    <br />
  </p>

---
**Network isolation per repo / branch**: every instance runs on its own Docker network (so Postgres/Redis/etc can stay on default ports *inside* the project).

**Stable HTTPS hostnames**: `https://<project>.hack` (and subdomains like `https://api.<project>.hack`) routed by a global Caddy proxy.

**Good logs UX**: instant `docker compose logs` tailing, plus Loki/Grafana for querying + history.

**Opt-in per repo**: no invasive changes to your codebase; config lives in `.hack/`.

---

### Why this exists

Most of my projects run the same stack. That’s fine until you want to:

- run two projects at the same time
- run two branches of the same repo
- run multiple worktrees in parallel

At that point everything fights over `localhost` and default ports.

The daily choice:

- **Option A:** stop A → start B → ship fix → stop B → restart A  
  you just spent 5–10 minutes paying the orchestration tax and nuking your focus.
- **Option B:** don’t run it. code blind. push. let CI tell you what you broke.

Neither scales. Both slow you down in dumb, repeatable ways.


## Installation

### Prerequisites
- **macOS**: supported.
- **Docker + Compose**: [Orbstack](https://docs.orbstack.dev/quick-start) | [Docker Desktop](https://www.docker.com/get-started/) 

### Install

Grab the install script

```bash
curl -fsSL https://github.com/hack-dance/hack-cli/releases/latest/download/hack-install.sh | bash
```

### Setup
```bash
hack global install
```

### Quick start 
Manual (CLI):

```bash
cd /path/to/your-repo
hack init
hack up --detach
hack open
```

Agent-assisted (Cursor/Claude/Codex with shell access):

```bash
hack setup cursor   # or hack setup claude / hack setup codex
hack setup agents   # optional: adds AGENTS.md + CLAUDE.md snippets
hack agent init --client cursor   # or --client claude / --client codex
hack agent patterns              # optional: dependency/ops checklist
```

If you omit `--client`, `hack agent init` will prompt you to choose (TTY only).
If your agent does not auto-open, paste the output into the chat. Example:

```
I ran `hack agent init` and pasted the output below. Please follow it to set up hack for this repo,
then run:
- `hack init` (use --auto if dev scripts are detected)
- `hack up --detach`
- `hack open --json`
If anything fails, use `hack logs --pretty` and summarize next steps.

<PASTE HACK AGENT INIT OUTPUT HERE>
```

If the agent cannot run shell commands, use MCP instead: `hack setup mcp` and `hack mcp serve`.

### macOS app (experimental)
Source lives in `apps/macos`. See `apps/macos/README.md` for XcodeGen and build/run steps.
Quick commands (repo root):

```bash
bun run macos:project-gen
bun run macos:open
bun run macos:dev
bun run macos:build
bun run macos:test
```

### Configuration (.hack/hack.config.json)
- `name`: project slug (also used for Docker Compose project name)
- `dev_host`: base hostname (`<dev_host>.hack`)

*Optional `[logs]` settings*
- `follow_backend`: `compose|loki` (default: `compose`)
- `snapshot_backend`: `compose|loki` (default: `loki`)
- `clear_on_down`: when running `hack down`, request Loki delete for this project (best-effort)
- `retention_period`: e.g. `"24h"`; on `hack down`, prune older logs (best-effort)

*Optional `[internal]` settings (container DNS/TLS)*
- `dns`: use CoreDNS to resolve `*.hack` inside containers (default: `true`)
- `tls`: mount Caddy Local CA + set common SSL env vars (default: `true`)
- `extra_hosts`: static Compose `extra_hosts` entries (hostname → IP/target), merged into the internal override

If you need **dynamic** `extra_hosts` (e.g. Pulumi outputs / local tunnels that change), use:

```bash
hack internal extra-hosts set <hostname> <target>
hack internal extra-hosts unset <hostname>
hack internal extra-hosts list
```

This writes `.hack/.internal/extra-hosts.json` and is merged into `extra_hosts` when you run `hack up` / `hack restart`.

*Optional `[oauth]` settings (OAuth-safe alias host)*
- `enabled`: when true, `hack init` generates Caddy labels so routed services answer on both:
- primary: `https://<dev_host>`
- OAuth alias: `https://<dev_host>.<tld>` (e.g. `https://sickemail.hack.gy`)
- `tld`: optional (default: `"gy"`). Only `*.hack.gy` is bootstrapped automatically by `hack global install`; other TLDs require manual DNS setup.

The file includes a JSON Schema reference for editor validation:

```json
{
  "$schema": "https://schemas.hack/hack.config.schema.json"
}
```

Schemas are served locally by the global Caddy proxy at `https://schemas.hack`.

Quick edits:

```bash
hack config get dev_host
hack config set dev_host "myapp.hack"
hack config set logs.snapshot_backend "compose"
```

## Commands (high level)

Run `hack help` (or `hack help <command>`) for full usage.

Common:
- `hack global install|up|down`
- `hack init|up|down|logs|open|tui`
- `hack status`
- `hack remote setup`
- `hack gateway enable`

Full command table + flags: `docs/cli.md`.

Run `hack help <command>` for detailed help.

Project commands that call Docker Compose accept `--profile` (up/down/restart/ps/logs/run).

## JSON output

Use `--json` for machine-readable output:

- `hack projects --json`
- `hack ps --json`
- `hack logs --json` (NDJSON stream; use `--no-follow` for snapshots)
- `hack open --json` (returns `{ "url": "..." }`)

When the daemon is running, `hack projects --json` and `hack ps --json` use it for faster results.

`hack logs --json` emits event envelopes (`start`, `log`, `end`) so MCP/TUI consumers can stream safely.

## Daemon (optional)

`hackd` is a local daemon that caches Docker state for fast status/ps queries.

```bash
hack daemon start
hack daemon status
hack daemon metrics
hack daemon stop
hack daemon logs
```

### launchd integration (macOS)

On macOS, you can install `hackd` as a launchd service for automatic management:

```bash
# Install with auto-start on login
hack daemon install --run-at-load

# Install without auto-start (manual start/stop via launchd)
hack daemon install

# Uninstall the launchd service
hack daemon uninstall
```

Options:
- `--run-at-load` / `--no-run-at-load`: Start automatically on login
- `--gui-only` / `--no-gui-only`: Only run in GUI sessions (default: GUI only)

The service uses label `dance.hack.hackd` and writes to `~/Library/LaunchAgents/`.

Use it when:
- You run `hack projects --json` / `hack ps --json` frequently (scripts, agent workflows, TUI).
- You want faster status snapshots without shelling out to Docker each time.

Skip it when:
- You prefer zero background processes.
- You rarely use JSON status/ps outputs.

If it is not running (or version-mismatched), the CLI falls back to direct Docker calls.

## Control plane + extensions (optional)

`hack` includes a small control-plane kernel so features like jobs, tickets, and remote access can
ship as extensions without bloating the core CLI.

- Extension commands run via `hack x <namespace> <command>`.
- Global control-plane config lives at `~/.hack/hack.config.json` (`hack config set --global ...`).
- Per-project overrides live in `.hack/hack.config.json` and win over global values.
- `controlPlane.gateway.enabled` is project-scoped and implicitly enables the gateway extension.

See `SPECS/control-plane/consolidated.md` and `docs/extensions.md` for the extension SDK surface.

### Gateway (remote access)

The gateway exposes `hackd` over HTTP/WS with token auth. It binds to `127.0.0.1` by default and
should be exposed via a Zero Trust/VPN or SSH tunnel when needed. `hack remote setup` is the
one-command flow that enables the gateway, creates a token, and can configure + start exposure
(Cloudflare/Tailscale/SSH) via prompts. It prints a QR by default (use `--no-qr` to skip).

```bash
hack remote setup
# or:
hack gateway setup
# or manually:
hack gateway enable
hack daemon stop && hack daemon start
hack x gateway token-create
```

Gateway tokens default to read-only. For non-GET requests, set
`controlPlane.gateway.allowWrites = true` globally and create a write-scoped token:

```bash
hack config set --global 'controlPlane.gateway.allowWrites' true
```

```bash
hack x gateway token-create --scope write
```

Current gateway API (HTTP/WS):
- status/metrics/projects/ps (`/v1/*`)
- supervisor jobs: list/create/show/cancel + log/event stream (`/control-plane/*`)
- supervisor shells: create/show + PTY stream (write token + allowWrites)
- CLI shell client: `hack x supervisor shell` (gateway + write token required)

Interactive shells are available over the gateway WebSocket; the CLI can attach with
`hack x supervisor shell` (write token + allowWrites required). Use SSH/Zero Trust for a full
terminal UI, or run commands via supervisor jobs.

See `docs/gateway-api.md` for full API usage, structured workflow patterns, and a runnable demo.

Remote access options (recommended order):
1) SSH tunnel to the gateway port for quick, ad-hoc access.
2) Zero Trust/VPN (Tailscale, Cloudflare, etc.) for persistent access.
3) Optional Caddy route (`https://gateway.hack`) for local convenience.

Note: Cloudflare Tunnel is ideal for the gateway HTTP/WS surface. It is not a direct SSH
replacement on iOS; use Tailscale/VPN for SSH access from mobile clients.
If you already use Cloudflare WARP, configure a private network route to your laptop and
use that IP/hostname for SSH in your mobile client.

Remote helper:
- `hack remote` shows status and offers to run setup when needed.
- `hack remote status` prints gateway + exposure status.
- `hack remote qr` prints a QR payload for SSH or gateway usage (confirm before sharing).
- `hack remote monitor` opens a mini TUI (status + gateway audit log tail).

Cloudflare tunnel helper:

```bash
hack x cloudflare tunnel-setup --hostname gateway.example.com
hack x cloudflare tunnel-start
```

Tailscale helper:

```bash
hack x tailscale setup
hack x tailscale status
```

DNS note: `cloudflared tunnel route dns <tunnel> <hostname>` creates the required CNAME to
`<tunnel-id>.cfargotunnel.com` in your Cloudflare zone (proxied).

### Supervisor (jobs + shells)

The supervisor is the job/shell runner that powers agent workflows and remote execution. It can run
commands, stream logs, and host PTY-backed shells. Use it locally with `hack x supervisor` or
remotely over the gateway.

Docs: `docs/supervisor.md`.

## Docs

Start here:
- `docs/README.md` (index)
- `docs/architecture.md`
- `docs/gateway.md`
- `docs/extensions.md`

## Agent setup (CLI-first)

Use `hack setup` to install local integrations. Default is project scope; add `--global` for user scope.

```bash
hack setup cursor
hack setup claude
hack setup codex
hack setup agents
```

What each setup command does:
- `hack setup cursor`: installs Cursor rules in `.cursor/rules/hack.mdc`
- `hack setup claude`: installs Claude Code hooks in `.claude/settings.local.json` (or user scope)
- `hack setup codex`: installs the Codex skill in `.codex/skills/hack-cli/SKILL.md`
- `hack setup agents`: adds/updates hack usage snippets in `AGENTS.md` and `CLAUDE.md`
- `hack setup mcp`: writes MCP configs for no-shell clients

Primer helpers:
- `hack agent prime`: short CLI-first primer used by Claude Code hooks
- `hack agent init`: repo-specific setup prompt agents can follow to scaffold/verify hack config
- `hack agent init --client cursor|claude|codex`: open the prompt directly in an agent client
- `hack agent patterns`: dependency/ops checklist for agents

Recommended flow:
- Use `hack setup cursor|claude|codex` for your agent client
- Use `hack setup agents` to document hack usage inside the repo
- Use `hack setup mcp` only when the agent has no shell access

## MCP (no-shell clients)

Use MCP only when the CLI is not available (e.g. no shell access).

Run the MCP server locally over stdio:

```bash
hack mcp serve
```

Most MCP clients spawn this on demand. Running it directly will wait for a client connection.

Install MCP configs (Cursor, Claude CLI, Codex):

```bash
# Project-scoped (default via setup)
hack setup mcp

# User-scoped (default; writes to your home config directories)
hack mcp install --all

# Project-scoped (writes .cursor/.claude/.codex in the repo)
hack mcp install --all --scope project
```

Project scope writes `.cursor/mcp.json`, `.claude/settings.json`, and `.codex/config.toml`.

Print config snippets without writing:

```bash
hack mcp print --codex
```

`hack init` can prompt to install local agent integrations after scaffolding a repo.
For agent-driven scaffolding without prompts, use `hack init --auto` and run `hack setup` manually.

## Branch builds (worktree-friendly)

Use `--branch <name>` on project commands to run isolated instances with unique hostnames and compose
project names:

```bash
hack up --branch feature-x --detach
hack logs --branch feature-x
hack open --branch feature-x
```

Using `--branch` will create/update `.hack/hack.branches.json` with a `last_used_at` timestamp. Branch
instances show up in `hack projects --details`.

Optional: track branch aliases in `.hack/hack.branches.json` for quick lookup:

```bash
hack branch add feature-x --note "worktree for PR 123"
hack branch list
hack branch open feature-x
```


## Service-to-service connections (HTTP vs DB/Redis)

If your app runs in Docker (the default in `hack`), don’t connect to `127.0.0.1` / `localhost` for Postgres/Redis.
Inside a container, `localhost` is that container, not the other compose services.

If you previously ran everything on your host and used `localhost:PORT`, update those references when you
move into containers:

- **HTTP services**: use the same `https://*.hack` hostname you open from the host (whatever you configured in Caddy labels, e.g. `https://api.myapp.hack`).
- **Non-HTTP services** (DB/Redis/etc.): use the Compose service hostname (e.g. `db`, `redis`).

For HTTP services, use the same `https://*.hack` URLs you use on the host. `hack up` injects internal DNS,
TLS trust, and `extra_hosts` mappings so `*.hack` resolves reliably inside containers. If you see `ENOTFOUND`
inside containers, run `hack restart` to refresh the host mappings.

For non-HTTP services, use the Compose service hostname on the default network:

- `Postgres: db:5432`
- `Redis: redis:6379`

Note: Caddy’s CA is mounted into containers when `internal.tls: true` so HTTPS calls to `*.hack` work for most runtimes.
If you’re using Java/Kotlin, you’ll need to import the CA into the JVM truststore manually.

Example:

```yaml
environment:
  DATABASE_URL: postgres://postgres:postgres@db:5432/mydb
  REDIS_URL: redis://redis:6379
```

If you need host access for debugging, prefer `docker compose exec` so you don’t reintroduce port conflicts:

```bash
docker compose -f .hack/docker-compose.yml exec db psql -U postgres -d mydb
docker compose -f .hack/docker-compose.yml exec redis redis-cli
```

## Logs (why both Compose and Loki)

By default, `hack logs` uses `docker compose logs` because it’s the lowest latency tail.
The daemon does not proxy logs yet; `hack logs` still talks directly to Docker Compose or Loki.

Loki is still valuable for:

- querying across time (history)
- filtering by labels (project/service/container)
- Grafana Explore / dashboards

### CLI

```bash
# Tail (fast)
hack logs --pretty

# Snapshot
hack logs --no-follow --pretty

# Snapshot JSON
hack logs --no-follow --json

# Query/history (force Loki)
hack logs --loki --pretty

# Range (Loki only)
hack logs --loki --since 2h --pretty
hack logs --loki --since 4h --until 1h --pretty

# Filter Loki by service
hack logs --loki --services api,worker --pretty

# Raw LogQL
hack logs --loki --query '{project="my-project"} |= "error"' --pretty
```

### Grafana

- Open: `hack open logs` or visit `https://logs.hack`
- Explore queries:

```logql
{project="my-project"}
{project="my-project", service="api"}
```

Alloy labels logs with:

- project: `Docker Compose project name`
- service: `Docker Compose service name`
- container: `Docker container name`


## Projects registry (bird’s-eye view)

`hack` maintains a best-effort registry under `~/.hack/projects.json` so you can target a project from anywhere:

```bash
hack projects
hack logs --project my-project --pretty
hack up --project my-project
```

## .hack and valid tld requirements

OAuth providers (notably Google) require `localhost` or a host that ends with a real public suffix.

We keep `.hack` as the primary local dev domain, and optionally expose an alias domain for OAuth flows.
If the OAuth alias is enabled, `hack global install` configures `*.hack.gy` to resolve to `127.0.0.1`
via dnsmasq + the OS resolver.

If you use Next.js (or another dev server that cares about dev origins), configure its dev allowlist to include the proxy domains.
Next.js supports `allowedDevOrigins` (wildcards supported) in `next.config.js`:

```js
module.exports = {
  allowedDevOrigins: ["*.hack", "*.hack.gy"],
}
```

Optionally you can pass in your own custom `dev_host` to the config.


## SSL

`hack` uses Caddy’s internal PKI to issue certs for `*.hack` (and any OAuth alias host). This covers
HTTPS for services routed through Caddy, but it does not create cert/key files for services running
outside of Caddy.

- macOS: run `hack global trust` to trust the Caddy Local CA in the System keychain.
- Other OS: run `hack global ca` to export the CA cert path, then add it to your OS/browser trust store.
- If you need the PEM directly: `hack global ca --print`.
- If you are running a local service outside of Caddy, use `hack global cert <host...>` (mkcert required) to generate a cert/key under `~/.hack/certs` and wire it into your service. This is only needed for non-Caddy services that still want trusted TLS.
- macOS: `hack global install` can optionally install mkcert (needed for `hack global cert`).

Install mkcert if you don't already have it (macOS example):

```bash
brew install mkcert
mkcert -install
```

Example (non-Caddy service):

```bash
hack global cert --install api.myapp.hack
```

Use `--out <dir>` if you want certs written somewhere else.

## Internal DNS (containers)

`hack global install` runs CoreDNS on the `hack-dev` network. CoreDNS answers `*.hack` and `*.hack.*` with
Caddy’s current IP so containers can use the same `https://*.hack` URLs as the host.

Some runtimes don’t honor custom DNS for `*.hack` reliably, so `hack up` also injects `extra_hosts` mappings
to the Caddy IP. If the Caddy IP changes, `hack status`, `hack doctor`, and the TUI show a warning; fix it
with `hack restart` to refresh the mapping.

If you also need `extra_hosts` for non-`*.hack` hostnames (common when you run host-local tunnels/proxies
and want containers to reach them by their real domain), use `hack internal extra-hosts set` to write a
repo-local `.hack/.internal/extra-hosts.json` that gets merged into the generated Compose override.

When `internal.tls` is enabled, `hack up` mounts the Caddy Local CA into each container and sets common
SSL env vars so HTTPS to `*.hack` is trusted inside containers.

If you update `hack`, rerun `hack global install` once to refresh the CoreDNS config.




## Why not just use X?

### Docker / Compose alone

They run containers. They don’t give you stable hostnames, HTTPS, or a way to run many isolated copies of the same stack without custom glue. 

You can build that layer yourself. I did. That’s this.

### Kubernetes

Kubernetes solves cluster orchestration. This problem is local parallelism.  
It adds complexity without fixing ports, routing, or developer feedback loops.

### Different ports

This is the default answer and it doesn’t scale.  
Ports leak into config, break OAuth and cookies, and turn into debt.  
Hostnames scale. Ports don’t.

There isn’t an off-the-shelf tool that gives you full local network isolation, real HTTPS, and near zero per-repo setup.

If you want that, you have to build it yourself.


## How it works

`hack` is a thin layer on top of Docker Compose plus a tiny global proxy.

- each project/branch runs in its own Docker network
- services use their normal ports inside that network
- a shared proxy routes `https://*.hack` and handles HTTPS
- logs are captured centrally

Your code doesn’t change. Your mental overhead does.

### Global (once per machine)

`hack global install` provisions `~/.hack/` and starts:

- **Caddy** (`lucaslorentz/caddy-docker-proxy`) on ports `80/443`
  - watches Docker labels and auto-routes `https://*.hack`
- **Logging stack**: Grafana + Loki + Alloy
  - reachable via `https://logs.hack`

### Per-project (per repo)

`hack init` creates `.hack/` in the repo root:

- `.hack/docker-compose.yml`: your project services
- `.hack/hack.config.json`: project config (name, dev host, log preferences)

Each project’s compose network stays isolated; only services you want “public” get attached to the shared ingress network so Caddy can reach them.


## Common patterns (deps + ops)

Agents: run `hack agent patterns` for a compact checklist based on this section.

### 1) Containerized dependency installs (recommended)

If you run `bun install` on the host and then start Linux containers, you can hit platform
mismatches (native modules, postinstall scripts, OS-specific binaries). The clean pattern is to
install dependencies **inside** Docker and share them via a volume.

Add a one-shot deps service and make your app services depend on it:

```yaml
deps:
  image: imbios/bun-node:latest
  working_dir: /app
  volumes:
    - ..:/app
    - node_modules:/app/node_modules
  command: bun install
  networks:
    - default

www:
  image: imbios/bun-node:latest
  working_dir: /app/apps/www
  volumes:
    - ..:/app
    - node_modules:/app/node_modules
  depends_on:
    deps:
      condition: service_completed_successfully
```

This keeps dependency resolution in the same OS as your containers and avoids host/guest drift.

### 2) Networked ops commands (DB schema tooling, migrations)

Because `hack` avoids publishing DB ports to your host, run schema/ops commands inside the
compose network.

Option A (recommended): add an ops-only service:

```yaml
db-ops:
  image: imbios/bun-node:latest
  working_dir: /app/packages/db # where your db schema + package.json live
  volumes:
    - ..:/app
    - node_modules:/app/node_modules
  environment:
    DATABASE_URL: postgres://postgres:postgres@db:5432/mydb
  depends_on:
    - db
    - deps
  networks:
    - default
  profiles: ["ops"]
  # Examples:
  # - Prisma:  bunx prisma migrate deploy
  # - Drizzle: bunx drizzle-kit push
  command: bun run db:push
```

Run it on demand:

```bash
docker compose -f .hack/docker-compose.yml --profile ops run --rm db-ops
```

Option B: run via `hack run` (thin wrapper over `docker compose run --rm`):

```bash
hack run --workdir /app/packages/db email-sync -- bunx prisma generate
hack run --workdir /app/packages/db email-sync -- bunx prisma migrate dev
hack run --workdir /app/packages/db email-sync -- bunx drizzle-kit push
hack run --workdir /app bun run turbo db:migrate
```

If your ops service is behind a compose profile, enable it:

```bash
hack run --profile ops --workdir /app/packages/db db-ops -- bun run db:push
```

See examples:
- `examples/next-app/README.md`


## Troubleshooting

- `*.hack` doesn’t resolve: run `hack doctor`, then `hack global install` (macOS: ensure dnsmasq is running).

- Stale global setup / CoreDNS issues: run `hack doctor --fix` (refreshes network + CoreDNS + CA).

- TLS warnings: run `hack global trust` (macOS).

- Logs missing in Grafana: ensure Alloy is running (`hack global status`) and try `{app="docker"}` in Explore.

- `ENOTFOUND` for `*.hack` inside containers: run `hack restart` to refresh `extra_hosts` mappings (check
  `hack status` or the TUI for Caddy IP mismatch warnings).

- `EAI_AGAIN` for external domains inside containers (e.g. `api.clerk.com`): CoreDNS isn’t forwarding.
  Run `hack global install` and restart CoreDNS:
  `docker compose -f ~/.hack/caddy/docker-compose.yml restart coredns`.

- `hack global up` warns about `hack-dev` network labels or missing subnet: remove the network and reinstall:
  `docker network rm hack-dev` then `hack global install`.

- OAuth redirect errors: use the OAuth alias host (`*.hack.gy`) or `localhost` (providers may reject non-public suffixes like `.hack`).



## Development

### From source

```bash
bun install
bun run install:dev
hack --help
```
This installs a small `hack` shim into `~/.hack/bin/hack` that runs your working tree directly (no rebuild needed).

If `hack` isn’t found, add this to your shell config:

```bash
export PATH="$HOME/.hack/bin:$PATH"
```

### Compiled binary (release-like)

```bash
bun install
bun run install:bin
hack --help
```
This builds `dist/hack` via `bun build --compile` and installs it to `~/.hack/bin/hack`.

### Check which install is active

```bash
bun run install:status
```
Reports whether `hack` is a dev shim or a compiled binary (and where it points).


### Run in place

```bash
bun dev --help
```

### Tests

```bash
bun test
```

### Conventional commits

```bash
bun run commit
```

Commitlint runs on `git commit` via husky, and semantic-release uses Conventional Commits to
compute versions.

### Build a standalone binary

```bash
bun run build
./dist/hack --help
```

### Build a release bundle

```bash
bun run build:release
```
Produces `dist/release/hack-<version>-release/`, a tarball, and `hack-install.sh`.

### Release (tag + GitHub workflow)

```bash
bun run release:prepare
git push --follow-tags
```

Updates `CHANGELOG.md` + `package.json`, creates the release commit and tag, and triggers the
GitHub Release workflow on push.

See `PACKAGING.md` for details.


See also:
- [Examples](examples/next-app/README.md)
- [Docs](docs/README.md)
- [Architecture](docs/architecture.md)


<p align="right">(<a href="#readme-top">back to top</a>)</p>
