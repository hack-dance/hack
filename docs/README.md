# Docs

This directory contains the public documentation for hack. Specs remain in `SPECS/` (working notes).

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
