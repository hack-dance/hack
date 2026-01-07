# Gateway API (hackd HTTP/WS)

The gateway exposes a small, authenticated HTTP/WS surface for remote orchestration. It is
designed for structured workflows (jobs + log streaming + shells) and keeps write access
opt-in with explicit guardrails.

> ⚠️ Experimental: remote exposure steps are still being validated end-to-end.

## Security model (read this first)

- The gateway binds to `127.0.0.1` by default. Expose it only through a Zero Trust tunnel,
  VPN, or SSH port-forward.
- Tokens are required for every request (HTTP and WS).
- Tokens have scopes (`read` or `write`). Non-GET requests and shell streams require `write`.
- Non-GET requests are blocked unless global `controlPlane.gateway.allowWrites = true`.
- Token secrets are never stored; only hashed records are kept on disk.
- Audit log is appended to `~/.hack/daemon/gateway/audit.jsonl`.

Recommended security posture:
- Use read-only tokens for monitoring.
- Use short-lived write tokens for remote execution.
- Put Cloudflare Access or Tailscale in front of the gateway.
- Rotate tokens; revoke unused ones.

## Quick start (one command)

```bash
hack remote setup
```

Choose Cloudflare/Tailscale/SSH when prompted. The wizard enables the gateway for the current
project, optionally enables writes, restarts `hackd`, creates a token + QR payload, and can
configure + start the exposure helper you pick.

## Enable + setup (manual)

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

Token management:

```bash
hack x gateway token-list
hack x gateway token-revoke <token-id>
```

3) (Optional) Allow writes + create a write token:

```bash
hack config set --global 'controlPlane.gateway.allowWrites' true
hack x gateway token-create --scope write
```

4) Expose the gateway (choose one):
- SSH: `ssh -L 7788:127.0.0.1:7788 <host>`
- Cloudflare Tunnel: `hack x cloudflare tunnel-setup --hostname gateway.example.com`
- Tailscale: use tailnet access (see Remote domains below)

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

## Remote domains (Cloudflare + Tailscale + SSH)

### Cloudflare (gateway HTTP/WS)

Recommended for exposing the gateway to mobile/web clients:

1) Pick a hostname under a Cloudflare-managed zone (e.g. `gateway.dimitri.computer`).
2) Run `hack x cloudflare tunnel-setup --hostname gateway.dimitri.computer`.
3) Start the tunnel: `hack x cloudflare tunnel-start`.

Cloudflare creates a CNAME to `<tunnel-id>.cfargotunnel.com` under your zone. The gateway URL is:

```
https://gateway.dimitri.computer
```

### Tailscale (VPN / SSH)

Best for SSH from iOS clients (Terminus, Blink, etc):

1) Join the tailnet on your laptop: `tailscale up --ssh`
2) Enable MagicDNS in the Tailscale admin UI.
3) Use the MagicDNS hostname in your SSH client (e.g. `laptop.tailnet.ts.net`).

For gateway access over the tailnet, either:
- run `tailscale serve tcp 7788 127.0.0.1:7788`, or
- set global `controlPlane.gateway.bind = 0.0.0.0` and restart hackd.

### SSH domain (custom)

If you want a stable `ssh.dimitri.computer` style hostname:

- Point the DNS record at your home IP **and** forward port 22 (not recommended), or
- Use Tailscale MagicDNS and treat `ssh.<tailnet>.ts.net` as your stable host.

Cloudflare Access for SSH requires `cloudflared access ssh` on the client, which is not available
on iOS, so Tailscale is the easiest mobile SSH path.

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

Browser note: the native WebSocket API cannot set headers. For browser clients, pass the token
as a query param on the WS URL:

```
wss://gateway.example.com/control-plane/projects/<id>/shells/<id>/stream?token=<token>
```

Only use this for WebSockets, and treat URLs as sensitive (tokens can leak via logs/history).

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

### Summary

