# Sessions

Sessions are **persistent project workspaces**. They keep a repo-root shell alive across terminal restarts, SSH reconnects, and long-running agent work so you can return to the same context instead of rebuilding it each time.

The guided default is **tmux**:
- `hack session` opens a tmux-first interactive picker
- `hack session start <project>` reuses the default project workspace unless you ask for an isolated one
- `hack session start <project> --env qa --service api` creates a stable env-scoped workspace when you need a specific overlay
- `hack setup tmux` installs the recommended popup binding so the picker is easy to reach from tmux

Other mux backends still exist. `sessions.mux=auto` prefers tmux and falls back to zellij when tmux is unavailable, and you can explicitly set `sessions.mux=zellij` if that is your preferred backend. The interactive onboarding and pane tooling are tmux-first today.

## Quick start

```bash
# Interactive picker for existing workspaces and new project workspaces
hack session

# Reuse the default workspace for a project, or create it if needed
hack session start <project>

# Create an env-scoped workspace for one overlay/service combination
hack session start <project> --env qa --service api --detach

# List active workspaces
hack session list

# Attach to an existing workspace by name
hack session attach <workspace>

# Queue a command in a running workspace
hack session exec <workspace> "bun test"

# Queue a command with injected env for that run
hack session exec <workspace> --env qa --service api "bun db:migrate"

# Stop a workspace
hack session stop <workspace>

# Capture recent output (defaults to active pane)
hack session capture <workspace>

# Tail workspace output for a short window (defaults to active pane)
hack session tail <workspace>

# List panes in a workspace
hack session panes <workspace>
```

## Core flows

### Interactive picker

Running `hack session` without arguments opens an interactive picker showing:
- **Active workspaces**: running workspaces from the configured mux backend(s), with attached status when the backend can report it
- **Available projects**: registered projects that do not currently have a default workspace

When selecting an attached session, you can choose to:
- **Attach**: detach other clients and take over the workspace
- **Create isolated**: start a separate long-running workspace such as `project--2`

This is the recommended entry point when you want to resume a project context but do not remember the exact workspace name.

`hack session` with no subcommand is inherently interactive (it prompts with a picker) and is not a
scripted/agent entry point. For scripted or agent-driven runs, use `hack session start <project>`
(optionally with `--detach`) or `hack session list --json` instead of the bare picker.

### Start and create

```bash
# Reuse the default project workspace (creates it if needed)
hack session start my-project

# Force creation of an isolated numbered workspace
hack session start my-project --new

# Create an isolated workspace with a custom suffix
hack session start my-project --name agent-1
# Creates: my-project--agent-1

# Prepare services before creating or attaching
hack session start my-project --up

# Create or reuse without attaching the current terminal
hack session start my-project --detach

# Create a stable env-scoped workspace
hack session start my-project --env qa --service api --detach
```

Default behavior is deliberate:
- The first workspace for a project is just the project name, for example `my-project`
- Passing `--env` or `--service` creates a stable scoped workspace name such as `my-project.env-qa.svc-api`
- `--new` or `--name` creates an isolated workspace for a second agent, experiment, or review lane
- `--detach` keeps the workspace alive for another tool or terminal to attach later

Workspaces are created at the project's repo root, not the `.hack/` directory.

### Attach

```bash
# Attach to an existing workspace
hack session attach my-project

# From inside tmux, this switches clients instead of nesting tmux
```

Use `attach` when you already know which workspace you want. If you are already inside tmux, hack switches clients instead of nesting tmux inside tmux. When attaching, tmux detaches other clients to avoid terminal size conflicts across multiple devices.
If the workspace is running in zellij, hack attaches to that named session directly instead.

### Stop

```bash
hack session stop <workspace>
```

`stop` kills the underlying mux session (`backend.killSession`) outright — anything still running
inside it, including a long-lived dev server or an in-progress agent task, is terminated. There is
no graceful shutdown step; if you need cleanup hooks to run first, do that before stopping.

### Exec

```bash
# Send a command to a running workspace
hack session exec my-project "bun test"

# tmux: sends the command + Enter to the active pane
# zellij: opens a new pane and runs the command because there is no active-pane equivalent

# Inject a selected overlay/service into the queued command
hack session exec my-project.env-qa.svc-api --env qa --service api "bun db:migrate"
```

Use `exec` when you want to drive a persistent workspace from another terminal, script, or agent without attaching interactively first.

If you pass `--env` or `--service`, Hack resolves the selected project env and injects it into the queued command without materializing `.hack/.env`.

### Listing panes (tmux only)

Use `hack session panes` to list panes with useful metadata (target, active flag, window/pane indices, command, path).

```bash
# List panes (NDJSON start/log/end)
hack session panes my-project

# Explicit NDJSON output (same as the default)
hack session panes my-project --json

# Single JSON object output
hack session panes my-project --pretty
```

`--json` and `--pretty` are mutually exclusive; passing both is an error.

### Capturing output (tmux only)

