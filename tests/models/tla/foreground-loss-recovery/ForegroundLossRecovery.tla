------------------------- MODULE ForegroundLossRecovery -------------------------
\* HACK-2096: what a foreground `hack up` or `hack restart` tells the user after
\* its provider VM is lost, and whether following that advice works.
\*
\* The pool watch starts right after `runtime up`, so the start is lost at one
\* of four points:
\*   Preparing: no service of this run requested yet (resolve, review, image
\*     builds and pulls, restore selection);
\*   Requested: services requested, the graph not yet both reported ready by
\*     the runtime and mapped (a ready but unmapped fresh `up` is still here);
\*   GraphReady: ready and mapped, the rest of the frontend's readiness work
\*     (HTTPS, `up.after`, and for a restart the retirement of its pending
\*     intent and its operation lock) still running;
\*   Serving.
\* The user then runs exactly the commands the message names, in order.
\*
\* `recorded` says whether a run record exists for `hack down --recover` to
\* find before services are requested: a resumed retained run, or a
\* restart's old run. A fresh `up` has none until its mapping is saved.
\*
\* Constants select the code:
\*   MessageRule = "stage": this fix. Preparing names `hack down --recover`,
\*     then `hack up` (a fresh `up`: `hack up` alone); Requested names no
\*     command (HACK-2714); GraphReady and Serving name down, then up.
\*   "graph": PR #1253 at a6c4cba: down, then up once the graph was ready, and
\*     no command before it, Preparing included.
\*   "intent": the stage rule, except that a run lost once ready names
\*     `hack restart` while the restart intent is pending (the old intent rule,
\*     isolated where it differs).
\*   "old": PR #1253 at cd0ebff10: everywhere, down then `hack restart` while
\*     an intent is pending, else down then up.
\*   ReleaseLock: the lost start releases the restart lock before it exits.
\*   RetireIntent: `hack down --recover` retires a cleaned restart intent once
\*     the run is stopped with data kept, when the restart lock is free.
EXTENDS Naturals, Sequences

CONSTANTS MessageRule, ReleaseLock, RetireIntent

VARIABLES kind, recorded, start, lostAt, receipt, intent, lock, msg, todo,
          outcome
vars == <<kind, recorded, start, lostAt, receipt, intent, lock, msg, todo,
          outcome>>

Commands == {"down", "up", "restart"}
Stages == {"Preparing", "Requested", "GraphReady", "Serving"}

TypeOK ==
    /\ kind \in {"up", "restart"}
    /\ recorded \in BOOLEAN
    /\ start \in Stages \cup {"Lost"}
    /\ lostAt \in Stages \cup {"none"}
    /\ receipt \in {"none", "stopped", "unready", "ready"}
    /\ intent \in {"none", "cleaned"}
    /\ lock \in BOOLEAN
    /\ msg \in {"none", "up", "downUp", "downRestart", "inspect"}
    /\ todo \in Seq(Commands)
    /\ outcome \in {"pending", "ok", "refused"}

\* A restart's replacement starts only after the old run was stopped and its
\* intent marked `cleaned`; the restart holds its operation lock throughout,
\* and the old run's record stays until the replacement is ready. An `up`
\* either resumes a stopped retained run or starts fresh with no record.
Init ==
    /\ kind \in {"up", "restart"}
    /\ recorded \in BOOLEAN
    /\ kind = "restart" => recorded
    /\ start = "Preparing" /\ lostAt = "none"
    /\ receipt = IF recorded THEN "stopped" ELSE "none"
    /\ intent = IF kind = "restart" THEN "cleaned" ELSE "none"
    /\ lock = (kind = "restart")
    /\ msg = "none" /\ todo = <<>> /\ outcome = "pending"

\* The first service of this run is requested (`graph.onRequested`).
Request ==
    /\ start = "Preparing"
    /\ start' = "Requested" /\ receipt' = "unready"
    /\ UNCHANGED <<kind, recorded, lostAt, intent, lock, msg, todo, outcome>>

