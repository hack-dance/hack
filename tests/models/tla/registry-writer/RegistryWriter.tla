-------------------------- MODULE RegistryWriter --------------------------
EXTENDS Naturals, FiniteSets

CONSTANT RecoveryGuard
Writers == 1..2
Reapers == 1..2
WriterPhases == {"idle", "prepared", "holding", "releasing", "released", "crashed"}
ReaperPhases == {"idle", "before", "guarded", "observed", "checked",
                 "refused", "reaped", "done", "crashed"}

VARIABLES lock, writer, reusedPid, guard, reaper, selected, unsafeReap
vars == <<lock, writer, reusedPid, guard, reaper, selected, unsafeReap>>
LiveOwners == {w \in Writers : writer[w] \in {"holding", "releasing"}}
Absent(w) == writer[w] = "crashed" /\ w \notin reusedPid

Init == /\ lock = 0
        /\ writer = [w \in Writers |-> "idle"]
        /\ reusedPid = {}
        /\ guard = 0
        /\ reaper = [r \in Reapers |-> "idle"]
        /\ selected = [r \in Reapers |-> 0]
        /\ unsafeReap = FALSE

\* A receipt becomes immutable before link(2) can publish it at the shared name.
Prepare(w) == /\ writer[w] = "idle"
              /\ writer' = [writer EXCEPT ![w] = "prepared"]
              /\ UNCHANGED <<lock, reusedPid, guard, reaper, selected, unsafeReap>>
Publish(w) == /\ writer[w] = "prepared" /\ lock = 0
              /\ lock' = w
              /\ writer' = [writer EXCEPT ![w] = "holding"]
              /\ UNCHANGED <<reusedPid, guard, reaper, selected, unsafeReap>>

\* Inspection and unlink are distinct: there is no atomic compare-and-unlink.
InspectRelease(w) == /\ writer[w] = "holding" /\ lock = w
                     /\ writer' = [writer EXCEPT ![w] = "releasing"]
                     /\ UNCHANGED <<lock, reusedPid, guard, reaper, selected, unsafeReap>>
Release(w) == /\ writer[w] = "releasing"
              /\ lock' = 0
              /\ writer' = [writer EXCEPT ![w] = "released"]
              /\ UNCHANGED <<reusedPid, guard, reaper, selected, unsafeReap>>
CrashWriter(w) == /\ writer[w] \in {"idle", "prepared", "holding", "releasing"}
                  /\ writer' = [writer EXCEPT ![w] = "crashed"]
                  /\ UNCHANGED <<lock, reusedPid, guard, reaper, selected, unsafeReap>>
\* Any occupied/reused PID refuses recovery; a missing snapshot is not ESRCH.
ReusePid(w) == /\ writer[w] = "crashed" /\ w \notin reusedPid
               /\ reusedPid' = reusedPid \cup {w}
               /\ UNCHANGED <<lock, writer, guard, reaper, selected, unsafeReap>>

ObserveBeforeGuard(r) == /\ reaper[r] = "idle"
                         /\ selected' = [selected EXCEPT ![r] = lock]
                         /\ reaper' = [reaper EXCEPT ![r] = "before"]
                         /\ UNCHANGED <<lock, writer, reusedPid, guard, unsafeReap>>
AcquireGuard(r) == /\ reaper[r] = "before"
                   /\ (~RecoveryGuard \/ guard = 0)
                   /\ guard' = IF RecoveryGuard THEN r ELSE guard
                   /\ selected' = [selected EXCEPT ![r] = 0]
                   /\ reaper' = [reaper EXCEPT ![r] = "guarded"]
                   /\ UNCHANGED <<lock, writer, reusedPid, unsafeReap>>
\* Fresh bounded receipt/death inspection runs only after acquiring the guard.
Observe(r) == /\ reaper[r] = "guarded"
              /\ (~RecoveryGuard \/ guard = r)
              /\ selected' = [selected EXCEPT ![r] = lock]
              /\ reaper' = [reaper EXCEPT ![r] = "observed"]
              /\ UNCHANGED <<lock, writer, reusedPid, guard, unsafeReap>>
CheckReceipt(r) == /\ reaper[r] = "observed"
                   /\ reaper' = [reaper EXCEPT ![r] =
                        IF selected[r] \in Writers
                           /\ lock = selected[r] /\ Absent(selected[r])
                        THEN "checked" ELSE "refused"]
                   /\ UNCHANGED <<lock, writer, reusedPid, guard, selected, unsafeReap>>
\* This path unlink consumes prior inspection, not an imaginary atomic CAS.
Reap(r) == /\ reaper[r] = "checked"
           /\ lock' = 0
           /\ unsafeReap' = (unsafeReap \/ (lock \in LiveOwners /\ lock # selected[r]))
           /\ reaper' = [reaper EXCEPT ![r] = "reaped"]
           /\ UNCHANGED <<writer, reusedPid, guard, selected>>
FinishRecovery(r) == /\ reaper[r] \in {"refused", "reaped"}
                     /\ guard' = IF RecoveryGuard THEN 0 ELSE guard
                     /\ reaper' = [reaper EXCEPT ![r] = "done"]
                     /\ UNCHANGED <<lock, writer, reusedPid, selected, unsafeReap>>
\* A crash never clears the non-reclaiming guard, even after the old lock is gone.
CrashRecovery(r) == /\ reaper[r] \in {"guarded", "observed", "checked", "refused", "reaped"}
                    /\ reaper' = [reaper EXCEPT ![r] = "crashed"]
                    /\ UNCHANGED <<lock, writer, reusedPid, guard, selected, unsafeReap>>

Next == (\E w \in Writers : Prepare(w) \/ Publish(w) \/ InspectRelease(w)
                           \/ Release(w) \/ CrashWriter(w) \/ ReusePid(w))
        \/ (\E r \in Reapers : ObserveBeforeGuard(r) \/ AcquireGuard(r)
                              \/ Observe(r) \/ CheckReceipt(r) \/ Reap(r)
                              \/ FinishRecovery(r) \/ CrashRecovery(r))
TypeOK == /\ lock \in 0..2 /\ guard \in 0..2
          /\ writer \in [Writers -> WriterPhases]
          /\ reaper \in [Reapers -> ReaperPhases]
          /\ selected \in [Reapers -> 0..2]
          /\ reusedPid \subseteq Writers /\ unsafeReap \in BOOLEAN
NoLiveOwnershipLoss == \A w \in LiveOwners : lock = w
MutualExclusion == Cardinality(LiveOwners) <= 1
NoStaleReap == ~unsafeReap
Spec == Init /\ [][Next]_vars
=============================================================================
