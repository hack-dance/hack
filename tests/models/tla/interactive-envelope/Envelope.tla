------------------------------ MODULE Envelope -----------------------------
EXTENDS Naturals, TLC
CONSTANT RestoreOnError
VARIABLES stage, echo, ready, pending, validated, ack, leaked
vars == <<stage, echo, ready, pending, validated, ack, leaked>>
Init == /\ stage = "initial" /\ echo = TRUE /\ ready = FALSE
        /\ pending = 0 /\ validated = FALSE /\ ack = FALSE /\ leaked = FALSE
TypeOK == /\ stage \in {"initial", "raw", "ready", "reading", "validated", "restored", "acked", "executed", "failed"}
          /\ echo \in BOOLEAN /\ ready \in BOOLEAN /\ pending \in 0..2
          /\ validated \in BOOLEAN /\ ack \in BOOLEAN /\ leaked \in BOOLEAN
Raw == /\ stage = "initial" /\ echo' = FALSE /\ stage' = "raw"
       /\ UNCHANGED <<ready, pending, validated, ack, leaked>>
Ready == /\ stage = "raw" /\ ready' = TRUE /\ stage' = "ready"
         /\ UNCHANGED <<echo, pending, validated, ack, leaked>>
SendPrivate == /\ stage = "ready" /\ ready /\ pending' = 2 /\ stage' = "reading"
               /\ leaked' = leaked \/ echo
               /\ UNCHANGED <<echo, ready, validated, ack>>
ReadByte == /\ stage = "reading" /\ pending > 0 /\ pending' = pending - 1
            /\ leaked' = leaked \/ echo
            /\ UNCHANGED <<stage, echo, ready, validated, ack>>
Validate == /\ stage = "reading" /\ pending = 0 /\ stage' = "validated" /\ validated' = TRUE
            /\ UNCHANGED <<echo, ready, pending, ack, leaked>>
Restore == /\ stage = "validated" /\ stage' = "restored" /\ echo' = TRUE
           /\ UNCHANGED <<ready, pending, validated, ack, leaked>>
Ack == /\ stage = "restored" /\ ack' = TRUE /\ stage' = "acked"
       /\ UNCHANGED <<echo, ready, pending, validated, leaked>>
Execute == /\ stage = "acked" /\ stage' = "executed"
           /\ UNCHANGED <<echo, ready, pending, validated, ack, leaked>>
\* Pending includes bytes still in flight: flushing the slave cannot erase them.
Fail == /\ stage \in {"raw", "ready", "reading", "validated"}
        /\ stage' = "failed" /\ echo' = RestoreOnError
        /\ UNCHANGED <<ready, pending, validated, ack, leaked>>
LateByte == /\ stage = "failed" /\ pending > 0 /\ pending' = pending - 1
            /\ leaked' = leaked \/ echo
            /\ UNCHANGED <<stage, echo, ready, validated, ack>>
Next == Raw \/ Ready \/ SendPrivate \/ ReadByte \/ Validate \/ Restore \/ Ack \/ Execute \/ Fail \/ LateByte
Spec == Init /\ [][Next]_vars
NoPrivateEcho == ~leaked
NoRestoreOverPrivate == pending > 0 => ~echo
AckAfterValidation == ack => validated /\ pending = 0 /\ echo
=============================================================================
