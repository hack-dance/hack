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
EXTENDS Naturals
CONSTANTS Fixed, Strict, ByHand, OtherBoots, RecoveryFaults, MaxBoot, MaxFaults,
          Https, OwnerRetires, ArchiveWorks, FinalizeStopped

VARIABLES pool, boot, run, runBoot, owner, pub, faults, recovering, https,
          httpsBoot, fin
vars == <<pool, boot, run, runBoot, owner, pub, faults, recovering, https,
          httpsBoot, fin>>
H == <<https, httpsBoot, fin>>

TypeOK ==
    /\ pool \in {"running", "stopped", "crashed"}
    /\ boot \in 0..MaxBoot /\ runBoot \in 0..MaxBoot
    /\ run \in {"none", "ready", "retained"}
    /\ owner \in {"none", "live", "dead"}
    /\ pub \in BOOLEAN /\ faults \in 0..MaxFaults /\ recovering \in BOOLEAN
    /\ https \in {"none", "live", "records"} /\ httpsBoot \in 0..MaxBoot
    /\ fin \in BOOLEAN

Init ==
    /\ pool = "stopped" /\ boot = 0 /\ run = "none" /\ runBoot = 0
    /\ owner = "none" /\ pub = FALSE /\ faults = 0 /\ recovering = FALSE
    /\ https = "none" /\ httpsBoot = 0 /\ fin = FALSE

CanBoot == boot < MaxBoot
\* Recovery of a dead owner's ready run in the current boot `b`.
CanRecover(b) ==
    \/ runBoot = b                                  \* same boot: recover-live-owner
    \/ IF Strict THEN runBoot + 1 = b ELSE runBoot < b

\* --- Faults and environment (bounded) -------------------------------------
Fault == faults < MaxFaults /\ (RecoveryFaults \/ ~recovering)
\* `runtime down` while the run is live: the pool stops; the guest's containers
\* go with it. It does not retire the foreground owner's publication.
RuntimeDown ==
    /\ Fault /\ pool = "running"
    /\ pool' = "stopped" /\ faults' = faults + 1
    /\ UNCHANGED <<boot, run, runBoot, owner, pub, recovering>> /\ UNCHANGED H
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
    /\ https' = "records"
    /\ UNCHANGED <<pool, boot, run, runBoot, owner, pub, faults, recovering, httpsBoot, fin>>
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
       IN /\ boot' = b
          /\ runBoot' = b
          /\ https' = IF Https THEN "live" ELSE "none"
          /\ httpsBoot' = IF Https THEN b ELSE 0
    /\ pool' = "running" /\ run' = "ready" /\ owner' = "live" /\ pub' = TRUE
    /\ UNCHANGED <<faults, recovering, fin>>

\* Recovery of a dead owner's ready run on a running pool (the existing
\* `hack down --recover`, also plain `hack down` once the frontend is gone):
\* cleanup with data retained, then the publication is retired. The frontend
\* finalization (the HTTPS lease) follows as its own step, Finalize.
RecoverRunning ==
    /\ pool = "running" /\ run = "ready" /\ owner = "dead" /\ CanRecover(boot)
    /\ run' = "retained" /\ pub' = FALSE /\ owner' = "none" /\ recovering' = FALSE
    /\ fin' = (https /= "none")
    /\ UNCHANGED <<pool, boot, runBoot, faults, https, httpsBoot>>

\* The frontend finalization of a recovered run releases the HTTPS lease: through
\* the live owner when it is bound to this boot, otherwise by archiving the owner's
\* records, which needs the owner gone (a live owner of an ended boot is waited for,
\* OwnerRetire) and a satisfiable quiescence proof.
Finalize ==
    /\ pool = "running" /\ run = "retained" /\ fin /\ ~pub
    /\ \/ https = "live" /\ httpsBoot = boot
       \/ https = "records" /\ ArchiveWorks
       \/ https = "none"
    /\ https' = "none" /\ httpsBoot' = 0 /\ fin' = FALSE
    /\ UNCHANGED <<pool, boot, run, runBoot, owner, pub, faults, recovering>>

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
    /\ UNCHANGED <<pool, boot, runBoot, faults, recovering, fin>>

\* `hack up` = Start, or (Fixed) recovery of a dead owner's run then Start on
\* a later command; `hack down` = Stop, RecoverRunning or (Fixed) RecoverStopped.
Up == Start \/ RecoverStopped
Down == Stop \/ RecoverRunning \/ RecoverStopped \/ Finalize
User == Up \/ Down \/ PoolRecover \/ (ByHand /\ RuntimeUp)

Next == RuntimeDown \/ Crash \/ OwnerCrash \/ OwnerNotices \/ OwnerRetire \/ RuntimeUp
        \/ User
Spec == Init /\ [][Next]_vars
\* User commands keep being tried; the owner notices its guest is gone.
FairSpec == Spec /\ WF_vars(Up) /\ WF_vars(Down) /\ WF_vars(PoolRecover)
            /\ WF_vars(OwnerNotices) /\ WF_vars(OwnerRetire)
            /\ (ByHand => WF_vars(RuntimeUp))

\* Up: the run is ready in the current boot with a live owner. Down: nothing
\* is running for it and no publication blocks a start.
Settled ==
    \/ pool = "running" /\ run = "ready" /\ owner = "live" /\ runBoot = boot
    \/ run \in {"none", "retained"} /\ ~pub /\ ~fin

\* From every reachable state some named command can act, or the owner is still
\* noticing that its guest is gone (it exits on its own), as is the HTTPS owner.
NoDeadEnd == Settled \/ ENABLED User \/ ENABLED OwnerNotices \/ ENABLED OwnerRetire
\* The boot bound is a model limit, not a dead end: it must never be what stops a command.
BootBoundUnreached == CanBoot
\* Under fair user commands, with faults bounded, the project settles again and again.
Recovers == []<>Settled
=============================================================================
