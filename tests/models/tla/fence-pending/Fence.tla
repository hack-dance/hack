---- MODULE Fence ----
EXTENDS TLC
VARIABLES phase, pending, alive
vars == <<phase,pending,alive>>
Init == /\ phase = "launching" /\ pending = "none" /\ alive = TRUE
WriteClosing == /\ phase = "launching" /\ pending = "none" /\ pending' = "closing" /\ UNCHANGED <<phase,alive>>
Stop == /\ phase = "closing" /\ pending = "none" /\ alive' = FALSE /\ UNCHANGED <<phase,pending>>
WriteStopped == /\ phase = "closing" /\ pending = "none" /\ ~alive /\ pending' = "stopped" /\ UNCHANGED <<phase,alive>>
BadTransition == /\ phase = "launching" /\ pending = "none" /\ pending' = "stopped" /\ UNCHANGED <<phase,alive>>
Recover == /\ <<phase,pending>> \in {<<"launching","closing">>,<<"closing","stopped">>}
           /\ phase' = pending /\ pending' = "none" /\ UNCHANGED alive
Next == WriteClosing \/ Stop \/ WriteStopped \/ BadTransition \/ Recover
Spec == Init /\ [][Next]_vars
Safe == phase = "stopped" => ~alive
====
