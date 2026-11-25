# Upgrade snapshot restore

`Restore.tla` follows one target of `restoreUpgradeSnapshot` in
`src/lib/upgrade-snapshot.ts` (`hack upgrade rollback`). The target holds the
snapshot's original `O`, the step output `S` that the snapshot recorded as its
after state, a user's edit `E`, or nothing. `aside` is the snapshot's private
`displaced/` directory for that target, oldest first; its first `consumed`
files have lost their key and are never adopted. A crash (SIGKILL) may follow
any step; the next invocation starts from what is on disk. One user write and
one user deletion may land at any time. Each invocation may pass `overwrite`
(`force`). The ghost `done` records that a restore has completed (returned
`restored`, or a rerun found the target already restored); `emptied` records
a user deletion after that.

The positive TLC exploration (`Resume = TRUE`, `Consume = TRUE`) exhausts 613
distinct states. Two negative controls must fail:

- `negative.cfg` (`Resume = FALSE`, the code before HACK-2188) fails
  `InterruptedRestoreResumes`: a restore killed after it moved `S` aside and
  before it published `O` leaves the path empty, and a plain rerun refuses it
  as changed. The witness is an idle, non-forced conflict with an empty target
  and `S` as the newest displaced file.
- `kept-keys.cfg` (`Consume = FALSE`, the first HACK-2188 fix before review)
  fails `DeletionKept`: a completed restore left `S` keyed, the user deleted
  the restored file, and a plain rerun adopted `S` and recreated `O` without
  `overwrite`. The witness is a non-forced `restored` outcome after `emptied`
  with `S` still keyed (`consumed = 0`).

| Action / invariant | Source and regression |
| --- | --- |
| `Start` | `restoreStart`: already restored, recorded step output, an empty path whose newest displaced file (`newestDisplaced`, keyed by `displacedName`) holds the after state, or `overwrite`. Any other newest displaced file is a conflict that names it (`interruptedAside`). |
| `Stage` | `stageFile` and `hardLinksWork` in the private `staging/` directory. |
| `Displace` / `LinkBack` | `displaceTarget` and `lateEditBack`: one rename into `displaced/`; a late edit is linked back unless the name was taken. |
| `Publish` | `publishOrPutBack` / `publishStaged`: a hard link that refuses an occupied name. |
| `Settle`, `ConsumeAll` | `settleDisplaced` / `consumeDisplaced`: after `restored`, `moved-aside` or `already-restored`, every keyed displaced file of the target is renamed without its key (hard link, then unlink). `Start` on an already-restored target settles too, which covers a kill between publication and the rename. `tests/upgrade-snapshot.test.ts`: a plain rollback after the user deletes a restored file is refused and the path stays empty, at every kill boundary and after a direct restore; a keyed file left by such a kill is settled by the already-restored rerun; a refused publication's older keyed file is consumed with the newer one. |
| `UserDelete`, `DeletionKept` | Once a restore has completed, a plain rerun never recreates a path the user emptied; only `overwrite` restores it. |
| `Crash` | `tests/upgrade-snapshot.test.ts` SIGKILLs `tests/fixtures/upgrade-restore-worker.ts` at all six staged/displaced boundaries of three targets (removed, rewritten with a new mode, created), then a plain rerun restores exact bytes and modes. A killed `overwrite` restore of an unrecorded target is reported where it was kept, then finished by `overwrite`. `tests/upgrade-apply.test.ts` kills rollback at every boundary of a real `ignore-rules` apply over two checkouts, and rolls back straight after SIGKILL at each of the seven apply boundaries. |
| `EditKept`, `StepOutputKept` | Nothing is deleted: displaced files stay in the snapshot and are reported as `keptAs`. |
| `RestoredIsOriginal` | A `restored` result means the path holds the snapshot's copy. |

The model abstracts each rename, hard link and unlink as atomic and serializes
restores (the CLI rollback holds the snapshot's apply lock). It does not model
other targets, filesystem durability or fsync, the cross-filesystem and
no-hard-link refusals, damaged blobs, non-file entries, a staged copy left by a
crash (private, never published) or targets that were absent in the snapshot
(their rerun is already-restored and never resumes). No fairness or eventual
completion is asserted.

Not covered by the fix: a user who deletes the restored file in the moment
between a killed restore's publication and its key drop, with no rerun in
between, is still resumed (the model's `done` stays false there). Displaced
files written by versions before HACK-2188 carry no key and are never adopted:
a rollback that an older binary interrupted still needs `overwrite`.
