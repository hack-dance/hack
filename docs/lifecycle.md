# Lifecycle (startup hooks + host processes)

Many projects need host-side setup around `hack up` (auth, local proxies, tunnels). Lifecycle config lets you run short-lived commands and manage long-running host processes alongside the project runtime.

Lifecycle is configured in `.hack/hack.config.json` under `lifecycle`.

You can also use a shorthand `startup` array for common `hack up` startup flows.

## Config

```json
{
  "$schema": "https://schemas.hack/hack.config.schema.json",
  "lifecycle": {
    "up": {
      "before": [
        { "name": "aws sso login", "command": "aws sso login", "cwd": "." },
        {
          "name": "aws-ssm-proxy",
          "command": "bun run proxy",
          "cwd": "packages/infra",
          "persistent": true
        }
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

## Startup shorthand

`startup` is a concise alias for startup hooks/processes:

- `persistent: false` (default) maps to `lifecycle.up.before`
- `persistent: true` maps to `lifecycle.processes`

```json
{
  "$schema": "https://schemas.hack/hack.config.schema.json",
  "startup": [
    {
      "name": "aws sso",
      "run": "aws sso login",
      "persistent": false
    },
    {
      "name": "aws-ssm-proxy",
      "run": "cd packages/infra && bun run proxy",
      "persistent": true
    }
  ]
}
```

Each startup item can be:

- a string command (one-shot startup hook), or
- an object with:
- `run` (or `command`) required
- `name` optional
- `cwd` optional
- `persistent` optional boolean (default `false`)

`cwd` is always resolved from the repo root (not from `.hack/`).

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
- `persistent` (optional): `true` means "start this as a managed lifecycle process"

Hooks run on the host as `sh -c <command>`. Failures stop the operation.
Commands inherit the CLI process environment (including PATH), plus resolved project env vars.

`persistent` behavior:
- In `lifecycle.up.before`, `persistent: true` starts the command in the lifecycle mux session and immediately continues to the next hook.
- Ordering is preserved: each persistent hook is started in sequence before moving to later hooks.
- In other hook lists (`up.after`, `down.before`, `down.after`), `persistent` is ignored and the hook runs as a normal blocking command.

### Processes

Long-running processes live under `lifecycle.processes` and are objects with:
- `name` (required): stable identifier (used for window naming)
- `command` (required): shell command (run in a mux session shell)
- `cwd` (optional): working directory (defaults to repo root)

Processes receive the resolved env contract (see `env.md`) as their environment.

## Visibility

Lifecycle output is now surfaced across CLI/runtime views:

- `hack logs` includes lifecycle hook/process output alongside compose logs.
- `hack logs <service>` supports lifecycle service names, including persistent process names.
- `hack projects --details` includes a `Startup & lifecycle` section with hooks + persistent processes.
- Runtime inventories include persistent lifecycle processes as synthetic services.
- The macOS project detail view includes a `Startup & Lifecycle` section in the main project overview.

## Runtime behavior

### `hack up`

1. Resolve env contract (and optionally prompt for missing required env in interactive shells).
2. Run `lifecycle.up.before` hooks in order.
3. For `up.before` hooks with `persistent: true`, start each as a managed lifecycle process and continue immediately.
4. Start lifecycle processes (if any) inside the same dedicated lifecycle session.
5. Run `docker compose up` (or `up -d` when `--detach`).
6. Run `lifecycle.up.after` hooks.

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

- For long-running setup commands, use either `lifecycle.processes` or `lifecycle.up.before` with `persistent: true`.
- Keep non-persistent hooks short and deterministic.
- Store lifecycle secrets in `hack.env.*.yaml` as encrypted `secure:` values and prefer runtime injection over relying on `.hack/.env`.
- If a hook requires interactive auth (e.g. browser-based SSO), it will still work; it runs with `stdin: inherit`.
