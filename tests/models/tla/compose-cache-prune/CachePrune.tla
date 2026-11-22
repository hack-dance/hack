---- MODULE CachePrune ----
EXTENDS Naturals

CONSTANT RequireMatchingReceipt
VARIABLES attached, other, generation, receipt, removed
vars == <<attached, other, generation, receipt, removed>>

Init == /\ attached = TRUE
        /\ other = FALSE
        /\ generation = 0
        /\ receipt = 2
        /\ removed = FALSE

Retain == /\ attached
          /\ receipt' = generation
          /\ UNCHANGED <<attached, other, generation, removed>>

Stop == /\ attached
        /\ attached' = FALSE
        /\ UNCHANGED <<other, generation, receipt, removed>>

Replace == /\ ~attached
           /\ ~other
           /\ ~removed
           /\ generation = 0
           /\ generation' = 1
           /\ UNCHANGED <<attached, other, receipt, removed>>

AttachOther == /\ ~attached
               /\ ~removed
               /\ ~other
               /\ other' = TRUE
               /\ UNCHANGED <<attached, generation, receipt, removed>>

Prune == /\ ~attached
         /\ ~other
         /\ ~removed
         /\ IF RequireMatchingReceipt THEN receipt = generation ELSE receipt # 2
         /\ removed' = TRUE
         /\ UNCHANGED <<attached, other, generation, receipt>>

Next == Retain \/ Stop \/ Replace \/ AttachOther \/ Prune
Spec == Init /\ [][Next]_vars
Safe == removed => (~attached /\ ~other /\ receipt = generation /\ generation = 0)
====
