# Env migration protocol

![Journal publication and separate cleanup](env-migration.svg)

The [diagram source](env-migration.mmd) uses the same control states and guards as
the [finite model](../../tests/models/tla/env-migration/COVERAGE.md). An idle state
can mean interrupted or complete; only completed migration can request cleanup.

`hack env migrate` prepares a project migration without writing files. It works
with Compose on Linux and macOS and does not contact Docker, a daemon or a native
runtime. `--path` selects one project; every legacy overlay is included.

```sh
hack env migrate --path ./app --json
hack env migrate --path ./app --apply --accept-tracked-env-changes
# Run and check the complete project before retiring its old copies.
hack up --path ./app
hack env migrate --path ./app --cleanup --json
hack env migrate --path ./app --cleanup --apply --accept-tracked-env-changes
hack env migrate --path ./app --rollback-manifest /private/snapshot/manifest.json
# Explicit recovery when a later edit prevents ordinary rollback:
hack env migrate --path ./app --rollback-manifest /private/snapshot/manifest.json --preserve-changes
```

Omit `--accept-tracked-env-changes` when the operation changes no tracked file.
It grants consent to tracked edits for apply, or tracked removals and config
pointer repair for cleanup. It never disables the delivery, snapshot or live-input
checks. Non-interactive invocations do not choose values or overwrite later edits.

## Preview JSON, version 1

`--json` uses the CLI result envelope: `{ "ok": true, "data": ... }`.
The preview's `data` has these stable fields:

| Field | Meaning |
| --- | --- |
| `version` | Integer `1`; consumers must reject unsupported versions. |
| `project` | `projectRoot`, `projectDir`, `projectName` and `serviceNames`; paths are absolute and canonical. |
| `status` | `ready` for unfinished migration work; `complete` when migration has completed; `recovery_required` for interrupted cleanup or rollback. |
| `action` | `preview`, or `cleanup` with `--cleanup`. |
| `dryRun` | Always `true` for a preview. |
| `files` | Ordered array of `{ path, action, keys, tracked }`. |
| `journalPath` | Absolute path where apply keeps its private journal; preview does not create it. |
| `manifestPath` | Absolute rollback manifest path once a journal exists, otherwise `null`. Available after interrupted apply even if that apply printed no result. |

Each file `action` is `write` (absent destination), `change` (existing destination)
or `removable` (a legacy copy eligible for the separate cleanup checks). `keys`
contains names only; config, key and ignore files have an empty array. `tracked`
is conservative: unknown Git status in a checkout counts as tracked. A cleanup
preview includes `removable` entries and any `change` to repair a store pointer.
These are candidates, not deletion
authority: apply checks the successful project run, original snapshot and current
delivery again. Finished publications are omitted on resume, and a completed
migration previews no further write or change. Confirmed removals are omitted.
When needed, the plan includes `.hack-staging/.gitignore` beside a destination.
This self-ignoring private staging guard is published before any value file.
Rollback retains these guards so interrupted or concurrent staging remains
invisible to ordinary Git additions; they hold only the fixed `*` ignore rule.

For example, an entry can be:

```json
{"path":"/project/.hack/hack.env.local.yaml","action":"write","keys":["API_TOKEN"],"tracked":false}
```

There are no values, ciphertext or key bytes in this JSON. Preview does not create
keys, ignore entries, locks, journals, snapshots or env files. Inputs that cannot
be read safely refuse with a value-free error. Preview is an observation; apply
prepares and checks its own immutable plan against the inputs before publication.
The exact plan requires reading legacy values and checking delivery in memory.
A configured native credential backend can request its ordinary authorization;
Hack does not bypass that prompt or include the values in the preview.

## Apply and recovery

Apply takes a private snapshot of originals and absent destinations before
publishing any migration target. The journal and staged payloads live outside working trees under
Hack's private data directory. The snapshot manifest and journal hold only names,
paths, statuses, modes, sizes and SHA-256 checksums. Original bytes and staged
payloads are separate private files; they can contain values and keys and must
remain private.

Each publication has an original checksum, an intended checksum and a completion
receipt. A retry skips completed steps and adopts a matching publication whose
rename succeeded before its receipt. Before publishing another file, a retry
revalidates the snapshot manifest and every original-file blob against the
journal. Missing or damaged rollback coverage refuses before publishing another
migration target; restore the intact snapshot bytes before retrying. An
unexpected input or destination change
refuses instead of guessing. Re-run the same apply command after interruption.
After completion it returns `already_complete` without rewriting the project or
journal. `doctor --migrate-env-config` uses the same apply/journal path and keeps
all legacy files. Doctor can also perform its existing hygiene repairs before
migration, such as adding ignore rules or tightening permissions; those separate
doctor repairs are outside the env migration journal. Use `hack env migrate
--apply` when the preview and rollback must cover only the migration's writes.
Implicit migrations from env, session and startup commands also use this journal
and keep legacy files; they preserve existing
Compose `env_file` references.
Implicit commands refuse an unfinished apply or rollback journal before using
partially published layers. Resume the explicit apply or rollback command first.

