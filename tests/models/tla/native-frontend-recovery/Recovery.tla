---------------------------- MODULE Recovery ----------------------------
EXTENDS Naturals, TLC
CONSTANTS EnforceReservation, EnforceRelease, EnforceAuthority, EnforceBinding
VARIABLES fresh, directory, owner, pending, savedOwner, savedNext, release,
          stage, active, alive, attempts, crashed, crashStage, progress, ready,
          binding, unsafePromotion, unsafeAbsence, unsafeEffect
publication == <<directory, owner, pending, savedOwner, savedNext, release>>
process == <<stage, active, alive, attempts>>
history == <<crashed, crashStage>>
resources == <<progress, ready>>
unsafe == <<unsafePromotion, unsafeAbsence, unsafeEffect>>
vars == <<fresh, publication, process, history, resources, binding, unsafe>>
Matches == binding = 1
Issued == active /\ owner = savedOwner /\ savedNext = 0 /\ alive
Init == /\ fresh \in BOOLEAN
        /\ directory = TRUE /\ owner = 1 /\ pending = 0
        /\ savedOwner = 1 /\ savedNext = 0 /\ release = FALSE
        /\ stage = (IF fresh THEN "leased" ELSE "admitted")
        /\ active = fresh /\ alive = fresh /\ attempts = 0
        /\ crashed = FALSE /\ crashStage = "none"
        /\ progress = (IF fresh THEN 3 ELSE 0) /\ ready = ~fresh
        /\ binding = 1 /\ unsafePromotion = FALSE
        /\ unsafeAbsence = FALSE /\ unsafeEffect = FALSE
