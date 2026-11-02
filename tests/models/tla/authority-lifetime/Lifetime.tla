----------------------------- MODULE Lifetime -----------------------------
EXTENDS TLC
CONSTANT StartupLock
VARIABLES running, authority, lock, start, down
vars == <<running, authority, lock, start, down>>
Init == /\ running = TRUE /\ authority = FALSE /\ lock = "none"
        /\ start = "new" /\ down = "new"
StartRead == /\ start = "new" /\ running /\ lock = "none"
             /\ start' = "checked" /\ lock' = IF StartupLock THEN "start" ELSE "none"
             /\ UNCHANGED <<running, authority, down>>
StartBind == /\ start = "checked" /\ (IF StartupLock THEN lock = "start" ELSE lock = "none")
             /\ authority' = TRUE /\ start' = "done" /\ lock' = "none"
             /\ UNCHANGED <<running, down>>
DownRead == /\ down = "new" /\ lock = "none"
            /\ down' = "stopping" /\ lock' = "down"
            /\ UNCHANGED <<running, authority, start>>
StopAuthority == /\ down = "stopping" /\ lock = "down"
                 /\ authority' = FALSE /\ down' = "authority-stopped"
                 /\ UNCHANGED <<running, lock, start>>
StopRuntime == /\ down = "authority-stopped" /\ lock = "down"
               /\ running' = FALSE /\ lock' = "none" /\ down' = "done"
               /\ UNCHANGED <<authority, start>>
Next == StartRead \/ StartBind \/ DownRead \/ StopAuthority \/ StopRuntime
Spec == Init /\ [][Next]_vars
NoAuthorityAfterDown == ~running => ~authority
=============================================================================