`hack session capture` emits NDJSON events by default for machine parsing (start/log/end). By default it targets the active pane; use `--target` to select a specific pane. Use `--pretty` for raw pane output; `--json` and `--pretty` are mutually exclusive.

```bash
# Capture last 200 lines (default) as NDJSON
hack session capture my-project

# Capture a specific pane target and line count (tmux pane targets use `:` and `.`)
hack session capture my-project --target my-project:0.1 --lines 500

# Human-friendly raw output
hack session capture my-project --pretty
```

### Tailing output (tmux only)

`hack session tail` also emits NDJSON events by default and stops after `--max-ms` (default 5000), polling every `--interval-ms` (default 500). By default it tails the active pane; use `--target` to select a specific pane. `--json` and `--pretty` are mutually exclusive.

```bash
# Poll capture-pane and emit only new lines for 5s (default)
hack session tail my-project

# Customize polling interval and max duration
hack session tail my-project --interval-ms 250 --max-ms 10000

# Human-friendly raw output
hack session tail my-project --pretty
```

## Remote access with SSH

Use `hack ssh` to get connection info for remote access:

```bash
# Interactive: choose Tailscale or direct SSH
hack ssh

# Use Tailscale SSH
hack ssh --tailscale

# Use direct SSH with hostname
hack ssh --direct --host 192.168.1.100

# Specify user and port
hack ssh --host example.com --user dev --port 2222

# Connect directly to a workspace
hack ssh my-session
```

### What `hack ssh` shows

1. **SSH command**: Copy-paste command to connect
2. **QR code**: Scan with mobile SSH apps (Blink, Termius)
3. **Active workspaces**: List of active workspaces on this machine, including the active mux backend when known
4. **Action picker**: Done or connect to a workspace

When you connect to an existing workspace, hack uses that workspace's backend. When you create a new one from the SSH flow, hack uses the configured default backend (`sessions.mux`).

### Tailscale setup

If Tailscale is stopped or not connected, `hack ssh` will prompt to start it:

```
Tailscale is stopped
? Turn on Tailscale? › yes
Starting Tailscale...
Tailscale connected!
```

### Terminal size conflicts

When multiple clients attach to the same tmux workspace, terminal size can get messed up. The session commands use `tmux attach -d` to detach other clients, avoiding this issue.

If you're already in tmux and want to switch workspaces without detaching:

```bash
# Inside tmux: prefix + s to open session switcher
# Or use the tmux command:
tmux switch-client -t <session>
```

## Configuration

Project config: `.hack/hack.config.json`

```json
{
  "sessions": {
    "mux": "auto"
  }
}
```

Values:
- `auto` (default): prefer tmux, fall back to zellij
- `tmux`: require tmux
- `zellij`: require zellij
- `none`: disable sessions

Env override: `HACK_SESSIONS_MUX=auto|tmux|zellij|none`

Global default:

```bash
hack config set --global sessions.mux zellij
```

Recommended onboarding:

```bash
# Install the tmux popup binding that launches the picker
hack setup tmux

# Keep tmux as the guided default, but switch globally if your team prefers zellij
hack config set --global sessions.mux zellij
```

## Daemon sessions API

> **Status: unsupported experimental.** This HTTP surface is served by the gateway, which the
> codebase itself labels "the unsupported experimental gateway server." It is outside the
> supported v3 product contract, hidden from default `hack --help` (see `hack help --all`), and
> prints a warning when the underlying `hack remote`/`hack gateway`/`hack node`/`hack dispatch`
> commands are invoked.

`hackd` (the daemon) itself listens on a local unix socket for the CLI's own use (fast JSON
status/ps, etc.) — it does not speak HTTP. The HTTP/WS surface described below, including the
`127.0.0.1:7788` examples, is served by the separate **gateway** process and requires it to be
explicitly enabled; it is not part of the daemon's normal listener.

The gateway exposes REST endpoints for managing **tmux** workspaces programmatically. Session
handlers shell out to `tmux` directly — there is no zellij code path in the gateway/daemon session
routes, even though `sessions.mux` supports zellij for local `hack session` usage. This is useful for:
- Remote workspace control via the gateway
- Building automation tools
- Agent orchestration

When accessed over HTTP, this API is served by the **gateway** and requires authentication.
See `docs/gateway-api.md` for token creation and the full security model.

See the [Gateway API](gateway-api.md) for authentication and endpoint details.

### Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/v1/sessions` | List all workspaces |
| POST | `/v1/sessions` | Create a new workspace |
| GET | `/v1/sessions/:id` | Get workspace details |
| POST | `/v1/sessions/:id/stop` | Stop (kill) a workspace |
| POST | `/v1/sessions/:id/exec` | Execute command in a workspace |
| POST | `/v1/sessions/:id/input` | Send raw keystrokes |

### List workspaces

```bash
curl -H "Authorization: Bearer $HACK_GATEWAY_TOKEN" \
  http://127.0.0.1:7788/v1/sessions
```

