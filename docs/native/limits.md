# Native backend (beta): what works and known limits

The native backend supports part of what Compose supports. When a project needs
something outside that part, Hack refuses and tells you. It does not guess, and it
does not fall back to Docker without telling you.

The changes labelled next.17 below describe candidate source `5002cf87bb`.
An installed next.16 bundle keeps its older behavior.

## Platform

| Platform | Native backend |
| --- | --- |
| Apple Silicon macOS | Supported, through `hack-next` |
| Intel macOS | Not supported. The installer refuses before changing anything. |
| Linux and Windows | Not supported. Use the Compose backend. |
| Stable `hack` (Homebrew or the release installer) | Does not contain the native backend |

## Commands that work

| You want to | Native today |
| --- | --- |
| Start the whole project | `hack up` in the foreground, or `hack up -d` in the background |
| Restart the whole project | `hack restart`, in the foreground only |
| Stop the project | `hack down`, and `hack down --recover` after a crash |
| See what is running | `hack ps` |
| Read recent logs | `hack logs <service> --no-follow`, a bounded snapshot |
| Run a command in a running service | Next.17: foreground terminal `hack exec SERVICE -- /bin/sh` is interactive; redirected input/output and `HACK_NO_INTERACTIVE=1` use finite exec |
| Run a one-off command | `hack run`, for services without source, data or private env mounts |
| Preview without starting | `hack config validate`, `hack config plan`, `hack config import --dry-run`, `hack config adopt --dry-run` |

The exact rules for each command are in
[native authored commands](../reference/native-authored-commands.md).

## Not supported yet

- Verified live log following. `hack logs <service> --follow` is available under
  verification, with `--tail`, `--since`, `--timestamps` and `--json`; real-VM acceptance for both
  authored and adopted projects remains pending. The following limits apply to
  this candidate command.
- Querying log history with Loki. Native live logs select one service; services configured with a TTY are currently refused by name.
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
- Interactive exec on an older next.16 bundle. Next.17 supports sized terminals,
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
| Foreign external networks | Exact `hack-dev` and `hack-logging` identities map to project-owned bridges in next.17; they do not join Docker's shared networks or provide cross-project DNS |
| External volumes | Native only uses volumes it creates and owns |
| Unsupported routing labels | Generated Hack/Compose metadata is inert in next.17; authored labels never grant resource ownership |
| Builds beyond a basic `context`, `dockerfile` and `target` | Build arguments, secrets, SSH and cache options are not supported |
| Platforms other than Linux arm64 | The virtual machine runs Linux arm64. `linux/amd64` works only for services you opt in to emulation. |

Details and the exact checks:
[Compose projects that stay on the Compose backend](../guides/native-candidate.md#compose-projects-that-stay-on-the-compose-backend).

## Other limits

- **Shared machine.** All native projects run in one virtual machine. They are
  separated the way Compose projects are, not by a machine each.
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
