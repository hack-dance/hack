# Docs

This directory is organized around the product story instead of the implementation tree.

If you are new to Hack, start with the core path first, then move into integrations, then only
visit the beta and reference surfaces you actually need.

## Core workflows

- [Initialize a project](guides/init-project.md)
- [CLI reference](cli.md)
- [Env & secrets](env.md)
- [Sessions](sessions.md)
- [Lifecycle](lifecycle.md)
- [Global settings](guides/global-settings.md)
- [Architecture](architecture.md)

## Integrations & collaboration

- [Integrations overview](integrations.md)
- [Tickets (git-backed)](guides/tickets.md)
- [Linear integration architecture](guides/linear-integration-architecture.md)

## Beta workflows

- [Gateway (Beta)](gateway.md)
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
- [Gateway API (Beta)](gateway-api.md)
- [Supervisor (Beta)](supervisor.md)
- [Gateway auth-broker bootstrap](guides/auth-broker-neon-bootstrap.md)
- [Create a new extension](guides/create-extension.md)
- [Control-plane SDK](sdk.md)

## Quick diagnostics

- `hack help`
- `hack status`
- `hack usage`
- `hack usage --watch`
- `hack doctor`
