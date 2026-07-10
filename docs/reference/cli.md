# hack CLI reference

<!-- GENERATED FILE — do not edit. Regenerate with: bun run docs:cli-reference -->

hack — Local development without the port-collision tax

Run `hack help <command>` for the same content in the terminal. Global options: `--no-interactive` (or `HACK_NO_INTERACTIVE=1`); commands with `--json` emit a `{ok, data, error}` envelope on stdout.

## Project

## `hack project`

Inspect or manage project metadata

### Usage

```bash
hack project <subcommand> [options]
```

### Subcommands

| Command | Summary |
| --- | --- |
| `hack project owner` | Inspect project ownership |

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack project owner`

Inspect project ownership

### Usage

```bash
hack project owner <subcommand> [options]
```

### Subcommands

| Command | Summary |
| --- | --- |
| `hack project owner show` | Show the local ownership metadata for the current project |

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack init`

Initialize a repo (generate .hack/ with compose + config)

### Usage

```bash
hack init [options]
```

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--manual` | Skip discovery and define services manually (or generate a minimal compose in --auto) |
| `--auto` | Run non-interactive init with sensible defaults |
| `--name <slug>` | Project slug (default: repo name) |
| `--dev-host <host>` | DEV_HOST override |
| `--oauth` | Enable OAuth-safe alias host |
| `--oauth-tld <tld>` | OAuth alias TLD override (default: gy) |
| `--no-discovery` | Skip discovery and generate a minimal compose |
| `--with <claude|codex|both>` | After init, hand the onboarding prompt to an agent CLI (prints the prompt when the CLI is missing or the run is non-interactive) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack up [services...]`

Start project services (docker compose up)

### Usage

```bash
hack up [services...] [options]
```

### Arguments

| Arg | Description |
| --- | --- |
| `services` |  |

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--env <name|base>` | Apply an optional env overlay by name (use 'base' to bypass overlays) |
| `--branch <name>` | Run against a branch-specific instance (compose name + hostnames) |
| `--detach, -d` | Run in background (docker compose up -d) |
| `--profile <name[,name...]>` | Enable one or more compose profiles (comma-separated) |
| `--target <auto|local|remote>` | Execution target routing (auto routes to remote when project execution mode requires it) |
| `--json` | Output JSON (machine-readable) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack down`

Stop project services (docker compose down)

### Usage

```bash
hack down [options]
```

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--env <name|base>` | Apply an optional env overlay by name (use 'base' to bypass overlays) |
| `--branch <name>` | Run against a branch-specific instance (compose name + hostnames) |
| `--profile <name[,name...]>` | Enable one or more compose profiles (comma-separated) |
| `--target <auto|local|remote>` | Execution target routing (auto routes to remote when project execution mode requires it) |
| `--json` | Output JSON (machine-readable) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack restart [services...]`

Restart the project or selected services

### Usage

```bash
hack restart [services...] [options]
```

### Arguments

| Arg | Description |
| --- | --- |
| `services` |  |

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--env <name|base>` | Apply an optional env overlay by name (use 'base' to bypass overlays) |
| `--branch <name>` | Run against a branch-specific instance (compose name + hostnames) |
| `--profile <name[,name...]>` | Enable one or more compose profiles (comma-separated) |
| `--target <auto|local|remote>` | Execution target routing (auto routes to remote when project execution mode requires it) |
| `--json` | Output JSON (machine-readable) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack ps`

Show project status (docker compose ps)

### Usage

```bash
hack ps [options]
```

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--branch <name>` | Run against a branch-specific instance (compose name + hostnames) |
| `--profile <name[,name...]>` | Enable one or more compose profiles (comma-separated) |
| `--json` | Output JSON (machine-readable) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack tui`

Open the project TUI (services + logs)

### Usage

