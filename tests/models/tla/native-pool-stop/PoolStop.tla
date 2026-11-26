------------------------------ MODULE PoolStop ------------------------------
\* One native project run on one VM pool, when the pool stops or dies under it
\* (HACK-2456). The question: from every reachable state, does some command the
\* CLI names (`hack up`, `hack down` / `hack down --recover`, `hack native
\* recover`) make progress to a settled project?
\*
\* pool     - "running", "stopped" (a clean stop) or "crashed" (provider dead,
\*            the owner record still says running; `hack native recover` stops it).
\* boot     - how many times the pool has booted; a boot is the guest identity
\*            (`guest_boot_id`). 0: never booted.
\* run      - the run receipt: "none", "ready" (ready-observed) or "retained"
\*            (stopped-data-retained).
\* runBoot  - the boot whose containers the ready receipt records.
\* owner    - the foreground owner process: "none", "live" or "dead".
\* pub      - the owner's publication (owner.json / control.sock) is present.
\*
\* Switches:
\*   Fixed   - this change: `hack up` and `hack down` on a stopped pool whose
\*             run's owner is dead start the pool and recover the run.
\*             FALSE is `next` before HACK-2456.
\*   Strict  - recovery of a dead owner's ready run accepts only its own boot
\*             (same-boot `recover-live-owner`) or the immediate predecessor boot
\*             (`dead_owner_cleanup` before the boot history); FALSE accepts any
\*             earlier boot, as `dead_owner_cleanup` now does (`boot_history`,
\*             `boot_match`). The model does not bound the history (16 boots).
\*   ByHand  - `runtime up` by hand counts as a user command (no message names it).
\*   OtherBoots - something else may boot the pool between the stop and this
\*             project's recovery: another project's `hack up`, or `runtime up` by hand.
\*   RecoveryFaults - a fault may strike between the recovery's `runtime up` and its
\*             graph recovery (two separate requests in the CLI).
\* recovering - a recovery started the pool and has not yet recovered the run.
\*
\* The shared HTTPS owner (a project with HTTPS routes, `Https`; HACK-2456 seen on
\* a real VM). It is a host process bound to one pool boot, holding the run's lease:
\* https     - "none", "live" (the owner process runs, bound to `httpsBoot`) or
\*             "records" (it exited and kept its configuration and lease records).
\* httpsBoot - the boot the owner is bound to.
\* fin       - the CLI's frontend finalization of the run is pending: the graph is
\*             stopped and the publication retired, but the HTTPS lease is not yet
\*             released or archived.
\* Switches (each TRUE is this change):
\*   OwnerRetires    - the owner retires itself once its boot has ended
\*                     (`native-https-pool-boot.ts`); FALSE: it runs until stopped.
\*   ArchiveWorks    - the previous-boot archive can prove the owner quiescent
\*                     (exact owner invocation); FALSE: it required the frontend and
\*                     runtime executables to run nowhere, which the CLI asking for
\*                     it never satisfies.
\*   FinalizeStopped - `hack down --recover` on a stopped pool also starts it to
\*                     finish a pending finalization.
\*   FinishAnyBoot   - a completed recovery's archive may run in any later boot
\*                     (HACK-2550, seen on a real VM: z338, z282); FALSE: only in
\*                     the boot the recovery ran in (`finBoot`), as before.
\* finBoot   - the boot in which the graph recovery completed.
\* port      - the shared HTTPS port: "free", "timewait" (the retired owner's Caddy
\*             left its connections in TIME_WAIT) or "listener" (another process
\*             listens on it, possibly on one specific address).
\* overListener - an archive ran while a listener held the port.
\*   ReuseBind       - the archive's port claim binds with address reuse, so TIME_WAIT
\*                     does not block it (HACK-2550); FALSE: it waits for "free".
\*   ListenerCheck   - with ReuseBind, the claim also binds every local address
\*                     exactly (wildcard, loopback, each interface address), so any
\*                     other listener refuses it; FALSE (a reuse bind of the wildcard
\*                     alone) is the broken control `reuse-no-check`.
\*
\* Another project's `hack up` needs a project share this running pool lacks
\* (HACK-2535). A running pool's mounts never change, so when the pool is idle that
\* `up` stops it, adds the share and boots it again (RuntimeUp, another boot).
\* restart     - "none" or "checked": the idle check passed under the provider lease
\*               and the stop has not happened yet.
\* stoppedLive - that stop ran while this project's run was live.
\*   IdleRestart - the restart exists (FALSE in every older control).
\*   SecondCheck - the stop checks idleness again right before the guest stops;
\*                 FALSE is the broken control `idle-restart-one-check`.
\*
\* `runtime down` typed by hand (HACK-2477) refuses while a run is live and stops
\* nothing; `runtime down --force` stops the pool under it, as every `runtime down`
\* did before.
\* downOverLive - a plain (unforced) `runtime down` stopped the pool under a live run.
\*   DownRefuses - plain `runtime down` refuses a live run (TRUE is this change);
\*                 FALSE is the broken control `down-no-refusal`.
\*
\* A second project in the same pool, native-authored (HACK-2715, seen on a real
\* VM): `runtime down --force` stopped the pool under both, and neither came back.
\* The Compose project's recovery worked, but its new start was refused because
\* admission refused the native run's receipt of the boot that ended; the native
\* project's recovery accepted only its own boot.
\* nrun     - the native run's receipt: "none", "preparing" (a start in progress),
\*            "ready" (ready-observed) or "removed" (recovered or stopped, data kept).
\* nrunBoot - the boot its containers belong to.
\* nowner   - its foreground owner: "none", "live" or "dead". A native-authored
\*            owner is a host process: once its run is ready it does not watch the
\*            pool, so it keeps running after the pool stops (seen on a real VM).
\*            A start in progress fails when its guest goes, and its owner exits.
\* nbound   - the run keeps state bound to its boot (persistent data, a live source,
\*            a custom network or a managed environment): no cleanup from an ended
\*            boot admits it (`journal::ended_boot_recoverable`), so it is refused
\*            by name and kept: the accepted outcome `NativeStranded`, once its
\*            owner is no longer live (review round 2: a live owner left running
\*            with its publication is not an accepted outcome).
\* nwasted  - a `hack down` started a stopped pool that its stop or recovery then
\*            could not use.
\*   TwoProjects     - the native project exists (FALSE in every older control).
\*   AdmitEndedBoot  - admission counts a native run of an ended boot (its stopped
\*                     containers reserve their limits) instead of refusing it
\*                     (`runtime.rs::ended_boot_reservations`). FALSE is `next`
\*                     before HACK-2715: the control `admission-ended-boot`.
\*   NativeCrossBoot - the native project's recovery accepts a run of an ended
\*                     boot of the pool (`journal::load_for_recovery`). FALSE is
\*                     `next` before HACK-2715 (same boot only): the control
\*                     `native-same-boot`.
\*   NativeStartsPool - its `hack down` (and `--recover`) starts a stopped pool
\*                     first (`startStoppedPoolForAuthoredRecovery`). FALSE is `next`
\*                     before HACK-2715: the control `native-stopped-pool`.
\* The review of HACK-2715 (each TRUE is this change):
\*   NativeMidStart  - a start caught mid-way (`preparing`) by the end of its boot is
\*                     admitted by the recovery and counted by admission (its present
\*                     members reserve their limits). FALSE: both refused it, which
\*                     blocked every project's start for good: `native-mid-start`.
\*   OwnerStopsEndedBoot - the run's own live owner's stop clears a run of an ended
\*                     boot (`runtime::cleanup_journal`). FALSE: it was same-boot
\*                     only, and the owner outlives the pool, so nothing cleared the
\*                     run (seen on a real VM): `native-live-owner`.
\*   NativeChecksFirst - `hack down` starts a stopped pool only when the run's
\*                     receipt shows its cleanup can proceed (`graph native boot`).
\*                     FALSE: it started the pool and then refused, leaving it
\*                     running: `native-start-unchecked`.
\*   NativeBoundState - the native run may keep boot-bound state (`nbound`).
\* The second review round of HACK-2715 (TRUE is this change):
\*   OwnerStopFirst  - `hack down` sends a boot-bound run's live owner its stop even
\*                     on a stopped pool, then names the refusal: the stop needs no
\*                     pool (the owner's cleanup refuses without an effect and the
\*                     owner exits). FALSE: the refusal came before the stop on a
\*                     stopped pool, so the owner and its publication stayed up
\*                     until host reboot, while a running or crashed pool still
\*                     got the stop: `native-bound-owner`. With it, `hack down` on
\*                     a stopped pool sends a live owner its stop first for every
\*                     run (the owner exits), and the same command then settles the
\*                     run by the dead-owner recovery, starting the pool only for a
\*                     recoverable run. FALSE also is the order that started the
\*                     pool first and then sent the owner its stop, which on a real
\*                     VM did not confirm ("stop is unconfirmed") and left `up -d`
\*                     refused; its cause there is not known, so the model lets that
\*                     stop fail (`NativeStopAfterStartFails`): `native-stop-after-start`.
\*   OwnerWatchesPool - a native owner notices from the pool record that its boot
\*                     ended and exits, keeping its publication for the recovery
\*                     (`NativeOwnerNotices`), and `runtime down --force` waits for
\*                     the owners of the runs it interrupted (seen on a real VM: an
\*                     owner outlived the forced stop). The model takes that wait as
\*                     succeeding; an owner still running when it ends is named in the
\*                     report and stopped by `hack down`, as after a crash. FALSE:
\*                     `force-leaves-owner`.
\*   CrashSeen       - (Codex P2) a provider that died under the pool leaves its
\*                     record `running`. The native `hack down` runs the existing
\*                     `runtime recover` first (`NativeDownRecoversCrash`), and an
\*                     owner counts a provider proven gone as its boot's end.
\*                     FALSE: only `hack native recover` moved such a pool on, and
\*                     `hack down` did nothing: `native-down-on-crash` (invariant
\*                     `NativeDownActs`).
\*   ExitsAsCrash    - such an owner ends as a crash would (`exitOnPoolEnd`), so its
\*                     run stays selectable by the dead-owner recovery. FALSE is
\*                     3c88966f (seen on a real VM): `hack down`, `up -d` and `exec`
\*                     refused for good: `owner-exits-released`.
\* nstartedFor  - this `hack down` started the pool for a live owner's stop.
\* nunconfirmed - a `hack down` ended with an unconfirmed stop and the run left.
\* forcedOwner  - a forced stop left a native owner running.
EXTENDS Naturals
CONSTANTS Fixed, Strict, ByHand, OtherBoots, RecoveryFaults, MaxBoot, MaxFaults,
          Https, OwnerRetires, ArchiveWorks, FinalizeStopped, FinishAnyBoot,
          ReuseBind, ListenerCheck, IdleRestart, SecondCheck, DownRefuses,
          TwoProjects, AdmitEndedBoot, NativeCrossBoot, NativeStartsPool,
          NativeMidStart, OwnerStopsEndedBoot, NativeChecksFirst, NativeBoundState,
          OwnerStopFirst, OwnerWatchesPool, CrashSeen, ExitsAsCrash

