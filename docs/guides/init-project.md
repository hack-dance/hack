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
- `hack up` starts the stack on an isolated network.
- `hack open` resolves the routed URL via the global proxy.

Optional:
- `hack logs --pretty` for log tailing.
- `hack tui` for the interactive dashboard.
- Configure log retention in `hack.config.json` via `logs.retention_period` (e.g. `7d`) and `logs.clear_on_down`.

Note:
- Inside containers, `localhost` points at the container itself. Update any `localhost:PORT` references to:
  - HTTP services via `https://*.hack` hostnames (matching your Caddy labels)
  - non-HTTP services via Compose service hostnames (e.g. `db`, `redis`)
