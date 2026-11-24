---- MODULE ProjectRemoteSelection ----
CONSTANTS UseSavedOnTeardown, KeepStaleLabel
VARIABLES record, label, started, hook, phase, stale
vars == <<record, label, started, hook, phase, stale>>
None == "none"
Init == /\ record = None
        /\ label = None
        /\ started = None
        /\ hook = None
        /\ phase = "starting"
        /\ stale = FALSE
Started == /\ phase = "starting"
           /\ phase' = "started"
           /\ started' = "local"
           /\ label' = "local"
           /\ record' = "local"
           /\ UNCHANGED <<hook, stale>>
Crash == /\ phase \in {"starting", "started"}
         /\ phase' = "crashed"
         /\ record' = None
         /\ UNCHANGED <<label, started, hook, stale>>
Switch == /\ phase = "started"
          /\ ~stale
          /\ stale' = TRUE
          /\ label' = "qa"
          /\ started' = "qa"
          /\ UNCHANGED <<record, hook, phase>>
Teardown == /\ phase \in {"started", "crashed"}
            /\ phase' = "done"
            /\ hook' = IF stale /\ KeepStaleLabel THEN None
                       ELSE IF label # None THEN label
                       ELSE IF record # None THEN record
                       ELSE IF UseSavedOnTeardown THEN "pending" ELSE None
            /\ UNCHANGED <<record, label, started, stale>>
Next == Started \/ Crash \/ Switch \/ Teardown
Spec == Init /\ [][Next]_vars
TeardownUsesStartedTarget == hook = None \/ hook = started
ActiveLabelWins == phase # "done" \/ ~stale \/ hook = started
====
