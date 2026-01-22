# Docs

This directory contains the public documentation for hack. Specs remain in `SPECS/` (working notes).

## Core docs

- [CLI reference](cli.md)
- [Architecture](architecture.md)
- [Sessions](sessions.md) - tmux session management + API
- [Gateway overview](gateway.md)
- [Gateway API](gateway-api.md)
- [Supervisor](supervisor.md)
- [Extensions](extensions.md)
- [Control-plane SDK](sdk.md)

Quick diagnostics:
- `hack usage` (resource usage across running projects)
- `hack usage --watch` (live resource trends)

## Guides

- Remote setup (one command): `hack remote setup`
- [Initialize a project](guides/init-project.md)
- [Global settings](guides/global-settings.md)
- [Tickets (git-backed)](guides/tickets.md)
- [Expose the gateway over SSH](guides/remote-ssh.md)
- [Expose the gateway with Cloudflare](guides/remote-cloudflare.md)
- [Expose the gateway with Tailscale](guides/remote-tailscale.md)
- [Run remote supervisor jobs](guides/remote-supervisor.md)
- [Create a new extension](guides/create-extension.md)
