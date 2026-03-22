# Remote Node Runtime Container

This is a beta workflow.
Start with [Core docs](../core.md) if you are new to `hack`, and use [Beta workflows](../beta.md)
for the rest of the remote path.

Use the published node-runtime container to spin up a remote node with minimal host setup.

Recommended public image:
- `hackdance/hack:latest`

The container bundles:
- `hack` CLI binary
- `docker` CLI + `docker compose` plugin
- bootstrap entrypoint that can initialize a project, enable gateway, and emit an enrollment bundle

## Quick Start (manual host)

1. Start the runtime container on the remote host:

```bash
docker run -d \
  --name hack-node \
  --restart unless-stopped \
  -p 7788:7788 \
  -v hack-node-home:/var/lib/hack \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e HACK_NODE_NAME="aws-node-1" \
  -e HACK_NODE_ENDPOINT="https://node.example.com" \
  -e HACK_NODE_GIT_REPO="git@github.com:<org>/<repo>.git" \
  -e HACK_NODE_LABELS="aws,ec2,linux" \
  -e HACK_NODE_ENROLL_PATH="/var/lib/hack/enrollment/node.bundle.json" \
  hackdance/hack:latest
```

2. Fetch enrollment bundle from the remote host:

```bash
ssh <remote-host> 'docker exec hack-node cat /var/lib/hack/enrollment/node.bundle.json' > node.bundle.json
```

3. Register node on controller:

```bash
hack node add --bundle node.bundle.json --default
hack node status --watch
```

## Private Repo Bootstrap

When `HACK_NODE_GIT_REPO` points to a private repo, credentials must be available inside the container.

Common approaches:
- SSH deploy key:
  - mount key material into the container (`-v ~/.ssh:/root/.ssh:ro`) and pre-populate `known_hosts`.
- HTTPS token:
  - provide a credential helper/config in the image or mount git credential files.

If credentials are missing, workspace bootstrap clone fails and dispatch cannot prepare branch workspaces.

## Bootstrap Behavior

Container entrypoint behavior (default):
1. Creates node workspace directory.
2. Optionally clones repo (`HACK_NODE_GIT_REPO`).
3. Initializes project via `hack init --auto --no-discovery` when `.hack/` is missing.
4. Enables project gateway and global gateway extension.
5. Applies gateway bind/port/allowWrites config from env vars.
6. Optionally writes enrollment bundle (`HACK_NODE_ENROLL_PATH`).
7. Clears daemon pid/socket state in persisted home volumes.
8. Starts `hack daemon start --foreground`.

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `HACK_NODE_WORKDIR` | `/workspace` | Base workspace root in container |
| `HACK_NODE_PROJECT_DIR` | `/workspace/node-project` | Project directory used for node bootstrap |
| `HACK_NODE_PROJECT_NAME` | `hack-node` | Project name passed to `hack init` |
| `HACK_NODE_AUTO_INIT` | `1` | Auto-run `hack init` when missing |
| `HACK_NODE_GIT_REPO` | - | Optional repo URL to clone into project dir |
| `HACK_NODE_GIT_BRANCH` | - | Optional clone branch |
| `HACK_NODE_GIT_DEPTH` | `1` | Clone depth |
| `HACK_NODE_GATEWAY_ENABLE` | `1` | Enable gateway config during bootstrap |
| `HACK_NODE_GATEWAY_BIND` | `0.0.0.0` | Gateway bind address |
| `HACK_NODE_GATEWAY_PORT` | `${PORT}` when present, else `7788` | Gateway port override |
| `HACK_NODE_GATEWAY_ALLOW_WRITES` | `1` | Set `controlPlane.gateway.allowWrites` |
| `HACK_NODE_NAME` | host hostname | Name used for `hack node init` bundle |
| `HACK_NODE_ENDPOINT` | `http://127.0.0.1:<port>` | Reachable endpoint included in bundle |
| `HACK_NODE_LABELS` | - | Comma-separated labels in bundle |
| `HACK_NODE_ENROLL_PATH` | - | Path to write enrollment bundle JSON |
| `HACK_NODE_ENROLL_FORCE` | `0` | Overwrite existing enrollment bundle |
| `HACK_DAEMON_DISABLE_DOCKER_EVENTS` | auto (`1` when no `/var/run/docker.sock`) | Disable Docker event stream loop on non-Docker hosts |
| `HACK_TAILSCALE_ENABLE` | `0` | Enable embedded Tailscale bootstrap in container |
| `TS_AUTHKEY` | - | Tailscale auth key used for non-interactive `tailscale up` |
| `HACK_TAILSCALE_HOSTNAME` | - | Optional tailnet hostname override |
| `HACK_TAILSCALE_ADVERTISE_TAGS` | - | Optional advertised tags (for example `tag:hack-node`) |
| `HACK_TAILSCALE_SSH` | `0` | Enable Tailscale SSH during bootstrap |
| `HACK_TAILSCALE_SERVE` | `1` when enabled | Publish gateway over tailnet using `tailscale serve` |
| `HACK_TAILSCALE_SERVE_TARGET` | `127.0.0.1:<gateway-port>` | Serve target forwarded to tailnet |
| `HACK_TAILSCALE_SOCKET` | `/tmp/tailscaled.sock` | Local tailscaled socket path |
| `HACK_TAILSCALE_STATE_DIR` | `/var/lib/hack/tailscale` | Tailscale state directory |

## Dispatch Notes

- Branch-scoped dispatch expects a git workspace. For containerized nodes, set `HACK_NODE_GIT_REPO` (recommended) or initialize git manually in the project dir.
- Reusing `hack-node-home` across container restarts is supported; startup clears stale daemon pid/socket files before launching `hackd`.

## Build and Publish

Local image build:

```bash
bun run build:node-runtime-image --tag hack-node-runtime:dev
```

`build:node-runtime-image` compiles the `hack` binary inside a Linux Docker build stage, so the image is portable even when built from macOS hosts.

Publish multi-arch image:

```bash
bun run build:node-runtime-image \
  --push \
  --platform linux/amd64,linux/arm64 \
  --tag hackdance/hack:latest
```

GitHub Actions workflow:
- `.github/workflows/release-node-runtime-image.yml`
