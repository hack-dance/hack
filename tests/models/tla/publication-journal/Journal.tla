---------------- MODULE Journal ----------------
EXTENDS Naturals
CONSTANT UnsafeRecovery
VARIABLES committed, pending, alive, changed, recoveredLive, skipped
vars == <<committed, pending, alive, changed, recoveredLive, skipped>>
Init == /\ committed = 0 /\ pending = 0 /\ alive = TRUE /\ changed = FALSE
        /\ recoveredLive = FALSE /\ skipped = FALSE
Write == /\ pending = 0 /\ committed < 4 /\ alive /\ pending' = committed+1
         /\ UNCHANGED <<committed, alive, changed, recoveredLive, skipped>>
Commit == /\ pending > 0 /\ alive /\ ~changed /\ committed' = pending /\ pending' = 0
          /\ UNCHANGED <<alive, changed, recoveredLive, skipped>>
Crash == /\ alive /\ alive' = FALSE /\ UNCHANGED <<committed, pending, changed, recoveredLive, skipped>>
Corrupt == /\ pending > 0 /\ ~changed /\ changed' = TRUE
           /\ UNCHANGED <<committed, pending, alive, recoveredLive, skipped>>
Skip == /\ pending > 0 /\ pending < 4 /\ pending' = pending+1
        /\ UNCHANGED <<committed, alive, changed, recoveredLive, skipped>>
Recover == /\ pending > 0 /\ ~changed /\ (~alive \/ UnsafeRecovery)
           /\ pending = committed+1 /\ committed' = pending /\ pending' = 0
           /\ recoveredLive' = alive /\ skipped' = (pending # committed+1)
           /\ UNCHANGED <<alive, changed>>
Next == Write \/ Commit \/ Crash \/ Corrupt \/ Skip \/ Recover
Safe == ~recoveredLive /\ ~skipped
Spec == Init /\ [][Next]_vars
====================================================
