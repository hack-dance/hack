---- MODULE FirstBroken ----
EXTENDS TLC
VARIABLES prior, occupied, complete, recovered
vars == <<prior,occupied,complete,recovered>>
Init == /\ prior \in {"empty","stopped","cancelled","discarded","launching"}
        /\ occupied \in BOOLEAN /\ complete \in BOOLEAN /\ recovered = FALSE
Terminal == prior \in {"empty","stopped","cancelled","discarded"}
Recover == /\ ~recovered /\ Terminal /\ complete
           /\ recovered' = TRUE /\ UNCHANGED <<prior,occupied,complete>>
Spec == Init /\ [][Recover]_vars
Safe == recovered => (Terminal /\ ~occupied /\ complete)
====
