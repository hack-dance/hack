# Data backup (`hack data export`)

`hack data export` writes a verified, file-level backup of a project's Compose
named volumes. It is the first step of moving data between the Compose and
native backends. It does not move or restore data yet: a later
`hack data import` will restore these backups, so the format below is fixed
for that.

```sh
hack down                      # the project must be stopped
hack data export               # default location under Hack's home
hack data export --out ~/backups --json
```

`--path`, `--project`, `--branch` and `--env` select the project, instance
and env overlay like other project commands. Without `--env`, the env
selection the instance was last started with is used, as `hack down` does,
so a volume name or engine that depends on that overlay resolves as it did at
startup. A successful `hack down` removes that record, so after
`hack up --env staging` then `hack down` the selection is no longer known:
when the project has env overlays the command refuses with `E_USAGE`, naming
them, before any Docker call; pass `--env <name>` (or `--env base` for base
layers only). The overlays are every one `hack up` could have selected: env
layers (`hack.env.<name>.yaml`, machine-local and inherited layers, the
configured default) and, for a legacy dotenv project, `.hack/.env.<name>`
files and overlays that only the encrypted file secret store holds values
for. When a legacy project's overlays cannot all be listed (its contract
values live in the keychain, say), it refuses the same way. A project
without overlays uses its base layers. Every Docker call (Compose, the
volume and container reads and the helper runs) gets the same managed Compose
env `hack up` gives the project, so a project that selects its engine with a
managed `DOCKER_HOST` or `DOCKER_CONTEXT` is read on that engine. The command
needs the Compose backend: with `HACK_RUNTIME_BACKEND=native` it refuses with
`E_NATIVE_PROJECT_UNSUPPORTED` and changes nothing.

## What it backs up

Hack reads the resolved Compose model with exactly the invocation `hack up`
builds for the instance: the same Compose files (the base or branch files,
Hack's stored internal override, the dependency-cache, local-directories and
runtime metadata overrides, and the env override), project name, project
directory and managed env (so env-interpolated names resolve as they do at
startup), with every profile active (`--profile '*'`) so a profile-gated
service's volume is included. It takes the model's top-level named volumes.
Compose leaves out a declared volume that no service uses, so that one is not
listed. Each volume key maps to its Docker volume name: the volume's `name:`,
or `<compose project>_<key>`.

| Volume | Result |
| --- | --- |
| Labeled `com.docker.compose.project=<this project>` and `com.docker.compose.volume=<key>` | Copied |
| `external: true` | Skipped as `external`; never inspected or read |
| Exists with other labels | Skipped as `foreign`; never mounted |
| Not created yet | Skipped as `absent`; nothing to back up |

Bind mounts, tmpfs mounts and anonymous volumes are not backed up.

## Consistency

The export refuses with `E_PROJECT_RUNNING` (exit 1) when a container of the
instance is running, or when any other container that mounts one of the
copied volumes is running. `docker ps --filter volume=` sees only volume
mounts by name, so at both running checks (before the first copy and after
the last) Hack also lists every running container (`docker ps --quiet`) and
inspects each one it did not create, by ID, in one call bounded by
`HACK_DATA_COMMAND_TIMEOUT_MS`. A bind whose `Source` is a copied volume's
`Mountpoint`, a path inside it, or a directory above it counts as using that
volume, by the same path rule as the event check below. A running container
that cannot be inspected refuses too (`detail.reason: unchecked_running`).

A volume mount can alias an owned volume's storage: a foreign `local`
volume created with `--opt type=none --opt o=bind --opt device=<owned
Mountpoint>` writes into the owned directory, while a container mounting it
shows only the alias's own name and `Source`. So for every volume mount of
another volume (at both running checks and for every container that starts
in the window), Hack inspects that volume, in one bounded call, and judges
its backing storage by the same path rule:

- a plain `local` volume (no options): its own `Mountpoint`;
- a `local` volume whose `o` option includes `bind` (or `rbind`) and that
  names a `device`: the device is the backing path;
- a `local` `tmpfs` volume: memory only, separate by construction;
- anything else (another volume driver, other local options such as an NFS,
  CIFS or block-device mount, or a volume Docker cannot inspect) is treated
  as possibly the same storage and refuses with `E_PROJECT_RUNNING`
  (`detail.reason: unchecked_volume_backing`, `detail.unchecked`: short
  container IDs; no volume or container names).
`error.detail.running` lists their short (12 character) container IDs, never
their names; stop the project with `hack down` and retry. Hack never stops anything for an export.

