-------------------------- MODULE Enrollment --------------------------
EXTENDS Naturals
CONSTANTS EnforceExclusiveCreate, EnforceOriginalCommit,
          EnforcePendingRead, KeepData
VARIABLES phase, record, volume, captured, alive, returned, matched, run,
          unsafeAdoption, unsafeCommit, unsafeRead, unsafeRetirement
vars == <<phase, record, volume, captured, alive, returned, matched, run,
          unsafeAdoption, unsafeCommit, unsafeRead, unsafeRetirement>>

Init == /\ phase = "idle" /\ record = "none"
        /\ volume \in {0, 2} /\ captured = 0 /\ alive = TRUE
        /\ returned = FALSE /\ matched = FALSE /\ run = 1
        /\ unsafeAdoption = FALSE /\ unsafeCommit = FALSE
        /\ unsafeRead = FALSE /\ unsafeRetirement = FALSE
ReserveIntent == /\ phase = "idle" /\ alive
                 /\ phase' = "pending" /\ record' = "pending"
                 /\ UNCHANGED <<volume, captured, alive, returned, matched, run,
                       unsafeAdoption, unsafeCommit, unsafeRead, unsafeRetirement>>
CreateOriginal == /\ phase = "pending" /\ alive
                  /\ (~EnforceExclusiveCreate \/ volume = 0)
                  /\ volume' = (IF volume = 0 THEN 1 ELSE volume)
                  /\ phase' = "created"
                  /\ unsafeAdoption' = (volume # 0)
                  /\ UNCHANGED <<record, captured, alive, returned, matched, run,
                        unsafeCommit, unsafeRead, unsafeRetirement>>
CaptureBirth == /\ phase = "created" /\ alive
                /\ captured' = volume /\ phase' = "captured"
                /\ UNCHANGED <<record, volume, alive, returned, matched, run,
                      unsafeAdoption, unsafeCommit, unsafeRead, unsafeRetirement>>
ReplaceVolume == /\ phase \in {"created", "captured", "done", "crashed"}
                 /\ volume = 1 /\ volume' = 2
                 /\ UNCHANGED <<phase, record, captured, alive, returned, matched, run,
                       unsafeAdoption, unsafeCommit, unsafeRead, unsafeRetirement>>
PublishEnrollment == /\ phase = "captured" /\ alive
                     /\ (~EnforceOriginalCommit \/ (captured = 1 /\ volume = captured))
                     /\ phase' = "published" /\ record' = "enrolled"
                     /\ unsafeCommit' = (captured # 1 \/ volume # captured)
                     /\ UNCHANGED <<volume, captured, alive, returned, matched, run,
                           unsafeAdoption, unsafeRead, unsafeRetirement>>
ConfirmDirectorySync == /\ phase = "published" /\ alive
                        /\ phase' = "done" /\ returned' = TRUE
                        /\ UNCHANGED <<record, volume, captured, alive, matched, run,
                              unsafeAdoption, unsafeCommit, unsafeRead, unsafeRetirement>>
CrashOrFailure == /\ phase \in {"pending", "created", "captured", "published"}
                  /\ alive /\ alive' = FALSE /\ phase' = "crashed"
                  /\ UNCHANGED <<record, volume, captured, returned, matched, run,
                        unsafeAdoption, unsafeCommit, unsafeRead, unsafeRetirement>>
ReadRetained == /\ phase \in {"done", "crashed"} /\ ~matched
               /\ (IF EnforcePendingRead
                     THEN record = "enrolled" /\ captured > 0 /\ volume = captured
                     ELSE record # "none" /\ volume > 0)
               /\ matched' = TRUE /\ unsafeRead' = (record # "enrolled")
               /\ UNCHANGED <<phase, record, volume, captured, alive, returned, run,
                     unsafeAdoption, unsafeCommit, unsafeRetirement>>
RetireCompute == /\ phase \in {"done", "crashed"} /\ run = 1
                 /\ run' = 2 /\ volume' = (IF KeepData THEN volume ELSE 0)
                 /\ unsafeRetirement' = (~KeepData /\ volume > 0)
                 /\ UNCHANGED <<phase, record, captured, alive, returned, matched,
                       unsafeAdoption, unsafeCommit, unsafeRead>>
Next == ReserveIntent \/ CreateOriginal \/ CaptureBirth \/ ReplaceVolume \/
        PublishEnrollment \/ ConfirmDirectorySync \/ CrashOrFailure \/
        ReadRetained \/ RetireCompute
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"idle", "pending", "created", "captured", "published", "done", "crashed"}
          /\ record \in {"none", "pending", "enrolled"}
          /\ volume \in 0..2 /\ captured \in 0..2 /\ run \in 1..2
          /\ alive \in BOOLEAN /\ returned \in BOOLEAN /\ matched \in BOOLEAN
          /\ unsafeAdoption \in BOOLEAN /\ unsafeCommit \in BOOLEAN
          /\ unsafeRead \in BOOLEAN /\ unsafeRetirement \in BOOLEAN
NoExistingAdoption == ~unsafeAdoption
OriginalBirthAtCommit == ~unsafeCommit
NoPendingMatch == ~unsafeRead
RetirementPreservesData == ~unsafeRetirement
NoUnconfirmedReturn == returned => record = "enrolled" /\ phase = "done"
=============================================================================