```bash
hack tui [options]
```

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack run <service> [cmd...]`

Run a one-off command in a service container (docker compose run --rm)

### Usage

```bash
hack run <service> [cmd...] [options]
```

### Arguments

| Arg | Description |
| --- | --- |
| `service` |  |
| `cmd` |  |

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--env <name|base>` | Apply an optional env overlay by name (use 'base' to bypass overlays) |
| `--branch <name>` | Run against a branch-specific instance (compose name + hostnames) |
| `--workdir <path>` | Working directory inside the container (docker compose run -w) |
| `--profile <name[,name...]>` | Enable one or more compose profiles (comma-separated) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack exec <service> [cmd...]`

Run a command in an already-running service container (docker compose exec)

### Usage

```bash
hack exec <service> [cmd...] [options]
```

### Arguments

| Arg | Description |
| --- | --- |
| `service` |  |
| `cmd` |  |

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--env <name|base>` | Apply an optional env overlay by name (use 'base' to bypass overlays) |
| `--branch <name>` | Run against a branch-specific instance (compose name + hostnames) |
| `--workdir <path>` | Working directory inside the container (docker compose run -w) |
| `--profile <name[,name...]>` | Enable one or more compose profiles (comma-separated) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack logs [service]`

Tail logs (compose by default; Loki for queries/history via --loki/--query)

### Usage

```bash
hack logs [service] [options]
```

### Arguments

| Arg | Description |
| --- | --- |
| `service` |  |

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--branch <name>` | Run against a branch-specific instance (compose name + hostnames) |
| `--follow, -f` | Follow logs (default for `hack logs`) |
| `--no-follow` | Print logs and exit (do not follow) |
| `--tail <n>` | Tail last N log lines (default: 200) |
| `--pretty` | Pretty-print logs (best-effort JSON parsing + formatting) |
| `--json` | Output JSON (machine-readable) |
| `--profile <name[,name...]>` | Enable one or more compose profiles (comma-separated) |
| `--compose` | Read logs directly from docker compose (bypass Loki) |
| `--loki` | Force Loki backend (do not fall back to docker compose logs) |
| `--services <csv>` | Filter Loki logs by service(s), comma-separated (e.g. api,www) |
| `--query <logql>` | Raw LogQL selector/query (overrides auto selector built from project + services) |
| `--since <time>` | Start time for Loki logs (RFC3339 or duration like 15m) |
| `--until <time>` | End time for Loki logs (RFC3339 or duration like 15m) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack open [target]`

Open a URL for the project (default: https://<project>.hack)

### Usage

```bash
hack open [target] [options]
```

### Arguments

| Arg | Description |
| --- | --- |
| `target` |  |

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--branch <name>` | Run against a branch-specific instance (compose name + hostnames) |
| `--json` | Output JSON (machine-readable) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack branch`

Manage branch aliases for a project

### Usage

```bash
hack branch <subcommand> [options]
```

### Subcommands

| Command | Summary |
| --- | --- |
| `hack branch add <name>` | Register a branch alias for this project |
| `hack branch list` | List registered branch aliases for this project |
| `hack branch remove <name>` | Remove a branch alias for this project |
| `hack branch open <name>` | Open the branch host in a browser |

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack branch add <name>`

Register a branch alias for this project

### Usage

```bash
hack branch add <name> [options]
```

### Arguments

| Arg | Description |
| --- | --- |
| `name` |  |

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--note <text>` | Optional note for the branch entry |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack branch list`

List registered branch aliases for this project

### Usage

```bash
hack branch list [options]
```

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack branch remove <name>`

Remove a branch alias for this project

### Usage

```bash
hack branch remove <name> [options]
```

### Arguments

| Arg | Description |
| --- | --- |
| `name` |  |

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack branch open <name>`

Open the branch host in a browser

### Usage

```bash
hack branch open <name> [options]
```

### Arguments

| Arg | Description |
| --- | --- |
| `name` |  |

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack config`

Read/write hack.config.json values

### Usage

```bash
hack config <subcommand> [options]
```

### Subcommands

| Command | Summary |
| --- | --- |
| `hack config get <key>` | Read a value from hack.config.json |
| `hack config set <key> <value>` | Update a value in hack.config.json |

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack config get <key>`

Read a value from hack.config.json

### Usage

```bash
hack config get <key> [options]
```

### Arguments

| Arg | Description |
| --- | --- |
| `key` |  |

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--global` | Read/write global ~/.hack/hack.config.json |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack config set <key> <value>`

Update a value in hack.config.json

### Usage

```bash
hack config set <key> <value> [options]
```

### Arguments

| Arg | Description |
| --- | --- |
| `key` |  |
| `value` |  |

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--global` | Read/write global ~/.hack/hack.config.json |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack session`

Manage persistent project workspaces with tmux-first onboarding

### Usage

```bash
hack session <subcommand> [options]
```

Sessions keep a project workspace alive across terminal restarts, SSH reconnects, and long-running agent work. The guided default is tmux, including `hack setup tmux` for a popup picker. Other mux backends such as zellij still exist through `sessions.mux`, but the interactive session tooling is tmux-first today.

### Subcommands

| Command | Summary |
| --- | --- |
| `hack session list` | List active workspaces |
| `hack session start [project]` | Reuse the default project workspace or create an isolated one |
| `hack session stop <workspace>` | Stop a workspace |
| `hack session attach <workspace>` | Attach to an existing workspace |
| `hack session exec <workspace> <command>` | Send a command to a running workspace |
| `hack session panes <workspace>` | List panes in a tmux workspace |
| `hack session capture <workspace>` | Capture recent output from a tmux workspace |
| `hack session tail <workspace>` | Tail output from a tmux workspace |

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack session list`

List active workspaces

### Usage

```bash
hack session list [options]
```

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack session start [project]`

Reuse the default project workspace or create an isolated one

### Usage

```bash
hack session start [project] [options]
```

Reuse the default project workspace when it already exists, or create an isolated long-running workspace with --new or --name. Use --detach when another tool should keep the workspace alive without attaching your terminal.

### Arguments

| Arg | Description |
| --- | --- |
| `project` | Project name or path |

### Options

| Option | Description |
| --- | --- |
| `--up` | Run hack up -d before creating or attaching |
| `--new` | Create an isolated workspace instead of reusing the default project workspace |
| `--name <value>` | Suffix for an isolated workspace name (for example: agent-1 -> project--agent-1) |
| `--detach, -d` | Create or reuse the workspace without attaching (for GUI/non-TTY use) |
| `--env <name|base>` | Apply an optional env overlay by name (use 'base' to bypass overlays) |
| `--service <global|service>` | Inject env for the selected scope (global or a service name) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack session stop <workspace>`

Stop a workspace

### Usage

```bash
hack session stop <workspace> [options]
```

### Arguments

| Arg | Description |
| --- | --- |
| `workspace` | Workspace name |

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack session attach <workspace>`

