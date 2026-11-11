# Run database migrations

These Compose recipes use commands and configuration available in `v5.0.0-next.13`.
The linked example projects come from the recipe source revision below.

Use this to apply schema migrations: once by hand, on every start, and in each
branch instance. Hack does not ship a migration tool. Use your framework's tool
(Prisma, Drizzle, Alembic, Rails, Flyway and so on) inside a container.

The complete project is in
[`examples/recipes/migrations`](https://github.com/hack-dance/hack/blob/943503b56081f9934fa98c4b80b7eea2a1a41822/examples/recipes/migrations). Its
`scripts/migrate.sh` is a small stand-in tool: it applies each
`migrations/*.sql` file once and records it in `schema_migrations`.

## On every start (recommended)

Add a one-shot `migrate` service. Compose runs it after the database is
healthy, and starts the app only when it exits with status 0.

<!-- include: examples/recipes/migrations/.hack/docker-compose.yml -->
```yaml
name: migrations
services:
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

  # Runs once per start, after the database is healthy, then exits.
  migrate:
    image: postgres:17.6-alpine
    command: ["sh", "/scripts/migrate.sh"]
    volumes:
      - ../migrations:/migrations:ro
      - ../scripts:/scripts:ro
    depends_on:
      db:
        condition: service_healthy

  # Starts only after the migrations succeeded.
  app:
    image: postgres:17.6-alpine
    command: ["sleep", "infinity"]
    depends_on:
      migrate:
        condition: service_completed_successfully

volumes:
  db-data: {}
```

The migration tool gets its connection settings from managed env, scoped to
the `migrate` service:

<!-- include: examples/recipes/migrations/.hack/hack.env.default.yaml -->
```yaml
version: 1
environment: default
secretsprovider: project_key
values:
  migrate:
    PGHOST: db
    PGUSER: app
    PGPASSWORD: app
    PGDATABASE: app
  app:
    DATABASE_URL: postgres://app:app@db:5432/app
```

The project config needs nothing for this pattern:

<!-- include: examples/recipes/migrations/.hack/hack.config.json -->
```json
{
  "$schema": "https://schemas.hack.local/hack.config.schema.json",
  "name": "migrations",
  "dev_host": "migrations.hack.local"
}
```

```sh
hack up -d
hack logs migrate --no-follow   # applying 001_create_notes ... migrations up to date
```

Hack treats a service that another service waits for with
`service_completed_successfully` as a one-shot step, so its exit does not count
as a failed start. If a migration fails, `hack up` fails and the app stays in
`Created`. Fix the migration, then run `hack up -d` again.

With your own tool, change the image and command of `migrate`. For example, a
Node project might use its app image with `command: ["npx", "prisma", "migrate",
"deploy"]` and the [deps service](deps-service.md) volume. We ran only the
stand-in tool.

## Once, by hand

`hack run` starts a fresh container of a service with the same env and network,
runs a command, and removes the container:

```sh
hack run migrate                     # the service's own command
hack run migrate psql -c '\dt'       # your own command; psql reads the PG* values
hack run migrate sh -c 'echo "$PGHOST"'
```

Put Hack options, such as `--env`, before the service name. Wrap a command that
uses a variable in `sh -c '...'` with single quotes, so the variable expands in
the container and not in your shell. Prefer tools that read credentials from
the environment (like `psql` with `PG*` variables) over passing a connection
string with a password as an argument: arguments are visible in process
listings.

## From a hook, without a migrate service

If you do not want a one-shot service, run your tool from an `up.after` hook.
The hook runs on your machine after the containers start, and `hack run` inside
it works:

```json
{
  "lifecycle": {
    "up": {
      "after": [{ "name": "migrate", "command": "hack run app npm run db:migrate" }]
    }
  }
}
```

The app starts before the migrations run, so it must cope with an older
schema for a moment. A failing hook makes `hack up` fail, but leaves the
containers running.

The `hack run` inside the hook does not inherit `--env` or `--branch` from
`hack up`. It uses the default overlay and this checkout's instance. After
`hack up -d --env qa`, the hook's `hack run` gets the base values, not `qa`.
A linked worktree still gets its own branch instance automatically. If you
start with `--env` or `--branch`, prefer the one-shot service.

We ran this hook with the stand-in tool, and checked the `--env` behavior
with a hook that prints a value.

## In each branch instance

Each branch instance has its own Compose project, so it has its own database
volume and its own migration history. A linked git worktree uses a branch
instance automatically:

```sh
git worktree add ../app-feature-tags -b feature-tags
cd ../app-feature-tags
# add migrations/003_add_tags.sql
hack up -d       # prints: Linked worktree detected → using branch instance "feature-tags" ...
```

The worktree's database gets migrations 001 to 003. The primary checkout's
database keeps 001 and 002. You can also start a branch instance from the same
checkout with `hack up -d --branch <name>`.

To start a branch database from a copy of another, dump and restore it with
your database's tools (for example `pg_dump` piped to `psql` through
`hack exec`). Hack does not copy volumes between instances.

## Notes

- Make every migration safe to run twice, or track applied versions as the
  stand-in does. The service runs on every start.
- Seed data is a separate, explicit step. Run it with `hack run` when you need
  it, not on every start.
- Against a remote database, read the guard rails in
  [Remote database](remote-database.md) first.

Related: [Environments](environments.md), [Cleanup](cleanup.md).
