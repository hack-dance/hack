# Lifecycle (startup hooks + host processes)

Many projects need host-side setup around `hack up` (auth, local proxies, tunnels). Lifecycle config lets you run short-lived commands and manage long-running host processes alongside the project runtime.

Lifecycle is configured in `.hack/hack.config.json` under `lifecycle`.

## Config

```json
{
  "lifecycle": {
    "up": {
      "before": [
        { "name": "aws sso login", "command": "aws sso login", "cwd": "." }
      ],
      "after": []
    },
    "down": {
      "before": [],
      "after": []
    },
    "processes": [
      {
        "name": "aws-proxy",
        "command": "bun run dev:aws-proxy",
        "cwd": "."
      }
    ]
  }
}
```

### Hooks

Hook lists live under:
- `lifecycle.up.before`
- `lifecycle.up.after`
- `lifecycle.down.before`
- `lifecycle.down.after`

Each entry can be either:
- a string (shell command), or
- an object:
  - `name` (optional): label for logs
  - `command` (required): shell command
  - `cwd` (optional): working directory; relative paths are resolved from repo root

Hooks run on the host as `sh -lc <command>`. Failures stop the operation.

### Processes

Long-running processes live under `lifecycle.processes` and are objects with:
- `name` (required): stable identifier (used for window naming)
- `command` (required): shell command (run via `sh -lc`)
- `cwd` (optional): working directory (defaults to repo root)

Processes receive the resolved env contract (see `env.md`) as their environment.

## Runtime behavior

### `hack up`

1. Resolve env contract (and optionally prompt for missing required env in interactive shells).
2. Run `lifecycle.up.before` hooks.
3. Start lifecycle processes (if any) inside a dedicated session.
4. Run `docker compose up` (or `up -d` when `--detach`).
5. Run `lifecycle.up.after` hooks.

### `hack down`

1. Run `lifecycle.down.before` hooks.
2. Run `docker compose down`.
3. Stop lifecycle processes by killing the lifecycle session.
4. Run `lifecycle.down.after` hooks.

### `hack restart`

`hack restart` performs the same lifecycle steps as `hack down` followed by `hack up`.

## Sessions backend

Lifecycle processes run inside the configured mux backend (tmux or zellij), using the same selection rules as `hack session`.

Config:
- Project: `.hack/hack.config.json` → `sessions.mux = auto|tmux|zellij|none`
- Env override: `HACK_SESSIONS_MUX=auto|tmux|zellij|none`

Lifecycle session name:
- No branch: `<project>--lifecycle`
- With `--branch <name>`: `<project>--lifecycle-<branch>`

Notes:
- If no mux backend is available, lifecycle process startup fails with an actionable error.
- Teardown is implemented by killing the lifecycle session; anything running inside that session will be stopped.

## Tips

- Keep `up.before` hooks short and deterministic; prefer long-running things as `processes`.
- Use `source: "keychain"` in the env contract for secrets and keep `.hack/.env` non-sensitive.
- If a hook requires interactive auth (e.g. browser-based SSO), it will still work; it runs with `stdin: inherit`.