Attach to an existing workspace

### Usage

```bash
hack session attach <workspace> [options]
```

Attach to a running workspace by name. Tmux switches clients instead of nesting tmux inside tmux, while zellij attaches to the named session directly.

### Arguments

| Arg | Description |
| --- | --- |
| `workspace` | Workspace name |

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack session exec <workspace> <command>`

Send a command to a running workspace

### Usage

```bash
hack session exec <workspace> <command> [options]
```

Queue a command in the workspace without opening a new interactive attach flow. Tmux sends it to the active pane; zellij opens a new pane for the command. This is useful for long-running agents, background checks, or remote follow-up work.

### Arguments

| Arg | Description |
| --- | --- |
| `workspace` | Workspace name |
| `command` | Command to execute in workspace |

### Options

| Option | Description |
| --- | --- |
| `--env <name|base>` | Apply an optional env overlay by name (use 'base' to bypass overlays) |
| `--service <global|service>` | Inject env for the selected scope (global or a service name) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack session panes <workspace>`

List panes in a tmux workspace

### Usage

```bash
hack session panes <workspace> [options]
```

### Arguments

| Arg | Description |
| --- | --- |
| `workspace` | Workspace name |

### Options

| Option | Description |
| --- | --- |
| `--json` | Output JSON (machine-readable) |
| `--pretty` | Pretty-print logs (best-effort JSON parsing + formatting) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack session capture <workspace>`

Capture recent output from a tmux workspace

### Usage

```bash
hack session capture <workspace> [options]
```

### Arguments

| Arg | Description |
| --- | --- |
| `workspace` | Workspace name |

### Options

| Option | Description |
| --- | --- |
| `--target <target>` | Tmux pane target (default: active pane) |
| `--lines <n>` | Number of lines to capture (default: 200) |
| `--json` | Output JSON (machine-readable) |
| `--pretty` | Pretty-print logs (best-effort JSON parsing + formatting) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack session tail <workspace>`

Tail output from a tmux workspace

### Usage

```bash
hack session tail <workspace> [options]
```

### Arguments

| Arg | Description |
| --- | --- |
| `workspace` | Workspace name |

### Options

| Option | Description |
| --- | --- |
| `--target <target>` | Tmux pane target (default: active pane) |
| `--lines <n>` | Number of lines to capture (default: 200) |
| `--interval-ms <ms>` | Polling interval in milliseconds (default: 500) |
| `--max-ms <ms>` | Stop tailing after N milliseconds (default: 5000) |
| `--json` | Output JSON (machine-readable) |
| `--pretty` | Pretty-print logs (best-effort JSON parsing + formatting) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack ssh [workspace]`

Show SSH connection info for remote access to this machine

### Usage

```bash
hack ssh [workspace] [options]
```

Show SSH connection info for this machine and optionally connect to a persistent workspace. Existing workspaces reuse their current mux backend, and newly created workspaces use the configured default backend.

### Arguments

| Arg | Description |
| --- | --- |
| `workspace` | Workspace to connect to |

### Options

| Option | Description |
| --- | --- |
| `--host, -H <value>` | SSH host (hostname or IP) |
| `--user, -u <value>` | SSH username |
| `--tailscale, -t` | Use Tailscale SSH |
| `--direct` | Use direct SSH (requires --host) |
| `--port, -p <value>` | SSH port for direct connection (default: 22) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## Global infrastructure

## `hack global`

Manage machine-wide infra (DNS/TLS, Caddy proxy, logs)

### Usage

```bash
hack global <subcommand> [options]
```

### Subcommands

| Command | Summary |
| --- | --- |
| `hack global install` | Bootstrap ~/.hack and start Caddy + Grafana/Loki/Alloy |
| `hack global up` | Start global infra containers |
| `hack global down` | Stop global infra containers |
| `hack global status` | Show status for global infra (containers + networks) |
| `hack global logs [service]` | Tail global infra logs (caddy\|grafana\|loki\|alloy) |
| `hack global ca` | Export Caddy Local CA cert (print path or PEM) |
| `hack global cert <hosts...>` | Generate local TLS certs via mkcert (for non-Caddy services) |
| `hack global trust` | Trust Caddy Local CA (macOS) so https://*.hack is trusted |
| `hack global logs-reset` | Wipe Loki/Grafana volumes (fresh logs + dashboards) |
| `hack global authorize` | Authorize passwordless DNS recovery commands on macOS |

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack global install`

Bootstrap ~/.hack and start Caddy + Grafana/Loki/Alloy

### Usage

```bash
hack global install [options]
```

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack global up`

Start global infra containers

### Usage

```bash
hack global up [options]
```

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack global down`

Stop global infra containers

### Usage

```bash
hack global down [options]
```

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack global status`

Show status for global infra (containers + networks)

### Usage

```bash
hack global status [options]
```

### Options

| Option | Description |
| --- | --- |
| `--json` | Output JSON (machine-readable) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack global logs [service]`

Tail global infra logs (caddy\|grafana\|loki\|alloy)

### Usage

```bash
hack global logs [service] [options]
```

### Arguments

| Arg | Description |
| --- | --- |
| `service` |  |

### Options

