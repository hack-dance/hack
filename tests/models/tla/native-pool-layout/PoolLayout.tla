----------------------------- MODULE PoolLayout -----------------------------
CONSTANT StrictOlder
VARIABLES owner, initial, refused

vars == <<owner, initial, refused>>
Init == /\ owner = "absent" /\ initial = "absent" /\ refused = FALSE

Create(layout) ==
    /\ owner = "absent" /\ layout \in {"legacy", "compact"}
    /\ owner' = layout /\ initial' = layout /\ UNCHANGED refused

\* Current boot, stop, and journal replay keep the creation layout.
UseExisting == /\ owner # "absent" /\ UNCHANGED vars

\* The old owner decoder rejects unknown fields before a mutating operation.
OlderUse ==
    /\ owner = "compact" /\ refused = FALSE
    /\ refused' = TRUE
    /\ owner' = IF StrictOlder THEN owner ELSE "legacy"
    /\ UNCHANGED initial

Next == (\E layout \in {"legacy", "compact"} : Create(layout)) \/ UseExisting \/ OlderUse
Spec == Init /\ [][Next]_vars
LayoutPreserved == owner = initial
=============================================================================
