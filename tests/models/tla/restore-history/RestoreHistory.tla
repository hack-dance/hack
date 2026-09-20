---------------------- MODULE RestoreHistory ----------------------
EXTENDS Naturals, Sequences, FiniteSets
CONSTANTS Capacity, Limit, DeleteBeforePublish
VARIABLES current, captured, manifest, legacy, pending, phase
vars == <<current, captured, manifest, legacy, pending, phase>>
Suffix(s) == IF Len(s) <= Capacity THEN s
             ELSE SubSeq(s, Len(s) - Capacity + 1, Len(s))
Expected(n) == Suffix([i \in 1..n |-> i])
Visible == IF manifest = <<>> THEN legacy ELSE manifest
Init == /\ current = Capacity + 1
        /\ captured = Capacity
        /\ manifest = <<>>
        /\ legacy = Expected(Capacity)
        /\ pending = <<>>
        /\ phase = "idle"
Prepare == /\ phase = "idle" /\ current <= Limit
           /\ pending' = Expected(current)
           /\ phase' = "writing"
           /\ legacy' = IF DeleteBeforePublish THEN <<>> ELSE legacy
           /\ UNCHANGED <<current, captured, manifest>>
Publish == /\ phase = "writing"
           /\ manifest' = pending /\ captured' = current
           /\ pending' = <<>> /\ phase' = "retiring"
           /\ UNCHANGED <<current, legacy>>
Retire == /\ phase = "retiring" /\ legacy # <<>>
          /\ legacy' = Tail(legacy)
          /\ UNCHANGED <<current, captured, manifest, pending, phase>>
Restore == /\ phase = "retiring" /\ legacy = <<>>
           /\ current' = current + 1 /\ phase' = "idle"
           /\ UNCHANGED <<captured, manifest, legacy, pending>>
Crash == /\ phase # "idle" /\ phase' = "idle" /\ pending' = <<>>
         /\ UNCHANGED <<current, captured, manifest, legacy>>
Done == /\ phase = "idle" /\ current > Limit /\ UNCHANGED vars
Next == Prepare \/ Publish \/ Retire \/ Restore \/ Crash \/ Done
TypeOK == /\ current \in (Capacity+1)..(Limit+1)
          /\ captured \in Capacity..Limit
          /\ phase \in {"idle", "writing", "retiring"}
          /\ Len(manifest) <= Capacity /\ Len(pending) <= Capacity
          /\ Len(legacy) <= Capacity
HistoryPreserved == Visible = Expected(captured)
CurrentAuthority == captured <= current /\ current <= captured + 1
RetirementHasCommit == phase = "retiring" => manifest = Expected(current)
Spec == Init /\ [][Next]_vars
===================================================================
