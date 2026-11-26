------------------------- MODULE ForegroundLossRecovery -------------------------
\* HACK-2096: what a foreground `hack up` or `hack restart` tells the user after
\* its provider VM is lost, and whether following that advice works.
\*
\* The start is lost at one of three points: before the runtime reported its
\* graph ready (`Starting`), after that but before the frontend's own readiness
\* work finished (`GraphReady`: mapping, HTTPS, `up.after`, and for a restart the
\* retirement of its pending intent and its operation lock), or once serving.
\* The user then runs exactly the commands the message names, in order.
\*
\* Constants select the code:
\*   MessageRule = "intent": the message reads the restart intent at loss time
\*     and names `hack restart` while one is pending (PR #1253 at cd0ebff10);
\*     "ready": it depends on whether the graph was ready (this fix).
\*   ReleaseLock: the lost start releases the restart lock before it exits.
\*   RetireIntent: `hack down --recover` retires a cleaned restart intent once
\*     the run is stopped with data kept, when the restart lock is free.
EXTENDS Naturals, Sequences

CONSTANTS MessageRule, ReleaseLock, RetireIntent

VARIABLES kind, start, lostAt, receipt, intent, lock, msg, todo, outcome
vars == <<kind, start, lostAt, receipt, intent, lock, msg, todo, outcome>>

Commands == {"down", "up", "restart"}

TypeOK ==
    /\ kind \in {"up", "restart"}
    /\ start \in {"Starting", "GraphReady", "Serving", "Lost"}
    /\ lostAt \in {"none", "Starting", "GraphReady", "Serving"}
    /\ receipt \in {"unready", "ready", "stopped"}
    /\ intent \in {"none", "cleaned"}
    /\ lock \in BOOLEAN
    /\ msg \in {"none", "downUp", "downRestart", "inspect"}
    /\ todo \in Seq(Commands)
    /\ outcome \in {"pending", "ok", "refused"}

\* A restart's replacement starts only after the old run was stopped and its
\* intent marked `cleaned`; the restart holds its operation lock throughout.
Init ==
    /\ kind \in {"up", "restart"}
    /\ start = "Starting" /\ lostAt = "none" /\ receipt = "unready"
    /\ intent = IF kind = "restart" THEN "cleaned" ELSE "none"
    /\ lock = (kind = "restart")
    /\ msg = "none" /\ todo = <<>> /\ outcome = "pending"

\* The runtime reports the graph ready: its receipt is `ready-observed`
\* (`graph.onReady` in `startNativeProjectAttempt`).
GraphReady ==
    /\ start = "Starting"
    /\ start' = "GraphReady" /\ receipt' = "ready"
    /\ UNCHANGED <<kind, lostAt, intent, lock, msg, todo, outcome>>

\* The frontend's readiness work finished. For a restart, its `onReady`
\* retires the intent and releases the lock, then `ready` progress follows.
Serve ==
    /\ start = "GraphReady"
    /\ start' = "Serving"
    /\ intent' = "none" /\ lock' = FALSE
    /\ UNCHANGED <<kind, lostAt, receipt, msg, todo, outcome>>

Message(at) ==
    IF MessageRule = "intent"
    THEN IF intent = "cleaned" THEN "downRestart" ELSE "downUp"
    ELSE IF at \in {"GraphReady", "Serving"} THEN "downUp" ELSE "inspect"

Steps(m) ==
    CASE m = "downUp" -> <<"down", "up">>
      [] m = "downRestart" -> <<"down", "restart">>
      [] OTHER -> <<>>

\* The pool watch sees the lost VM, prints the message, runs `beforeLostExit`
\* (the restart's lock release) and exits 1; nothing else of the start runs.
Lose ==
    /\ start \in {"Starting", "GraphReady", "Serving"}
    /\ start' = "Lost" /\ lostAt' = start
    /\ msg' = Message(start)
    /\ todo' = Steps(Message(start))
    /\ lock' = (lock /\ ~ReleaseLock)
    /\ outcome' = IF Steps(Message(start)) = <<>> THEN "ok" ELSE "pending"
    /\ UNCHANGED <<kind, receipt, intent>>

\* `hack down --recover`: a run lost before its graph was ready has no
\* cross-boot retirement (HACK-2714); a ready one is stopped with data kept.
DownAccepts == receipt # "unready"
\* `hack up` refuses a pending restart and a run that is not stopped.
UpAccepts == intent = "none" /\ receipt = "stopped"
\* `hack restart` refuses while its lock is held ("already owned"), and a
\* stopped run with nothing pending ("needs an active graph").
RestartAccepts == ~lock /\ intent = "cleaned" /\ receipt = "stopped"

Accepts(c) ==
    CASE c = "down" -> DownAccepts
      [] c = "up" -> UpAccepts
      [] OTHER -> RestartAccepts

Step ==
    /\ start = "Lost" /\ outcome = "pending" /\ todo # <<>>
    /\ LET c == Head(todo) IN
       IF ~Accepts(c)
       THEN /\ outcome' = "refused"
            /\ UNCHANGED <<receipt, intent, todo>>
       ELSE /\ todo' = Tail(todo)
            /\ outcome' = IF Tail(todo) = <<>> THEN "ok" ELSE "pending"
            /\ receipt' = CASE c = "down" -> "stopped"
                            [] OTHER -> "ready"
            /\ intent' = IF c = "down" /\ RetireIntent /\ ~lock
                         THEN "none"
                         ELSE IF c = "restart" THEN "none" ELSE intent
    /\ UNCHANGED <<kind, start, lostAt, lock, msg>>

Next == GraphReady \/ Serve \/ Lose \/ Step
Spec == Init /\ [][Next]_vars

\* Every command the message names, run in order, is accepted.
NoRefusedAdvice == outcome # "refused"
\* The message withholds a command only when none can work: the run was lost
\* before its graph was ready.
NoNeedlessWithholding == msg = "inspect" => lostAt = "Starting"
\* Reachability witness (expected to fail): a lost restart is recovered by
\* following its message.
NoRestartRecovery == ~(kind = "restart" /\ outcome = "ok" /\ msg # "inspect")
=============================================================================
