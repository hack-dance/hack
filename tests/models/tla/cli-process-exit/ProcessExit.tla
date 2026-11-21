------------------------- MODULE ProcessExit -------------------------
(* How the CLI process ends (src/lib/process-exit.ts, index.ts).
   The command returns its exit code; work it started may continue and is
   registered as a hold (stdio MCP session, MCP tool call, foreground daemon,
   TUI renderer close, TUI action child). `exitWhenDone` waits until no hold
   is pending -- re-checking, since a settling hold can register another --
   then ends stdout/stderr and exits once `end` reports the data flushed.
   Holds may settle and register in any order. *)
EXTENDS Naturals, FiniteSets
CONSTANTS Holds, Recheck, EndBeforeExit
VARIABLES phase, pending, used, snap, buffered
vars == <<phase, pending, used, snap, buffered>>

Init == /\ phase = "running" /\ pending = {} /\ used = {}
        /\ snap = {} /\ buffered = FALSE

\* Work registers a hold: the command itself, or a hold as it settles.
Register(h) == /\ phase # "exited" /\ h \notin used
               /\ (phase = "running" \/ pending # {})
               /\ pending' = pending \cup {h} /\ used' = used \cup {h}
               /\ UNCHANGED <<phase, snap, buffered>>
Settle(h) == /\ h \in pending /\ pending' = pending \ {h}
             /\ UNCHANGED <<phase, used, snap, buffered>>
\* Output may be written while the process runs or holds are pending.
Write == /\ phase \in {"running", "waiting"} /\ buffered' = TRUE
         /\ UNCHANGED <<phase, pending, used, snap>>

CommandReturns == /\ phase = "running"
                  /\ phase' = "waiting" /\ snap' = pending
                  /\ UNCHANGED <<pending, used, buffered>>
\* `await Promise.all([...holds])` resolves once its snapshot settled.
SnapshotSettled ==
    /\ phase = "waiting" /\ snap \cap pending = {}
    /\ IF Recheck /\ pending # {}
         THEN phase' = "waiting" /\ snap' = pending   \* loop again
         ELSE phase' = "flushing" /\ snap' = {}
    /\ UNCHANGED <<pending, used, buffered>>
\* `end(cb)` delivers buffered output; `write("", cb)` may not (Bun pipes).
EndStreams == /\ phase = "flushing"
              /\ phase' = "ended" /\ buffered' = (buffered /\ ~EndBeforeExit)
              /\ UNCHANGED <<pending, used, snap>>
Exit == /\ phase = "ended" /\ phase' = "exited"
        /\ UNCHANGED <<pending, used, snap, buffered>>

Next == \/ \E h \in Holds : Register(h) \/ Settle(h)
        \/ Write \/ CommandReturns \/ SnapshotSettled \/ EndStreams \/ Exit
Spec == Init /\ [][Next]_vars

TypeOK == /\ phase \in {"running", "waiting", "flushing", "ended", "exited"}
          /\ pending \subseteq Holds /\ used \subseteq Holds
          /\ snap \subseteq Holds /\ buffered \in BOOLEAN
\* The process never ends while held work is still running.
NoExitWithPendingHold == phase \in {"flushing", "ended", "exited"} => pending = {}
\* Everything written before the exit was delivered.
NoLostOutput == phase = "exited" => ~buffered
=======================================================================
