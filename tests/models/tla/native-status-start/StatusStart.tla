--------------------------- MODULE StatusStart ---------------------------
EXTENDS Naturals, TLC
CONSTANT ReaderTakesLease
VARIABLES stage, lease, reader, failedByReader, failed, services, dead,
          sameIdentity, stopped, secondAdmitted
vars == <<stage, lease, reader, failedByReader, failed, services, dead,
          sameIdentity, stopped, secondAdmitted>>

\* Seven separate acquisitions: pool, relay, graph, probes, reservation,
\* bridge, publisher. The first three already retry acquisition in production.
Init == /\ stage = 1 /\ lease = "free" /\ reader = FALSE
        /\ failedByReader = FALSE /\ failed = FALSE /\ services = FALSE
        /\ dead = FALSE /\ sameIdentity = TRUE /\ stopped = FALSE
        /\ secondAdmitted = FALSE

Read == /\ ~reader /\ (~ReaderTakesLease \/ lease = "free")
        /\ reader' = TRUE
        /\ lease' = IF ReaderTakesLease THEN "reader" ELSE lease
        /\ UNCHANGED <<stage, failedByReader, failed, services, dead,
                        sameIdentity, stopped, secondAdmitted>>
ReadDone == /\ reader /\ reader' = FALSE
            /\ lease' = IF ReaderTakesLease THEN "free" ELSE lease
            /\ UNCHANGED <<stage, failedByReader, failed, services, dead,
                            sameIdentity, stopped, secondAdmitted>>

Acquire == /\ stage <= 7 /\ ~failed /\ lease = "free"
           /\ lease' = "start"
           /\ UNCHANGED <<stage, reader, failedByReader, failed, services,
                           dead, sameIdentity, stopped, secondAdmitted>>
FinishStage == /\ lease = "start" /\ stage <= 7 /\ ~failed
               /\ stage' = stage + 1 /\ lease' = "free"
               /\ services' = (services \/ stage = 3)
               /\ UNCHANGED <<reader, failedByReader, failed, dead,
                               sameIdentity, stopped, secondAdmitted>>
\* These later acquisitions have no retry. This is the baseline counterexample.
ReaderRefusal == /\ stage \in 4..7 /\ ~failed /\ lease = "reader"
                 /\ failed' = TRUE /\ failedByReader' = TRUE
                 /\ UNCHANGED <<stage, lease, reader, services, dead,
                                 sameIdentity, stopped, secondAdmitted>>
OtherFailure == /\ ~failed /\ lease = "free" /\ services
                /\ failed' = TRUE
                /\ UNCHANGED <<stage, lease, reader, failedByReader, services,
                                dead, sameIdentity, stopped, secondAdmitted>>
OwnerExit == /\ failed /\ ~dead /\ dead' = TRUE
             /\ UNCHANGED <<stage, lease, reader, failedByReader, failed,
                             services, sameIdentity, stopped, secondAdmitted>>
IdentityChanges == /\ ~stopped /\ sameIdentity /\ sameIdentity' = FALSE
                   /\ UNCHANGED <<stage, lease, reader, failedByReader, failed,
                                   services, dead, stopped, secondAdmitted>>
\* A new explicit plain down invokes the existing exact-proof recovery.
\* Unknown identity never grants cleanup. No crash/uncertain effect replay modeled.
Down == /\ failed /\ services /\ dead /\ sameIdentity /\ lease = "free"
        /\ services' = FALSE /\ stopped' = TRUE
        /\ UNCHANGED <<stage, lease, reader, failedByReader, failed, dead,
                        sameIdentity, secondAdmitted>>
\* The run's existing foreground/admission claim rejects a second mutation;
\* neither status nor this change grants it a capability.
SecondMutation == /\ ~stopped /\ secondAdmitted' = FALSE
                  /\ UNCHANGED <<stage, lease, reader, failedByReader, failed,
                                  services, dead, sameIdentity, stopped>>
Next == Read \/ ReadDone \/ Acquire \/ FinishStage \/ ReaderRefusal
        \/ OtherFailure \/ OwnerExit \/ IdentityChanges \/ Down \/ SecondMutation
Spec == Init /\ [][Next]_vars
TypeOK == /\ stage \in 1..8 /\ lease \in {"free", "reader", "start"}
          /\ reader \in BOOLEAN /\ failedByReader \in BOOLEAN
          /\ failed \in BOOLEAN /\ services \in BOOLEAN /\ dead \in BOOLEAN
          /\ sameIdentity \in BOOLEAN /\ stopped \in BOOLEAN
          /\ secondAdmitted \in BOOLEAN
ReaderNeverFailsStart == ~failedByReader
\* Assumed unchanged admission policy, not independently checked by this model.
NoSecondMutation == ~secondAdmitted
StopRequiresProof == stopped => dead /\ sameIdentity /\ ~services
=============================================================================
