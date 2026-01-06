# CLI Reference

This reference mirrors the CLI spec in `src/cli/spec.ts`.
Run `hack help` or `hack help <command>` for interactive help.

## Conventions

- Commands that accept both `--path` and `--project` treat them as mutually exclusive.
- `--branch` runs branch-specific instances (compose project name + hostnames).
- `--profile` accepts comma-separated compose profiles.
- Options marked repeatable can be passed multiple times.

## Top-level commands

| Command | Summary | Group |
| --- | --- | --- |
| `hack global` | Manage machine-wide infra (DNS/TLS, Caddy proxy, logs) | Global |
| `hack projects` | Show all projects (registry + running docker compose) | Global |
| `hack status` | Show project status (shortcut for `hack projects --details`) | Global |
| `hack usage` | Show resource usage across running projects | Global |
| `hack init` | Initialize a repo (generate .hack/ with compose + config) | Project |
| `hack up` | Start project services (docker compose up) | Project |
| `hack down` | Stop project services (docker compose down) | Project |
| `hack restart` | Restart project services (down then up) | Project |
| `hack ps` | Show project status (docker compose ps) | Project |
| `hack logs` | Tail logs (compose by default; Loki for queries/history via --loki/--query) | Project |
| `hack run` | Run a one-off command in a service container (docker compose run --rm) | Project |
| `hack open` | Open a URL for the project (default: https://<project>.hack) | Project |
| `hack tui` | Open the project TUI (services + logs) | Project |
| `hack branch` | Manage branch aliases for a project | Project |
| `hack config` | Read/write hack.config.json values | Project |
| `hack gateway` | Manage gateway enablement | Extensions |
| `hack remote` | Remote workflow helpers | Extensions |
| `hack x` | Run extension commands | Extensions |
| `hack setup` | Install integrations for coding agents | Agents |
| `hack agent` | Agent utilities | Agents |
| `hack mcp` | Manage MCP server integrations for coding agents | Agents |
| `hack doctor` | Validate local setup (docker, networks, DNS, global infra, project config) | Diagnostics |
| `hack daemon` | Manage the local hack daemon (hackd) | Diagnostics |
| `hack log-pipe` | Read log lines from stdin and pretty-print them | Diagnostics |
| `hack help` | Show help for a command | Diagnostics |
| `hack version` | Print version | Diagnostics |
| `hack secrets` | Manage secrets in OS keychain (Bun.secrets) | Secrets |
| `hack the` | Fun commands | Fun |

## Global commands

### hack global

Usage: `hack global <subcommand>`

Subcommands:

| Subcommand | Summary |
| --- | --- |
| `install` | Bootstrap `~/.hack` and start Caddy + Grafana/Loki/Alloy |
| `up` | Start global infra containers |
| `down` | Stop global infra containers |
| `status` | Show status for global infra (containers + networks) |
| `logs` | Tail global infra logs (caddy|grafana|loki|alloy) |
| `ca` | Export Caddy Local CA cert (print path or PEM) |
| `cert` | Generate local TLS certs via mkcert (for non-Caddy services) |
| `trust` | Trust Caddy Local CA (macOS) so https://*.hack is trusted |
| `logs-reset` | Wipe Loki/Grafana volumes (fresh logs + dashboards) |

#### hack global logs

Usage: `hack global logs [service] [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `service` | string | no | Filter to one global service (caddy, grafana, loki, alloy) |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-f`, `--follow` | boolean | true | Follow logs (default) |
| `--no-follow` | boolean | false | Print logs and exit |
| `--tail <n>` | number | 200 | Tail last N log lines |
| `--pretty` | boolean | false | Pretty-print logs (best-effort JSON parsing + formatting) |

#### hack global ca

Usage: `hack global ca [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--print` | boolean | false | Print the CA cert PEM to stdout (instead of printing its path) |

#### hack global cert

Usage: `hack global cert <hosts...> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `hosts` | string[] | yes | One or more hostnames to generate certs for |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--install` | boolean | false | Run mkcert -install before generating certs |
| `--out <dir>` | string | `~/.hack/certs` | Directory for generated cert/key |

### hack projects

Usage: `hack projects [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--project <name>` | string | - | Filter to a registered project name |
| `--details` | boolean | false | Show per-project service tables |
| `--include-global` | boolean | false | Include global infra projects under `~/.hack` |
| `--all` | boolean | false | Include unregistered docker compose projects |
| `--json` | boolean | false | Output JSON (machine-readable) |

Subcommand:

#### hack projects prune

Usage: `hack projects prune [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--include-global` | boolean | false | Include global infra projects under `~/.hack` |

### hack status

Usage: `hack status [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--project <name>` | string | - | Filter to a registered project name |
| `--include-global` | boolean | false | Include global infra projects under `~/.hack` |
| `--all` | boolean | false | Include unregistered docker compose projects |
| `--json` | boolean | false | Output JSON (machine-readable) |

### hack usage

Usage: `hack usage [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--project <name>` | string | - | Filter to a registered project name |
| `--include-global` | boolean | false | Include global infra projects under `~/.hack` |
| `--json` | boolean | false | Output JSON (machine-readable) |

## Project commands

### hack init

Usage: `hack init [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--manual` | boolean | false | Skip discovery and define services manually (or generate a minimal compose in --auto) |
| `--auto` | boolean | false | Run non-interactive init with sensible defaults |
| `--name <slug>` | string | - | Project slug (default: repo name) |
| `--dev-host <host>` | string | - | DEV_HOST override |
| `--oauth` | boolean | false | Enable OAuth-safe alias host |
| `--oauth-tld <tld>` | string | `gy` | OAuth alias TLD override |
| `--no-discovery` | boolean | false | Skip discovery and generate a minimal compose |

### hack up

Usage: `hack up [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |
| `--branch <name>` | string | - | Run against a branch-specific instance |
| `-d`, `--detach` | boolean | false | Run in background (docker compose up -d) |
| `--profile <name[,name...]>` | string | - | Enable one or more compose profiles |

### hack down

Usage: `hack down [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |
| `--branch <name>` | string | - | Run against a branch-specific instance |
| `--profile <name[,name...]>` | string | - | Enable one or more compose profiles |

### hack restart

Usage: `hack restart [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |
| `--branch <name>` | string | - | Run against a branch-specific instance |
| `--profile <name[,name...]>` | string | - | Enable one or more compose profiles |

### hack ps

Usage: `hack ps [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |
| `--branch <name>` | string | - | Run against a branch-specific instance |
| `--profile <name[,name...]>` | string | - | Enable one or more compose profiles |
| `--json` | boolean | false | Output JSON (machine-readable) |

### hack logs

Usage: `hack logs [service] [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `service` | string | no | Filter logs by service (shortcut for `--services`) |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |
| `--branch <name>` | string | - | Run against a branch-specific instance |
| `-f`, `--follow` | boolean | true | Follow logs (default) |
| `--no-follow` | boolean | false | Print logs and exit |
| `--tail <n>` | number | 200 | Tail last N log lines |
| `--pretty` | boolean | false | Pretty-print logs (best-effort JSON parsing + formatting) |
| `--json` | boolean | false | Output JSON (NDJSON stream) |
| `--profile <name[,name...]>` | string | - | Enable one or more compose profiles |
| `--compose` | boolean | false | Read logs from docker compose (bypass Loki) |
| `--loki` | boolean | false | Force Loki backend (no compose fallback) |
| `--services <csv>` | string | - | Filter Loki logs by service(s), comma-separated |
| `--query <logql>` | string | - | Raw LogQL selector/query |
| `--since <time>` | string | - | Start time for Loki logs (RFC3339 or duration like 15m) |
| `--until <time>` | string | - | End time for Loki logs (RFC3339 or duration like 15m) |

Notes:

- `--compose` cannot be combined with `--loki`, `--services`, `--query`, `--since`, or `--until`.
- `--json` cannot be combined with `--pretty`.
- `--until` cannot be combined with `--follow`.

### hack run

Usage: `hack run <service> [-- <cmd...>] [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `service` | string | yes | Compose service name |
| `cmd` | string[] | no | Command to run (defaults to service entrypoint) |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |
| `--branch <name>` | string | - | Run against a branch-specific instance |
| `--workdir <path>` | string | - | Working directory inside the container (docker compose run -w) |
| `--profile <name[,name...]>` | string | - | Enable one or more compose profiles |

### hack open

Usage: `hack open [target] [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `target` | string | no | `www` (default), `logs`, a subdomain, or a full URL |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |
| `--branch <name>` | string | - | Run against a branch-specific instance |
| `--json` | boolean | false | Output JSON with `{ "url": "..." }` |

Notes:

- `hack open` with no target opens `https://<dev_host>.hack`.
- `hack open logs` opens Grafana (`https://logs.hack`).
- If `target` includes a scheme (e.g. `https://...`) it is used as-is.
- If `target` has no dots, it is treated as a subdomain of `dev_host`.

### hack tui

Usage: `hack tui [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |

### hack branch

Usage: `hack branch <subcommand>`

Subcommands:

| Subcommand | Summary |
| --- | --- |
| `add` | Register a branch alias for this project |
| `list` | List registered branch aliases |
| `remove` | Remove a branch alias |
| `open` | Open the branch host in a browser |

#### hack branch add

Usage: `hack branch add <name> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Branch name or alias |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |
| `--note <text>` | string | - | Optional note for the branch entry |

#### hack branch list

Usage: `hack branch list [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |

#### hack branch remove

Usage: `hack branch remove <name> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Branch name or alias |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |

#### hack branch open

Usage: `hack branch open <name> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Branch name or alias |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |

### hack config

Usage: `hack config <subcommand>`

Subcommands:

| Subcommand | Summary |
| --- | --- |
| `get` | Read a value from hack.config.json |
| `set` | Update a value in hack.config.json |

#### hack config get

Usage: `hack config get <key> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `key` | string | yes | Dot path (e.g. `logs.snapshot_backend`) |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |
| `--global` | boolean | false | Read global `~/.hack/hack.config.json` |

#### hack config set

Usage: `hack config set <key> <value> [options]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `key` | string | yes | Dot path (e.g. `logs.snapshot_backend`) |
| `value` | string | yes | JSON value or raw string (parsed as JSON when valid) |

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |
| `--global` | boolean | false | Write global `~/.hack/hack.config.json` |

## Extension commands

### hack gateway

Usage: `hack gateway <subcommand>`

Subcommands:

| Subcommand | Summary |
| --- | --- |
| `enable` | Enable the gateway and start hackd |
| `setup` | Guided gateway setup (enable + token) |
| `disable` | Disable the gateway (does not stop hackd) |

#### hack gateway enable

Usage: `hack gateway enable [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |

#### hack gateway setup

Usage: `hack gateway setup [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |
| `--qr` | boolean | true | Force QR output after setup (default) |
| `--no-qr` | boolean | false | Skip QR output after setup |
| `--yes` | boolean | false | Skip confirmation prompts when printing QR payloads |

#### hack gateway disable

Usage: `hack gateway disable [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |

### hack remote

Usage: `hack remote <subcommand>`

If you run `hack remote` with no subcommand, it prints status and offers to run setup.

Subcommands:

| Subcommand | Summary |
| --- | --- |
| `setup` | Run the guided gateway setup |
| `status` | Show remote/gateway status |
| `monitor` | Open a remote status TUI |
| `qr` | Print a QR payload for remote access |

#### hack remote setup

Usage: `hack remote setup [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |
| `--qr` | boolean | true | Force QR output after setup (default) |
| `--no-qr` | boolean | false | Skip QR output after setup |
| `--yes` | boolean | false | Skip confirmation prompts when printing QR payloads |

#### hack remote status

Usage: `hack remote status [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |

#### hack remote monitor

Usage: `hack remote monitor [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |

#### hack remote qr

Usage: `hack remote qr [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--project <name>` | string | - | Target a registered project by name |
| `--gateway-url <url>` | string | - | Gateway base URL to embed in QR output |
| `--token <token>` | string | - | Gateway token to embed in QR output |
| `--ssh` | boolean | false | Emit an SSH QR payload instead of a gateway payload |
| `--ssh-host <host>` | string | - | SSH host for QR payload (required with --ssh) |
| `--ssh-user <user>` | string | - | SSH user for QR payload (defaults to `$USER` when set) |
| `--ssh-port <port>` | number | - | SSH port for QR payload (omitted defaults to 22) |
| `--yes` | boolean | false | Skip confirmation before printing sensitive QR payloads |

### hack x

Usage: `hack x <namespace> <command> [args...]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `args` | string[] | no | Extension command args (passed through) |

Notes:

- `hack x list` lists available extensions.
- `hack x <namespace> help` lists commands for a namespace.

## Agent commands

### hack setup

Usage: `hack setup <subcommand>`

Subcommands:

| Subcommand | Summary |
| --- | --- |
| `cursor` | Install Cursor rules for hack CLI usage |
| `claude` | Install Claude Code hooks for hack CLI usage |
| `codex` | Install Codex skill for hack CLI usage |
| `agents` | Install AGENTS.md / CLAUDE.md snippets |
| `mcp` | Install MCP configs for hack CLI usage (no-shell only) |

#### hack setup cursor

Usage: `hack setup cursor [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--global` | boolean | false | Use global (user) scope instead of project scope |
| `--check` | boolean | false | Check whether integration is installed |
| `--remove` | boolean | false | Remove integration files/config |

#### hack setup claude

Usage: `hack setup claude [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--global` | boolean | false | Use global (user) scope instead of project scope |
| `--check` | boolean | false | Check whether integration is installed |
| `--remove` | boolean | false | Remove integration files/config |

#### hack setup codex

Usage: `hack setup codex [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--global` | boolean | false | Use global (user) scope instead of project scope |
| `--check` | boolean | false | Check whether integration is installed |
| `--remove` | boolean | false | Remove integration files/config |

#### hack setup agents

Usage: `hack setup agents [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--all` | boolean | false | Target all supported docs |
| `--agents-md` | boolean | false | Target AGENTS.md |
| `--claude-md` | boolean | false | Target CLAUDE.md |
| `--check` | boolean | false | Check whether integration is installed |
| `--remove` | boolean | false | Remove integration files/config |

#### hack setup mcp

Usage: `hack setup mcp [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--global` | boolean | false | Use global (user) scope instead of project scope |
| `--all` | boolean | false | Target all supported clients |
| `--cursor` | boolean | false | Target Cursor integration |
| `--claude` | boolean | false | Target Claude integration |
| `--codex` | boolean | false | Target Codex integration |
| `--check` | boolean | false | Check whether integration is installed |
| `--remove` | boolean | false | Remove integration files/config |

### hack agent

Usage: `hack agent <subcommand>`

Subcommands:

| Subcommand | Summary |
| --- | --- |
| `prime` | Print agent primer text |
| `patterns` | Print agent init patterns guide |
| `init` | Print agent init prompt |

#### hack agent init

Usage: `hack agent init [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `-c`, `--client <cursor|claude|codex|print>` | string | - | Open init prompt in an agent client (or print) |

### hack mcp

Usage: `hack mcp <subcommand>`

Subcommands:

| Subcommand | Summary |
| --- | --- |
| `serve` | Run the MCP server over stdio |
| `install` | Install MCP config for supported clients |
| `print` | Print MCP config snippets |

#### hack mcp install

Usage: `hack mcp install [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--scope <user|project>` | string | `user` | Write MCP config to user or project scope |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--all` | boolean | false | Target all supported clients |
| `--cursor` | boolean | false | Target Cursor MCP config |
| `--claude` | boolean | false | Target Claude CLI MCP config |
| `--codex` | boolean | false | Target Codex MCP config |
| `--docs` | boolean | false | Update AGENTS.md and CLAUDE.md with hack usage |
| `--agents-md` | boolean | false | Update AGENTS.md with hack usage |
| `--claude-md` | boolean | false | Update CLAUDE.md with hack usage |

#### hack mcp print

Usage: `hack mcp print [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--scope <user|project>` | string | `user` | Print MCP config for user or project scope |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--all` | boolean | false | Target all supported clients |
| `--cursor` | boolean | false | Target Cursor MCP config |
| `--claude` | boolean | false | Target Claude CLI MCP config |
| `--codex` | boolean | false | Target Codex MCP config |

## Diagnostics commands

### hack doctor

Usage: `hack doctor [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `-p`, `--path <dir>` | string | - | Run against a repo path (overrides cwd search) |
| `--fix` | boolean | false | Attempt safe auto-remediations (network + CoreDNS + CA) |

### hack daemon

Usage: `hack daemon <subcommand>`

Subcommands:

| Subcommand | Summary |
| --- | --- |
| `start` | Start hackd (local daemon) |
| `stop` | Stop hackd |
| `status` | Show hackd status |
| `metrics` | Show hackd metrics |
| `logs` | Show hackd logs |

#### hack daemon start

Usage: `hack daemon start [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--foreground` | boolean | false | Run hackd in the foreground (debug) |

#### hack daemon status

Usage: `hack daemon status [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--json` | boolean | false | Output JSON (machine-readable) |

#### hack daemon logs

Usage: `hack daemon logs [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--tail <n>` | number | 200 | Tail last N log lines |

### hack log-pipe

Usage: `hack log-pipe [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--format <auto|docker-compose|plain>` | string | `auto` | How to parse incoming lines from stdin |
| `--stream <stdout|stderr>` | string | `stdout` | Treat stdin as stdout or stderr |

### hack help

Usage: `hack help [path...]`

Arguments:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string[] | no | Command path to show help for (e.g. `global logs`) |

### hack version

Usage: `hack version`

## Secrets

### hack secrets

Usage: `hack secrets <subcommand>`

Subcommands:

| Subcommand | Summary |
| --- | --- |
| `set` | Store a secret |
| `get` | Print a secret (exit 1 if missing) |
| `delete` | Delete a stored secret |

Options (all subcommands):

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--service <service>` | string | `hack-cli` | Override Bun.secrets service name |

Arguments (set/get/delete):

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | no | Secret name (prompted if omitted) |

## Fun

### hack the planet

Usage: `hack the planet [options]`

Options:

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `--variant <cut|mash|cycle|random>` | string | `cycle` | Animation variant |
| `--loop` | boolean | true | Loop until Ctrl+C |
