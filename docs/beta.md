# Beta Workflows

This section holds remote and control-plane features that are still evolving.

Start in [Core docs](core.md) first if you are new to `hack`. Beta workflows build on the core
local model instead of replacing it.

## Beta entry points

- [Gateway overview](gateway.md)
- [Remote node quickstart](guides/remote-node-quickstart.md)
- [Run laptop-to-laptop node pairing e2e](guides/remote-node-laptop-e2e.md)
- [Bootstrap a remote node on Railway](guides/remote-node-railway.md)
- [Run a remote node via container image](guides/remote-node-container.md)
- [Use Hack in managed Codex containers](guides/codex-managed-environments.md)
- [Expose the gateway over SSH](guides/remote-ssh.md)
- [Expose the gateway with Cloudflare](guides/remote-cloudflare.md)
- [Expose the gateway with Tailscale](guides/remote-tailscale.md)
- [Run remote supervisor jobs](guides/remote-supervisor.md)

## Before you start

- Keep your local project flow working first: `hack init`, `hack up --detach`, `hack open`
- Treat remote exposure and node orchestration as opt-in
- Expect some pages here to be marked experimental while the surface is still settling

## Need lower-level detail?

Use [Extensions & reference](reference.md) for:

- [Gateway API](gateway-api.md)
- [Supervisor](supervisor.md)
- [Control-plane SDK](sdk.md)
- [CLI reference](cli.md)
