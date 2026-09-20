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
- New projects default to `<project>.hack.local`. Pass `--dev-host` to choose a custom
  hostname. Existing project hosts are not migrated by this default change.
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
  - HTTP services via `https://*.hack.local` hostnames (matching your Caddy labels)
  - non-HTTP services via Compose service hostnames (e.g. `db`, `redis`)

## Local domain compatibility

For new projects, `--oauth` adds `<project>.hack.gy` alongside the primary
`<project>.hack.local` route; it does not create `<project>.hack.local.gy`.
An explicit OAuth TLD replaces `gy`. Custom development hosts keep their configured
name; Hack does not invent an OAuth alias for a domain outside its managed namespaces.
Service subdomains and branch names are inserted before the project name on both routes.

Existing `.hack` and `.hack.gy` configurations retain their names. Re-running init
with an agent handoff also preserves and describes the existing host. Do not rename
an existing project's config without updating its Compose routes and consumers.
For a project with literal Compose routes, preview a scoped migration first:

```bash
hack doctor --path /absolute/path/to/repo --domain-migration preview --json
hack doctor --path /absolute/path/to/repo --domain-migration apply --json
hack doctor --path /absolute/path/to/repo --domain-migration rollback --json
```

`apply` is explicit authorization to update only `hack.config.json` and
`docker-compose.yml`. It changes the primary host and adds matching `.hack.local`
routes while retaining the old routes, including service and branch prefixes.
It does not run the other Doctor repairs, restart services, change host DNS/trust,
or rewrite OAuth callback registrations, environment variables or application config.
Verify those consumers and DNS before separately restarting the intended instance.

Migration refuses custom primary domains, dynamic routes, ambiguous Compose
indirection and conflicting literal routes in this project or other registered
projects/worktrees. The registered-configuration check is a preflight, not an
exclusive claim on live Caddy routes or discovery of unregistered projects.
Those cases require manual route review; do not work around a refusal by deleting
registry entries. Preview prints host changes only, not configuration contents.

The private `.hack/.internal/domain-migration` journal stores the exact original
file bytes and permissions. Keep it local: Compose/config files may contain secrets.
Its own ignore rule excludes backups and staged copies even in older projects
without a parent `.internal` ignore rule. Do not force-add this journal to Git.
Rollback restores both originals only when their current contents still match the
recorded pre- or post-migration state; independent edits cause refusal before restore.
Keep the journal until rollback is no longer needed. A second migration cannot
overwrite an existing journal. Linked/symlinked target paths and non-regular files
are rejected; use a canonical project path.
The two file replacements are journaled, not a single atomic operation. Rollback
can recover a recorded partial update after proving the lock owner is dead; it
never takes a lock from a live or unknown owner. An interrupted lock publication
or recovery guard requires manual review. Keep editors and other config writers
idle during apply/rollback; they do not participate in the migration lock.

The explicit global setup configures the new DNS suffix alongside the legacy ones.
Use Doctor to check for missing resolver configuration before starting a new project;
review the proposed global setup changes rather than removing existing resolver files.
`.local` has special multicast DNS semantics ([RFC 6762, section 3](https://www.rfc-editor.org/rfc/rfc6762.html#section-3)),
so generated configuration alone does not establish host or browser reachability.
Live DNS, route and TLS qualification remains a prerelease acceptance gate.

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
- **Native file watching**: generated services use the container runtime's native
  file notifications. Hack does not force Chokidar or Watchpack polling because
  polling a bind-mounted monorepo can consume substantial CPU and disk I/O. Add
  `CHOKIDAR_USEPOLLING` or `WATCHPACK_POLLING` to an individual service only when
  its runtime has a demonstrated file-notification problem.
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

For command lookup and extension docs, use [Reference](../reference.md).
