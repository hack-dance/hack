--------------------------- MODULE Preflight ---------------------------
EXTENDS Naturals
CONSTANT RetireOnEOF
VARIABLES frontend, worker, phase, done, locked
vars == <<frontend, worker, phase, done, locked>>
Init == /\ frontend = "alive" /\ worker = "alive"
        /\ phase = "idle" /\ done = 0 /\ locked = FALSE
Send == /\ frontend = "alive" /\ worker = "alive"
        /\ phase = "idle" /\ done < 2
        /\ phase' = "in-flight" /\ locked' = TRUE
        /\ UNCHANGED <<frontend, worker, done>>
Reply == /\ worker = "alive" /\ phase = "in-flight"
         /\ phase' = "idle" /\ done' = done + 1 /\ locked' = FALSE
         /\ UNCHANGED <<frontend, worker>>
FrontendDies == /\ frontend = "alive"
                /\ frontend' = "dead"
                /\ UNCHANGED <<worker, phase, done, locked>>
EOFObserved == /\ frontend = "dead" /\ worker = "alive"
               /\ worker' = IF RetireOnEOF THEN "exited" ELSE "orphaned"
               /\ phase' = "closed" /\ locked' = FALSE
               /\ UNCHANGED <<frontend, done>>
Next == Send \/ Reply \/ FrontendDies \/ EOFObserved
Spec == Init /\ [][Next]_vars /\ WF_vars(EOFObserved)
NoOrphan == worker # "orphaned"
BetweenRequestsUnlocked == phase # "in-flight" => ~locked
Retires == frontend = "dead" ~> worker = "exited"
=============================================================================
