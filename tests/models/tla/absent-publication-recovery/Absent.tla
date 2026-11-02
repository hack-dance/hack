----------------------------- MODULE Absent -----------------------------
EXTENDS Naturals, TLC
CONSTANTS EnforceIntent, EnforceBarrier, EnforceSelection, EnforceCompletion
VARIABLES foreground, engine, recovery, publisher, intent, progress,
          complete, retired, published, version, selected, crashed,
          unsafeCleanup, unsafePublication, unsafeRetirement
durable == <<intent, progress, complete, retired, published>>
observations == <<version, selected>>
effects == <<unsafeCleanup, unsafePublication, unsafeRetirement>>
vars == <<foreground, engine, recovery, publisher, durable, observations,
          crashed, effects>>
LocksHeld == foreground = "recovery" /\ engine = "recovery"
SelectionMatches == selected = version
\* Exact legacy inputs and resource/guest observations are one abstract version.
\* No old Pin is synthesized. The selection starts without any live publication.
Init == /\ foreground = "none" /\ engine = "none"
        /\ recovery = "idle" /\ publisher = "idle"
        /\ intent = FALSE /\ progress = 0 /\ complete = FALSE
        /\ retired = FALSE /\ published = FALSE
        /\ version = 1 /\ selected = 0 /\ crashed = FALSE
        /\ unsafeCleanup = FALSE /\ unsafePublication = FALSE
        /\ unsafeRetirement = FALSE
AcquireRecoveryForeground ==
    /\ recovery \in {"idle", "crashed"} /\ foreground = "none"
    /\ foreground' = "recovery" /\ recovery' = "foreground"
    /\ selected' = IF intent THEN selected ELSE version
    /\ UNCHANGED <<engine, publisher, durable, version, crashed, effects>>
AcquireRecoveryEngine ==
    /\ recovery = "foreground" /\ foreground = "recovery" /\ engine = "none"
    /\ engine' = "recovery"
    /\ recovery' = IF retired THEN "retired"
                   ELSE IF complete THEN "complete"
                   ELSE IF intent THEN "cleaning" ELSE "leased"
    /\ UNCHANGED <<foreground, publisher, durable, observations, crashed, effects>>
WriteIntent ==
    /\ recovery = "leased" /\ LocksHeld /\ SelectionMatches /\ ~published
    /\ intent' = TRUE /\ recovery' = "cleaning"
    /\ UNCHANGED <<foreground, engine, publisher, progress, complete, retired,
                    published, observations, crashed, effects>>
\* One effect represents one exact non-volume resource cleanup. Commit is separate.
CleanupOne ==
    /\ recovery \in {"leased", "cleaning"} /\ LocksHeld /\ ~published
    /\ progress < 2 /\ (EnforceIntent => intent)
    /\ (EnforceSelection => SelectionMatches)
    /\ progress' = progress + 1 /\ recovery' = "cleaning"
    /\ unsafeCleanup' = (unsafeCleanup \/ ~intent \/ ~SelectionMatches)
    /\ UNCHANGED <<foreground, engine, publisher, intent, complete, retired,
                    published, observations, crashed, unsafePublication, unsafeRetirement>>
CommitCleanup ==
    /\ recovery = "cleaning" /\ LocksHeld /\ intent
    /\ SelectionMatches /\ progress = 2 /\ ~published
    /\ complete' = TRUE /\ recovery' = "complete"
    /\ UNCHANGED <<foreground, engine, publisher, intent, progress, retired,
                    published, observations, crashed, effects>>
RetireAbsentPublisher ==
    /\ recovery \in {"leased", "cleaning", "complete"} /\ LocksHeld
    /\ SelectionMatches /\ ~published
    /\ (EnforceCompletion => (intent /\ complete /\ progress = 2))
    /\ retired' = TRUE /\ recovery' = "retired"
    /\ unsafeRetirement' = (unsafeRetirement \/ ~intent \/ ~complete \/ progress # 2)
    /\ UNCHANGED <<foreground, engine, publisher, intent, progress, complete,
                    published, observations, crashed, unsafeCleanup, unsafePublication>>
ReleaseRecovery ==
    /\ recovery = "retired" /\ LocksHeld
    /\ foreground' = "none" /\ engine' = "none" /\ recovery' = "done"
    /\ UNCHANGED <<publisher, durable, observations, crashed, effects>>
\* A crash releases kernel locks while retaining every committed durable field.
CrashRecovery ==
    /\ recovery \in {"foreground", "leased", "cleaning", "complete", "retired"}
    /\ ~crashed /\ recovery' = "crashed" /\ crashed' = TRUE
    /\ foreground' = "none" /\ engine' = "none"
    /\ UNCHANGED <<publisher, durable, observations, effects>>
