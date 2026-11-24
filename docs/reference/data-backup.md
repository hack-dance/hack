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
and env overlay like other project commands. Every Docker call (Compose, the
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
copied volumes is running. `error.detail.running` names them; stop the project
with `hack down` and retry. Hack never stops anything for an export.

Before its first check, the export subscribes to Docker's live event
stream (`docker events`, volume `mount` and container `start` events, with no
`--since`, so nothing depends on the engine's short event history). It proves
the subscription live by creating and starting a no-op marker container
(`hack-data-export-<random>-start`, no network, no logging) and waiting for
that container's start event. Markers are tracked like the volume helpers:
their create and start are bounded by `HACK_DATA_COMMAND_TIMEOUT_MS`, and
each is removed and its removal confirmed on every path, a signal included; only then does it check for running containers and copy. Every helper
runs under a unique name (`hack-data-export-<random>`), so its own mounts are
told apart from anything else's. After the last copy it lists running
containers again, runs an end marker and waits for its start event (the
engine emits events in order, so every earlier event has then arrived), stops
the subscription and decides:

- a mount of a copied volume by any other container, even one that started
  and exited during the copy, refuses with `E_PROJECT_RUNNING` and
  `error.detail.mounts` (volume, container ID and name);
- an event stream that ended before Hack stopped it, an unreadable event, or
  a marker whose start event did not arrive within 30 seconds refuses with
  `E_DOCKER_UNAVAILABLE`: Hack lost coverage and cannot prove nothing else
  wrote.

Either refusal leaves the copy unpublished in `<backup>.partial/`. On every
path the events child is stopped (SIGTERM, a two-second drain, then SIGKILL)
and awaited; on Ctrl-C or SIGTERM the export also force-removes its running
helper containers by name before exiting.

## How it copies

Each owned volume is held by one helper container for its whole copy. Hack
creates it from the image the storage witness already pins
(`oven/bun@sha256:1846adf2…`) with a unique name
(`hack-data-export-<random>`), `--network none`, `--log-driver none` (the raw
tar crosses the container's attached output, and a daemon's central logging
driver must never receive volume bytes), a read-only root filesystem,
`no-new-privileges` and the volume mounted read-only at `/v`, running `sleep
infinity`. Docker pulls the image digest once if it is not cached.

Once the container holds the mount, Hack inspects the volume again and
requires the identity it validated before: the same `CreatedAt`, driver,
mountpoint, options and Compose labels, and the container's own mount must
name that volume. A volume that was removed, replaced or relabeled in
between refuses with `E_PROJECT_RUNNING` (`detail.reason: volume_changed`)
and is not read. Docker creates a volume that is missing when a container
mounts it, so a volume removed in that gap may be left recreated, empty and
unlabelled.

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
removed: false}` and the `docker rm -f` command to run) instead of claiming
cleanup, and nothing is published. Ctrl-C or SIGTERM stops the event
subscription, force-removes the run's helper containers by name and reports
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

A resolved Docker volume name can carry interpolated env values (for example
`name: app-${TOKEN}`). The manifest, the `--json` output, the text summary and
error messages name volumes by Compose key only; the manifest keeps a sha256
of the resolved name so a restore can tell whether it changed.

## Format

```text
<parent>/<UTC timestamp>/          for example 20261123T140501Z
  manifest.json
  <key>.tar                        one per copied volume
```

The default parent is `$HACK_HOME/data-backups/<compose project>` (Hack's home
is `~/.hack` unless `HACK_HOME` is set). `--out <dir>` replaces the parent.
Directories and files are created private to your user (0700 and 0600).

`manifest.json` (schema `hack.data-backup.v1`):

| Field | Meaning |
| --- | --- |
| `project`, `branch`, `composeProject` | Hack project name, branch slug or null, Compose project name |
| `createdAt` | UTC start time, ISO 8601 |
| `hackVersion`, `helperImage`, `digestAlgorithm` | Version that wrote it, pinned helper reference, `hack.tree-digest.v1` |
| `volumes[]` | `key`, `nameSha256` (sha256 of the Docker volume name, never the name itself), `driver`, the two ownership `labels`, `file`, `tarBytes`, `tarSha256`, `entries` (the root included, sockets not), `excludedSockets`, `contentDigest` |
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
