---------------- MODULE PerServicePublication ----------------
EXTENDS FiniteSets
CONSTANT UnsafeRecord, UnsafeBind
Services == {"first", "second"}
Aborted == {"failed", "cancelled", "dead", "down"}
VARIABLES ready, child, recorded, phase, stale, lateBind
vars == <<ready, child, recorded, phase, stale, lateBind>>
Retiring == (Aborted \ {"dead"}) \cup {"recovering"}
Committed == {"committed", "authorized", "bound"}
Init == /\ ready = {} /\ recorded = {} /\ stale = {} /\ lateBind = FALSE
        /\ child = [s \in Services |-> "absent"] /\ phase = "starting"
Ready(s) == /\ phase = "starting" /\ s \notin ready
            /\ ready' = ready \cup {s}
            /\ UNCHANGED <<child, recorded, phase, stale, lateBind>>
Admit(s) == /\ phase = "starting" /\ s \in ready \ stale
            /\ child[s] = "absent"
            /\ child' = [child EXCEPT ![s] = "gated"]
            /\ UNCHANGED <<ready, recorded, phase, stale, lateBind>>
Commit(s) == /\ phase = "starting" /\ s \notin stale /\ child[s] = "gated"
             /\ child' = [child EXCEPT ![s] = "committed"]
             /\ UNCHANGED <<ready, recorded, phase, stale, lateBind>>
Authorize(s) == /\ phase = "starting" /\ s \notin stale /\ child[s] = "committed"
                /\ child' = [child EXCEPT ![s] = "authorized"]
                /\ UNCHANGED <<ready, recorded, phase, stale, lateBind>>
Bind(s) == /\ (child[s] = "authorized" \/ (UnsafeBind /\ phase = "starting" /\ child[s] = "gated"))
           /\ child' = [child EXCEPT ![s] = IF @ = "gated" THEN "uncommitted-bind" ELSE "bound"]
           /\ lateBind' = (lateBind \/ phase \in {"dead", "recovering"})
           /\ UNCHANGED <<ready, recorded, phase, stale>>
Record(s) == /\ phase = "starting" /\ s \notin recorded
             /\ (child[s] = "bound" \/ (UnsafeRecord /\ child[s] = "gated"))
             /\ recorded' = recorded \cup {s}
             /\ UNCHANGED <<ready, child, phase, stale, lateBind>>
Stale(s) == /\ phase = "starting" /\ s \notin stale
            /\ child[s] \in {"absent", "gated", "committed"}
            /\ stale' = stale \cup {s}
            /\ UNCHANGED <<ready, child, recorded, phase, lateBind>>
Finish == /\ phase = "starting" /\ recorded = Services
          /\ phase' = "ready" /\ UNCHANGED <<ready, child, recorded, stale, lateBind>>
Abort(reason) == /\ phase = "starting" /\ phase' = reason
                 /\ UNCHANGED <<ready, child, recorded, stale, lateBind>>
EOFExit(s) == /\ phase \in Aborted \cup {"recovering"} /\ child[s] = "gated"
              /\ child' = [child EXCEPT ![s] = "absent"]
              /\ UNCHANGED <<ready, recorded, phase, stale, lateBind>>
SelectDeadOwner == /\ phase = "dead"
                   /\ phase' = "recovering"
                   /\ UNCHANGED <<ready, child, recorded, stale, lateBind>>
Retire(s) == /\ phase \in Retiring /\ child[s] \in Committed
             /\ child' = [child EXCEPT ![s] = "absent"]
             /\ recorded' = recorded \ {s}
             /\ UNCHANGED <<ready, phase, stale, lateBind>>
Settled == /\ phase \in Retiring /\ \A s \in Services : child[s] = "absent"
           /\ phase' = "retired" /\ UNCHANGED <<ready, child, recorded, stale, lateBind>>
Next == \/ \E s \in Services :
          Ready(s) \/ Admit(s) \/ Commit(s) \/ Authorize(s) \/ Bind(s)
          \/ Record(s) \/ Stale(s) \/ EOFExit(s) \/ Retire(s)
        \/ \E reason \in Aborted : Abort(reason)
        \/ Finish \/ SelectDeadOwner \/ Settled
Safe == /\ \A s \in Services :
             /\ child[s] # "uncommitted-bind"
             /\ (child[s] # "absent" => s \in ready)
             /\ (s \in recorded => child[s] = "bound")
             /\ (s \in stale => child[s] \notin {"authorized", "bound"})
        /\ (phase = "ready" => recorded = Services)
        /\ (phase = "retired" => \A s \in Services : child[s] = "absent")
NoDeadAuthorizedBind == ~lateBind
Spec == Init /\ [][Next]_vars
===============================================================
