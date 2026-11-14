# Always-on projects

Autostart is a choice for this machine. Project configuration cannot enable it. Install
Hack's per-user login service, then mark a registered project:

```sh
hack daemon install
hack autostart add --project sample
hack autostart add --project sample --branch preview
hack autostart list --json
```

Each project has one selected instance: base by default, or the named branch.
Adding it again replaces that selection. In the project directory, omit `sample`.
Opt in from the primary checkout. Linked-worktree opt-in is refused in this slice:
a branch instance uses the primary checkout's code, not a different Git checkout.
`hack up -d --always` marks the selected instance and starts it now. `add` only
changes the marker; it does not start anything immediately.

`hack down` pauses autostart for the selected marked instance before attempting to
stop it. For a renamed linked-worktree branch, ownership reconciliation selects
the existing instance before its pause is written; the same selected branch is
used for the start/stop lock and teardown. Start and stop serialize on a machine-local instance lock: `down` waits
for an in-flight login start, then stops it before returning success. The login
child checks trusted intent under that lock and immediately before starting
containers. This auxiliary lock covers login starts and Compose stops, including a stop
after a marker was removed while startup was in flight. Ordinary manual starts
do not hold it, so a long manual image build cannot block `down` on this lock. A later `hack up` clears the pause. Pausing does not stop running services:

```sh
hack autostart pause --project sample
hack autostart resume --project sample
hack autostart pause                    # globally pause automatic starts
hack autostart resume                   # resume the global startup policy
hack autostart remove --project sample  # forget the marker; leave services alone
```

The positional project spelling remains accepted. All commands accept
`--json --no-interactive`; mutations return the usual `{ok,data}` or
`{ok:false,error}` envelope. `list --json` returns a bare object.
Global pause also covers projects marked afterwards. Global resume preserves
projects paused by a manual `down`; start one with `hack up` or explicitly
`hack autostart resume --project sample` to clear that manual pause.

## At login

![Login startup sequence](diagrams/autostart-login.svg)

Only a daemon launched by the installed login service runs the automatic pass.
A daemon started manually or implicitly by another CLI command does not replay
projects. To run the pass deliberately, use `hack autostart run --no-interactive`
(optionally `--json`). Both entry points respect the same per-boot claims.
This slice supports Compose projects on Linux and macOS. Native-runtime startup
is skipped as `native_unsupported` before probing Docker.

The daemon waits up to ten minutes for Docker, backing off from two seconds to
thirty seconds between probes. Configure the service bound with
`hack config set --global controlPlane.daemon.autostartEngineWaitMs 900000`
(1–3600000 milliseconds; restart the daemon to apply); an explicit
run also accepts `--engine-wait-ms`. While waiting, JSON reports
`login_run.waiting_for_engine: true`. An engine timeout consumes no project
claims. The service daemon retries when its regular engine observation detects
Docker later in the same boot. Global routing starts only if its installed
`caddy/docker-compose.yml` exists in the machine's Hack home,
then unpaused projects are considered in name/ID order. Starts are at least
500 milliseconds apart, with at most two in progress. Each uses the running
daemon's CLI executable and the ordinary `up -d --no-interactive` path.
Children receive a fixed environment allow-list and an executable search
path built from system directories and known Bun, Hack and Docker directories
under the owned home (plus Linux `.local/bin`); launching-shell `DOCKER_*`, `COMPOSE_*` and `HACK_*` overrides are not copied.
Hack adds only its explicit internal noninteractive and identity settings.
Only automatic passes check the derived executable path before helper
lookup too. Directories, executable files and symlink targets must satisfy the
same read-only ownership and permission checks used by the Linux service; unsafe
paths are refused without automatic permission repair. This strict policy also
applies to group-writable Homebrew directories, including group `admin`: install
required helpers in a trusted lookup directory before retrying. A refused search
path does not consume a project's attempt for this boot.
The daemon keeps its installed PATH and continues normal status observation;
automatic-start refusal does not change ordinary daemon operation.
The strict policy also applies to Linux user-private groups. Check `hack doctor`
for the affected trust category. After reviewing ownership and who belongs to the
group, remove group/other write only on the intended files and directories with
`chmod go-w <reviewed-path>`; do not recursively change a shared checkout or
Homebrew installation. Using a private checkout and private tool installation is
an alternative. Hack never changes those permissions automatically.
Use `umask 022` in shells that run `hack up` so changed generated inputs retain
safe modes; with umask 002, a later manual start can recreate group-writable
generated files and require another review before automatic startup.
This restriction can also affect Docker Desktop and OrbStack: their CLI and
Compose plugin links can point into app bundles beneath group-writable
`/Applications`. Such installations are refused by the automatic path even when
manual Docker works. Do not change `/Applications` permissions as an automatic
repair; use reviewed private tools or keep starting projects manually.
Already-running instances are adopted without repeating startup hooks. An unknown
runtime state is skipped rather than taken as proof that the instance is down.

