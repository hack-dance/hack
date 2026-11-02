--------------------------- MODULE MissingLock ---------------------------
EXTENDS Naturals, TLC
CONSTANTS GuardOrdinary, GuardRetired, GuardCompletionProof,
          GuardCompletionLock, AllowOldHolder
VARIABLES stage, gate, repair, held, lockPath, selected, version,
          eligible, crashed, consumer, legacyPublished,
          unsafeAdmission, unsafeCompletion
vars == <<stage, gate, repair, held, lockPath, selected, version,
          eligible, crashed, consumer, legacyPublished,
          unsafeAdmission, unsafeCompletion>>
Stages == {"absent", "intent", "temp", "linked", "final", "journal",
           "socket", "owner", "complete"}
SelectedProof == eligible /\ selected = version /\ selected # 0
ReplacementHeld == held /\ lockPath = "replacement"
BothOriginalsAbsent == stage \in {"owner", "complete"}
IncompleteIntent == stage # "absent" /\ stage # "complete"
Init == /\ stage = "absent" /\ gate = FALSE /\ repair = "idle"
        /\ held = FALSE /\ lockPath = "missing"
        /\ selected = 0 /\ version = 1 /\ eligible \in BOOLEAN
        /\ crashed = FALSE /\ consumer = "none"
        /\ legacyPublished = FALSE /\ unsafeAdmission = FALSE
        /\ unsafeCompletion = FALSE
Begin == /\ repair = "idle" /\ ~gate /\ eligible
         /\ gate' = TRUE /\ repair' = "active"
         /\ UNCHANGED <<stage, held, lockPath, selected, version, eligible,
                        crashed, consumer, legacyPublished, unsafeAdmission,
                        unsafeCompletion>>
\* The exact selected proof and nonce are durable before any lock-path effect.
WriteIntent == /\ repair = "active" /\ gate /\ stage = "absent"
               /\ eligible /\ stage' = "intent" /\ selected' = version
               /\ UNCHANGED <<gate, repair, held, lockPath, version, eligible,
                              crashed, consumer, legacyPublished,
                              unsafeAdmission, unsafeCompletion>>
CreateTemp == /\ repair = "active" /\ gate /\ stage = "intent"
              /\ SelectedProof /\ stage' = "temp"
              /\ UNCHANGED <<gate, repair, held, lockPath, selected, version,
                             eligible, crashed, consumer, legacyPublished,
                             unsafeAdmission, unsafeCompletion>>
AcquireTemp == /\ repair = "active" /\ gate /\ stage = "temp" /\ ~held
               /\ held' = TRUE
               /\ UNCHANGED <<stage, gate, repair, lockPath, selected, version,
                              eligible, crashed, consumer, legacyPublished,
                              unsafeAdmission, unsafeCompletion>>
LinkLock == /\ repair = "active" /\ gate /\ stage = "temp" /\ held
            /\ lockPath = "missing" /\ SelectedProof
            /\ stage' = "linked" /\ lockPath' = "replacement"
            /\ UNCHANGED <<gate, repair, held, selected, version, eligible,
                           crashed, consumer, legacyPublished, unsafeAdmission,
                           unsafeCompletion>>
RemoveTemp == /\ repair = "active" /\ gate /\ stage = "linked"
              /\ ReplacementHeld /\ SelectedProof
              /\ stage' = "final"
              /\ UNCHANGED <<gate, repair, held, lockPath, selected, version,
                             eligible, crashed, consumer, legacyPublished,
                             unsafeAdmission, unsafeCompletion>>
AcquireReplacement == /\ repair = "active" /\ gate /\ ~held
                      /\ stage \in {"linked", "final", "journal", "socket", "owner"}
                      /\ (lockPath = "replacement" \/ ~GuardCompletionLock)
                      /\ held' = TRUE
                      /\ UNCHANGED <<stage, gate, repair, lockPath, selected,
                                     version, eligible, crashed, consumer,
                                     legacyPublished, unsafeAdmission,
                                     unsafeCompletion>>
StartJournal == /\ repair = "active" /\ gate /\ stage = "final"
                /\ ReplacementHeld /\ SelectedProof
                /\ stage' = "journal"
                /\ UNCHANGED <<gate, repair, held, lockPath, selected, version,
                               eligible, crashed, consumer, legacyPublished,
                               unsafeAdmission, unsafeCompletion>>
ArchiveSocket == /\ repair = "active" /\ gate /\ stage = "journal"
                 /\ ReplacementHeld /\ SelectedProof
                 /\ stage' = "socket"
                 /\ UNCHANGED <<gate, repair, held, lockPath, selected, version,
                                eligible, crashed, consumer, legacyPublished,
                                unsafeAdmission, unsafeCompletion>>
ArchiveOwner == /\ repair = "active" /\ gate /\ stage = "socket"
                /\ ReplacementHeld /\ SelectedProof
                /\ stage' = "owner"
                /\ UNCHANGED <<gate, repair, held, lockPath, selected, version,
                               eligible, crashed, consumer, legacyPublished,
                               unsafeAdmission, unsafeCompletion>>
