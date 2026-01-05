# Gateway API (hackd HTTP/WS)

The gateway exposes a small, authenticated HTTP/WS surface for remote orchestration. It is
designed for structured workflows (jobs + log streaming + shells) and keeps write access
opt-in with explicit guardrails.

## Security model (read this first)

- The gateway binds to `127.0.0.1` by default. Expose it only through a Zero Trust tunnel,
  VPN, or SSH port-forward.
- Tokens are required for every request (HTTP and WS).
- Tokens have scopes (`read` or `write`). Non-GET requests and shell streams require `write`.
- Non-GET requests are blocked unless `controlPlane.gateway.allowWrites = true`.
- Token secrets are never stored; only hashed records are kept on disk.
- Audit log is appended to `~/.hack/daemon/gateway/audit.jsonl`.

Recommended security posture:
- Use read-only tokens for monitoring.
- Use short-lived write tokens for remote execution.
- Put Cloudflare Access or Tailscale in front of the gateway.
- Rotate tokens; revoke unused ones.

## Enable + setup

1) Enable gateway and start hackd:

```bash
hack remote setup
# or:
hack gateway setup
# or manually:
hack gateway enable
hack daemon stop && hack daemon start
```

2) Create a token:

```bash
hack x gateway token-create
```

3) (Optional) Allow writes + create a write token:

```bash
hack config set 'controlPlane.gateway.allowWrites' true
hack x gateway token-create --scope write
```

4) Expose the gateway (choose one):
- SSH: `ssh -L 7788:127.0.0.1:7788 <host>`
- Cloudflare Tunnel: `hack x cloudflare tunnel-setup --hostname gateway.example.com`
- Tailscale: advertise local port via tailnet ACLs

5) (Optional) Print a QR payload for remote clients:

```bash
hack remote qr --gateway-url https://gateway.example.com --token <token>
# or SSH payload:
hack remote qr --ssh --ssh-host <host> --ssh-user <user>
```

You can also emit a QR immediately after setup (use `--no-qr` to skip):

```bash
hack gateway setup
```

Monitor gateway activity locally:

```bash
hack remote monitor
```

## Authentication

HTTP requests:
- `Authorization: Bearer <token>`
- or `x-hack-token: <token>`

WebSocket:
Use the same header on the WS handshake. Bun supports:

```ts
const ws = new WebSocket("wss://gateway.example.com/control-plane/projects/..", {
  headers: { Authorization: `Bearer ${token}` }
})
```

## Structured workflow (recommended flow)

The remote client should:

1) **Check status**
   - `GET /v1/status`
2) **Discover projects**
   - `GET /v1/projects` to get `project_id` + runtime status
3) **Run a job**
   - `POST /control-plane/projects/:projectId/jobs` (write token + allowWrites)
4) **Stream logs/events**
   - `WS /control-plane/projects/:projectId/jobs/:jobId/stream`
5) **Store results**
   - capture logs, exit status, and summary in your client/app

For interactive work, create a shell and stream over WS:

1) `POST /control-plane/projects/:projectId/shells`
2) `WS /control-plane/projects/:projectId/shells/:shellId/stream`

Clients should always persist:
- `jobId`
- last `logsOffset` / `eventsSeq` (for resume)

## CLI + SDK helpers

CLI shell client (write token + allowWrites required):

```bash
hack x supervisor shell --gateway http://127.0.0.1:7788 --token $HACK_GATEWAY_TOKEN --project-id <id>
```

TypeScript client (in-repo):
- `src/control-plane/sdk/gateway-client.ts` exposes `createGatewayClient` for typed HTTP/WS calls.

## Endpoint reference

Base URL: `http://127.0.0.1:7788` (or your tunnel URL)

### GET /v1/status

Returns daemon status and uptime.

```bash
curl -H "Authorization: Bearer $HACK_GATEWAY_TOKEN" \
  http://127.0.0.1:7788/v1/status
```

