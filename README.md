<a id="readme-top"></a>

<!-- PROJECT LOGO -->
<br />
<div align="center">
  <a href="https://github.com/othneildrew/Best-README-Template">
    <img src="hacker-mash.gif" alt="Logo" width="600">
  </a>

  <h3 align="center">hack</h3>

  <p align="center">
    Opinionated local-dev orchestration for running <b>multiple projects</b> at the same time** without port conflicts.
    <br />
  </p>
</div>
<br />
<br />

- **Network isolation per repo / branch**: every instance runs on its own Docker network (so Postgres/Redis/etc can stay on default ports *inside* the project).
- **Stable HTTPS hostnames**: `https://<project>.hack` (and subdomains like `https://api.<project>.hack`) routed by a global Caddy proxy.
- **Good logs UX**: instant `docker compose logs` tailing, plus Loki/Grafana for querying + history.
- **Opt-in per repo**: no invasive changes to your codebase; config lives in `.hack/`.


### Why this exists

Most of my projects run the same stack. That’s fine until you want to:

- run two projects at the same time
- run two branches of the same repo
- run multiple worktrees in parallel

At that point everything fights over `localhost` and default ports.

The daily choice:

- **Option A:** stop A → start B → ship fix → stop B → restart A  
  you just spent 5–10 minutes paying the orchestration tax and nuking your focus.
- **Option B:** don’t run it. code blind. push. let CI tell you what you broke.

Neither scales. Both slow you down in dumb, repeatable ways.


## Quickstart

### Prerequisites
- **Docker** (OrbStack works great)
- **macOS**:
  - `hack global install` will optionally set up `dnsmasq` so `*.hack` resolves locally
  - `hack global trust` can trust Caddy’s local CA so HTTPS is clean


### Setup
```bash
hack global install
```

### Initialize a repo
```bash
cd /path/to/your-repo
hack init
hack up --detach
hack open
```

### Configuration (.hack/hack.config.json)
- `name`: project slug (also used for Docker Compose project name)
- `dev_host`: base hostname (`<dev_host>.hack`)

*Optional `[logs]` settings*
- `follow_backend`: `compose|loki` (default: `compose`)
- `snapshot_backend`: `compose|loki` (default: `loki`)
- `clear_on_down`: when running `hack down`, request Loki delete for this project (best-effort)
- `retention_period`: e.g. `"24h"`; on `hack down`, prune older logs (best-effort)

*Optional `[internal]` settings (container DNS/TLS)*
- `dns`: use CoreDNS to resolve `*.hack` inside containers (default: `true`)
- `tls`: mount Caddy Local CA + set common SSL env vars (default: `true`)

*Optional `[oauth]` settings (OAuth-safe alias host)*
- `enabled`: when true, `hack init` generates Caddy labels so routed services answer on both:
- primary: `https://<dev_host>`
- OAuth alias: `https://<dev_host>.<tld>` (e.g. `https://sickemail.hack.gy`)
- `tld`: optional (default: `"gy"`). Only `*.hack.gy` is bootstrapped automatically by `hack global install`; other TLDs require manual DNS setup.

The file includes a JSON Schema reference for editor validation:

```json
{
  "$schema": "https://schemas.hack/hack.config.schema.json"
}
```

Schemas are served locally by the global Caddy proxy at `https://schemas.hack`.

Quick edits:

```bash
hack config get dev_host
hack config set dev_host "myapp.hack"
hack config set logs.snapshot_backend "compose"
```

## Commands (high level)

- **Global**: `hack global install|up|down|status|logs|logs-reset|ca|cert|trust`
- **Project**: `hack init|up|down|restart|ps|run|logs|open`
- **Config**: `hack config get|set`
- **Projects**: `hack projects|prune`
- **Status**: `hack status` (shortcut for `hack projects --details`)
- **Branch**: `hack branch add|list|remove|open`
- **Diagnostics**: `hack doctor`
- **Crash override**: `hack the planet`

Run `hack help <command>` for detailed help.

