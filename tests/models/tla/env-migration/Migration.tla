----------------------------- MODULE Migration -----------------------------
EXTENDS Naturals, TLC
CONSTANTS Steps, UnsafeCleanup, UnsafeRepairProof
VARIABLES phase, published, recorded, snapshot, legacy, complete, runProof,
          separate, live, deferred
vars == <<phase, published, recorded, snapshot, legacy, complete, runProof,
          separate, live, deferred>>

Init == /\ phase = "preview" /\ published = 0 /\ recorded = 0
        /\ snapshot = FALSE /\ legacy = TRUE /\ complete = FALSE
        /\ runProof = FALSE /\ separate = FALSE /\ live \in BOOLEAN
        /\ deferred \in BOOLEAN

Prepare == /\ phase \in {"preview", "rolled_back"}
           /\ phase' = "apply" /\ snapshot' = TRUE
           /\ UNCHANGED <<published, recorded, legacy, complete, runProof, separate, live, deferred>>
Publish == /\ phase = "apply" /\ published = recorded /\ published < Steps
           /\ published' = published + 1
           /\ UNCHANGED <<phase, recorded, snapshot, legacy, complete, runProof, separate, live, deferred>>
Record == /\ phase = "apply" /\ recorded < published
          /\ recorded' = published
          /\ UNCHANGED <<phase, published, snapshot, legacy, complete, runProof, separate, live, deferred>>
Crash == /\ phase = "apply" /\ phase' = "idle"
         /\ UNCHANGED <<published, recorded, snapshot, legacy, complete, runProof, separate, live, deferred>>
Resume == /\ phase = "idle" /\ ~complete /\ snapshot /\ phase' = "apply"
          /\ UNCHANGED <<published, recorded, snapshot, legacy, complete, runProof, separate, live, deferred>>
Finish == /\ phase = "apply" /\ recorded = Steps
          /\ complete' = TRUE /\ phase' = "idle"
          /\ UNCHANGED <<published, recorded, snapshot, legacy, runProof, separate, live, deferred>>
RequestRepair == /\ phase = "idle" /\ complete /\ deferred /\ snapshot /\ legacy
                 /\ phase' = "apply" /\ complete' = FALSE /\ deferred' = FALSE
                 /\ published' = 0 /\ recorded' = 0 /\ separate' = FALSE
                 /\ runProof' = IF UnsafeRepairProof THEN runProof ELSE FALSE
                 /\ UNCHANGED <<snapshot, legacy, live>>
SuccessfulRun == /\ phase = "idle" /\ complete /\ ~runProof
                 /\ runProof' = TRUE
                 /\ UNCHANGED <<phase, published, recorded, snapshot, legacy, complete, separate, live, deferred>>
DamageBackup == /\ phase = "idle" /\ complete /\ legacy /\ snapshot
                /\ snapshot' = FALSE
                /\ UNCHANGED <<phase, published, recorded, legacy, complete, runProof, separate, live, deferred>>
RequestCleanup == /\ phase = "idle" /\ complete /\ runProof /\ snapshot /\ ~live
                  /\ phase' = "cleanup" /\ separate' = TRUE
                  /\ UNCHANGED <<published, recorded, snapshot, legacy, complete, runProof, live, deferred>>
RemoveLegacy == /\ phase = "cleanup" /\ snapshot /\ runProof /\ ~live
                /\ legacy' = FALSE /\ phase' = "idle"
                /\ UNCHANGED <<published, recorded, snapshot, complete, runProof, separate, live, deferred>>
RefuseCleanup == /\ phase = "cleanup" /\ legacy
                 /\ phase' = "idle"
                 /\ UNCHANGED <<published, recorded, snapshot, legacy, complete, runProof, separate, live, deferred>>
UnsafeRemoveDuringApply == /\ UnsafeCleanup /\ phase = "apply" /\ legacy /\ published = 0
                           /\ legacy' = FALSE
                           /\ UNCHANGED <<phase, published, recorded, snapshot, complete, runProof, separate, live, deferred>>
Rollback == /\ phase = "idle" /\ snapshot
            /\ phase' = "rolled_back" /\ published' = 0 /\ recorded' = 0
            /\ legacy' = TRUE /\ complete' = FALSE /\ runProof' = FALSE
            /\ separate' = FALSE /\ deferred' \in BOOLEAN
            /\ UNCHANGED <<snapshot, live>>

Next == Prepare \/ Publish \/ Record \/ Crash \/ Resume \/ Finish \/ RequestRepair \/ SuccessfulRun
        \/ DamageBackup \/ RequestCleanup \/ RemoveLegacy \/ RefuseCleanup
        \/ UnsafeRemoveDuringApply \/ Rollback
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"preview", "apply", "idle", "cleanup", "rolled_back"}
          /\ published \in 0..Steps /\ recorded \in 0..Steps
          /\ snapshot \in BOOLEAN /\ legacy \in BOOLEAN /\ complete \in BOOLEAN
          /\ runProof \in BOOLEAN /\ separate \in BOOLEAN /\ live \in BOOLEAN
          /\ deferred \in BOOLEAN
NoSameRunCleanup == ~legacy => separate
NoLostOriginal == legacy \/ snapshot
LiveInputsRetained == live => legacy
ReceiptsFollowPublication == recorded <= published
CompleteHasAllSteps == complete => recorded = Steps
FreshRunProof == runProof => complete
=============================================================================
