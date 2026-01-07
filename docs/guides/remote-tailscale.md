# Expose the gateway with Tailscale

> ⚠️ Experimental: this guide has not been validated end-to-end yet. Use with caution and report issues.

Tailscale is the best option for SSH from mobile clients and for a private gateway URL when you are off-network.

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

Then access via your MagicDNS name or tailnet IP.
