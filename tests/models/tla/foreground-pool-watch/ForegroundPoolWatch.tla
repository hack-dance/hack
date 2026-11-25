--------------------------- MODULE ForegroundPoolWatch --------------------------
\* HACK-2096: a foreground native start whose provider VM is lost exits
\* non-zero within a bound, after naming the lost VM and the recovery command.
\* Time is discrete ticks that pass only while the VM is lost under an
\* unsettled start. The watch's check and its exit are urgent: a tick cannot
\* pass a due check or a due exit. `WatchForeground = FALSE` is the old code,
\* where only a detached owner watched its pool.
EXTENDS Naturals

CONSTANTS WatchForeground, Check, Grace
VARIABLES phase, live, watching, seen, deadline, t, reported, code
vars == <<phase, live, watching, seen, deadline, t, reported, code>>

Bound == Check + Grace
Running == {"Starting", "Serving"}

TypeOK ==
    /\ phase \in {"Selecting", "Starting", "Serving", "Exited", "Settled"}
    /\ live \in BOOLEAN /\ watching \in BOOLEAN /\ seen \in BOOLEAN
    /\ deadline \in 0..Bound /\ t \in 0..(Bound + 1)
    /\ reported \in BOOLEAN /\ code \in {0, 1, 130}

Init ==
    /\ phase = "Selecting" /\ live = TRUE /\ watching = FALSE
    /\ seen = FALSE /\ deadline = 0 /\ t = 0
    /\ reported = FALSE /\ code = 0 \* 0: not ended yet

\* `runtime up` admitted this boot; the watch binds to it (detached or not).
Admit ==
    /\ phase = "Selecting" /\ live
    /\ phase' = "Starting" /\ watching' = WatchForeground
    /\ UNCHANGED <<live, seen, deadline, t, reported, code>>

\* The owner reports ready or started: `serving`, so the grace becomes 0.
Ready ==
    /\ phase = "Starting" /\ live
    /\ phase' = "Serving"
    /\ UNCHANGED <<live, watching, seen, deadline, t, reported, code>>

\* SIGKILL of the provider, a crash, or a pool stop under the run.
LoseVm ==
    /\ live /\ phase \in Running
    /\ live' = FALSE /\ t' = 0
    /\ UNCHANGED <<phase, watching, seen, deadline, reported, code>>

\* A check sees the gone provider pid (or the ended boot) and arms the grace,
\* chosen at that moment: 0 once ready, `Grace` while still starting.
Observe ==
    /\ watching /\ ~live /\ ~seen /\ phase \in Running
    /\ seen' = TRUE
    /\ deadline' = t + (IF phase = "Serving" THEN 0 ELSE Grace)
    /\ UNCHANGED <<phase, live, watching, t, reported, code>>

\* The grace expired on an unsettled start: print the message, exit 1.
ExitOnLoss ==
    /\ seen /\ t >= deadline /\ phase \in Running
    /\ phase' = "Exited" /\ reported' = TRUE /\ code' = 1
    /\ UNCHANGED <<live, watching, seen, deadline, t>>

\* The start finishes on its own: a failure it reports, or the user's stop.
\* Settling stops the watch, so it never exits a second time.
SettleFailed ==
    /\ phase = "Starting"
    /\ phase' = "Settled" /\ code' = 1
    /\ UNCHANGED <<live, watching, seen, deadline, t, reported>>

UserStop ==
    /\ phase \in Running
    /\ phase' = "Settled" /\ code' = 130
    /\ UNCHANGED <<live, watching, seen, deadline, t, reported>>

\* Time passes only while the VM is lost under a running start, and never past
\* a due check (`Check` ticks) or a due exit.
Tick ==
    /\ ~live /\ phase \in Running /\ t <= Bound
    /\ ~(watching /\ ~seen /\ t >= Check)
    /\ ~(seen /\ t >= deadline)
    /\ t' = t + 1
    /\ UNCHANGED <<phase, live, watching, seen, deadline, reported, code>>

Next == Admit \/ Ready \/ LoseVm \/ Observe \/ ExitOnLoss
        \/ SettleFailed \/ UserStop \/ Tick
Spec == Init /\ [][Next]_vars

\* A foreground start never outlives its lost VM by more than the bound.
BoundedExit == (phase \in Running /\ ~live) => t <= Bound
\* The watch exits only for a lost VM, non-zero, after naming it.
ExitReported == phase = "Exited" => (~live /\ reported /\ code = 1)
\* A live VM never ends the start.
NoExitOnLiveVm == live => phase /= "Exited"
=============================================================================
