# Architecture

![Architecture Diagram](./architecture-diagram.svg)

## Why this exists (plain English)

Running multiple local projects at the same time is messy when everything wants the same ports and
"localhost". This CLI gives each repo its own isolated network and stable HTTPS hostnames so you can:

- run many apps concurrently without port juggling
- keep service defaults (Postgres on 5432, Redis on 6379) inside each project
- access every app via predictable `https://<project>.hack`
- get fast local logs plus searchable history

## System overview
 
`hack` is a Bun CLI that writes per-project Compose files under `.hack/` and manages a machine-wide
proxy, DNS helpers, and logging stack under `~/.hack/`.

- **Caddy** (docker-proxy) routes `*.hack` based on container labels.
- **CoreDNS** resolves `*.hack` inside containers to the Caddy IP, with `extra_hosts` mappings for resolver compatibility.
- **Alloy + Loki + Grafana** capture logs and provide history.
- **Schemas** are served by Caddy at `https://schemas.hack`.
- **hackd (optional daemon)** caches Docker state for fast `hack projects --json` / `hack ps --json`.

```mermaid
graph LR
  CLI["hack CLI (Bun)"]
  Browser["Browser"]

  subgraph Host["Developer machine"]
  subgraph Global["Global infra (~/.hack)"]
    Caddy["Caddy docker-proxy"]
    CoreDNS["CoreDNS"]
    Loki["Loki"]
    Grafana["Grafana"]
    Alloy["Alloy (Docker logs)"]
  end

  subgraph Project["Project repo (.hack)"]
    Compose["docker-compose.yml"]
    Services["Service containers"]
  end

  Hackd["hackd (optional daemon)"]
  end

  CLI -->|"hack global install/up"| Global
  CLI -->|"hack init/up"| Compose
  Compose -->|"docker compose"| Services
  CLI -->|"projects/ps --json"| Hackd
  Hackd -->|"docker events + ps"| Services

  Services -->|"Docker labels"| Caddy
  Services -->|"container logs"| Alloy
  Alloy --> Loki --> Grafana

  CoreDNS -->|"*.hack → Caddy IP"| Services
  Caddy -->|"https://*.hack"| Browser
  Grafana -->|"https://logs.hack"| Browser
  Caddy -->|"https://schemas.hack"| Browser
```

## Global vs project scope

- Global scope (`~/.hack`)
  - Caddy proxy on 80/443 (routes via Docker labels)
  - CoreDNS for container DNS (`*.hack` → Caddy)
  - macOS DNS helper: dnsmasq + `/etc/resolver` for `*.hack` → Caddy container IP
  - Logging stack (Alloy → Loki → Grafana)
  - Global config: `hack.config.json` (control plane defaults + extension settings)
    - Gateway bind/port/allowWrites
  - Schemas hosted under `https://schemas.hack`
  - Networks: `hack-dev` (ingress) and `hack-logging`

- Project scope (`.hack`)
  - `docker-compose.yml` defines services + Caddy labels
  - `hack.config.json` stores project name, dev host, log preferences, OAuth alias
  - `controlPlane.gateway.enabled` marks the project as gateway-capable
  - Optional overrides:
    - `.internal/compose.override.yml` (generated internal DNS/TLS injection)
    - `.internal/extra-hosts.json` (user-managed extra_hosts merged into the override)
    - `.branch/compose.<branch>.override.yml` (branch builds)


## Internal DNS + TLS (containers)

When `internal.dns` / `internal.tls` are enabled, `hack up` writes a Compose override that:

- sets each service’s DNS to the CoreDNS container
- mounts Caddy’s local CA cert into each service
- sets common SSL env vars (Node, curl, git, requests)
- injects `extra_hosts` mappings for `*.hack` → current Caddy IP (for runtimes that ignore custom DNS)
- merges any repo-local `.hack/.internal/extra-hosts.json` entries (for host tunnels / dynamic domains)

This lets containers use the same `https://*.hack` hostnames as the host machine. If Caddy’s IP changes,
`hack status`, `hack doctor`, and the TUI will warn; `hack restart` refreshes the mapping.

```mermaid
graph LR
  Service["Project container"] -->|"DNS query *.hack"| CoreDNS["CoreDNS (hack-dev)"]
  CoreDNS -->|"A record = Caddy IP"| Service
  Service -->|"HTTPS request"| Caddy["Caddy docker-proxy"]
  Caddy -->|"Routes by labels"| Upstream["Service upstream"]
```
 
## Lifecycle (init → up → logs)

```mermaid
sequenceDiagram
  participant User
  participant CLI as hack
  participant Docker
  participant Caddy
  participant Loki

  User->>CLI: hack init
  CLI->>Docker: create .hack/docker-compose.yml
  CLI-->>User: wrote .hack/ files

  User->>CLI: hack up
  CLI->>Docker: docker compose up
  Docker->>Caddy: read labels for routing
  Docker->>Loki: logs via Alloy

  User->>CLI: hack logs
  alt compose backend
    CLI->>Docker: docker compose logs
  else loki backend
    CLI->>Loki: query/tail LogQL
  end
```

