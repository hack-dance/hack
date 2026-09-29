----------------------------- MODULE Startup -----------------------------
EXTENDS Naturals, TLC
CONSTANTS CommitBeforeGrant, MaxClients
VARIABLES watchdog, backend, requested, granted, killed, clients
vars == <<watchdog, backend, requested, granted, killed, clients>>

Init == /\ watchdog = "watching" /\ backend = "starting"
        /\ requested = FALSE /\ granted = FALSE /\ killed = FALSE
        /\ clients = 0

Request == /\ backend = "starting" /\ ~requested
           /\ requested' = TRUE
           /\ UNCHANGED <<watchdog, backend, granted, killed, clients>>

\* Commit relinquishes timeout authority before the grant can become observable.
Commit == /\ CommitBeforeGrant /\ requested /\ watchdog = "watching"
          /\ watchdog' = "committed"
          /\ UNCHANGED <<backend, requested, granted, killed, clients>>
Grant == /\ requested /\ ~granted
         /\ (watchdog = "committed" \/ (~CommitBeforeGrant /\ watchdog = "watching"))
         /\ granted' = TRUE
         /\ UNCHANGED <<watchdog, backend, requested, killed, clients>>
Release == /\ granted /\ watchdog \in {"watching", "committed"}
           /\ watchdog' = "released"
           /\ UNCHANGED <<backend, requested, granted, killed, clients>>

Timeout == /\ watchdog = "watching"
           /\ watchdog' = "timedout" /\ backend' = "dead" /\ killed' = TRUE
           /\ clients' = 0 /\ UNCHANGED <<requested, granted>>
Ready == /\ granted /\ backend = "starting" /\ backend' = "ready"
         /\ UNCHANGED <<watchdog, requested, granted, killed, clients>>
Attach == /\ backend = "ready" /\ clients < MaxClients
          /\ clients' = clients + 1
          /\ UNCHANGED <<watchdog, backend, requested, granted, killed>>
Detach == /\ clients > 0 /\ clients' = clients - 1
          /\ UNCHANGED <<watchdog, backend, requested, granted, killed>>
Retire == /\ backend = "ready" /\ clients = 0 /\ backend' = "dead"
          /\ UNCHANGED <<watchdog, requested, granted, killed, clients>>
BackendCrash == /\ backend # "dead" /\ backend' = "dead" /\ clients' = 0
                /\ UNCHANGED <<watchdog, requested, granted, killed>>
WatchdogCrash == /\ watchdog \in {"watching", "committed"}
                 /\ watchdog' = "lost"
                 /\ UNCHANGED <<backend, requested, granted, killed, clients>>

Next == Request \/ Commit \/ Grant \/ Release \/ Timeout \/ Ready \/ Attach
        \/ Detach \/ Retire \/ BackendCrash \/ WatchdogCrash
Spec == Init /\ [][Next]_vars
TypeOK == /\ watchdog \in {"watching", "committed", "released", "timedout", "lost"}
          /\ backend \in {"starting", "ready", "dead"}
          /\ requested \in BOOLEAN /\ granted \in BOOLEAN /\ killed \in BOOLEAN
          /\ clients \in 0..MaxClients
NoRevokedGrant == ~(granted /\ killed)
=============================================================================