Before its first check, the export subscribes to Docker's live event
stream (`docker events`: volume `mount`, `create` and `destroy` and container
`start` events, with no
`--since`, so nothing depends on the engine's short event history). It proves
the subscription live by creating and starting a no-op marker container
(`hack-data-export-<random>-start`, no network, no logging) and waiting for
that container's start event. Markers are tracked like the volume helpers:
their create and start are bounded by `HACK_DATA_COMMAND_TIMEOUT_MS`, and
each is removed and its removal confirmed on every path, a signal included; only then does it check for running containers and copy.

Hack tracks every container it creates (helpers and markers) by the
immutable ID its own `docker create` returned, never by name: a name is free
again once a container is removed, and another container can take it. Every
start, exec, inspect and removal uses that ID, and an ID is retired as soon
as Docker confirms the container is gone. When a create's outcome is unknown
(the client timed out or was interrupted), a container under the name counts
as Hack's only when it carries that create's random
`io.hack.data-backup.nonce` label; one that merely has the name is left
alone.

No mount is exempt: Hack's own helpers hold each volume with a bind of its
`Mountpoint`, which emits no volume `mount` event (checked on Docker 29.9),
and markers mount nothing, so any `mount` event of a copied volume comes
from another container. Because a bind emits no volume event, another
container could use the same technique, so every container that starts in
the window and is not one Hack created is inspected by ID (bounded by
`HACK_DATA_COMMAND_TIMEOUT_MS`) once the window closes. After the last copy it lists running
containers again, runs an end marker and waits for its start event (the
engine emits events in order, so every earlier event has then arrived), stops
the subscription and decides:

- any mount of a copied volume, even by a container that started and exited
  during the copy or reuses one of Hack's helper names, refuses with
  `E_PROJECT_RUNNING` and `error.detail.mounts` (volume key and short
  container ID);
- so does a container that started in the window with a volume mount of a
  copied volume or a bind whose `Source` is a copied volume's `Mountpoint`,
  a path inside it, or a directory above it. Paths are the daemon's own
  (they may live in a VM), so they are compared after lexical
  normalization;
- a container that started in the window but cannot be inspected (it was
  already removed, or the inspect failed) refuses with `E_PROJECT_RUNNING`
  (`detail.reason: unchecked_start`, `detail.unchecked`: short IDs), since
  what it mounted is unknown. On a busy engine an unrelated short-lived
  container that starts during the export can cause this refusal; if
  nothing else should be using the project's volumes, retry the export;
- an event stream that ended before Hack stopped it, an unreadable event, or
  a marker whose start event did not arrive within 30 seconds refuses with
  `E_DOCKER_UNAVAILABLE`: Hack lost coverage and cannot prove nothing else
  wrote.

Either refusal leaves the copy unpublished in `<backup>.partial/`. On every
path the events child is stopped (SIGTERM, a two-second drain, then SIGKILL)
and awaited; on Ctrl-C or SIGTERM the export also force-removes its live
helper containers, by ID, before exiting; a container that reused one of
their names is never touched.

## How it copies

Each owned volume is held by one helper container for its whole copy. Hack
creates it from the image the storage witness already pins
(`oven/bun@sha256:1846adf2…`) with a unique name
(`hack-data-export-<random>`), `--network none`, `--log-driver none` (the raw
tar crosses the container's attached output, and a daemon's central logging
driver must never receive volume bytes), a read-only root filesystem and
`no-new-privileges`, running `sleep infinity`. Docker pulls the image digest
once if it is not cached.

The helper never mounts the volume by name. Docker creates a missing named
volume whenever a container mounts it, so mounting by name could leave an
empty volume behind if the validated one was removed meanwhile. Instead the
helper bind-mounts the volume's inspected `Mountpoint` read-only at `/v`
(`--mount type=bind,src=<Mountpoint>,dst=/v,readonly`); a bind of a path
that is gone fails, so a volume removed after validation refuses with
`E_PROJECT_RUNNING` (`detail.reason: volume_changed`, "nothing was created")
and nothing is created. This reads only plain `local` volumes, whose data
is that directory: a volume with another driver, or a local volume with
driver options (an NFS or bind mount, which is only mounted while a
container uses it by name), refuses the export before any hold with
`E_CONFIG_INVALID` (`detail.reason: unsupported_driver`).

Once the container holds the bind, Hack inspects the volume again and
requires the identity it validated before: the same `CreatedAt`, driver,
mountpoint, options and Compose labels, and the container's mount must be
that directory. A volume replaced or relabeled in between refuses the same
way and is not read.

Hack cannot pin a volume against removal. A bind of its `Mountpoint` is not
a Docker volume reference, so `docker volume rm` succeeds while the helper
holds it: on Docker 29.9.2 the removal exits 0, `docker volume inspect` then
fails, and the helper's `/v` is left an empty tree. Every digest taken after
such a removal agrees on that empty tree. Hack therefore rechecks the
volume's identity (by inspect only; it never creates a volume) right after
the hold, again after the copy and the second digest, and once more for
every copied volume immediately before the rename that publishes the
backup. A volume that is gone, or replaced under the same name, refuses
with `E_PROJECT_RUNNING` (`detail.reason: volume_changed`) and leaves the
copy in `<backup>.partial/`.

An identity comparison alone is not enough: Docker reports a volume's
`CreatedAt` to the second, so a volume removed and created again under the
same name and labels within one second matches every field (checked on
Docker 29.9.2), and the hold would bind the new volume's directory. The
event subscription therefore also receives volume `destroy` and `create`
events, and any destroy or create of a copied volume's name during the
window refuses publication with `volume_changed`, whatever the timestamps
say. Export creates no volume, so every such event is someone else's.

On Docker Desktop and OrbStack the daemon runs in a VM, and the
`Mountpoint` is a path inside that VM; the daemon resolves the bind there.
That has not been checked on macOS yet.

Every read then runs in that container through `docker exec`, so all of them
use the same mount:

1. The tree digest of the source.
2. `tar --numeric-owner -cpf - -C /v .`, streamed to `<key>.tar`. The host
   computes the tar's sha256 while writing it.
3. The tree digest of the source again. If it differs from the first, the
   volume changed during the copy and the export refuses
   (`detail.reason: source_changed`).
4. The archive digest: `<key>.tar` is streamed back into the helper, and a
   Bun script parses it (GNU and POSIX headers, checksums verified) and
   computes the same `hack.tree-digest.v1` from the archive's headers and
   content. If it differs from the source digest, the archive does not hold
   the tree that was read, and the export refuses
   (`detail.reason: archive_mismatch`).

Publication requires source digest before the copy = source digest after
the copy = archive digest.

Finally the container is force-removed and Hack confirms with Docker that it
is gone, on every path, success or failure.

The tree digest is `hack.tree-digest.v1`, computed by a Bun script in the
helper. Every entry (the root as `.`, then each path relative to the root, as
raw bytes) is sorted bytewise. For each entry, seven fields are hashed, each
followed by one NUL byte: path, type (`f` `d` `l` `c` `b` `p`), permission
bits in octal, uid, gid, size (regular files, otherwise 0) and content (a
regular file's sha256, a symlink's target, a device's rdev, otherwise
empty). The digest is the sha256 of that stream. A restore runs the same
script on the restored volume and compares.

## Deadlines

Every Docker call is bounded. Metadata calls (the Compose model, inspect,
`ps`, `create`, `start`, `rm`) default to two minutes,
`HACK_DATA_COMMAND_TIMEOUT_MS`. Each whole-volume step (a digest, the tar, the
archive check, an extract) defaults to four hours, about 1 TiB at 75 MiB/s,
`HACK_DATA_STEP_TIMEOUT_MS`; raise it for larger or slower volumes. Both take
milliseconds; a value outside the accepted range refuses before anything
runs. A step past its bound is stopped and refuses with
`E_DOCKER_UNAVAILABLE` (`detail.reason: step_timeout`). On a timeout, a full
disk or any other failure the helper container is removed; if Docker cannot
confirm the removal, the outcome says so (`detail.cleanup: {container,
removed: false}`, the container ID, and the `docker rm -f <id>` command to
run) instead of claiming cleanup, and nothing is published. Ctrl-C or SIGTERM
stops the event subscription, force-removes the run's live helper containers
by ID and reports
`E_CANCELLED`; removal is confirmed with a few short retries, since Docker
may still be tearing a container down.

## What "consistent" means

A backup is consistent in this sense: no container other than the export's
own helpers was observed using a copied volume by the live event fence, from
before the first running-container check until after the last digest, and
the three digests above are equal. It is not a filesystem snapshot: a
process that writes through some other path the fence cannot see, such as
the Docker host itself writing into the volume's directory, is not detected
unless it changes the tree between the two source digests.

## Entry types

| Entry | Kept and verified |
| --- | --- |
| Regular files | Path, mode, uid, gid, size and content |
| Directories | Path, mode, uid, gid |
| Symlinks | Path, mode, uid, gid and target |
| FIFOs | Path, mode, uid, gid |
| Character and block devices | Path, mode, uid, gid and device number |
| Hard links | Restored as tar stores them (a link to the first path); each path is verified as a regular file with the shared content, but link identity is not verified |
| Unix sockets | Not copied; counted as `excludedSockets` |

Timestamps, extended attributes and ACLs are not promised: tar keeps
modification times, but no digest covers them, and attributes and ACLs are
not copied.

Unix sockets are not copied. GNU tar skips them (`socket ignored`), so the
digest leaves them out too and the manifest counts them per volume as
`excludedSockets`; the text summary says how many were not copied. Sockets
are runtime artifacts, such as `mysql.sock` in a MySQL data directory, that
the service recreates when it starts.

## Redaction

Compose resolves names with interpolated env values: a volume's `name:`
(`app-${TOKEN}`) and the top-level project `name:` (`${STORAGE_TOKEN}`), which
Docker then copies into every container name and ownership label. No such
resolved value is written or printed:

- volumes are named by Compose key in the manifest, the `--json` output, the
  text summary and error messages; the manifest keeps `nameSha256`, the
  sha256 of the resolved Docker name;
- the manifest keeps `composeProjectSha256` instead of the Compose project
  name, and `labelsSha256` (the sha256 of each ownership label value)
  instead of the labels;
- the default backup path is named after Hack's project name
  (`hack.config.json` `name`, else the checkout directory) and the branch
  slug, never the Compose project;
- refusals name containers by short ID only (`detail.running`,
  `detail.mounts[].container`, `detail.unchecked`), never by name: a name
  can carry the resolved Compose project name or a managed value
  interpolated into `container_name:`;
- an engine line quoted in a refusal (`Engine said: …`, in text and JSON)
  has every value the project's managed env adds, such as a managed
  `DOCKER_HOST` or `DOCKER_CONTEXT`, replaced by `[REDACTED]`, as
  `hack up` does.

A restore compares these hashes instead of the values.

## Format

```text
<parent>/<UTC timestamp>/          for example 20261123T140501Z
  manifest.json
  <key>.tar                        one per copied volume
```

The default parent is `$HACK_HOME/data-backups/<hack project>` for the default
instance and `$HACK_HOME/data-backups/<hack project>--<branch>` for a branch
instance (Hack's home is `~/.hack` unless `HACK_HOME` is set). `--out <dir>` replaces the parent.
Directories and files are created private to your user (0700 and 0600).

`manifest.json` (schema `hack.data-backup.v1`):

| Field | Meaning |
| --- | --- |
| `project`, `branch`, `composeProjectSha256` | Hack project name, branch slug or null, sha256 of the resolved Compose project name |
| `createdAt` | UTC start time, ISO 8601 |
| `hackVersion`, `helperImage`, `digestAlgorithm` | Version that wrote it, pinned helper reference, `hack.tree-digest.v1` |
| `volumes[]` | `key`, `nameSha256` (sha256 of the Docker volume name, never the name itself), `driver`, `labelsSha256` (sha256 of the two ownership label values), `file`, `tarBytes`, `tarSha256`, `entries` (the root included, sockets not), `excludedSockets`, `contentDigest` |
| `skipped[]` | `key` and `reason`: `external`, `foreign` or `absent` |

`--json` prints the standard envelope with `data.schema` `hack.data-export.v1`,
`data.backup` (the backup path) and `data.manifest`.

## Atomicity and durability

Everything is written into `<backup>.partial/`. Each tar is fsynced as it is
written; the manifest is written last and fsynced, then the `.partial`
directory is fsynced, one rename publishes `<backup>/`, and the parent
directory is fsynced. When the export created the parent itself (a new
`--out` tree, or the first backup under Hack's home), the directory above
each directory it created is fsynced too, deepest first, so the new path is
durable as a whole. The outcomes are:

- **Failure before the rename**: only `<backup>.partial/` exists. It is never
  a backup: Hack never reads, reuses or completes it, and you can delete it.
- **Success**: `<backup>/` exists, its rename was flushed, and the command
  exits 0.
- **An fsync after the rename failed** (the parent, or the directory above
  one the export created): `<backup>/` exists and is
  complete, but the command exits 1 with `backup at <path> is complete but
  its durability could not be confirmed` and `error.detail` `{published:
  true, durable: false}`. Use it once the file system is healthy, or export
  again.

Each run uses a new timestamp; if the target or its `.partial` already
exists (two runs in the same second), the export refuses with
`E_PATH_CONFLICT` instead of writing into it.
