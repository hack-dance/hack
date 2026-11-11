# Clean up branch instances, worktrees and volumes

The commands and configuration on this page were audited against `v5.0.0-next.13`.
The execution notes below come from the newer recipe source revision; the examples
were not rerun with the pinned binary.

Use this to remove what old branches and worktrees leave behind: containers,
networks, volumes, lifecycle sessions and stale `node_modules`. It also says
what `hack projects prune` and `hack doctor` cover, and what they leave to you.

## What each command removes

| Command | Containers | Networks | Volumes | Lifecycle processes | Registry entries |
| --- | --- | --- | --- | --- | --- |
| `hack down` | This instance's | This instance's | Kept | Stopped | Kept |
| `hack down --prune-caches` | as `hack down` | as `hack down` | Only disposable caches | Stopped | Kept |
| `hack projects prune` | Of orphaned instances (force-removed) | Kept | Kept | Not touched | Entries whose checkout or `.hack` files are gone |
| `hack doctor` | Reports only | Reports only | Not checked | Reports orphaned sessions | Reports only |
| `hack doctor --fix` | Starts containers stuck in `Created`; never removes | No | No | Stops sessions it proves are orphaned | No |

An instance is orphaned when Compose still has containers for it but its
checkout directory, or the `.hack` Compose file in it, no longer exists.

## Remove a worktree (the clean way)

Stop the worktree's branch instance **before** you delete the worktree:

```sh
cd ../app-feature-x
hack down --prune-caches --yes
docker volume ls --filter label=com.docker.compose.project=<project>--feature-x
docker volume rm <volumes you no longer need>
cd -
git worktree remove ../app-feature-x
```

`hack down` from inside a linked worktree targets that worktree's branch
instance. From another checkout, use `hack down --branch feature-x`.

## A worktree was already deleted

If you removed the worktree while its instance was running, the containers keep
running. `hack doctor` reports them:

```text
runtime hygiene: 1 orphaned runtime project: <project>--feature-x
(run: hack projects prune --project <project>)
```

1. Preview, then remove the orphaned containers:

   ```sh
   hack projects prune --project <project> --dry-run
   hack projects prune --project <project>
   ```

   `--project <name>` covers the project and its branch instances
   (`<name>--*`). Without it, prune looks at every project on the machine.

2. Prune leaves the instance's network and volumes. Remove them with Docker:

   ```sh
   docker compose -p <project>--feature-x down --volumes
   docker volume ls --filter label=com.docker.compose.project=<project>--feature-x
   docker volume rm <any volume still listed>
   ```

   `docker compose -p ... down --volumes` works without the Compose file, but
   it may not find every volume. Check with `docker volume ls` afterwards.

## Remove a project's data volumes

`hack down` keeps every named volume, including databases. On the Compose
backend, Hack has no command that deletes them. Use Docker:

```sh
hack down
docker volume ls --filter label=com.docker.compose.project=<project>
docker volume rm <project>_db-data
```

Shared dependency volumes are named `hack-cache-<project>-<volume>-<hash>`.
Docker refuses to remove one while any container, including another branch
instance's, still uses it. Old ones stay after a lockfile change; remove those
you no longer use the same way.

On the native backend, `hack down --remove-data` deletes a stopped project's
data volumes. See the [native backend guide](../../guides/native-candidate.md).

## Lifecycle sessions and host processes

`hack down` stops the lifecycle processes it started (tunnels, proxies, host
dev servers). If a session is left behind, for example after a crash:

```sh
hack doctor          # reports stale or orphaned lifecycle sessions
hack doctor --fix    # stops only sessions it can prove are orphaned
```

A session updated in the last five minutes may still be starting; doctor leaves
it alone. Processes adopted through `singleton` were not started by Hack, and
`hack down` leaves them running.

## Stale `node_modules` in your checkout

With a [deps service](deps-service.md), containers use a volume, so a
`node_modules` folder in your checkout is either a leftover from a host install
or an empty mount point that Docker created. Find them:

```sh
find . -name node_modules -type d -prune
```

Delete them when no tool on your machine needs them. On Linux with Docker
Engine, the empty mount points belong to root. Remove them with
`sudo rmdir`, or leave them: they are empty, and git ignores them if
`node_modules` is in `.gitignore`.

## Registry entries

`hack projects` lists registered projects. An entry whose checkout no longer
exists is removed by `hack projects prune`. Use `--dry-run` first; the preview
lists candidates, not proof that their data is safe to discard.

## What was tested

On Linux with Docker Engine: removing a running worktree, the doctor report,
`hack projects prune --dry-run` and `--project`, the Docker commands above,
`hack down --prune-caches --yes`, and Docker's refusal to remove a volume in
use. `hack doctor --fix` for lifecycle sessions was not exercised here; it is
covered by the repository's tests.

Related: [Lifecycle](../../lifecycle.md),
[Dependency directories and caches](dependency-directories.md),
[Common pitfalls](common-pitfalls.md).
