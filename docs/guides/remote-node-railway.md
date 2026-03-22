# Railway Node Bootstrap Guide

This is a beta workflow.
Start with [Core docs](../core.md) if you are new to `hack`, and use [Beta workflows](../beta.md)
for the rest of the remote path.

Use this guide to register a Railway-hosted runtime as a `hack` remote node.

If this is your first remote node, start with [Remote node quickstart](remote-node-quickstart.md) for core concepts.

## Quick Start

### Fastest path (macOS app)

1. Open **Settings → Extensions → Railway**.
2. Ensure **Railway CLI installed** and **CLI authenticated** are healthy.
3. (Private mode) Set **Bootstrap auth key** in **Settings → Extensions → Tailscale**.
4. Click **Bootstrap node now**.
5. Open **Settings → System → Topology** and verify the node is registered.

### CLI path (uses saved Railway defaults)

If your Railway project/service defaults are already saved:

```bash
hack node provider railway bootstrap --default
```

### CLI path (explicit target)

```bash
hack node provider railway bootstrap \
  --railway-project "<project-id-or-name>" \
  --railway-service "<service-id-or-name>" \
  --default
```

### Private mode via Tailscale (no public Railway domain required)

```bash
hack node provider railway bootstrap \
  --railway-project "<project-id-or-name>" \
  --railway-private \
  --default
```

Auth key resolution order in private mode:
1. `--tailscale-auth-key` flag
2. Global config `controlPlane.extensions["dance.hack.tailscale"].config.authKey`
3. `HACK_TAILSCALE_AUTH_KEY` (shell fallback)

Set once in global config:

```bash
hack config set --global 'controlPlane.extensions["dance.hack.tailscale"].config.authKey' "tskey-auth-..."
```

Create a new Railway service automatically:

```bash
hack node provider railway bootstrap \
  --railway-project "<project-id-or-name>" \
  --create-service \
  --railway-service hack-node-runtime \
  --railway-image hackdance/hack:latest \
  --name "railway-node-1" \
  --labels railway,linux,container \
  --default
```

If you already know the endpoint, pass it explicitly:

```bash
hack node provider railway bootstrap \
  --railway-project "<project-id-or-name>" \
  --railway-service "<service-id-or-name>" \
  --endpoint "https://hack-node-runtime-production.up.railway.app"
```

## macOS App Workflow

In Hack Desktop:

1. Open **Settings → Extensions → Railway**.
2. Confirm **Railway CLI installed** and **CLI authenticated**.
3. Open **Settings → Extensions → Tailscale** and set **Bootstrap auth key** (for private mode).
4. Set defaults:
   - Railway project (optional if already configured in provider/global defaults)
   - Node display name (optional)
   - Private tailscale mode toggle
5. Keep service empty unless you need an existing Railway service:
   - empty service => app auto-creates a service from node name
   - set service => app targets that service
6. For private mode, use one of:
   - saved auth key in global config (recommended default path)
   - direct auth key override via `--tailscale-auth-key` for one-off runs
   - env var `HACK_TAILSCALE_AUTH_KEY` only as a shell-level fallback
7. Click **Save defaults**.
8. Click **Bootstrap node now**.
9. Validate result card + node registration in **Settings → Topology**.
10. Use **Open topology** / **Add remote node** for additional node bring-up from the topology page.

## What The Command Does

`hack node provider railway bootstrap` performs these steps:

1. Creates an isolated temporary Railway CLI context (no project files written into your repo).
2. Links Railway CLI to the target project/environment.
3. Optionally creates a new Railway service from the node runtime image.
4. Generates/reads a Railway domain endpoint when `--endpoint` is omitted (public mode), or resolves `Self.DNSName` from `tailscale status --json` (private mode).
5. Sets node runtime env vars (`HACK_NODE_NAME`, gateway bind/port, labels, stable gateway token).
6. In private mode, configures embedded Tailscale runtime (`TS_AUTHKEY`, hostname/tags, `tailscale serve`).
   - `TS_AUTHKEY` comes from `--tailscale-auth-key`, global config `controlPlane.extensions["dance.hack.tailscale"].config.authKey` (mirrored to Railway compatibility key), or `HACK_TAILSCALE_AUTH_KEY`.
7. Executes `hack node init --json` inside the Railway service via `railway ssh`.
8. Registers the returned bundle on the controller (`hack node add` equivalent).
9. Probes node health and updates local node registry state.

## Required Prerequisites

1. Railway CLI installed (`railway --version`).
2. Logged into Railway CLI (`railway whoami`).
3. Controller can reach the resulting Railway endpoint.

## Flags

- `--railway-project <id|name>`: target project (required only when no config default is set).
- `--railway-service <id|name>`: target service (optional when `--create-service`; if omitted, service name is derived from node name).
- `--create-service`: add service with the runtime image before bootstrap.
- `--railway-image <image>`: image used with `--create-service`.
- `--railway-environment <id|name>`: defaults to `production`.
- `--railway-workspace <id|name>`: optional workspace selector.
- `--endpoint <url>`: skip Railway domain auto-discovery and use explicit endpoint.
- `--domain-port <port>`: internal gateway/domain target port (default `7788`).
- `--init-retries <count>`: retry count for SSH init while deployment is warming (default `6`).
- `--railway-private`: skip public domain generation and resolve endpoint from Tailscale.
- `--tailscale-auth-key <key>`: optional override for `--railway-private`; injected as `TS_AUTHKEY` when provided.
- `--tailscale-hostname <hostname>`: optional Tailscale hostname override.
- `--tailscale-tags <tag:...,...>`: optional tags for tailnet policy; omitted by default.
- `--default`: set resulting node as default controller node.
- `--json`: machine-readable output.

