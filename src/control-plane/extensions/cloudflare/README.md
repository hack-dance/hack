# Cloudflare Gateway Extension

This extension helps expose the local gateway (`hackd` HTTP/WS) through a Cloudflare Tunnel.
It does not call Cloudflare APIs directly; it prints a `cloudflared` config and can run the
`cloudflared` CLI to create and route the tunnel.

## Prerequisites

- `cloudflared` installed (Homebrew: `brew install cloudflare/cloudflare/cloudflared`)
- Cloudflare account access with a domain you control

## Quick start (automated)

1) Enable the gateway and start the daemon:

```bash
hack gateway enable
hack daemon stop && hack daemon start
```

2) Run the setup helper:

```bash
hack x cloudflare tunnel-setup --hostname gateway.dimitri.computer
```

3) Start the tunnel:

```bash
hack x cloudflare tunnel-start
```

4) Stop the tunnel when needed:

```bash
hack x cloudflare tunnel-stop
```

## DNS requirements (Cloudflare)

You must have the hostname under a Cloudflare-managed zone (e.g. `dimitri.computer`).
The setup helper runs:

```bash
cloudflared tunnel route dns <tunnel-name> <hostname>
```

This creates a CNAME record pointing to:
`<tunnel-id>.cfargotunnel.com` (proxied by Cloudflare).

If you prefer to do it manually, create:

- **Type**: CNAME
- **Name**: `gateway`
- **Target**: `<tunnel-id>.cfargotunnel.com`
- **Proxy**: enabled

## Quick start (manual)

If you prefer to run the `cloudflared` steps yourself:

```bash
hack x cloudflare tunnel-print --hostname gateway.dimitri.computer --out ~/.cloudflared/config.yml
```

Then follow the printed steps.

## Config via hack.config.json

You can store defaults under `controlPlane.extensions["dance.hack.cloudflare"].config`:

```json
{
  "controlPlane": {
    "extensions": {
      "dance.hack.cloudflare": {
        "enabled": true,
        "config": {
          "hostname": "gateway.dimitri.computer",
          "tunnel": "hack-gateway",
          "origin": "http://127.0.0.1:7788",
          "credentialsFile": "/Users/you/.cloudflared/<tunnel-id>.json"
        }
      }
    }
  }
}
```

If `credentialsFile` is omitted, `cloudflared` will use the default path when it exists:
`~/.cloudflared/<tunnel-id>.json`.

## Commands

- `hack x cloudflare tunnel-setup`
  - `--hostname <host>` (required if not set in config)
  - `--tunnel <name>` (default: `hack-gateway`)
  - `--origin <url>` (default: gateway bind/port, usually `http://127.0.0.1:7788`)
  - `--credentials-file <path>` (optional)
  - `--out <path>` (optional; default: `~/.cloudflared/config.yml`)
  - `--skip-login` (skip `cloudflared tunnel login`)
  - `--skip-create` (skip `cloudflared tunnel create`)
  - `--skip-route` (skip `cloudflared tunnel route dns`)

- `hack x cloudflare tunnel-print`
  - `--hostname <host>` (required if not set in config)
  - `--tunnel <name>` (default: `hack-gateway`)
  - `--origin <url>` (default: gateway bind/port, usually `http://127.0.0.1:7788`)
  - `--credentials-file <path>` (optional)
  - `--out <path>` (optional; write config to file)

- `hack x cloudflare tunnel-start`
  - `--config <path>` (optional; default: `~/.cloudflared/config.yml`)
  - `--tunnel <name>` (default: `hack-gateway`)
  - `--out <path>` (alias for `--config`)

- `hack x cloudflare tunnel-stop`

## Notes

- Gateway tokens default to read-only; set `controlPlane.gateway.allowWrites = true` and
  create a write token if you need non-GET requests.
- Cloudflare Tunnel uses an outbound connection; you do not need to expose a public IP.
- This extension only wraps the `cloudflared` CLI and does not call Cloudflare APIs directly.
- `hack remote status` surfaces the configured hostname and `cloudflared` PID when available.

## SSH caveat (mobile)

Cloudflare Tunnel is great for HTTP/WS (the gateway), but it does **not** provide a native SSH
endpoint that iOS SSH clients can dial directly. Cloudflare Access for SSH requires
`cloudflared access ssh` on the client machine, which is not available on iOS.

If you want SSH from a phone:
- Prefer Tailscale/WireGuard to your laptop, or
- Use a standard VPN/LAN route to port 22.

Recommendation: expose `gateway.<domain>` via Cloudflare for the gateway HTTP/WS surface, and
use a separate SSH path for direct shell access.

## Cloudflare Access (Zero Trust) policies

To add an extra layer of auth in front of the gateway:

1) In Cloudflare Zero Trust: **Access → Applications → Add an application → Self-hosted**.
2) Set the hostname (e.g. `gateway.dimitri.computer`) and save the app.
3) Add an Access policy (e.g. allow by email domain, WARP device posture, or IdP group).
4) For headless clients, create a **Service Token** and use these headers:

```
CF-Access-Client-Id: <client-id>
CF-Access-Client-Secret: <client-secret>
```

The gateway still requires its own token (`Authorization: Bearer ...`). Access policies are
an extra perimeter layer, not a replacement.
