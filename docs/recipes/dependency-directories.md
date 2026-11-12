# Dependency directories and caches

Use this to decide where `node_modules`, virtual environments, build output and
tool caches live. The short rule: anything a container installs or generates
goes in a named volume, not in your checkout.

For installing packages, start with [Install dependencies in a deps service](deps-service.md).
This page covers the other directories, how to share
and clean them, and what changes on the native backend.

## Where each directory goes

| Directory | Put it in | Why |
| --- | --- | --- |
| `node_modules` (root and each workspace) | A named volume, filled by a `deps` service | Linux binaries; one install for all services |
| Python virtual environment | A named volume (for example `/venv`), filled by a `deps` service | Same reason; see the [Python example](config-examples.md#python-web-app-with-postgres) |
| Build output served by another service (`dist`, `site`) | A named volume shared by the builder and the server | The server reads it; your checkout stays clean. See the [static site example](config-examples.md#static-site-with-a-build-watcher) |
| Framework and tool caches (`.next`, `.turbo`, `.cache`) | A named volume per instance | Fast rebuilds; safe to delete |
| Data (`/var/lib/postgresql/data`, `/data`) | A named volume | Kept across `hack down` |

Bind-mount only your source (`..:/app`). On macOS, files in a bind mount cross
from macOS into the Linux VM, which is slower than a named volume, which stays
inside the VM. See [Development runtime safety](../guides/development-runtime-safety.md).

## Caches you can throw away

Mark a cache volume as disposable, so `hack down --prune-caches` can remove it:

```yaml
services:
  web:
    volumes:
      - ..:/app
      - node_modules:/app/node_modules:ro
      - build-cache:/app/.cache

volumes:
  node_modules: {}
  build-cache:
    labels:
      hack.cache.disposable: "true"
```

```sh
hack down --prune-caches          # asks first
hack down --prune-caches --yes    # no prompt
```

Volumes mounted only at a `.next` path count as disposable without a label.
`--prune-caches` removes only those volumes, only for this instance. It keeps
dependency volumes, databases, and everything else. It is not available on the
native backend. Details: [CLI cache and startup](../cli.md).

## Sharing dependencies between branch instances

By default each branch instance and worktree has its own volumes. To let
instances with the same lockfile share one dependency volume, add the
`hack.dependencies.cache-volume` and `hack.dependencies.lockfiles` labels to
the `deps` service and set its `platform`. Hack names the shared volume from a
fingerprint of the lockfiles, the runtime files you list in
`hack.dependencies.runtime-files`, the installer image, the platform and the
build settings. A different fingerprint gets a new volume. Old volumes are kept
until you remove them.

Only the installer should mount dependency volumes writable; app consumers use
`:ro`, with tool caches in separate writable volumes. Share a dependency cache
only across equally trusted worktrees. A worktree's installer can still change
the shared volume, so use per-instance volumes for untrusted worktrees.

The fingerprint does not see changes inside a mutable image tag. Pin the
installer image by tag or digest.

Ordinary cache labels do not stop two installers from writing the same volume
at the same time. If your install output never depends on the instance and
needs no credentials, you can opt into the stricter
[locked installer protocol](../guides/dependency-cache-protocol.md), which adds
a lock, a verifier and a ready marker.

The how-to, with the commands we ran, is in
[the deps service recipe](deps-service.md#branch-instances-and-worktrees).

## Private registries

If `.npmrc`, `.yarnrc.yml` or `bunfig.toml` uses `${VAR}` for a token, Hack
checks that the variable is set before it runs the installer, and fails with
`E_ENV_KEY_MISSING` when it is not. Store the token as a secret in the `deps`
service's scope:

```sh
<secret-source> | hack env add NPM_TOKEN --service deps --secret --local --value-stdin
```

We did not run a private registry install.

## On the native backend (beta)

The [native backend](../guides/native-candidate.md) runs services in its own
Linux VM without Docker. These points come from its guide; we did not run them
for this page.

- The VM is Linux arm64. An installer with another `platform` stays on the
  Compose backend unless amd64 emulation is enabled.
- Source is shared with the VM as a snapshot that leaves out `.git`,
  `node_modules` and `.env*`. Writable sharing of your source needs
  `HACK_NATIVE_SHARED_SOURCE=1` (or `"sharedSource": true`).
- A dependency cache is shared between worktrees and branch instances only
  while every service except the installer mounts it read-only. Otherwise it
  belongs to one checkout and branch instance.
- Workspace installs that write into each package need explicit volume
  mappings. A `workspaceCache` adaptation can mount parts of one dependency
  volume at each workspace's `node_modules`.
- Native never creates an anonymous volume, and allows at most 16 named
  volumes, dependency caches included.
- `hack down --remove-data` deletes the data volumes a stopped native project
  created. Shared dependency caches are released, not deleted.
  `--prune-caches` is refused on native.

Related: [Install dependencies in a deps service](deps-service.md),
[Cleanup](cleanup.md), [Common pitfalls](common-pitfalls.md).