| Method | Path | Write required | Description |
| --- | --- | --- | --- |
| GET | `/v1/status` | no | Daemon status + uptime |
| GET | `/v1/metrics` | no | Cache + stream metrics |
| GET | `/v1/projects` | no | Gateway-enabled projects + runtime snapshot |
| GET | `/v1/ps` | no | Compose project container list |
| GET | `/control-plane/projects/:projectId/jobs` | no | List jobs |
| POST | `/control-plane/projects/:projectId/jobs` | yes | Create job |
| GET | `/control-plane/projects/:projectId/jobs/:jobId` | no | Fetch job |
| POST | `/control-plane/projects/:projectId/jobs/:jobId/cancel` | yes | Cancel job |
| WS | `/control-plane/projects/:projectId/jobs/:jobId/stream` | no | Stream job logs/events |
| POST | `/control-plane/projects/:projectId/shells` | yes | Create shell |
| GET | `/control-plane/projects/:projectId/shells/:shellId` | no | Fetch shell |
| WS | `/control-plane/projects/:projectId/shells/:shellId/stream` | yes | Stream shell PTY |

### GET /v1/status

Returns daemon status and uptime.

```bash
curl -H "Authorization: Bearer $HACK_GATEWAY_TOKEN" \
  http://127.0.0.1:7788/v1/status
```

Response:

| Field | Type | Description |
| --- | --- | --- |
| `status` | string | Always `ok` on success |
| `version` | string | hackd version |
| `pid` | number | Process id |
| `started_at` | string | ISO timestamp |
| `uptime_ms` | number | Uptime in milliseconds |

### GET /v1/metrics

Returns daemon cache and stream metrics.

Response:

| Field | Type | Description |
| --- | --- | --- |
| `status` | string | Always `ok` on success |
| `started_at` | string | ISO timestamp |
| `uptime_ms` | number | Uptime in milliseconds |
| `cache_updated_at` | string or null | Last cache refresh time |
| `cache_age_ms` | number or null | Cache age in milliseconds |
| `last_refresh_at` | string or null | Last refresh attempt |
| `refresh_count` | number | Refresh count |
| `refresh_failures` | number | Refresh failures |
| `last_event_at` | string or null | Last docker event timestamp |
| `events_seen` | number | Docker events seen |
| `streams_active` | number | Active WS streams |

### GET /v1/projects

Returns gateway-enabled registered projects + runtime status. Includes `project_id`.

Query parameters:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `filter` | string | no | Project name filter |
| `include_global` | boolean | no | Include global infra entries |
| `include_unregistered` | boolean | no | Ignored over the gateway (always false) |

```bash
curl -H "Authorization: Bearer $HACK_GATEWAY_TOKEN" \
  "http://127.0.0.1:7788/v1/projects?include_global=true"
```

Response:

| Field | Type | Description |
| --- | --- | --- |
| `generated_at` | string | ISO timestamp |
| `filter` | string or null | Applied filter |
| `include_global` | boolean | Include global infra entries |
| `include_unregistered` | boolean | Always `false` over the gateway |
| `projects` | ProjectView[] | Gateway-enabled projects only |

### GET /v1/ps

Fetch runtime container status for a compose project.

Query parameters:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `compose_project` | string | yes | Compose project id |
| `project` | string | no | Display name |
| `branch` | string | no | Branch name |

Response:

| Field | Type | Description |
| --- | --- | --- |
| `project` | string | Display project name |
| `branch` | string or null | Branch name |
| `composeProject` | string | Compose project id |
| `items` | PsItem[] | `docker compose ps` style rows |

### POST /control-plane/projects/:projectId/jobs

Create a job (requires write token + `allowWrites`).

Request body:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `runner` | string | no | Runner name (default: `generic`) |
| `command` | string[] | yes | Command argv |
| `cwd` | string | no | Working directory (relative to project root) |
| `env` | object | no | Environment overrides |

```json
{
  "runner": "generic",
  "command": ["bash", "-lc", "bun test"],
  "cwd": ".",
  "env": { "NODE_ENV": "test" }
}
```

