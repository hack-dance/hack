---- MODULE BuildBatch ----
EXTENDS Integers, FiniteSets
CONSTANTS Jobs, Cap, EarlyReturn, CancelWins
VARIABLES next, active, stop, cancelled, result
vars == <<next, active, stop, cancelled, result>>
Init == /\ next = 1 /\ active = {} /\ stop = 0
        /\ cancelled = {} /\ result = -1
Start == /\ result = -1 /\ stop = 0
         /\ next \in Jobs /\ Cardinality(active) < Cap
         /\ active' = active \cup {next} /\ next' = next + 1
         /\ UNCHANGED <<stop, cancelled, result>>
Fail(j) == /\ result = -1 /\ j \in active /\ stop = 0
           /\ stop' = j /\ active' = active \ {j}
           /\ UNCHANGED <<next, cancelled, result>>
Interrupt == /\ result = -1 /\ stop = 0
             /\ stop' = -2
             /\ UNCHANGED <<next, active, cancelled, result>>
Settle(j) == /\ result = -1 /\ j \in active
             /\ active' = active \ {j}
             /\ cancelled' = IF stop = 0 THEN cancelled ELSE cancelled \cup {j}
             /\ UNCHANGED <<next, stop, result>>
Return == /\ result = -1
          /\ (stop # 0 \/ next \notin Jobs)
          /\ (active = {} \/ (EarlyReturn /\ stop = -2))
          /\ result' \in IF CancelWins /\ stop \in Jobs /\ cancelled # {} THEN cancelled ELSE {stop}
          /\ UNCHANGED <<next, active, stop, cancelled>>
Next == Start \/ Interrupt \/ Return \/ \E j \in Jobs: Fail(j) \/ Settle(j)
NoLiveReturn == result # -1 => active = {}
FirstOutcome == result # -1 => result = stop
Bounded == Cardinality(active) <= Cap
Spec == Init /\ [][Next]_vars
====
