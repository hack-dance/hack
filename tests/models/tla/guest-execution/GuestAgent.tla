---- MODULE GuestAgent ----
EXTENDS Naturals
CONSTANT PrematureRelease
VARIABLES epoch, handle, job, saved, pending, conn, belief, actor
v == <<epoch, handle, job, saved, pending, conn, belief, actor>>
Init == /\ epoch = 0 /\ handle = 0 /\ job = "absent" /\ saved = FALSE
        /\ pending = {} /\ conn = "down" /\ belief = "unknown" /\ actor = 0
Connect == /\ conn = "down" /\ conn' = "up"
           /\ UNCHANGED <<epoch,handle,job,saved,pending,belief,actor>>
Stall == /\ conn = "up" /\ conn' = "half"
         /\ UNCHANGED <<epoch,handle,job,saved,pending,belief,actor>>
Deadline == /\ conn = "half" /\ conn' = "down" /\ belief' = "unknown"
            /\ UNCHANGED <<epoch,handle,job,saved,pending,actor>>
HostRestart == /\ conn' = "down" /\ belief' = "unknown"
               /\ UNCHANGED <<epoch,handle,job,saved,pending,actor>>
Send == /\ conn = "up" /\ pending' = pending \cup {handle}
        /\ UNCHANGED <<epoch,handle,job,saved,conn,belief,actor>>
Drop(h) == /\ pending' = pending \ {h}
           /\ UNCHANGED <<epoch,handle,job,saved,conn,belief,actor>>
Deliver(h) == /\ pending' = pending \ {h}
              /\ IF h = epoch /\ job = "absent"
                    THEN /\ job' \in {"running","spawnFailed"} /\ actor' = h
                    ELSE UNCHANGED <<job,actor>>
              /\ UNCHANGED <<epoch,handle,saved,conn,belief>>
Finish == /\ job = "running" /\ job' = "exited"
          /\ UNCHANGED <<epoch,handle,saved,pending,conn,belief,actor>>
List == /\ conn = "up"
        /\ belief' = IF handle # epoch THEN "unknown"
                      ELSE IF job \in {"absent","released"} THEN "missing" ELSE "listed"
        /\ UNCHANGED <<epoch,handle,job,saved,pending,conn,actor>>
Inspect == /\ conn = "up" /\ belief' = IF handle = epoch THEN job ELSE "unknown"
           /\ UNCHANGED <<epoch,handle,job,saved,pending,conn,actor>>
Record == /\ belief \in {"exited","spawnFailed"} /\ handle = epoch /\ saved' = TRUE
          /\ UNCHANGED <<epoch,handle,job,pending,conn,belief,actor>>
Release == /\ conn = "up" /\ handle = epoch /\ job \in {"exited","spawnFailed"}
           /\ (saved \/ PrematureRelease) /\ job' = "released"
           /\ UNCHANGED <<epoch,handle,saved,pending,conn,belief,actor>>
Reboot == /\ epoch = 0 /\ epoch' = 1 /\ job' = "absent" /\ saved' = FALSE
          /\ conn' = "down" /\ belief' = "unknown" /\ UNCHANGED <<handle,pending,actor>>
NewHandle == /\ conn = "up" /\ handle # epoch /\ handle' = epoch /\ belief' = "unknown"
             /\ UNCHANGED <<epoch,job,saved,pending,conn,actor>>
Next == Connect \/ Stall \/ Deadline \/ HostRestart \/ Send \/ Finish \/ List \/ Inspect
        \/ Record \/ Release \/ Reboot \/ NewHandle \/ (\E h \in pending: Deliver(h) \/ Drop(h))
Spec == Init /\ [][Next]_v /\ WF_v(Finish)
ResultBeforeRelease == job = "released" => saved
IncarnationFence == job # "absent" => actor = epoch
EventuallyReaped == (job = "running") ~> (job # "running")
====
