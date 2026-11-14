------------------------ MODULE LifecycleSupervisor ------------------------
EXTENDS Naturals
CONSTANT SkipLiveFence, SkipOrphanFence, LoseRecoverySnapshot
VARIABLES phase, durable, guard, locked, live, supervisor, attempts,
          identity, unsafeSignal, duplicate, witness, snapshot, orphanKilled
vars == <<phase, durable, guard, locked, live, supervisor, attempts,
          identity, unsafeSignal, duplicate, witness, snapshot, orphanKilled>>

Init == /\ phase = "Absent"
        /\ durable = FALSE /\ guard = FALSE /\ locked = FALSE
        /\ live = FALSE /\ supervisor = FALSE /\ attempts = 0
        /\ identity = "match" /\ unsafeSignal = FALSE /\ duplicate = FALSE
        /\ witness = FALSE /\ snapshot = FALSE /\ orphanKilled = FALSE

Reserve == /\ phase \in {"Absent", "Exited"} /\ ~live /\ attempts < 2
           /\ phase' = "Starting" /\ guard' = TRUE /\ locked' = TRUE
           /\ supervisor' = TRUE /\ durable' = FALSE
           /\ attempts' = attempts + 1
           /\ /\ witness' = FALSE /\ snapshot' = FALSE /\ orphanKilled' = FALSE
           /\ UNCHANGED <<live, identity, unsafeSignal, duplicate>>
Publish == /\ phase = "Starting" /\ ~durable
           /\ durable' = TRUE
           /\ UNCHANGED <<phase, guard, locked, live, supervisor, attempts,
                           identity, unsafeSignal, duplicate, witness, snapshot, orphanKilled>>
Spawn == /\ phase = "Starting" /\ durable /\ guard /\ locked
         /\ phase' = "Running" /\ live' = TRUE
         /\ /\ witness' = TRUE
           /\ UNCHANGED <<durable, guard, locked, supervisor, attempts,
                         identity, unsafeSignal, duplicate, snapshot, orphanKilled>>
StartFailure == /\ phase = "Starting"
                /\ phase' = "Exited" /\ guard' = FALSE /\ locked' = FALSE
                /\ supervisor' = FALSE
                /\ UNCHANGED <<durable, live, attempts, identity,
                                unsafeSignal, duplicate, witness, snapshot, orphanKilled>>
SupervisorDeath == /\ supervisor /\ phase = "Running"
                   /\ supervisor' = FALSE /\ phase' = "Recoverable"
                   /\ UNCHANGED <<durable, guard, locked, live, attempts,
                                   identity, unsafeSignal, duplicate, witness, snapshot, orphanKilled>>
GuardDeath == /\ guard /\ live
              /\ guard' = FALSE /\ locked' = FALSE
              /\ phase' = "Orphaned" /\ supervisor' = FALSE
              /\ UNCHANGED <<durable, live, attempts, identity,
                              unsafeSignal, duplicate, witness, snapshot, orphanKilled>>
Retry == /\ ~supervisor /\ live /\ attempts < 2
         /\ SkipLiveFence
         /\ duplicate' = TRUE /\ attempts' = attempts + 1
         /\ UNCHANGED <<phase, durable, guard, locked, live, supervisor,
                         identity, unsafeSignal, witness, snapshot, orphanKilled>>
ReplaceIdentity == /\ identity = "match" /\ durable
                   /\ identity' \in {"foreign", "unknown"}
                   /\ UNCHANGED <<phase, durable, guard, locked, live,
                                   supervisor, attempts, unsafeSignal, duplicate, witness, snapshot, orphanKilled>>
Stop == /\ phase \in {"Running", "Recoverable"}
        /\ guard /\ durable /\ identity = "match"
        /\ phase' = "Stopping"
        /\ unsafeSignal' = (unsafeSignal \/ identity # "match")
        /\ UNCHANGED <<durable, guard, locked, live, supervisor, attempts,
                        identity, duplicate, witness, snapshot, orphanKilled>>
Kill == /\ phase = "Stopping" /\ guard /\ identity = "match"
        /\ phase' = "KillPending"
        /\ unsafeSignal' = (unsafeSignal \/ identity # "match")
        /\ UNCHANGED <<durable, guard, locked, live, supervisor, attempts,
                        identity, duplicate, witness, snapshot, orphanKilled>>