Automatic routing accepts only the already-installed files produced by this
CLI's current Caddy, CoreDNS, logging, Grafana and schema templates. It checks
ownership, file type and every directory component, refuses symlinks and unsafe
parent directories, and compares bounded reads with those templates. All files
must pass before matching non-secret bytes are republished on fresh `0644` inodes,
so container users can read them while other host users cannot write them. Routing
and logging containers are recreated to bind those new files; an old open writer
or old file mount cannot modify the new assets. Compose `.env` imports and the
unsupported remote-route bridge are disabled for this automatic path.
Customized, outdated, missing or unsafe assets cause `routing_failed` and no
project starts. This path does not install or migrate assets. Review the paths,
preserve suspect files outside the active installation, secure their parent
directories, and regenerate the installed files with `hack global install`
before another login pass. Unexpected files in the mounted `schemas` or Grafana
`dashboards` directories must be reviewed and moved outside those directories;
reinstallation alone does not remove extra files. Ordinary manual routing commands keep their behavior.
Adoption requires a running container. An exited-zero container is treated as a
completed job only when its service is a dependency target explicitly declared
with `condition: service_completed_successfully`; other stopped services require
`up`. Adoption also requires every service in the selected default-profile model
to have a container, including required dependency targets. A missing service
runs the normal `up` path. This slice reads the primary Compose file; branch
overrides, declared `scale` or `deploy.replicas`, explicit Compose file/profile
overrides and unsupported composition
cannot prove adoption, so they run ordinary `up` and may repeat startup hooks.
Managed environment metadata and dotenv inputs also require ordinary `up`;
adoption never decrypts environment values to guess the selected graph.

Before project input discovery and again under the instance start lock, login
checks that the checkout and project-directory ancestor chains belong to the
current user or root and cannot be replaced by other users. The check repeats
before container startup. A shared writable parent is refused even when the
saved registry pathname still matches. Startup configuration, Compose and environment
input files and their symlink targets also require trusted ownership and modes;
generated JSON/YAML/env inputs under `.hack/.internal` and `.hack/.branch` are included.
protected directories alone do not make a writable lifecycle configuration safe.
Normal owner Git updates remain allowed. This is not a recursive audit of all
repository code a hook or build may execute.

Docker's `config.json` and context metadata/TLS paths must likewise be owned by
the current user or root and not writable by other users. These checks inspect
filesystem metadata without exposing credentials, and repeat in login children
before runtime startup. Unsafe engine selection refuses without consuming a boot
attempt; owner-controlled context changes remain supported.
Docker Compose plugin directories and their executables receive the same checks.
A Docker config with `cliPluginsExtraDirs` requires manual startup; automatic
startup parses only this policy setting and never reports credential fields.

