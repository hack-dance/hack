------------------------- MODULE ForegroundLossRecovery -------------------------
\* HACK-2096: what a foreground `hack up` or `hack restart` tells the user after
\* its provider VM is lost, and whether following that advice works.
\*
\* The pool watch starts right after `runtime up`, so the VM dies under the
\* start at one of four points:
\*   Preparing: no service of this run requested yet (resolve, review, image
\*     builds and pulls, restore selection);
\*   Requested: services requested, the graph not yet both reported ready by
\*     the runtime and mapped (a ready but unmapped fresh `up` is still here);
\*   GraphReady: ready and mapped, the rest of the frontend's readiness work
\*     (HTTPS, `up.after`, and for a restart the retirement of its pending
\*     intent and its operation lock) still running;
\*   Serving.
\* Two things then race to end the start: the pool watch (it prints the
\* message, releases the restart lock and exits 1), or the start's own error
\* path (a request, image preparation or the foreground unwind fails first;
\* on a real VM within 0.13 to 1.6 s). The user then runs exactly the commands
\* the printed message names, in order.
\*
\* `recorded` says whether a run record exists for `hack down --recover` to
\* find before services are requested: a resumed retained run, or a
\* restart's old run. A fresh `up` has none until its mapping is saved.
\* `leftover`: a VM lost seconds after a `hack down` removed the recorded
\* run's containers may bring them back on the next boot, stopped, because the
\* guest engine's removal had not reached its disk (real-VM row 8).
\* `ports`: the project publishes a port, so its run holds bridge routes once
\* ready. A run without one has no route to prove its relay owner by, only the
\* relay owner's own publication, which the owner's unwind removes (HACK-2711).
\* `left`: what the dead owner of a recorded run lost at Requested left in its
\* receipt: "failed" when its own unwind ran (`failed-retained`), "restoring"
\* when it died without unwinding (killed, crashed, or taken down with the CLI
\* that exits 1), so the admitted restore's phase stays.
\*
\* Constants select the code:
\*   MessageRule = "recover": this fix. As "stage", except that a recorded run
\*     lost at Requested names down, then up (HACK-2714).
\*   "stage": PR #1253 as merged. Preparing names `hack down --recover`,
\*     then `hack up` (a fresh `up`: `hack up` alone); Requested names no
\*     command; GraphReady and Serving name down, then up.
\*   "graph": PR #1253 at a6c4cba: down, then up once the graph was ready, and
\*     no command before it, Preparing included.
\*   "intent": the stage rule, except that a run lost once ready names
\*     `hack restart` while the restart intent is pending (the old intent rule,
\*     isolated where it differs).
\*   "old": PR #1253 at cd0ebff10: everywhere, down then `hack restart` while
\*     an intent is pending, else down then up.
\*   ErrorRule = "stage": the start's own error goes through the same
\*     classification and prints the same stage message; "generic": PR #1253
\*     at a8705a39, the error's own text (image preparation names `hack up`;
\*     the foreground unwind names `hack down --recover`).
\*   ReleaseLock: the lost start releases the restart lock before it exits.
\*   RetireIntent: `hack down --recover` retires a cleaned restart intent once
\*     the run is stopped with data kept, when the restart lock is free.
\*   RepairLeftover: `hack down --recover` removes containers the receipt
\*     records removed that a lost VM brought back (HACK-2719: without the
\*     owner, under its retirement lock).
\*   StorageBarrier: a cleanup flushes the guest disk before it records the
\*     removal, so a lost VM brings nothing back (HACK-2719).
\*   CrossBootStart: which starts lost before ready the runtime's cross-boot
\*     dead-owner recovery retires (HACK-2714). "restoring": this fix, a
\*     `failed-retained` or a `restoring` receipt; "failed": 01ab67fa, only
\*     `failed-retained`; "none": the runtime before, only a ready run.
\*   RouteProof = "exit": a run with no route proves its dead owner's relay by
\*     the relay's clean exit (HACK-2711); "pinned": only a still-published
\*     relay endpoint counts, which a no-port run's unwound owner no longer has.
\*   ClassifyRule = "veto": a start error counts as a lost VM from the pool
\*     record (a gone provider pid in any phase, or an ended boot); only a
\*     `running` record with a live pid vetoes a lost-provider code (this
\*     fix). "round5": c624229e, where only a `running` record's pid was read
\*     and any record naming the boot vetoed, so a provider that died with the
\*     record stuck in `quiescing` or `stopping` was missed. "code": the code
\*     alone suffices (38347515), though the runtime also reports it on a
\*     healthy VM.
\*
\* `stale`: the record names the watched boot in a transitional phase when the
\* provider dies (a `runtime down` from another terminal, or another project's
\* idle stop, died part way).
EXTENDS Naturals, Sequences

CONSTANTS MessageRule, ErrorRule, ReleaseLock, RetireIntent, RepairLeftover,
          ClassifyRule, StorageBarrier, CrossBootStart, RouteProof

VARIABLES kind, recorded, ports, start, lostAt, endedBy, leftover, stale,
          left, receipt, intent, lock, msg, todo, outcome