ReserveCandidate ==
    /\ stage = "admitted" /\ directory /\ attempts < 2 /\ Matches
    /\ (owner # 0 \/ release) /\ pending = 0
    /\ pending' = attempts + 2 /\ attempts' = attempts + 1
    /\ stage' = "pending" /\ alive' = TRUE /\ active' = FALSE
    /\ UNCHANGED <<fresh, directory, owner, savedOwner, savedNext, release,
                    history, resources, binding, unsafe>>
BindCandidate ==
    /\ stage = "pending" /\ alive /\ Matches /\ pending # 0
    /\ savedOwner' = owner /\ savedNext' = pending
    /\ release' = (owner = 0) /\ stage' = "reserved"
    /\ UNCHANGED <<fresh, directory, owner, pending, active, alive, attempts,
                    history, resources, binding, unsafe>>
PromoteCandidate ==
    /\ stage \in {"pending", "reserved"} /\ Matches /\ alive
    /\ pending # 0 /\ (EnforceReservation => savedNext = pending)
    /\ owner' = pending /\ pending' = 0 /\ stage' = "promoted"
    /\ unsafePromotion' = unsafePromotion \/ savedNext # pending
    /\ UNCHANGED <<fresh, directory, savedOwner, savedNext, release,
                    active, alive, attempts, history, resources, binding,
                    unsafeAbsence, unsafeEffect>>
IssueLease ==
    /\ stage = "promoted" /\ Matches /\ alive /\ owner = savedNext
    /\ active' = TRUE /\ stage' = "issued"
    /\ UNCHANGED <<fresh, publication, alive, attempts, history, resources,
                    binding, unsafe>>
BindIssuedLease ==
    /\ stage = "issued" /\ active /\ Matches /\ alive
    /\ savedOwner' = owner /\ savedNext' = 0 /\ release' = FALSE
    /\ stage' = "leased"
    /\ UNCHANGED <<fresh, directory, owner, pending, active, alive, attempts,
                    history, resources, binding, unsafe>>
AdvanceResources ==
    /\ stage = "leased" /\ progress < 3
    /\ (EnforceAuthority => Issued) /\ (EnforceBinding => Matches)
    /\ progress' = progress + 1
    /\ ready' = (IF progress = 1 THEN FALSE ELSE ready)
    /\ unsafeEffect' = unsafeEffect \/ ~Issued \/ ~Matches
    /\ UNCHANGED <<fresh, publication, process, history, binding,
                    unsafePromotion, unsafeAbsence>>
ArmRelease ==
    /\ stage = "leased" /\ Issued /\ Matches
    /\ release' = TRUE /\ stage' = "releasing"
    /\ UNCHANGED <<fresh, directory, owner, pending, savedOwner, savedNext,
                    active, alive, attempts, history, resources, binding, unsafe>>
RemoveOwner ==
    /\ stage \in {"leased", "releasing"} /\ Issued /\ Matches
    /\ (EnforceRelease => release)
    /\ owner' = 0 /\ active' = FALSE /\ stage' = "empty"
    /\ unsafeAbsence' = unsafeAbsence \/ ~release
    /\ UNCHANGED <<fresh, directory, pending, savedOwner, savedNext, release,
                    alive, attempts, history, resources, binding,
                    unsafePromotion, unsafeEffect>>
RemoveDirectory ==
    /\ stage = "empty" /\ release /\ owner = 0 /\ pending = 0 /\ Matches
    /\ directory' = FALSE /\ stage' = "done" /\ alive' = FALSE
    /\ UNCHANGED <<fresh, owner, pending, savedOwner, savedNext, release,
                    active, attempts, history, resources, binding, unsafe>>
FailFreshRelease ==
    /\ fresh /\ stage = "leased" /\ progress = 3 /\ ~release
    /\ stage' = "release-failed" /\ active' = FALSE
    /\ UNCHANGED <<fresh, publication, alive, attempts, history, resources,
                    binding, unsafe>>
LoseAuthority ==
    /\ stage = "leased" /\ active /\ active' = FALSE
    /\ UNCHANGED <<fresh, publication, stage, alive, attempts, history,
                    resources, binding, unsafe>>
ReplaceBinding ==
    /\ binding = 1 /\ binding' = 2
    /\ UNCHANGED <<fresh, publication, process, history, resources, unsafe>>
Crash ==
    /\ stage \in {"pending", "reserved", "promoted", "issued", "leased",
                    "releasing", "empty", "release-failed"}
    /\ ~crashed /\ crashed' = TRUE /\ crashStage' = stage
    /\ stage' = "reopen" /\ active' = FALSE /\ alive' = FALSE
    /\ UNCHANGED <<fresh, publication, attempts, resources, binding, unsafe>>
RecoverSavedCandidate ==
    /\ stage = "reopen" /\ ~alive /\ Matches
    /\ directory /\ pending # 0 /\ pending = savedNext
    /\ (owner = savedOwner \/ (owner = 0 /\ release))
    /\ owner' = pending /\ pending' = 0 /\ stage' = "admitted"
    /\ UNCHANGED <<fresh, directory, savedOwner, savedNext, release,
                    active, alive, attempts, history, resources, binding, unsafe>>
ReadmitOwner ==
    /\ stage = "reopen" /\ ~alive /\ Matches /\ pending = 0
    /\ (owner = savedOwner \/ (owner = savedNext /\ owner # 0)
        \/ (owner = 0 /\ release))
    /\ directory' = TRUE /\ stage' = "admitted"
    /\ UNCHANGED <<fresh, owner, pending, savedOwner, savedNext, release,
                    active, alive, attempts, history, resources, binding, unsafe>>
RefuseUnknown ==
    /\ stage = "reopen" /\ (pending # 0 /\ pending # savedNext)
    /\ stage' = "unknown-retained"
    /\ UNCHANGED <<fresh, publication, active, alive, attempts, history,
                    resources, binding, unsafe>>
RefuseChanged ==
    /\ stage = "reopen" /\ ~Matches /\ stage' = "changed-retained"
    /\ UNCHANGED <<fresh, publication, active, alive, attempts, history,
                    resources, binding, unsafe>>
Next == ReserveCandidate \/ BindCandidate \/ PromoteCandidate \/ IssueLease
        \/ BindIssuedLease \/ AdvanceResources \/ ArmRelease \/ RemoveOwner
        \/ RemoveDirectory \/ FailFreshRelease \/ LoseAuthority \/ ReplaceBinding
        \/ Crash \/ RecoverSavedCandidate \/ ReadmitOwner \/ RefuseUnknown
        \/ RefuseChanged
Spec == Init /\ [][Next]_vars
TypeOK == /\ fresh \in BOOLEAN /\ directory \in BOOLEAN
          /\ owner \in 0..3 /\ pending \in 0..3 /\ savedOwner \in 0..3
          /\ savedNext \in 0..3 /\ release \in BOOLEAN
          /\ stage \in {"admitted", "pending", "reserved", "promoted", "issued",
                         "leased", "releasing", "empty", "done", "reopen",
                         "release-failed", "unknown-retained", "changed-retained"}
          /\ active \in BOOLEAN /\ alive \in BOOLEAN /\ attempts \in 0..2
          /\ crashed \in BOOLEAN
          /\ crashStage \in {"none", "pending", "reserved", "promoted", "issued",
                              "leased", "releasing", "empty", "release-failed"}
          /\ progress \in 0..3 /\ ready \in BOOLEAN /\ binding \in 1..2
          /\ unsafePromotion \in BOOLEAN /\ unsafeAbsence \in BOOLEAN
          /\ unsafeEffect \in BOOLEAN
NoUnreservedPromotion == ~unsafePromotion
NoUncommittedAbsence == ~unsafeAbsence
NoUnissuedEffect == ~unsafeEffect
NeverReservedCrashCompletion == ~(crashStage = "reserved" /\ progress = 3 /\ stage = "done")
NeverPromotedCrashCompletion == ~(crashStage = "promoted" /\ progress = 3 /\ stage = "done")
NeverReleaseCrashCompletion == ~(crashStage = "empty" /\ progress = 3 /\ stage = "done")
NeverUnknownRefusal == stage # "unknown-retained"
NeverFreshReleaseRetention == ~(stage = "release-failed" /\ owner = 1 /\ directory /\ ~release)
=============================================================================
