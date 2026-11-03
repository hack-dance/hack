---- MODULE Instance ----
\* Lifecycle-session ownership for one shared-helper instance (one branch):
\* two overlapping `hack up` runs and one `hack down`. Source mapping and
\* omissions are in tests/models/tla/README.md ("Shared helper instance").
EXTENDS Naturals, TLC
Ups == {"a", "b"}
VARIABLES pc, cap, gen, epoch, mine, session, down
vars == <<pc, cap, gen, epoch, mine, session, down>>

Init == /\ pc = [u \in Ups |-> "idle"]
        /\ cap = [u \in Ups |-> 0]
        /\ gen = 0
        /\ epoch = <<"none", "none">>
        /\ mine = [u \in Ups |-> FALSE]
        /\ session = "absent"
        /\ down = "idle"

\* captureSharedHelperShutdownGeneration, before up.before hooks.
Capture(u) == /\ pc[u] = "idle"
              /\ pc' = [pc EXCEPT ![u] = "captured"]
              /\ cap' = [cap EXCEPT ![u] = gen]
              /\ UNCHANGED <<gen, epoch, mine, session, down>>

\* startProjectSharedHelpers refuses a start a down superseded during its hooks.
Superseded(u) == /\ pc[u] = "captured" /\ gen # cap[u]
                 /\ pc' = [pc EXCEPT ![u] = "done"]
                 /\ UNCHANGED <<cap, gen, epoch, mine, session, down>>

\* Helpers ready, then the controller's session decision and creation, each
\* under the instance lock and recorded as the session epoch.
Decide(u) == /\ pc[u] = "captured" /\ gen = cap[u]
             /\ pc' = [pc EXCEPT ![u] = "decided"]
             /\ IF session = "alive"
                   THEN /\ epoch' = <<u, "adopted">>
                        /\ UNCHANGED <<mine, session>>
                   ELSE /\ epoch' = <<u, "created">>
                        /\ mine' = [mine EXCEPT ![u] = TRUE]
                        /\ session' = "alive"
             /\ UNCHANGED <<cap, gen, down>>

\* assertCurrent before containers start.
Launch(u) == /\ pc[u] = "decided" /\ gen = cap[u]
             /\ pc' = [pc EXCEPT ![u] = "launched"]
             /\ UNCHANGED <<cap, gen, epoch, mine, session, down>>

\* assertCurrent after containers start.
Succeed(u) == /\ pc[u] = "launched" /\ gen = cap[u]
              /\ pc' = [pc EXCEPT ![u] = "succeeded"]
              /\ UNCHANGED <<cap, gen, epoch, mine, session, down>>

\* Compose failure, SIGINT/SIGTERM, or a failed assertCurrent.
Fail(u) == /\ pc[u] \in {"decided", "launched"}
           /\ pc' = [pc EXCEPT ![u] = "failed"]
           /\ UNCHANGED <<cap, gen, epoch, mine, session, down>>

\* runIfOwned: under the instance lock, the creator kills the session only
\* while the epoch is still its own creation.
Cleanup(u) == /\ pc[u] = "failed"
              /\ pc' = [pc EXCEPT ![u] = "done"]
              /\ session' = IF mine[u] /\ epoch = <<u, "created">>
                               THEN "absent" ELSE session
              /\ UNCHANGED <<cap, gen, epoch, mine, down>>

\* The instance lock stayed busy: ownership undecidable, session kept.
CleanupUndecidable(u) == /\ pc[u] = "failed"
                         /\ pc' = [pc EXCEPT ![u] = "done"]
                         /\ UNCHANGED <<cap, gen, epoch, mine, session, down>>

\* A committed down: the stopping mark advances the generation; shutdown
\* (Compose/graph down, session stop) and the helper release, which advances
\* it again, are one step here. The real gap between the session stop and the
\* release is the documented launch-prevention limitation (README).
DownMark == /\ down = "idle"
            /\ down' = "marked" /\ gen' = gen + 1
            /\ UNCHANGED <<pc, cap, epoch, mine, session>>
DownStop == /\ down = "marked"
            /\ down' = "stopped" /\ session' = "absent" /\ gen' = gen + 1
            /\ UNCHANGED <<pc, cap, epoch, mine>>

Next == \/ \E u \in Ups : \/ Capture(u) \/ Superseded(u) \/ Decide(u)
                          \/ Launch(u) \/ Succeed(u) \/ Fail(u)
                          \/ Cleanup(u) \/ CleanupUndecidable(u)
        \/ DownMark \/ DownStop
Spec == Init /\ [][Next]_vars

\* An up that succeeded with no down since its capture keeps a live session.
SessionSafe == \A u \in Ups :
                 (pc[u] = "succeeded" /\ cap[u] = gen) => session = "alive"
====
