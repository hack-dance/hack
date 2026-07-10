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
- `hack open` resolves the routed URL via the global proxy and prefers the OAuth alias when
  `oauth.enabled` is true. Set `open.prefer` or pass `--prefer auto|alias|dev` to override.

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

## What discovery checks (and what it can't)

`hack init` (interactive and `--auto`) discovers dev scripts across a repo/monorepo
and runs a validation pass over the results before writing `.hack/docker-compose.yml`.
It catches common scaffolding mistakes automatically, but it is not a substitute for
reviewing the generated compose file:

- **Duplicate/aggregator script dedupe**: when a package defines both `dev` and
  `start` (or similar), only the best-scoring script becomes a service — no more
  `web` + `web-2`. Root-level "aggregator" scripts that just delegate to a
  workspace package's own dev script (e.g. `turbo run dev --filter=web`, or
  `dotnet run --project apps/backend`) are also dropped in favor of the
  package-local script. In the interactive wizard, the deduped set is
  pre-selected by default — you can still add a dropped script back manually.
- **Port reassignment**: HTTP services that would collide on the same internal
  port are deterministically reassigned to the next free port (ascending from
  the collision), and the container command is rewritten to match. Each
  reassignment is logged as a warning.
- **Runtime TODOs**: services whose dev script looks non-JS (`.csproj`/`.fsproj`,
  `go.mod`, `Cargo.toml`, `pyproject.toml`/`requirements.txt`, `mix.exs`,
  `Gemfile`, or a command like `dotnet run`/`go run`/`cargo`/`python`/`mix`) get an
  obviously-wrong placeholder image (`alpine:3`) plus a `TODO(hack-init): ...`
  comment above the service in the compose file — instead of silently getting the
  default Bun/Node image. You must replace the image and command by hand.
- **Backing-service warnings**: dependencies (`pg`, `ioredis`, `@temporalio/*`,
  `kafkajs`, `amqplib`, `mongodb`/`mongoose`, `prisma`, ...) and `.env`/`.env.example`
  key names (never values) are scanned for signals of postgres, mysql, redis,
  temporal, kafka, rabbitmq, or mongodb. These are **not** auto-scaffolded — they
  show up as warnings and as a comment block at the top of the generated compose
  file with a one-line suggestion each. If a `docker-compose*.yml`/`compose*.yml`
  already exists at the repo root, it's flagged too ("treat it as ground truth for
  backing services and images") instead of being re-derived from scratch.

None of this replaces reviewing the scaffold. Discovery is a best-effort heuristic
pass, not ground truth — always inventory the generated `.hack/docker-compose.yml`
against the real repo before running `hack up` (agents included; see the
onboarding prompt for the inventory-first review step).

When the local path is working and you intentionally want remote execution or gateway exposure, move
to [Beta workflows](../beta.md). For full command lookup and extension docs, use
[Extensions & reference](../reference.md).
