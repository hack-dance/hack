--------------------------- MODULE ArchiveBound ---------------------------
\* One run's dead-owner recovery history across repeated pool stops (HACK-2576).
\*
\* Every pool stop under a running project ends its boot; the next `up` recovers
\* the run, and a recovery that finds an earlier completed recovery record moves
\* it aside as history (`dead-owner-cleanup-retired-*`; the interrupted-start
\* journal history works the same way). The history is bounded.
\*
\* phase    - "ready": the run is up; "stopped": its pool stopped under it.
\* intent   - "none" or "complete": the run's current recovery record.
\* archives - proven finished history records.
\* foreign  - other files with the history's name prefix that cannot be proven
\*            finished (a foreign file, a record from an unknown format); fixed.
\* cycles   - pool stops so far (bounded by MaxCycles).
\*
\* Switches:
\*   DropOldest   - this change: at the bound the oldest proven finished record is
\*                  removed to make room. FALSE is today: the recovery refuses.
\*   CountForeign - today's count includes every file with the prefix; this change
\*                  counts only proven finished records.
EXTENDS Naturals
CONSTANTS Limit, MaxCycles, MaxForeign, DropOldest, CountForeign

VARIABLES phase, intent, archives, foreign, cycles
vars == <<phase, intent, archives, foreign, cycles>>

TypeOK ==
    /\ phase \in {"ready", "stopped"}
    /\ intent \in {"none", "complete"}
    /\ archives \in 0..Limit /\ foreign \in 0..MaxForeign
    /\ cycles \in 0..MaxCycles

Init ==
    /\ phase = "ready" /\ intent = "none" /\ archives = 0
    /\ foreign \in 0..MaxForeign /\ cycles = 0

\* `runtime down`, a crash or a host restart under the running project.
PoolStop ==
    /\ phase = "ready" /\ cycles < MaxCycles
    /\ phase' = "stopped" /\ cycles' = cycles + 1
    /\ UNCHANGED <<intent, archives, foreign>>

\* What the archive step counts against the bound.
Counted == IF CountForeign THEN archives + foreign ELSE archives

\* The next `up` (or `down --recover`): a completed prior record is archived first.
Recover ==
    /\ phase = "stopped"
    /\ intent = "complete" => (DropOldest \/ Counted < Limit)
    /\ archives' =
         IF intent = "none" THEN archives
         ELSE IF archives < Limit THEN archives + 1 ELSE archives
    /\ intent' = "complete" /\ phase' = "ready"
    /\ UNCHANGED <<foreign, cycles>>

Next == PoolStop \/ Recover
Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ WF_vars(Recover)

\* A run whose pool stopped can always be recovered by the next `up`.
AlwaysRecoverable == phase = "stopped" => ENABLED Recover
\* The history stays bounded.
Bounded == archives <= Limit
\* Under a fair `up`, every stopped run is up again.
Recovers == phase = "stopped" ~> phase = "ready"
=============================================================================