VARIABLES pool, boot, run, runBoot, owner, pub, faults, recovering, https,
          httpsBoot, fin, finBoot, port, overListener, restart, stoppedLive,
          downOverLive, nrun, nrunBoot, nowner, nbound, nwasted, nstartedFor,
          nunconfirmed, forcedOwner
X == <<nstartedFor, nunconfirmed, forcedOwner>>
N == <<nrun, nrunBoot, nowner, nbound, nwasted, X>>
vars == <<pool, boot, run, runBoot, owner, pub, faults, recovering, https,
          httpsBoot, fin, finBoot, port, overListener, restart, stoppedLive,
          downOverLive, N>>
R == <<restart, stoppedLive, downOverLive, N>>
P == <<port, overListener, R>>
H == <<https, httpsBoot, fin, finBoot, P>>

TypeOK ==
    /\ pool \in {"running", "stopped", "crashed"}
    /\ boot \in 0..MaxBoot /\ runBoot \in 0..MaxBoot
    /\ run \in {"none", "ready", "retained"}
    /\ owner \in {"none", "live", "dead"}
    /\ pub \in BOOLEAN /\ faults \in 0..MaxFaults /\ recovering \in BOOLEAN
    /\ https \in {"none", "live", "records"} /\ httpsBoot \in 0..MaxBoot
    /\ fin \in BOOLEAN /\ finBoot \in 0..MaxBoot
    /\ port \in {"free", "timewait", "listener"} /\ overListener \in BOOLEAN
    /\ restart \in {"none", "checked"} /\ stoppedLive \in BOOLEAN
    /\ downOverLive \in BOOLEAN
    /\ nrun \in {"none", "preparing", "ready", "removed"} /\ nrunBoot \in 0..MaxBoot
    /\ nowner \in {"none", "live", "dead", "gone"} /\ nbound \in BOOLEAN /\ nwasted \in BOOLEAN
    /\ nstartedFor \in BOOLEAN /\ nunconfirmed \in BOOLEAN /\ forcedOwner \in BOOLEAN

