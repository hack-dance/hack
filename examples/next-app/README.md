# examples/next-app

Bootstrap a single-app Bun project and add `hack` with deps + ops patterns.

## 1) Scaffold a Next app

Pick a template and create a project:

```bash
bunx create-next-app@latest
bun install
```

## 2) Initialize `hack`

```bash
hack init
```

## 3) Add deps + ops patterns

Edit `.hack/docker-compose.yml` to add a `deps` service and (optionally) an ops service.

`deps` (containerized installs):

```yaml
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

Example app service (adjust command + port for your template):

```yaml
www:
  image: imbios/bun-node:latest
  working_dir: /app
  volumes:
    - ..:/app
    - node_modules:/app/node_modules // mount the shared deps volume
  command: bun run dev -- -p 3000 -H 0.0.0.0
  depends_on:
    deps:
      condition: service_completed_successfully
  labels:
    caddy: "bun-app.hack, bun-app.hack.gy"
    caddy.reverse_proxy: "{{upstreams 3000}}"
    caddy.tls: internal
  networks:
    - hack-dev
    - default
```

Optional `ops` (profiled ops commands):

```yaml
ops:
  image: imbios/bun-node:latest
  working_dir: /app
  volumes:
    - ..:/app
    - node_modules:/app/node_modules
  environment:
    DATABASE_URL: postgres://postgres:postgres@db:5432/mydb
  depends_on:
    - db
    - deps
  networks:
    - default
  profiles: ["ops"]
  command: bun run db:generate //optionally add a default command to run.
```

## 4) Run

```bash
hack global install
hack up --detach
hack open
hack logs
```


## Using the ops script
see example ops script that simply wraps the docker compose command here: [scripts/ops.ts](scripts/ops.ts)

```bash
bun ops -- bun db:generate
```

## Notes

- Adjust `command` + `working_dir` to match your template.
- Keep ops services on the default network only.

## Gateway shell MVP (xterm)

This example includes a minimal browser terminal at `/gateway`.

1) Enable the gateway and generate a write token:

```bash
hack remote setup
hack config set --global 'controlPlane.gateway.allowWrites' true
hack x gateway token-create --scope write
```

2) Install deps + run the app:

```bash
cd examples/next-app
bun install
bun run dev
```

3) Open http://localhost:3000/gateway and paste your gateway URL + token.

The UI uses the gateway HTTP API for setup and a WebSocket for the shell stream.
