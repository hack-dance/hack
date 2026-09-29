----------------------------- MODULE Routing -----------------------------
EXTENDS Naturals, TLC
CONSTANT ReuseFrontend
VARIABLES generation, alive, phase, observed, delivered
vars == <<generation, alive, phase, observed, delivered>>
Init == /\ generation = 1 /\ alive = {1} /\ phase = "start"
        /\ observed = 0 /\ delivered = 0
Observe == /\ phase = "start" /\ generation \in alive
           /\ observed' = generation /\ phase' = "observed"
           /\ UNCHANGED <<generation, alive, delivered>>
Retire == /\ generation = 1 /\ 1 \in alive /\ phase # "done"
          /\ alive' = {} /\ UNCHANGED <<generation, phase, observed, delivered>>
Replace == /\ generation = 1 /\ alive = {} /\ phase # "done"
           /\ generation' = 2 /\ alive' = {2}
           /\ UNCHANGED <<phase, observed, delivered>>
Connect == /\ phase = "observed"
           /\ delivered' = IF ReuseFrontend THEN (IF generation \in alive THEN generation ELSE 0)
                           ELSE (IF observed \in alive THEN observed ELSE 0)
           /\ phase' = "done" /\ UNCHANGED <<generation, alive, observed>>
Next == Observe \/ Retire \/ Replace \/ Connect
Spec == Init /\ [][Next]_vars
NoWrongReservation == phase = "done" => delivered = 0 \/ delivered = observed
=============================================================================