Init ==
    /\ pool = "stopped" /\ boot = 0 /\ run = "none" /\ runBoot = 0
    /\ owner = "none" /\ pub = FALSE /\ faults = 0 /\ recovering = FALSE
    /\ https = "none" /\ httpsBoot = 0 /\ fin = FALSE /\ finBoot = 0
    /\ port = "free" /\ overListener = FALSE
    /\ restart = "none" /\ stoppedLive = FALSE /\ downOverLive = FALSE
    /\ nrun = "none" /\ nrunBoot = 0 /\ nowner = "none"
    /\ nbound = FALSE /\ nwasted = FALSE
    /\ nstartedFor = FALSE /\ nunconfirmed = FALSE /\ forcedOwner = FALSE

CanBoot == boot < MaxBoot
\* Recovery of a dead owner's ready run in the current boot `b`.
CanRecover(b) ==
    \/ runBoot = b                                  \* same boot: recover-live-owner
    \/ IF Strict THEN runBoot + 1 = b ELSE runBoot < b

\* --- Faults and environment (bounded) -------------------------------------
Fault == faults < MaxFaults /\ (RecoveryFaults \/ ~recovering)
\* A run is live while its receipt is ready, whatever its owner or boot
\* (`pool_users::live_graph_runs`); a retained run holds no containers.
LiveRun == run = "ready"
\* The native run is live in the pool's current boot: a start in progress or ready.
\* A native run of an ended boot runs nothing in this boot and is not live
\* (`pool_users::live_graph_runs`, HACK-2715 review: seen on a real VM, it kept every
\* later plain `runtime down` refused).
NativeLive == nrun \in {"preparing", "ready"} /\ nrunBoot = boot
\* The native run's boot has ended under it: the pool stopped, or booted again.
NativeEnded == nrun \in {"preparing", "ready"} /\ (pool /= "running" \/ nrunBoot /= boot)
\* What the cleanup from an ended boot admits (`journal::ended_boot_recoverable`).
EndedRecoverable == ~nbound /\ (nrun = "ready" \/ NativeMidStart)
\* How a ready run's owner ends once its pool boot ended (it noticed, its stop found
\* no engine, or `--force` waited for it). With ExitsAsCrash it ends as a crash
\* would, keeping its admission lock for the dead-owner recovery ("dead"). Without
\* it (3c88966f, seen on a real VM) it returned normally and released the lock, a
\* state ("gone") that no recovery selects.
Exited == IF ExitsAsCrash THEN "dead" ELSE "gone"
\* A boot-bound run of an ended boot: refused by name, data kept (the named outcome),
\* with no live owner left running (HACK-2715 review round 2).
NativeStranded == nbound /\ NativeEnded /\ nowner /= "live"
\* Either project's run is live.
AnyLive == LiveRun \/ NativeLive
\* `runtime down` typed by hand (HACK-2477). It checks the live runs under the
\* provider lease, which graph starts take before they write a live receipt, so the
\* check and the stop are one step. With no live run it stops the pool.
RuntimeDown ==
    /\ Fault /\ pool = "running" /\ (DownRefuses => ~AnyLive)
    /\ pool' = "stopped" /\ faults' = faults + 1
    /\ downOverLive' = (downOverLive \/ AnyLive)
    /\ UNCHANGED <<boot, run, runBoot, owner, pub, recovering>>
    /\ UNCHANGED <<https, httpsBoot, fin, finBoot, port, overListener, restart, stoppedLive, N>>
