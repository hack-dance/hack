# Sessions

Sessions provide a way to manage persistent terminal workspaces using tmux. They're designed for:
- **Remote access**: SSH into your machine and attach to an existing workspace
- **Agent execution**: Run long-running agents in isolated tmux sessions
- **Multi-terminal workflows**: Keep multiple project contexts alive across sessions

## Quick start

```bash
# Interactive session picker (shows sessions + projects)
hack session

# Start a session for a project
hack session start <project>

# List all sessions
hack session list

# Attach to an existing session
hack session attach <session>

# Run a command in a session
hack session exec <session> "npm test"

# Stop a session
hack session stop <session>

# Capture recent output
hack session capture <session>

# Tail session output for a short window
hack session tail <session>
```

## Session management

### Interactive picker

Running `hack session` without arguments opens an interactive picker showing:
- **Active sessions**: Attached and detached tmux sessions
- **Available projects**: Registered projects without active sessions

When selecting an attached session, you can choose to:
- **Attach**: Detach other clients and take over the session
- **Create new**: Start a new numbered session (e.g., `project:2`)

### Creating sessions

```bash
# Start session for a project (creates or attaches)
hack session start my-project

# Force create a new numbered session
hack session start my-project --new

# Create with custom name suffix
hack session start my-project --name agent-1
# Creates: my-project:agent-1

# Run `hack up -d` before attaching
hack session start my-project --up
```

Sessions are created at the project's repo root, not the `.hack/` directory.

### Attaching to sessions

```bash
# Attach to an existing session
hack session attach my-project

# From inside tmux, this switches to the session instead of nesting
```

When attaching, the `-d` flag detaches other clients to avoid terminal size conflicts when multiple devices are connected.

### Executing commands

```bash
# Send a command to a running session
hack session exec my-project "npm run dev"

# This sends the command + Enter to the session's active pane
```

### Capturing output

`hack session capture` emits NDJSON events by default for machine parsing (start/log/end). Use `--pretty` for raw pane output.

```bash
# Capture last 200 lines (default) as NDJSON
hack session capture my-project

# Capture a specific pane target and line count
hack session capture my-project --target my-project:0.1 --lines 500

# Human-friendly raw output
hack session capture my-project --pretty
```

### Tailing output

`hack session tail` also emits NDJSON events by default and stops after `--max-ms` (default 5000).

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

# Connect directly to a session
hack ssh my-session
```

### What `hack ssh` shows

1. **SSH command**: Copy-paste command to connect
2. **QR code**: Scan with mobile SSH apps (Blink, Termius)
3. **Active sessions**: List of tmux sessions on this machine
4. **Action picker**: Done or connect to a session

### Tailscale setup

If Tailscale is stopped or not connected, `hack ssh` will prompt to start it:

```
Tailscale is stopped
? Turn on Tailscale? › yes
Starting Tailscale...
Tailscale connected!
```

### Terminal size conflicts

When multiple clients attach to the same tmux session, terminal size can get messed up. The session commands use `tmux attach -d` to detach other clients, avoiding this issue.

If you're already in tmux and want to switch sessions without detaching:

```bash
# Inside tmux: prefix + s to open session switcher
# Or use the tmux command:
tmux switch-client -t <session>
```

## Daemon sessions API

The hack daemon exposes a REST API for managing tmux sessions programmatically. This is useful for:
- Remote session control via the gateway
- Building automation tools
- Agent orchestration

See the [Gateway API](gateway-api.md) for authentication and endpoint details.

### Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/v1/sessions` | List all tmux sessions |
| POST | `/v1/sessions` | Create a new session |
| GET | `/v1/sessions/:id` | Get session details |
| POST | `/v1/sessions/:id/stop` | Stop (kill) a session |
| POST | `/v1/sessions/:id/exec` | Execute command in session |
| POST | `/v1/sessions/:id/input` | Send raw keystrokes |

### List sessions

```bash
curl http://127.0.0.1:7788/v1/sessions
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

### Create session

```bash
curl -X POST http://127.0.0.1:7788/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{"name": "agent-1", "cwd": "/path/to/project"}'
```

Request body:
| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Session name (alphanumeric, dash, underscore, dot) |
| `cwd` | string | no | Working directory |

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

### Get session

```bash
curl http://127.0.0.1:7788/v1/sessions/agent-1
```

Response includes connection info for SSH access:
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
  -H "Content-Type: application/json" \
  -d '{"command": "npm test"}'
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
  -H "Content-Type: application/json" \
  -d '{"keys": "C-c"}'
```

Send raw keystrokes without Enter. Useful for:
- `C-c` (Ctrl+C)
- `C-d` (Ctrl+D)
- `Escape`
- Arrow keys: `Up`, `Down`, `Left`, `Right`
- `Tab`

Response:
```json
{
  "status": "sent",
  "session": "agent-1"
}
```

### Stop session

```bash
curl -X POST http://127.0.0.1:7788/v1/sessions/agent-1/stop
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
| 400 | `missing_name` | Session name not provided |
| 400 | `invalid_name` | Session name contains invalid characters |
| 400 | `missing_command` | Command not provided for exec |
| 400 | `missing_keys` | Keys not provided for input |
| 400 | `missing_session_id` | Session ID not in URL |
| 404 | `session_not_found` | Session doesn't exist |
| 409 | `session_exists` | Session already exists (on create) |
| 500 | `create_failed` | tmux create failed |
| 500 | `stop_failed` | tmux kill failed |
| 500 | `exec_failed` | tmux send-keys failed |
| 500 | `input_failed` | tmux send-keys failed |

## Example: Remote agent workflow

1. **Create a session from your remote client**:
   ```bash
   curl -X POST http://gateway.example.com/v1/sessions \
     -H "Authorization: Bearer $TOKEN" \
     -d '{"name": "agent-task-1", "cwd": "/home/dev/project"}'
   ```

2. **Execute commands**:
   ```bash
   curl -X POST http://gateway.example.com/v1/sessions/agent-task-1/exec \
     -H "Authorization: Bearer $TOKEN" \
     -d '{"command": "git pull && npm install && npm test"}'
   ```

3. **SSH in to check progress**:
   ```bash
   ssh laptop.tail1234.ts.net -t "tmux attach -t agent-task-1"
   ```

4. **Clean up when done**:
   ```bash
   curl -X POST http://gateway.example.com/v1/sessions/agent-task-1/stop \
     -H "Authorization: Bearer $TOKEN"
   ```
