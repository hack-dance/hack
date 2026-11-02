------------------------- MODULE TerminalReuse -------------------------
EXTENDS TLC
CONSTANT EnforceCommitBarrier
VARIABLES phase, ownerAlive, cancelled, reviewed, prepared, fenced,
          committed, slotReady, grants, sameScope, sameGeneration,
          allRetired, authorityEmpty, lifecycleClear
inputs == <<sameScope, sameGeneration, allRetired, authorityEmpty, lifecycleClear>>
vars == <<phase, ownerAlive, cancelled, reviewed, prepared, fenced,
          committed, slotReady, grants, inputs>>
OldTargets == {1, 2}
NewTarget == 3
Eligible == sameScope /\ sameGeneration /\ allRetired /\ authorityEmpty /\ lifecycleClear
Init == /\ phase = "terminal" /\ ownerAlive = TRUE /\ cancelled = FALSE
        /\ reviewed = FALSE /\ prepared = FALSE /\ fenced = TRUE
        /\ committed = FALSE /\ slotReady = FALSE /\ grants = {}
        /\ sameScope \in BOOLEAN /\ sameGeneration \in BOOLEAN
        /\ allRetired \in BOOLEAN /\ authorityEmpty \in BOOLEAN
        /\ lifecycleClear \in BOOLEAN
Review == /\ phase = "terminal" /\ ownerAlive /\ ~cancelled /\ Eligible
          /\ phase' = "reviewed" /\ reviewed' = TRUE
          /\ UNCHANGED <<ownerAlive, cancelled, prepared, fenced,
                          committed, slotReady, grants, inputs>>
Prepare == /\ phase = "reviewed" /\ ownerAlive /\ ~cancelled
           /\ phase' = "journaled" /\ prepared' = TRUE
           /\ UNCHANGED <<ownerAlive, cancelled, reviewed, fenced,
                           committed, slotReady, grants, inputs>>
BeginEmpty == /\ phase = "journaled" /\ ownerAlive /\ ~cancelled /\ Eligible
              /\ phase' = "fenced" /\ fenced' = TRUE
              /\ UNCHANGED <<ownerAlive, cancelled, reviewed, prepared,
                              committed, slotReady, grants, inputs>>
Commit == /\ phase = "fenced" /\ ownerAlive /\ ~cancelled
          /\ phase' = "committed" /\ committed' = TRUE
          /\ UNCHANGED <<ownerAlive, cancelled, reviewed, prepared, fenced,
                          slotReady, grants, inputs>>
CompleteEmpty == /\ phase = "committed" /\ ownerAlive /\ ~cancelled /\ Eligible
                 /\ phase' = "ready" /\ slotReady' = TRUE /\ fenced' = FALSE
                 /\ UNCHANGED <<ownerAlive, cancelled, reviewed, prepared,
                                 committed, grants, inputs>>
RegisterNew == /\ ownerAlive /\ ~cancelled /\ grants = {}
               /\ IF EnforceCommitBarrier THEN phase = "ready"
                                          ELSE phase \in {"fenced", "ready"}
               /\ phase' = "one-off" /\ grants' = {NewTarget}
               /\ UNCHANGED <<ownerAlive, cancelled, reviewed, prepared,
                               fenced, committed, slotReady, inputs>>
Cancel == /\ phase \notin {"terminal", "one-off", "failed"}
          /\ ownerAlive /\ ~cancelled
          /\ phase' = "failed" /\ cancelled' = TRUE
          /\ fenced' = TRUE /\ slotReady' = FALSE /\ grants' = {}
          /\ UNCHANGED <<ownerAlive, reviewed, prepared, committed, inputs>>
Crash == /\ ownerAlive /\ ownerAlive' = FALSE
         /\ fenced' = TRUE /\ slotReady' = FALSE /\ grants' = {}
         /\ UNCHANGED <<phase, cancelled, reviewed, prepared, committed, inputs>>
Next == Review \/ Prepare \/ BeginEmpty \/ Commit \/ CompleteEmpty \/ RegisterNew \/ Cancel \/ Crash
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"terminal", "reviewed", "journaled", "fenced", "committed", "ready", "one-off", "failed"}
          /\ ownerAlive \in BOOLEAN /\ cancelled \in BOOLEAN
          /\ reviewed \in BOOLEAN /\ prepared \in BOOLEAN /\ fenced \in BOOLEAN
          /\ committed \in BOOLEAN /\ slotReady \in BOOLEAN
          /\ grants \subseteq OldTargets \cup {NewTarget}
          /\ sameScope \in BOOLEAN /\ sameGeneration \in BOOLEAN
          /\ allRetired \in BOOLEAN /\ authorityEmpty \in BOOLEAN
          /\ lifecycleClear \in BOOLEAN
NoPrematureNewGrant == grants # {} => (reviewed /\ prepared /\ committed
                                     /\ slotReady /\ ~fenced /\ Eligible
                                     /\ ~cancelled /\ ownerAlive)
NoTerminalGrant == grants \cap OldTargets = {}
NoEffectsForUnsafeSelection == prepared => (reviewed /\ Eligible)
=======================================================================
