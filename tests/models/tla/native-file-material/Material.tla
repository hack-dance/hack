--------------------------- MODULE Material ---------------------------
EXTENDS Naturals, TLC, FiniteSets
CONSTANTS EnforceOrder, EnforceAbsence, EnforceSelection, EnforceHooks,
          EnforceChild, EnforceFinalCheck, EnforceIntent,
          AllowOwnerDrift, AllowPendingDrift, AllowAnchorDrift
Members == {1, 2}
VARIABLES generation, recoveryReference, members, retirement, phase,
          containerPresent, hookPending, childPending, stopChild, sourceFresh,
          anchorVersion, ownerVersion, pendingVersion, crashes, partialCrash,
          missingWithoutIntent, unsafeDelete, unsafeCommit, unsafeIntent
vars == <<generation, recoveryReference, members, retirement, phase,
          containerPresent, hookPending, childPending, stopChild, sourceFresh,
          anchorVersion, ownerVersion, pendingVersion, crashes, partialCrash,
          missingWithoutIntent, unsafeDelete, unsafeCommit, unsafeIntent>>

\* Owner protocol, starting from one uncertain startup. Its exact
\* generation/reference and two immutable material members are already durable.
\* Unknown hooks/children never become known merely because containers stop.
Init == /\ generation = "pending-up" /\ recoveryReference = TRUE
        /\ members = Members /\ retirement = "live" /\ phase = "interrupted"
        /\ containerPresent = TRUE /\ hookPending \in BOOLEAN
        /\ childPending \in BOOLEAN /\ stopChild = "idle" /\ sourceFresh \in BOOLEAN
        /\ anchorVersion = 1 /\ ownerVersion = 1 /\ pendingVersion = 1
        /\ crashes = 0 /\ partialCrash = FALSE /\ missingWithoutIntent = FALSE
        /\ unsafeDelete = FALSE /\ unsafeCommit = FALSE /\ unsafeIntent = FALSE

SelectionSafe == anchorVersion = 1 /\ ownerVersion = 1 /\ pendingVersion = 1
RetirementSafe == SelectionSafe /\ ~containerPresent /\ ~hookPending /\ ~childPending /\ stopChild = "reaped"
GuardedRetirement == /\ (EnforceAbsence => ~containerPresent)
                     /\ (EnforceSelection => SelectionSafe)
                     /\ (EnforceHooks => ~hookPending)
                     /\ (EnforceChild => (~childPending /\ stopChild = "reaped"))
Active == phase \in {"stopping", "observed", "retiring", "finalizing"}

\* Recover validates the saved generation and reacquires the mutation lease.
\* No authored source or decryption is required by stop recovery.
Recover == /\ phase = "interrupted" /\ recoveryReference
           /\ generation' = "pending-down" /\ phase' = "stopping"
           /\ UNCHANGED <<recoveryReference, members, retirement, containerPresent,
                          hookPending, childPending, stopChild, sourceFresh, anchorVersion,
                          ownerVersion, pendingVersion, crashes, partialCrash,
                          missingWithoutIntent, unsafeDelete, unsafeCommit, unsafeIntent>>
\* A new stop arms durably before its engine child. Only that live attempt can
\* reap; crash while armed persists unknown across every subsequent recovery.
ArmStop == /\ phase = "stopping" /\ stopChild \in {"idle", "reaped"}
           /\ stopChild' = "armed"
           /\ UNCHANGED <<generation, recoveryReference, members, retirement, phase,
                          containerPresent, hookPending, childPending, sourceFresh,
                          anchorVersion, ownerVersion, pendingVersion, crashes,
                          partialCrash, missingWithoutIntent, unsafeDelete,
                          unsafeCommit, unsafeIntent>>
ReapStop == /\ phase = "stopping" /\ stopChild = "armed"
            /\ stopChild' = "reaped"
            /\ UNCHANGED <<generation, recoveryReference, members, retirement, phase,
                           containerPresent, hookPending, childPending, sourceFresh,
                           anchorVersion, ownerVersion, pendingVersion, crashes,
                           partialCrash, missingWithoutIntent, unsafeDelete,
                           unsafeCommit, unsafeIntent>>
