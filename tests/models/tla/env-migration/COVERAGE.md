# Env migration journal

`Migration.tla` bounds each publication phase to two files. Publish and receipt are separate
actions: an invocation can crash between them, then resume from retained bytes.
Completion, successful project startup and a later explicit cleanup request are
distinct. An implicit migration can defer a later explicit Compose repair;
`RequestRepair` starts that phase under intact snapshot coverage and invalidates
the earlier successful-run proof. The counters reset for the abstract later
phase; already completed layer publications remain outside that phase in the
implementation. Snapshot damage while legacy files remain blocks repair and cleanup. Live targets
cannot be removed. The unsafe control restores same-run deletion and must fail
`NoSameRunCleanup` at `UnsafeRemoveDuringApply`.
The positive TLC exploration exhausts 74 distinct states (four initial states
cover ordinary/live targets and deferred/completed Compose repair). The negative witness has zero publications,
an intact snapshot, a retained applying journal, no later cleanup request and a
removed legacy target. Both live-target initial states admit that witness.
The `stale-repair-proof` negative control retains an earlier successful-run proof
when repair starts and fails `FreshRunProof` at `RequestRepair`.

| Action / invariant | Source and regression |
| --- | --- |
| Prepare / NoLostOriginal | `prepareConsistent` and `prepareJournal` bind immutable payloads and source checksums to a checked private snapshot before project writes. Preview/apply parity and damaged-blob refusal use real files. |
| Publish, Record, Crash, Resume | `applyEnvMigration` publishes before recording provider/journal receipts; matching intended bytes are adopted on retry. `env-migration-journal.test.ts` SIGKILLs an owned child at every journal/publication boundary. |
| Finish / CompleteHasAllSteps | Resolution succeeds before the complete journal is published; completed retry is a no-op. |
| RequestRepair / FreshRunProof | `prepareDeferredComposeRepair` and `extendComposeRepair` admit only an unchanged, already snapshotted Compose target after implicit migration. Existing layer publications are kept, new input checksums are recorded, and prior startup proof is cleared. Real-file tests prove preview/apply parity, tracked consent, missing-value/backup refusal, tighter modes and rollback. Six additional SIGKILL boundaries cover the later repair. |
| SuccessfulRun, RequestCleanup, RemoveLegacy / NoSameRunCleanup | `recordEnvMigrationProjectRun` and `cleanupEnvMigration` require a later request, unchanged successful-run layer revision, intact snapshot and fresh delivery. Migration, including implicit routes, retains originals. |
| RefuseCleanup | A known delivery or live-input refusal before unlink returns to completed migration; unknown or partial effects require rollback. A real-file regression changes delivery immediately before removal, checks that every legacy file stays and the journal remains complete, then corrects delivery and successfully retries. The model abstracts the pre-removal refusal only; it does not model receipt failures or partial cleanup. |
| LiveInputsRetained | Existing #769 identity guard remains at candidate selection and immediately before deletion. The live-key regression uses real files. |
| Rollback | Snapshot adapter guards expected current bytes, restores legacy sources before reversing publications and preserves overwritten bytes. Round-trip and later-edit refusal use real files. |

The model abstracts each per-file rename and each journal write as atomic; it
does not prove filesystem fsync durability, descriptor/path identity, lock
reclamation, cryptography, real snapshot-provider behavior, partial cleanup or
rollback, unsynchronized external writers, process signal delivery, a successful
runtime's actual environment or any macOS behavior. No fairness or eventual
recovery is asserted. Arbitrarily many crashes stutter over a finite persistent
state; the real process test covers only its enumerated boundaries.
