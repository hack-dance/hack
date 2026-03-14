# Hack

Hack is local development without the port-collision tax.

It gives each repo or branch its own network, a stable HTTPS URL, and a single place to manage
the workflows that usually end up scattered across shell scripts, terminal tabs, and sidecar tools.

## Three core promises

1. Run multiple repos or branches at the same time without port conflicts.
2. Open every project on a stable HTTPS URL like `https://myapp.hack`.
3. Keep project workflows such as env, sessions, tickets, and integrations close to the repo.

## Five-minute start

### Prerequisites

- macOS
- Docker + Compose via [OrbStack](https://docs.orbstack.dev/quick-start) or
  [Docker Desktop](https://www.docker.com/get-started/)

### Install

CLI:

```bash
curl -fsSL https://github.com/hack-dance/hack/releases/latest/download/hack-install.sh | bash
```

macOS app:

- Download the latest DMG from
  [GitHub Releases](https://github.com/hack-dance/hack/releases/latest)
- `Hack Desktop for macOS` is currently **Beta**

### Start a project

```bash
hack global install

cd /path/to/your-repo
hack init
hack up --detach
hack open
```

What those commands do:

- `hack global install` boots the machine-level DNS, TLS, and logging services
- `hack init` creates the `.hack/` project config
- `hack up --detach` starts your stack on an isolated network
- `hack open` opens the project URL in your browser

Useful next commands:

```bash
hack logs --pretty
hack run <service> <command...>
hack status
hack down
```

## What is core today

These workflows are the main product:

- Project setup and runtime: `hack init`, `hack up`, `hack down`, `hack restart`, `hack ps`
- Stable local access: `hack open`, `hack logs`, `hack run`, `hack status`
- Parallel project work: branch instances, isolated networks, and per-project hostnames
- Repo-local workflow support: `hack env`, `hack session`, `hack tickets`

Supporting capabilities:

- GitHub and Linear integrations
- Agent setup for Cursor, Claude Code, and Codex
- CLI and SDK reference surfaces for extensions and automation

Beta surfaces:

- Remote control plane and gateway flows
- Multi-node execution and dispatch
- Hack Desktop for macOS

## Integrations overview

Hack has a few supporting surfaces that matter after your project is already running.

### GitHub

Use GitHub integration when you want Hack to authenticate repo workflows and carry pull-request
context cleanly between GitHub and local Hack work.

- Main surface: `hack x github ...`
- Common use: connect a profile, inspect status, then use PR update or repo-aware automation
  workflows from Hack
- Reference: [docs/extensions.md](docs/extensions.md)

### Linear

Use Linear when you want selected Linear issues or projects to sync into your repo-local workflow
instead of treating Linear as a separate universe.

- Main surface: `hack linear ...`
- Common use: connect a profile, bind a project, sync issues or project state
- Reference: [docs/guides/linear-integration-architecture.md](docs/guides/linear-integration-architecture.md)

### Tickets

Use tickets when you want lightweight work tracking in git without leaving the repo.

- Main surface: `hack tickets ...`
- Common use: create follow-up work, track status, sync hidden ticket refs
- Reference: [docs/guides/tickets.md](docs/guides/tickets.md)

### Sessions

Use sessions when you want a durable terminal workspace for yourself or an agent.

- Main surface: `hack session ...`
- Common use: keep a project shell alive, reattach later, or run long-lived agent work
- Reference: [docs/sessions.md](docs/sessions.md)

### Env

Use env management when you want the repo to declare what configuration it needs without committing
the secret values themselves.

- Main surface: `hack env ...`
- Common use: define required vars in `.hack/hack.env.json`, keep values in `.hack/.env` or a
  secret backend
- Reference: [docs/env.md](docs/env.md)

## Docs map

Start here when you want the product story before the low-level reference:

- Core workflows: [docs/README.md](docs/README.md)
- CLI quick map and full reference: [docs/cli.md](docs/cli.md)
- Integrations overview: [docs/integrations.md](docs/integrations.md)

Beta surfaces are intentionally separate:

- Remote control plane and gateway: [docs/gateway.md](docs/gateway.md)
- Multi-node quickstart: [docs/guides/remote-node-quickstart.md](docs/guides/remote-node-quickstart.md)
- Hack Desktop for macOS: [apps/macos/README.md](apps/macos/README.md)

Reference surfaces:

- Extensions and SDK: [docs/extensions.md](docs/extensions.md)
- Gateway API (Beta): [docs/gateway-api.md](docs/gateway-api.md)
- Architecture: [docs/architecture.md](docs/architecture.md)

## `hack help` guide

Root help is organized in the same order as the product:

- `Global commands`: machine setup and shared services
- `Core workflows`: the day-to-day local-dev path
- `Collaboration & integrations`: env, sessions, tickets, Linear, and SSH access
- `Beta workflows`: remote control plane, multi-node, and dispatch
- `Extension commands`: lower-level extension namespace access

Run `hack help` or `hack help <command>` for the CLI version of that map.

## Agent setup

If you want Hack to teach coding agents how to work in a repo:

```bash
hack setup cursor
hack setup claude
hack setup codex
hack setup sync --all-scopes
hack agent init --client codex
```

If your agent does not have shell access, use MCP instead:

```bash
hack setup mcp
hack mcp serve
```

## Development

If you are working on Hack itself:

```bash
bun install
bun run build
bun test
bun x ultracite check
```

Useful repo-level commands:

- `bun run build`
- `bun run test`
- `bun run check`
- `bun run macos:build`

## Beta note

Remote control plane, multi-node execution, and the macOS app are all still **Beta**. They are
useful, but they are not the core path a new user needs to learn first.
