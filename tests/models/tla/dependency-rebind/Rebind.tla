---------------------------- MODULE Rebind ----------------------------
EXTENDS TLC, FiniteSets
CONSTANT EnforceBarrier, EnforceTerminalReview,
         DeclaredCompleted, ExitedZero, ExitedFailure
VARIABLES phase, reviewed, fenced, revoked, streams, fresh, committed,
          admitted, cancelled, ownerAlive, completed
vars == <<phase, reviewed, fenced, revoked, streams, fresh, committed,
          admitted, cancelled, ownerAlive, completed>>
Targets == {1, 2}
Stopped == ExitedZero \cup ExitedFailure
Running == Targets \ Stopped
ValidCompleted == DeclaredCompleted \cap ExitedZero
Init == /\ phase = "old"
        /\ reviewed = FALSE /\ fenced = FALSE /\ revoked = {}
        /\ streams = Targets /\ fresh = {} /\ committed = FALSE
        /\ admitted = FALSE /\ cancelled = FALSE /\ ownerAlive = TRUE
        /\ completed = {}
Review == /\ phase = "old" /\ ownerAlive /\ ~cancelled
          /\ IF EnforceTerminalReview THEN Stopped = ValidCompleted
                                      ELSE TRUE
          /\ completed' = Stopped
          /\ reviewed' = TRUE /\ phase' = "reviewed"
          /\ UNCHANGED <<fenced, revoked, streams, fresh, committed,
                          admitted, cancelled, ownerAlive>>
Fence == /\ phase = "reviewed" /\ ownerAlive /\ ~cancelled
         /\ fenced' = TRUE /\ phase' = "fenced"
         /\ UNCHANGED <<reviewed, revoked, streams, fresh, committed,
                         admitted, cancelled, ownerAlive, completed>>
Retire == /\ phase = "fenced" /\ ownerAlive /\ ~cancelled
          /\ revoked' = Targets /\ streams' = {} /\ phase' = "retired"
          /\ UNCHANGED <<reviewed, fenced, fresh, committed,
                          admitted, cancelled, ownerAlive, completed>>
Register == /\ phase = "retired" /\ ownerAlive /\ ~cancelled
            /\ \E target \in Running \ fresh:
                  /\ fresh' = fresh \cup {target}
                  /\ UNCHANGED <<phase, reviewed, fenced, revoked, streams,
                                  committed, admitted, cancelled, ownerAlive,
                                  completed>>
Commit == /\ phase = "retired" /\ fresh = Running
          /\ ownerAlive /\ ~cancelled
          /\ committed' = TRUE /\ phase' = "committed"
          /\ UNCHANGED <<reviewed, fenced, revoked, streams, fresh,
                          admitted, cancelled, ownerAlive, completed>>
Release == /\ ownerAlive /\ ~cancelled
           /\ Running # {}
           /\ IF EnforceBarrier THEN phase = "committed"
                                  ELSE phase \in {"reviewed", "committed"}
           /\ admitted' = TRUE /\ fenced' = FALSE /\ phase' = "active"
           /\ UNCHANGED <<reviewed, revoked, streams, fresh, committed,
                           cancelled, ownerAlive, completed>>
CloseTerminal == /\ phase = "committed" /\ Running = {}
                 /\ ownerAlive /\ ~cancelled
                 /\ phase' = "terminal" /\ fenced' = TRUE
                 /\ UNCHANGED <<reviewed, revoked, streams, fresh, committed,
                                 admitted, cancelled, ownerAlive, completed>>
Cancel == /\ phase \notin {"old", "active", "terminal", "failed"}
          /\ ownerAlive /\ ~cancelled
          /\ cancelled' = TRUE /\ fenced' = TRUE /\ admitted' = FALSE
          /\ fresh' = {} /\ phase' = "failed"
          /\ UNCHANGED <<reviewed, revoked, streams, committed, ownerAlive,
                          completed>>
Crash == /\ ownerAlive /\ ownerAlive' = FALSE /\ admitted' = FALSE
         /\ fresh' = {} /\ fenced' = TRUE
         /\ UNCHANGED <<phase, reviewed, revoked, streams, committed, cancelled,
                         completed>>
Next == Review \/ Fence \/ Retire \/ Register \/ Commit \/ Release
        \/ CloseTerminal \/ Cancel \/ Crash
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"old", "reviewed", "fenced", "retired", "committed", "active", "terminal", "failed"}
          /\ reviewed \in BOOLEAN /\ fenced \in BOOLEAN
          /\ revoked \subseteq Targets /\ streams \subseteq Targets
          /\ fresh \subseteq Targets /\ committed \in BOOLEAN
          /\ admitted \in BOOLEAN /\ cancelled \in BOOLEAN /\ ownerAlive \in BOOLEAN
          /\ completed \subseteq Targets
          /\ DeclaredCompleted \subseteq Targets
          /\ ExitedZero \subseteq Targets /\ ExitedFailure \subseteq Targets
          /\ ExitedZero \cap ExitedFailure = {}
NoEarlyAdmission == admitted => (reviewed /\ revoked = Targets /\ streams = {}
                                /\ fresh = Running /\ committed /\ ~fenced
                                /\ ~cancelled /\ ownerAlive /\ Running # {})
NoMixedGeneration == fresh # {} => (revoked = Targets /\ streams = {})
NoWrongTerminalReadiness == completed \subseteq ValidCompleted
NoTerminalGrant == fresh \cap Stopped = {}
======================================================================
