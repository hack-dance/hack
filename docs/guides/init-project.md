# Initialize a project

This sets up a repo so it can run under hack.

```bash
cd /path/to/repo
hack init
hack up --detach
hack open
```

Notes:
- `hack init` writes `.hack/` files (Compose + config).
- `hack init` also scaffolds `.hack/hack.env.default.yaml`. See `docs/env.md`.
- `hack up` starts the stack on an isolated network.
- `hack open` resolves the routed URL via the global proxy.

Optional:
- `hack logs --pretty` for log tailing.
- `hack tui` for the interactive dashboard.
- Configure log retention in `hack.config.json` via `logs.retention_period` (e.g. `7d`) and `logs.clear_on_down`.
- Add startup hooks/host processes in `.hack/hack.config.json` under `lifecycle` (or `startup` shorthand). See `docs/lifecycle.md`.
- For fixed-port host helpers such as SSM tunnels, add `singleton.ports` and usually `onConflict: "adopt"` so `hack up` reuses an already-running equivalent helper instead of starting duplicate tunnel stacks.

Note:
- Inside containers, `localhost` points at the container itself. Update any `localhost:PORT` references to:
  - HTTP services via `https://*.hack` hostnames (matching your Caddy labels)
  - non-HTTP services via Compose service hostnames (e.g. `db`, `redis`)

When the local path is working and you intentionally want remote execution or gateway exposure, move
to [Beta workflows](../beta.md). For full command lookup and extension docs, use
[Extensions & reference](../reference.md).
