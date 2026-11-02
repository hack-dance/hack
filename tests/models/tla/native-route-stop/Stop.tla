----------------------------- MODULE Stop -----------------------------
EXTENDS Naturals, TLC
CONSTANTS EnforceOrder, EnforceAbsence, EnforceSelection, EnforceHooks
VARIABLES generation, claimHeld, workloadPresent, routePresent, hookPending,
          phase, version, selected, absenceObserved, crashes, unsafeRelease
vars == <<generation, claimHeld, workloadPresent, routePresent, hookPending,
          phase, version, selected, absenceObserved, crashes, unsafeRelease>>

\* One uncertain routed startup, including an optional unresolved host-hook intent.
\* Its immutable generation and cooperative route reference remain available.
Init == /\ generation = "pending-up" /\ claimHeld = TRUE
        /\ workloadPresent = TRUE /\ routePresent = TRUE
        /\ hookPending \in BOOLEAN /\ phase = "interrupted"
        /\ version = 1 /\ selected = 0 /\ absenceObserved = FALSE
        /\ crashes = 0 /\ unsafeRelease = FALSE

\* Recover validates the dead mutation owner and reacquires its instance lock.
\* The pending down intent is durable before any container removal.
Recover == /\ phase = "interrupted" /\ generation # "stopped"
           /\ generation' = "pending-down" /\ phase' = "stopping"
           /\ selected' = 0 /\ absenceObserved' = FALSE
           /\ UNCHANGED <<claimHeld, workloadPresent, routePresent, hookPending,
                           version, crashes, unsafeRelease>>
StopWorkload == /\ phase = "stopping" /\ workloadPresent
                /\ workloadPresent' = FALSE
                /\ UNCHANGED <<generation, claimHeld, routePresent, hookPending,
                                phase, version, selected, absenceObserved,
                                crashes, unsafeRelease>>
\* Caddy convergence is a separate step; container absence is not route absence.
ConvergeProxy == /\ ~workloadPresent /\ routePresent
                 /\ routePresent' = FALSE
                 /\ UNCHANGED <<generation, claimHeld, workloadPresent, hookPending,
                                 phase, version, selected, absenceObserved,
                                 crashes, unsafeRelease>>
Observe == /\ phase = "stopping"
           /\ phase' = "observed" /\ selected' = version
           /\ absenceObserved' = (~workloadPresent /\ ~routePresent)
           /\ UNCHANGED <<generation, claimHeld, workloadPresent, routePresent,
                           hookPending, version, crashes, unsafeRelease>>
\* A replaced reference between selection and claims exclusion must refuse.
ReplaceReference == /\ phase = "observed" /\ version = 1
                    /\ version' = 2
                    /\ UNCHANGED <<generation, claimHeld, workloadPresent,
                                    routePresent, hookPending, phase, selected,
                                    absenceObserved, crashes, unsafeRelease>>
AcquireClaims == /\ phase = "observed" /\ phase' = "leased"
                 /\ UNCHANGED <<generation, claimHeld, workloadPresent,
                                 routePresent, hookPending, version, selected,
                                 absenceObserved, crashes, unsafeRelease>>
ReleaseSafe == absenceObserved /\ selected = version /\ ~hookPending
RetireClaims == /\ phase = "leased" /\ claimHeld
                /\ (EnforceAbsence => absenceObserved)
                /\ (EnforceSelection => selected = version)
                /\ (EnforceHooks => ~hookPending)
                /\ claimHeld' = FALSE /\ phase' = "released"
                /\ unsafeRelease' = ~ReleaseSafe
                /\ UNCHANGED <<generation, workloadPresent, routePresent,
                                hookPending, version, selected, absenceObserved,
                                crashes>>
\* Failed proofs preserve both stores and allow a fresh explicit retry.
Refuse == /\ phase = "leased" /\ ~ReleaseSafe
          /\ phase' = "interrupted"
          /\ UNCHANGED <<generation, claimHeld, workloadPresent, routePresent,
                          hookPending, version, selected, absenceObserved,
                          crashes, unsafeRelease>>
CommitStop == /\ generation = "pending-down" /\ ~workloadPresent
              /\ phase \in {"stopping", "observed", "leased", "released"}
              /\ (EnforceOrder => ~claimHeld)
              /\ generation' = "stopped" /\ phase' = "complete"
              /\ UNCHANGED <<claimHeld, workloadPresent, routePresent, hookPending,
                              version, selected, absenceObserved, crashes,
                              unsafeRelease>>
\* Crash may occur between any two durable/effect steps, including retirement
\* and generation completion. It loses locks, never the saved generation/reference.
Crash == /\ phase \in {"stopping", "observed", "leased", "released"}
         /\ crashes = 0 /\ crashes' = 1 /\ phase' = "interrupted"
         /\ UNCHANGED <<generation, claimHeld, workloadPresent, routePresent,
                         hookPending, version, selected, absenceObserved,
                         unsafeRelease>>
Next == Recover \/ StopWorkload \/ ConvergeProxy \/ Observe \/ ReplaceReference
        \/ AcquireClaims \/ RetireClaims \/ Refuse \/ CommitStop \/ Crash
Spec == Init /\ [][Next]_vars
TypeOK == /\ generation \in {"pending-up", "pending-down", "stopped"}
          /\ claimHeld \in BOOLEAN /\ workloadPresent \in BOOLEAN
          /\ routePresent \in BOOLEAN /\ hookPending \in BOOLEAN
          /\ phase \in {"interrupted", "stopping", "observed", "leased",
                         "released", "complete"}
          /\ version \in 1..2 /\ selected \in 0..2
          /\ absenceObserved \in BOOLEAN /\ crashes \in 0..1
          /\ unsafeRelease \in BOOLEAN
NoLostRecovery == generation = "stopped" => ~claimHeld
NoUnprovedRelease == ~unsafeRelease
NeverComplete == generation # "stopped"
=======================================================================