\* The standard retirement journal and both archived exact identities precede completion.
Commit == /\ repair = "active" /\ gate /\ stage = "owner" /\ held
          /\ (GuardCompletionProof => SelectedProof)
          /\ (GuardCompletionLock => lockPath = "replacement")
          /\ stage' = "complete" /\ gate' = FALSE /\ repair' = "done"
          /\ held' = FALSE
          /\ unsafeCompletion' = (~SelectedProof \/ lockPath # "replacement")
          /\ UNCHANGED <<lockPath, selected, version, eligible, crashed,
                         consumer, legacyPublished, unsafeAdmission>>
\* A crash drops process locks, not the intent, temp/link, journal or archive bytes.
Crash == /\ repair = "active" /\ ~crashed
         /\ repair' = "crashed" /\ gate' = FALSE /\ held' = FALSE
         /\ crashed' = TRUE
         /\ UNCHANGED <<stage, lockPath, selected, version, eligible, consumer,
                        legacyPublished, unsafeAdmission, unsafeCompletion>>
Resume == /\ repair = "crashed" /\ ~gate /\ IncompleteIntent
          /\ repair' = "active" /\ gate' = TRUE
          /\ UNCHANGED <<stage, held, lockPath, selected, version, eligible,
                         crashed, consumer, legacyPublished, unsafeAdmission,
                         unsafeCompletion>>
ChangeInputs == /\ repair = "crashed" /\ version = 1
                /\ version' = 2
                /\ UNCHANGED <<stage, gate, repair, held, lockPath, selected,
                               eligible, crashed, consumer, legacyPublished,
                               unsafeAdmission, unsafeCompletion>>
ReplacePath == /\ repair = "crashed" /\ lockPath = "replacement"
               /\ lockPath' = "foreign"
               /\ UNCHANGED <<stage, gate, repair, held, selected, version,
                              eligible, crashed, consumer, legacyPublished,
                              unsafeAdmission, unsafeCompletion>>
Refuse == /\ repair = "active" /\ gate /\ IncompleteIntent
          /\ (~SelectedProof \/ lockPath = "foreign")
          /\ repair' = "refused" /\ gate' = FALSE /\ held' = FALSE
          /\ UNCHANGED <<stage, lockPath, selected, version, eligible, crashed,
                         consumer, legacyPublished, unsafeAdmission,
                         unsafeCompletion>>
\* Consumers may see both originals absent after the second rename, before commit.
AdmitOrdinary == /\ consumer = "none" /\ ~gate /\ BothOriginalsAbsent
                 /\ (GuardOrdinary => ~IncompleteIntent)
                 /\ consumer' = "ordinary"
                 /\ unsafeAdmission' = IncompleteIntent
                 /\ UNCHANGED <<stage, gate, repair, held, lockPath, selected,
                                version, eligible, crashed, legacyPublished,
                                unsafeCompletion>>
AdmitRetired == /\ consumer = "none" /\ ~gate /\ BothOriginalsAbsent
                /\ (GuardRetired => ~IncompleteIntent)
                /\ consumer' = "retired"
                /\ unsafeAdmission' = IncompleteIntent
                /\ UNCHANGED <<stage, gate, repair, held, lockPath, selected,
                               version, eligible, crashed, legacyPublished,
                               unsafeCompletion>>
\* A pre-gate binary can hold an old unlinked lock inode and ignore this gate.
\* The maintained protocol excludes that binary through external quiescence.
OldHolderPublish == /\ AllowOldHolder /\ gate /\ IncompleteIntent
                    /\ ~legacyPublished /\ legacyPublished' = TRUE
                    /\ UNCHANGED <<stage, gate, repair, held, lockPath,
                                   selected, version, eligible, crashed,
                                   consumer, unsafeAdmission, unsafeCompletion>>
Next == Begin \/ WriteIntent \/ CreateTemp \/ AcquireTemp \/ LinkLock
        \/ RemoveTemp \/ AcquireReplacement \/ StartJournal \/ ArchiveSocket
        \/ ArchiveOwner \/ Commit \/ Crash \/ Resume \/ ChangeInputs
        \/ ReplacePath \/ Refuse \/ AdmitOrdinary \/ AdmitRetired
        \/ OldHolderPublish
Spec == Init /\ [][Next]_vars
TypeOK == /\ stage \in Stages /\ gate \in BOOLEAN
          /\ repair \in {"idle", "active", "crashed", "done", "refused"}
          /\ held \in BOOLEAN /\ lockPath \in {"missing", "replacement", "foreign"}
          /\ selected \in 0..2 /\ version \in 1..2 /\ eligible \in BOOLEAN
          /\ crashed \in BOOLEAN
          /\ consumer \in {"none", "ordinary", "retired"}
          /\ legacyPublished \in BOOLEAN /\ unsafeAdmission \in BOOLEAN
          /\ unsafeCompletion \in BOOLEAN
NoPrematureConsumer == ~unsafeAdmission
NoUnprovedCompletion == ~unsafeCompletion
NoUncoordinatedLegacy == ~legacyPublished
NeverComplete == stage # "complete"
=============================================================================
