# Native backend (beta): what works and known limits

The native backend supports part of what Compose supports. When a project needs
something outside that part, Hack refuses and tells you. It does not guess, and it
does not fall back to Docker without telling you.

Rows labelled next.17 need next.17 or later. An installed next.16 bundle keeps
its older behavior.

## Platform

| Platform | Native backend |
| --- | --- |
| Apple Silicon macOS | Supported, through `hack-next` |
| Intel macOS | Not supported. The installer refuses before changing anything. |
| Linux and Windows | Not supported. Use the Compose backend. |
| Stable `hack` (Homebrew or the release installer) | Does not contain the native backend |

## Commands on native

These are the current Apple Silicon prerelease forms. The refusal column
covers the listed gaps. Other failures, such as missing setup or an unready
service, have their own codes.

| Command | Supported on native | Refusal for unsupported forms | What a Compose project can use that native lacks |
| --- | --- | --- | --- |
| `hack up` | Whole project or selected services from a Compose file, in the foreground, with `--detach`, or with `--json` (detached) | `E_USAGE` for `--target`; authored native projects still refuse service selection | Use a remote target. See the configuration gaps below. |
| `hack restart` | Whole project in the foreground. Since next.22, Compose-backed projects also support detached restart through `--json`. | `E_USAGE` for service selection or `--target` on Compose-backed projects. Authored projects return `E_NATIVE_PROJECT_UNSUPPORTED` for those forms and for `--json`. The parser rejects `--detach` on either backend. | Restart selected services or target another host. |
| `hack down`, `hack down --recover` | Whole-project stop and explicit recovery for an interrupted native run | `E_NATIVE_PROJECT_UNSUPPORTED` for authored `down --json` or env/profile overrides | Use JSON for ordinary stops with an authored project. Native recovery applies to native owners. |
| `hack ps` | Status and `--json` | `E_NATIVE_PROJECT_UNSUPPORTED` for an authored `ps --profile` | Select Compose profiles when listing services. |
| `hack logs` | Finite snapshots and live follow under verification. Compose-backed projects accept a service name or all services. Authored projects require one service. | `E_USAGE` for `--loki`, `--services`, `--query`, `--until` and `--pretty`. Authored projects without a service return `E_NATIVE_PROJECT_UNSUPPORTED`. | Query Loki history, choose several services with `--services`, and use Compose log formatting and line-size controls. |
| `hack exec` | One running service, with a TTY in a foreground terminal or finite exec with closed stdin | `E_USAGE` for env/profile overrides on Compose-backed projects. On authored projects, nonempty overrides return `E_NATIVE_PROJECT_UNSUPPORTED`. | Pass Compose selection flags. Native exec uses the running service environment. |
| `hack run` | One-off commands for eligible services. Compose-backed native one-offs cannot use source, data or private env mounts. | `E_USAGE` for empty env/profile selections or a selection that conflicts with the running Compose-backed instance. Authored input has its own admission checks. | Use one-off containers with the service's source and data mounts. |
| `hack config validate`, `hack config plan`, `hack config import --dry-run` | Read-only configuration checks and previews | Input-specific diagnostics | These commands preview or validate native configuration. |
| `hack config adopt`, including `--dry-run` | Compose backend required | `E_NATIVE_PROJECT_UNSUPPORTED` | Adopt eligible legacy configuration and existing Docker data volumes. |

