# Step store model coverage (HACK-2461)

`StepStore.tla` checks the design of the step store before its code exists: when a
stored step result may replace the work, when garbage collection may delete a
record, and which digest one command uses for a mutable image tag.
`../stat-keyed-hash/StatKeyedHash.tla` checks the file-hash index the store uses
for executables, archives and source files.

This is a design model. No store code is on this branch yet. The tie table below
names the code and the test that each later slice of HACK-2461 must add (P1 store
and keys, P2 file hashes, P4 image tags, P5 guest uploads, P8 garbage collection);
a row is covered only when its test exists.

## Charts

Rendered with Pele 1.9.0 and the house theme, one chart per control variable.
Sources: [states.mmd](states.mmd), [gc.mmd](gc.mmd), [tag.mmd](tag.mmd). `pc` uses
one state per value; `pruning` shows `None` and one schematic key `k`; `tag` (`[d, age]`) groups its values into
absent, fresh and expired, as the chart's note says. Each SVG has light and dark
2x PNGs beside it (`*@2x.png`, `*.dark@2x.png`), made with Chromium and the Geist
font. The label checker passes on all six SVGs with Geist installed; without
Geist a fallback font draws edge labels up to 7 px wider than their boxes.

![One step and its record](states.svg)

![Garbage collection](gc.svg)

![One tag record](tag.svg)

## What the model holds

One step of one class (constant `Class`):

| Class | Output | A record may replace the work when |
| --- | --- | --- |
| `cas` | stored by content address in the store; never changed in place | the record exists |
| `slot` | one path that a later run may overwrite (the Compose override) | the record exists and the slot holds this input's output |
| `boot` | lives in the VM; the key carries the boot id | the record for this boot exists and one observation finds the output |

The world may change the input at any time, reboot the VM, remove slot and
boot outputs (`Drift`) and kill the process between the effect and its record
(`Crash`).

