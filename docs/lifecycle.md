# Lifecycle (startup hooks + host processes)

Many projects need host-side setup around `hack up` (auth, local proxies, tunnels). Lifecycle config lets you run short-lived commands and manage long-running host processes alongside the project runtime.

Lifecycle is configured in `.hack/hack.config.json` under `lifecycle`.

You can also use a shorthand `startup` array for common `hack up` startup flows.

## Why `singleton` exists

Some lifecycle-managed helpers bind fixed local ports and are easy to start outside Hack:

- AWS SSM port-forwarding tunnels
- local API or database proxies
- search/dashboard tunnels

Without an ownership hint, `hack up` can only assume it should launch the configured command again. If a
matching helper is already running manually, or a previous reconnect loop already restored it, that can
create duplicate supervisors, partial port conflicts, or aggressive cleanup/restart churn.

`singleton` exists to make those fixed-port helpers explicit. It gives Hack a conservative rule:

- start the helper when none of its expected listeners exist
- adopt the existing helper when the full listener set is already healthy and the config opts into reuse
- fail fast on partial occupancy instead of trying to replace part of a live tunnel stack

That keeps Hack local-first and predictable. It avoids turning "something equivalent is already running"
into "kill and recreate it", which is especially important for brittle port-forwarding workflows.

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
          "persistent": true,
          "singleton": {
            "ports": [3306, 9200, 9201, 8443, 8444, 8445],
            "onConflict": "adopt"
          }
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
      "persistent": true,
      "singleton": {
        "ports": [3306, 9200, 9201, 8443, 8444, 8445],
        "onConflict": "adopt"
      }
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
- `singleton` optional object with `ports` and optional `onConflict`

`cwd` is always resolved from the repo root (not from `.hack/`).

A `persistent: true` startup entry with no `name` gets a generated name (`startup-1`, `startup-2`, ...
in config order). That generated name is what shows up as the window name and what you pass to
`hack logs <name>`, so naming persistent entries explicitly makes logs easier to find.

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
- `singleton` (optional): local listener policy with:
- `ports` required array of local TCP listener ports
- `onConflict` optional `"adopt"` or `"fail"` (default `"fail"`)

Hooks run on the host as `sh -c <command>`. Failures stop the operation.
Commands inherit the CLI process environment (including PATH), plus resolved project env vars.

`persistent` behavior:
- In `lifecycle.up.before`, `persistent: true` starts the command in the lifecycle mux session and immediately continues to the next hook.
- Ordering is preserved: each persistent hook is started in sequence before moving to later hooks.
- In other hook lists (`up.after`, `down.before`, `down.after`), `persistent` is ignored and the hook runs as a normal blocking command.

`singleton` behavior:
- Hack checks the configured local TCP listener ports before starting the lifecycle process.
- If none of the configured ports are in use, Hack starts the process normally.
- If all configured ports already have listeners and `onConflict` is `"adopt"`, Hack skips startup, records an adoption note, and leaves the external process alone on `hack down`.
- If only some configured ports are already occupied, Hack fails fast instead of launching a competing partial replacement.
- If all configured ports already have listeners and `onConflict` is omitted or `"fail"`, Hack stops with an explicit error so the operator can decide whether to stop or reuse the existing process.

Important boundaries:
- `singleton` is a listener-level guard, not a deep process identity check.
- Adoption means "Hack observed the full expected local listener set and will not start another copy". It does not mean Hack now owns or can safely tear down that external process.
- `hack down` only stops processes Hack actually launched inside the lifecycle session. Adopted external listeners are intentionally left alone.

### Processes

Long-running processes live under `lifecycle.processes` and are objects with:
- `name` (required): stable identifier (used for window naming)
- `command` (required): shell command (run in a mux session shell)
- `cwd` (optional): working directory (defaults to repo root)
- `singleton` (optional): listener-ownership policy with `ports` and `onConflict`

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

Before starting persistent work, Hack reconciles the expected lifecycle session with
`.hack/.internal/lifecycle/state.json`:

- A session whose mux ownership token, saved definition hash, and live process windows all match is
  adopted without starting duplicate processes.
- A token-owned stale session is replaced. Pre-ownership tmux sessions are replaced only when saved
  state, checkout path, creation time, and window count provide deterministic legacy ownership proof.
- A same-name session without matching ownership proof is left untouched and `hack up` fails with an
  actionable collision error.

If the operation later fails in Compose or `up.after`, Hack removes only the lifecycle session created
by that operation. The same exact-token cleanup runs for supported `SIGINT` and `SIGTERM` paths, including
signals received while the mux session is still being initialized.

### `hack down`

1. Run `lifecycle.down.before` hooks.
2. Run `docker compose down`.
3. Stop lifecycle processes by killing the lifecycle session.
4. Run `lifecycle.down.after` hooks.

### `hack restart`

`hack restart` performs the same lifecycle steps as `hack down` followed by `hack up`.
From the primary checkout, it targets only the base Compose/lifecycle instance. A linked worktree uses
its isolated derived branch instance, and `--branch <name>` targets only that explicit branch.

### `--json`

`hack up`, `hack down`, and `hack restart` accept `--json`. A lifecycle hook failure surfaces as
`{ok: false, error: {code: 'E_LIFECYCLE_FAILED', message}}`; a `docker compose` failure surfaces as
`E_COMPOSE_FAILED`. Lifecycle failures are one of the primary consumers of the `--json` error envelope,
since hook and process startup are common failure points around `hack up`.

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
- Current lifecycle sessions carry the same random ownership token in mux metadata and persisted state.
  Cleanup requires an exact token match; deterministic names alone never authorize session teardown.
- For tmux-backed lifecycle sessions, Hack also persists the pane PID and the wrapped command's actual
  process-group metadata to `.hack/.internal/lifecycle/state.json`, with per-hook/process output logged to
  `.hack/.internal/lifecycle/*.log`. If tmux pane state disappears before teardown, `hack down` still uses that persisted metadata to clean up any live lifecycle process groups instead of leaving orphaned host processes behind.
- `hack doctor` reports stale lifecycle state, leaderless process groups, ownership collisions, and
  ownership-proven sessions with no running Compose instance. Recently updated sessions are treated
  as possible in-flight startups for five minutes and stay untouched. `hack doctor --fix` reaps only
  established orphans after rechecking runtime liveness and mux ownership; unverified same-name
  sessions stay untouched.

## Tips

- For long-running setup commands, use either `lifecycle.processes` or `lifecycle.up.before` with `persistent: true`.
- For local proxy/tunnel helpers that bind fixed ports, prefer `singleton.ports` with `onConflict: "adopt"` so `hack up` can reuse an already-running external tunnel instead of racing it.
- Keep non-persistent hooks short and deterministic.
- Store lifecycle secrets in `hack.env.*.yaml` as encrypted `secure:` values and prefer runtime injection over relying on `.hack/.env`.
- If a hook requires interactive auth (e.g. browser-based SSO), it will still work; it runs with `stdin: inherit`.
- Global `--no-interactive` (or `HACK_NO_INTERACTIVE=1`) affects only the env-prompt step in `hack up`
  (step 1 above): with prompting disallowed, missing required env is never prompted for — the run
  fails fast with an actionable error instead of blocking on a prompt, following the same
  `--no-interactive` convention used across the CLI (documented defaults or `E_INTERACTIVE_REQUIRED`).
  It does not change hook `stdin` behavior — a hook that itself blocks on interactive auth still
  blocks under `--no-interactive`.
