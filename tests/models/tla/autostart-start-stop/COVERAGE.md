# Autostart start/stop admission

This finite model checks one login child and one foreground `down` targeting the
same Compose project and branch. Both initially stopped and initially running
runtime states are explored. There is one pause publication, one start opportunity,
one shutdown attempt and no later explicit `up` or resume. No fairness or eventual
start/stop guarantee is asserted.

`NoStartAfterSuccessfulDown` means the earlier login child never issues its start
effect after `down` has returned successfully. The positive configuration also
checks `SuccessfulDownIsStopped` and all variable domains. Admission, the runtime
start effect, child settlement, pause publication, stop and successful return are
separate transitions; they are not collapsed into one atomic command.

| Model action | Source boundary | Regression mapping |
| --- | --- | --- |
| `DownPause` | `handleDown` first pins the reconciled runtime branch, then publishes pause through `updateAutostartIntent` before waiting for that instance lock. | `tests/autostart-lifecycle-intent.test.ts`: source down pauses before waiting for a start and holds admission through runtime shutdown. |
| `LoginLock` / `LoginAdmit` / `LoginRefuse` | `withAutostartCommandLock` and `withAutostartProjectLock` serialize the actual CLI child; `assertAutostartProjectCurrent` rereads trusted intent while admission is held. | The same source-down regression rejects the earlier start after pause and a queued later start after successful down. |
| `ChildStart` / `ChildSettle` | Runtime startup effects execute inside the login child's project lock; the owning command settles before lock release. A child admitted just before pause may finish before down obtains the lock. | `tests/autostart-project-lock.test.ts`: start/stop admission serializes the Compose instance even after registry identity changes. |
| `DownLock` / `DownStop` / `DownReturn` | Foreground down holds the same instance lock through runtime shutdown and successful return. | The source-down regression blocks a queued start while fake shutdown is still running. |
| `ChildCrashOrFailure` / `DownFailure` | Failed commands do not establish successful down; a settled child has no further modeled startup effect. | These are abstract assumptions; the model does not qualify process-tree cancellation or dead-owner recovery. |

The positive configuration exhausts **41 distinct states** (68 generated), with
two initial states and maximum depth seven. The negative configuration enables
only `ReleaseBeforeChildSettles`: it releases the login lock while the child is
still pending. TLC must fail `NoStartAfterSuccessfulDown` at `ChildStart`, in the
same state containing `holder = "none"`, `paused = TRUE`, `child = "started"`,
`running = TRUE`, `down = "done"` and `lateStart = TRUE`. A parse error, incomplete
successor, unrelated invariant failure, partial search or timeout is not evidence.

The contract is registered in `scripts/lib/tla-runtime-models.ts` and consumed by
`scripts/check-tla-models.ts`. The standard contract tests automatically exercise
its expected state count and exact negative witness. TLC uses the repository's
checksum-pinned TLA+ 1.7.4 artifact; the local qualification used Java 17, two workers
and a 512 MiB heap.

The shared project lock is assumed exclusive and continuously owned until the
effect-capable child settles. Pause writes are abstract committed atomic updates.
The model does not prove filesystem durability, registry trust, alias/key mapping,
PID identity or lock reclamation, real engine requests, descendant-process cleanup,
or any late runtime effect surviving termination of the lock-owning CLI child.
In particular, `ChildCrashOrFailure` revokes all remaining child effects; that is a
failure assumption, not proof that an orphaned engine request cannot finish later.
`runtime-backend.ts` now forwards cancellation to each owned detached Compose
phase, and `shell.ts` waits for an owned-group census before cancellation returns.
`tests/runtime-backend-cancellation.test.ts` exercises real task-owned phase
descendants that ignore TERM; it maps this process boundary to `ChildSettle`.
The outer login deadline allows five seconds for the inner two-second escalation
and bounded settlement. Killable processes and a functioning process census are
assumptions; SIGKILL of the CLI, host failure, and an engine request already
accepted outside its client group remain outside this finite model.
Unattended Compose now checks intent before preparation and before starting
containers, and never builds, pulls or executes configured host commands.
`runtime-backend-unattended.test.ts` maps a pause before preparation to zero
subprocess calls; `autostart-host-boundary.test.ts` checks the actual host runners.
Closed manual-start refusals can release a boot claim through a boot/branch
compare-and-set before any start. This model does not cover that registry ledger;
`project-autostart.test.ts` covers stale, changed-target and real-failure refusal
cases, and daemon tests cover neutral progress and same-boot recovery.
Multiple projects, multiple login attempts, reboot, upgrades, global pause, retries,
network prompts, native backends and real login-service behavior are outside this
model. Component model success does not qualify installed binaries or real login.