When implicit migration retained legacy Compose `env_file` references, a later
explicit preview or `doctor --migrate-env-config` can offer their repair. This is
a new journalled phase: completed env layers are not published again, tracked
Compose edits require fresh consent, and migrated values must still resolve.
The Compose before image must be unchanged and covered by the original intact
snapshot; the same manifest rolls back the whole migration, including this
later repair. A fresh read revision permits unrelated additions in existing
layers and permission tightening by Doctor, while refusing changed legacy bytes
or lost migrated values. Its pending journal freezes that revision for resume.
The phase retains all legacy files and clears an earlier startup proof, so
cleanup still needs a later successful full-project run. Once the repair is
complete, another explicit apply is a no-op.

Migration refuses a Git-tracked project key path even when its file is absent
from the worktree, including case-folded aliases such as `.Hack.Secret.Key`.
Tracked-change consent does not allow publishing key bytes at that path.
Git tracking is checked again under the key lock before publication;
keep the key out of the index before resuming a refused migration.

Completed publication payloads are removed; retries also sweep receipted orphan
staging directories. Unknown or edited entries are retained, reported as
`payloadCleanup: "kept"` in the apply result. Original snapshot blobs remain for
rollback. A private data home inside a Git working tree refuses apply; choose a
private `HACK_HOME` outside repositories, including a home managed as dotfiles.

Snapshot storage must also share a filesystem and mount with every migration
target, with hard links permitted: the snapshot library restores with rename and
hard links. Apply admits the storage location before copying original inputs,
then checks the completed snapshot again before publishing any migration target.
Cleanup and rollback repeat the snapshot check. Admission briefly links an
exclusively created, empty `.hack-env-restore-probe-*` file from the
storage directory (or its nearest existing parent before capture) to each
existing target parent, then removes both names. These temporary probes contain
no input bytes and are not migration targets in `files`; preview
never creates them. A process killed during an apply, cleanup or rollback check
can leave an empty probe. It is retained rather than removed by matching its
name alone.

An interruption after snapshot capture but before journal publication
can leave a private original-file snapshot; `hack upgrade rollback` without a
manifest lists retained snapshots. The snapshot can contain original values and
keys in private blobs, although its manifest contains metadata only. Keep it
private even when no migration target was published. If admission refuses,
choose a private `HACK_HOME` on the target mount outside
Git working trees, then retry the preview. Matching device numbers alone do not
prove that two paths share a mount, for example with Linux bind mounts.

Migration never includes cleanup. A later explicit cleanup requires:

1. A completed migration and a successful full-project `hack up`; service-only
   startup does not qualify. Layer changes since that run require another run.
   The run uses its selected overlay. Other overlays receive a fresh static
   delivery check; this is not a claim that each overlay was run.
2. An intact snapshot containing each original cleanup target.
3. Fresh agreement between legacy values and current YAML delivery, under the
   existing source/destination writer locks.
4. The live-input guard at selection and immediately before each deletion.
   Current project/shared keys, configuration and YAML layers, including aliases
   and hard links, cannot be removed.

Legacy stores leave before their keys. Confirmed store removal also repairs its
config pointer. A partial cleanup preserves confirmed removals in the journal and
reports every confirmed removal even if pointer repair or snapshot receipt
recording fails. Pointer repair is attempted before recording removal receipts;
if repair cannot be confirmed, the error warns about a possible stale pointer.
When a delivery or live-input refusal happens before any unlink or pointer
publication, the migration stays complete and cleanup remains retryable after
correcting the inputs. Uncertain or partial removals require snapshot rollback.
If cleanup is interrupted, use its rollback manifest before
retrying; it does not infer fresh deletion authority from an old receipt.

Rollback restores originals before reversing publications, so legacy values are
available before new layers leave resolution. Project keys remain in place,
including a newly created shared key: another checkout may already use it. The
root key ignore entry is retained with a checkout-local key. The rollback result
names these paths in `retained`; key removal is not part of rollback.
Ordinary rollback refuses later edits. Explicit `--preserve-changes` restores the
originals and keeps replaced bytes privately in the snapshot instead; it does not
select or merge values. Rollback can resume an incomplete restoration. An
incomplete rollback exits 1 in both JSON and plain modes, preserving its per-file
restoration details and leaving the journal in `rolling_back`. Project commands
remain blocked until the same rollback completes; a restored result exits 0.
Keep the manifest, blobs and journal together until the upgrade is accepted.
Neither file-level atomic writes nor cooperative
locks protect against an unrelated process replacing files outside Hack's locks.

### Recovering retained edits

Rollback JSON includes `preserved: [{ path, backupPath }]` for files the snapshot
provider kept while restoring. `path` identifies the original file and
`backupPath` identifies its retained bytes. The lower-level per-file `results`
also retain the provider's `keptAs` and status, including incomplete outcomes.
These fields contain paths only. The files themselves can hold values and keys.

Use the named backup path to recover a file into a **new private path outside Git
working trees**. For example, after choosing an existing private recovery
directory, this copies bytes without printing them or overwriting an existing
destination:

```sh
umask 077
set -C
cat /private/snapshot/blobs/RECORDED_SHA256 > /private/recovery/recovered.yaml
```

Replace the source with the returned `backupPath`. Inspect or reconcile the
recovered file privately; do not paste its contents into reports. Keep the
snapshot until every retained edit has been recovered or deliberately retired.
