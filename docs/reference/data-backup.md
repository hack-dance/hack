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

`--path`, `--project` and `--branch` select the project and instance like
other project commands. The command needs the Compose backend: with
`HACK_RUNTIME_BACKEND=native` it refuses with `E_NATIVE_PROJECT_UNSUPPORTED`
and changes nothing.

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
with `hack down` and retry. Hack never stops anything for an export. It checks
again after copying, and a container that started meanwhile also refuses, so
the copy is never published.

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
   one NUL byte: path, type (`f` `d` `l` `c` `b` `p` `s`), permission bits in
   octal, uid, gid, size (regular files, otherwise 0) and content (a regular
   file's sha256, a symlink's target, a device's rdev, otherwise empty). The
   digest is the sha256 of that stream. A restore runs the same script on the
   restored volume and compares.

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
| `volumes[]` | `key`, `name`, `driver`, the two ownership `labels`, `file`, `tarBytes`, `tarSha256`, `entries` (the root included), `contentDigest` |
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
