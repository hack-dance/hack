# Upgrade snapshot restore

`Restore.tla` follows one target of `restoreUpgradeSnapshot` in
`src/lib/upgrade-snapshot.ts` (`hack upgrade rollback`). The target holds the
snapshot's original `O`, the step output `S` that the snapshot recorded as its
after state, a user's edit `E`, or nothing. `aside` is the snapshot's private
`displaced/` directory for that target, oldest first. A crash (SIGKILL) may
follow any step; the next invocation starts from what is on disk. One user
write may land at any time. Each invocation may pass `overwrite` (`force`).

The positive TLC exploration (`Resume = TRUE`) exhausts 104 distinct states.
The negative control (`Resume = FALSE`, the code before HACK-2188) must fail
`InterruptedRestoreResumes`: a restore killed after it moved `S` aside and
before it published `O` leaves the path empty, and a plain rerun refuses it as
changed. The witness is an idle, non-forced conflict with an empty target and
`S` as the newest displaced file.

| Action / invariant | Source and regression |
| --- | --- |
| `Start` | `restoreStart`: already restored, recorded step output, an empty path whose newest displaced file (`newestDisplaced`, keyed by `displacedName`) holds the after state, or `overwrite`. Any other newest displaced file is a conflict that names it (`interruptedAside`). |
| `Stage` | `stageFile` and `hardLinksWork` in the private `staging/` directory. |
| `Displace` / `LinkBack` | `displaceTarget` and `lateEditBack`: one rename into `displaced/`; a late edit is linked back unless the name was taken. |
| `Publish` | `publishOrPutBack` / `publishStaged`: a hard link that refuses an occupied name. |
| `Crash` | `tests/upgrade-snapshot.test.ts` SIGKILLs `tests/fixtures/upgrade-restore-worker.ts` at all six staged/displaced boundaries of three targets (removed, rewritten with a new mode, created), then a plain rerun restores exact bytes and modes. A killed `overwrite` restore of an unrecorded target is reported where it was kept, then finished by `overwrite`. `tests/upgrade-apply.test.ts` kills rollback at every boundary of a real `ignore-rules` apply over two checkouts, and rolls back straight after SIGKILL at each of the seven apply boundaries. |
| `EditKept`, `StepOutputKept` | Nothing is deleted: displaced files stay in the snapshot and are reported as `keptAs`. |
| `RestoredIsOriginal` | A `restored` result means the path holds the snapshot's copy. |

The model abstracts each rename, hard link and unlink as atomic and serializes
restores (the CLI rollback holds the snapshot's apply lock). It does not model
other targets, filesystem durability or fsync, the cross-filesystem and
no-hard-link refusals, damaged blobs, non-file entries, a staged copy left by a
crash (private, never published) or a user who deletes a restored file. No
fairness or eventual completion is asserted.