### Storing Auth Key In Global Config

Set once:

```bash
hack config set --global 'controlPlane.extensions["dance.hack.tailscale"].config.authKey' "tskey-auth-..."
```

Compatibility note:

- `controlPlane.extensions["dance.hack.railway"].config.tailscaleAuthKey` is still read as fallback for older setups.

## Troubleshooting

1. `backend error: requested tags [tag:hack-node] are invalid or not permitted`
   - Cause: your tailnet policy does not allow that tag.
   - Fix: do not pass `--tailscale-tags` unless you explicitly configured allowed tags in your tailnet policy.
   - Bootstrap now omits tags by default and clears stale `HACK_TAILSCALE_ADVERTISE_TAGS` from existing Railway services.
2. Private node is running but bootstrap hangs on endpoint resolution
   - Cause: userspace tailscaled socket mismatch when probing `tailscale status`.
   - Fix: current bootstrap probes `tailscale --socket /tmp/tailscaled.sock status --json`; update to latest CLI build.
3. Node appears in Tailscale admin but not in Hack Desktop topology
   - Cause: node was not registered into Hack controller registry (tailnet join alone is not enough).
   - Fix: run bootstrap to completion, then refresh topology in app (or reopen settings).

## Validation Checklist

After bootstrap:

```bash
hack node list
hack node status --node <node-id>
hack dispatch run --node <node-id> --project <project> --branch <branch> --runner generic -- "pwd"
```

Pin a project to remote execution mode:

```bash
hack config set "controlPlane.execution.mode" "local_edit_remote_run"
hack config set "controlPlane.execution.nodeId" "<node-id>"
hack up --target auto
```

## E2E Test Matrix (Railway + Tailscale Auth Key)

Run this matrix before marking Railway bootstrap stable:

1. **Readiness checks**
   - `railway --version`
   - `railway whoami`
   - `tailscale status --json` (controller only)
2. **Private bootstrap (auth key path)**
   - run bootstrap with `--railway-private --tailscale-auth-key`
   - confirm output includes `"network": "tailscale-private"` and `"tailscaleAuth": "provided"` (or `"config"` / `"env"` if resolved from defaults)
3. **Registry + probe**
   - `hack node list`
   - `hack node status --node <node-id>`
4. **Dispatch execution**
   - `hack dispatch run --node <node-id> --project <project> --branch <branch> --runner generic -- "uname -a"`
5. **Dev flow smoke**
   - `hack node devcontainer up --node <node-id> --project <project> --branch <branch>`
   - attach from local IDE and verify shell commands execute
6. **Cleanup**
   - `hack node remove <node-id>`
   - remove Railway test service if created during test

### Automated E2E Runner

Use the bundled runner for a repeatable CLI validation:

```bash
bun run test:e2e:railway
```

`scripts/railway-node-e2e.ts` now treats `HACK_RAILWAY_E2E_*` as overrides. If unset, it relies on the same CLI bootstrap defaults used by normal flows (provider profile routing + Railway extension config).

Optional override env vars:

- `HACK_RAILWAY_E2E_PROJECT=<project-id-or-name>` (optional override)
- `HACK_RAILWAY_E2E_SERVICE=<service-id-or-name>` (optional override)
- `HACK_RAILWAY_E2E_ENVIRONMENT=<environment>` (optional override)
- `HACK_RAILWAY_E2E_WORKSPACE=<workspace-id-or-name>` (optional override)
- `HACK_RAILWAY_E2E_CREATE_SERVICE=true` (optional override)
- `HACK_RAILWAY_E2E_IMAGE=hackdance/hack:latest` (optional override)
- `HACK_RAILWAY_E2E_NODE_NAME=<node-name>` (optional override)
- `HACK_RAILWAY_E2E_ENDPOINT=https://...` (optional override)
- `HACK_RAILWAY_E2E_DEFAULT_NODE=true` (optional override)
- `HACK_RAILWAY_E2E_LABELS=railway,e2e` (optional override)
- `HACK_RAILWAY_E2E_PRIVATE=true` (optional override)
- `HACK_RAILWAY_E2E_TAILSCALE_AUTH_KEY=tskey-auth-...` (optional override)
- `HACK_RAILWAY_E2E_TAILSCALE_HOSTNAME=<hostname>` (optional override)
- `HACK_RAILWAY_E2E_TAILSCALE_TAGS=tag:my-allowed-tag` (optional)
- `HACK_RAILWAY_E2E_INIT_RETRIES=<count>` (optional override)
- `HACK_RAILWAY_E2E_DOMAIN_PORT=<port>` (optional override)
- `HACK_TAILSCALE_AUTH_KEY=tskey-auth-...` (shell fallback when config/flag are not used)

## Current Limitations

1. Railway bootstrap currently assumes the runtime image already contains `hack` CLI.
2. If your image is private, Railway must have valid registry credentials or deploy will fail.
3. Domain auto-discovery relies on Railway CLI JSON output shape; pass `--endpoint` to bypass.
4. This is v1 provider automation and does not replace AWS/SSM-first roadmap items.