\* With a live run it refuses (`runtime_down_live_runs`, naming the run): nothing changes.
RuntimeDownRefused ==
    /\ DownRefuses /\ pool = "running" /\ AnyLive
    /\ UNCHANGED vars
\* `runtime down --force` while the run is live: the pool stops; the guest's
\* containers go with it, and its JSON lists the run (`interrupted_runs`). It does not
\* retire the foreground owner's publication.
RuntimeDownForce ==
    /\ Fault /\ pool = "running"
    /\ pool' = "stopped" /\ faults' = faults + 1
    \* A ready native run's owner, as a host process, outlives the pool. With
    \* OwnerWatchesPool it notices and exits, and the forced stop waits for it.
    /\ LET left == nrun = "ready" /\ nowner = "live"
       IN /\ nowner' = IF left /\ OwnerWatchesPool THEN Exited ELSE nowner
          /\ forcedOwner' = (forcedOwner \/ (left /\ ~OwnerWatchesPool))
    /\ UNCHANGED <<boot, run, runBoot, owner, pub, recovering>>
    /\ UNCHANGED <<https, httpsBoot, fin, finBoot, port, overListener, restart,
                   stoppedLive, downOverLive>>
    /\ UNCHANGED <<nrun, nrunBoot, nbound, nwasted, nstartedFor, nunconfirmed>>
\* The VM or its provider dies (or the host reboots).
Crash ==
    /\ Fault /\ pool = "running"
    /\ pool' = "crashed" /\ faults' = faults + 1
    /\ UNCHANGED <<boot, run, runBoot, owner, pub, recovering>> /\ UNCHANGED H
\* The foreground owner dies while the pool keeps running.
OwnerCrash ==
    /\ Fault /\ owner = "live"
    /\ owner' = "dead" /\ faults' = faults + 1
    /\ UNCHANGED <<pool, boot, run, runBoot, pub, recovering>> /\ UNCHANGED H
\* The owner notices its guest is gone (the pool stopped, or a later boot
\* replaced it) and exits without retiring its publication.
OwnerNotices ==
    /\ owner = "live" /\ (pool /= "running" \/ runBoot /= boot)
    /\ owner' = "dead"
    /\ UNCHANGED <<pool, boot, run, runBoot, pub, faults, recovering>> /\ UNCHANGED H
\* The shared HTTPS owner sees from the pool record that its boot ended (the pool
\* stopped, crashed or booted again) and exits, keeping its records.
OwnerRetire ==
    /\ OwnerRetires /\ https = "live" /\ (pool /= "running" \/ httpsBoot /= boot)
    /\ https' = "records" /\ port' = IF port = "listener" THEN port ELSE "timewait"
    /\ UNCHANGED <<pool, boot, run, runBoot, owner, pub, faults, recovering, httpsBoot, fin, finBoot, overListener>> /\ UNCHANGED R
\* The retired Caddy's TIME_WAIT connections expire (about 30 s on macOS).
TimeWaitEnds ==
    /\ port = "timewait" /\ port' = "free"
    /\ UNCHANGED <<pool, boot, run, runBoot, owner, pub, faults, recovering, https, httpsBoot, fin, finBoot, overListener>> /\ UNCHANGED R
\* Another process listens on the port (a bounded fault), and later stops.
Listen ==
    /\ Https /\ Fault /\ port = "free" /\ https /= "live"
    /\ port' = "listener" /\ faults' = faults + 1
    /\ UNCHANGED <<pool, boot, run, runBoot, owner, pub, recovering, https, httpsBoot, fin, finBoot, overListener>> /\ UNCHANGED R
ListenerExits ==
    /\ port = "listener" /\ port' = "free"
    /\ UNCHANGED <<pool, boot, run, runBoot, owner, pub, faults, recovering, https, httpsBoot, fin, finBoot, overListener>> /\ UNCHANGED R
\* The archive's port claim (`https_recovery::port_absent`).
PortClaimable ==
    IF ReuseBind THEN (~ListenerCheck \/ port /= "listener") ELSE port = "free"
