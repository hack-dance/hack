# Expose the gateway with Cloudflare

> ⚠️ Experimental: this guide has not been validated end-to-end yet. Use with caution and report issues.

Cloudflare Tunnel is ideal for HTTP/WS gateway access from a phone or browser when you are off-network.

## Prereqs

- `cloudflared` installed
- A Cloudflare-managed zone (e.g. `dimitri.computer`)

## Setup (one command)

```bash
hack remote setup
```

Choose **Cloudflare** when prompted. The wizard enables the extension, asks for hostnames,
and offers to run `cloudflared` setup + start for you.

## Setup (manual)

```bash
hack config set --global 'controlPlane.extensions["dance.hack.cloudflare"].enabled' true
hack x cloudflare tunnel-setup --hostname gateway.example.com --ssh-hostname ssh.example.com
hack x cloudflare tunnel-start
```

The helper writes `~/.cloudflared/config.yml` and creates the DNS CNAME for the hostname.

## Connect

```bash
curl -H "Authorization: Bearer $HACK_GATEWAY_TOKEN" https://gateway.example.com/v1/status
```

## Notes

- Consider Cloudflare Access policies for extra auth.
- Cloudflare Tunnel is for the gateway HTTP/WS surface by default.

## SSH via Cloudflare Access (desktop)

Cloudflare Access for SSH requires `cloudflared` on the client.

```bash
cloudflared access ssh --hostname ssh.example.com
```

You can print the Access setup steps:

```bash
hack x cloudflare access-setup --ssh-hostname ssh.example.com --user <user>
```

Optional `~/.ssh/config` shortcut:

```
Host ssh.example.com
  User <user>
  ProxyCommand /opt/homebrew/bin/cloudflared access ssh --hostname %h
```

Mobile SSH clients do not support this flow; use Tailscale for SSH on iOS.
