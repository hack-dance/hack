----------------------------- MODULE SharedHttps -----------------------------
EXTENDS TLC, FiniteSets
CONSTANT RejectClosingAcquire
VARIABLES mode, clients, leases, unsafeShutdown
vars == <<mode, clients, leases, unsafeShutdown>>
Clients == {1, 2}
Phases == {"new", "leased", "disconnected", "clean", "clean-disconnected", "released"}
Init == /\ mode = "active"
        /\ clients = [c \in Clients |-> IF c = 1 THEN "leased" ELSE "new"]
        /\ leases = {1}
        /\ unsafeShutdown = FALSE
Acquire == /\ clients[2] = "new"
           /\ (mode = "active" \/ (~RejectClosingAcquire /\ mode = "closing"))
           /\ clients' = [clients EXCEPT ![2] = "leased"]
           /\ leases' = leases \cup {2}
           /\ UNCHANGED <<mode, unsafeShutdown>>
Disconnect(c) == /\ mode = "active"
                 /\ clients[c] \in {"leased", "clean"}
                 /\ clients' = [clients EXCEPT ![c] = IF @ = "clean" THEN "clean-disconnected" ELSE "disconnected"]
                 /\ UNCHANGED <<mode, leases, unsafeShutdown>>
CleanupProof(c) == /\ mode = "active"
                   /\ clients[c] \in {"leased", "disconnected"}
                   /\ clients' = [clients EXCEPT ![c] = IF @ = "leased" THEN "clean" ELSE "clean-disconnected"]
                   /\ UNCHANGED <<mode, leases, unsafeShutdown>>
Release(c) == /\ mode = "active"
              /\ clients[c] \in {"clean", "clean-disconnected"}
              /\ clients' = [clients EXCEPT ![c] = "released"]
              /\ leases' = leases \ {c}
              /\ UNCHANGED <<mode, unsafeShutdown>>
BeginClose == /\ mode = "active" /\ leases = {}
              /\ mode' = "closing"
              /\ UNCHANGED <<clients, leases, unsafeShutdown>>
FinishClose == /\ mode = "closing"
               /\ mode' = "closed"
               /\ unsafeShutdown' = (leases # {})
               /\ UNCHANGED <<clients, leases>>
OwnerCrash == /\ mode \in {"active", "closing"}
              /\ mode' = "failed"
              /\ UNCHANGED <<clients, leases, unsafeShutdown>>
Next == Acquire \/ BeginClose \/ FinishClose \/ OwnerCrash
        \/ (\E c \in Clients: Disconnect(c) \/ CleanupProof(c) \/ Release(c))
Spec == Init /\ [][Next]_vars
TypeOK == /\ mode \in {"active", "closing", "closed", "failed"}
          /\ clients \in [Clients -> Phases]
          /\ leases \subseteq Clients
          /\ unsafeShutdown \in BOOLEAN
UnreleasedLeasesRemainOwned == leases = {c \in Clients: clients[c] \notin {"new", "released"}}
NoPrematureShutdown == ~unsafeShutdown
=============================================================================
