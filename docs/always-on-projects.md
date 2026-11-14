# Always-on projects

Autostart is a choice for this machine. A repository cannot enable it. Install
Hack's per-user login service, then mark a registered project:

```sh
hack daemon install
hack autostart add sample
hack autostart add sample --branch preview
hack autostart list --json
```

Each project has one selected instance: base by default, or the named branch.
Adding it again replaces that selection. In the project directory, omit `sample`.
Opt in from the primary checkout. Linked-worktree opt-in is refused in this slice:
a branch instance uses the primary checkout's code, not a different Git checkout.
`hack up -d --always` marks the selected instance and starts it now. `add` only
changes the marker; it does not start anything immediately.

`hack down` pauses autostart for the selected marked instance before attempting to
stop it. A later `hack up` clears the pause. Pausing does not stop running services:

```sh
hack autostart pause sample
hack autostart resume sample
hack autostart pause          # all marked projects
hack autostart resume         # all marked projects
hack autostart remove sample # forget the marker; leave running services alone
```

## At login

![Login startup sequence](diagrams/autostart-login.svg)

The pass runs at the first `hackd` start in each OS boot. The installed service
normally starts it at login; starting the daemon manually or through a
daemon-backed CLI command can also trigger it. This slice supports Compose
projects on Linux and macOS. Native-runtime startup is skipped as
`native_unsupported` before probing Docker.

The daemon waits up to 60 seconds for Docker, starts global routing only if it is
already installed, then considers unpaused projects in name/ID order. Starts are
at least 500 milliseconds apart, with at most two in progress. Each uses the
running daemon's CLI executable and the ordinary `up -d --no-interactive` path.
Already-running instances are adopted without repeating startup hooks. An unknown
runtime state is skipped rather than taken as proof that the instance is down.
Adoption requires a running container. An exited-zero container is treated as a
completed job only when its service is a dependency target explicitly declared
with `condition: service_completed_successfully`; other stopped services require
`up`. This slice reads that declaration from the primary Compose file.

No terminal or keychain prompt is allowed. Missing keys, required interaction,
pending env migration, unavailable project paths and startup failures produce a
recorded result. Run `hack up` manually to investigate and recover. The daemon does
not install routing, start Docker, sign in, or migrate configuration at login.

A claim is saved before each attempt, once per OS boot. Restarting the daemon in
the same boot does not repeat starts. A crash after the claim can leave an
interrupted attempt; its outcome is unknown, so this slice requires manual
`hack up` recovery. A new boot permits a new attempt. Resume permits the next login
attempt; use `hack up` to start immediately.
An engine timeout or routing failure also consumes that boot's attempt. If Docker
is slow to become ready, start the projects with `hack up` after it is ready.

`HACK_DAEMON_AUTOSTART_DISABLE=1` disables this pass as well as implicit daemon
startup. Test harnesses and the isolated `hack-v5` launcher set it; those runs do
not start marked projects. Use the installed CLI/service for login startup.

This first slice starts projects once. It does not restart a project after failure
or replace terminal-based lifecycle supervision. Persistent host helpers retain
the existing [lifecycle](lifecycle.md) behavior. Linux's systemd user service starts
at login; startup before login requires separately opting into user lingering.
No system service or `sudo` is needed for Hack's login service.

## JSON contract

`hack projects --json` and `hack status --json` add `autostart` to every project,
including summary views. It is `null` for unmarked projects. `hack autostart list
--json` returns `{ "projects": [...] }` containing only marked registrations; each
entry has `project_id`, `name`, and the same `autostart` object:

```json
{
  "project_id": "example-id",
  "name": "sample",
  "autostart": {
    "branch": null,
    "paused": false,
    "last_result": {
      "status": "skipped",
      "reason": "engine_timeout",
      "at": "2026-01-01T00:00:00.000Z"
    }
  }
}
```

`branch` is `null` for base or a branch-instance slug. `paused` is a boolean.
`last_result` is `null` before any recorded attempt, otherwise its `status` is
`started`, `already_running`, `skipped`, or `failed`; `reason` is `null` on success
or a machine-readable code; `at` is an ISO 8601 timestamp. Reasons never contain
command output, environment values or credentials. Consumers should display an
unknown future reason as a generic failure and retain its code. These fields are
additive and stable; internal boot claims are not part of this public contract.

Current skip reasons are `engine_timeout`, `routing_failed`,
`boot_identity_unavailable`, `native_unsupported`, `runtime_unknown`,
`interactive_required`, `env_key_missing`, `keychain_unavailable`,
`pending_env_migration`, `project_unavailable`, `paused`, `target_changed`,
`daemon_stopped`, and `invalid_marker`. Failure reasons are `start_failed`,
`start_timeout`, and `output_limit`.

An invalid or newer marker is shown as paused with `skipped/invalid_marker` and
the sentinel timestamp `1970-01-01T00:00:00.000Z` (no attempt occurred). Other
project commands keep working and unrelated registry writes preserve the original
marker. Remove and re-add it with `hack autostart remove sample` then
`hack autostart add sample` to repair it. Unknown future statuses fail closed in
this version rather than enabling startup.

`hack doctor` warns when a project is marked but no login-service file exists and
names `hack daemon install`. File presence alone does not prove a real login run
or that the operating system enabled the service.
