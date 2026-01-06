# Tailscale Gateway Extension

This extension wraps the local `tailscale` CLI to help expose the gateway over your tailnet.
It does not call the Tailscale API directly.

## Prerequisites

- `tailscale` installed (Homebrew: `brew install tailscale`)
- Device joined to a tailnet

## Quick start

```bash
hack config set --global 'controlPlane.extensions["dance.hack.tailscale"].enabled' true
hack x tailscale setup
```

## Commands

- `hack x tailscale setup`
  - Prints a setup checklist (`tailscale up`, `tailscale status`, `tailscale ip -4`).
- `hack x tailscale status`
  - Runs `tailscale status` (supports extra tailscale flags).
- `hack x tailscale ip`
  - Runs `tailscale ip -4` by default (pass args for IPv6 or all IPs).

## Notes

- For SSH access from a phone, use your Tailscale IP in the SSH client.
- The gateway is still protected by its token; Tailscale is an extra perimeter layer.