StopContainers == /\ phase = "stopping" /\ containerPresent
                  /\ stopChild \in {"armed", "unknown"}
                  /\ containerPresent' = FALSE
                  /\ UNCHANGED <<generation, recoveryReference, members, retirement,
                                 phase, hookPending, childPending, stopChild, sourceFresh,
                                 anchorVersion, ownerVersion, pendingVersion, crashes,
                                 partialCrash, missingWithoutIntent, unsafeDelete,
                                 unsafeCommit, unsafeIntent>>
Observe == /\ phase = "stopping" /\ stopChild \in {"reaped", "unknown"}
           /\ phase' = "observed"
           /\ UNCHANGED <<generation, recoveryReference, members, retirement,
                          containerPresent, hookPending, childPending, stopChild, sourceFresh,
                          anchorVersion, ownerVersion, pendingVersion, crashes,
                          partialCrash, missingWithoutIntent, unsafeDelete,
                          unsafeCommit, unsafeIntent>>

\* Persist exact member/inode retirement authority before the first unlink.
\* Existing intent survives retry; missing live material cannot create authority.
BeginRetirement == /\ phase = "observed" /\ retirement \in {"live", "intent"}
                   /\ GuardedRetirement
                   /\ (EnforceIntent => ~missingWithoutIntent)
                   /\ retirement' = "intent" /\ phase' = "retiring"
                   /\ unsafeIntent' = (unsafeIntent \/ missingWithoutIntent)
                   /\ UNCHANGED <<generation, recoveryReference, members,
                                  containerPresent, hookPending, childPending, stopChild,
                                  sourceFresh, anchorVersion, ownerVersion,
                                  pendingVersion, crashes, partialCrash,
                                  missingWithoutIntent, unsafeDelete, unsafeCommit>>
DeleteMember(member) == /\ phase = "retiring" /\ retirement = "intent"
                       /\ member \in members /\ GuardedRetirement
                       /\ members' = members \ {member}
                       /\ unsafeDelete' = (unsafeDelete \/ ~RetirementSafe)
                       /\ UNCHANGED <<generation, recoveryReference, retirement,
                                      phase, containerPresent, hookPending,
                                      childPending, stopChild, sourceFresh, anchorVersion,
                                      ownerVersion, pendingVersion, crashes,
                                      partialCrash, missingWithoutIntent,
                                      unsafeCommit, unsafeIntent>>
MarkRetired == /\ phase = "retiring" /\ retirement = "intent" /\ members = {}
               /\ GuardedRetirement
               /\ retirement' = "retired" /\ phase' = "finalizing"
               /\ UNCHANGED <<generation, recoveryReference, members,
                              containerPresent, hookPending, childPending, stopChild, sourceFresh,
                              anchorVersion, ownerVersion, pendingVersion, crashes,
                              partialCrash, missingWithoutIntent, unsafeDelete,
                              unsafeCommit, unsafeIntent>>
ResumeRetired == /\ phase = "observed" /\ retirement = "retired"
                 /\ RetirementSafe /\ phase' = "finalizing"
                 /\ UNCHANGED <<generation, recoveryReference, members, retirement,
                                containerPresent, hookPending, childPending, stopChild,
                                sourceFresh, anchorVersion, ownerVersion,
                                pendingVersion, crashes, partialCrash,
                                missingWithoutIntent, unsafeDelete, unsafeCommit,
                                unsafeIntent>>

\* Finalizer return is not completion authority: recheck exact pending/owner/root.
CommitSafe == RetirementSafe /\ retirement = "retired" /\ members = {}
CommitStop == /\ generation = "pending-down" /\ Active /\ ~containerPresent
              /\ (EnforceOrder => (retirement = "retired" /\ members = {}))
              /\ (EnforceFinalCheck => RetirementSafe)
              /\ generation' = "stopped" /\ recoveryReference' = FALSE
              /\ phase' = "complete" /\ unsafeCommit' = ~CommitSafe
              /\ UNCHANGED <<members, retirement, containerPresent, hookPending,
                             childPending, stopChild, sourceFresh, anchorVersion, ownerVersion,
                             pendingVersion, crashes, partialCrash, missingWithoutIntent,
                             unsafeDelete, unsafeIntent>>
Refuse == /\ Active /\ (~RetirementSafe \/ missingWithoutIntent) /\ phase' = "interrupted"
          /\ UNCHANGED <<generation, recoveryReference, members, retirement,
                         containerPresent, hookPending, childPending, stopChild, sourceFresh,
                         anchorVersion, ownerVersion, pendingVersion, crashes,
                         partialCrash, missingWithoutIntent, unsafeDelete,
                         unsafeCommit, unsafeIntent>>
