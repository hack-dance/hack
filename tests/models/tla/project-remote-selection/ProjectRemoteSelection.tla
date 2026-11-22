---- MODULE ProjectRemoteSelection ----
CONSTANTS UseSavedOnTeardown, TrustUnlabelledPeer, Fault
VARIABLES saved, record, label, started, hook, phase, declared, peer, stop, stale, renamed
vars == <<saved, record, label, started, hook, phase, declared, peer, stop, stale, renamed>>
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
        /\ stale = FALSE
        /\ renamed = FALSE
Begin == /\ phase = "stopped"
         /\ phase' = "starting"
         /\ record' = None
         /\ UNCHANGED <<saved, label, started, hook, declared, peer, stop, stale, renamed>>
Started == /\ phase = "starting"
           /\ phase' = "started"
           /\ started' = "local"
           /\ label' = "local"
           /\ record' = "local"
           /\ UNCHANGED <<saved, hook, declared, peer, stop, stale, renamed>>
Fail == /\ phase \in {"starting", "started"}
        /\ phase' = "failed"
        /\ record' = None
        /\ UNCHANGED <<saved, label, started, hook, declared, peer, stop, stale, renamed>>
RemoveConfig == /\ phase \in {"started", "failed"}
                /\ declared
                /\ declared' = FALSE
                /\ UNCHANGED <<saved, record, label, started, hook, phase, peer, stop, stale, renamed>>
ObservePeer == /\ phase \in {"started", "failed"}
               /\ peer = "none"
               /\ peer' \in {"one-off", "foreign"}
               /\ UNCHANGED <<saved, record, label, started, hook, phase, declared, stop, stale, renamed>>
Restart == /\ phase \in {"started", "failed"}
           /\ declared
           /\ phase' = "restart refused"
           /\ UNCHANGED <<saved, record, label, started, hook, declared, peer, stop, stale, renamed>>
Switch == /\ phase = "started"
          /\ ~stale
          /\ stale' = TRUE
          /\ label' = "live"
          /\ started' = "live"
          /\ UNCHANGED <<saved, record, hook, phase, declared, peer, stop, renamed>>
RenameBinding == /\ phase = "started"
                 /\ ~renamed
                 /\ renamed' = TRUE
                 /\ UNCHANGED <<saved, record, label, started, hook, phase, declared, peer, stop, stale>>
Teardown == /\ phase \in {"failed", "started", "restart refused"}
            /\ phase' = "done"
            /\ hook' = IF stale /\ Fault = "stale" THEN None
                       ELSE IF declared /\ label # None THEN label
                       ELSE IF declared /\ record # None THEN record
                       ELSE IF UseSavedOnTeardown THEN saved ELSE None
            /\ stop' = IF peer = "foreign" /\ (~TrustUnlabelledPeer \/ declared) THEN "refused"
                       ELSE IF label # None
                            THEN IF renamed /\ Fault = "renamed" THEN "failed" ELSE "owned"
                            ELSE IF Fault = "empty" THEN "empty" ELSE "failed"
            /\ UNCHANGED <<saved, record, label, started, declared, peer, stale, renamed>>
Next == Begin \/ Started \/ Fail \/ RemoveConfig \/ ObservePeer \/ Restart \/ Switch \/ RenameBinding \/ Teardown
Spec == Init /\ [][Next]_vars
TeardownUsesStartedTarget == hook = None \/ hook = started
RecoveryRequiresOwnership == stop # "owned" \/ (label # None /\ peer # "foreign")
NoGuessedEmpty == stop # "empty"
ActiveLabelWins == phase # "done" \/ ~stale \/ ~declared \/ hook = started
RenamedBindingCanRecover == phase # "done" \/ ~renamed \/ peer = "foreign" \/ stop = "owned"
====
