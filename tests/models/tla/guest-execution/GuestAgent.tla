---- MODULE GuestAgent ----
EXTENDS Naturals
CONSTANT PrematureRelease, DuplicateDelivery, RecordRunning
VARIABLES epoch, id, job, actual, starts, saved, pending, conn, belief
v == <<epoch,id,job,actual,starts,saved,pending,conn,belief>>
Terminal == {"exit37","spawnFailed"}
Empty == << "none","none" >>
Init == /\ epoch = 0 /\ id = 1 /\ job = "absent" /\ actual = Empty
        /\ starts = <<0,0>> /\ saved = "none" /\ pending = {}
        /\ conn = "down" /\ belief = "unknown"
Connect == /\ conn = "down" /\ conn' = "up"
           /\ UNCHANGED <<epoch,id,job,actual,starts,saved,pending,belief>>
Stall == /\ conn = "up" /\ conn' = "half"
         /\ UNCHANGED <<epoch,id,job,actual,starts,saved,pending,belief>>
Disconnect == /\ conn' = "down" /\ belief' = "unknown"
              /\ UNCHANGED <<epoch,id,job,actual,starts,saved,pending>>
Deadline == /\ conn = "half" /\ Disconnect
HostRestart == Disconnect
Send == /\ conn = "up" /\ pending' = pending \cup {<<epoch,id>>}
        /\ UNCHANGED <<epoch,id,job,actual,starts,saved,conn,belief>>
Drop(h) == /\ pending' = pending \ {h}
           /\ UNCHANGED <<epoch,id,job,actual,starts,saved,conn,belief>>
Deliver(h) == /\ pending' = pending \ {h}
              /\ IF h = <<epoch,id>> /\ (job = "absent" \/ DuplicateDelivery)
                    THEN /\ job' \in {"running","spawnFailed"}
                         /\ starts' = [starts EXCEPT ![id] = @ + 1]
                         /\ actual' = [actual EXCEPT ![id] = IF job' = "running" THEN "none" ELSE job']
                    ELSE UNCHANGED <<job,starts,actual>>
              /\ UNCHANGED <<epoch,id,saved,conn,belief>>
Finish == /\ job = "running" /\ job' = "exit37"
          /\ actual' = [actual EXCEPT ![id] = "exit37"]
          /\ UNCHANGED <<epoch,id,starts,saved,pending,conn,belief>>
List == /\ conn = "up"
        /\ belief' = IF job \in {"absent","released"} THEN "missing" ELSE "listed"
        /\ UNCHANGED <<epoch,id,job,actual,starts,saved,pending,conn>>
Inspect == /\ conn = "up" /\ belief' = job
           /\ UNCHANGED <<epoch,id,job,actual,starts,saved,pending,conn>>
Record == /\ (belief \in Terminal \/ (RecordRunning /\ belief = "running"))
          /\ saved' = belief /\ UNCHANGED <<epoch,id,job,actual,starts,pending,conn,belief>>
Release == /\ conn = "up" /\ job \in Terminal /\ (saved # "none" \/ PrematureRelease)
           /\ job' = "released" /\ UNCHANGED <<epoch,id,actual,starts,saved,pending,conn,belief>>
NewId == /\ id = 1 /\ job = "released" /\ id' = 2 /\ job' = "absent"
         /\ saved' = "none" /\ belief' = "unknown"
         /\ UNCHANGED <<epoch,actual,starts,pending,conn>>
Reboot == /\ epoch = 0 /\ epoch' = 1 /\ id' = 1 /\ job' = "absent"
          /\ actual' = Empty /\ starts' = <<0,0>> /\ saved' = "none"
          /\ conn' = "down" /\ belief' = "unknown" /\ UNCHANGED pending
Next == Connect \/ Stall \/ Deadline \/ HostRestart \/ Send \/ Finish \/ List \/ Inspect
        \/ Record \/ Release \/ Reboot \/ NewId \/ (\E h \in pending: Deliver(h) \/ Drop(h))
Spec == Init /\ [][Next]_v /\ WF_v(Finish)
StartedOnce == \A i \in 1..2: starts[i] <= 1
SavedOutcome == saved = "none" \/ (saved \in Terminal /\ saved = actual[id])
ResultBeforeRelease == job = "released" => saved = actual[id]
EventuallyReaped == (job = "running") ~> (job # "running")
====