| Option | Description |
| --- | --- |
| `--follow, -f` | Follow logs (default for `hack logs`) |
| `--no-follow` | Print logs and exit (do not follow) |
| `--tail <n>` | Tail last N log lines (default: 200) |
| `--pretty` | Pretty-print logs (best-effort JSON parsing + formatting) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack global ca`

Export Caddy Local CA cert (print path or PEM)

### Usage

```bash
hack global ca [options]
```

### Options

| Option | Description |
| --- | --- |
| `--print` | Print the CA cert PEM to stdout (instead of printing its path) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack global cert <hosts...>`

Generate local TLS certs via mkcert (for non-Caddy services)

### Usage

```bash
hack global cert <hosts...> [options]
```

Uses mkcert to generate a cert/key pair under ~/.hack/certs (or --out).

### Arguments

| Arg | Description |
| --- | --- |
| `hosts` |  |

### Options

| Option | Description |
| --- | --- |
| `--install` | Run mkcert -install before generating certs |
| `--out <dir>` | Directory for generated cert/key (default: ~/.hack/certs) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack global trust`

Trust Caddy Local CA (macOS) so https://*.hack is trusted

### Usage

```bash
hack global trust [options]
```

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack global logs-reset`

Wipe Loki/Grafana volumes (fresh logs + dashboards)

### Usage

```bash
hack global logs-reset [options]
```

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack global authorize`

Authorize passwordless DNS recovery commands on macOS

### Usage

```bash
hack global authorize [options]
```

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack status`

Show project status (shortcut for `hack projects --details`)

### Usage

```bash
hack status [options]
```

### Options

| Option | Description |
| --- | --- |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--include-global` | Include global infra projects under ~/.hack (e.g. logging stack) |
| `--all` | Include unregistered docker compose projects (best-effort) |
| `--meta` | Include git/worktree/session/env metadata (implies --details) |
| `--json` | Output JSON (machine-readable) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack usage`

Show resource usage across running projects

### Usage

```bash
hack usage [options]
```

### Options

| Option | Description |
| --- | --- |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--include-global` | Include global infra projects under ~/.hack (e.g. logging stack) |
| `--watch` | Refresh usage continuously |
| `--interval <value>` | Refresh interval (ms) for --watch |
| `--no-host` | Skip host process metrics |
| `--json` | Output JSON (machine-readable) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack projects`

Show all projects (registry + running docker compose)

### Usage

```bash
hack projects <subcommand> [options]
```

### Subcommands

| Command | Summary |
| --- | --- |
| `hack projects prune` | Remove stale registry entries and stop orphaned containers |

### Options

| Option | Description |
| --- | --- |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--details` | Show per-project service tables |
| `--meta` | Include git/worktree/session/env metadata (implies --details) |
| `--include-global` | Include global infra projects under ~/.hack (e.g. logging stack) |
| `--all` | Include unregistered docker compose projects (best-effort) |
| `--json` | Output JSON (machine-readable) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack projects prune`

Remove stale registry entries and stop orphaned containers

### Usage

```bash
hack projects prune [options]
```

### Options

| Option | Description |
| --- | --- |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--include-global` | Include global infra projects under ~/.hack (e.g. logging stack) |
| `--json` | Output JSON (machine-readable) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## Diagnostics

## `hack log-pipe`

Read log lines from stdin and pretty-print them (best-effort JSON parsing)

### Usage

```bash
hack log-pipe [options]
```

### Options

| Option | Description |
| --- | --- |
| `--format <auto|docker-compose|plain>` | How to parse incoming lines from stdin (default: auto) |
| `--stream <stdout|stderr>` | Treat stdin as stdout or stderr (stderr forces ERROR level + writes to stderr) (default: stdout) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack doctor`

Validate local setup (docker, networks, DNS, global infra, project config)

### Usage

```bash
hack doctor [options]
```

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--fix` | Attempt safe auto-remediations (network + CoreDNS + CA) |
| `--migrate-env-config` | Migrate legacy hack.env.json/.env state to the new env config files |
| `--json` | Output JSON (machine-readable) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack crash-capture`

Capture OrbStack/system/docker diagnostics into .tmp for post-failure triage

### Usage

```bash
hack crash-capture [options]
```

Collects structured snapshots after a runtime failure: hack status/logs, docker state, OrbStack process details, and filtered macOS unified logs.

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--since <duration>` | Look-back window for system logs (for example: 30m, 2h) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack daemon`

Manage the local hack daemon (hackd)

### Usage

```bash
hack daemon <subcommand> [options]
```

### Subcommands

| Command | Summary |
| --- | --- |
| `hack daemon start` | Start hackd (local daemon) |
| `hack daemon stop` | Stop hackd |
| `hack daemon restart` | Restart hackd |
| `hack daemon status` | Show hackd status |
| `hack daemon metrics` | Show hackd metrics |
| `hack daemon logs` | Show hackd logs |
| `hack daemon clear` | Clear stale hackd pid/socket files |
| `hack daemon install` | Install hackd as a launchd service (macOS) |
| `hack daemon uninstall` | Uninstall hackd launchd service (macOS) |

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack daemon start`

Start hackd (local daemon)

### Usage

```bash
hack daemon start [options]
```

### Options

| Option | Description |
| --- | --- |
| `--foreground` | Run hackd in the foreground (debug) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack daemon stop`

Stop hackd

### Usage