## Logging pipeline

`hack logs` supports two backends:

- **compose**: fast, direct `docker compose logs`
- **loki**: searchable history + LogQL filters

NDJSON streaming (`hack logs --json`) emits `start`, `log`, and `end` events for MCP/TUI consumers.

Retention:
- Loki retention is set in the global Loki config (`~/.hack/logging/loki.yaml`), default `168h` in the template.
- Per-project overrides live in `hack.config.json` under `logs.retention_period` and apply when `hack down` prunes logs.

```mermaid
graph LR
  Containers["Compose containers"] -->|"stdout/stderr"| Alloy
  Alloy -->|"push"| Loki
  Loki -->|"query"| CLI["hack logs --loki"]
  CLI -->|"NDJSON/pretty"| Terminal
  Loki -->|"Explore"| Grafana
```

Note: the daemon does not proxy logs yet; `hack logs` still talks directly to Docker Compose or Loki.

## Daemon (hackd)

`hackd` is an optional local daemon that watches Docker events and maintains a cached view of running
containers. It serves a small local API over a Unix socket at `~/.hack/daemon/hackd.sock` and powers:

- `hack projects --json`
- `hack ps --json`
- streaming consumers (TUI/MCP)

If the daemon is not running (or version-mismatched), the CLI falls back to direct Docker calls.

Runtime health:
- The daemon treats the container runtime as ephemeral; it fingerprints the engine (socket + engine id)
  and detects resets.
- When the runtime is unavailable, cached state is retained but marked stale; API responses include
  `runtime_*` metadata and project `status` becomes `unknown`.

Why optional:
- The CLI must keep working with zero background processes.
- Not all users need cached JSON (especially if they only use interactive commands).
- It stays off in minimal or constrained environments, but is available when you want faster status.

```mermaid
graph LR
  CLI["hack CLI (JSON)"] -->|GET /v1/projects| Hackd["hackd"]
  CLI -->|GET /v1/ps| Hackd
  Hackd -->|"docker events"| Docker["Docker Engine"]
  Hackd -->|"docker ps"| Docker
  Hackd -->|"cached state"| Cache["In-memory cache"]
```

## Control plane + extensions

The control plane keeps the core CLI minimal while adding features as extensions. `hackd` loads
extension manifests and exposes their APIs; the CLI dispatches extension commands via `hack x`.

- **Gateway**: optional HTTP/WS access to `hackd` (localhost by default).
- **Supervisor**: job execution + streaming for agents.

```mermaid
graph LR
  CLI["hack CLI"] --> Hackd["hackd"]
  Hackd --> ExtMgr["ExtensionManager"]
  ExtMgr --> Gateway["Gateway"]
  ExtMgr --> Supervisor["Supervisor"]
  ExtMgr --> Tickets["Tickets"]
  Remote["Remote client"] -->|HTTP/WS| Gateway
  Gateway --> Hackd
```

### Gateway API + remote workflows

The gateway exposes:
- `GET /v1/projects` with `project_id` for remote workflow routing
- job execution + streaming (`/control-plane/projects/:id/jobs`)
- PTY-backed shells (`/control-plane/projects/:id/shells`, WS stream)

Current gateway routing:
- One gateway instance is active per machine (global config).
- Projects opt in with `controlPlane.gateway.enabled` in their project config.
- Remote clients route by `project_id` in the API paths.

For full usage, security posture, and end-to-end examples, see `gateway-api.md`.

## Branch builds

`--branch <name>` generates a per-branch Compose override that:

- prefixes hostnames (e.g. `api.myapp.hack` → `api.<branch>.myapp.hack`)
- prefixes the Compose project name

This enables parallel worktrees without port or hostname collisions.

## Files and directories

- `~/.hack/`
  - `daemon/hackd.sock`
  - `daemon/hackd.pid`
  - `daemon/hackd.log`
  - `caddy/docker-compose.yml`
  - `caddy/Corefile` (CoreDNS config)
  - `logging/docker-compose.yml`
  - `logging/alloy.alloy`
  - `logging/loki.yaml`
  - `logging/grafana/...`
  - `schemas/hack.config.schema.json`
  - `schemas/hack.branches.schema.json`
  - `certs/` (mkcert output for non-Caddy services)
  - `projects.json` (best-effort registry)

- `<repo>/.hack/`
  - `docker-compose.yml`
  - `hack.config.json`
  - `hack.branches.json` (optional)
  - `.internal/compose.override.yml`
  - `.branch/compose.<branch>.override.yml`

## Key design choices

- Docker Compose is the execution substrate for predictability and portability.
- Caddy routes by container label so there is no per-repo reverse proxy config.
- CoreDNS gives containers the same `*.hack` namespace as the host.
- Logs default to `docker compose logs` for speed; Loki is used for history and filtering.
- The optional daemon keeps CLI JSON queries fast without making it a hard dependency.
- Config lives alongside each repo in `.hack/` to keep repos isolated and portable.
- Schemas are generated from templates and served locally for editor validation.
