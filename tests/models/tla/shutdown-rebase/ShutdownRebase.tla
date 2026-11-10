------------------------- MODULE ShutdownRebase -------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Keys, SkipRebase, SkipAbsence
VARIABLES phase, services, evidence, archived, oldState, history, unsafePrune
vars == <<phase, services, evidence, archived, oldState, history, unsafePrune>>
Init == /\ phase = "stopped" /\ services = Keys /\ evidence = Keys
        /\ archived = FALSE /\ oldState \in {"absent", "present", "unknown"}
        /\ history \in BOOLEAN /\ unsafePrune = FALSE
\* Actual restore first confirms absence of all old compute and retains receipts.
Archive == /\ phase = "stopped" /\ oldState = "absent"
           /\ phase' = "archived" /\ archived' = TRUE
           /\ UNCHANGED <<services, evidence, oldState, history, unsafePrune>>
\* History publication and shutdown replacement are separate crash boundaries.
Rebase == /\ phase = "archived" /\ phase' = "rebased"
          /\ evidence' = IF SkipRebase THEN evidence ELSE {}
          /\ UNCHANGED <<services, archived, oldState, history, unsafePrune>>
Start == /\ phase = "rebased" /\ phase' = "running"
         /\ services' \in SUBSET Keys
         /\ UNCHANGED <<evidence, archived, oldState, history, unsafePrune>>
Crash == /\ phase \in {"archived", "rebased"} /\ phase' = "stopped"
         /\ UNCHANGED <<services, evidence, archived, oldState, history, unsafePrune>>
Stop == /\ phase = "running" /\ evidence \subseteq services
        /\ phase' = "done" /\ evidence' = services
        /\ UNCHANGED <<services, archived, oldState, history, unsafePrune>>
\* Legacy graph already restored without a reset: repair must prove exact old ID
\* from stopped history and freshly inspect it absent. Present includes exited.
Legacy == /\ phase = "stopped" /\ phase' = "uncertain" /\ services' = {}
          /\ UNCHANGED <<evidence, archived, oldState, history, unsafePrune>>
Repair == /\ phase = "uncertain" /\ history
          /\ (oldState = "absent" \/ SkipAbsence)
          /\ phase' = "repaired" /\ archived' = TRUE /\ evidence' = {}
          /\ unsafePrune' = (unsafePrune \/ oldState # "absent")
          /\ UNCHANGED <<services, oldState, history>>
Next == Archive \/ Rebase \/ Start \/ Crash \/ Stop \/ Legacy \/ Repair
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"stopped", "archived", "rebased", "running", "done", "uncertain", "repaired"}
          /\ services \subseteq Keys /\ evidence \subseteq Keys
          /\ archived \in BOOLEAN /\ history \in BOOLEAN /\ unsafePrune \in BOOLEAN
          /\ oldState \in {"absent", "present", "unknown"}
StopAdmitted == phase = "running" => evidence \subseteq services
NoUnprovenPrune == ~unsafePrune
RetainedBeforeReset == phase \in {"rebased", "running", "repaired"} => archived
=============================================================================
