---- MODULE GuestAgent ----
EXTENDS Naturals
CONSTANT PrematureRelease, DuplicateDelivery, RecordRunning, UnsafeRestart, WaitForEOF
VARIABLES epoch, id, job, actual, starts, saved, pending, conn, belief
VARIABLES agent, survivor, writerOpen
protocol == <<epoch,id,job,actual,starts,saved,pending,conn,belief>>
v == <<protocol, agent, survivor, writerOpen>>
Terminal == {"exit37","spawnFailed"}
Empty == << "none","none" >>
Init == /\ agent = "online" /\ survivor = FALSE /\ writerOpen = FALSE
        /\ epoch = 0 /\ id = 1 /\ job = "absent" /\ actual = Empty
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
Release == /\ (~WaitForEOF \/ ~writerOpen)
           /\ conn = "up" /\ job \in Terminal /\ (saved # "none" \/ PrematureRelease)
           /\ job' = "released" /\ UNCHANGED <<epoch,id,actual,starts,saved,pending,conn,belief>>
NewId == /\ id = 1 /\ job = "released" /\ id' = 2 /\ job' = "absent"
         /\ saved' = "none" /\ belief' = "unknown"
         /\ UNCHANGED <<epoch,actual,starts,pending,conn>>
ResetRegistry == /\ epoch = 0 /\ epoch' = 1 /\ id' = 1 /\ job' = "absent"
          /\ actual' = Empty /\ starts' = <<0,0>> /\ saved' = "none"
          /\ conn' = "down" /\ belief' = "unknown" /\ UNCHANGED pending
Crash == /\ epoch = 0 /\ agent = "online" /\ agent' = "crashed"
         /\ survivor' = (job = "running" \/ writerOpen)
         /\ UNCHANGED <<protocol, writerOpen>>
KillCgroup == /\ agent = "crashed" /\ agent' = "clean" /\ survivor' = FALSE
              /\ UNCHANGED <<protocol, writerOpen>>
AgentRestart == /\ (agent = "clean" \/ (agent = "crashed" /\ UnsafeRestart))
                /\ ResetRegistry /\ agent' = "online" /\ writerOpen' = FALSE
                /\ UNCHANGED survivor
ObserveExit == /\ Finish /\ writerOpen' \in BOOLEAN
               /\ UNCHANGED <<agent,survivor>>
Commands == Connect \/ Stall \/ Deadline \/ HostRestart \/ Send \/ List \/ Inspect
            \/ Record \/ NewId \/ (\E h \in pending: Deliver(h) \/ Drop(h))
Reboot == /\ ResetRegistry /\ agent' = "online" /\ survivor' = FALSE /\ writerOpen' = FALSE
Next == Crash \/ KillCgroup \/ AgentRestart
        \/ (/\ agent = "online" /\ (\/ ObserveExit
                                   \/ (/\ Commands /\ UNCHANGED <<agent,survivor,writerOpen>>)
                                   \/ (/\ Release /\ writerOpen' = FALSE /\ UNCHANGED <<agent,survivor>>)))
        \/ Reboot
Spec == Init /\ [][Next]_v /\ WF_v(agent = "online" /\ ObserveExit)
        /\ WF_v(KillCgroup) /\ WF_v(AgentRestart)
NoOrphan == agent = "online" => ~survivor
TerminalReleasable == (agent = "online" /\ conn = "up" /\ job \in Terminal /\ saved = actual[id])
                      => ENABLED Release
StartedOnce == \A i \in 1..2: starts[i] <= 1
SavedOutcome == saved = "none" \/ (saved \in Terminal /\ saved = actual[id])
ResultBeforeRelease == job = "released" => saved = actual[id]
EventuallyReaped == (job = "running") ~> (job # "running")
====
