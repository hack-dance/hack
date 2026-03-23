# Docs

This directory is organized around the product story instead of the implementation tree.

If you are new to Hack, start with the core path first, then move into integrations, then only
visit the beta and reference surfaces you actually need.

## Adjacent capabilities at a glance

These docs cover a few capabilities that usually appear right after the core `init/up/open/logs` loop.
You do not need all of them to start using `hack`.

- **GitHub**: Connect GitHub when you want `hack` to help open or update pull requests from the same
  workflow you use locally. Relevant once your local branch is ready to share or review. Start in
  [`guides/github-workflows.md`](guides/github-workflows.md).
- **Linear**: Connect Linear when your team tracks delivery there and you want project or issue sync
  tied to the repo. Relevant when a repo should map cleanly to a Linear project or issue workflow.
  Start in [`guides/linear-integration-architecture.md`](guides/linear-integration-architecture.md).
- **Tickets**: Use tickets for lightweight repo-local work tracking that stays close to the code and is
  easy for agents to update. Relevant when you want task tracking without depending on an external
  tracker. Start in [`guides/tickets.md`](guides/tickets.md).
- **Sessions**: Use sessions to keep terminal workspaces alive across SSH, restarts, and agent handoff.
  Relevant when you want persistent shells instead of recreating project context each time. Start in
  [`sessions.md`](sessions.md).
- **Env**: Use env to declare which local config and secrets a project actually needs. Relevant when
  teammates, automation, or remote runs need a repeatable way to resolve project settings. Start in
  [`env.md`](env.md).

## Core workflows

- [Initialize a project](guides/init-project.md)
- [CLI reference](cli.md)
- [Env & secrets](env.md)
- [Architecture](architecture.md)
- [Sessions](sessions.md)
- [Lifecycle](lifecycle.md)
- [Gateway overview](gateway.md)
- [Gateway API](gateway-api.md)
- [Supervisor](supervisor.md)
- [Extensions](extensions.md)
- [Control-plane SDK](sdk.md)
- [Global settings](guides/global-settings.md)
- [Prerequisite detection matrix](guides/prerequisite-detection-matrix.md)

Admin model reference:
- [Architecture](architecture.md) for local-only vs broker-mediated admin boundaries.
- [Env & secrets](env.md) for env ownership, sharing modes, and secret custody.

## Integrations & collaboration

- [Integrations overview](integrations.md)
- [GitHub workflows](guides/github-workflows.md)
- [Tickets (git-backed)](guides/tickets.md)
- [Linear integration architecture](guides/linear-integration-architecture.md)

## Beta workflows

- [Remote node quickstart (Beta)](guides/remote-node-quickstart.md)
- [Remote node runtime container (Beta)](guides/remote-node-container.md)
- [Remote node on Railway (Beta)](guides/remote-node-railway.md)
- [Laptop-to-laptop remote node validation (Beta)](guides/remote-node-laptop-e2e.md)
- [Expose the gateway over SSH (Beta)](guides/remote-ssh.md)
- [Expose the gateway with Cloudflare (Beta)](guides/remote-cloudflare.md)
- [Expose the gateway with Tailscale (Beta)](guides/remote-tailscale.md)
- [Run remote supervisor jobs (Beta)](guides/remote-supervisor.md)
- [Hack Desktop for macOS (Beta)](../apps/macos/README.md)

## Extensions & reference

- [Extensions & SDK reference](extensions.md)
- [Gateway auth-broker bootstrap](guides/auth-broker-neon-bootstrap.md)
- [Create a new extension](guides/create-extension.md)

## Architecture & research

- [Agent-native runtime landscape](agent-native-runtime-landscape.md)
- [Agent-native runtime provider capabilities](agent-native-runtime-provider-capabilities.md)
- [Agent-native runtime requirements](plans/2026-03-22-agent-native-runtime-requirements-design.md)

## Quick diagnostics

- `hack help`
- `hack status`
- `hack usage`
- `hack usage --watch`
- `hack node routes status`
- `hack node routes repair`
- `hack doctor`

## Monorepo note

- Root scripts orchestrate workspace tasks through Turbo.
- Package-local commands remain available via `bun run --cwd <workspace> <script>`.
