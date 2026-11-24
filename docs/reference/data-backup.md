# Data backup (`hack data export`, `hack data import`)

`hack data export` writes a verified, file-level backup of a project's Compose
named volumes, and `hack data import` restores one into Compose volumes. They
are the first steps of moving data between the Compose and native backends;
both work on Compose only for now.

```sh
hack down                      # the project must be stopped
hack data export               # default location under Hack's home
hack data export --out ~/backups --json
hack data import ~/.hack/data-backups/shop/20261123T140501Z
hack data import <backup> --from-project shop   # into a branch or renamed project
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

Text alone cannot prove two paths separate: `/proc/self/root/<Mountpoint>`
or a symlink to a Mountpoint names the same directory under another
spelling. Text that already shows an overlap refuses as above. Every other
bind `Source` of a foreign container, and every bind alias's `device`, is
proven on the daemon: one pinned helper (no network, no logging, a
read-only root, tracked by ID) gets each such path and each copied
`Mountpoint` bind-mounted read-only, so the daemon resolves symlinks and
`/proc/self/root` as it does for any bind. The helper reads its own
`/proc/self/mountinfo` and compares each mount's filesystem (major:minor)
and its root within that filesystem, submounts included: the same
filesystem with either root inside the other overlaps (equal, inside or
above). For a path that is not a directory it also looks for the same
device and inode in the copied tree (a hard link). A plain local volume's
own directory is separate by construction and is not proven. A proof that
cannot be made (the helper fails or times out, or a path does not exist)
refuses with `unchecked_volume_backing`. On a host with busy containers
this adds one short helper run to each running check and to the end of
the window.

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

A bind of the `Mountpoint` is not a Docker volume reference, so on its own
it does not stop `docker volume rm`: on Docker 29.9.2 the removal exits 0,
`docker volume inspect` then fails, and the helper's `/v` is left an empty
tree that every later digest agrees on. Hack therefore also holds a Docker
reference to each copied volume for the whole copy and the window's checks:
right after the first running check, it creates (and never starts) one
reference container per volume (`--mount
type=volume,src=<name>,dst=/v,volume-nocopy,volume-driver=local,volume-opt=type=none`,
no network, no logging, a read-only root, the run's nonce label), tracked by the ID its create
returned. While it exists Docker refuses the removal, `--force` included
("volume is in use"); it runs nothing and emits no mount event. Each
reference is removed by its ID once the window's checks are done, before
the publish, and its removal is confirmed; an unconfirmed removal is
reported like a helper's (`detail.cleanup`). Hack never removes a volume.

A plain volume mount would make Docker create a missing named volume. The
reference names local driver options instead (`type=none` without a
`device`), which the driver uses only to create a volume and refuses to
create with. So a volume removed between validation and the reference is
refused at the reference ("missing required option") and not recreated,
while an existing volume is referenced unchanged (checked on Docker 29.9.2,
engine API 1.56: its `CreatedAt`, options, labels and Mountpoint stay the
same, and no volume event is emitted). Export therefore creates no volume
and leaves none behind. Every other way of taking a reference that was
tried, a plain volume mount, `DriverConfig` with the local driver and no
options, `Subpath`, volume labels, a read-only mount or a legacy `Binds`
entry, recreates a missing volume; a bogus driver refuses existing and
missing volumes alike. Hack rechecks every volume's identity (by inspect)
as soon as its references exist, for a volume replaced under the same name
in between; that volume is not Hack's and is never removed. Identity is
also rechecked right after each hold, after each copy and its second
digest, and for every copied volume immediately before the rename that
publishes the backup, in case a reference was removed by someone else. A volume that is
gone, or replaced under the same name, refuses with `E_PROJECT_RUNNING`
(`detail.reason: volume_changed`) and leaves the copy in
`<backup>.partial/`.

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
run) instead of claiming cleanup, and nothing is published. When a `docker
create` for a helper, marker or reference returns no container ID (the
response was lost or timed out) and Hack cannot find the container by its
name and the create's random `io.hack.data-backup.nonce` label either, a
container of this run may exist that Hack does not track: the refusal says
so with an unknown cleanup outcome (`detail.cleanup: {container: null,
removed: false, outcome: "unknown", label, command}`) and, in text too, one
command that finds and removes it by that label only,
`docker ps -aq --filter label=io.hack.data-backup.nonce=<nonce> | xargs -r docker rm -f`.
A create the daemon itself refused created nothing and is not reported. Ctrl-C or SIGTERM
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
<parent>/<UTC timestamp>[-<n>]/    for example 20261123T140501Z or 20261123T140501Z-2
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

Each run uses a new UTC timestamp. Under the default parent, when that name
or its `.partial` already exists (two runs in the same second, or a quick
retry after a refused run, whose `.partial` is left on purpose), the export
takes the next free name: `<UTC>-2`, `<UTC>-3`, and so on, up to 99 more
names in one second. The claim is the creation of `<name>.partial` itself,
so two exports at once never share a name, and an existing backup or
`.partial` is never reused or replaced. With an explicit `--out <dir>`, a
collision still refuses with `E_PATH_CONFLICT` instead of writing into it.

## Restore (`hack data import`)

`hack data import <backup-dir> [--from-project <name>] [--json]` takes the
same `--path`, `--project`, `--branch` and `--env` selection, the same Compose
model as `hack up`, the same managed env and the same deadlines as export,
the same refusal without `--env` when the selection is no longer recorded and
the project has overlays, the same redaction of quoted engine lines, and
refuses the native backend the same way. It never overwrites, deletes or
relabels data it does not own.

Before any write it checks, in order:

1. **The backup.** A `.partial` directory, a directory without
   `manifest.json`, a manifest that is not `hack.data-backup.v1`, or a tar
   that is missing, is not a regular file, or differs in size or sha256 from
   the manifest refuses with `E_BACKUP_INVALID`. The backup id is the sha256
   of `manifest.json`.
2. **The source project and names.** The backup's `composeProjectSha256`
   must equal the sha256 of this instance's resolved Compose project name,
   and each target's Docker name must hash to the backup's `nameSha256`. To
   restore into a branch instance, a renamed project or under a changed
   volume name, pass `--from-project <hack project>`: the backup's Hack
   project name (its manifest `project`), compared as given; a missing or
   different value refuses with `E_USAGE`. Messages name Hack projects and
   branches only.
3. **One import at a time.** The import holds
   `$HACK_HOME/data-imports/<hack project>[--<branch>]/.lock` for its whole
   run (Hack's names, never the resolved Compose project). A
   second import of the same project refuses with `E_LOCKED` after a
   one-second bound instead of waiting; a lock left by a process that no
   longer exists is reclaimed.
4. **Running containers and writers.** As for export: the live event
   subscription is proven before the first running-container check, and
   `E_PROJECT_RUNNING` refuses when a container of the instance, or any
   container mounting a target, runs, or when any container mounts a target
   during the import (this run's helpers hold targets by bind, which emits
   no volume `mount` event). As for export, every container that starts in
   the window and is not one this import created is inspected by ID: a
   volume mount of a target or a bind of a target's `Mountpoint` (including
   one the import just created), a path inside it or a directory above it
   refuses, and a start that cannot be inspected refuses with
   `detail.reason: unchecked_start` (retry if it was unrelated). Containers
   are tracked and removed by ID and reported by short ID only. Each
   refusal leaves the journal unfinished. Both running checks also inspect
   every running container for a bind of an existing target's
   `Mountpoint` (a target that does not exist yet is matched by name).
   As for export, Hack cannot pin a target against removal, so it rechecks
   each target's identity after every read-only hold (a mismatch refuses
   as `changed`, before any write), after its restore and digest, and for
   every target immediately before any journal is marked complete (a
   mismatch refuses with `volume_changed` and leaves the journal
   unfinished). Import never creates a volume except an absent target.
   Volume `destroy` and `create` events of a target's name during the
   window refuse the same way, whatever the timestamps say; a `create` is
   import's own only when import's own `docker volume create` of exactly
   that name succeeded in the window (one event per create). Foreign volume
   mounts, bind sources and alias devices are judged by their backing
   storage, proven on the daemon, as for export. Import also holds a Docker
   reference (a created, never started container) to every existing target
   from the first running check, and to each target it creates right after
   creating it, until the window's checks are done, so `docker volume rm` of
   a target is refused while it is restored. An existing target removed
   before its reference is recreated empty by Docker for the reference and
   refuses as `changed`; journals are marked complete only after every
   reference is removed.
5. **Targets.** A backed-up key that is no longer declared here, or is
   `external` here, is skipped and reported. For each other key the target is
   its Docker volume (`name:` or `<compose project>_<key>`):

| Target | Result |
| --- | --- |
| Absent | Created with `docker volume create` and Compose's labels (`com.docker.compose.project`, `com.docker.compose.volume`, `com.docker.compose.version` from `docker compose version --short`) plus `io.hack.data-backup.source=<backup id>` |
| Exists, labeled for this project and key, empty | Used as it is (emptiness is checked in a read-only held helper) |
| Exists, labeled for this project and key, with data | Refused (`not_empty`), unless it is this import's own interrupted copy (below) |
| Labels name another project or key, or none | Refused (`foreign`); never mounted or changed |
| Declared with a driver other than `local` or with `driver_opts`, or existing with such a driver or options | Refused (`unsupported_driver`): import restores into plain local volumes only for now, so data never lands in an unintended backing store such as an NFS mount |

Any refusal names every conflicting volume, by key, in one
`E_DATA_TARGET_CONFLICT` (`error.detail.conflicts`) and writes nothing. Move
the volume aside, or back it up with `hack data export`, then rerun. Compose
accepts a volume created by import as its own: it carries the same labels
Compose writes, and Compose does not require its config-hash label.

Then, per target, through one held helper container as export uses (unique
`hack-data-import-<random>` name, `--log-driver none`, `--network none`,
read-only root, `no-new-privileges`, and the target's `Mountpoint`
bind-mounted read-write at `/v`; an existing target is never mounted by
name, and only an absent one is created, explicitly, with `docker volume
create`):

1. An absent target is created. Because `docker volume create` returns an
   existing volume of that name unchanged, Hack inspects the result and
   requires this backup's source label, the expected Compose labels and a
   plain local driver without options.
2. The helper is created holding the volume, and the volume must still be
   the one validated or just created (same `CreatedAt`, driver, mountpoint,
   options and labels) and, unless it is our own interrupted copy, empty.
   Anything else refuses as `changed` before anything is written.
3. The journal records `started`; our own interrupted copy is cleared
   (`find /v -mindepth 1 -delete`); the tar is streamed in through `docker
   exec` running `tar --numeric-owner -xpf - -C /v`; and the helper computes
   the same `hack.tree-digest.v1` digest as export.
4. A digest or entry count that differs from the manifest marks the journal
   `failed`, leaves the volume as it is and exits 1 (`E_UNEXPECTED`); a step
   past its deadline refuses with `E_DOCKER_UNAVAILABLE` (`step_timeout`).
   The helper is removed and its removal confirmed on every path, as for
   export.

After all targets, the import checks running containers again and closes
the event fence, as export does; only then are the journals marked
`complete`.

### Interruption and recovery

The journal is `$HACK_HOME/data-imports/<hack project>[--<branch>]/<key>.json`
(`hack.data-import-journal.v1`: backup id, backup path, key, the sha256 of
the target's Docker name, state `started`, `complete` or `failed`), written
atomically. On a rerun, a non-empty target is treated as this import's own
partial copy only when all of these hold: its `io.hack.data-backup.source`
label is the same backup id, the journal names the same backup and target,
and the journal is not `complete`. That copy is cleared inside the helper and
restored again.

A target whose journal is `complete` for the same backup and target name was
restored by an earlier run (this is checked before the emptiness check, so a
target the user emptied since refuses as `modified` instead of being
restored over, and a volume that is empty in the backup verifies instead of
being rewritten), for example one stopped before its other targets
finished. It is re-verified in a read-only held helper: when its tree digest
and entry count equal the manifest's it is reported as `verified-complete`
(`outcome: verified`) and not written, and the import goes on with the other
targets; when they differ, it changed since and refuses (`modified`). If every
target already matches, the import exits 0 with "Nothing to restore: all
volumes already match this backup". Any other non-empty volume, including one
with a complete journal of a different backup, is refused as above
(`not_empty`).

An existing empty volume that the import filled has no source label (Docker
labels cannot be added later), so if that import is interrupted a rerun
refuses it; the message says to remove that volume after checking it.

`--json` prints the standard envelope with `data.schema` `hack.data-import.v1`:
`backup`, `backupId`, `sourceProject`, `sourceBranch`, `project`, `branch`
(Hack names), `volumes[]`
(`key`, `target` `created`, `empty`, `replaced-partial` or
`verified-complete`, `outcome` `restored` or `verified`, `entries`,
`excludedSockets`, `contentDigest`) and `skipped[]` (`key`, `reason`
`undeclared` or `external`). Docker volume names appear in neither.