No terminal or keychain prompt is allowed. Missing keys, required interaction,
pending env migration, unavailable project paths and startup failures produce a
recorded result. Run `hack up` manually to investigate and recover. The daemon does
not install routing, start Docker, sign in, or migrate configuration at login.
Before trusting intent, Hack opens `projects.json` without following links and
requires a regular file owned by the current user, with no group or other write
access. On first opt-in, an unmarked legacy registry that is a regular file owned
by the user is atomically replaced with a fresh `0600` file, with a one-line
notice. The selected checkout must be independently observed from the current
directory before legacy paths can authorize startup. For first opt-in from a
legacy registry, change into the reviewed checkout and run `hack autostart add`
or `hack up -d --always`. Other copied registrations retain a review requirement
until they are opted in from their own checkout. Trusted named targets continue
to work from other directories. The old inode is never reused, so an already-open writer cannot change
the replacement. This migration refuses symlinks, foreign ownership, malformed
registries and preexisting intent in an unsafe file. Ordinary registration and
prune operations keep their lenient handling of malformed unmarked records and
worktree metadata, including
replacing a registry symlink itself with a regular file while leaving its target
unchanged. They retain review requirements on copied paths; this does not
authorize autostart. That check repeats at every autostart read and mutation. Unsafe registry
permissions refuse startup. Do not repair a formerly writable registry with
in-place `chmod`: another user's already-open writer descriptor remains writable.
Preserve the old file outside the active registry, start with a fresh registry,
register the projects again, and re-enable only reviewed projects. Do not copy
untrusted markers into the replacement. Hack publishes fresh registry files with
mode `0600`. Ordinary project listings remain readable for diagnosis.
The trust check observes current file ownership and mode; it cannot recover the
history of arbitrary external permission changes or revoke an existing writer.

A claim is saved before each attempt, once per OS boot. Restarting the daemon in
the same boot does not repeat starts. A crash after the claim can leave an
interrupted attempt; its outcome is unknown, so this slice requires manual
`hack up` recovery. A new boot permits a new attempt. An unavailable boot identity records a refusal
without replacing a prior claim, so recovering the probe cannot replay an
already-attempted project. Resume permits the next login
attempt; use `hack up` to start immediately.
A routing failure consumes that boot's attempt; an engine timeout does not.
A start has a 120-second bound, then receives TERM and a five-second grace before
KILL. Detached Compose phases forward cancellation and settle their own process
groups before releasing startup ownership. Partial startup remains possible;
inspect and recover with `hack up`.

`HACK_DAEMON_AUTOSTART_DISABLE=1` disables this pass as well as implicit daemon
startup. Test harnesses and the isolated `hack-v5` launcher set it; those runs do
not start marked projects. Use the installed CLI/service for login startup.

This first slice starts projects once. It does not restart a project after failure
or replace terminal-based lifecycle supervision. Persistent host helpers retain
the existing [lifecycle](lifecycle.md) behavior. On Linux, service-origin starts
run in independent transient user scopes, so their host helpers survive daemon
stop/restart while the daemon retains `KillMode=control-group`. Failure to create
a scope refuses the start rather than falling back into the daemon cgroup.
Linux's systemd user service starts
at login; startup before login requires separately opting into user lingering.
No system service or `sudo` is needed for Hack's login service.

## JSON contract

`hack projects --json`, `hack status --json`, and `/v1/projects` include an
`autostart` object for every project, including summary views and unmarked
projects. `hack autostart list --json` returns marked registrations. All these
payloads include the same top-level `autostart_global` object:

```json
{
  "projects": [{
    "project_id": "example-id",
    "name": "sample",
    "autostart": {
      "enabled": true,
      "state": "on",
      "paused_reason": null,
      "failures": {
        "count": 0,
        "last_at": null,
        "failed_services": [],
        "last_error_code": null
      },
      "max_failures": 3,
      "branch": null,
      "paused": false,
      "last_result": null
    }
  }],
  "autostart_global": {
    "paused": false,
    "login_run": {
      "in_progress": false,
      "started_at": null,
      "pending": [],
      "started": [],
      "failed": [],
      "waiting_for_engine": false
    },
    "service_ready": false
  }
}
```