**Assumption for the cas class:** cas objects are removed only by garbage
collection (`positive-cas` runs with `Drifts = FALSE`). A cas record alone
replaces the work, so an object deleted or corrupted by anything else would make
a skip unsound in this model. The store must hold that line in code: objects live
in the store's own private directory, and a read verifies small objects' content
(the step-store design's crash-safety rule).
Garbage collection deletes a record first and its cas object second, and only
while no command holds the key. One tag has a stored resolution with an age; the
registry may move the tag; a resolve may fail (offline).

## Invariants

| Invariant | In plain words |
| --- | --- |
| `NoUnsoundSkip` | A step is skipped only when a record exists for its current inputs and its output is present. |
| `NoPruneInUse` | Garbage collection never deletes an output that a running command took from a skip or a record. |
| `OneDigestPerCommand` | One command uses one digest for each tag. |
| `NoSilentStaleTag` | A tag record older than the time limit is used only after a failed resolve in the same command (offline, shown as stale). |
| `PullResolves` | The digest `hack pull` reports was resolved in its own command. (A safety property: the model does not check that a pull finishes.) |

### Which configuration exercises each invariant

Three of the invariants are written into the guards of the positive configs, so a
positive cannot break them by construction; the controls carry that check.

| Invariant | Exercised by the positives | Carried by the controls |
| --- | --- | --- |
| `NoUnsoundSkip` | `positive-cas` (a cas record is trusted without an observation). In slot and boot `Usable` already requires the output to be present | record-first, no-verify (slot, boot), no-epoch, late-key, object-first |
| `NoPruneInUse` | `positive-cas` only: slot and boot records have no store object to delete | no-pin |
| `OneDigestPerCommand` | none: the mixed flag is set only on the `ResolvePerUse` branch | resolve-per-use |
| `NoSilentStaleTag` | none: `UseTag`'s guard already excludes the stale case | ignore-ttl |
| `PullResolves` | all three | none (no control) |

`NoVerify` removes the observation at three places at once: the skip
(`Usable`), the record (`Record`) and the lost-effect check (`RecordLost`).

## Checked bounds

TLC 1.7.4, Java 17, the runner's settings (two workers, 512 MiB heap). Two inputs,
`TTL = 1`, tag digests `{1, 2}`.

| Configuration | Bounds | Result |
| --- | --- | --- |
| `positive` | boot class, drift, `MaxBoot = 2` | no error, 1,082,240 distinct states |
| `positive-slot` | slot class, drift, `MaxBoot = 2` | no error, 284,160 distinct states |
| `positive-cas` | cas class, no drift, `MaxBoot = 2` | no error, 184,320 distinct states |
| `negative` (`RecordFirst`) | cas, `MaxBoot = 1` | `NoUnsoundSkip` at `Skip` |
| `no-verify-slot` | slot, no drift, `MaxBoot = 1` | `NoUnsoundSkip` at `Skip` (inputs A, B, A in one slot) |
| `no-verify-boot` | boot, drift, `MaxBoot = 2` | `NoUnsoundSkip` at `Skip` |
| `no-epoch` (with `NoVerify`) | boot, no drift, `MaxBoot = 2`, one input | `NoUnsoundSkip` at `Skip` on the second boot |
| `late-key` | cas, `MaxBoot = 1` | `NoUnsoundSkip` at `Skip` |
| `no-pin` | cas, `MaxBoot = 1` | `NoPruneInUse` at `PruneFinish` |
| `object-first` | cas, `MaxBoot = 1` | `NoUnsoundSkip` at `Skip` (a record names a deleted object) |
| `ignore-ttl` | cas, `MaxBoot = 1` | `NoSilentStaleTag` at `UseTag` |
| `resolve-per-use` | cas, `MaxBoot = 1` | `OneDigestPerCommand` at `UseTag` |

The positive state counts are pinned in `scripts/lib/tla-runtime-models.ts`. A
control is checked by its invariant and its final state's `bad` flag, which only
the offending action can set. Its state count varies with the two-worker search.

`NoEpoch` runs together with `NoVerify`: in this model the observation alone keeps
boot skips sound, and the boot id in the key makes a stale record miss without an
engine call. The control has one input, so no input change can make a no-verify
skip unsound in one boot: the failure needs the second boot. The same
configuration without `NoEpoch` passes.

## What TLC found in the first draft (both changed the design)

1. A command that produces a cas object that already exists races a prune of the
   old record: the prune deletes the object after the command produced it and
   before it recorded it. Fix: pin the key before producing; at the object's
   deletion, re-check that no record and no pin names it.
2. Pruning a record removed the slot file and the VM's output with it. Fix: garbage
   collection deletes only cas objects; a slot or boot record is only forgotten.

## Tie to code (to be filled by each slice)

| Model action | Code | Test that walks it | Slice |
| --- | --- | --- | --- |
| `Skip`, `Usable` | `store::lookup` | `hit_needs_observation_for_slot_and_boot_not_for_cas` | P1 |
| `Execute` pins first | `store::pin` | `key_is_pinned_before_the_output_is_written` | P1 |
| `Record` after observation | `store::record` | `record_written_only_after_the_effect_is_read_back` | P1 |
| `RecordLost` | step driver | `effect_lost_before_record_runs_again` | P1 |
| `Crash` | process death | `torn_record_is_a_miss_and_is_deleted`; `tmp_file_left_by_a_dead_writer_is_removed_by_gc` | P1, P8 |
| `PruneStart`, `PruneFinish` | `store::gc` | `gc_skips_while_any_command_holds_the_store`; `object_deleted_only_if_no_record_names_it_again` | P8 |
| `Reboot` | boot epoch | `boot_record_misses_on_new_guest_boot` | P5 |
| `Drift` | external removal | `probe_binary_removed_in_guest_is_sent_again` | P5 |
| `ChangeInput`, `LateKey` | key from the input struct | per-step property tests; shared key vectors in Rust and TypeScript | P1 on |
| `Resolve`, `UseTag` | `store::tags` | `one_resolution_per_command_for_repeated_references` | P4 |
| `Tick` past the limit | `store::tags` | `expired_tag_resolves_on_the_next_command` | P4 |
| `ResolveFails` | `store::tags` | `offline_uses_present_image_and_marks_it_stale`; `pull_fails_offline` | P4 |
| `PullDone` | `hack pull` | `pull_always_resolves` | P4 |
| `StatKeyedHash` | `store::index` | `racy_file_is_not_recorded`; `restored_mtime_is_caught_by_ctime`; `stat_moved_during_read_is_not_recorded` | P2 |

## Not covered

- More than one step, and steps feeding each other (cas output digests as inputs
  downstream).
- Concurrent writers of one record (identical content, atomic rename) and two
  garbage collectors (the exclusive lock).
- Torn files after power loss (the record's `check` field; covered by tests).
- Hash collisions. Stat-key edge cases beyond `StatKeyedHash`: inode reuse after
  delete and recreate, coarse ctime filesystems, a same-user adversary.
- The offline fallback's presence check (the image must be present); `hack pull`
  failing offline is not a modelled action.
- Liveness, the size budget, and time other than the tag's age.
- `PullResolves` has no negative control, and no liveness: a pull that never
  reports is not a violation.
- Outputs of the cas class removed by anything other than garbage collection.
- A pass checks the design at these bounds. It does not prove the
  implementation, durability, engine behaviour or performance.
