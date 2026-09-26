------------------------- MODULE BalloonReuse -------------------------
EXTENDS TLC
CONSTANT RestoreAccounting
VARIABLES phase, reusable
vars == <<phase, reusable>>
Init == /\ phase = "mapped" /\ reusable = FALSE
Unmap == /\ phase = "mapped" /\ phase' = "unmapped" /\ UNCHANGED reusable
Discard == /\ phase = "unmapped" /\ phase' = "retained"
           /\ reusable' \in BOOLEAN
Reuse == /\ phase = "retained" /\ phase' = "ready"
         /\ reusable' = IF RestoreAccounting THEN FALSE ELSE reusable
ReuseFailure == /\ RestoreAccounting /\ phase = "retained"
                /\ phase' = "stopped" /\ UNCHANGED reusable
Remap == /\ phase = "ready" /\ phase' = "mapped" /\ UNCHANGED reusable
RemapFailure == /\ phase = "ready" /\ phase' = "stopped" /\ UNCHANGED reusable
Stop == /\ phase # "stopped" /\ phase' = "stopped" /\ UNCHANGED reusable
Halted == /\ phase = "stopped" /\ UNCHANGED vars
Next == Unmap \/ Discard \/ Reuse \/ ReuseFailure \/ Remap \/ RemapFailure \/ Stop \/ Halted
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"mapped", "unmapped", "retained", "ready", "stopped"}
          /\ reusable \in BOOLEAN
MappedMemoryAccounted == phase = "mapped" => ~reusable
=============================================================================
