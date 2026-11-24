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
| `DownPause` | `handleDown` first pins the reconciled runtime branch, then publishes pause through `updateAutostartIntent` before waiting for that instance lock. When the engine cannot be read to pin an implicit worktree target, `resolveFinalAutostartDownTarget` pauses the registration's marked instance (any branch) before failing. | `tests/autostart-lifecycle-intent.test.ts`: source down pauses before waiting for a start and holds admission through runtime shutdown. `tests/autostart-down-target.test.ts`: unavailable runtime still pauses a candidate marker. |
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
The source regression in `autostart-lifecycle-intent.test.ts` holds login startup
at Compose's prepare phase with a name interpolated from a managed overlay. It
checks that Down publishes pause and waits for the lock on that effective stack
before sending teardown to the same name. This exercises the name mapping that
the model assumes. A separate source regression checks that Down keeps the name
pinned by Desktop Start while delivering its saved overlay.
Ordinary Down publishes pause for a known copy before reading its overlay or
waiting for its checkout lock. A pre-publication race regression holds Desktop
Start before its pin is saved and verifies that Down waits and then stops that
same stack. The checkout lock is scoped to the logical copy so a synchronous
hook can stop a sibling. Reconciliation carries the observed Compose name across
the copy-lock handoff, then rechecks ownership under that name's lock. The
`project-down-worktree-safety.test.ts` dotenv override regression exercises the
handoff. Shared
runtime state writes use a separate lock and atomic replacement. These locks
and overlay-read failure are implementation details outside the finite model.
The source CLI also records the effective launch identity before startup. The
supervisor regression starts under a Compose name override and a nondefault
overlay, then checks that Down uses that overlay and retires the matching host
process. The mux controller tests exercise distinct names that normalize to
the same registry slug, plus adoption and retirement of an owned legacy session.
The saved launch associates the exact Compose identity and overlay with the
logical copy in its checkout. A source CLI regression supplies the name override
only through the launch overlay and verifies that a plain Down selects the
recorded name and engine. A separate upgrade fixture starts with a live owner
under the old lifecycle key and checks that Start leaves only one host owner.
The overlay regression also runs a failed before hook and checks that it leaves
the earlier association available to Down. The two-overlay regression checks that
an explicit selection resolves its own Compose name. Legacy underscore recovery
requires an owned exact stack and no containers for the competing normalized name.
The legacy owner proof and the mutation use the same Docker transport settings.
A fresh Start may replace stale metadata after both names and any legacy owner
are confirmed absent. Partial Start retains its launch association while any
runtime may remain, and failure cleanup only removes the publication it created.
Restart carries one resolved Compose name and environment through ownership,
recreation, repair and readiness. It retains the launch association for cleanup
when those phases cannot establish absence. An unnamed base launch records the
directory-derived Compose name, with overlay selection stored separately.
New launch records retain a digest of Docker connection settings. Stop and
Restart compare the settings they will pass to Docker before cleanup or
recreation. Restart keeps its value-free reference file paired with its env
through each Compose attempt and lets sibling hooks finish before claiming it.
When supplied by the engine, a bounded daemon ID observation also distinguishes
replacements behind the same endpoint. Start rechecks the original launch after
hooks, and bound readers check the selected connection before accessing services.
Start and Restart retry a failed daemon ID read before starting managed resources.
When both reads fail, the command leaves no new launch. If a successful probe
reports that an ID is unsupported, the command retains the connection-settings
evidence. Scoped mutations recheck after lock waits and before Docker effects.
Restart cancellation aborts reference-file admission and guards the final
Compose spawn. A helper-retention probe requires matching engine evidence to
establish absence.
If Restart staged a launch before a child could spawn, it restores the previous
association using the staged launch ID. Successful detached startup accepts
readiness only while the captured engine matches on both sides of the read.
Explicit and implicit selection of the same Docker context share a fingerprint.
Staging captures displaced launch records under the runtime-state lock and
publishes only the captured engine evidence. Start and Restart recheck that
evidence after the write. Restart settles its publication before after-hooks
and cancels those hooks as owned process groups. Scoped readiness uses the same
captured-engine check, and the explicit default socket matches the implicit one.
Detached manual Compose startup holds the logical checkout lock and then
the final-name lock through cache initialization and Compose dispatch. The
locks are released for attached hooks. Saved engine evidence and checkout
ownership are checked on readmission before managed-process or Compose effects.
Login startup hands its held name to the
same flow even when no Compose name override is required. Canceling a queued
Start removes its lock candidate while the owner remains active. Detached
startup serializes writes and Compose reads of the generated environment
references. Signal handling for Start settles staged launch publication before
re-raising. The CLI regressions cover both two-checkout name contention and
SIGTERM before dispatch. These checks assume cooperating Hack commands. The
model does not represent direct Docker CLI writes or terminal job control.
The CLI also covers same-copy Down invoked from Desktop and ordinary Start
hooks. Mux resumption checks persisted and live ownership before starting
more processes or publishing. After-hook cleanup takes the copy locks and
checks the current launch and session cleanup epoch. Adoption changes the
epoch before Compose dispatch. These host-process transitions are outside
the finite start/stop model and covered by controller and private tmux tests.
Whole-copy Restart uses the same releasable locks for its attached startup and
shutdown hooks. After a shutdown hook it revalidates the saved launch, Docker
engine, and checkout ownership before resuming. After an attached startup
after-hook, readiness and cleanup require the same launch ID with no intervening
service mutation. Scoped mutations mark the saved launch before dispatch,
including operations whose outcome will remain unknown. The private CLI fixtures
cover a successor launch, a same-copy service stop, and an exception while
reacquiring a lock after a persistent hook. Scoped mutations and manual Restart
hook interleavings are outside the finite model.
Whole-copy Down releases the locks for its before-hooks and validates the saved
launch, engine, and checkout again before teardown. It releases admission for
after-hooks once teardown has settled. A foreground scoped Compose start holds
admission only through dispatch. If a scoped command is refused before it can
spawn Docker, rollback restores the preceding revision only if the same staged
revision is still current. The CLI fixtures cover these hook and dispatch cases.
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
The unattended effective-model guard rejects host-file execution inputs and
checks named-volume driver/options/Compose labels immediately before preparation
and start. Only fixed, authenticated read-only generated TLS mounts are admitted.
Runtime-backend tests include hidden generated binds, old bind-backed engine
volumes, ownership labels, safe missing/default volumes and withdrawn TLS trust.
These are implementation regressions; the finite model does not model Docker
storage metadata, certificate parsing, privileged engine actors or application
code/data inside prepared images and engine-managed volumes.
Explicit CLI signal forwarding is covered by `autostart-cli-cancellation.test.ts`:
SIGINT and SIGTERM stop later dispatches, await a real detached startup child's
cleanup, finish progress and preserve signal exit status. The finite model does
not model operating-system signal delivery or the CLI entry point.
Multiple projects, multiple login attempts, reboot, upgrades, global pause, retries,
network prompts, native backends and real login-service behavior are outside this
model. Component model success does not qualify installed binaries or real login.
