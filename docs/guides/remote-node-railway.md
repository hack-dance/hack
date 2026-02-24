# Railway Node Bootstrap Guide

Use this guide to register a Railway-hosted runtime as a `hack` remote node with one controller command.

## Quick Start

Existing Railway service:

```bash
hack node provider railway bootstrap \
  --railway-project "<project-id-or-name>" \
  --railway-service "<service-id-or-name>" \
  --railway-environment production \
  --default
```

Private-by-default via Tailscale (no public Railway domain required):

```bash
hack node provider railway bootstrap \
  --railway-project "<project-id-or-name>" \
  --railway-service "<service-id-or-name>" \
  --railway-private \
  --tailscale-auth-key "tskey-auth-..." \
  --default
```

Private mode with auth key preconfigured in global config:

```bash
hack config set --global 'controlPlane.extensions["dance.hack.tailscale"].config.authKey' "tskey-auth-..."
hack node provider railway bootstrap \
  --railway-project "<project-id-or-name>" \
  --railway-service "<service-id-or-name>" \
  --railway-private \
  --default
```

Create service from `hack-node-runtime` image first:

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

If you already know the public endpoint, pass it explicitly:

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
   - Railway project (required)
   - Node display name (optional)
   - Private tailscale mode toggle
5. Keep service empty unless you need an existing Railway service:
   - empty service => app auto-creates a service from node name
   - set service => app targets that service
6. For private mode, use one of:
   - saved auth key in global config (recommended)
   - env var `HACK_TAILSCALE_AUTH_KEY`
   - direct auth key override via `--tailscale-auth-key`
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

- `--railway-project <id|name>`: required target project.
- `--railway-service <id|name>`: target service (optional when `--create-service`; if omitted, service name is derived from node name).
- `--create-service`: add service with the runtime image before bootstrap.
- `--railway-image <image>`: image used with `--create-service`.
- `--railway-environment <id|name>`: defaults to `production`.
- `--railway-workspace <id|name>`: optional workspace selector.
- `--endpoint <url>`: skip Railway domain auto-discovery and use explicit endpoint.
- `--domain-port <port>`: internal gateway/domain target port (default `7788`).
- `--init-retries <count>`: retry count for SSH init while deployment is warming (default `6`).
- `--railway-private`: skip public domain generation and resolve endpoint from Tailscale.
- `--tailscale-auth-key <key>`: required for `--railway-private`; injected as `TS_AUTHKEY`.
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
HACK_RAILWAY_E2E_PROJECT="<project-id-or-name>" \
HACK_RAILWAY_E2E_SERVICE="<service-id-or-name>" \
HACK_RAILWAY_E2E_PRIVATE=true \
HACK_RAILWAY_E2E_TAILSCALE_AUTH_KEY="tskey-auth-..." \
bun run test:e2e:railway
```

Optional env vars:

- `HACK_RAILWAY_E2E_CREATE_SERVICE=true`
- `HACK_RAILWAY_E2E_IMAGE=hackdance/hack:latest`
- `HACK_RAILWAY_E2E_DEFAULT_NODE=true`
- `HACK_RAILWAY_E2E_LABELS=railway,e2e`
- `HACK_RAILWAY_E2E_TAILSCALE_TAGS=tag:my-allowed-tag` (optional)
- `HACK_TAILSCALE_AUTH_KEY=tskey-auth-...` (global fallback when `--tailscale-auth-key` is not passed)

## Current Limitations

1. Railway bootstrap currently assumes the runtime image already contains `hack` CLI.
2. If your image is private, Railway must have valid registry credentials or deploy will fail.
3. Domain auto-discovery relies on Railway CLI JSON output shape; pass `--endpoint` to bypass.
4. This is v1 provider automation and does not replace AWS/SSM-first roadmap items.
