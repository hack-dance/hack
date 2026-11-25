------------------------- MODULE DownLostFrontend -------------------------
\* HACK-2097: `hack down --recover` (or plain `hack down`) after a lost
\* foreground `up` whose graph owner is still running. The owner sees its
\* frontend go and runs its own retaining stop (HACK-2087), racing the down.
\* The model starts after the down's first selection saw the owner running.
\*
\* Source mapping (src/backends/native-project-down.ts):
\*   Stop      requestOwnedStop: `graph cleanup`, answered only by a live owner
\*             that has not begun its own stop
\*   Reselect  stopAfterOwnerGone after graph_owner_recovery (Reselect = FALSE
\*             is the code before): awaitOwnerExit polls while the owner is
\*             running or its publication reads `uncertain` (Settle = FALSE is
\*             the first fix without the wait), at most MaxPolls; then
\*             ownerStillExiting, or dispatch on the settled selection
\*   Recover   recoverLiveOwner: same-boot `graph recover-live-owner`
\*   Retire    resumeSelectedOwner -> retireUnadmittedOwner for an owner that
\*             died after its stop wrote the retained receipt
\*   Confirm   verify(inspect, stopped): stopped receipt, containers absent,
\*             then frontend finalization recovery (Confirm = FALSE skips it)
\*   Rerun     the user follows ownerStillExiting: once the owner has exited,
\*             the same command again (its first selection dispatches alike)
\* Owner effects (runtime-core foreground owner, graph/mod.rs cleanup):
\*   BeginStop     parent exit observed; receipt `cleanup-intent` (stopping)
\*   FinishStop    receipt `stopped-data-retained` (stopped)
\*   BeginRetire   publication renames in progress: reads `uncertain`
\*   FinishRetire  publication retired: absent
\*   Die           owner killed at any point of its run or its stop (exited)
\*   Vanish        publication gone without a stop (a torn retirement)
\* why names the refusal: "exiting" (wait, then rerun), "midstop" (explicit
\* dead-owner cleanup), "torn" (the stopped-receipt check), "unnamed" (a dead
\* end: a refusal that names no step that works).
EXTENDS Naturals, TLC
CONSTANTS Reselect, Confirm, Settle, MaxPolls
VARIABLES owner, graph, exiting, pc, reselected, polls, why, vanished
vars == <<owner, graph, exiting, pc, reselected, polls, why, vanished>>
downVars == <<pc, reselected, polls, why>>

Owners == {"running", "uncertain", "exited", "absent"}
Graphs == {"ready", "stopping", "stopped"}
Steps == {"stop", "reselect", "recover", "retire", "confirm", "done", "refused"}
Whys == {"none", "exiting", "midstop", "torn", "unnamed"}

TypeOK == /\ owner \in Owners /\ graph \in Graphs /\ exiting \in BOOLEAN
          /\ pc \in Steps /\ reselected \in BOOLEAN
          /\ polls \in 0..MaxPolls /\ why \in Whys /\ vanished \in BOOLEAN

\* The frontend is lost; the down's first selection saw the owner running.
Init == /\ owner = "running" /\ graph = "ready" /\ exiting = FALSE
        /\ pc = "stop" /\ reselected = FALSE /\ polls = 0 /\ why = "none"
        /\ vanished = FALSE

\* An owner still on its way out: alive, or its publication read mid-change.
Settling == owner \in {"running", "uncertain"}

BeginStop == /\ owner = "running" /\ ~exiting /\ graph = "ready"
             /\ exiting' = TRUE /\ graph' = "stopping"
             /\ UNCHANGED <<owner, vanished>> /\ UNCHANGED downVars
FinishStop == /\ owner = "running" /\ exiting /\ graph = "stopping"
              /\ graph' = "stopped"
              /\ UNCHANGED <<owner, exiting, vanished>> /\ UNCHANGED downVars
BeginRetire == /\ owner = "running" /\ exiting /\ graph = "stopped"
               /\ owner' = "uncertain"
               /\ UNCHANGED <<graph, exiting, vanished>> /\ UNCHANGED downVars
FinishRetire == /\ owner = "uncertain" /\ owner' = "absent"
                /\ UNCHANGED <<graph, exiting, vanished>> /\ UNCHANGED downVars
Die == /\ owner = "running" /\ owner' = "exited"
       /\ UNCHANGED <<graph, exiting, vanished>> /\ UNCHANGED downVars
