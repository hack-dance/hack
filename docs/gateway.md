# Gateway (remote control plane)

The gateway exposes a small HTTP/WS surface on top of `hackd` so you can orchestrate jobs, stream
logs, and open shells remotely. It is disabled by default and binds to `127.0.0.1` unless you
explicitly expose it through SSH, Cloudflare, or Tailscale.

## Concepts

- **Gateway**: HTTP/WS server inside `hackd` (token-protected).
- **Supervisor**: job/shell runner used by the gateway for execution + streaming.
- **Remote CLI**: `hack remote` wraps setup, status, QR payloads, and monitoring.

## Config model

Global config (machine-wide): `~/.hack/hack.config.json`
- `controlPlane.gateway.bind` (default `127.0.0.1`)
- `controlPlane.gateway.port` (default `7788`)
- `controlPlane.gateway.allowWrites` (default `false`)
- `controlPlane.extensions.*` (extension settings)

Project config (per repo): `.hack/hack.config.json`
- `controlPlane.gateway.enabled` (marks project as gateway-capable)
- `controlPlane.extensions.<id>.enabled` (per-extension enablement)

### Project opt-in

Each project opts in to gateway access with `controlPlane.gateway.enabled = true` in its
project config. The gateway server is global; it starts whenever at least one project opts in.

## Quick start

```bash
hack remote setup
# or:
hack gateway setup
```

This one-command flow enables the gateway for the current project, optionally enables writes,
restarts `hackd`, creates a token + QR payload, and can configure exposure (Cloudflare/Tailscale/SSH)
via prompts.

## Tokens + writes

- Tokens are scoped (`read` or `write`).
- Non-GET requests and shell streams require **both** a write token and
  `controlPlane.gateway.allowWrites = true` (global).

```bash
hack config set --global 'controlPlane.gateway.allowWrites' true
hack x gateway token-create --scope write
```

## Project routing

Remote clients should call `GET /v1/projects` and use the returned `project_id` in API paths
(`/control-plane/projects/:id/...`). Only gateway-enabled projects are returned over the gateway.

## Remote access

Choose one exposure path (for off-network access):

- **SSH port-forward**: `ssh -L 7788:127.0.0.1:7788 <public-host-or-tailnet>`
- **Cloudflare Tunnel**: `hack x cloudflare tunnel-setup --hostname gateway.example.com --ssh-hostname ssh.example.com`
- **Tailscale**: use tailnet access or `tailscale serve tcp 7788 127.0.0.1:7788`

Guides:
- `guides/remote-ssh.md`
- `guides/remote-cloudflare.md`
- `guides/remote-tailscale.md`

## API reference

See `gateway-api.md` for endpoints, structured workflow patterns, and an e2e smoke test.