Project commands that call Docker Compose accept `--profile` (up/down/restart/ps/logs/run).

## JSON output

Use `--json` for machine-readable output:

- `hack projects --json`
- `hack ps --json`
- `hack logs --json` (NDJSON stream; use `--no-follow` for snapshots)

`hack logs --json` emits event envelopes (`start`, `log`, `end`) so MCP/TUI consumers can stream safely.

## Branch builds (worktree-friendly)

Use `--branch <name>` on project commands to run isolated instances with unique hostnames and compose
project names:

```bash
hack up --branch feature-x --detach
hack logs --branch feature-x
hack open --branch feature-x
```

Using `--branch` will create/update `.hack/hack.branches.json` with a `last_used_at` timestamp. Branch
instances show up in `hack projects --details`.

Optional: track branch aliases in `.hack/hack.branches.json` for quick lookup:

```bash
hack branch add feature-x --note "worktree for PR 123"
hack branch list
hack branch open feature-x
```


## Service-to-service connections (DB/Redis)

If your app runs in Docker (the default in `hack`), don’t connect to `127.0.0.1` / `localhost` for Postgres/Redis.
Inside a container, `localhost` is that container, not the other compose services.

With CoreDNS enabled (`internal.dns: true`), containers can use the same `https://*.hack` URLs as your host.
If CoreDNS isn’t running (or you disable it), use the Compose service hostname on the default network:

- `Postgres: db:5432`
- `Redis: redis:6379`

Note: Caddy’s CA is mounted into containers when `internal.tls: true` so HTTPS calls to `*.hack` work for most runtimes.
If you’re using Java/Kotlin, you’ll need to import the CA into the JVM truststore manually.

Example:

```yaml
environment:
  DATABASE_URL: postgres://postgres:postgres@db:5432/mydb
  REDIS_URL: redis://redis:6379
```

If you need host access for debugging, prefer `docker compose exec` so you don’t reintroduce port conflicts:

```bash
docker compose -f .hack/docker-compose.yml exec db psql -U postgres -d mydb
docker compose -f .hack/docker-compose.yml exec redis redis-cli
```


## DB schema tooling (ORM or otherwise)

Because `hack` intentionally avoids publishing DB ports to your host (so you can run many projects concurrently),
the best pattern is to run schema commands inside the compose network.

### Option A (recommended): ops-only service

Add a one-shot service to `.hack/docker-compose.yml` (adjust paths for your project):

```yaml
db-ops:
  image: imbios/bun-node:latest
  working_dir: /app/packages/db # where your db schema + package.json live
  volumes:
    - ..:/app
  environment:
    DATABASE_URL: postgres://postgres:postgres@db:5432/mydb
  depends_on:
    - db
  networks:
    - default
  profiles: ["ops"]
  # Examples:
  # - Prisma:  bunx prisma migrate deploy
  # - Drizzle: bunx drizzle-kit push
  command: bun run db:push
```

Run it on demand:

```bash
docker compose -f .hack/docker-compose.yml --profile ops run --rm db-ops
```

### Option B: run arbitrary commands via `hack run`

`hack run` is a thin wrapper over `docker compose run --rm` that automatically targets the right repo:

```bash
hack run --workdir /app/packages/db email-sync -- bunx prisma generate
hack run --workdir /app/packages/db email-sync -- bunx prisma migrate dev
hack run --workdir /app/packages/db email-sync -- bunx drizzle-kit push
hack run --workdir /app bun run turbo db:migrate
```

If your ops service is behind a compose profile, enable it:

```bash
hack run --profile ops --workdir /app/packages/db db-ops -- bun run db:push
```



## Logs (why both Compose and Loki)

By default, `hack logs` uses `docker compose logs` because it’s the lowest latency tail.

Loki is still valuable for:

- querying across time (history)
- filtering by labels (project/service/container)
- Grafana Explore / dashboards

### CLI