```bash
hack daemon stop [options]
```

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack daemon restart`

Restart hackd

### Usage

```bash
hack daemon restart [options]
```

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack daemon status`

Show hackd status

### Usage

```bash
hack daemon status [options]
```

### Options

| Option | Description |
| --- | --- |
| `--json` | Output JSON (machine-readable) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack daemon metrics`

Show hackd metrics

### Usage

```bash
hack daemon metrics [options]
```

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack daemon logs`

Show hackd logs

### Usage

```bash
hack daemon logs [options]
```

### Options

| Option | Description |
| --- | --- |
| `--tail <n>` | Tail last N log lines (default: 200) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack daemon clear`

Clear stale hackd pid/socket files

### Usage

```bash
hack daemon clear [options]
```

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack daemon install`

Install hackd as a launchd service (macOS)

### Usage

```bash
hack daemon install [options]
```

### Options

| Option | Description |
| --- | --- |
| `--run-at-load` | Start hackd automatically on login |
| `--no-run-at-load` | Do not start hackd automatically on login |
| `--gui-only` | Only run in GUI sessions (default) |
| `--no-gui-only` | Run in all session types (including SSH) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack daemon uninstall`

Uninstall hackd launchd service (macOS)

### Usage

```bash
hack daemon uninstall [options]
```

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack update`

Update hack to the latest release

### Usage

```bash
hack update [options]
```

Downloads and installs the latest stable hack release from GitHub.

Notes:
- Refuses to self-update when running from a Homebrew install, local dev wrapper, or symlink install.
- Updates the current hack binary and refreshes assets.

### Options

| Option | Description |
| --- | --- |
| `--check` | Check for updates (do not install) |
| `--yes` | Apply update without prompting |
| `--tag <tag>` | Update to a specific release tag (e.g. v1.4.0) |
| `--json` | Output JSON (machine-readable) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack version`

Print version

### Usage

```bash
hack version [options]
```

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack help [path...]`

Show help for a command (e.g. hack help global logs)

### Usage

```bash
hack help [path...] [options]
```

### Arguments

| Arg | Description |
| --- | --- |
| `path` |  |

### Options

| Option | Description |
| --- | --- |
| `--all` | Include experimental (unsupported) commands in help output |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## Agents

## `hack mcp`

Manage MCP server integrations for coding agents

### Usage

```bash
hack mcp <subcommand> [options]
```

### Subcommands

| Command | Summary |
| --- | --- |
| `hack mcp serve` | Run the MCP server over stdio |
| `hack mcp install` | Install MCP config for supported clients |
| `hack mcp print` | Print MCP config snippets |

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack mcp serve`

Run the MCP server over stdio

### Usage

```bash
hack mcp serve [options]
```

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack mcp install`

Install MCP config for supported clients

### Usage

```bash
hack mcp install [options]
```

### Options

| Option | Description |
| --- | --- |
| `--scope <user|project>` | Write MCP config to user or project scope (default: user) |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--all` | Target all supported clients |
| `--cursor` | Target Cursor MCP config |
| `--claude` | Target Claude CLI MCP config |
| `--codex` | Target Codex MCP config |
| `--docs` | Update AGENTS.md and CLAUDE.md with hack usage |
| `--agents-md` | Update AGENTS.md with hack usage |
| `--claude-md` | Update CLAUDE.md with hack usage |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack mcp print`

Print MCP config snippets

### Usage

```bash
hack mcp print [options]
```

### Options

| Option | Description |
| --- | --- |
| `--scope <user|project>` | Write MCP config to user or project scope (default: user) |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--all` | Target all supported clients |
| `--cursor` | Target Cursor MCP config |
| `--claude` | Target Claude CLI MCP config |
| `--codex` | Target Codex MCP config |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack setup`

Install integrations for coding agents

### Usage

```bash
hack setup <subcommand> [options]
```

### Subcommands

| Command | Summary |
| --- | --- |
| `hack setup tmux` | Install the recommended tmux binding for hack workspaces |
| `hack setup cursor` | Install Cursor rules for hack CLI usage |
| `hack setup claude` | Install Claude Code hooks for hack CLI usage |
| `hack setup codex` | Install Codex skill for hack CLI usage |
| `hack setup tickets` | Remove or audit the deprecated Hack Tickets skill |
| `hack setup agents` | Install AGENTS.md / CLAUDE.md snippets for hack CLI usage |
| `hack setup sync` | Refresh project/global agent guidance and remove deprecated artifacts |
| `hack setup mcp` | Install MCP configs for hack CLI usage (no-shell only) |

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack setup tmux`

Install the recommended tmux binding for hack workspaces

### Usage

```bash
hack setup tmux [options]
```

### Options

| Option | Description |
| --- | --- |
| `--check` | Check whether integration is installed |
| `--remove` | Remove integration files/config |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack setup cursor`

Install Cursor rules for hack CLI usage

### Usage

```bash
hack setup cursor [options]
```

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--global` | Use global (user) scope instead of project scope |
| `--check` | Check whether integration is installed |
| `--remove` | Remove integration files/config |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack setup claude`

Install Claude Code hooks for hack CLI usage

### Usage

```bash
hack setup claude [options]
```

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--global` | Use global (user) scope instead of project scope |
| `--check` | Check whether integration is installed |
| `--remove` | Remove integration files/config |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack setup codex`

Install Codex skill for hack CLI usage