### GET /v1/metrics

Returns daemon cache and stream metrics.

### GET /v1/projects

Returns registered projects + runtime status. Includes `project_id` when registered.

Query:
- `filter` (string, project name)
- `include_global` (boolean)
- `include_unregistered` (boolean)

```bash
curl -H "Authorization: Bearer $HACK_GATEWAY_TOKEN" \
  "http://127.0.0.1:7788/v1/projects?include_unregistered=true"
```

### GET /v1/ps

Fetch runtime container status for a compose project.

Query:
- `compose_project` (required)
- `project` (optional display name)
- `branch` (optional)

### POST /control-plane/projects/:projectId/jobs

Create a job (requires write token + `allowWrites`).

Body:
```json
{
  "runner": "generic",
  "command": ["bash", "-lc", "bun test"],
  "cwd": ".",
  "env": { "NODE_ENV": "test" }
}
```

Response:
```json
{ "job": { "jobId": "...", "status": "queued", ... } }
```

### GET /control-plane/projects/:projectId/jobs
### GET /control-plane/projects/:projectId/jobs/:jobId
### POST /control-plane/projects/:projectId/jobs/:jobId/cancel

Read and manage job metadata.

### WS /control-plane/projects/:projectId/jobs/:jobId/stream

Client → server:
```json
{ "type": "hello", "logsFrom": 0, "eventsFrom": 0 }
```

Server → client:
```json
{ "type": "ready", "logsOffset": 0, "eventsSeq": 0 }
{ "type": "log", "stream": "combined", "offset": 128, "data": "..." }
{ "type": "event", "seq": 2, "event": { "type": "job.started" } }
{ "type": "heartbeat", "ts": "...", "logsOffset": 128, "eventsSeq": 2 }
```

### POST /control-plane/projects/:projectId/shells

Create a PTY-backed shell (requires write token + `allowWrites`).

Body:
```json
{ "cols": 120, "rows": 30, "cwd": ".", "shell": "/bin/zsh" }
```

Response:
```json
{ "shell": { "shellId": "...", "status": "running", ... } }
```

### GET /control-plane/projects/:projectId/shells/:shellId

Fetch shell metadata.

### WS /control-plane/projects/:projectId/shells/:shellId/stream

Client → server:
```json
{ "type": "hello", "cols": 120, "rows": 30 }
{ "type": "input", "data": "ls -la\n" }
{ "type": "resize", "cols": 160, "rows": 40 }
{ "type": "signal", "signal": "SIGINT" }
{ "type": "close" }
```

Server → client:
```json
{ "type": "ready", "shellId": "...", "cols": 120, "rows": 30, "cwd": "...", "shell": "/bin/bash", "status": "running" }
{ "type": "output", "data": "..." }
{ "type": "exit", "exitCode": 0, "signal": null }
```

Non-JSON text frames are treated as raw input.

## Error codes

- `401` `missing_token` or `invalid_token`
- `403` `writes_disabled` or `write_scope_required`
- `404` `not_found`
- `426` `upgrade_required`

## Demo: end-to-end gateway workflow

See `examples/basic/gateway-demo.ts` for a runnable script that:
- checks status
- creates a job
- streams logs/events over WS

Run it with:

```bash
export HACK_GATEWAY_URL="http://127.0.0.1:7788"
export HACK_GATEWAY_TOKEN="..."
export HACK_PROJECT_ID="..."
export HACK_COMMAND="echo hello"
export HACK_ALLOW_WRITES="1"

bun run examples/basic/gateway-demo.ts
```

## E2E smoke test (optional)

Set these env vars and run `bun test`:

```
HACK_GATEWAY_E2E=1
HACK_GATEWAY_URL=...
HACK_GATEWAY_TOKEN=...
```

If `HACK_GATEWAY_E2E_WRITE=1` is also set, the test will attempt job creation.