\* The runtime reported the graph ready and the mapping is saved
\* (`graph.onReady`, after `ensureMapping`).
GraphReady ==
    /\ start = "Requested"
    /\ start' = "GraphReady" /\ receipt' = "ready"
    /\ UNCHANGED <<kind, recorded, lostAt, intent, lock, msg, todo, outcome>>

\* The frontend's readiness work finished. For a restart, its `onReady`
\* retires the intent and releases the lock, then `ready` progress follows.
Serve ==
    /\ start = "GraphReady"
    /\ start' = "Serving"
    /\ intent' = "none" /\ lock' = FALSE
    /\ UNCHANGED <<kind, recorded, lostAt, receipt, msg, todo, outcome>>

ByIntent == IF intent = "cleaned" THEN "downRestart" ELSE "downUp"

StageMessage(at) ==
    CASE at = "Preparing" -> IF recorded THEN "downUp" ELSE "up"
      [] at = "Requested" -> "inspect"
      [] OTHER -> "downUp"

Message(at) ==
    CASE MessageRule = "stage" -> StageMessage(at)
      [] MessageRule = "graph" ->
            IF at \in {"GraphReady", "Serving"} THEN "downUp" ELSE "inspect"
      [] MessageRule = "intent" ->
            IF at \in {"GraphReady", "Serving"} THEN ByIntent
            ELSE StageMessage(at)
      [] OTHER -> ByIntent

Steps(m) ==
    CASE m = "up" -> <<"up">>
      [] m = "downUp" -> <<"down", "up">>
      [] m = "downRestart" -> <<"down", "restart">>
      [] OTHER -> <<>>

\* The pool watch sees the lost VM, prints the message, runs `beforeLostExit`
\* (the restart's lock release) and exits 1; nothing else of the start runs.
Lose ==
    /\ start \in Stages
    /\ start' = "Lost" /\ lostAt' = start
    /\ msg' = Message(start)
    /\ todo' = Steps(Message(start))
    /\ lock' = (lock /\ ~ReleaseLock)
    /\ outcome' = IF Steps(Message(start)) = <<>> THEN "ok" ELSE "pending"
    /\ UNCHANGED <<kind, recorded, receipt, intent>>

\* `hack down --recover` depends on where the start was lost, not on what the
\* message said. Lost while preparing, the record (if any) is still the
\* stopped retained run, and a fresh `up` has none (`not_started`); lost once
\* ready and mapped, the run is stopped with data kept. Lost in between, no
\* cross-boot retirement exists yet (HACK-2714).
DownAccepts == lostAt \in {"Preparing", "GraphReady", "Serving"}
\* `hack up` refuses a pending restart and a run that is not stopped.
UpAccepts == intent = "none" /\ receipt \in {"none", "stopped"}
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
            /\ receipt' = CASE c = "down" ->
                                 IF receipt = "none" THEN "none" ELSE "stopped"
                            [] OTHER -> "ready"
            /\ intent' = IF c = "down" /\ RetireIntent /\ ~lock
                         THEN "none"
                         ELSE IF c = "restart" THEN "none" ELSE intent
    /\ UNCHANGED <<kind, recorded, start, lostAt, lock, msg>>

Next == Request \/ GraphReady \/ Serve \/ Lose \/ Step
Spec == Init /\ [][Next]_vars

\* Every command the message names, run in order, is accepted.
NoRefusedAdvice == outcome # "refused"
\* The message withholds a command only when none can work: the run was lost
\* after its services were requested and before it was ready and mapped.
NoNeedlessWithholding == msg = "inspect" => lostAt = "Requested"
\* Reachability witness (expected to fail): a lost restart is recovered by
\* following its message.
NoRestartRecovery == ~(kind = "restart" /\ outcome = "ok" /\ msg # "inspect")
=============================================================================
