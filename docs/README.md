# Docs

This directory contains the public documentation for hack. Specs remain in `SPECS/` (working notes).

## Adjacent capabilities at a glance

These docs cover a few capabilities that usually appear right after the core `init/up/open/logs` loop.
You do not need all of them to start using `hack`.

- **GitHub**: Connect GitHub when you want `hack` to help open or update pull requests from the same
  workflow you use locally. Relevant once your local branch is ready to share or review. Start in
  [`extensions.md`](extensions.md).
- **Linear**: Connect Linear when your team tracks delivery there and you want project or issue sync
  tied to the repo. Relevant when a repo should map cleanly to a Linear project or issue workflow.
  Start in [`extensions.md`](extensions.md).
- **Tickets**: Use tickets for lightweight repo-local work tracking that stays close to the code and is
  easy for agents to update. Relevant when you want task tracking without depending on an external
  tracker. Start in [`guides/tickets.md`](guides/tickets.md).
- **Sessions**: Use sessions to keep terminal workspaces alive across SSH, restarts, and agent handoff.
  Relevant when you want persistent shells instead of recreating project context each time. Start in
  [`sessions.md`](sessions.md).
- **Env**: Use env to declare which local config and secrets a project actually needs. Relevant when
  teammates, automation, or remote runs need a repeatable way to resolve project settings. Start in
  [`env.md`](env.md).

## Core docs

- [CLI reference](cli.md)
- [Architecture](architecture.md)
- [Sessions](sessions.md) - mux session management (tmux or zellij) + API
- [Env & secrets](env.md) - env contract + `.hack/.env` + OS keychain secrets
- [Lifecycle](lifecycle.md) - project startup hooks + managed host processes
- [Gateway overview](gateway.md)
- [Gateway API](gateway-api.md)
- [Supervisor](supervisor.md)
- [Extensions](extensions.md)
- [Control-plane SDK](sdk.md)

Monorepo note:
- Root scripts orchestrate workspace tasks through Turbo.
- Package-local commands remain available via `bun run --cwd <workspace> <script>`.

Quick diagnostics:
- `hack usage` (resource usage across running projects)
- `hack usage --watch` (live resource trends)
- `hack node routes status` (controller-side remote route bridge state)
- `hack node routes repair` (re-apply persisted remote route bridge routes)

## Guides

- Start here (first remote node in ~10 minutes):
  - [Remote node quickstart](guides/remote-node-quickstart.md)
  - [Run laptop-to-laptop node pairing e2e](guides/remote-node-laptop-e2e.md)
  - [Bootstrap a remote node on Railway](guides/remote-node-railway.md)
- Remote setup (one command): `hack remote setup`
- [Initialize a project](guides/init-project.md)
- [Global settings](guides/global-settings.md)
- [Tickets (git-backed)](guides/tickets.md)
- [Expose the gateway over SSH](guides/remote-ssh.md)
- [Expose the gateway with Cloudflare](guides/remote-cloudflare.md)
- [Expose the gateway with Tailscale](guides/remote-tailscale.md)
- [Run remote supervisor jobs](guides/remote-supervisor.md)
- [Run a remote node via container image](guides/remote-node-container.md)
- [Bootstrap a remote node on Railway](guides/remote-node-railway.md)
- [Bootstrap auth-broker with Neon + Railway](guides/auth-broker-neon-bootstrap.md)
- [Create a new extension](guides/create-extension.md)
