--------------------------- MODULE RestartIntent ---------------------------
\* HACK-1953: an interrupted `hack restart` must never leave a pending restart
\* that both `hack up` and `hack restart` refuse. A restart saves a `prepared`
\* intent bound to the exact old run, asks the old run's foreground owner to
\* stop, and marks the intent `cleaned` only after that stop is confirmed.
\* The old owner stops on that request or on its own Ctrl-C; either way it
\* retires itself. `up` refuses while any intent is pending.
\*
\* OwnGroup: the restart's stop request runs in its own process group, so the
\* terminal's Ctrl-C reaches only the restart frontend, which lets the stop
\* finish. Otherwise the request dies with the interrupt and the restart exits
\* with its prepared intent kept.
\* ResumeStopped: a later restart accepts a prepared intent whose old run its
\* owner already stopped (it confirms the stopped graph from fresh
\* observations). Otherwise a prepared intent requires an active graph.
\* A crash (SIGKILL, closed terminal) of the restart frontend is always
\* possible once and keeps the intent; no process group choice prevents it.
EXTENDS Naturals, TLC
CONSTANTS OwnGroup, ResumeStopped
VARIABLES graph, owner, requested, intent, restart, interrupted, crashed,
          attempts, replaced
vars == <<graph, owner, requested, intent, restart, interrupted, crashed,
          attempts, replaced>>

TypeOK ==
    /\ graph \in {"active", "stopped"}
    /\ owner \in {"live", "retired"}
    /\ requested \in BOOLEAN
    /\ intent \in {"none", "prepared", "cleaned"}
    /\ restart \in {"idle", "stopping", "starting", "canceled", "failed", "done"}
    /\ interrupted \in BOOLEAN
    /\ crashed \in BOOLEAN
    /\ attempts \in 0..2
    /\ replaced \in BOOLEAN

Init == /\ graph = "active" /\ owner = "live" /\ requested = FALSE
        /\ intent = "none" /\ restart = "idle" /\ interrupted = FALSE
        /\ crashed = FALSE /\ attempts = 0 /\ replaced = FALSE

\* The commands a person can run once no restart frontend is running.
Quiet == restart \in {"idle", "canceled", "failed", "done"}
UpAccepts == intent = "none" /\ graph = "stopped" /\ owner = "retired"
RestartAccepts ==
    \/ intent = "none" /\ graph = "active"
    \/ intent = "cleaned"
    \/ intent = "prepared" /\ graph = "active"
    \/ intent = "prepared" /\ ResumeStopped /\ graph = "stopped"
       /\ owner = "retired"

\* Preflight is abstracted: it stops nothing and refuses a changed mapping.
\* A new restart saves its intent; a resumed one keeps the saved selection.
BeginRestart ==
    /\ Quiet /\ ~replaced /\ attempts < 2 /\ RestartAccepts
    /\ restart' = IF intent = "cleaned" THEN "starting" ELSE "stopping"
    /\ intent' = IF intent = "none" THEN "prepared" ELSE intent
    /\ requested' = FALSE /\ attempts' = attempts + 1
    /\ interrupted' = FALSE
    /\ UNCHANGED <<graph, owner, crashed, replaced>>

\* The stop request reaches the old owner.
Request == /\ restart = "stopping" /\ owner = "live" /\ ~requested
           /\ requested' = TRUE
           /\ UNCHANGED <<graph, owner, intent, restart, interrupted, crashed,
                          attempts, replaced>>

\* The old owner stops its graph with data retained and retires, on the
\* restart's request or on a Ctrl-C in its own terminal.
OwnerStops == /\ owner = "live"
              /\ graph' = "stopped" /\ owner' = "retired"
              /\ UNCHANGED <<requested, intent, restart, interrupted, crashed,
                             attempts, replaced>>

\* The terminal's one Ctrl-C reaches the restart while it is stopping the old run.
Interrupt ==
    /\ restart = "stopping" /\ ~interrupted
    /\ interrupted' = TRUE
    /\ restart' = IF OwnGroup THEN restart ELSE "failed"
    /\ UNCHANGED <<graph, owner, requested, intent, crashed, attempts,
                   replaced>>

Crash == /\ restart \in {"stopping", "starting"} /\ ~crashed
         /\ crashed' = TRUE /\ restart' = "failed"
         /\ UNCHANGED <<graph, owner, requested, intent, interrupted,
                        attempts, replaced>>

\* The down confirms the stopped graph and the old frontend's finalization.
\* An interrupted restart then ends as an ordinary stopped project.
StopConfirmed ==
    /\ restart = "stopping" /\ graph = "stopped" /\ owner = "retired"
    /\ intent' = IF interrupted THEN "none" ELSE "cleaned"
    /\ restart' = IF interrupted THEN "canceled" ELSE "starting"
    /\ UNCHANGED <<graph, owner, requested, interrupted, crashed, attempts,
                   replaced>>

\* The replacement reaches ready from the retained data; readiness retires the intent.
Ready == /\ restart = "starting" /\ intent = "cleaned"
         /\ restart' = "done" /\ intent' = "none" /\ replaced' = TRUE
         /\ graph' = "active"
         /\ UNCHANGED <<owner, requested, interrupted, crashed, attempts>>

Next == BeginRestart \/ Request \/ OwnerStops \/ Interrupt \/ Crash
        \/ StopConfirmed \/ Ready
Spec == Init /\ [][Next]_vars

\* Once no frontend runs and the old owner has stopped, `up` or `restart`
\* accepts the state: their refusals never point at each other.
NoRecoveryLoop ==
    (Quiet /\ owner = "retired" /\ ~replaced) => (UpAccepts \/ RestartAccepts)
\* `up` never starts fresh while the exact old selection is pending.
NoFreshFallback == UpAccepts => intent = "none"
\* A replacement starts only after the old run's stop was confirmed.
NoReplacementOverLiveOwner == replaced => owner = "retired"
\* A canceled restart leaves a plain stopped project that `up` resumes.
CanceledIsClean == restart = "canceled" => UpAccepts
\* The first Ctrl-C (without a crash) ends with no pending restart.
InterruptLeavesNoIntent ==
    (interrupted /\ ~crashed /\ Quiet /\ ~replaced) => intent = "none"
=============================================================================
