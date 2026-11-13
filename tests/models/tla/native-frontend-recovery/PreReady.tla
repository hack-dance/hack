----------------------------- MODULE PreReady -----------------------------
EXTENDS Naturals, TLC
CONSTANTS EnforceSettled, EnforceRelease, EnforceIntent
VARIABLES origin, owner, savedOwner, intent, release, removed, files, complete,
          active, alive, attempts, crashes, unsafeCleanup, unsafeRelease, starts
publication == <<owner, savedOwner, intent, release>>
progress == <<removed, files, complete>>
process == <<active, alive, attempts, crashes>>
unsafe == <<unsafeCleanup, unsafeRelease, starts>>
vars == <<origin, publication, progress, process, unsafe>>
Settled == origin \in {"ready", "failed", "cleanup"}
Init == /\ origin \in {"ready", "failed", "cleanup", "preparing", "pending"}
        /\ owner \in {"none", "original"} /\ savedOwner = "none"
        /\ intent = FALSE /\ release = FALSE /\ removed = FALSE
        /\ files = TRUE /\ complete = FALSE /\ active = FALSE /\ alive = FALSE
        /\ attempts = 0 /\ crashes = 0 /\ unsafeCleanup = FALSE
        /\ unsafeRelease = FALSE /\ starts = 1
Acquire ==
    /\ ~active /\ ~alive /\ ~intent /\ attempts < 2
    /\ owner \in {"none", "original", "held"}
    /\ owner' = IF owner = "none" THEN "held" ELSE owner
    /\ active' = TRUE /\ alive' = TRUE /\ attempts' = attempts + 1
    /\ UNCHANGED <<origin, savedOwner, intent, release, progress, crashes, unsafe>>
Commit ==
    /\ active /\ alive /\ ~intent /\ (EnforceSettled => Settled)
    /\ intent' = TRUE /\ savedOwner' = owner
    /\ UNCHANGED <<origin, owner, release, progress, process, unsafe>>
Cleanup ==
    /\ active /\ alive /\ intent /\ ~removed /\ owner = savedOwner
    /\ removed' = TRUE /\ unsafeCleanup' = (~Settled \/ unsafeCleanup)
    /\ UNCHANGED <<origin, publication, files, complete, process, unsafeRelease, starts>>
RetireFiles ==
    /\ active /\ alive /\ intent /\ removed /\ files /\ owner = savedOwner
    /\ files' = FALSE
    /\ UNCHANGED <<origin, publication, removed, complete, process, unsafe>>
ArmRelease ==
    /\ active /\ alive /\ intent /\ ~files /\ owner = savedOwner /\ ~release
    /\ release' = TRUE
    /\ UNCHANGED <<origin, owner, savedOwner, intent, progress, process, unsafe>>
Release ==
    /\ active /\ alive /\ intent /\ ~files /\ owner = savedOwner
    /\ (EnforceRelease => release)
    /\ owner' = "none" /\ active' = FALSE /\ alive' = FALSE
    /\ unsafeRelease' = (~release \/ unsafeRelease)
    /\ UNCHANGED <<origin, savedOwner, intent, release, progress, attempts, crashes, unsafeCleanup, starts>>
Crash ==
    /\ active /\ alive /\ crashes = 0
    /\ active' = FALSE /\ alive' = FALSE /\ crashes' = 1
    /\ UNCHANGED <<origin, publication, progress, attempts, unsafe>>
Resume ==
    /\ ~active /\ ~alive /\ intent /\ ~complete /\ attempts < 2
    /\ owner = savedOwner /\ owner # "none"
    /\ active' = TRUE /\ alive' = TRUE /\ attempts' = attempts + 1
    /\ UNCHANGED <<origin, publication, progress, crashes, unsafe>>
ReplaceOwner ==
    /\ ~active /\ ~alive /\ intent /\ ~complete /\ owner = savedOwner
    /\ owner' = "foreign"
    /\ UNCHANGED <<origin, savedOwner, intent, release, progress, process, unsafe>>
Complete ==
    /\ intent /\ removed /\ ~files /\ ~complete /\ release /\ owner = "none"
    /\ complete' = TRUE
    /\ UNCHANGED <<origin, publication, removed, files, process, unsafe>>
StartAnother ==
    /\ ~files /\ ~complete /\ owner = "none" /\ starts = 1
    /\ (EnforceIntent => ~intent)
    /\ starts' = 2
    /\ UNCHANGED <<origin, publication, progress, process, unsafeCleanup, unsafeRelease>>
Next == Acquire \/ Commit \/ Cleanup \/ RetireFiles \/ ArmRelease \/ Release
        \/ Crash \/ Resume \/ ReplaceOwner \/ Complete \/ StartAnother
Spec == Init /\ [][Next]_vars
TypeOK == /\ origin \in {"ready", "failed", "cleanup", "preparing", "pending"}
          /\ owner \in {"none", "original", "held", "foreign"}
          /\ savedOwner \in {"none", "original", "held"}
          /\ intent \in BOOLEAN /\ release \in BOOLEAN /\ removed \in BOOLEAN
          /\ files \in BOOLEAN /\ complete \in BOOLEAN /\ active \in BOOLEAN
          /\ alive \in BOOLEAN /\ attempts \in 0..2 /\ crashes \in 0..1
          /\ unsafeCleanup \in BOOLEAN /\ unsafeRelease \in BOOLEAN /\ starts \in 1..2
OnlySettledCleanup == ~unsafeCleanup
ReleaseRecorded == ~unsafeRelease
NoReplay == starts = 1
RetirementHasProof == (~files => removed) /\ (complete => removed /\ release /\ owner = "none")
=============================================================================
