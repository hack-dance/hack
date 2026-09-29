-------------------------- MODULE Admission --------------------------
EXTENDS Naturals, FiniteSets
CONSTANT Locked
VARIABLES owner, phase, used
vars == <<owner, phase, used>>
Init == /\ owner = 0 /\ phase = [i \in 1..2 |-> "idle"] /\ used = {}
Check(i) == /\ phase[i] = "idle" /\ Cardinality(used) < 1
            /\ (~Locked \/ owner = 0)
            /\ owner' = IF Locked THEN i ELSE owner
            /\ phase' = [phase EXCEPT ![i] = "checked"] /\ UNCHANGED used
Reserve(i) == /\ phase[i] = "checked"
              /\ used' = used \cup {i}
              /\ phase' = [phase EXCEPT ![i] = "reserved"]
              /\ owner' = 0
Retire(i) == /\ phase[i] = "reserved" /\ owner = 0
             /\ used' = used \ {i}
             /\ phase' = [phase EXCEPT ![i] = "idle"] /\ UNCHANGED owner
Next == \E i \in 1..2 : Check(i) \/ Reserve(i) \/ Retire(i)
Spec == Init /\ [][Next]_vars
Capacity == Cardinality(used) <= 1
=============================================================================