```bash
# Tail (fast)
hack logs --pretty

# Snapshot
hack logs --no-follow --pretty

# Snapshot JSON
hack logs --no-follow --json

# Query/history (force Loki)
hack logs --loki --pretty

# Range (Loki only)
hack logs --loki --since 2h --pretty
hack logs --loki --since 4h --until 1h --pretty

# Filter Loki by service
hack logs --loki --services api,worker --pretty

# Raw LogQL
hack logs --loki --query '{project="my-project"} |= "error"' --pretty
```

### Grafana

- Open: `hack open logs` or visit `https://logs.hack`
- Explore queries:

```logql
{project="my-project"}
{project="my-project", service="api"}
```

Alloy labels logs with:

- project: `Docker Compose project name`
- service: `Docker Compose service name`
- container: `Docker container name`


## Projects registry (bird’s-eye view)

`hack` maintains a best-effort registry under `~/.hack/projects.json` so you can target a project from anywhere:

```bash
hack projects
hack logs --project my-project --pretty
hack up --project my-project
```





## .hack and valid tld requirements

OAuth providers (notably Google) require `localhost` or a host that ends with a real public suffix.

We keep `.hack` as the primary local dev domain, and optionally expose an alias domain for OAuth flows.
Default: `*.hack.gy` → `127.0.0.1` (via dnsmasq + OS resolver).

If you use Next.js (or another dev server that cares about dev origins), configure its dev allowlist to include the proxy domains.
Next.js supports `allowedDevOrigins` (wildcards supported) in `next.config.js`:

```js
module.exports = {
  allowedDevOrigins: ["*.hack", "*.hack.gy"],
}
```

Optionally you can pass in your own custom `dev_host` to the config.


## SSL

`hack` uses Caddy’s internal PKI to issue certs for `*.hack` (and any OAuth alias host). This covers
HTTPS for services routed through Caddy, but it does not create cert/key files for services running
outside of Caddy.

- macOS: run `hack global trust` to trust the Caddy Local CA in the System keychain.
- Other OS: run `hack global ca` to export the CA cert path, then add it to your OS/browser trust store.
- If you need the PEM directly: `hack global ca --print`.
- If you are running a local service outside of Caddy, use `hack global cert <host...>` (mkcert required) to generate a cert/key under `~/.hack/certs` and wire it into your service. This is only needed for non-Caddy services that still want trusted TLS.

Install mkcert if you don't already have it (macOS example):

```bash
brew install mkcert
mkcert -install
```

Example (non-Caddy service):

```bash
hack global cert --install api.myapp.hack
```

Use `--out <dir>` if you want certs written somewhere else.

## Internal DNS (containers)

`hack global install` runs CoreDNS on the `hack-dev` network and pins Caddy + CoreDNS to stable IPs.
CoreDNS answers `*.hack` and `*.hack.*` with Caddy’s IP so containers can use the same `https://*.hack`
URLs as the host. All other DNS is forwarded to Docker’s resolver.

If you created the `hack-dev` network before this feature, recreate it once so the static IPs can be
assigned (better runtime compatibility):

```bash
docker network rm hack-dev
hack global install
```

If you update `hack`, rerun `hack global install` once to refresh the CoreDNS config.



## Why not just use X?

### Docker / Compose alone

They run containers. They don’t give you stable hostnames, HTTPS, or a way to run many isolated copies of the same stack without custom glue. 

You can build that layer yourself. I did. That’s this.

### Kubernetes

Kubernetes solves cluster orchestration. This problem is local parallelism.  
It adds complexity without fixing ports, routing, or developer feedback loops.

### Different ports

This is the default answer and it doesn’t scale.  
Ports leak into config, break OAuth and cookies, and turn into debt.  
Hostnames scale. Ports don’t.

There isn’t an off-the-shelf tool that gives you full local network isolation, real HTTPS, and near zero per-repo setup.

If you want that, you have to build it yourself.



## How it works

`hack` is a thin layer on top of Docker Compose plus a tiny global proxy.

- each project/branch runs in its own Docker network
- services use their normal ports inside that network
- a shared proxy routes `https://*.hack` and handles HTTPS
- logs are captured centrally

