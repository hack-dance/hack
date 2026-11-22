------------------------ MODULE PoolCapacityUpdate ------------------------
EXTENDS Naturals

CONSTANT Fence
VARIABLES pool, live, checked, receipt, config, journal, bootSize

vars == <<pool, live, checked, receipt, config, journal, bootSize>>
Init ==
    /\ pool = "running" /\ live = FALSE /\ checked = FALSE
    /\ receipt = 1 /\ config = 1 /\ journal = FALSE /\ bootSize = 1

\* Abstract the idle-restart boundary in PoolStop. Let a start interleave
\* after the observation to check the final stop predicate independently.
AcquireUse ==
    /\ pool = "running" /\ ~live
    /\ live' = TRUE
    /\ UNCHANGED <<pool, checked, receipt, config, journal, bootSize>>
ReleaseUse ==
    /\ live
    /\ live' = FALSE
    /\ UNCHANGED <<pool, checked, receipt, config, journal, bootSize>>
ObserveIdle ==
    /\ pool = "running" /\ ~live /\ ~checked /\ receipt = 1
    /\ checked' = TRUE
    /\ UNCHANGED <<pool, live, receipt, config, journal, bootSize>>
StopIdle ==
    /\ pool = "running" /\ checked /\ ~live
    /\ pool' = "stopped" /\ checked' = FALSE /\ bootSize' = 0
    /\ UNCHANGED <<live, receipt, config, journal>>

\* Durable transitions from share_update: intent, provider CAS, owner
\* receipt, and retirement. A crash loses only transient progress.
Begin ==
    /\ pool = "stopped" /\ ~journal /\ receipt = 1
    /\ journal' = TRUE
    /\ UNCHANGED <<pool, live, checked, receipt, config, bootSize>>
ProviderCAS ==
    /\ pool = "stopped" /\ journal /\ config = 1
    /\ config' = 2
    /\ UNCHANGED <<pool, live, checked, receipt, journal, bootSize>>
OwnerCAS ==
    /\ pool = "stopped" /\ journal /\ config = 2 /\ receipt = 1
    /\ receipt' = 2
    /\ UNCHANGED <<pool, live, checked, config, journal, bootSize>>
Retire ==
    /\ pool = "stopped" /\ journal /\ receipt = 2 /\ config = 2
    /\ journal' = FALSE
    /\ UNCHANGED <<pool, live, checked, config, receipt, bootSize>>
CrashStopped ==
    /\ pool = "stopped"
    /\ UNCHANGED vars
Boot ==
    /\ pool = "stopped"
    /\ IF Fence THEN ~journal /\ config = receipt ELSE config = 2
    /\ pool' = "running" /\ bootSize' = config
    /\ UNCHANGED <<checked, live, config, receipt, journal>>

Next == AcquireUse \/ ReleaseUse \/ ObserveIdle \/ StopIdle
        \/ Begin \/ ProviderCAS \/ OwnerCAS \/ Retire \/ CrashStopped \/ Boot
Spec == Init /\ [][Next]_vars
CoherentBoot == pool = "running" => (bootSize = receipt /\ ~journal)
NoEviction == live => pool = "running"

=============================================================================