### Usage

```bash
hack setup codex [options]
```

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--global` | Use global (user) scope instead of project scope |
| `--check` | Check whether integration is installed |
| `--remove` | Remove integration files/config |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack setup tickets`

Remove or audit the deprecated Hack Tickets skill

### Usage

```bash
hack setup tickets [options]
```

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--global` | Use global (user) scope instead of project scope |
| `--check` | Check whether integration is installed |
| `--remove` | Remove integration files/config |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack setup agents`

Install AGENTS.md / CLAUDE.md snippets for hack CLI usage

### Usage

```bash
hack setup agents [options]
```

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--all` | Target all supported clients |
| `--agents-md` | Target AGENTS.md |
| `--claude-md` | Target CLAUDE.md |
| `--check` | Check whether integration is installed |
| `--remove` | Remove integration files/config |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack setup sync`

Refresh project/global agent guidance and remove deprecated artifacts

### Usage

```bash
hack setup sync [options]
```

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--global` | Use global (user) scope instead of project scope |
| `--all-scopes` | Target both project and global (user) scopes |
| `--check` | Check whether integration is installed |
| `--remove` | Remove integration files/config |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack setup mcp`

Install MCP configs for hack CLI usage (no-shell only)

### Usage

```bash
hack setup mcp [options]
```

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--global` | Use global (user) scope instead of project scope |
| `--all` | Target all supported clients |
| `--cursor` | Target Cursor integration |
| `--claude` | Target Claude integration |
| `--codex` | Target Codex integration |
| `--check` | Check whether integration is installed |
| `--remove` | Remove integration files/config |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack agent`

Agent utilities

### Usage

```bash
hack agent <subcommand> [options]
```

### Subcommands

| Command | Summary |
| --- | --- |
| `hack agent prime` | Print agent primer text |
| `hack agent patterns` | Print agent init patterns guide |
| `hack agent init` | Print agent init prompt |
| `hack agent onboard` | Print the project onboarding prompt (agent-assisted setup) |

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack agent prime`

Print agent primer text

### Usage

```bash
hack agent prime [options]
```

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack agent patterns`

Print agent init patterns guide

### Usage

```bash
hack agent patterns [options]
```

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack agent init`

Print agent init prompt

### Usage

```bash
hack agent init [options]
```

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--client, -c <cursor|claude|codex|print>` | Open init prompt in an agent client (or print) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack agent onboard`

Print the project onboarding prompt (agent-assisted setup)

### Usage

```bash
hack agent onboard [options]
```

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## Secrets & env

## `hack secrets`

Manage secrets in OS keychain (Bun.secrets)

### Usage

```bash
hack secrets <subcommand> [options]
```

### Subcommands

| Command | Summary |
| --- | --- |
| `hack secrets set [name]` | Store a secret |
| `hack secrets get [name]` | Print a secret (exit 1 if missing) |
| `hack secrets delete [name]` | Delete a stored secret |

### Options

| Option | Description |
| --- | --- |
| `--service <service>` | Override Bun.secrets service name (default: hack-cli) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack secrets set [name]`

Store a secret

### Usage

```bash
hack secrets set [name] [options]
```

### Arguments

| Arg | Description |
| --- | --- |
| `name` |  |

### Options

| Option | Description |
| --- | --- |
| `--service <service>` | Override Bun.secrets service name (default: hack-cli) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack secrets get [name]`

Print a secret (exit 1 if missing)

### Usage

```bash
hack secrets get [name] [options]
```

### Arguments

| Arg | Description |
| --- | --- |
| `name` |  |

### Options

| Option | Description |
| --- | --- |
| `--service <service>` | Override Bun.secrets service name (default: hack-cli) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack secrets delete [name]`

Delete a stored secret

### Usage

```bash
hack secrets delete [name] [options]
```

### Arguments

| Arg | Description |
| --- | --- |
| `name` |  |

### Options

| Option | Description |
| --- | --- |
| `--service <service>` | Override Bun.secrets service name (default: hack-cli) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## Integrations

## `hack auth [args...]`

Removed: Hack account sign-in no longer ships with the local-first CLI

### Usage

```bash
hack auth [args...] [options]
```

Removed in v3: Hack no longer ships a centralized auth broker or hosted account surface.

Migration: Local workflows no longer require Hack account sign-in. Use local project ownership, tickets, env, and sessions directly.

### Arguments

| Arg | Description |
| --- | --- |
| `args` | Legacy subcommand and arguments |

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack org [args...]`

Removed: hosted organization management is no longer part of Hack

### Usage

```bash
hack org [args...] [options]
```

Removed in v3: Hack v3 dropped centralized org and membership administration with the broker-backed control plane.

Migration: Keep project ownership local and use native git collaboration plus repo-local tickets instead.

### Arguments

| Arg | Description |
| --- | --- |
| `args` | Legacy subcommand and arguments |

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack team [args...]`

Removed: hosted team management is no longer part of Hack

### Usage

```bash
hack team [args...] [options]
```

Removed in v3: Hack v3 removed broker-backed team and membership lifecycle management.

Migration: Use repo-local ownership plus native collaboration tools outside Hack.

### Arguments