\* A cooperating identity/guest-boot change cannot occur under the Engine lease.
ChangeInputs ==
    /\ engine = "none" /\ version = 1 /\ version' = 2
    /\ UNCHANGED <<foreground, engine, recovery, publisher, durable, selected,
                    crashed, effects>>
RefuseRecovery ==
    /\ recovery \in {"leased", "cleaning", "complete"} /\ LocksHeld
    /\ (~SelectionMatches \/ published)
    /\ recovery' = "refused" /\ foreground' = "none" /\ engine' = "none"
    /\ UNCHANGED <<publisher, durable, observations, crashed, effects>>
AcquirePublisherForeground ==
    /\ publisher = "idle" /\ foreground = "none"
    /\ publisher' = "foreground" /\ foreground' = "publisher"
    /\ UNCHANGED <<engine, recovery, durable, observations, crashed, effects>>
AcquirePublisherEngine ==
    /\ publisher = "published" /\ foreground = "publisher" /\ engine = "none"
    /\ publisher' = "active" /\ engine' = "publisher"
    /\ UNCHANGED <<foreground, recovery, durable, observations, crashed, effects>>
ReleasePublisherEngine ==
    /\ publisher = "active" /\ engine = "publisher"
    /\ publisher' = "running" /\ engine' = "none"
    /\ UNCHANGED <<foreground, recovery, durable, observations, crashed, effects>>
FreshAllowed == ~intent /\ ~published
RetiredAllowed == intent /\ complete /\ retired /\ ~published
\* Ordinary bind publishes while holding the foreground lock, BEFORE Engine admission.
\* Recovery also needs that foreground lock, so intent and publication cannot race.
Publish ==
    /\ publisher = "foreground" /\ foreground = "publisher" /\ engine = "none"
    /\ (FreshAllowed \/ RetiredAllowed \/ (~EnforceBarrier /\ ~published))
    /\ published' = TRUE /\ publisher' = "published"
    /\ unsafePublication' = (unsafePublication \/ (intent /\ ~retired))
    /\ UNCHANGED <<foreground, engine, recovery, intent, progress, complete, retired,
                    observations, crashed, unsafeCleanup, unsafeRetirement>>
RefusePublisher ==
    /\ publisher = "foreground" /\ ~FreshAllowed /\ ~RetiredAllowed
    /\ publisher' = "refused" /\ foreground' = "none"
    /\ UNCHANGED <<engine, recovery, durable, observations, crashed, effects>>
PublisherExit ==
    /\ publisher \in {"published", "active", "running"} /\ foreground = "publisher"
    /\ publisher' = "exited" /\ foreground' = "none" /\ engine' = "none"
    /\ UNCHANGED <<recovery, durable, observations, crashed, effects>>
Next == AcquireRecoveryForeground \/ AcquireRecoveryEngine \/ WriteIntent \/ CleanupOne
        \/ CommitCleanup \/ RetireAbsentPublisher \/ ReleaseRecovery \/ CrashRecovery
        \/ ChangeInputs \/ RefuseRecovery \/ AcquirePublisherForeground
        \/ AcquirePublisherEngine \/ ReleasePublisherEngine \/ Publish \/ RefusePublisher
        \/ PublisherExit
Spec == Init /\ [][Next]_vars
TypeOK == /\ foreground \in {"none", "recovery", "publisher"}
          /\ engine \in {"none", "recovery", "publisher"}
          /\ recovery \in {"idle", "foreground", "leased", "cleaning", "complete",
                            "retired", "crashed", "done", "refused"}
          /\ publisher \in {"idle", "foreground", "published", "active", "running",
                             "refused", "exited"}
          /\ intent \in BOOLEAN /\ progress \in 0..2 /\ complete \in BOOLEAN
          /\ retired \in BOOLEAN /\ published \in BOOLEAN
          /\ version \in 1..2 /\ selected \in 0..2 /\ crashed \in BOOLEAN
          /\ unsafeCleanup \in BOOLEAN /\ unsafePublication \in BOOLEAN
          /\ unsafeRetirement \in BOOLEAN
ForegroundBeforeEngine == engine # "none" => engine = foreground
NoUnwitnessedCleanup == ~unsafeCleanup
NoPrematurePublication == ~unsafePublication
NoUnconfirmedRetirement == ~unsafeRetirement
CompletionRequiresCleanup == complete => (intent /\ progress = 2)
=======================================================================
