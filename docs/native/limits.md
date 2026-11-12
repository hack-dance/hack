# Native backend (beta): what works and known limits

The native backend supports part of what Compose supports. When a project needs
something outside that part, Hack refuses and tells you. It does not guess, and it
does not fall back to Docker without telling you.

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
| Read logs | `hack logs <service> --no-follow` |
| Run a command in a running service | `hack exec`, without an interactive terminal |
| Run a one-off command | `hack run`, for services without source, data or private env mounts |
| Preview without starting | `hack config validate`, `hack config plan`, `hack config import --dry-run`, `hack config adopt --dry-run` |

The exact rules for each command are in
[native authored commands](../reference/native-authored-commands.md).

## Not supported yet

- Following logs live, or querying log history with Loki.
- Interactive `exec` sessions.
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
| External networks | Native only uses networks it creates and owns |
| External volumes | Native only uses volumes it creates and owns |
| Labels Hack or Compose reserve | These labels prove which tool owns a resource |
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
- **Stopping with Ctrl-C.** In this prerelease, Ctrl-C may not stop a foreground
  project cleanly when it publishes ports. Use `hack down` from another terminal,
  and `hack down --recover` if it reports that the owner is gone.
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