Vanish == /\ owner = "running" /\ ~exiting /\ graph = "ready"
          /\ owner' = "absent" /\ vanished' = TRUE
          /\ UNCHANGED <<graph, exiting>> /\ UNCHANGED downVars

Refuse(w) == pc' = "refused" /\ why' = w

\* The authenticated stop reaches only a live owner not already stopping.
Stop == /\ pc = "stop"
        /\ IF owner = "running" /\ ~exiting
           THEN /\ owner' = "absent" /\ graph' = "stopped" /\ pc' = "confirm"
                /\ UNCHANGED why
           ELSE /\ IF Reselect /\ ~reselected
                   THEN pc' = "reselect" /\ UNCHANGED why
                   ELSE Refuse("unnamed")
                /\ UNCHANGED <<owner, graph>>
        /\ UNCHANGED <<exiting, reselected, polls, vanished>>
\* Poll while settling, within the bound; then dispatch on what is left.
ReselectOwner ==
    /\ pc = "reselect" /\ reselected' = TRUE
    /\ IF Settling /\ Settle /\ polls < MaxPolls
       THEN polls' = polls + 1 /\ UNCHANGED <<pc, why>>
       ELSE /\ UNCHANGED polls
            /\ CASE Settling -> Refuse(IF Settle THEN "exiting" ELSE "unnamed")
                 [] owner = "absent" -> pc' = "confirm" /\ UNCHANGED why
                 [] graph = "ready" -> pc' = "recover" /\ UNCHANGED why
                 [] graph = "stopped" -> pc' = "retire" /\ UNCHANGED why
                 [] OTHER -> Refuse("midstop")
    /\ UNCHANGED <<owner, graph, exiting, vanished>>
\* The runtime proves the exited owner dead (it never comes back).
Recover == /\ pc = "recover"
           /\ owner' = "absent" /\ graph' = "stopped" /\ pc' = "confirm"
           /\ UNCHANGED <<exiting, reselected, polls, why, vanished>>
Retire == /\ pc = "retire"
          /\ owner' = "absent" /\ pc' = "confirm"
          /\ UNCHANGED <<graph, exiting, reselected, polls, why, vanished>>
ConfirmStop == /\ pc = "confirm"
               /\ IF graph = "stopped" \/ ~Confirm
                  THEN pc' = "done" /\ UNCHANGED why
                  ELSE Refuse("torn")
               /\ UNCHANGED <<owner, graph, exiting, reselected, polls, vanished>>
\* The named step: wait for the owner to exit, then run the same command.
Rerun == /\ pc = "refused" /\ why = "exiting" /\ ~Settling
         /\ pc' = "reselect" /\ polls' = 0 /\ why' = "none"
         /\ UNCHANGED <<owner, graph, exiting, reselected, vanished>>

OwnerNext == BeginStop \/ FinishStop \/ BeginRetire \/ FinishRetire \/ Die \/ Vanish
DownNext == Stop \/ ReselectOwner \/ Recover \/ Retire \/ ConfirmStop \/ Rerun
Next == OwnerNext \/ DownNext
Spec == Init /\ [][Next]_vars
\* The owner finishes a stop it began (it may still die); the down and the
\* user's named rerun take their steps. Die and Vanish are never forced.
FairSpec == /\ Spec
            /\ WF_vars(BeginStop) /\ WF_vars(FinishStop)
            /\ WF_vars(BeginRetire) /\ WF_vars(FinishRetire)
            /\ WF_vars(Stop) /\ WF_vars(ReselectOwner) /\ WF_vars(Recover)
            /\ WF_vars(Retire) /\ WF_vars(ConfirmStop) /\ WF_vars(Rerun)

\* Success means the graph is stopped with its data (no false success).
DoneIsStopped == pc = "done" => graph = "stopped"
\* Every refusal names a step that works: wait and rerun for an owner still
\* exiting, the explicit dead-owner cleanup for one that died during its own
\* stop, and the stopped-receipt check for a torn retirement.
NoDeadEnd == pc = "refused" => why \in {"exiting", "midstop", "torn"}
\* A live owner, or one whose publication is mid-retirement, is never
\* recovered or retired as dead.
NoLiveRecovery == pc \in {"recover", "retire"} => owner = "exited"
\* Under the fair steps the run ends stopped, or in one of the two refusals
\* whose remedy lies outside this command.
Recovers == <>(pc = "done" \/ (pc = "refused" /\ why \in {"midstop", "torn"}))
=============================================================================