Response:
| Field | Type | Description |
| --- | --- | --- |
| `job` | JobMeta | Job metadata |

### GET /control-plane/projects/:projectId/jobs
### GET /control-plane/projects/:projectId/jobs/:jobId
### POST /control-plane/projects/:projectId/jobs/:jobId/cancel

Read and manage job metadata.

Responses:

| Endpoint | Field | Type | Description |
| --- | --- | --- | --- |
| `GET /jobs` | `jobs` | JobMeta[] | Job list |
| `GET /jobs/:jobId` | `job` | JobMeta | Job details |
| `POST /jobs/:jobId/cancel` | `status` | string | Always `cancelled` on success |

### WS /control-plane/projects/:projectId/jobs/:jobId/stream

Client -> server (JSON):

| Type | Fields | Description |
| --- | --- | --- |
| `hello` | `logsFrom?`, `eventsFrom?` | Start streaming from offsets (default 0) |

```json
{ "type": "hello", "logsFrom": 0, "eventsFrom": 0 }
```

Server -> client (JSON):

| Type | Fields | Description |
| --- | --- | --- |
| `ready` | `logsOffset`, `eventsSeq` | Current offsets |
| `log` | `stream`, `offset`, `data` | Log chunk (`stream` is `combined`) |
| `event` | `seq`, `event` | Job event (see JobEvent) |
| `heartbeat` | `ts`, `logsOffset`, `eventsSeq` | Keepalive with offsets |
| `error` | `message` | Error string (e.g. `job_not_found`) |

```json
{ "type": "ready", "logsOffset": 0, "eventsSeq": 0 }
{ "type": "log", "stream": "combined", "offset": 128, "data": "..." }
{ "type": "event", "seq": 2, "event": { "type": "job.started" } }
{ "type": "heartbeat", "ts": "...", "logsOffset": 128, "eventsSeq": 2 }
```

### POST /control-plane/projects/:projectId/shells

Create a PTY-backed shell (requires write token + `allowWrites`).