StopUnknown == /\ phase \in {"Stopping", "KillPending"} /\ live
               /\ phase' = "StopUnknown"
               /\ UNCHANGED <<durable, guard, locked, live, supervisor, attempts,
                               identity, unsafeSignal, duplicate, witness, snapshot, orphanKilled>>
ProcessExit == /\ live /\ live' = FALSE
               /\ UNCHANGED <<phase, durable, guard, locked, supervisor, attempts,
                               identity, unsafeSignal, duplicate, witness, snapshot, orphanKilled>>
Reap == /\ ~live /\ phase \notin {"Absent", "Starting", "Exited"}
        /\ phase' = "Exited" /\ guard' = FALSE /\ locked' = FALSE
        /\ supervisor' = FALSE
        /\ UNCHANGED <<durable, live, attempts, identity, unsafeSignal, duplicate, witness, snapshot, orphanKilled>>
\* Environment: after the old session empties, a new leader can take its
\* numeric SID, fork, and exit. The survivor has no old birth witness.
ReuseSessionID == /\ durable /\ ~guard /\ ~live
                  /\ identity = "match"
                  /\ phase \in {"Orphaned", "Exited", "Stopping", "KillPending"}
                  /\ identity' = "sid-reused" /\ live' = TRUE
                  /\ UNCHANGED <<phase, durable, guard, locked, supervisor,
                                  attempts, unsafeSignal, duplicate, witness, snapshot, orphanKilled>>
RecoverOrphan == /\ phase = "Orphaned" /\ ~guard /\ live /\ durable
                 /\ (identity = "match" \/ (SkipOrphanFence /\ identity = "sid-reused"))
                 /\ unsafeSignal' = (unsafeSignal \/ identity # "match")
                 /\ phase' = "Stopping"
                 /\ /\ (witness \/ SkipOrphanFence) /\ snapshot' = TRUE
           /\ UNCHANGED <<durable, guard, locked, live, supervisor,
                                 attempts, identity, duplicate, witness, orphanKilled>>
WitnessExit == /\ phase = "Stopping" /\ ~guard /\ live /\ witness
               /\ witness' = FALSE
               /\ snapshot' = IF LoseRecoverySnapshot THEN FALSE ELSE snapshot
               /\ UNCHANGED <<phase, durable, guard, locked, live, supervisor,
                               attempts, identity, unsafeSignal, duplicate, orphanKilled>>
OrphanKill == /\ phase = "Stopping" /\ ~guard /\ live /\ snapshot
              /\ identity = "match"
              /\ phase' = "KillPending" /\ orphanKilled' = TRUE
              /\ UNCHANGED <<durable, guard, locked, live, supervisor, attempts,
                              identity, unsafeSignal, duplicate, witness, snapshot>>
Next == WitnessExit \/ OrphanKill \/ ReuseSessionID \/ RecoverOrphan \/ Reserve \/ Publish \/ Spawn \/ StartFailure \/ SupervisorDeath
        \/ GuardDeath \/ Retry \/ ReplaceIdentity \/ Stop \/ Kill
        \/ StopUnknown \/ ProcessExit \/ Reap
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"Absent", "Starting", "Running", "Recoverable",
                        "Orphaned", "Stopping", "KillPending", "StopUnknown", "Exited"}
          /\ attempts \in 0..2 /\ identity \in {"match", "foreign", "unknown", "sid-reused"}
          /\ \A b \in {durable, guard, locked, live, supervisor,
                         unsafeSignal, duplicate, witness, snapshot, orphanKilled} : b \in BOOLEAN
DurableBeforeLaunch == live => durable
GuardRetainsLock == guard => locked
NoForeignSignal == ~unsafeSignal
NoDuplicate == ~duplicate
RecoveryAuthorityRetained == (phase \in {"Stopping", "KillPending"} /\ ~guard
                            /\ live /\ identity = "match") => snapshot
OrphanKillEnabled == (phase = "Stopping" /\ ~guard /\ live /\ ~witness
                     /\ identity = "match" /\ snapshot) => ENABLED OrphanKill
=============================================================================