| Arg | Description |
| --- | --- |
| `args` | Legacy subcommand and arguments |

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack linear [args...]`

Removed: Linear integration is no longer part of Hack v3

### Usage

```bash
hack linear [args...] [options]
```

Removed in v3: Hack v3 removed hosted planning and sync integrations to stay self-contained and local-first.

Migration: Use repo-local tickets for optional in-repo tracking and keep Linear outside Hack.

### Arguments

| Arg | Description |
| --- | --- |
| `args` | Legacy subcommand and arguments |

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack env`

Set project env vars and local secrets

### Usage

```bash
hack env <subcommand> [options]
```

### Subcommands

| Command | Summary |
| --- | --- |
| `hack env list` | List resolved env values for the selected overlay |
| `hack env explain <key>` | Explain a resolved env value without revealing it |
| `hack env apply` | Recreate one service with its resolved env |
| `hack env add [key] [value]` | Add or update an env value |
| `hack env set [key] [value]` | Alias for env add |
| `hack env materialize` | Write a compatibility .env file from the selected overlay |
| `hack env exec [command...]` | Run a host command with project env injected |
| `hack env shell` | Open a host shell with project env injected |
| `hack env unset [key]` | Remove an env value from the canonical config |
| `hack env backend` | Manage env/secret storage backend strategy |

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack env list`

List resolved env values for the selected overlay

### Usage

```bash
hack env list [options]
```

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--env <name|base>` | Apply an optional env overlay by name (use 'base' to bypass overlays) |
| `--json` | Output JSON (machine-readable) |
| `--show-secrets` | Print secret values (keychain) in plaintext |
| `--service <global|service>` | Target scope (global or a discovered service name) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack env explain <key>`

Explain a resolved env value without revealing it

### Usage

```bash
hack env explain <key> [options]
```

### Arguments

| Arg | Description |
| --- | --- |
| `key` |  |

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--env <name|base>` | Apply an optional env overlay by name (use 'base' to bypass overlays) |
| `--json` | Output JSON (machine-readable) |
| `--service <global|service>` | Target scope (global or a discovered service name) |
| `--target <host|compose>` | Env view for host commands (default: host rewrites container-oriented addresses for local host execution) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack env apply`

Recreate one service with its resolved env

### Usage

```bash
hack env apply [options]
```

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--env <name|base>` | Apply an optional env overlay by name (use 'base' to bypass overlays) |
| `--json` | Output JSON (machine-readable) |
| `--service <global|service>` | Target scope (global or a discovered service name) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack env add [key] [value]`

Add or update an env value

### Usage

```bash
hack env add [key] [value] [options]
```

### Arguments

| Arg | Description |
| --- | --- |
| `key` |  |
| `value` |  |

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--env <name|base>` | Apply an optional env overlay by name (use 'base' to bypass overlays) |
| `--secret` | Store value as an encrypted secure entry |
| `--local` | Write to the worktree-local env override file instead of the shared repo env file |
| `--service <global|service>` | Target scope (global or a discovered service name) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack env set [key] [value]`

Alias for env add

### Usage

```bash
hack env set [key] [value] [options]
```

### Arguments

| Arg | Description |
| --- | --- |
| `key` |  |
| `value` |  |

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--env <name|base>` | Apply an optional env overlay by name (use 'base' to bypass overlays) |
| `--secret` | Store value as an encrypted secure entry |
| `--local` | Write to the worktree-local env override file instead of the shared repo env file |
| `--service <global|service>` | Target scope (global or a discovered service name) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack env materialize`

Write a compatibility .env file from the selected overlay

### Usage

```bash
hack env materialize [options]
```

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--env <name|base>` | Apply an optional env overlay by name (use 'base' to bypass overlays) |
| `--service <global|service>` | Target scope (global or a discovered service name) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack env exec [command...]`

Run a host command with project env injected

### Usage

```bash
hack env exec [command...] [options]
```

Inject the selected Hack env overlay directly into a one-off host command without materializing .hack/.env. To inspect a value, prefer `printenv KEY` or `sh -lc 'printf "%s\n" "$KEY"'`; `echo $KEY` expands in your current shell before Hack injects env.

### Arguments

| Arg | Description |
| --- | --- |
| `command` |  |

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--env <name|base>` | Apply an optional env overlay by name (use 'base' to bypass overlays) |
| `--service <global|service>` | Target scope (global or a discovered service name) |
| `--target <host|compose>` | Env view for host commands (default: host rewrites container-oriented addresses for local host execution) |
| `--shell <command>` | Run a shell command string via /bin/sh -lc after env injection so `$VAR` expansion happens inside the child shell |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack env shell`

Open a host shell with project env injected

### Usage

```bash
hack env shell [options]
```

Start an interactive host shell with the selected Hack env overlay injected into the process environment.

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--env <name|base>` | Apply an optional env overlay by name (use 'base' to bypass overlays) |
| `--service <global|service>` | Target scope (global or a discovered service name) |
| `--target <host|compose>` | Env view for host commands (default: host rewrites container-oriented addresses for local host execution) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack env unset [key]`

Remove an env value from the canonical config

### Usage

```bash
hack env unset [key] [options]
```

### Arguments

| Arg | Description |
| --- | --- |
| `key` |  |

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--env <name|base>` | Apply an optional env overlay by name (use 'base' to bypass overlays) |
| `--local` | Write to the worktree-local env override file instead of the shared repo env file |
| `--service <global|service>` | Target scope (global or a discovered service name) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack env backend`

Manage env/secret storage backend strategy

### Usage

```bash
hack env backend <subcommand> [options]
```

### Subcommands

| Command | Summary |
| --- | --- |
| `hack env backend status` | Show configured env/secret backend strategy |
| `hack env backend use <backend>` | Select env/secret backend strategy |

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack host`

