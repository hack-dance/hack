# Expose the gateway over SSH

Use SSH port-forwarding when you want quick, ad-hoc access without extra tooling.
You still need a reachable SSH host (public IP, VPN, or Tailscale).

## Steps (one command)

```bash
hack remote setup
```

Choose **SSH tunnel** when prompted. The wizard enables the gateway, creates a token, and prints
the SSH port-forward + QR payload.

## Steps (manual)

1) Enable gateway + create a token:

```bash
hack gateway enable
hack daemon stop && hack daemon start
hack x gateway token-create --scope read
```

2) Forward the gateway port (from your remote client):

```bash
ssh -L 7788:127.0.0.1:7788 <user>@<public-host-or-tailnet>
```

3) Verify from the client (127.0.0.1 is your local end of the tunnel):

```bash
curl -H "Authorization: Bearer $HACK_GATEWAY_TOKEN" http://127.0.0.1:7788/v1/status
```

## Off-network access

If your machine is not directly reachable, use one of:
- Tailscale (recommended for SSH): `tailscale up --ssh`
- Public IP + router port-forwarding to SSH
- Cloudflare Access (desktop clients only): see `remote-cloudflare.md`

## Public IP + DNS (optional)

If you want a stable hostname (e.g. `ssh.example.com`):
1) Point an A/AAAA record to your public IP.
2) Forward TCP port 22 on your router to your machine.
3) Use the DNS name in the SSH command: `ssh <user>@ssh.example.com`

## QR payloads

```bash
hack remote qr --ssh --ssh-host <host> --ssh-user <user>
```

This prints an `ssh://` QR payload for mobile clients.
