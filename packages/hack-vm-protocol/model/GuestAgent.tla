---- MODULE GuestAgent ----
EXTENDS Naturals
VARIABLES conn, epoch, job, observed, exited, pending
v == <<conn,epoch,job,observed,exited,pending>>
Init == /\ conn = "down" /\ epoch = 0 /\ job = "absent"
        /\ observed = "none" /\ exited = FALSE /\ pending = FALSE
Connect == /\ conn = "down" /\ conn' = "up"
           /\ UNCHANGED <<epoch,job,observed,exited,pending>>
Send == /\ conn = "up" /\ epoch = 0 /\ job = "absent" /\ ~pending
        /\ pending' = TRUE /\ UNCHANGED <<conn,epoch,job,observed,exited>>
Lose == /\ conn = "up" /\ conn' = "half"
        /\ UNCHANGED <<epoch,job,observed,exited,pending>>
HostRestart == /\ conn # "down" /\ conn' = "down"
               /\ UNCHANGED <<epoch,job,observed,exited,pending>>
Start == /\ pending /\ epoch = 0 /\ job = "absent"
         /\ job' = "running" /\ pending' = FALSE
         /\ UNCHANGED <<conn,epoch,observed,exited>>
Exit == /\ job = "running" /\ job' = "exit37" /\ exited' = TRUE
        /\ UNCHANGED <<conn,epoch,observed,pending>>
Inspect == /\ conn = "up" /\ observed' = IF epoch = 0 THEN job ELSE "unknown"
           /\ UNCHANGED <<conn,epoch,job,exited,pending>>
Release == /\ conn = "up" /\ epoch = 0 /\ observed = "exit37" /\ job = "exit37"
           /\ job' = "released" /\ UNCHANGED <<conn,epoch,observed,exited,pending>>
GuestRestart == /\ epoch = 0 /\ epoch' = 1 /\ conn' = "down" /\ job' = "absent"
                /\ pending' = FALSE /\ UNCHANGED <<observed,exited>>
Next == Connect \/ Send \/ Lose \/ HostRestart \/ Start \/ Exit \/ Inspect \/ Release \/ GuestRestart
Spec == Init /\ [][Next]_v
ExitRetained == (epoch = 0 /\ exited) => job \in {"exit37","released"}
StaleCannotRun == epoch # 0 => job = "absent"
====
