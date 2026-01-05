# examples/basic

A tiny Bun HTTP service you can use to test `hack init` discovery and routing.

## Run

```bash
bun run index.ts --port 3000 --host 0.0.0.0
```

## Gateway demo (remote workflow)

This demo calls the gateway API to create a job and stream logs.

Prereqs:
- gateway enabled + hackd running
- a gateway token (write token if you want to create jobs)

```bash
export HACK_GATEWAY_URL="http://127.0.0.1:7788"
export HACK_GATEWAY_TOKEN="..."
export HACK_PROJECT_ID="..."
export HACK_ALLOW_WRITES="1"
export HACK_COMMAND="echo hello from gateway"

bun run examples/basic/gateway-demo.ts
```

See `GATEWAY_API.md` for full API docs.
