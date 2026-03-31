# Docs Information Architecture

This document defines the documentation split for `hack`:

- core
- beta
- extensions and reference

The goal is to keep the primary product story legible while still making advanced and evolving
surfaces easy to find on purpose.

## Principles

1. Core comes first.
2. Beta remains accessible, but never reads as the default path.
3. Reference is easy to find, but does not lead onboarding.
4. Cross-links should help readers move from core into beta intentionally.
5. Deep links into beta or reference pages should self-identify where the reader is.

## Sections

### Core

Core docs describe the default local `hack` experience:

- initialize a repo
- run services on isolated local networks
- open stable local hostnames
- manage env and secrets
- configure lifecycle hooks
- manage persistent sessions

Current landing page:
- [Core docs](core.md)

Core pages:
- [Initialize a project](guides/init-project.md)
- [Architecture](architecture.md)
- [Env & secrets](env.md)
- [Lifecycle](lifecycle.md)
- [Sessions](sessions.md)

### Beta

Beta docs cover remote and control-plane workflows that are still evolving:

- gateway exposure
- remote nodes
- remote execution
- remote supervisor jobs

Current landing page:
- [Beta workflows](beta.md)

Beta pages:
- [Gateway overview](gateway.md)
- [Remote node quickstart](guides/remote-node-quickstart.md)
- [Run laptop-to-laptop node pairing e2e](guides/remote-node-laptop-e2e.md)
- [Bootstrap a remote node on Railway](guides/remote-node-railway.md)
- [Run a remote node via container image](guides/remote-node-container.md)
- [Run the optional web control plane locally](guides/web-control-plane-local-dev.md)
- [Expose the gateway over SSH](guides/remote-ssh.md)
- [Expose the gateway with Cloudflare](guides/remote-cloudflare.md)
- [Expose the gateway with Tailscale](guides/remote-tailscale.md)
- [Run remote supervisor jobs](guides/remote-supervisor.md)

### Extensions & Reference

Extensions and reference docs hold command lookup, APIs, and implementation-oriented material:

- CLI command tables
- extension configuration and authoring
- tickets and integrations
- API and SDK reference

Current landing page:
- [Extensions & reference](reference.md)

Reference pages:
- [CLI reference](cli.md)
- [Extensions](extensions.md)
- [Global settings](guides/global-settings.md)
- [Tickets (git-backed)](guides/tickets.md)
- [Create a new extension](guides/create-extension.md)
- [Linear integration architecture](guides/linear-integration-architecture.md)
- [Auth broker Neon bootstrap](guides/auth-broker-neon-bootstrap.md)
- [Gateway API](gateway-api.md)
- [Supervisor](supervisor.md)
- [Control-plane SDK](sdk.md)

## Navigation Rules

Use these rules when adding or updating docs:

1. Default new user links should point to [Core docs](core.md), not directly to beta or reference.
2. Remote and control-plane setup pages should identify themselves as beta.
3. Command tables, SDK docs, and extension authoring guides should identify themselves as reference.
4. Core pages may link out to beta only when the move is explicit and intentional.
5. Root docs navigation should present the three buckets before individual pages.
