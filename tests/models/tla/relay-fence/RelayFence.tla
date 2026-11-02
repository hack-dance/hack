---- MODULE RelayFence ----
EXTENDS Naturals, Sequences
CONSTANT Limit
VARIABLES issued, owner, fence, closed, alive, retired
vars == <<issued, owner, fence, closed, alive, retired>>
Init == /\ issued = 0 /\ owner = 0 /\ fence = 0 /\ closed = TRUE /\ alive = 0 /\ retired = <<>>
Issue == /\ owner = 0 /\ issued < Limit
         /\ issued' = issued + 1 /\ owner' = issued + 1
         /\ UNCHANGED <<fence, closed, alive, retired>>
Launch(i) == /\ i \in 1..issued /\ i > fence
             /\ fence' = i /\ closed' = FALSE /\ alive' = i
             /\ UNCHANGED <<issued, owner, retired>>
BeginStop == /\ owner # 0 /\ owner >= fence
             /\ fence' = owner /\ closed' = TRUE
             /\ UNCHANGED <<issued, owner, alive, retired>>
FinishStop == /\ owner # 0 /\ fence = owner /\ closed
              /\ alive' = 0 /\ retired' = Append(retired, owner) /\ owner' = 0
              /\ UNCHANGED <<issued, fence, closed>>
Next == Issue \/ (\E i \in 1..Limit : Launch(i)) \/ BeginStop \/ FinishStop
Spec == Init /\ [][Next]_vars
Safe == /\ (\A k \in 1..Len(retired) : alive # retired[k]) /\ (alive = 0 \/ alive = owner)
        /\ fence <= issued /\ Len(retired) <= Limit
====