Your code doesn’t change. Your mental overhead does.

### Global (once per machine)

`hack global install` provisions `~/.hack/` and starts:

- **Caddy** (`lucaslorentz/caddy-docker-proxy`) on ports `80/443`
  - watches Docker labels and auto-routes `https://*.hack`
- **Logging stack**: Grafana + Loki + Alloy
  - reachable via `https://logs.hack`

### Per-project (per repo)

`hack init` creates `.hack/` in the repo root:

- `.hack/docker-compose.yml`: your project services
- `.hack/hack.config.json`: project config (name, dev host, log preferences)

Each project’s compose network stays isolated; only services you want “public” get attached to the shared ingress network so Caddy can reach them.


## Development

### From source

```bash
bun install
bun run install:dev
hack --help
```
This installs a small `hack` shim into `~/.hack/bin/hack` that runs your working tree directly (no rebuild needed).

If `hack` isn’t found, add this to your shell config:

```bash
export PATH="$HOME/.hack/bin:$PATH"
```

### Compiled binary (release-like)

```bash
bun install
bun run install:bin
hack --help
```
This builds `dist/hack` via `bun build --compile` and installs it to `~/.hack/bin/hack`.


### Run in place

```bash
bun dev --help
```

### Tests

```bash
bun test
```

### Build a standalone binary

```bash
bun run build
./dist/hack --help
```

### Packaging note (gum)

The repo ships gum tarballs under `binaries/gum/`. In packaged builds, ship `binaries/` alongside the binary (or set `HACK_ASSETS_DIR`).

See `PACKAGING.md` for details.


## Troubleshooting

- `*.hack` doesn’t resolve: run `hack doctor`, then `hack global install` (macOS: ensure dnsmasq is running).

- Stale global setup / CoreDNS issues: run `hack doctor --fix` (refreshes network + CoreDNS + CA).

- TLS warnings: run `hack global trust` (macOS).

- Logs missing in Grafana: ensure Alloy is running (`hack global status`) and try `{app="docker"}` in Explore.

- `ENOTFOUND` for `*.hack`/`*.hack.gy` inside containers: refresh CoreDNS config with `hack global install`,
  then restart CoreDNS: `docker compose -f ~/.hack/caddy/docker-compose.yml restart coredns`.

- `EAI_AGAIN` for external domains inside containers (e.g. `api.clerk.com`): CoreDNS isn’t forwarding.
  Run `hack global install` and restart CoreDNS as above.

- `hack global up` warns about `hack-dev` network labels or missing subnet: remove the network and reinstall:
  `docker network rm hack-dev` then `hack global install`.

- OAuth redirect errors: use the OAuth alias host (`*.hack.gy`) or `localhost` (providers may reject non-public suffixes like `.hack`).

- Dependecy mismatch errors: when installing dependices on your local machine (say mac os) you may have pre or post install scripts or env specific installs, trying to run you projects in a linux container with those same dependices can produce a numebr of weird depndcy issues. Common solution here is to create a shared dep service in your docker-compose:
```
  deps:
    image: imbios/bun-node:latest
    working_dir: /app
    volumes:
      - ..:/app
      - node_modules:/app/node_modules
    command: bun install
    networks:
      - default
```
then make sure your other depndent services mount the same volume and wait for it to complete
```
  www:
    image: imbios/bun-node:latest
    working_dir: /app/apps/www
    volumes:
      - ..:/app
      - node_modules:/app/node_modules
    command: bun run dev -- -p 3000 -H 0.0.0.0
    environment:
      CHOKIDAR_USEPOLLING: "true"
      WATCHPACK_POLLING: "true"
      IS_LOCAL: "1"
    labels:
      caddy: "myapp.hack, myapp.hack.gy"
      caddy.reverse_proxy: "{{upstreams 3000}}"
      caddy.tls: internal
    networks:
      - hack-dev
      - default
    depends_on:
      deps:
        condition: service_completed_successfully
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>