\* A boot by something else (another project's `hack up`, or `runtime up` by hand).
\* With ByHand it is a user command of this project; otherwise a bounded fault.
RuntimeUp ==
    /\ pool = "stopped" /\ CanBoot /\ (ByHand \/ (OtherBoots /\ Fault))
    /\ pool' = "running" /\ boot' = boot + 1
    /\ faults' = IF ByHand THEN faults ELSE faults + 1
    /\ UNCHANGED <<run, runBoot, owner, pub, recovering>> /\ UNCHANGED H

\* --- User commands the CLI names ------------------------------------------
\* `hack native recover`: a crashed pool is recorded stopped (recovered-unclean).
PoolRecover ==
    /\ pool = "crashed"
    /\ pool' = "stopped"
    /\ UNCHANGED <<boot, run, runBoot, owner, pub, faults, recovering>> /\ UNCHANGED H

\* Graph admission of a start in boot `b`: the native project's ready run counts
\* in its own boot; from an ended boot it counts only with AdmitEndedBoot (before
\* HACK-2715 admission refused it, `native_graph_receipt`). A start in progress
\* refuses in its own boot (its effects may still land); from an ended boot it
\* counts only with NativeMidStart.
Admits(b) ==
    \/ nrun \in {"none", "removed"}
    \/ nrun = "ready" /\ (nrunBoot = b \/ AdmitEndedBoot)
    \/ nrun = "preparing" /\ nrunBoot /= b /\ AdmitEndedBoot /\ NativeMidStart
\* A fresh or retained start: boots a stopped pool first. A pending finalization
\* refuses it (`E_RECOVERY_REQUIRED`, naming `hack down --recover`); with HTTPS
\* routes it starts a new owner, bound to this boot, once the old one is archived.
Start ==
    /\ \/ run = "none"
       \/ run = "retained" /\ ~pub
    /\ ~fin /\ https = "none"
    /\ pool /= "crashed"
    /\ pool = "running" \/ CanBoot
    /\ LET b == IF pool = "running" THEN boot ELSE boot + 1
       IN /\ Admits(b)
          /\ boot' = b
          /\ runBoot' = b
          /\ https' = IF Https THEN "live" ELSE "none"
          /\ httpsBoot' = IF Https THEN b ELSE 0
    /\ pool' = "running" /\ run' = "ready" /\ owner' = "live" /\ pub' = TRUE
    /\ UNCHANGED <<faults, recovering, fin, finBoot>> /\ UNCHANGED P

\* Recovery of a dead owner's ready run on a running pool (the existing
\* `hack down --recover`, also plain `hack down` once the frontend is gone):
\* cleanup with data retained, then the publication is retired. The frontend
\* finalization (the HTTPS lease) follows as its own step, Finalize.
RecoverRunning ==
    /\ pool = "running" /\ run = "ready" /\ owner = "dead" /\ CanRecover(boot)
    /\ run' = "retained" /\ pub' = FALSE /\ owner' = "none" /\ recovering' = FALSE
    /\ fin' = (https /= "none") /\ finBoot' = boot
    /\ UNCHANGED <<pool, boot, runBoot, faults, https, httpsBoot>> /\ UNCHANGED P

\* The frontend finalization of a recovered run releases the HTTPS lease: through
\* the live owner when it is bound to this boot, otherwise by archiving the owner's
\* records, which needs the owner gone (a live owner of an ended boot is waited for,
\* OwnerRetire) and a satisfiable quiescence proof.
Finalize ==
    /\ pool = "running" /\ run = "retained" /\ fin /\ ~pub
    /\ \/ https = "live" /\ httpsBoot = boot
       \/ https = "records" /\ ArchiveWorks /\ finBoot = boot /\ PortClaimable
       \/ https = "none"
    /\ https' = "none" /\ httpsBoot' = 0 /\ fin' = FALSE /\ finBoot' = 0
    /\ overListener' = (overListener \/ (https = "records" /\ port = "listener"))
    /\ UNCHANGED <<pool, boot, run, runBoot, owner, pub, faults, recovering, port>> /\ UNCHANGED R

\* A completed recovery whose archive failed (the port still in TIME_WAIT, or the
\* start crashed) and whose boot has since ended: the graph is already stopped, so
\* what is left is host-side and proven from current observations alone (owner
\* gone, socket refused, port free, resources absent), whatever boot the recovery
\* ran in (`HttpsArchiveGuard`, `bridges::cleanup::read_completed_recovery`).
FinishCompleted ==
    /\ FinishAnyBoot
    /\ pool = "running" /\ run = "retained" /\ fin /\ ~pub
    /\ https = "records" /\ ArchiveWorks /\ finBoot /= boot /\ PortClaimable
    /\ https' = "none" /\ httpsBoot' = 0 /\ fin' = FALSE /\ finBoot' = 0
    /\ overListener' = (overListener \/ port = "listener")
    /\ UNCHANGED <<pool, boot, run, runBoot, owner, pub, faults, recovering, port>> /\ UNCHANGED R

\* HACK-2456: with the pool stopped, `hack up` / `hack down --recover` first send
\* `runtime up` (`inspectOrStartStoppedPool`), then start over; the restarted down
\* recovers the run with RecoverRunning as a separate request.
\* With FinalizeStopped it also starts the pool for a pending finalization.
RecoverStopped ==
    /\ Fixed
    /\ pool = "stopped" /\ CanBoot
    /\ \/ run = "ready" /\ owner = "dead"
       \/ FinalizeStopped /\ run = "retained" /\ fin /\ ~pub
    /\ pool' = "running" /\ boot' = boot + 1 /\ recovering' = TRUE
    /\ UNCHANGED <<run, runBoot, owner, pub, faults>> /\ UNCHANGED H

\* `hack down` of a live run: stop with data retained; its frontend releases the
\* lease, and the idle owner retires.
Stop ==
    /\ pool = "running" /\ run = "ready" /\ owner = "live" /\ runBoot = boot
    /\ run' = "retained" /\ pub' = FALSE /\ owner' = "none"
    /\ https' = "none" /\ httpsBoot' = 0
    /\ UNCHANGED <<pool, boot, runBoot, faults, recovering, fin, finBoot>> /\ UNCHANGED P

