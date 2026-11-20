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
\*             (`dead_owner_cleanup`); FALSE accepts any earlier boot.
\*   ByHand  - `runtime up` by hand counts as a user command (no message names it).
\*   OtherBoots - something else may boot the pool between the stop and this
\*             project's recovery: another project's `hack up`, or `runtime up` by hand.
EXTENDS Naturals
CONSTANTS Fixed, Strict, ByHand, OtherBoots, MaxBoot, MaxFaults

VARIABLES pool, boot, run, runBoot, owner, pub, faults
vars == <<pool, boot, run, runBoot, owner, pub, faults>>

TypeOK ==
    /\ pool \in {"running", "stopped", "crashed"}
    /\ boot \in 0..MaxBoot /\ runBoot \in 0..MaxBoot
    /\ run \in {"none", "ready", "retained"}
    /\ owner \in {"none", "live", "dead"}
    /\ pub \in BOOLEAN /\ faults \in 0..MaxFaults

Init ==
    /\ pool = "stopped" /\ boot = 0 /\ run = "none" /\ runBoot = 0
    /\ owner = "none" /\ pub = FALSE /\ faults = 0

CanBoot == boot < MaxBoot
\* Recovery of a dead owner's ready run in the current boot `b`.
CanRecover(b) ==
    \/ runBoot = b                                  \* same boot: recover-live-owner
    \/ IF Strict THEN runBoot + 1 = b ELSE runBoot < b

\* --- Faults and environment (bounded) -------------------------------------
Fault == faults < MaxFaults
\* `runtime down` while the run is live: the pool stops; the guest's containers
\* go with it. It does not retire the foreground owner's publication.
RuntimeDown ==
    /\ Fault /\ pool = "running"
    /\ pool' = "stopped" /\ faults' = faults + 1
    /\ UNCHANGED <<boot, run, runBoot, owner, pub>>
\* The VM or its provider dies (or the host reboots).
Crash ==
    /\ Fault /\ pool = "running"
    /\ pool' = "crashed" /\ faults' = faults + 1
    /\ UNCHANGED <<boot, run, runBoot, owner, pub>>
\* The foreground owner dies while the pool keeps running.
OwnerCrash ==
    /\ Fault /\ owner = "live"
    /\ owner' = "dead" /\ faults' = faults + 1
    /\ UNCHANGED <<pool, boot, run, runBoot, pub>>
\* The owner notices its guest is gone (the pool stopped, or a later boot
\* replaced it) and exits without retiring its publication.
OwnerNotices ==
    /\ owner = "live" /\ (pool /= "running" \/ runBoot /= boot)
    /\ owner' = "dead"
    /\ UNCHANGED <<pool, boot, run, runBoot, pub, faults>>
\* A boot by something else (another project's `hack up`, or `runtime up` by hand).
\* With ByHand it is a user command of this project; otherwise a bounded fault.
RuntimeUp ==
    /\ pool = "stopped" /\ CanBoot /\ (ByHand \/ (OtherBoots /\ Fault))
    /\ pool' = "running" /\ boot' = boot + 1
    /\ faults' = IF ByHand THEN faults ELSE faults + 1
    /\ UNCHANGED <<run, runBoot, owner, pub>>

\* --- User commands the CLI names ------------------------------------------
\* `hack native recover`: a crashed pool is recorded stopped (recovered-unclean).
PoolRecover ==
    /\ pool = "crashed"
    /\ pool' = "stopped"
    /\ UNCHANGED <<boot, run, runBoot, owner, pub, faults>>

\* A fresh or retained start: boots a stopped pool first.
Start ==
    /\ \/ run = "none"
       \/ run = "retained" /\ ~pub
    /\ pool /= "crashed"
    /\ pool = "running" \/ CanBoot
    /\ LET b == IF pool = "running" THEN boot ELSE boot + 1
       IN /\ boot' = b /\ runBoot' = b
    /\ pool' = "running" /\ run' = "ready" /\ owner' = "live" /\ pub' = TRUE
    /\ UNCHANGED faults

\* Recovery of a dead owner's ready run on a running pool (the existing
\* `hack down --recover`, also plain `hack down` once the frontend is gone):
\* cleanup with data retained, then the publication is retired.
RecoverRunning ==
    /\ pool = "running" /\ run = "ready" /\ owner = "dead" /\ CanRecover(boot)
    /\ run' = "retained" /\ pub' = FALSE /\ owner' = "none"
    /\ UNCHANGED <<pool, boot, runBoot, faults>>

\* HACK-2456: the same with the pool stopped: start it, then recover. If the
\* run's boot is too old to recover, the boot still happened.
RecoverStopped ==
    /\ Fixed
    /\ pool = "stopped" /\ run = "ready" /\ owner = "dead" /\ CanBoot
    /\ pool' = "running" /\ boot' = boot + 1
    /\ IF CanRecover(boot + 1)
       THEN run' = "retained" /\ pub' = FALSE /\ owner' = "none"
       ELSE UNCHANGED <<run, pub, owner>>
    /\ UNCHANGED <<runBoot, faults>>

\* `hack down` of a live run: stop with data retained.
Stop ==
    /\ pool = "running" /\ run = "ready" /\ owner = "live" /\ runBoot = boot
    /\ run' = "retained" /\ pub' = FALSE /\ owner' = "none"
    /\ UNCHANGED <<pool, boot, runBoot, faults>>

\* `hack up` = Start, or (Fixed) recovery of a dead owner's run then Start on
\* a later command; `hack down` = Stop, RecoverRunning or (Fixed) RecoverStopped.
Up == Start \/ RecoverStopped
Down == Stop \/ RecoverRunning \/ RecoverStopped
User == Up \/ Down \/ PoolRecover \/ (ByHand /\ RuntimeUp)

Next == RuntimeDown \/ Crash \/ OwnerCrash \/ OwnerNotices \/ RuntimeUp \/ User
Spec == Init /\ [][Next]_vars
\* User commands keep being tried; the owner notices its guest is gone.
FairSpec == Spec /\ WF_vars(Up) /\ WF_vars(Down) /\ WF_vars(PoolRecover)
            /\ WF_vars(OwnerNotices) /\ (ByHand => WF_vars(RuntimeUp))

\* Up: the run is ready in the current boot with a live owner. Down: nothing
\* is running for it and no publication blocks a start.
Settled ==
    \/ pool = "running" /\ run = "ready" /\ owner = "live" /\ runBoot = boot
    \/ run \in {"none", "retained"} /\ ~pub

\* From every reachable state some named command can act, or the owner is still
\* noticing that its guest is gone (it exits on its own).
NoDeadEnd == Settled \/ ENABLED User \/ ENABLED OwnerNotices \/ ~CanBoot
\* Under fair user commands, with faults bounded, the project settles again and again.
Recovers == []<>Settled
=============================================================================