`enabled` is false and `state` is `off` for an unmarked project. State is `on`
for an enabled project, `paused` after a manual stop or global pause, or `starting` while the
project is pending in an active login run. Invalid markers use `needs_attention`.
`paused_reason` is `manual_stop` for an individual pause and otherwise `null`.
`failures` has the empty values above in this first slice; `max_failures: 3`
reserves the keep-up retry bound, but no retries run in this slice. Explicit
project resume clears the pause and failure state. The keep-up slice will use
the same fields for failure counts and `needs_attention` after exhausting retries.

Global `paused` is an independent machine setting. Login-run arrays contain
stable project IDs: pending includes queued and active attempts, started includes
started and already-running projects, and failed includes real startup failures
and refusals such as a missing key. Engine waiting and timeout leave the queue
unclaimed and do not count as failures. Manual/global pauses,
cancellation and target changes leave the queue without being marked failed.
An interrupted run is closed before the next daemon startup; it does
not authorize repeating a claimed start. `started_at` is `null` before the first
run or its ISO 8601 start time. `service_ready` means a login-service file is
installed for this invocation; it does not prove manager readiness, unit
freshness, or a real login run. A launcher that disables autostart reports false.
After a daemon crash, persisted progress can remain `starting` until the daemon
starts again and closes the interrupted run. Invalid global policy fails closed
as globally paused; an explicit global resume repairs it.

The additive `branch` field is `null` for base or a branch-instance slug.
`paused` reflects the individual marker, separate from global pause.
`last_result` is `null` before any recorded attempt, otherwise its `status` is
`started`, `already_running`, `skipped`, or `failed`; `reason` is `null` on success
or a machine-readable code; `at` is an ISO 8601 timestamp. Reasons never contain
command output, environment values or credentials. Consumers should display an
unknown future reason as a generic failure and retain its code. These fields are
additive and stable; internal boot claims are not part of this public contract.

Current skip reasons are `engine_timeout`, `routing_failed`,
`boot_identity_unavailable`, `native_unsupported`, `runtime_unknown`,
`interactive_required`, `env_key_missing`, `keychain_unavailable`,
`pending_env_migration`, `project_unavailable`, `checkout_untrusted`,
`executable_path_untrusted`, `docker_config_untrusted`, `paused`, `target_changed`,
`daemon_stopped`, `global_paused`, and `invalid_marker`. Failure reasons are `start_failed`,
`start_timeout`, and `output_limit`.

An invalid or newer marker is shown as `needs_attention` with `skipped/invalid_marker` and
the sentinel timestamp `1970-01-01T00:00:00.000Z` (no attempt occurred). Other
project commands keep working and unrelated registry writes preserve the original
marker. Remove and re-add it with `hack autostart remove sample` then
`hack autostart add sample` to repair it. Unknown future statuses fail closed in
this version rather than enabling startup.

`hack doctor` warns when a project is marked but no login-service file exists and
names `hack daemon install`. File presence alone does not prove a real login run
or that the operating system enabled the service.

Older Hack versions sharing this machine registry can drop markers and global
policy on their next write. This fails closed but loses opt-ins; avoid mixing
versions until the upgrade-handling slice supplies compatibility diagnostics.
The service-presence check also cannot yet prove its executable supports
autostart; reinstall the service with this CLI after upgrading.

The fixed login environment does not support an engine available only through
a shell `DOCKER_HOST` override (including some rootless setups). Configure a
working default Docker context for the service account; shell overrides are
never copied. Avoid explicit `autostart run` while a service pass is active:
claims prevent duplicate project attempts, but concurrent passes do not share
one dispatch cap in this slice.

An explicit upgrade snapshot rollback restores the registry at snapshot time.
With `--overwrite` that can also restore old pauses and boot claims; it does not
merge newer machine intent. An overwrite rollback can undo a global pause as well. Review and reapply the
restored machine intent before allowing another login pass. Upgrade-aware state reconciliation
is part of HACK-2216.