\* HACK-2535: the other project's `up` checks idleness under the provider lease. Idle:
\* no live run (a ready receipt, whatever its owner), no pending finalization and no
\* recovery in progress. The code holds the lease from the first check to the stop,
\* and graph starts take that lease before they write a live receipt, so in the code
\* no start runs between the checks. The model is more permissive on purpose: it lets
\* a start turn its receipt live between the two checks (Start while "checked"), as if
\* some start needed no lease, so it shows what the second check, right before the
\* guest stops (RestartStop), guards on its own. A bounded fault: it is another
\* project's command.
Idle == run /= "ready" /\ ~NativeLive /\ ~fin /\ ~recovering
RestartCheck ==
    /\ IdleRestart /\ Fault /\ restart = "none" /\ pool = "running" /\ Idle
    /\ restart' = "checked" /\ faults' = faults + 1
    /\ UNCHANGED <<pool, boot, run, runBoot, owner, pub, recovering, stoppedLive, downOverLive, N>>
    /\ UNCHANGED <<https, httpsBoot, fin, finBoot, port, overListener>>
\* The stop: the guest and every container in it stop; the share is added and the
\* other project's start boots the pool later (RuntimeUp).
RestartStop ==
    /\ restart = "checked" /\ pool = "running" /\ (SecondCheck => Idle)
    /\ pool' = "stopped" /\ restart' = "none"
    /\ stoppedLive' = (stoppedLive \/ AnyLive)
    /\ UNCHANGED <<boot, run, runBoot, owner, pub, faults, recovering, downOverLive, N>>
    /\ UNCHANGED <<https, httpsBoot, fin, finBoot, port, overListener>>
\* The second check refuses, or the pool changed meanwhile: nothing is stopped.
RestartRefused ==
    /\ restart = "checked" /\ (~Idle \/ pool /= "running")
    /\ restart' = "none"
    /\ UNCHANGED <<pool, boot, run, runBoot, owner, pub, faults, recovering, stoppedLive, downOverLive, N>>
    /\ UNCHANGED <<https, httpsBoot, fin, finBoot, port, overListener>>
Restart == RestartCheck \/ RestartStop \/ RestartRefused

\* --- The native-authored project (TwoProjects, HACK-2715) ------------------
NU == <<pool, boot, run, runBoot, owner, pub, faults, recovering>>
NH == <<https, httpsBoot, fin, finBoot, port, overListener, restart, stoppedLive, downOverLive>>
\* Its `hack up`: a native-authored start needs a running pool (a stopped one
\* refuses and names `runtime up`) and admits the Compose run in any boot, as
\* Compose admission counts an ended boot's containers. Its receipt is written
\* `preparing` first; the run may keep boot-bound state.
NativeStart ==
    /\ TwoProjects /\ pool = "running" /\ nrun \in {"none", "removed"}
    /\ nowner = "none"
    /\ nrun' = "preparing" /\ nrunBoot' = boot /\ nowner' = "live"
    /\ nbound' \in (IF NativeBoundState THEN BOOLEAN ELSE {FALSE})
    /\ UNCHANGED nwasted /\ UNCHANGED NU /\ UNCHANGED NH /\ UNCHANGED X
\* The start completes in its own boot.
NativeReady ==
    /\ nrun = "preparing" /\ nowner = "live" /\ pool = "running" /\ nrunBoot = boot
    /\ nrun' = "ready"
    /\ UNCHANGED <<nrunBoot, nowner, nbound, nwasted>> /\ UNCHANGED NU /\ UNCHANGED NH /\ UNCHANGED X
\* The start's guest went away (forced stop, crash): the start fails, its own
\* cleanup cannot reach the engine, and its owner exits keeping its publication.
NativeStartFails ==
    /\ nrun = "preparing" /\ nowner = "live" /\ (pool /= "running" \/ nrunBoot /= boot)
    /\ nowner' = "dead"
    /\ UNCHANGED <<nrun, nrunBoot, nbound, nwasted>> /\ UNCHANGED NU /\ UNCHANGED NH /\ UNCHANGED X
NativeProgress == NativeReady \/ NativeStartFails
\* The ready run's owner is killed (a bounded fault). An owner killed mid-start in a
\* running boot is outside this model: that same-boot case is unchanged.
NativeOwnerCrash ==
    /\ Fault /\ nrun = "ready" /\ nowner = "live"
    /\ nowner' = "dead" /\ faults' = faults + 1
    /\ UNCHANGED <<nrun, nrunBoot, nbound, nwasted>> /\ UNCHANGED X
    /\ UNCHANGED <<pool, boot, run, runBoot, owner, pub, recovering>> /\ UNCHANGED NH
\* `runtime up`, which the refusal of its start on a stopped pool names: only when
\* it would start (the code names it nowhere else).
NativeRuntimeUp ==
    /\ TwoProjects /\ pool = "stopped" /\ CanBoot
    /\ nrun \in {"none", "removed"} /\ nowner = "none"
    /\ pool' = "running" /\ boot' = boot + 1
    /\ UNCHANGED <<run, runBoot, owner, pub, faults, recovering>> /\ UNCHANGED H
\* Its `hack down` of a ready run with a live owner: the owner's stop, data kept.
\* In its own boot as before; from an ended boot with OwnerStopsEndedBoot, when the
\* cleanup from an ended boot admits the run.
NativeStop ==
    /\ TwoProjects /\ pool = "running" /\ nrun = "ready" /\ nowner = "live"
    /\ \/ nrunBoot = boot
       \/ OwnerStopsEndedBoot /\ EndedRecoverable
    /\ nrun' = "removed" /\ nowner' = "none"
    /\ UNCHANGED <<nrunBoot, nbound, nwasted>> /\ UNCHANGED NU /\ UNCHANGED NH
    /\ nstartedFor' = FALSE /\ UNCHANGED <<nunconfirmed, forcedOwner>>
