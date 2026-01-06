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
