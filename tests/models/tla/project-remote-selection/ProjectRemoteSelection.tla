---- MODULE ProjectRemoteSelection ----
CONSTANT UseSavedOnTeardown
VARIABLES saved, record, label, started, hook, phase
vars == <<saved, record, label, started, hook, phase>>
None == "none"
Init == /\ saved = "live"
        /\ record = None
        /\ label = None
        /\ started = None
        /\ hook = None
        /\ phase = "stopped"
Begin == /\ phase = "stopped"
         /\ phase' = "starting"
         /\ record' = None
         /\ UNCHANGED <<saved, label, started, hook>>
Started == /\ phase = "starting"
           /\ phase' = "started"
           /\ started' = "local"
           /\ label' = "local"
           /\ record' = "local"
           /\ UNCHANGED <<saved, hook>>
Fail == /\ phase \in {"starting", "started"}
        /\ phase' = "failed"
        /\ record' = None
        /\ UNCHANGED <<saved, label, started, hook>>
Teardown == /\ phase \in {"failed", "started"}
            /\ phase' = "done"
            /\ hook' = IF label # None THEN label
                       ELSE IF record # None THEN record
                       ELSE IF UseSavedOnTeardown THEN saved ELSE None
            /\ UNCHANGED <<saved, record, label, started>>
Next == Begin \/ Started \/ Fail \/ Teardown
Spec == Init /\ [][Next]_vars
TeardownUsesStartedTarget == hook = None \/ hook = started
====