\* Its dead-owner recovery (`hack down --recover`, or plain `hack down` once the
\* owner is gone) on a running pool: the cleanup removes the run, data kept, and
\* retires the publication. A ready run in its own boot; a run of an ended boot with
\* NativeCrossBoot, when the cleanup from an ended boot admits it.
NativeRecover ==
    /\ TwoProjects /\ pool = "running" /\ nrun \in {"preparing", "ready"}
    /\ nowner = "dead"
    /\ \/ nrun = "ready" /\ nrunBoot = boot
       \/ NativeCrossBoot /\ nrunBoot /= boot /\ EndedRecoverable
    /\ nrun' = "removed" /\ nowner' = "none"
    /\ UNCHANGED <<nrunBoot, nbound, nwasted>> /\ UNCHANGED NU /\ UNCHANGED NH /\ UNCHANGED X
\* HACK-2715: with the pool stopped, that `hack down` first starts it
\* (`startStoppedPoolForAuthoredRecovery`), then stops or recovers as above. With
\* NativeChecksFirst only when the run's receipt shows the cleanup can proceed; a
\* start that the stop or recovery then cannot use is `nwasted`.
NativeDownStartsPool ==
    /\ TwoProjects /\ NativeStartsPool /\ pool = "stopped" /\ CanBoot
    \* With OwnerStopFirst a live owner is asked to stop first (NativeStopEnded),
    \* so the pool starts only for the dead-owner recovery.
    /\ \/ nrun = "ready" /\ nowner = "live" /\ ~OwnerStopFirst
       \/ nrun \in {"preparing", "ready"} /\ nowner = "dead"
    /\ NativeChecksFirst => EndedRecoverable
    /\ pool' = "running" /\ boot' = boot + 1
    /\ nwasted' = (nwasted \/ ~(EndedRecoverable /\ IF nowner = "live"
                                                    THEN OwnerStopsEndedBoot
                                                    ELSE NativeCrossBoot))
    /\ UNCHANGED <<run, runBoot, owner, pub, faults, recovering>> /\ UNCHANGED NH
    /\ UNCHANGED <<nrun, nrunBoot, nowner, nbound>>
    /\ nstartedFor' = (nowner = "live") /\ UNCHANGED <<nunconfirmed, forcedOwner>>
\* Its `hack down` of a run of an ended boot with a live owner whose stop cannot
\* clear it (review round 2): on a stopped pool with OwnerStopFirst for every run,
\* elsewhere for a boot-bound one. The stop needs no pool. Its cleanup refuses
\* without an effect (no engine on a stopped pool, or
\* `native_graph_ended_boot_unsupported`), the owner exits keeping its
\* publication as evidence, and the command goes on to the dead-owner recovery
\* (NativeDownStartsPool, NativeRecover) or names the refusal. Without
\* OwnerStopFirst `startStoppedPoolForAuthoredRecovery` ran first, refusing a
\* bound run before any stop on a pool it proved stopped, and starting the pool
\* for any other.
NativeStopEnded ==
    /\ TwoProjects /\ nrun = "ready" /\ nowner = "live" /\ NativeEnded
    /\ IF pool = "stopped" THEN OwnerStopFirst ELSE nbound
    /\ nowner' = Exited
    /\ UNCHANGED <<nrun, nrunBoot, nbound, nwasted>> /\ UNCHANGED NU /\ UNCHANGED NH /\ UNCHANGED X
\* The order before the fix: the owner's stop right after this `hack down` started
\* the pool for it. On a real VM it did not confirm: the owner exited, the command
\* reported "stop is unconfirmed" and the run was left, so `up -d` was refused.
NativeStopAfterStartFails ==
    /\ TwoProjects /\ nstartedFor /\ pool = "running" /\ nrun = "ready"
    /\ nowner = "live"
    /\ nowner' = "dead" /\ nunconfirmed' = TRUE /\ nstartedFor' = FALSE
    /\ UNCHANGED <<nrun, nrunBoot, nbound, nwasted, forcedOwner>>
    /\ UNCHANGED NU /\ UNCHANGED NH
\* OwnerWatchesPool: a ready run's owner notices from the pool record that its
\* boot ended (the pool stopped, or booted again) and exits without a cleanup
\* effect, keeping its publication. A crashed pool still records it running; with
\* CrashSeen the owner also counts a provider proven gone as its boot's end
\* (`journal::boot_of`), else it notices once the pool is recorded stopped.
NativeOwnerNotices ==
    /\ TwoProjects /\ OwnerWatchesPool /\ nrun = "ready" /\ nowner = "live"
    /\ (pool /= "crashed" \/ CrashSeen) /\ NativeEnded
    /\ nowner' = Exited
    /\ UNCHANGED <<nrun, nrunBoot, nbound, nwasted>> /\ UNCHANGED NU /\ UNCHANGED NH /\ UNCHANGED X
\* CrashSeen (Codex P2): the native `hack down` on a pool whose provider died first
\* runs the existing `runtime recover` (HACK-2579), which records the pool stopped;
\* it then goes on as on any stopped pool. Without it only `hack native recover`
\* did, and `hack down` itself had nothing to do.
NativeDownRecoversCrash ==
    /\ TwoProjects /\ CrashSeen /\ pool = "crashed"
    /\ nrun \in {"preparing", "ready"}
    /\ pool' = "stopped"
    /\ UNCHANGED <<boot, run, runBoot, owner, pub, faults, recovering>> /\ UNCHANGED H
