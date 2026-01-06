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
