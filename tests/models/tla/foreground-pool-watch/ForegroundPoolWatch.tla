--------------------------- MODULE ForegroundPoolWatch --------------------------
\* HACK-2096: a foreground native start whose provider VM is lost exits
\* non-zero within a bound, after naming the lost VM and the recovery command,
\* and never once its graph is confirmed stopped.
\* Time is discrete ticks that pass only while the VM is lost under an
\* unsettled start. The watch's check and its exit are urgent: a tick cannot
\* pass a due check or a due exit.
\* `WatchForeground = FALSE` is the old code, where only a detached owner
\* watched its pool. `DisarmOnStop = FALSE` is the first HACK-2096 change,
\* whose watch stayed armed while the start finished after its graph stopped.
EXTENDS Naturals

CONSTANTS WatchForeground, DisarmOnStop, Check, Grace
VARIABLES phase, live, watching, seen, deadline, t, reported, code, graphStopped
vars == <<phase, live, watching, seen, deadline, t, reported, code,
          graphStopped>>

Bound == Check + Grace
\* The graph owner still runs: the start waits on it.
Running == {"Starting", "Serving", "Stopping"}
\* The watch may be armed: the graph runs, or the start is finishing after it.
Watched == Running \cup {"Finishing"}

TypeOK ==
    /\ phase \in {"Selecting", "Starting", "Serving", "Stopping", "Finishing",
                  "Exited", "Settled"}
    /\ live \in BOOLEAN /\ watching \in BOOLEAN /\ seen \in BOOLEAN
    /\ deadline \in 0..Bound /\ t \in 0..(Bound + 1)
    /\ reported \in BOOLEAN /\ code \in {0, 1, 130}
    /\ graphStopped \in BOOLEAN

Init ==
    /\ phase = "Selecting" /\ live = TRUE /\ watching = FALSE
    /\ seen = FALSE /\ deadline = 0 /\ t = 0
    /\ reported = FALSE /\ code = 0 \* 0: not ended yet
    /\ graphStopped = FALSE

\* `runtime up` admitted this boot; the watch binds to it (detached or not).
Admit ==
    /\ phase = "Selecting" /\ live
    /\ phase' = "Starting" /\ watching' = WatchForeground
    /\ UNCHANGED <<live, seen, deadline, t, reported, code, graphStopped>>

\* The owner reports ready or started: `serving`, so the grace becomes 0.
Ready ==
    /\ phase = "Starting" /\ live
    /\ phase' = "Serving"
    /\ UNCHANGED <<live, watching, seen, deadline, t, reported, code,
                   graphStopped>>

\* The user's stop (`stopping`: no longer serving) or a startup failure. The
\* graph owner is still unwinding, so the start still waits on it.
UserStop ==
    /\ phase \in {"Starting", "Serving"}
    /\ phase' = "Stopping" /\ code' = 130
    /\ UNCHANGED <<live, watching, seen, deadline, t, reported, graphStopped>>

SettleFailed ==
    /\ phase = "Starting"
    /\ phase' = "Stopping" /\ code' = 1
    /\ UNCHANGED <<live, watching, seen, deadline, t, reported, graphStopped>>

\* The final inspection confirms the graph stopped (`graphCleanupConfirmed`).
\* The pool now counts as idle; the start runs lifecycle cleanup, down.after
\* and the finalization acknowledgement. The fix cancels the watch here.
GraphStopped ==
    /\ phase = "Stopping"
    /\ phase' = "Finishing" /\ graphStopped' = TRUE
    /\ watching' = (watching /\ ~DisarmOnStop)
    /\ UNCHANGED <<live, seen, deadline, t, reported, code>>

\* The start settles on its own; its finalizer cancels any watch.
Finish ==
    /\ phase = "Finishing"
    /\ phase' = "Settled" /\ watching' = FALSE
    /\ UNCHANGED <<live, seen, deadline, t, reported, code, graphStopped>>

\* SIGKILL of the provider, a crash, or a pool stop: under a running graph, or
\* (legitimately, as an idle pool) under a start that is only finishing.
LoseVm ==
    /\ live /\ phase \in Watched
    /\ live' = FALSE /\ t' = 0
    /\ UNCHANGED <<phase, watching, seen, deadline, reported, code,
                   graphStopped>>

\* A check sees the gone provider pid or the ended boot and arms the grace,
\* chosen at that moment: 0 once ready, `Grace` otherwise.
Observe ==
    /\ watching /\ ~live /\ ~seen /\ phase \in Watched
    /\ seen' = TRUE
    /\ deadline' = t + (IF phase = "Serving" THEN 0 ELSE Grace)
    /\ UNCHANGED <<phase, live, watching, t, reported, code, graphStopped>>

\* The grace expired with the watch still armed: print the message, exit 1.
ExitOnLoss ==
    /\ watching /\ seen /\ t >= deadline /\ phase \in Watched
    /\ phase' = "Exited" /\ reported' = TRUE /\ code' = 1
    /\ UNCHANGED <<live, watching, seen, deadline, t, graphStopped>>

\* Time passes only while the VM is lost under an unsettled start, and never
\* past a due check (`Check` ticks) or a due exit of an armed watch.
Tick ==
    /\ ~live /\ phase \in Watched /\ t <= Bound
    /\ ~(watching /\ ~seen /\ t >= Check)
    /\ ~(watching /\ seen /\ t >= deadline)
    /\ t' = t + 1
    /\ UNCHANGED <<phase, live, watching, seen, deadline, reported, code,
                   graphStopped>>

Next == Admit \/ Ready \/ UserStop \/ SettleFailed \/ GraphStopped \/ Finish
        \/ LoseVm \/ Observe \/ ExitOnLoss \/ Tick
Spec == Init /\ [][Next]_vars

\* A start never waits on a graph owner in a lost VM longer than the bound.
BoundedExit == (phase \in Running /\ ~live) => t <= Bound
\* Once the graph is confirmed stopped, a pool stop never ends the start as a
\* lost VM: it finishes down.after and the finalization acknowledgement.
NoExitAfterGraphStopped == phase = "Exited" => ~graphStopped
\* Sanity: the watch exits only for a lost VM, non-zero, after naming it.
ExitReported == phase = "Exited" => (~live /\ reported /\ code = 1)
=============================================================================