Run host-side commands with project env injected

### Usage

```bash
hack host <subcommand> [options]
```

Use hack host when a command should run on your host machine, not inside the compose network, but still needs Hack-resolved env and host-local rewrites.

### Subcommands

| Command | Summary |
| --- | --- |
| `hack host exec [command...]` | Run a host command with project env injected |
| `hack host shell` | Open a host shell with project env injected |

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack host exec [command...]`

Run a host command with project env injected

### Usage

```bash
hack host exec [command...] [options]
```

Run a one-off command on the host with the selected Hack env overlay injected. Use --scope when you want service-scoped values without running inside that service container. To inspect a value, prefer `printenv KEY` or `sh -lc 'printf "%s\n" "$KEY"'`; `echo $KEY` expands in your current shell before Hack injects env.

### Arguments

| Arg | Description |
| --- | --- |
| `command` |  |

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--env <name|base>` | Apply an optional env overlay by name (use 'base' to bypass overlays) |
| `--scope <global|service>` | Resolve values for one env scope while still running the command on the host |
| `--target <host|compose>` | Env view for host commands (default: host rewrites container-oriented addresses for local host execution) |
| `--shell <command>` | Run a shell command string via /bin/sh -lc after env injection so `$VAR` expansion happens inside the child shell |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack host shell`

Open a host shell with project env injected

### Usage

```bash
hack host shell [options]
```

Start an interactive host shell with the selected Hack env overlay injected. Use --scope when you want service-scoped values without running inside that service container.

### Options

| Option | Description |
| --- | --- |
| `--path, -p <dir>` | Run a project command against a repo path (overrides cwd search) |
| `--project <name>` | Target a registered project by name (from ~/.hack/projects.json) |
| `--env <name|base>` | Apply an optional env overlay by name (use 'base' to bypass overlays) |
| `--scope <global|service>` | Resolve values for one env scope while still running the command on the host |
| `--target <host|compose>` | Env view for host commands (default: host rewrites container-oriented addresses for local host execution) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## `hack tickets [args...]`

Deprecated: legacy repo-local Tickets compatibility commands

### Usage

```bash
hack tickets [args...] [options]
```

Usage:
  hack tickets list
  hack tickets create --title "..."
  hack tickets show <ticket-id>
  hack tickets status <ticket-id> <open\|in_progress\|blocked\|done>
  hack tickets update <ticket-id> [--title "..."] [--body "..."]
  hack tickets sync
  hack tickets setup
  hack tickets tui

Deprecated compatibility surface. It is no longer installed into agent instructions or skills.
Alias for `hack x tickets <command>`. Requires extension enabled.

### Arguments

| Arg | Description |
| --- | --- |
| `args` |  |

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## Extensions

## `hack x [args...]`

Run extension commands

### Usage

```bash
hack x [args...] [options]
```

Usage:
  hack x list
  hack x <namespace> help
  hack x <namespace> <command> [args...]

Extension commands accept their own flags and arguments.
Use `hack x <namespace> help` to see available commands.

### Arguments

| Arg | Description |
| --- | --- |
| `args` |  |

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## Fun

## `hack the`

Crash override

### Usage

```bash
hack the <subcommand> [options]
```

### Subcommands

| Command | Summary |
| --- | --- |
| `hack the planet` | Crash override |

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack the planet`

Crash override

### Usage

```bash
hack the planet [options]
```

### Options

| Option | Description |
| --- | --- |
| `--variant <cut|mash|cycle|random>` | Animation variant (default: cycle) |
| `--loop` | Loop until Ctrl+C (default: true) |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |


## Experimental (unsupported)

These commands are source-available but outside the supported v3 product contract. They are hidden from default `hack --help` (see them with `hack help --all`) and print a warning when invoked.

- `hack dispatch` — Beta: run branch-scoped jobs on remote nodes
- `hack gateway` — Beta: manage the remote control plane entrypoint
- `hack node` — Beta: manage remote execution nodes
- `hack remote` — Beta: guided remote access and gateway helpers

## Internal

## `hack internal`

Manage hack-managed internal overrides

### Usage

```bash
hack internal <subcommand> [options]
```

### Subcommands

| Command | Summary |
| --- | --- |
| `hack internal extra-hosts` | Manage internal Compose extra_hosts |

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |

## `hack internal extra-hosts`

Manage internal Compose extra_hosts

### Usage

```bash
hack internal extra-hosts <subcommand> [options]
```

### Subcommands

| Command | Summary |
| --- | --- |
| `hack internal extra-hosts set <hostname> <target>` | Set an internal extra_hosts entry |
| `hack internal extra-hosts unset <hostname>` | Remove an internal extra_hosts entry |
| `hack internal extra-hosts list` | List internal extra_hosts entries |

### Options

| Option | Description |
| --- | --- |
| `--no-interactive` | Never prompt: apply documented defaults or fail with E_INTERACTIVE_REQUIRED (also via HACK_NO_INTERACTIVE=1) |
| `--help, -h` | Show help |
| `--version, -v` | Show version |
