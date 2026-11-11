# Config examples

The commands and configuration on this page were audited against `v5.0.0-next.13`.
The execution notes below come from the newer recipe source revision; the examples
were not rerun with the pinned binary.

Copy-paste project setups for common shapes. Each one is a complete, working project in
[`examples/configs`](https://github.com/hack-dance/hack/blob/943503b56081f9934fa98c4b80b7eea2a1a41822/examples/configs): `.hack/hack.config.json`, the env file,
`.hack/docker-compose.yml` and a small app. Copy the directory, rename `name`, `dev_host`
and the `caddy` labels, and replace the app.

The repository's tests check that these files match the projects in `examples/configs`, that
each config passes the project schema, and that every Node or Bun service uses the
[deps service](deps-service.md) pattern.

| Shape | Directory |
| --- | --- |
| [Web app with Postgres](#web-app-with-postgres) | `examples/configs/web-postgres` |
| [API with a worker and a queue](#api-with-a-worker-and-a-queue) | `examples/configs/api-worker-queue` |
| [Monorepo with two apps and a shared package](#monorepo-with-two-apps-and-a-shared-package) | `examples/configs/monorepo` |
| [Python web app with Postgres](#python-web-app-with-postgres) | `examples/configs/python-postgres` |
| [Static site with a build watcher](#static-site-with-a-build-watcher) | `examples/configs/static-site` |
| [Dev server on your machine next to containerized services](#dev-server-on-your-machine-next-to-containerized-services) | `examples/configs/host-dev-server` |

Routed services use Caddy labels and the external `hack-dev` network. Both need
the global proxy (`hack global install`). Without it, create the network yourself
with `docker network create hack-dev`, and reach services with `hack exec` or
published ports instead of their `*.hack.local` names.

## Web app with Postgres

A Bun web server and a Postgres database. The `deps` service installs packages into a volume; the web service starts when the install finished and the database is healthy.
Open `https://web-postgres.hack.local` once the global proxy is installed, or try it with `hack exec web bun -e 'console.log(await (await fetch("http://127.0.0.1:3000/")).text())'`.

<!-- include: examples/configs/web-postgres/.hack/hack.config.json -->
```json
{
  "$schema": "https://schemas.hack.local/hack.config.schema.json",
  "name": "web-postgres",
  "dev_host": "web-postgres.hack.local"
}
```

<!-- include: examples/configs/web-postgres/.hack/hack.env.default.yaml -->
```yaml
version: 1
environment: default
secretsprovider: project_key
values:
  web:
    DATABASE_URL: postgres://app:app@db:5432/app
```

<!-- include: examples/configs/web-postgres/.hack/docker-compose.yml -->
```yaml
name: web-postgres
services:
  # Installs dependencies once, inside Linux, into the shared node_modules volume.
  deps:
    image: oven/bun:1.4.4-slim
    working_dir: /app
    command: ["bun", "install", "--frozen-lockfile"]
    volumes:
      - ..:/app
      - node_modules:/app/node_modules

  web:
    image: oven/bun:1.4.4-slim
    working_dir: /app
    command: ["bun", "run", "dev"]
    volumes:
      - ..:/app
      - node_modules:/app/node_modules
    depends_on:
      deps:
        condition: service_completed_successfully
      db:
        condition: service_healthy
    labels:
      caddy: web-postgres.hack.local
      caddy.reverse_proxy: "{{upstreams 3000}}"
      caddy.tls: internal
    networks:
      - hack-dev
      - default

  db:
    image: postgres:17.6-alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "app", "-d", "app"]
      interval: 2s
      timeout: 3s
      retries: 30

volumes:
  node_modules: {}
  db-data: {}

networks:
  hack-dev:
    external: true
```

## API with a worker and a queue

An HTTP API puts jobs on a Redis list; a worker takes them off and stores a result. The API and the worker share one `deps` install and one `REDIS_URL`.
`POST /jobs` with `{"text":"hello"}` returns an id; `GET /jobs/<id>` returns `HELLO` once the worker ran. `hack logs worker` shows each job.

<!-- include: examples/configs/api-worker-queue/.hack/hack.config.json -->
```json
{
  "$schema": "https://schemas.hack.local/hack.config.schema.json",
  "name": "api-worker-queue",
  "dev_host": "api-worker-queue.hack.local"
}
```

<!-- include: examples/configs/api-worker-queue/.hack/hack.env.default.yaml -->
```yaml
version: 1
environment: default
secretsprovider: project_key
values:
  global:
    REDIS_URL: redis://queue:6379
```

<!-- include: examples/configs/api-worker-queue/.hack/docker-compose.yml -->
```yaml
name: api-worker-queue
services:
  # One install, shared by the API and the worker through the same volume.
  deps:
    image: oven/bun:1.4.4-slim
    working_dir: /app
    command: ["bun", "install", "--frozen-lockfile"]
    volumes:
      - ..:/app
      - node_modules:/app/node_modules

  api:
    image: oven/bun:1.4.4-slim
    working_dir: /app
    command: ["bun", "run", "api"]
    volumes:
      - ..:/app
      - node_modules:/app/node_modules
    depends_on:
      deps:
        condition: service_completed_successfully
      queue:
        condition: service_healthy
    labels:
      caddy: api-worker-queue.hack.local
      caddy.reverse_proxy: "{{upstreams 3000}}"
      caddy.tls: internal
    networks:
      - hack-dev
      - default

  worker:
    image: oven/bun:1.4.4-slim
    working_dir: /app
    command: ["bun", "run", "worker"]
    volumes:
      - ..:/app
      - node_modules:/app/node_modules
    depends_on:
      deps:
        condition: service_completed_successfully
      queue:
        condition: service_healthy

  queue:
    image: redis:8.2-alpine
    volumes:
      - queue-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 3s
      retries: 30

volumes:
  node_modules: {}
  queue-data: {}

networks:
  hack-dev:
    external: true
```

## Monorepo with two apps and a shared package

Bun workspaces: `apps/web` and `apps/api` both import `packages/shared`. Bun writes a `node_modules` folder into each workspace package, so each has its own named volume, listed once in a YAML anchor.
The web app answers on `monorepo.hack.local`, the API on `api.monorepo.hack.local`. Add a volume to the anchor when you add a workspace package with dependencies.

<!-- include: examples/configs/monorepo/.hack/hack.config.json -->
```json
{
  "$schema": "https://schemas.hack.local/hack.config.schema.json",
  "name": "monorepo",
  "dev_host": "monorepo.hack.local"
}
```

<!-- include: examples/configs/monorepo/.hack/hack.env.default.yaml -->
```yaml
version: 1
environment: default
secretsprovider: project_key
values:
  global: {}
```

<!-- include: examples/configs/monorepo/.hack/docker-compose.yml -->
```yaml
name: monorepo
# Bun (like pnpm) writes a node_modules directory into each workspace package
# as well as the root. Each one gets a named volume, so nothing is written to
# the host checkout and every container sees the same Linux install.
x-workspace-volumes: &workspace-volumes
  - ..:/app
  - node_modules:/app/node_modules
  - web_node_modules:/app/apps/web/node_modules
  - api_node_modules:/app/apps/api/node_modules

services:
  deps:
    image: oven/bun:1.4.4-slim
    working_dir: /app
    command: ["bun", "install", "--frozen-lockfile"]
    volumes: *workspace-volumes

  web:
    image: oven/bun:1.4.4-slim
    working_dir: /app/apps/web
    command: ["bun", "run", "dev"]
    volumes: *workspace-volumes
    depends_on:
      deps:
        condition: service_completed_successfully
    labels:
      caddy: monorepo.hack.local
      caddy.reverse_proxy: "{{upstreams 3000}}"
      caddy.tls: internal
    networks:
      - hack-dev
      - default

  api:
    image: oven/bun:1.4.4-slim
    working_dir: /app/apps/api
    command: ["bun", "run", "dev"]
    volumes: *workspace-volumes
    depends_on:
      deps:
        condition: service_completed_successfully
    labels:
      caddy: api.monorepo.hack.local
      caddy.reverse_proxy: "{{upstreams 3000}}"
      caddy.tls: internal
    networks:
      - hack-dev
      - default

volumes:
  node_modules: {}
  web_node_modules: {}
  api_node_modules: {}

networks:
  hack-dev:
    external: true
```

## Python web app with Postgres

A Python HTTP server that queries Postgres with psycopg. The `deps` service builds a virtual environment in the `venv` volume, so packages are installed for Linux, not for your machine.
Change `requirements.txt` and run `hack restart`; pip installs only what changed.

<!-- include: examples/configs/python-postgres/.hack/hack.config.json -->
```json
{
  "$schema": "https://schemas.hack.local/hack.config.schema.json",
  "name": "python-postgres",
  "dev_host": "python-postgres.hack.local"
}
```

<!-- include: examples/configs/python-postgres/.hack/hack.env.default.yaml -->
```yaml
version: 1
environment: default
secretsprovider: project_key
values:
  web:
    DATABASE_URL: postgresql://app:app@db:5432/app
```

<!-- include: examples/configs/python-postgres/.hack/docker-compose.yml -->
```yaml
name: python-postgres
services:
  # Builds the virtual environment inside Linux, in a named volume. pip skips
  # packages that are already installed, so later starts are quick.
  deps:
    image: python:3.13-slim
    working_dir: /app
    command: ["sh", "-c", "python -m venv /venv && /venv/bin/pip install --disable-pip-version-check -r requirements.txt"]
    volumes:
      - ..:/app:ro
      - venv:/venv

  web:
    image: python:3.13-slim
    working_dir: /app
    command: ["/venv/bin/python", "app.py"]
    environment:
      PYTHONUNBUFFERED: "1"
    volumes:
      - ..:/app
      - venv:/venv
    depends_on:
      deps:
        condition: service_completed_successfully
      db:
        condition: service_healthy
    labels:
      caddy: python-postgres.hack.local
      caddy.reverse_proxy: "{{upstreams 8000}}"
      caddy.tls: internal
    networks:
      - hack-dev
      - default

  db:
    image: postgres:17.6-alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "app", "-d", "app"]
      interval: 2s
      timeout: 3s
      retries: 30

volumes:
  venv: {}
  db-data: {}

networks:
  hack-dev:
    external: true
```

## Static site with a build watcher

`bun build --watch` rebuilds the site into the `site` volume when a source file changes. Caddy serves that volume read-only.
Edit `src/index.html` and reload: the watcher rebuilds within a second or two. Nothing is written into your checkout. Right after `hack up`, the first build may not be done yet; reload if you get a 404.

<!-- include: examples/configs/static-site/.hack/hack.config.json -->
```json
{
  "$schema": "https://schemas.hack.local/hack.config.schema.json",
  "name": "static-site",
  "dev_host": "static-site.hack.local"
}
```

<!-- include: examples/configs/static-site/.hack/hack.env.default.yaml -->
```yaml
version: 1
environment: default
secretsprovider: project_key
values:
  global: {}
```

<!-- include: examples/configs/static-site/.hack/docker-compose.yml -->
```yaml
name: static-site
services:
  deps:
    image: oven/bun:1.4.4-slim
    working_dir: /app
    command: ["bun", "install", "--frozen-lockfile"]
    volumes:
      - ..:/app
      - node_modules:/app/node_modules

  # Rebuilds into the shared "site" volume whenever a source file changes.
  build:
    image: oven/bun:1.4.4-slim
    working_dir: /app
    command: ["bun", "run", "watch"]
    volumes:
      - ..:/app
      - node_modules:/app/node_modules
      - site:/site
    depends_on:
      deps:
        condition: service_completed_successfully

  # Serves the built files. It only reads the volume.
  web:
    image: caddy:2.10-alpine
    command: ["caddy", "file-server", "--root", "/site", "--listen", ":8080"]
    volumes:
      - site:/site:ro
    depends_on:
      - build
    labels:
      caddy: static-site.hack.local
      caddy.reverse_proxy: "{{upstreams 8080}}"
      caddy.tls: internal
    networks:
      - hack-dev
      - default

volumes:
  node_modules: {}
  site: {}

networks:
  hack-dev:
    external: true
```

## Dev server on your machine next to containerized services

The app runs on your machine as a lifecycle process; only Postgres and Redis run in containers. Their ports are published on `127.0.0.1`, and the `host` scope in the env file points the app at them.
Here the app runs on your machine, so install its packages on your machine (the `install` hook does). Keep that `node_modules` away from any container. Open `http://127.0.0.1:3000`.

<!-- include: examples/configs/host-dev-server/.hack/hack.config.json -->
```json
{
  "$schema": "https://schemas.hack.local/hack.config.schema.json",
  "name": "host-dev-server",
  "dev_host": "host-dev-server.hack.local",
  "lifecycle": {
    "up": {
      "before": [{ "name": "install", "command": "bun install --frozen-lockfile" }]
    },
    "processes": [{ "name": "dev", "command": "bun run dev" }]
  }
}
```

<!-- include: examples/configs/host-dev-server/.hack/hack.env.default.yaml -->
```yaml
version: 1
environment: default
secretsprovider: project_key
values:
  host:
    PORT: "3000"
    DATABASE_URL: postgres://app:app@127.0.0.1:54329/app
    REDIS_URL: redis://127.0.0.1:63799
```

<!-- include: examples/configs/host-dev-server/.hack/docker-compose.yml -->
```yaml
name: host-dev-server
# Only the backing services run in containers. Their ports are published on
# the loopback address so the dev server on the host can reach them.
services:
  db:
    image: postgres:17.6-alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
    ports:
      - "127.0.0.1:54329:5432"
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "app", "-d", "app"]
      interval: 2s
      timeout: 3s
      retries: 30

  cache:
    image: redis:8.2-alpine
    ports:
      - "127.0.0.1:63799:6379"

volumes:
  db-data: {}
```

## What was tested

Each example was started with `hack up -d` against Docker Engine on Linux (amd64), and
answered a request through `hack exec` or a published port. The `*.hack.local` routes
were not tested, because the global proxy was not installed. None of the examples was run
on macOS or on the native backend.

Related: [Recipes](overview.md), [Install dependencies in a deps service](deps-service.md),
[Common pitfalls](common-pitfalls.md).
