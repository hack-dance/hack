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
and env overlay like other project commands. Every Docker call (Compose, the
volume and container reads and the helper runs) gets the same managed Compose
env `hack up` gives the project, so a project that selects its engine with a
managed `DOCKER_HOST` or `DOCKER_CONTEXT` is read on that engine. The command
needs the Compose backend: with `HACK_RUNTIME_BACKEND=native` it refuses with
`E_NATIVE_PROJECT_UNSUPPORTED` and changes nothing.

## What it backs up

Hack reads the resolved Compose model (`docker compose config`, with the same
files and project name `hack up` uses) and takes its top-level named volumes.
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
the subscription live by running a no-op marker container
(`hack-data-export-<random>-start`) and waiting for that container's start
event; only then does it check for running containers and copy. Every helper
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

Each volume is mounted read-only at `/v` in the helper image the storage
witness already pins (`oven/bun@sha256:1846adf2…`), with `--rm`,
`--network none`, a read-only root filesystem and `no-new-privileges`. Docker
pulls that digest once if it is not cached. Two helper runs read each volume:

1. `tar --numeric-owner -cpf - -C /v .` streams the tree to `<key>.tar`. The host
   computes the tar's sha256 while writing it. Numeric owners, modes, symlinks
   and hard links are kept; times are kept by tar but are not part of the
   digest. Extended attributes and ACLs are not copied.
2. A Bun script computes the tree digest `hack.tree-digest.v1`. Every entry
   (the root as `.`, then each path relative to the root, as raw bytes) is
   sorted bytewise. For each entry, seven fields are hashed, each followed by
   one NUL byte: path, type (`f` `d` `l` `c` `b` `p`), permission bits in
   octal, uid, gid, size (regular files, otherwise 0) and content (a regular
   file's sha256, a symlink's target, a device's rdev, otherwise empty). The
   digest is the sha256 of that stream. A restore runs the same script on the
   restored volume and compares.

Unix sockets are not copied. GNU tar skips them (`socket ignored`), so the
digest leaves them out too and the manifest counts them per volume as
`excludedSockets`; the text summary says how many were not copied. Sockets
are runtime artifacts, such as `mysql.sock` in a MySQL data directory, that
the service recreates when it starts.

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
| `volumes[]` | `key`, `name`, `driver`, the two ownership `labels`, `file`, `tarBytes`, `tarSha256`, `entries` (the root included, sockets not), `excludedSockets`, `contentDigest` |
| `skipped[]` | `key`, `name` and `reason`: `external`, `foreign` or `absent` |

`--json` prints the standard envelope with `data.schema` `hack.data-export.v1`,
`data.backup` (the backup path) and `data.manifest`.

## Atomicity

Everything is written into `<backup>.partial/`. The manifest is written last,
the files and directory are fsynced, and the directory is renamed to
`<backup>/`. An interrupted or failed export leaves only the `.partial`
directory. It is never a backup: Hack never reads, reuses or completes it, and
you can delete it. Each run uses a new timestamp; if the target or its
`.partial` already exists (two runs in the same second), the export refuses
with `E_PATH_CONFLICT` instead of writing into it.

## Restore (`hack data import`)

`hack data import <backup-dir> [--from-project <name>] [--json]` takes the
same `--path`, `--project`, `--branch` and `--env` selection and managed env
as export, and refuses the native backend the same way. It never overwrites,
deletes or relabels data it does not own.

Before any change it checks, in order:

1. **The backup.** A `.partial` directory, a directory without
   `manifest.json`, a manifest that is not `hack.data-backup.v1`, or a tar
   that is missing, is not a regular file, or differs in size or sha256 from
   the manifest refuses with `E_BACKUP_INVALID`. The backup id is the sha256
   of `manifest.json`.
2. **The source project.** The backup's `composeProject` must equal this
   instance's Compose project. To restore into a branch instance or a renamed
   project, pass `--from-project <backup's compose project>`; a missing or
   different value refuses with `E_USAGE`.
3. **Running containers.** As for export: `E_PROJECT_RUNNING` when a
   container of the instance, or any container mounting a target, runs.
4. **Targets.** A backed-up key that is no longer declared here, or is
   `external` here, is skipped and reported. For each other key the target is
   its Docker volume (`name:` or `<compose project>_<key>`):

| Target | Result |
| --- | --- |
| Absent | Created with `docker volume create` and Compose's labels (`com.docker.compose.project`, `com.docker.compose.volume`, `com.docker.compose.version` from `docker compose version --short`) plus `io.hack.data-backup.source=<backup id>` |
| Exists, labeled for this project and key, empty | Used as it is |
| Exists, labeled for this project and key, with data | Refused (`not_empty`), unless it is this import's own interrupted copy (below) |
| Labels name another project or key, or none | Refused (`foreign`); never mounted or changed |

Any refusal names every conflicting volume in one `E_DATA_TARGET_CONFLICT`
(`error.detail.conflicts`) and changes nothing. Move the volume aside, or back
it up with `hack data export`, then rerun. Compose accepts a volume created by
import as its own: it carries the same labels Compose writes, and Compose does
not require its config-hash label.

Then, per target: the journal records `started`; an absent target is
created; the tar is streamed into the pinned helper (`--rm`, `--network none`,
read-only root, `no-new-privileges`, the volume read-write at `/v`) running
`tar --numeric-owner -xpf - -C /v`; and the helper computes the same
`hack.tree-digest.v1` digest as export. A digest or entry count that differs
from the manifest marks the journal `failed`, leaves the volume as it is and
exits 1 (`E_UNEXPECTED`). After all targets, the import checks Docker's mount
events and running containers again, as export does; only then are the
journals marked `complete`.

### Interruption and recovery

The journal is `$HACK_HOME/data-imports/<compose project>/<key>.json`
(`hack.data-import-journal.v1`: backup id, backup path, key, target volume,
state `started`, `complete` or `failed`), written atomically. On a rerun, a
non-empty target is treated as this import's own partial copy only when all
of these hold: its `io.hack.data-backup.source` label is the same backup id,
the journal names the same backup and target, and the journal is not
`complete`. That copy is cleared inside the helper
(`find /v -mindepth 1 -delete`) and restored again. Any other non-empty
volume is refused as above, including one that already holds a completed
restore of this backup (`already_imported`).

An existing empty volume that the import filled has no source label (Docker
labels cannot be added later), so if that import is interrupted a rerun
refuses it; the message names the volume to remove with `docker volume rm`
after checking it.

`--json` prints the standard envelope with `data.schema` `hack.data-import.v1`:
`backup`, `backupId`, `sourceComposeProject`, `composeProject`, `volumes[]`
(`key`, `name`, `target` `created`, `empty` or `replaced-partial`, `entries`,
`excludedSockets`, `contentDigest`) and `skipped[]` (`key`, `reason`
`undeclared` or `external`).
