------------------------- MODULE DownLostFrontend -------------------------
\* HACK-2097: `hack down --recover` after a lost foreground `up` whose graph
\* owner is still running. The owner sees its frontend go and runs its own
\* retaining stop (HACK-2087), racing the down that follows.
\*
\* Source mapping (src/backends/native-project-down.ts):
\*   Select    nativeProjectDownOnce: inspect, then selectForegroundOwner
\*   Stop      requestOwnedStop: `graph cleanup` for a running/absent owner
\*   Reselect  requestOwnedStop catch: graph_owner_recovery after a running
\*             selection selects once more (Reselect = FALSE is the code before)
\*   Recover   recoverLiveOwner: same-boot `graph recover-live-owner`
\*   Confirm   verify(inspect, stopped): stopped receipt, containers absent,
\*             then frontend finalization recovery (Confirm = FALSE skips it)
\* Owner effects (runtime-core foreground owner):
\*   SelfStop  parent exit observed; retaining cleanup; publication retired
\*   Die       owner killed part-way; publication left (exited)
\*   Vanish    publication gone without a stop (torn retirement): only the
\*             stopped-receipt check stands between it and a false success
\* Atomic abstractions: the owner's whole stop, the runtime's proofs inside
\* recover-live-owner, and the frontend recovery after Confirm.
EXTENDS TLC
CONSTANTS Reselect, Confirm
VARIABLES owner, graph, pc, sel, reselected, vanished
vars == <<owner, graph, pc, sel, reselected, vanished>>

Owners == {"running", "exited", "absent"}
Steps == {"select", "stop", "reselect", "recover", "confirm", "done", "refused"}

TypeOK == /\ owner \in Owners /\ graph \in {"ready", "stopped"}
          /\ pc \in Steps /\ sel \in Owners \cup {"none"}
          /\ reselected \in BOOLEAN /\ vanished \in BOOLEAN

\* The frontend is already lost; the owner still runs its ready graph.
Init == /\ owner = "running" /\ graph = "ready" /\ pc = "select"
        /\ sel = "none" /\ reselected = FALSE /\ vanished = FALSE

Down == pc \notin {"done", "refused"}

SelfStop == /\ owner = "running" /\ graph = "ready"
            /\ owner' = "absent" /\ graph' = "stopped"
            /\ UNCHANGED <<pc, sel, reselected, vanished>>
Die == /\ owner = "running"
       /\ owner' = "exited"
       /\ UNCHANGED <<graph, pc, sel, reselected, vanished>>
Vanish == /\ owner = "running" /\ graph = "ready"
          /\ owner' = "absent" /\ vanished' = TRUE
          /\ UNCHANGED <<graph, pc, sel, reselected>>

\* A stopped graph needs no stop; otherwise dispatch on the selection.
Select == /\ pc = "select"
          /\ sel' = owner
          /\ pc' = CASE graph = "stopped" -> "confirm"
                     [] owner = "exited" -> "recover"
                     [] OTHER -> "stop"
          /\ UNCHANGED <<owner, graph, reselected, vanished>>
\* The authenticated stop reaches only a live owner.
Stop == /\ pc = "stop"
        /\ IF owner = "running"
           THEN /\ owner' = "absent" /\ graph' = "stopped" /\ pc' = "confirm"
           ELSE /\ pc' = IF Reselect /\ sel = "running" /\ ~reselected
                         THEN "reselect" ELSE "refused"
                /\ UNCHANGED <<owner, graph>>
        /\ UNCHANGED <<sel, reselected, vanished>>
ReselectOwner ==
    /\ pc = "reselect"
    /\ sel' = owner /\ reselected' = TRUE
    /\ pc' = CASE owner = "exited" -> "recover"
               [] owner = "absent" -> "confirm"
               [] OTHER -> "refused"
    /\ UNCHANGED <<owner, graph, vanished>>
\* The runtime rechecks owner death; a live owner is never recovered.
Recover == /\ pc = "recover"
           /\ IF owner = "exited"
              THEN /\ owner' = "absent" /\ graph' = "stopped" /\ pc' = "confirm"
              ELSE /\ pc' = "refused" /\ UNCHANGED <<owner, graph>>
           /\ UNCHANGED <<sel, reselected, vanished>>
ConfirmStop == /\ pc = "confirm"
               /\ pc' = IF graph = "stopped" \/ ~Confirm THEN "done" ELSE "refused"
               /\ UNCHANGED <<owner, graph, sel, reselected, vanished>>

Next == \/ SelfStop \/ Die \/ Vanish
        \/ Select \/ Stop \/ ReselectOwner \/ Recover \/ ConfirmStop
Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ WF_vars(Select) /\ WF_vars(Stop) /\ WF_vars(ReselectOwner)
                 /\ WF_vars(Recover) /\ WF_vars(ConfirmStop)

\* Success means the graph is stopped with its data (no false success).
DoneIsStopped == pc = "done" => graph = "stopped"
\* The only refusal left is the abnormal torn retirement, whose stopped-receipt
\* check refuses without replaying cleanup. A live or exited owner, or one that
\* stopped itself, never ends in a refusal.
NoDeadEnd == pc = "refused" => vanished
\* Every down ends.
Ends == <>(~Down)
=============================================================================
