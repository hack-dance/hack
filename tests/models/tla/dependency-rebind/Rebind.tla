---------------------------- MODULE Rebind ----------------------------
EXTENDS TLC, FiniteSets
CONSTANT EnforceBarrier
VARIABLES phase, reviewed, fenced, revoked, streams, fresh, committed,
          admitted, cancelled, ownerAlive
vars == <<phase, reviewed, fenced, revoked, streams, fresh, committed,
          admitted, cancelled, ownerAlive>>
Targets == {1, 2}
Init == /\ phase = "old"
        /\ reviewed = FALSE /\ fenced = FALSE /\ revoked = {}
        /\ streams = Targets /\ fresh = {} /\ committed = FALSE
        /\ admitted = FALSE /\ cancelled = FALSE /\ ownerAlive = TRUE
Review == /\ phase = "old" /\ ownerAlive /\ ~cancelled
          /\ reviewed' = TRUE /\ phase' = "reviewed"
          /\ UNCHANGED <<fenced, revoked, streams, fresh, committed,
                          admitted, cancelled, ownerAlive>>
Fence == /\ phase = "reviewed" /\ ownerAlive /\ ~cancelled
         /\ fenced' = TRUE /\ phase' = "fenced"
         /\ UNCHANGED <<reviewed, revoked, streams, fresh, committed,
                         admitted, cancelled, ownerAlive>>
Retire == /\ phase = "fenced" /\ ownerAlive /\ ~cancelled
          /\ revoked' = Targets /\ streams' = {} /\ phase' = "retired"
          /\ UNCHANGED <<reviewed, fenced, fresh, committed,
                          admitted, cancelled, ownerAlive>>
Register == /\ phase = "retired" /\ ownerAlive /\ ~cancelled
            /\ \E target \in Targets \ fresh:
                  /\ fresh' = fresh \cup {target}
                  /\ UNCHANGED <<phase, reviewed, fenced, revoked, streams,
                                  committed, admitted, cancelled, ownerAlive>>
Commit == /\ phase = "retired" /\ fresh = Targets
          /\ ownerAlive /\ ~cancelled
          /\ committed' = TRUE /\ phase' = "committed"
          /\ UNCHANGED <<reviewed, fenced, revoked, streams, fresh,
                          admitted, cancelled, ownerAlive>>
Release == /\ ownerAlive /\ ~cancelled
           /\ IF EnforceBarrier THEN phase = "committed"
                                  ELSE phase \in {"reviewed", "committed"}
           /\ admitted' = TRUE /\ fenced' = FALSE /\ phase' = "active"
           /\ UNCHANGED <<reviewed, revoked, streams, fresh, committed,
                           cancelled, ownerAlive>>
Cancel == /\ phase \notin {"old", "active", "failed"}
          /\ ownerAlive /\ ~cancelled
          /\ cancelled' = TRUE /\ fenced' = TRUE /\ admitted' = FALSE
          /\ fresh' = {} /\ phase' = "failed"
          /\ UNCHANGED <<reviewed, revoked, streams, committed, ownerAlive>>
Crash == /\ ownerAlive /\ ownerAlive' = FALSE /\ admitted' = FALSE
         /\ fresh' = {} /\ fenced' = TRUE
         /\ UNCHANGED <<phase, reviewed, revoked, streams, committed, cancelled>>
Next == Review \/ Fence \/ Retire \/ Register \/ Commit \/ Release \/ Cancel \/ Crash
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"old", "reviewed", "fenced", "retired", "committed", "active", "failed"}
          /\ reviewed \in BOOLEAN /\ fenced \in BOOLEAN
          /\ revoked \subseteq Targets /\ streams \subseteq Targets
          /\ fresh \subseteq Targets /\ committed \in BOOLEAN
          /\ admitted \in BOOLEAN /\ cancelled \in BOOLEAN /\ ownerAlive \in BOOLEAN
NoEarlyAdmission == admitted => (reviewed /\ revoked = Targets /\ streams = {}
                                /\ fresh = Targets /\ committed /\ ~fenced
                                /\ ~cancelled /\ ownerAlive)
NoMixedGeneration == fresh # {} => (revoked = Targets /\ streams = {})
======================================================================
