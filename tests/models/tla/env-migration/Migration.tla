----------------------------- MODULE Migration -----------------------------
EXTENDS Naturals, TLC
CONSTANTS Steps, UnsafeCleanup
VARIABLES phase, published, recorded, snapshot, legacy, complete, runProof,
          separate, live
vars == <<phase, published, recorded, snapshot, legacy, complete, runProof,
          separate, live>>

Init == /\ phase = "preview" /\ published = 0 /\ recorded = 0
        /\ snapshot = FALSE /\ legacy = TRUE /\ complete = FALSE
        /\ runProof = FALSE /\ separate = FALSE /\ live \in BOOLEAN

Prepare == /\ phase \in {"preview", "rolled_back"}
           /\ phase' = "apply" /\ snapshot' = TRUE
           /\ UNCHANGED <<published, recorded, legacy, complete, runProof, separate, live>>
Publish == /\ phase = "apply" /\ published = recorded /\ published < Steps
           /\ published' = published + 1
           /\ UNCHANGED <<phase, recorded, snapshot, legacy, complete, runProof, separate, live>>
Record == /\ phase = "apply" /\ recorded < published
          /\ recorded' = published
          /\ UNCHANGED <<phase, published, snapshot, legacy, complete, runProof, separate, live>>
Crash == /\ phase = "apply" /\ phase' = "idle"
         /\ UNCHANGED <<published, recorded, snapshot, legacy, complete, runProof, separate, live>>
Resume == /\ phase = "idle" /\ ~complete /\ snapshot /\ phase' = "apply"
          /\ UNCHANGED <<published, recorded, snapshot, legacy, complete, runProof, separate, live>>
Finish == /\ phase = "apply" /\ recorded = Steps
          /\ complete' = TRUE /\ phase' = "idle"
          /\ UNCHANGED <<published, recorded, snapshot, legacy, runProof, separate, live>>
SuccessfulRun == /\ phase = "idle" /\ complete /\ ~runProof
                 /\ runProof' = TRUE
                 /\ UNCHANGED <<phase, published, recorded, snapshot, legacy, complete, separate, live>>
DamageBackup == /\ phase = "idle" /\ complete /\ legacy /\ snapshot
                /\ snapshot' = FALSE
                /\ UNCHANGED <<phase, published, recorded, legacy, complete, runProof, separate, live>>
RequestCleanup == /\ phase = "idle" /\ complete /\ runProof /\ snapshot /\ ~live
                  /\ phase' = "cleanup" /\ separate' = TRUE
                  /\ UNCHANGED <<published, recorded, snapshot, legacy, complete, runProof, live>>
RemoveLegacy == /\ phase = "cleanup" /\ snapshot /\ runProof /\ ~live
                /\ legacy' = FALSE /\ phase' = "idle"
                /\ UNCHANGED <<published, recorded, snapshot, complete, runProof, separate, live>>
UnsafeRemoveDuringApply == /\ UnsafeCleanup /\ phase = "apply" /\ legacy /\ published = 0
                           /\ legacy' = FALSE
                           /\ UNCHANGED <<phase, published, recorded, snapshot, complete, runProof, separate, live>>
Rollback == /\ phase = "idle" /\ snapshot
            /\ phase' = "rolled_back" /\ published' = 0 /\ recorded' = 0
            /\ legacy' = TRUE /\ complete' = FALSE /\ runProof' = FALSE
            /\ separate' = FALSE /\ UNCHANGED <<snapshot, live>>

Next == Prepare \/ Publish \/ Record \/ Crash \/ Resume \/ Finish \/ SuccessfulRun
        \/ DamageBackup \/ RequestCleanup \/ RemoveLegacy \/ UnsafeRemoveDuringApply \/ Rollback
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"preview", "apply", "idle", "cleanup", "rolled_back"}
          /\ published \in 0..Steps /\ recorded \in 0..Steps
          /\ snapshot \in BOOLEAN /\ legacy \in BOOLEAN /\ complete \in BOOLEAN
          /\ runProof \in BOOLEAN /\ separate \in BOOLEAN /\ live \in BOOLEAN
NoSameRunCleanup == ~legacy => separate
NoLostOriginal == legacy \/ snapshot
LiveInputsRetained == live => legacy
ReceiptsFollowPublication == recorded <= published
CompleteHasAllSteps == complete => recorded = Steps
=============================================================================
