-------------------------- MODULE Authorization --------------------------
EXTENDS TLC
CONSTANT HoldLock
VARIABLES phase, active, held, lateWrite
vars == <<phase, active, held, lateWrite>>
Init == /\ phase = "new" /\ active = TRUE /\ held = FALSE /\ lateWrite = FALSE
Authenticate == /\ phase = "new" /\ active /\ phase' = "ready"
                /\ UNCHANGED <<active, held, lateWrite>>
Check == /\ phase = "ready" /\ active
         /\ phase' = "checked" /\ held' = HoldLock
         /\ UNCHANGED <<active, lateWrite>>
Write == /\ phase = "checked" /\ phase' = "done"
         /\ held' = FALSE /\ lateWrite' = ~active /\ UNCHANGED active
Revoke == /\ active /\ ~held /\ active' = FALSE
          /\ UNCHANGED <<phase, held, lateWrite>>
Next == Authenticate \/ Check \/ Write \/ Revoke
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"new", "ready", "checked", "done"}
          /\ active \in BOOLEAN /\ held \in BOOLEAN /\ lateWrite \in BOOLEAN
NoLateWrite == ~lateWrite
=============================================================================