vars == <<kind, recorded, ports, start, lostAt, endedBy, leftover, stale,
          left, receipt, intent, lock, msg, todo, outcome>>

Commands == {"down", "up", "restart"}
Stages == {"Preparing", "Requested", "GraphReady", "Serving"}

TypeOK ==
    /\ kind \in {"up", "restart"}
    /\ recorded \in BOOLEAN
    /\ ports \in BOOLEAN
    /\ start \in Stages \cup {"Dead", "Lost"}
    /\ lostAt \in Stages \cup {"none"}
    /\ endedBy \in {"none", "watch", "error", "ordinary"}
    /\ leftover \in BOOLEAN
    /\ stale \in BOOLEAN
    /\ left \in {"none", "failed", "restoring"}
    /\ receipt \in {"none", "stopped", "unready", "ready"}
    /\ intent \in {"none", "cleaned"}
    /\ lock \in BOOLEAN
    /\ msg \in {"none", "up", "downUp", "downRestart", "inspect",
                "genericUp", "genericDown", "own"}
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
    /\ ports \in BOOLEAN
    /\ start = "Preparing" /\ lostAt = "none" /\ endedBy = "none"
    /\ leftover = FALSE /\ stale = FALSE /\ left = "none"
    /\ receipt = IF recorded THEN "stopped" ELSE "none"
    /\ intent = IF kind = "restart" THEN "cleaned" ELSE "none"
    /\ lock = (kind = "restart")
    /\ msg = "none" /\ todo = <<>> /\ outcome = "pending"

Frozen == <<kind, recorded, ports, endedBy, leftover, stale, left, msg, todo,
            outcome>>

\* The first service of this run is requested (`graph.onRequested`).
Request ==
    /\ start = "Preparing"
    /\ start' = "Requested" /\ receipt' = "unready"
    /\ UNCHANGED <<lostAt, intent, lock>> /\ UNCHANGED Frozen

\* The runtime reported the graph ready and the mapping is saved
\* (`graph.onReady`, after `ensureMapping`).
GraphReady ==
    /\ start = "Requested"
    /\ start' = "GraphReady" /\ receipt' = "ready"
    /\ UNCHANGED <<lostAt, intent, lock>> /\ UNCHANGED Frozen

\* The frontend's readiness work finished. For a restart, its `onReady`
\* retires the intent and releases the lock, then `ready` progress follows.
Serve ==
    /\ start = "GraphReady"
    /\ start' = "Serving"
    /\ intent' = "none" /\ lock' = FALSE
    /\ UNCHANGED <<lostAt, receipt>> /\ UNCHANGED Frozen

\* The provider VM dies under the start. A recorded run lost before any
\* service was requested may get its removed containers back (row 8), unless
\* the down that removed them flushed the guest disk first. The record may
\* still say `running`, or be stuck in a transitional phase (`stale`) that
\* still names the boot.
Die ==
    /\ start \in Stages
    /\ start' = "Dead" /\ lostAt' = start
    /\ leftover' \in IF recorded /\ start = "Preparing" /\ ~StorageBarrier
                     THEN BOOLEAN ELSE {FALSE}
    /\ stale' \in BOOLEAN
    /\ left' \in IF recorded /\ start = "Requested"
                 THEN {"failed", "restoring"} ELSE {"none"}
    /\ UNCHANGED <<kind, recorded, ports, endedBy, receipt, intent, lock, msg,
                   todo, outcome>>

ByIntent == IF intent = "cleaned" THEN "downRestart" ELSE "downUp"

StageMessage(at) ==
    CASE at = "Preparing" -> IF recorded THEN "downUp" ELSE "up"
      [] at = "Requested" -> "inspect"
      [] OTHER -> "downUp"

\* This fix: a recorded run lost at Requested is retired like one lost once
\* ready; a fresh `up` lost there has no record for the down to find.
RecoverMessage(at) ==
    IF at = "Requested" /\ recorded THEN "downUp" ELSE StageMessage(at)

Message(at) ==
    CASE MessageRule = "recover" -> RecoverMessage(at)
      [] MessageRule = "stage" -> StageMessage(at)
      [] MessageRule = "graph" ->
            IF at \in {"GraphReady", "Serving"} THEN "downUp" ELSE "inspect"
      [] MessageRule = "intent" ->
            IF at \in {"GraphReady", "Serving"} THEN ByIntent
            ELSE StageMessage(at)
      [] OTHER -> ByIntent

\* The error's own text at a8705a39: image preparation says to retry
\* `hack up`; the foreground unwind says to run `hack down --recover`.
GenericMessage(at) ==
    IF at = "Preparing" THEN "genericUp" ELSE "genericDown"

Steps(m) ==
    CASE m \in {"up", "genericUp"} -> <<"up">>
      [] m = "downUp" -> <<"down", "up">>
      [] m = "downRestart" -> <<"down", "restart">>
      [] m = "genericDown" -> <<"down">>
      [] OTHER -> <<>>

