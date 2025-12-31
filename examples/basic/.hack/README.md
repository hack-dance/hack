# hack local dev

This repo is configured for the `hack` local-dev platform.

## Networks

- `hack-dev`: shared ingress network (Caddy routes only services attached to this network).
- `default`: per-project network created by Docker Compose.

Rules:
- Only attach **HTTP services** you want routable to `hack-dev`.
- Do **not** attach Postgres/Redis to `hack-dev`.
- Avoid `container_name` (breaks multi-repo).

## Service-to-service connections (important)

When services run inside Docker containers, `127.0.0.1` / `localhost` refers to **that container**, not the
other services in the compose file.

So inside containers, use Docker Compose DNS names:

- Postgres: host `db`, port `5432`
- Redis: host `redis`, port `6379`

Example env for an app container:

```yaml
environment:
  DATABASE_URL: postgres://postgres:postgres@db:5432/mydb
  REDIS_URL: redis://redis:6379
```

If you need to run tools from your host machine, prefer `docker compose exec` to avoid host port conflicts:

```bash
docker compose -f .hack/docker-compose.yml exec db psql -U postgres -d mydb
docker compose -f .hack/docker-compose.yml exec redis redis-cli
```

## Hostnames

- Primary app: https://example.hack
- Subdomains: https://<sub>.example.hack (e.g. api.example.hack)

OAuth note:
- OAuth-safe alias (public suffix): https://example.hack.gy
- OAuth-safe subdomains: https://<sub>.example.hack.gy (e.g. api.example.hack.gy)

## Branch instances

Use `--branch` to run isolated instances of the same project:

- `hack up --branch feature-x`
- Hostnames become `feature-x.example.hack` and `api.feature-x.example.hack`.

## Logs (Grafana + Loki)

- Open Grafana: https://logs.hack
- Default credentials: `admin` / `admin`

In **Explore**, try queries like:

- `{project="<compose-project>"}`
- `{project="<compose-project>", service="api"}`

Tip: `project`/`service` labels come from Docker Compose labels (via Alloy).

## Adding a routable HTTP service

Add a service under `services:` in `.hack/docker-compose.yml` and include:

```yaml
labels:
  caddy: api.example.hack
  caddy.reverse_proxy: "{{upstreams 4000}}"
  caddy.tls: internal
networks:
  - hack-dev
  - default
```

## Adding Postgres / Redis (optional)

Postgres (default network only):

```yaml
db:
  image: postgres:17
  environment:
    POSTGRES_USER: postgres
    POSTGRES_PASSWORD: postgres
    POSTGRES_DB: mydb
  volumes:
    - postgres-data:/var/lib/postgresql/data
  networks:
    - default
```

Redis (default network only):

```yaml
redis:
  image: bitnami/redis:latest
  environment:
    ALLOW_EMPTY_PASSWORD: "yes"
  volumes:
    - redis-data:/bitnami/redis/data
  networks:
    - default
```

Add volumes at the bottom:

```yaml
volumes:
  postgres-data:
  redis-data:
```

## DB schema tooling (Prisma / Drizzle)

For DB tooling in a monorepo, the cleanest approach is to run commands inside the project network so you
don’t need to publish DB ports to your host.

Option A (recommended): create an ops-only service in `.hack/docker-compose.yml`:

```yaml
db-ops:
  image: imbios/bun-node:latest
  working_dir: /app/packages/db # adjust to your db package
  volumes:
    - ..:/app
  environment:
    DATABASE_URL: postgres://postgres:postgres@db:5432/mydb
  depends_on:
    - db
  networks:
    - default
  profiles: ["ops"]
  # Prisma:
  # command: bunx prisma migrate deploy
  # Drizzle:
  # command: bunx drizzle-kit push
  command: bun run db:push
```

Then run it on demand:

```bash
docker compose -f .hack/docker-compose.yml --profile ops run --rm db-ops
```

Option B: run one-off commands without adding a new service using `hack run`:

```bash
hack run --workdir /app/packages/db email-sync -- bunx prisma generate
hack run --workdir /app/packages/db email-sync -- bunx prisma migrate dev
hack run --workdir /app/packages/db email-sync -- bunx drizzle-kit push
```

If your ops service is behind a compose profile, enable it:

```bash
hack run --profile ops --workdir /app/packages/db db-ops -- bun run db:push
```

### If you see: “Host version … does not match binary version …”

That error is from **esbuild** (often triggered by Drizzle tooling compiling `*.ts` config).
It usually means you’re running container commands against a partially mismatched install (common if you try
to share host `node_modules` into a Linux container).

Best fix: keep host deps on host, and give containers their own deps via a volume:

```yaml
services:
  www:
    volumes:
      - ..:/app
      - node_modules:/app/node_modules

volumes:
  node_modules:
```

Then install once inside the container volume:

```bash
hack run --workdir /app www -- bun install
```