Request body:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cols` | number | no | Terminal columns |
| `rows` | number | no | Terminal rows |
| `cwd` | string | no | Working directory (relative to project root) |
| `shell` | string | no | Shell path (default: `$SHELL` or `/bin/bash`) |
| `env` | object | no | Environment overrides |

```json
{ "cols": 120, "rows": 30, "cwd": ".", "shell": "/bin/zsh" }
```

Response:
| Field | Type | Description |
| --- | --- | --- |
| `shell` | ShellMeta | Shell metadata |

### GET /control-plane/projects/:projectId/shells/:shellId

Fetch shell metadata.

Response:

| Field | Type | Description |
| --- | --- | --- |
| `shell` | ShellMeta | Shell metadata |

### WS /control-plane/projects/:projectId/shells/:shellId/stream

Client -> server (JSON):

| Type | Fields | Description |
| --- | --- | --- |
| `hello` | `cols?`, `rows?` | Optional initial size |
| `input` | `data` | Input text |
| `resize` | `cols`, `rows` | Resize PTY |
| `signal` | `signal` | Send signal (SIGINT, SIGTERM, SIGKILL, SIGHUP, SIGQUIT, SIGUSR1, SIGUSR2, SIGTSTP) |
| `close` | - | Close the shell |

```json
{ "type": "hello", "cols": 120, "rows": 30 }
{ "type": "input", "data": "ls -la\n" }
{ "type": "resize", "cols": 160, "rows": 40 }
{ "type": "signal", "signal": "SIGINT" }
{ "type": "close" }
```

Server -> client (JSON):

| Type | Fields | Description |
| --- | --- | --- |
| `ready` | `shellId`, `cols`, `rows`, `cwd`, `shell`, `status` | Shell info |
| `output` | `data` | Output data |
| `exit` | `exitCode`, `signal` | Exit info |

```json
{ "type": "ready", "shellId": "...", "cols": 120, "rows": 30, "cwd": "...", "shell": "/bin/bash", "status": "running" }
{ "type": "output", "data": "..." }
{ "type": "exit", "exitCode": 0, "signal": null }
```

Non-JSON text frames are treated as raw input.

## Schemas

### JobMeta

| Field | Type | Description |
| --- | --- | --- |
| `jobId` | string | Job id |
| `status` | string | `queued`, `starting`, `running`, `completed`, `failed`, `cancelled`, `awaiting_input` |
| `runner` | string | Runner name |
| `command` | string[] (optional) | Command argv |
| `projectId` | string (optional) | Project id |
| `projectName` | string (optional) | Project name |
| `createdAt` | string | ISO timestamp |
| `updatedAt` | string | ISO timestamp |
| `lastEventSeq` | number | Last event sequence number |

### JobEvent

| Field | Type | Description |
| --- | --- | --- |
| `seq` | number | Event sequence number |
| `ts` | string | ISO timestamp |
| `type` | string | Event type (e.g. `job.started`) |
| `payload` | object (optional) | Optional payload |

### ShellMeta

| Field | Type | Description |
| --- | --- | --- |
| `shellId` | string | Shell id |
| `status` | string | `running` or `exited` |
| `createdAt` | string | ISO timestamp |
| `updatedAt` | string | ISO timestamp |
| `projectId` | string (optional) | Project id |
| `projectName` | string (optional) | Project name |
| `cwd` | string | Working directory |
| `shell` | string | Shell path |
| `cols` | number | Terminal columns |
| `rows` | number | Terminal rows |
| `pid` | number (optional) | Process id |
| `exitCode` | number (optional) | Exit code |
| `signal` | string or null | Exit signal |

### ProjectView

| Field | Type | Description |
| --- | --- | --- |
| `project_id` | string or null | Project id |
| `name` | string | Project name |
| `dev_host` | string or null | Dev host (without scheme) |
| `repo_root` | string or null | Repo root path |
| `project_dir` | string or null | Project `.hack` dir |
| `defined_services` | string[] or null | Services defined in compose |
| `runtime` | RuntimeProject or null | Runtime snapshot |
| `branch_runtime` | array | Branch entries `{ branch, runtime }` |
| `kind` | string | `registered` or `unregistered` |
| `status` | string | `running`, `stopped`, `missing`, `unregistered` |

### RuntimeProject

| Field | Type | Description |
| --- | --- | --- |
| `project` | string | Compose project name |
| `working_dir` | string or null | Compose working directory |
| `services` | RuntimeService[] | Services + containers |

### RuntimeService

| Field | Type | Description |
| --- | --- | --- |
| `service` | string | Service name |
| `containers` | RuntimeContainer[] | Containers |

### RuntimeContainer

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Container id |
| `state` | string | Container state |
| `status` | string | Human-readable status |
| `name` | string | Container name |
| `ports` | string | Port mapping string |
| `working_dir` | string or null | Compose working directory |

### PsItem

| Field | Type | Description |
| --- | --- | --- |
| `Service` | string | Compose service name |
| `Name` | string | Container name |
| `Status` | string | Container status |
| `Ports` | string | Ports string |

## Error codes

- `401` `missing_token` or `invalid_token`
- `403` `writes_disabled`, `write_scope_required`, or `project_disabled`
- `404` `not_found`
- `426` `upgrade_required`

## Demo: end-to-end gateway workflow

See `examples/basic/gateway-demo.ts` for a runnable script that:
- checks status
- creates a job
- streams logs/events over WS

Browser shell demo:
- `examples/next-app/app/gateway/page.tsx` (xterm UI)

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

Run the gateway e2e (auto-generates tokens; requires gateway enabled and hackd running):

```bash
# Optional: run against a specific project directory
export HACK_GATEWAY_E2E_CWD=/path/to/project

# Optional: disable write tests
export HACK_GATEWAY_E2E_WRITE=0

bun run test:e2e:gateway
```