End(by, m, lockAfter) ==
    /\ start = "Dead"
    /\ start' = "Lost" /\ endedBy' = by
    /\ msg' = m /\ todo' = Steps(m)
    /\ lock' = lockAfter
    /\ outcome' = IF Steps(m) = <<>> THEN "ok" ELSE "pending"
    /\ UNCHANGED <<kind, recorded, ports, lostAt, leftover, stale, left,
                   receipt, intent>>

\* The pool watch sees the lost VM, prints the message, runs `beforeLostExit`
\* (the restart's lock release) and exits 1; nothing else of the start runs.
Watch == End("watch", Message(lostAt), lock /\ ~ReleaseLock)

\* The start's own error path fails first. Its error propagates, so the
\* restart's `finally` releases the lock either way. It is classified as a
\* lost VM unless the code at hand misses it: the round-5 rule read no pid
\* from a transitional record and let that record veto the code.
Classified == ~(ClassifyRule = "round5" /\ stale)

StartFails ==
    End("error",
        IF ErrorRule = "stage" /\ Classified
        THEN Message(lostAt) ELSE GenericMessage(lostAt),
        FALSE)

\* An ordinary failure on a healthy VM (no `Die`): the record still shows the
\* watched boot's provider alive. Its error may still carry the runtime's
\* `process_identity_unavailable` (an image build's context snapshot, an
\* incarnation read). It must keep its own message (`own`, nothing to run).
OrdinaryFail ==
    /\ start \in Stages
    /\ \E coded \in BOOLEAN :
         msg' = IF ClassifyRule = "code" /\ coded
                THEN Message(start) ELSE "own"
    /\ start' = "Lost" /\ lostAt' = start /\ endedBy' = "ordinary"
    /\ todo' = <<>> /\ outcome' = "ok"
    /\ lock' = FALSE
    /\ UNCHANGED <<kind, recorded, ports, leftover, stale, left, receipt,
                   intent>>

\* `hack down --recover` depends on where the start was lost, not on what the
\* message said. Lost while preparing, the record (if any) is still the
\* stopped retained run, and a fresh `up` has none (`not_started`). Otherwise
\* the down starts the pool and the runtime retires the run across the boot,
\* with data kept: once ready and mapped always, and lost in between only a
\* recorded run, with the recovery of a lost start (CrossBootStart, HACK-2714).
\* Either needs the dead owner's relay proved: by the run's routes, or with no
\* published port by the relay's clean exit (RouteProof, HACK-2711).
\* Containers a lost VM brought back fail the confirmation unless the down
\* removes them again.
RelayProved == ports \/ RouteProof = "exit"
LostStartAdmitted ==
    \/ CrossBootStart = "restoring"
    \/ CrossBootStart = "failed" /\ left = "failed"
Retirable ==
    CASE lostAt = "Preparing" -> TRUE
      [] lostAt = "Requested" -> recorded /\ LostStartAdmitted /\ RelayProved
      [] OTHER -> RelayProved
DownAccepts ==
    /\ Retirable
    /\ leftover => RepairLeftover
\* `hack up` refuses a pending restart, a run that is not stopped, and a
\* mapping whose cleanup is unconfirmed.
UpAccepts == intent = "none" /\ receipt \in {"none", "stopped"} /\ ~leftover
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
            /\ UNCHANGED <<receipt, intent, todo, leftover>>
       ELSE /\ todo' = Tail(todo)
            /\ outcome' = IF Tail(todo) = <<>> THEN "ok" ELSE "pending"
            /\ receipt' = CASE c = "down" ->
                                 IF receipt = "none" THEN "none" ELSE "stopped"
                            [] OTHER -> "ready"
            /\ leftover' = IF c = "down" THEN FALSE ELSE leftover
            /\ intent' = IF c = "down" /\ RetireIntent /\ ~lock
                         THEN "none"
                         ELSE IF c = "restart" THEN "none" ELSE intent
    /\ UNCHANGED <<kind, recorded, ports, start, lostAt, endedBy, stale, left,
                   lock, msg>>

Next == Request \/ GraphReady \/ Serve \/ Die \/ Watch \/ StartFails
        \/ OrdinaryFail \/ Step
Spec == Init /\ [][Next]_vars

\* Every command the message names, run in order, is accepted.
NoRefusedAdvice == outcome # "refused"
\* The message withholds a command only when none can work: the run was lost
\* after its services were requested and before it was ready and mapped, and
\* no cross-boot recovery retires it (a fresh `up`, or the runtime before
\* HACK-2714).
NoNeedlessWithholding ==
    msg = "inspect" =>
        lostAt = "Requested" /\ ~(recorded /\ CrossBootStart # "none")
\* Reachability witness (expected to fail): a lost restart is recovered by
\* following its message.
NoRestartRecovery ==
    ~(kind = "restart" /\ outcome = "ok" /\ msg \notin {"inspect", "own"})
\* An ordinary failure on a live VM never gets lost-VM advice.
NoFalseLoss == endedBy = "ordinary" => msg = "own"
\* A start error after its VM died gets the stage message (one the stage
\* rules name), never the error's own text, whatever phase the record is in.
NoMissedLoss ==
    endedBy = "error" => msg \in {"up", "downUp", "downRestart", "inspect"}
=============================================================================
