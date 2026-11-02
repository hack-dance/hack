-------------------------- MODULE Cancellation --------------------------
EXTENDS TLC
CONSTANT CheckCancellation
VARIABLES phase, cancelled, latePublication
vars == <<phase, cancelled, latePublication>>

Init == /\ phase = "idle" /\ cancelled = FALSE /\ latePublication = FALSE
Begin == /\ phase = "idle" /\ phase' = "pending"
         /\ UNCHANGED <<cancelled, latePublication>>
Cancel == /\ phase \in {"pending", "owned", "published"} /\ ~cancelled
          /\ cancelled' = TRUE /\ UNCHANGED <<phase, latePublication>>
\* Completion includes observing ownership evidence, even after cancellation.
Complete == /\ phase = "pending" /\ phase' = "owned"
            /\ UNCHANGED <<cancelled, latePublication>>
Publish == /\ phase = "owned" /\ (~CheckCancellation \/ ~cancelled)
           /\ phase' = "published" /\ latePublication' = cancelled
           /\ UNCHANGED cancelled
Grant == /\ phase = "published" /\ ~cancelled /\ phase' = "ready"
         /\ UNCHANGED <<cancelled, latePublication>>
Refuse == /\ phase \in {"owned", "published"} /\ cancelled
          /\ phase' = "closed" /\ UNCHANGED <<cancelled, latePublication>>
Retire == /\ phase = "ready" /\ phase' = "closed"
          /\ UNCHANGED <<cancelled, latePublication>>

Next == Begin \/ Cancel \/ Complete \/ Publish \/ Grant \/ Refuse \/ Retire
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"idle", "pending", "owned", "published", "ready", "closed"}
          /\ cancelled \in BOOLEAN /\ latePublication \in BOOLEAN
NoLatePublication == ~latePublication
NoCancelledReady == ~(cancelled /\ phase = "ready")
=============================================================================