Crash == /\ Active /\ crashes = 0 /\ crashes' = 1 /\ phase' = "interrupted"
         /\ stopChild' = IF stopChild = "armed" THEN "unknown" ELSE stopChild
         /\ partialCrash' = (partialCrash \/ (retirement = "intent" /\
                                             members # {} /\ members # Members))
         /\ UNCHANGED <<generation, recoveryReference, members, retirement,
                        containerPresent, hookPending, childPending, sourceFresh,
                        anchorVersion, ownerVersion, pendingVersion, missingWithoutIntent,
                        unsafeDelete, unsafeCommit, unsafeIntent>>

\* Independent external changes across awaits cannot be adopted by a saved token.
DriftAnchor == /\ AllowAnchorDrift /\ Active /\ anchorVersion = 1
               /\ anchorVersion' = 2
               /\ UNCHANGED <<generation, recoveryReference, members, retirement, phase,
                              containerPresent, hookPending, childPending, stopChild, sourceFresh,
                              ownerVersion, pendingVersion, crashes, partialCrash,
                              missingWithoutIntent, unsafeDelete, unsafeCommit, unsafeIntent>>
DriftOwner == /\ AllowOwnerDrift /\ Active /\ ownerVersion = 1
              /\ ownerVersion' = 2
              /\ UNCHANGED <<generation, recoveryReference, members, retirement, phase,
                             containerPresent, hookPending, childPending, stopChild, sourceFresh,
                             anchorVersion, pendingVersion, crashes, partialCrash,
                             missingWithoutIntent, unsafeDelete, unsafeCommit, unsafeIntent>>
DriftPending == /\ AllowPendingDrift /\ Active /\ pendingVersion = 1
                /\ pendingVersion' = 2
                /\ UNCHANGED <<generation, recoveryReference, members, retirement, phase,
                               containerPresent, hookPending, childPending, stopChild, sourceFresh,
                               anchorVersion, ownerVersion, crashes, partialCrash,
                               missingWithoutIntent, unsafeDelete, unsafeCommit, unsafeIntent>>
DisappearMember(member) == /\ phase = "observed" /\ retirement = "live"
                           /\ member \in members /\ members' = members \ {member}
                           /\ missingWithoutIntent' = TRUE
                           /\ UNCHANGED <<generation, recoveryReference, retirement, phase,
                                          containerPresent, hookPending, childPending, stopChild,
                                          sourceFresh, anchorVersion, ownerVersion,
                                          pendingVersion, crashes, partialCrash,
                                          unsafeDelete, unsafeCommit, unsafeIntent>>
Next == Recover \/ ArmStop \/ ReapStop \/ StopContainers \/ Observe \/ BeginRetirement
        \/ (\E member \in Members: DeleteMember(member)) \/ MarkRetired \/ ResumeRetired
        \/ CommitStop \/ Refuse \/ Crash \/ DriftAnchor \/ DriftOwner \/ DriftPending
        \/ (\E member \in Members: DisappearMember(member))
Spec == Init /\ [][Next]_vars
\* Dedicated stop-child guard control keeps the startup child and hooks known.
StopChildSpec == (Init /\ ~childPending /\ ~hookPending) /\ [][Next]_vars
TypeOK == /\ generation \in {"pending-up", "pending-down", "stopped"}
          /\ members \subseteq Members /\ retirement \in {"live", "intent", "retired"}
          /\ phase \in {"interrupted", "stopping", "observed", "retiring", "finalizing", "complete"}
          /\ anchorVersion \in 1..2 /\ ownerVersion \in 1..2 /\ pendingVersion \in 1..2
          /\ stopChild \in {"idle", "armed", "reaped", "unknown"}
          /\ crashes \in 0..1
          /\ \A value \in {recoveryReference, containerPresent, hookPending, childPending,
                            sourceFresh, partialCrash, missingWithoutIntent, unsafeDelete,
                            unsafeCommit, unsafeIntent}: value \in BOOLEAN
NoLostRecovery == ~recoveryReference => (members = {} /\ retirement = "retired")
NoUnprovedDeletion == ~unsafeDelete
NoStaleCompletion == ~unsafeCommit
NoInferredIntent == ~unsafeIntent
NeverCompleteAfterPartialCrash == ~partialCrash \/ generation # "stopped"
NeverCompleteWithoutSource == sourceFresh \/ generation # "stopped"
=======================================================================
