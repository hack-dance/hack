---- MODULE HostRootRetirement ----
EXTENDS TLC
CONSTANT Broken
VARIABLES phase, reference, identity, leased
vars == <<phase, reference, identity, leased>>

Init ==
  /\ phase = "Present"
  /\ reference \in {"Live", "Recoverable", "None", "Unknown"}
  /\ identity = "Original"
  /\ leased = FALSE

Acquire ==
  /\ ~leased
  /\ leased' = TRUE
  /\ UNCHANGED <<phase, reference, identity>>

Prune ==
  /\ leased
  /\ phase = "Present"
  /\ reference = "Recoverable"
  /\ reference' = "None"
  /\ UNCHANGED <<phase, identity, leased>>

Plan ==
  /\ leased
  /\ phase = "Present"
  /\ reference = "None" \/ (Broken /\ reference = "Recoverable")
  /\ identity = "Original"
  /\ phase' = "Planned"
  /\ UNCHANGED <<reference, identity, leased>>

Move ==
  /\ leased
  /\ phase = "Planned"
  /\ identity = "Original"
  /\ reference = "None" \/ Broken
  /\ phase' = "Quarantined"
  /\ UNCHANGED <<reference, identity, leased>>

Remove ==
  /\ leased
  /\ phase = "Quarantined"
  /\ identity = "Original"
  /\ reference = "None" \/ Broken
  /\ phase' = "Removed"
  /\ UNCHANGED <<reference, identity, leased>>

Crash ==
  /\ leased
  /\ leased' = FALSE
  /\ UNCHANGED <<phase, reference, identity>>

Replace ==
  /\ ~leased
  /\ phase \in {"Planned", "Quarantined"}
  /\ identity = "Original"
  /\ identity' = "Replacement"
  /\ UNCHANGED <<phase, reference, leased>>

Next == Acquire \/ Prune \/ Plan \/ Move \/ Remove \/ Crash \/ Replace
Spec == Init /\ [][Next]_vars
PreserveReferences ==
  phase \in {"Quarantined", "Removed"} => reference = "None"
====
