---- MODULE StageBroken ----
EXTENDS TLC
VARIABLES phase, held, alive
vars == <<phase, held, alive>>
Init == /\ phase = "idle" /\ held = FALSE /\ alive = FALSE
Begin == /\ phase = "idle" /\ phase' = "preparing" /\ held' = TRUE /\ UNCHANGED alive
Authorize == /\ phase = "preparing" /\ held /\ phase' = "launching" /\ UNCHANGED <<held, alive>>
Fork == /\ phase = "launching" /\ held /\ ~alive /\ alive' = TRUE /\ UNCHANGED <<phase, held>>
LoseParent == /\ held /\ held' = FALSE /\ UNCHANGED <<phase, alive>>
Discard == /\ ~held /\ phase \in {"preparing", "launching"} /\ phase' = "discarded" /\ UNCHANGED <<held, alive>>
StopProcess == /\ ~held /\ phase = "launching" /\ alive' = FALSE /\ phase' = "stopped" /\ UNCHANGED held
Next == Begin \/ Authorize \/ Fork \/ LoseParent \/ Discard \/ StopProcess
Spec == Init /\ [][Next]_vars
Safe == phase = "discarded" => ~alive
====