NativeUp == NativeStart \/ NativeRuntimeUp
NativeDown == NativeStop \/ NativeRecover \/ NativeDownStartsPool \/ NativeStopEnded
              \/ NativeStopAfterStartFails \/ NativeDownRecoversCrash
NativeUser == NativeUp \/ NativeDown \/ PoolRecover

\* `hack up` = Start, or (Fixed) recovery of a dead owner's run then Start on
\* a later command; `hack down` = Stop, RecoverRunning or (Fixed) RecoverStopped.
Up == Start \/ RecoverStopped
Down == Stop \/ RecoverRunning \/ RecoverStopped \/ Finalize \/ FinishCompleted
User == Up \/ Down \/ PoolRecover \/ (ByHand /\ RuntimeUp)

PoolDown == RuntimeDown \/ RuntimeDownRefused \/ RuntimeDownForce
Next == PoolDown \/ Crash \/ OwnerCrash \/ OwnerNotices \/ OwnerRetire \/ RuntimeUp
        \/ TimeWaitEnds \/ Listen \/ ListenerExits \/ User \/ Restart
        \/ NativeUser \/ NativeProgress \/ NativeOwnerCrash \/ NativeOwnerNotices
Spec == Init /\ [][Next]_vars
\* User commands keep being tried; the owner notices its guest is gone.
FairSpec == Spec /\ WF_vars(Up) /\ WF_vars(Down) /\ WF_vars(PoolRecover)
            /\ WF_vars(OwnerNotices) /\ WF_vars(OwnerRetire)
            /\ WF_vars(TimeWaitEnds) /\ WF_vars(ListenerExits)
            /\ (ByHand => WF_vars(RuntimeUp))
            /\ WF_vars(NativeUp) /\ WF_vars(NativeDown)
            /\ WF_vars(NativeProgress) /\ WF_vars(NativeOwnerNotices)

\* Up: the run is ready in the current boot with a live owner. Down: nothing
\* is running for it and no publication blocks a start.
Settled ==
    \/ pool = "running" /\ run = "ready" /\ owner = "live" /\ runBoot = boot
    \/ run \in {"none", "retained"} /\ ~pub /\ ~fin

\* From every reachable state some named command can act, or the owner is still
\* noticing that its guest is gone (it exits on its own), as is the HTTPS owner.
NoDeadEnd == Settled \/ ENABLED User \/ ENABLED OwnerNotices \/ ENABLED OwnerRetire
             \/ ENABLED TimeWaitEnds \/ ENABLED ListenerExits
\* The previous-boot archive never runs while another process listens on the port.
NoArchiveOverListener == ~overListener
\* HACK-2535: a run that became live before the idle restart's stop is never stopped by it.
NoRestartOverLiveRun == ~stoppedLive
\* HACK-2477: only `runtime down --force` stops the pool under a live run.
NoDownOverLiveRun == ~downOverLive
\* HACK-2715: from every reachable state this project can come up again by its
\* own commands alone, whatever the other project left in the pool: it is up,
\* or a step of its way up is enabled, or an owner is still noticing its guest is
\* gone. A settled "down" is not enough here: before HACK-2715 the Compose run
\* was retained after its recovery, and its start was refused for good.
ThisUp == pool = "running" /\ run = "ready" /\ owner = "live" /\ runBoot = boot
CanComeUp == ThisUp \/ ENABLED (Start \/ RecoverStopped \/ RecoverRunning \/ PoolRecover
                                \/ Finalize \/ FinishCompleted)
             \/ ENABLED OwnerNotices \/ ENABLED OwnerRetire
             \/ ENABLED TimeWaitEnds \/ ENABLED ListenerExits
             \* the other project's start in progress settles on its own
             \/ ENABLED NativeProgress
\* The same for the native project, by its own commands alone, or its start in
\* progress settling on its own. A boot-bound run of an ended boot is the one
\* accepted exception: it is refused by name with its data kept (`NativeStranded`).
NativeUpNow == pool = "running" /\ nrun = "ready" /\ nowner = "live" /\ nrunBoot = boot
NativeCanComeUp == ~TwoProjects \/ NativeUpNow \/ NativeStranded \/ ENABLED NativeUser
                   \/ ENABLED NativeProgress \/ ENABLED NativeOwnerNotices
\* Its settled states: up in the current boot, down with nothing left, or refused.
NativeSettled == NativeUpNow \/ (nrun \in {"none", "removed"} /\ nowner = "none")
                 \/ NativeStranded
\* HACK-2715 review: `hack down` never starts a pool its stop or recovery cannot use.
NoWastedPoolStart == ~nwasted
\* HACK-2715 review round 2: `hack down` never ends with an unconfirmed stop that
\* leaves the run behind (seen on a real VM).
DownConfirms == ~nunconfirmed
\* HACK-2715 review round 2: `runtime down --force` leaves no native owner running.
NoOwnerLeftByForce == ~forcedOwner
\* Codex P2: from every state the native project is not settled in, its own `hack
\* down` acts (or its start or owner settles on its own), without `hack native
\* recover` first, even when the pool's provider died.
NativeDownActs ==
    (TwoProjects /\ nrun \in {"preparing", "ready"} /\ ~NativeUpNow /\ ~NativeStranded)
        => ENABLED (NativeDown \/ NativeProgress \/ NativeOwnerNotices)
NativeRecovers == []<>NativeSettled
\* The boot bound is a model limit, not a dead end: it must never be what stops a command.
BootBoundUnreached == CanBoot
\* Under fair user commands, with faults bounded, the project settles again and again.
Recovers == []<>Settled
=============================================================================
