---- MODULE ProjectRemoteSelection ----
CONSTANTS UseSavedOnTeardown, TrustUnlabelledPeer
VARIABLES saved, record, label, started, hook, phase, declared, peer, stop
vars == <<saved, record, label, started, hook, phase, declared, peer, stop>>
None == "none"
Init == /\ saved = "live"
        /\ record = None
        /\ label = None
        /\ started = None
        /\ hook = None
        /\ phase = "stopped"
        /\ declared = TRUE
        /\ peer = "none"
        /\ stop = "none"
Begin == /\ phase = "stopped"
         /\ phase' = "starting"
         /\ record' = None
         /\ UNCHANGED <<saved, label, started, hook, declared, peer, stop>>
Started == /\ phase = "starting"
           /\ phase' = "started"
           /\ started' = "local"
           /\ label' = "local"
           /\ record' = "local"
           /\ UNCHANGED <<saved, hook, declared, peer, stop>>
Fail == /\ phase \in {"starting", "started"}
        /\ phase' = "failed"
        /\ record' = None
        /\ UNCHANGED <<saved, label, started, hook, declared, peer, stop>>
RemoveConfig == /\ phase \in {"started", "failed"}
                /\ declared
                /\ declared' = FALSE
                /\ UNCHANGED <<saved, record, label, started, hook, phase, peer, stop>>
ObservePeer == /\ phase \in {"started", "failed"}
               /\ peer = "none"
               /\ peer' \in {"one-off", "foreign"}
               /\ UNCHANGED <<saved, record, label, started, hook, phase, declared, stop>>
Restart == /\ phase \in {"started", "failed"}
           /\ declared
           /\ phase' = "restart refused"
           /\ UNCHANGED <<saved, record, label, started, hook, declared, peer, stop>>
Teardown == /\ phase \in {"failed", "started", "restart refused"}
            /\ phase' = "done"
            /\ hook' = IF declared /\ label # None THEN label
                       ELSE IF declared /\ record # None THEN record
                       ELSE IF UseSavedOnTeardown THEN saved ELSE None
            /\ stop' = IF peer = "foreign" /\ (~TrustUnlabelledPeer \/ declared) THEN "refused"
                       ELSE IF label # None THEN "owned" ELSE "empty"
            /\ UNCHANGED <<saved, record, label, started, declared, peer>>
Next == Begin \/ Started \/ Fail \/ RemoveConfig \/ ObservePeer \/ Restart \/ Teardown
Spec == Init /\ [][Next]_vars
TeardownUsesStartedTarget == hook = None \/ hook = started
RecoveryRequiresOwnership == stop # "owned" \/ (label # None /\ peer # "foreign")
====
