# Expose the gateway with Tailscale (Beta)

This is a beta workflow.
Start with [Core docs](../core.md) if you are new to `hack`, and use [Beta workflows](../beta.md)
for the rest of the remote path.

Use this guide when you want private tailnet-only access to `hack` gateway endpoints.

> Beta: Tailscale gateway exposure is part of the remote control plane beta.

Tailscale is recommended for:
1. SSH from mobile/desktop clients.
2. Private remote-node endpoints without public ingress.
3. Railway private bootstrap with a reusable auth key.

## Setup

```bash
hack remote setup
```

Choose **Tailscale** when prompted. The wizard enables the extension and prints the setup checklist.

## Setup (manual)

```bash
hack config set --global 'controlPlane.extensions["dance.hack.tailscale"].enabled' true
hack x tailscale setup
```

Then join your tailnet:

```bash
tailscale up --ssh
```

For private provider bootstrap (for example Railway), set a reusable auth key once:

```bash
hack config set --global 'controlPlane.extensions["dance.hack.tailscale"].config.authKey' "tskey-auth-..."
```

## Gateway access

Option A: serve the gateway over the tailnet:

```bash
tailscale serve tcp 7788 127.0.0.1:7788
```

Option B: bind the gateway to all interfaces (less strict):

```bash
hack config set --global controlPlane.gateway.bind 0.0.0.0
hack daemon stop && hack daemon start
```

> **Security note:** Option B exposes the gateway on all network interfaces, not just Tailscale. If your machine is connected to other networks (public Wi-Fi, corporate LAN), the gateway will be accessible from those networks. Use Option A (`tailscale serve`) for better isolation, or ensure firewall rules restrict access when using Option B.

Then access via your MagicDNS name or tailnet IP.

## Trust model reminder

Tailnet membership is transport, not automatic controller trust.
You still pair/register remote nodes with `hack node pair` or `hack node add`.