See [native authored commands](../reference/native-authored-commands.md) for the
authored project contract and [the native reference](../guides/native-candidate.md#frontend-integration-status)
for other frontend operations.

## Native startup limits

- Detached `up` (including `--json`) starts with a 15-minute budget and a
  60-minute ceiling. Image builds and loads pause the budget. The ceiling
  continues to count wall time. Set `HACK_NATIVE_DETACHED_START_TIMEOUT_MS` or
  `HACK_NATIVE_DETACHED_START_CEILING_MS` in milliseconds (at least 1000).
  Invalid settings give `E_USAGE`. Expiry gives `E_STARTUP_TIMEOUT`.
- For a Compose-backed native project, the graph readiness limit defaults to
  300 seconds. Use `native.startTimeoutSeconds` in `.hack/hack.config.json`
  or override it with `HACK_NATIVE_START_TIMEOUT_SECONDS`. Values must be whole
  seconds from 60 to 600. Invalid settings give `E_CONFIG_INVALID`. The
  runtime reports expiry as `graph_timeout`.
- Authored native startup uses `HACK_COMPOSE_STARTUP_TIMEOUT_MS` with a
  90,000 ms default and a 300,000 ms maximum. Out-of-range values give
  `E_USAGE`. This is separate from the detached launcher ceiling.

## Not supported yet

- Verified live log following. `hack logs <service> --follow` is available under
  verification, with `--tail`, `--since`, `--timestamps` and `--json`; real-VM acceptance for both
  authored and adopted projects remains pending. The following limits apply to
  this candidate command.
- Querying log history with Loki. Native live logs follow one service, or every service when you name none (since next.22); services configured with a TTY are currently refused by name.
- Unbounded restart following. Project restart re-admission waits at most 30 seconds
  and retains at most 1000 initial lines from the new container. Failure reports
  `native_log_restart_unavailable`. Same-container Engine restarts observed by
  the reader report `native_log_container_restarted`; after an already confirmed
  stop the follow ends as stopped. Neither case reattaches to that container.
- Following a service before its graph is ready. Startup refuses with
  `native_log_selection_changed`.
- Complete oversized lines. Lines over 64 Ki characters retain only that
  prefix with `[truncated]`; following continues. A trailing fragment is marked
  `[partial]`. JSON entries also carry `truncated: true` or `partial: true`.
- Proving a complete tail without transport EOF. A stopped service whose stream
  stays open for five idle seconds ends with `native_log_stopped_idle` and exit 1,
  not a clean EOF. The final tail may be incomplete.
- Interactive exec on an older next.16 bundle. Since next.17, native supports sized terminals,
  resize and control bytes; old managed-env launchers require a matching restart
  or finite exec. Inspect uncertain outcomes with `hack exec-sessions`; see
  [exec recovery](../guides/native-candidate.md#normal-native-exec).
- Changing the env overlay, profiles or target of a project that is already
  running. Stop it and start it again.
- Starting or restarting single services. Native starts and restarts the whole
  project.
- UDP ports. Only TCP ports with an explicit host port are published.
- Automatic restart for services that publish a port.

## Compose features that stay on Compose

A project that uses any of these runs on the Compose backend in v5. Native `up`
refuses with `E_NATIVE_PROJECT_UNSUPPORTED`, names the feature, and starts nothing.

| Compose feature | Why it stays on Compose |
| --- | --- |
| Foreign external networks | Exact `hack-dev` and `hack-logging` identities map to project-owned bridges (since next.17); they do not join Docker's shared networks or provide cross-project DNS |
| External volumes | Native only uses volumes it creates and owns |
| Unsupported routing labels | Generated Hack/Compose metadata is inert (since next.17); authored labels never grant resource ownership |
| Builds beyond a basic `context`, `dockerfile` and `target` | Build arguments, secrets, SSH and cache options are not supported |
| Platforms other than Linux arm64 | The virtual machine runs Linux arm64. `linux/amd64` works only for services you opt in to emulation. |

Details and the exact checks:
[Compose projects that stay on the Compose backend](../guides/native-candidate.md#compose-projects-that-stay-on-the-compose-backend).

## Other limits

- **Shared machine.** Projects the pool was started with share its VM resources.
  A pool accepts up to eight project shares. If a running pool does not share
  a project root, `hack up` refuses it until the pool is stopped and the share
  is added for the next boot.
- **Images that declare a volume.** Some images, such as the stock Redis and
  database images, declare a data folder with `VOLUME`. On native the service must
  mount a named volume at that path, for example `redis-data:/data`. Without one
  the project refuses with `graph_image_volume_uncovered`. A bind mount or a
  read-only mount there does not count.
- **Stopping with Ctrl-C.** The native publisher-shutdown fix (HACK-2087, #719)
  already shipped in next.16. Next.17 adds lifecycle-command retirement fixes
  (HACK-2184): transient reads retry, cleanup waits for proved command retirement,
  and a second Ctrl-C can request the forced command-group stop. Unknown cleanup
  still retains evidence. Use `hack down` from another terminal, then
  `hack down --recover` if it reports the owner is gone; do not delete state.
- **Removing folders on shared source.** Inside a service, `rm -rf` of a folder with
  many entries on shared source can stop with "Directory not empty" and leave files
  behind. This is a fault in the virtual machine's file share and is still present in
  the pinned SmolVM 1.35.4. Run the command again, remove the folder from the Mac, or
  keep that folder on a named volume.
- **Large command output.** Native `hack exec` can lose the end of its output,
  from a few hundred KB upward, in about 1 in 4 runs. `hack run` can lose it when
  the Mac reads its output slowly. This is a fault in the pinned virtual machine
  provider; a fix is verified and ships with a new provider pin. For large output,
  redirect it to a file in the container and copy the file out with `docker cp`.
  See [known issues](../guides/native-candidate.md#known-issues).
- **Hot reload with a large checkout.** Normally an edit made on the Mac reaches
  services within about a tenth of a second and file watchers inside them fire.
  When the project folders shared into the virtual machine hold more than 100,000
  files and folders in total, native starts without those change notifications
  and `hack up` says so: an edit then reaches services after up to about 5
  seconds, and a file watcher inside a service does not see it, so restart the
  service after an edit. The reason is that the virtual machine reads every
  shared entry before it starts, and past that size the read can make the start
  fail. The usual cause is installed dependencies in the checkout
  (`node_modules`). Remove the checkout's copy (with `localDirectories` the
  installed copy lives on the virtual machine's disk) to bring hot reload back,
  or set `HACK_NATIVE_HOT_RELOAD=on` to force it on and accept a slower start
  that may fail; `off` turns it off for any size.
- **The wait before the virtual machine starts.** Before native starts the
  virtual machine it checks the Mac's resources twice, at least one second
  apart. When a check that passed is on record from the last 60 seconds (a
  recent start or stop of the virtual machine leaves one), the start skips
  that wait. `HACK_NATIVE_ADMISSION_REUSE_SECONDS` sets how old the record may
  be, in whole seconds from 0 to 600. The default is 60, and `0` turns reuse
  off, so every start waits. Any other value, including one above 600, is
  refused before anything starts or stops.
- **Images.** Images need a Linux arm64 variant. Local registries need an explicit
  opt-in. Registries signed by a private certificate authority are not supported.
- **Data.** Data does not move between backends, or between prerelease versions.
  Each new prerelease starts with fresh native state.
- **Rollback.** An older prerelease may refuse state written by a newer one. That
  is a refusal, not a rollback.
- **Speed and resources.** Not measured in public yet. Do not assume native is
  faster or lighter than Compose.

The full list is under
[candidate capability limits](../guides/prereleases.md#candidate-capability-limits).

## When something is refused

A refusal is a result, not a bug to work around. Hack prints a one-line error with
a stable code and changes nothing. Do not loosen security settings, raise limits or
delete Hack's state to get past it. Run the project on Compose, and
[tell us](https://github.com/hack-dance/hack/issues) which feature you needed.