Response:
```json
{
  "sessions": [
    {
      "name": "my-project",
      "attached": false,
      "path": "/Users/dev/my-project",
      "windows": 1,
      "createdAt": "2024-01-15T10:30:00.000Z"
    }
  ],
  "connection": {
    "tailscaleDnsName": "laptop.tail1234.ts.net",
    "tailscaleSshCommand": "ssh laptop.tail1234.ts.net",
    "tailscaleReady": true,
    "hostname": "laptop"
  }
}
```

Session objects have no `backend` field — every session in this API is a tmux session.

### Create workspace

```bash
curl -X POST http://127.0.0.1:7788/v1/sessions \
  -H "Authorization: Bearer $HACK_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "agent-1", "cwd": "/path/to/project"}'
```

Request body:
| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Workspace name (alphanumeric, dash, underscore) |
| `cwd` | string | no | Working directory |

Creation always uses tmux; there is no backend override.

Response (201):
```json
{
  "session": {
    "name": "agent-1",
    "attached": false,
    "path": "/path/to/project",
    "windows": 1,
    "createdAt": "2024-01-15T10:35:00.000Z"
  }
}
```

### Get workspace

```bash
curl -H "Authorization: Bearer $HACK_GATEWAY_TOKEN" \
  http://127.0.0.1:7788/v1/sessions/agent-1
```

Response includes connection info for SSH access to the workspace:
```json
{
  "session": { ... },
  "connection": {
    "tailscaleDnsName": "laptop.tail1234.ts.net",
    "tailscaleSshCommand": "ssh laptop.tail1234.ts.net",
    "tailscaleReady": true,
    "hostname": "laptop"
  }
}
```

### Execute command

```bash
curl -X POST http://127.0.0.1:7788/v1/sessions/agent-1/exec \
  -H "Authorization: Bearer $HACK_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command": "bun test"}'
```

This sends the command followed by Enter to the session.

Response:
```json
{
  "status": "sent",
  "session": "agent-1"
}
```

### Send raw input

```bash
curl -X POST http://127.0.0.1:7788/v1/sessions/agent-1/input \
  -H "Authorization: Bearer $HACK_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"keys": "C-c"}'
```

Send raw keystrokes without Enter. Useful for:
- `C-c` (Ctrl+C)
- `C-d` (Ctrl+D)
- `Escape`
- Arrow keys: `Up`, `Down`, `Left`, `Right`
- `Tab`

Note:
- `keys` are passed directly to `tmux send-keys` — there is no zellij branch on this endpoint.

Response:
```json
{
  "status": "sent",
  "session": "agent-1"
}
```

### Stop workspace

```bash
curl -X POST -H "Authorization: Bearer $HACK_GATEWAY_TOKEN" \
  http://127.0.0.1:7788/v1/sessions/agent-1/stop
```

Response:
```json
{
  "status": "stopped",
  "session": "agent-1"
}
```

### Error codes

| Status | Error | Description |
| --- | --- | --- |
| 400 | `invalid_json` | Request body is not valid JSON |
| 400 | `missing_name` | Workspace name not provided |
| 400 | `invalid_name` | Workspace name contains invalid characters |
| 400 | `missing_command` | Command not provided for exec |
| 400 | `missing_keys` | Keys not provided for input |
| 400 | `missing_session_id` | Session ID not in URL |
| 404 | `session_not_found` | Session doesn't exist |
| 409 | `session_exists` | Session already exists (on create) |
| 500 | `create_failed` | Session create failed |
| 500 | `stop_failed` | Session kill failed |
| 500 | `exec_failed` | Session exec failed |
| 500 | `input_failed` | Session input failed |

## Example: Remote agent workflow

> **Status: unsupported experimental.** Like the Daemon sessions API above, this workflow depends
> on the gateway, which is outside the supported v3 product contract and hidden behind
> `hack help --all`. `gateway.example.com` below stands in for whatever tunnel/ingress you put in
> front of the gateway yourself (Cloudflare, Tailscale, SSH port-forward) — hack does not provide
> that ingress.

1. **Create a workspace from your remote client**:
   ```bash
   curl -X POST http://gateway.example.com/v1/sessions \
     -H "Authorization: Bearer $TOKEN" \
     -d '{"name": "agent-task-1", "cwd": "/home/dev/project"}'
   ```

2. **Execute commands**:
   ```bash
   curl -X POST http://gateway.example.com/v1/sessions/agent-task-1/exec \
     -H "Authorization: Bearer $TOKEN" \
     -d '{"command": "git pull && bun install && bun test"}'
   ```

3. **SSH in to check progress**:
   ```bash
   ssh laptop.tail1234.ts.net -t "hack session attach agent-task-1"
   ```

4. **Clean up when done**:
   ```bash
   curl -X POST http://gateway.example.com/v1/sessions/agent-task-1/stop \
     -H "Authorization: Bearer $TOKEN"
   ```
