# Hack

```text
 █████   █████   █████████     █████████  █████   ████
░░███   ░░███   ███░░░░░███   ███░░░░░███░░███   ███░
 ░███    ░███  ░███    ░███  ███     ░░░  ░███  ███
 ░███████████  ░███████████ ░███          ░███████
 ░███░░░░░███  ░███░░░░░███ ░███          ░███░░███
 ░███    ░███  ░███    ░███ ░░███     ███ ░███ ░░███
 █████   █████ █████   █████ ░░█████████  █████ ░░████
░░░░░   ░░░░░ ░░░░░   ░░░░░   ░░░░░░░░░  ░░░░░   ░░░░
```

Hack is a local-first platform for developers and agents who need to run more than one project, branch, or workflow at once.

It makes three promises: **run projects in parallel**, **normalize all your tickets**, and **manage project env safely**.

When local dev breaks down, it usually breaks down in the same places: ports collide, work gets split across too many ticket systems, and env setup turns into tribal knowledge. Hack is the opinionated layer that makes those problems boring again.

Sessions and integrations support those promises directly: sessions keep terminal work durable, and integrations let agents, ticket systems, and remote surfaces plug into the same project model.

## The Three Core Promises

### 1. Run projects in parallel

Hack lets each repo or branch run as its own isolated local environment instead of fighting over `localhost`, shared Docker networks, or ad-hoc port maps.

- Run multiple repos at the same time.
- Run multiple branches or worktrees of the same repo at the same time.
- Keep service defaults like Postgres and Redis on their normal container ports.
- Open stable HTTPS hostnames like `https://<project>.hack` and `https://api.<project>.hack`.

Core commands:

```bash
hack up --detach
hack up --branch feature-x --detach
hack open
hack logs --pretty
```

### 2. Normalize all your tickets

Hack keeps a local-first, git-backed ticket substrate in your repo, then lets external systems like Linear sync into that substrate instead of forcing your workflow to live in five different places.

- Track work in git with lightweight hack tickets.
- Sync issues and projects with Linear when you need shared coordination.
- Preserve ownership and provenance so local and synced tickets stay understandable.
- Give the CLI, agents, and the macOS app one normalized ticket model to work against.

Core commands:

```bash
hack tickets setup
hack tickets create --title "Investigate flaky auth flow"
hack tickets list
hack linear project-bind --project-id "<linear-project-id>"
hack linear sync-project --from linear --project-id "<linear-project-id>"
```

Docs:

- [Tickets guide](docs/guides/tickets.md)
- [Linear integration architecture](docs/guides/linear-integration-architecture.md)

### 3. Manage project env safely

Hack separates shareable env structure from secret values so teams and agents can understand what a project needs without leaking sensitive material into git.

- Commit an env contract in `.hack/hack.env.json`.
- Keep plain local values in gitignored `.hack/.env`.
- Store secrets in the OS keychain or another configured backend.
- Resolve env requirements before `hack up`, `hack run`, or `hack restart`.

Core commands:

```bash
hack env list
hack env set AWS_PROFILE=dev
hack env set --secret DATABASE_URL=postgres://...
hack env backend status
```

Docs:

- [Env and secrets](docs/env.md)

## First Run

### Prerequisites

- macOS
- Docker + Compose via [OrbStack](https://docs.orbstack.dev/quick-start) or [Docker Desktop](https://www.docker.com/get-started/)

### 1. Install Hack

CLI only:

```bash
curl -fsSL \
  https://github.com/hack-dance/hack/releases/latest/download/hack-install.sh \
  | bash
```

CLI + desktop app:

- Download the latest DMG from [GitHub Releases](https://github.com/hack-dance/hack/releases/latest)
- Install the CLI from the DMG
- Optionally keep the macOS app for the beta desktop surface

### 2. Set up your machine

```bash
hack global install
```

### 3. Start your first project

```bash
cd /path/to/your-repo
hack init
hack up --detach
hack open
```

If you want the shortest non-interactive path for an existing repo, use `hack init --auto`.

### 4. Optional: install agent integrations

Use these when you want Cursor, Claude, or Codex to understand Hack workflows directly.

```bash
hack setup cursor
hack setup claude
hack setup codex
hack setup sync --all-scopes
```

If your agent does not have shell access, use MCP instead:

```bash
hack mcp install --all --scope project
```

Docs:

- [Initialize a project](docs/guides/init-project.md)
- [CLI reference](docs/cli.md)

## Supporting Capabilities

### Sessions

Sessions keep terminal work durable. They are not the headline promise, but they are a first-class support capability for parallel project work, remote access, and long-running agents.

- Backed by `tmux` or `zellij`
- Started from the project root, not from `.hack/`
- Useful for remote attach, agent execution, and multi-terminal workflows

```bash
hack session
hack session start my-project --up
hack session attach my-project
hack session exec my-project "bun test"
```

Docs:

- [Sessions](docs/sessions.md)

### Integrations

Integrations make the core promises more usable without changing what Hack is.

- Agent integrations via `hack setup`
- MCP for no-shell clients via `hack mcp`
- Linear as a ticket-normalization extension, not the center of the product

If your agent has shell access, prefer the CLI. Use MCP only when shell access is unavailable.

Docs:

- [Extensions](docs/extensions.md)
- [Gateway overview](docs/gateway.md)

## Beta Capabilities

> Beta surfaces are real and useful, but they are not the core promise of Hack yet.

### Remote control plane

The gateway, supervisor, and remote shell flows let you control Hack over HTTP and remote transports. This is the foundation for off-device control, but it is still a secondary surface.

Docs:

- [Gateway overview](docs/gateway.md)
- [Gateway API](docs/gateway-api.md)
- [Supervisor](docs/supervisor.md)

### Multi-node

Hack can pair remote nodes, bootstrap workspaces, and dispatch work across machines. This is useful when your local machine is not enough, but it is still beta-level product surface area.

Docs:

- [Remote node quickstart](docs/guides/remote-node-quickstart.md)
- [Remote node container guide](docs/guides/remote-node-container.md)
- [Remote supervisor guide](docs/guides/remote-supervisor.md)

### macOS app

Hack Desktop gives you a native dashboard for projects, tickets, sessions, and integrations. It is a beta companion to the CLI, not the primary entry point.

Docs:

- [macOS app README](apps/macos/README.md)

## How Hack Works

- Project config lives in `.hack/`.
- Each project or branch instance gets its own isolated Docker network and compose identity.
- A global Caddy proxy gives routed services stable local HTTPS hostnames.
- `hack logs` uses Compose for the fast path and Loki/Grafana for history and querying.
- `hackd` is an optional daemon for faster `projects` and `ps` snapshots.

Useful commands:

```bash
hack help
hack projects
hack status
hack daemon start
hack open logs
```

## Documentation

Start here:

- [Docs index](docs/README.md)
- [CLI reference](docs/cli.md)
- [Architecture](docs/architecture.md)
- [Env and secrets](docs/env.md)
- [Sessions](docs/sessions.md)
- [Extensions](docs/extensions.md)

Common guides:

- [Initialize a project](docs/guides/init-project.md)
- [Tickets guide](docs/guides/tickets.md)
- [Remote node quickstart](docs/guides/remote-node-quickstart.md)
- [Global settings](docs/guides/global-settings.md)

## Develop From Source

```bash
bun install
bun run install:dev
hack --help
```

Useful repo commands:

```bash
bun test
bun x ultracite check
```
