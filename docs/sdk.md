# Control Plane SDK

Internal SDK helpers for the control plane and gateway clients.

## Gateway client

Create a typed HTTP/WS client for gateway orchestration:

```ts
import { createGatewayClient } from "./gateway-client.ts"

const client = createGatewayClient({
  baseUrl: "http://127.0.0.1:7788",
  token: process.env.HACK_GATEWAY_TOKEN ?? ""
})

const status = await client.getStatus()
if (status.ok) {
  console.log(status.data.status, status.data.uptime_ms)
}
```

Shells (write token + allowWrites required):

```ts
const created = await client.createShell({ projectId, cols: 120, rows: 30 })
if (!created.ok) throw new Error(created.error.message)

const ws = client.openShellStream({
  projectId,
  shellId: created.data.shell.shellId
})
ws.addEventListener("open", () => {
  ws.send(JSON.stringify({ type: "hello", cols: 120, rows: 30 }))
})
```

### Client options

`createGatewayClient` accepts:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `baseUrl` | string | yes | Gateway base URL (e.g. `http://127.0.0.1:7788`) |
| `token` | string | yes | Gateway token (read or write scope) |
| `timeoutMs` | number | no | Request timeout in ms (default: 5000) |

### Methods

| Method | HTTP/WS | Args | Returns | Notes |
| --- | --- | --- | --- | --- |
| `getStatus()` | GET `/v1/status` | - | `GatewayResponse<GatewayStatus>` | - |
| `getMetrics()` | GET `/v1/metrics` | - | `GatewayResponse<GatewayMetrics>` | - |
| `getProjects(opts?)` | GET `/v1/projects` | `{ filter?, includeGlobal?, includeUnregistered? }` | `GatewayResponse<GatewayProjectsPayload>` | Gateway ignores `includeUnregistered` |
| `getPs(opts)` | GET `/v1/ps` | `{ composeProject, project?, branch? }` | `GatewayResponse<GatewayPsPayload>` | - |
| `listJobs(opts)` | GET `/control-plane/projects/:id/jobs` | `{ projectId }` | `GatewayResponse<GatewayJobListResponse>` | - |
| `getJob(opts)` | GET `/control-plane/projects/:id/jobs/:jobId` | `{ projectId, jobId }` | `GatewayResponse<GatewayJobResponse>` | - |
| `createJob(opts)` | POST `/control-plane/projects/:id/jobs` | `{ projectId, runner?, command, cwd?, env? }` | `GatewayResponse<GatewayJobResponse>` | Write token + allowWrites |
| `cancelJob(opts)` | POST `/control-plane/projects/:id/jobs/:jobId/cancel` | `{ projectId, jobId }` | `GatewayResponse<GatewayCancelResponse>` | Write token + allowWrites |
| `createShell(opts)` | POST `/control-plane/projects/:id/shells` | `{ projectId, shell?, cwd?, env?, cols?, rows? }` | `GatewayResponse<GatewayShellResponse>` | Write token + allowWrites |
| `getShell(opts)` | GET `/control-plane/projects/:id/shells/:shellId` | `{ projectId, shellId }` | `GatewayResponse<GatewayShellResponse>` | - |
| `openJobStream(opts)` | WS `/control-plane/projects/:id/jobs/:jobId/stream` | `{ projectId, jobId }` | `WebSocket` | Uses `?token=` query string |
| `openShellStream(opts)` | WS `/control-plane/projects/:id/shells/:shellId/stream` | `{ projectId, shellId }` | `WebSocket` | Uses `?token=` query string |

### Response types

`GatewayResponse<T>`:

| Field | Type | Description |
| --- | --- | --- |
| `ok` | boolean | Success flag |
| `status` | number | HTTP status code |
| `data` | T | Present when `ok: true` |
| `error` | GatewayError | Present when `ok: false` |

`GatewayError`:

| Field | Type | Description |
| --- | --- | --- |
| `message` | string | Error message |
| `code` | string (optional) | Error code (e.g. `writes_disabled`) |
| `raw` | object (optional) | Raw response payload |

For payload schemas (`GatewayStatus`, `GatewayMetrics`, `GatewayProjectsPayload`, `GatewayPsPayload`,
`JobMeta`, `ShellMeta`), see `docs/gateway-api.md`.

## Control-plane config

Read control-plane configuration (global config + project overrides):

```ts
import { readControlPlaneConfig } from "./config.ts"

const config = await readControlPlaneConfig({ projectDir: "/path/to/repo/.hack" })
console.log(config.config.gateway.enabled)
```

## Notes

- Global config lives at `~/.hack/hack.config.json` (override with `HACK_GLOBAL_CONFIG_PATH`).
- Gateway write operations require global `controlPlane.gateway.allowWrites = true` and a write-scoped token.
- See `gateway-api.md` for endpoint details and structured workflows.
