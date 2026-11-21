--------------------------- MODULE RuntimeService ---------------------------
\* HACK-2460: one runtime service per native home, started on demand by its
\* clients. Each client issues one mutation, identified by an intent id, and
\* may lose its reply, resend it on a new connection, meet a service of another
\* build, or fall back to the one-shot path. Service processes may crash at any
\* step.
\*
\* Frames and replies belong to connections. A written frame sits in the
\* receiving process's buffer for its connection until that process reads it,
\* whether or not the client is still connected; its reply reaches the client
\* only on that same connection while it is open. The client counts the frames
\* it wrote that were not refused to it before admission (unsure): only those
\* can still have an effect, and fallback needs none.
\*
\* The effect is observable as "none", "started" or "complete" (world). Work
\* that started may complete after its service died (Settle). Inspection reads
\* only that: "complete" is done, "none" is not done, "started" is unknown. It
\* sees no process's memory, so it may start without a service only while no
\* process holds service.lock. After a serving process answered "accepted, no
\* live attempt", its intent record answers any later frame with that id.
\*
\* Safety only. Small bounds: two clients, MaxInstances service processes,
\* MaxConns connections per client. Each guard constant is TRUE in
\* positive.cfg; each negative control turns one off and must fail the
\* invariant named in the registry.
EXTENDS Naturals, FiniteSets

CONSTANTS
    Clients,             \* model values, e.g. {c1, c2}
    NewClients,          \* clients whose CLI carries the "new" build
    NoClient,            \* model value: nobody holds the one-shot lease
    MaxInstances,        \* bound on service processes ever started
    MaxConns,            \* bound on connections each client opens
    LockBeforeBind,      \* only the holder of service.lock binds the socket
    AcceptBeforeEffect,  \* the durable intent record precedes any effect
    DedupeIntent,        \* a resent intent id is answered, never re-run
    FallbackOnlyUnsent,  \* one-shot fallback only with no unsure frame
    RefuseSkew,          \* a service of another build never runs a mutation
    InspectOnlyWhenFree  \* one-shot inspection starts only while no service lives

ASSUME NewClients \subseteq Clients
ASSUME MaxInstances \in Nat /\ MaxInstances >= 1
ASSUME MaxConns \in Nat /\ MaxConns >= 1

None == 0
Ids == 1..MaxInstances
Conns == 1..MaxConns
Frames == Ids \X Conns
Live == {"serving", "draining"}
Build(c) == IF c \in NewClients THEN "new" ELSE "old"

VARIABLES
    inst,     \* [Ids -> [st, b]]: state and build of each service process
    lock,     \* holder of the flock on service.lock (freed by death)
    sock,     \* the instance whose listener the socket path names
    next,     \* next instance id a client may start
    cl,       \* client phase
    conn,     \* instance the client's open connection reaches
    cid,      \* number of the client's open connection (0: none)
    opened,   \* connections the client has opened so far
    unsure,   \* frames written and not refused to the client before admission
    inflight, \* <<instance, connection>> frames not yet read by their process
    waiters,  \* connections that the live attempt answers when it finishes
    intent,   \* durable intent record: "none" | "accepted" | "done"
    att,      \* in-memory attempt: "none" | "admitted" | "running"
    attIn,    \* instance holding the attempt
    svcLease, \* provider lease held by a service attempt (instance id)
    oneLease, \* provider lease held by a one-shot process (client)
    effects,  \* ghost: how many times the client's effect started
    world,    \* observable effect: "none" | "started" | "complete"
    report    \* what the client finally told its user

svcVars == <<inst, lock, sock, next>>
cliVars == <<cl, conn, cid, opened, unsure, report>>
workVars == <<inflight, waiters, intent, att, attIn, svcLease, oneLease, effects, world>>
vars == <<svcVars, cliVars, workVars>>

Phases == {"idle", "hello", "sent", "replied", "unknown", "oneshot",
           "oneshotRunning", "inspect", "finished"}

TypeOK ==
    /\ inst \in [Ids -> [st : {"none", "starting", "serving", "draining", "dead"},
                         b : {"old", "new", "-"}]]
    /\ lock \in Ids \cup {None}
    /\ sock \in Ids \cup {None}
    /\ next \in 1..(MaxInstances + 1)
    /\ cl \in [Clients -> Phases]
    /\ conn \in [Clients -> Ids \cup {None}]
    /\ cid \in [Clients -> 0..MaxConns]
    /\ opened \in [Clients -> 0..MaxConns]
    /\ unsure \in [Clients -> 0..MaxConns]
    /\ inflight \in [Clients -> SUBSET Frames]
    /\ waiters \in [Clients -> SUBSET Frames]
    /\ intent \in [Clients -> {"none", "accepted", "done"}]
    /\ att \in [Clients -> {"none", "admitted", "running"}]
    /\ attIn \in [Clients -> Ids \cup {None}]
    /\ svcLease \in Ids \cup {None}
    /\ oneLease \in Clients \cup {NoClient}
    /\ effects \in [Clients -> 0..3]
    /\ world \in [Clients -> {"none", "started", "complete"}]
    /\ report \in [Clients -> {"none", "done", "notdone", "unknown"}]

LeaseFree == svcLease = None /\ oneLease = NoClient

\* The client is waiting on connection f = <<instance, number>>.
Waiting(f, c) == conn[c] = f[1] /\ cid[c] = f[2] /\ cl[c] = "sent"

Started(w) == IF w = "complete" THEN w ELSE "started"

Init ==
    /\ inst = [i \in Ids |-> [st |-> "none", b |-> "-"]]
    /\ lock = None
    /\ sock = None
    /\ next = 1
    /\ cl = [c \in Clients |-> "idle"]
    /\ conn = [c \in Clients |-> None]
    /\ cid = [c \in Clients |-> 0]
    /\ opened = [c \in Clients |-> 0]
    /\ unsure = [c \in Clients |-> 0]
    /\ inflight = [c \in Clients |-> {}]
    /\ waiters = [c \in Clients |-> {}]
    /\ intent = [c \in Clients |-> "none"]
    /\ att = [c \in Clients |-> "none"]
    /\ attIn = [c \in Clients |-> None]
    /\ svcLease = None
    /\ oneLease = NoClient
    /\ effects = [c \in Clients |-> 0]
    /\ world = [c \in Clients |-> "none"]
    /\ report = [c \in Clients |-> "none"]

-----------------------------------------------------------------------------
\* Service processes.

\* Connecting failed (no path, or a stale path): the client starts a service
\* process of its own build.
Spawn(c) ==
    /\ cl[c] = "idle"
    /\ IF sock = None THEN TRUE ELSE inst[sock].st = "dead"
    /\ next <= MaxInstances
    /\ inst' = [inst EXCEPT ![next] = [st |-> "starting", b |-> Build(c)]]
    /\ next' = next + 1
    /\ UNCHANGED <<lock, sock, cliVars, workVars>>

TakeLock(i) ==
    /\ inst[i].st = "starting"
    /\ lock = None
    /\ lock' = i
    /\ UNCHANGED <<inst, sock, next, cliVars, workVars>>

\* Binding first removes whatever the path names, as node serve does today.
Bind(i) ==
    /\ inst[i].st = "starting"
    /\ (LockBeforeBind => lock = i)
    /\ sock' = i
    /\ inst' = [inst EXCEPT ![i].st = "serving"]
    /\ UNCHANGED <<lock, next, cliVars, workVars>>

\* The lock is held by another process: exit; the client connects to it.
LoseRace(i) ==
    /\ inst[i].st = "starting"
    /\ lock # None
    /\ lock # i
    /\ inst' = [inst EXCEPT ![i].st = "dead"]
    /\ UNCHANGED <<lock, sock, next, cliVars, workVars>>

DropAt(i, S) == {f \in S : f[1] # i}

\* The client's open connection to i, if any, breaks.
CloseAt(i) ==
    /\ conn' = [c \in Clients |-> IF conn[c] = i THEN None ELSE conn[c]]
    /\ cid' = [c \in Clients |-> IF conn[c] = i THEN 0 ELSE cid[c]]
    /\ cl' = [c \in Clients |->
                IF conn[c] = i /\ cl[c] \in {"hello", "sent"} THEN "idle" ELSE cl[c]]

\* Kill at any moment: flock and lease are freed, memory and unread frames are
\* lost, the socket path stays behind as a stale file, durable intent records
\* stay, and work that started stays started.
Crash(i) ==
    /\ inst[i].st \in {"starting", "serving", "draining"}
    /\ inst' = [inst EXCEPT ![i].st = "dead"]
    /\ lock' = IF lock = i THEN None ELSE lock
    /\ svcLease' = IF svcLease = i THEN None ELSE svcLease
    /\ att' = [c \in Clients |-> IF attIn[c] = i THEN "none" ELSE att[c]]
    /\ attIn' = [c \in Clients |-> IF attIn[c] = i THEN None ELSE attIn[c]]
    /\ inflight' = [c \in Clients |-> DropAt(i, inflight[c])]
    /\ waiters' = [c \in Clients |-> IF attIn[c] = i THEN {} ELSE waiters[c]]
    /\ CloseAt(i)
    /\ UNCHANGED <<sock, next, opened, unsure, report, intent, oneLease, effects, world>>

\* Stops listening, drains the queue, re-checks, exits (spec 3.5). Atomic here.
IdleExit(i) ==
    /\ inst[i].st = "serving"
    /\ \A c \in Clients : conn[c] # i /\ attIn[c] # i /\ DropAt(i, inflight[c]) = inflight[c]
    /\ inst' = [inst EXCEPT ![i].st = "dead"]
    /\ lock' = IF lock = i THEN None ELSE lock
    /\ sock' = IF sock = i THEN None ELSE sock
    /\ UNCHANGED <<next, cliVars, workVars>>

\* A draining process exits once none of its own attempts is left. Frames it
\* never read are dropped; it would have refused them.
ExitDrained(i) ==
    /\ inst[i].st = "draining"
    /\ \A c \in Clients : attIn[c] # i
    /\ inst' = [inst EXCEPT ![i].st = "dead"]
    /\ lock' = IF lock = i THEN None ELSE lock
    /\ inflight' = [c \in Clients |-> DropAt(i, inflight[c])]
    /\ CloseAt(i)
    /\ UNCHANGED <<sock, next, opened, unsure, report, waiters, intent, att, attIn,
                   svcLease, oneLease, effects, world>>

-----------------------------------------------------------------------------
\* Frames, as the service reads them. A frame may be read after its
\* connection closed; its reply is then lost.

Admit(f, c) ==
    /\ f \in inflight[c]
    /\ inst[f[1]].st = "serving"
    /\ att[c] = "none"
    /\ (DedupeIntent => intent[c] = "none")
    /\ inflight' = [inflight EXCEPT ![c] = @ \ {f}]
    /\ waiters' = [waiters EXCEPT ![c] = {f}]
    /\ intent' = [intent EXCEPT ![c] = IF AcceptBeforeEffect THEN "accepted" ELSE @]
    /\ att' = [att EXCEPT ![c] = "admitted"]
    /\ attIn' = [attIn EXCEPT ![c] = f[1]]
    /\ UNCHANGED <<svcVars, cliVars, svcLease, oneLease, effects, world>>

\* A resent intent id whose attempt is still alive here joins it: the
\* attempt's reply also answers this frame's connection.
Join(f, c) ==
    /\ DedupeIntent
    /\ f \in inflight[c]
    /\ inst[f[1]].st \in Live
    /\ att[c] # "none"
    /\ attIn[c] = f[1]
    /\ inflight' = [inflight EXCEPT ![c] = @ \ {f}]
    /\ waiters' = [waiters EXCEPT ![c] = @ \cup {f}]
    /\ UNCHANGED <<svcVars, cliVars, intent, att, attIn, svcLease, oneLease,
                   effects, world>>

\* A resent intent id that already finished gets its recorded result.
AnswerDone(f, c) ==
    /\ DedupeIntent
    /\ f \in inflight[c]
    /\ inst[f[1]].st \in Live
    /\ intent[c] = "done"
    /\ inflight' = [inflight EXCEPT ![c] = @ \ {f}]
    /\ cl' = [cl EXCEPT ![c] = IF Waiting(f, c) THEN "replied" ELSE @]
    /\ UNCHANGED <<svcVars, conn, cid, opened, unsure, report, waiters, intent,
                   att, attIn, svcLease, oneLease, effects, world>>

\* Accepted, but no live attempt holds it: the outcome is unproven. Under
\* OneOwner no other process can hold it either, and the record keeps any
\* later frame with this id from being admitted.
AnswerUnknown(f, c) ==
    /\ DedupeIntent
    /\ f \in inflight[c]
    /\ inst[f[1]].st \in Live
    /\ intent[c] = "accepted"
    /\ att[c] = "none"
    /\ inflight' = [inflight EXCEPT ![c] = @ \ {f}]
    /\ cl' = [cl EXCEPT ![c] = IF Waiting(f, c) THEN "unknown" ELSE @]
    /\ UNCHANGED <<svcVars, conn, cid, opened, unsure, report, waiters, intent,
                   att, attIn, svcLease, oneLease, effects, world>>

\* A draining process refuses a frame it never admitted, before any effect.
\* The client learns it only on that frame's open connection.
RefuseDraining(f, c) ==
    /\ f \in inflight[c]
    /\ inst[f[1]].st = "draining"
    /\ intent[c] = "none"
    /\ att[c] = "none"
    /\ inflight' = [inflight EXCEPT ![c] = @ \ {f}]
    /\ IF Waiting(f, c)
          THEN /\ cl' = [cl EXCEPT ![c] = "idle"]
               /\ conn' = [conn EXCEPT ![c] = None]
               /\ cid' = [cid EXCEPT ![c] = 0]
               /\ unsure' = [unsure EXCEPT ![c] = @ - 1]
          ELSE UNCHANGED <<cl, conn, cid, unsure>>
    /\ UNCHANGED <<svcVars, opened, report, waiters, intent, att, attIn, svcLease,
                   oneLease, effects, world>>

Begin(i, c) ==
    /\ att[c] = "admitted"
    /\ attIn[c] = i
    /\ inst[i].st \in Live
    /\ LeaseFree
    /\ effects[c] < 3
    /\ svcLease' = i
    /\ att' = [att EXCEPT ![c] = "running"]
    /\ effects' = [effects EXCEPT ![c] = @ + 1]
    /\ world' = [world EXCEPT ![c] = Started(@)]
    /\ UNCHANGED <<svcVars, cliVars, inflight, waiters, intent, attIn, oneLease>>

\* The reply reaches the client only on a connection the attempt answers.
Finish(i, c) ==
    /\ att[c] = "running"
    /\ attIn[c] = i
    /\ svcLease = i
    /\ svcLease' = None
    /\ world' = [world EXCEPT ![c] = "complete"]
    /\ intent' = [intent EXCEPT ![c] = "done"]
    /\ att' = [att EXCEPT ![c] = "none"]
    /\ attIn' = [attIn EXCEPT ![c] = None]
    /\ waiters' = [waiters EXCEPT ![c] = {}]
    /\ cl' = [cl EXCEPT ![c] =
                IF \E f \in waiters[c] : Waiting(f, c) THEN "replied" ELSE @]
    /\ UNCHANGED <<svcVars, conn, cid, opened, unsure, report, inflight, oneLease,
                   effects>>

\* Work that started may still complete after its process died, for example in
\* a child that outlives it.
Settle(c) ==
    /\ world[c] = "started"
    /\ att[c] = "none"
    /\ oneLease # c
    /\ world' = [world EXCEPT ![c] = "complete"]
    /\ UNCHANGED <<svcVars, cliVars, inflight, waiters, intent, att, attIn,
                   svcLease, oneLease, effects>>

-----------------------------------------------------------------------------
\* Clients.

Connect(c) ==
    /\ cl[c] = "idle"
    /\ sock # None
    /\ inst[sock].st = "serving"
    /\ opened[c] < MaxConns
    /\ opened' = [opened EXCEPT ![c] = @ + 1]
    /\ cid' = [cid EXCEPT ![c] = opened[c] + 1]
    /\ conn' = [conn EXCEPT ![c] = sock]
    /\ cl' = [cl EXCEPT ![c] = "hello"]
    /\ UNCHANGED <<svcVars, unsure, report, workVars>>

\* Writing the mutation frame on this connection. A resend carries the same
\* intent id on a new connection.
Send(c) ==
    /\ cl[c] = "hello"
    /\ conn[c] # None
    /\ inst[conn[c]].st \in Live
    /\ (RefuseSkew => inst[conn[c]].b = Build(c))
    /\ cl' = [cl EXCEPT ![c] = "sent"]
    /\ unsure' = [unsure EXCEPT ![c] = @ + 1]
    /\ inflight' = [inflight EXCEPT ![c] = @ \cup {<<conn[c], cid[c]>>}]
    /\ UNCHANGED <<svcVars, conn, cid, opened, report, waiters, intent, att, attIn,
                   svcLease, oneLease, effects, world>>

\* hello showed another build: ask it to retire. It unlinks its socket path
\* at once and keeps service.lock until it exits; the next process of the
\* client's build waits for the lock.
Retire(c) ==
    /\ cl[c] = "hello"
    /\ conn[c] # None
    /\ inst[conn[c]].st = "serving"
    /\ inst[conn[c]].b # Build(c)
    /\ inst' = [inst EXCEPT ![conn[c]].st = "draining"]
    /\ sock' = IF sock = conn[c] THEN None ELSE sock
    /\ conn' = [conn EXCEPT ![c] = None]
    /\ cid' = [cid EXCEPT ![c] = 0]
    /\ cl' = [cl EXCEPT ![c] = "idle"]
    /\ UNCHANGED <<lock, next, opened, unsure, report, workVars>>

\* A broken pipe or a lost reply. It never cancels an admitted attempt, and a
\* frame already written stays in the service's buffer.
Disconnect(c) ==
    /\ cl[c] \in {"hello", "sent"}
    /\ conn[c] # None
    /\ cl' = [cl EXCEPT ![c] = "idle"]
    /\ conn' = [conn EXCEPT ![c] = None]
    /\ cid' = [cid EXCEPT ![c] = 0]
    /\ UNCHANGED <<svcVars, opened, unsure, report, workVars>>

\* Today's one-process-per-request path.
Fallback(c) ==
    /\ cl[c] \in {"idle", "hello"}
    /\ (FallbackOnlyUnsent => unsure[c] = 0)
    /\ cl' = [cl EXCEPT ![c] = "oneshot"]
    /\ conn' = [conn EXCEPT ![c] = None]
    /\ cid' = [cid EXCEPT ![c] = 0]
    /\ UNCHANGED <<svcVars, opened, unsure, report, workVars>>

OneShotBegin(c) ==
    /\ cl[c] = "oneshot"
    /\ LeaseFree
    /\ effects[c] < 3
    /\ oneLease' = c
    /\ effects' = [effects EXCEPT ![c] = @ + 1]
    /\ world' = [world EXCEPT ![c] = Started(@)]
    /\ cl' = [cl EXCEPT ![c] = "oneshotRunning"]
    /\ UNCHANGED <<svcVars, conn, cid, opened, unsure, report, inflight, waiters,
                   intent, att, attIn, svcLease>>

OneShotEnd(c) ==
    /\ cl[c] = "oneshotRunning"
    /\ oneLease = c
    /\ oneLease' = NoClient
    /\ world' = [world EXCEPT ![c] = "complete"]
    /\ cl' = [cl EXCEPT ![c] = "finished"]
    /\ report' = [report EXCEPT ![c] = "done"]
    /\ UNCHANGED <<svcVars, conn, cid, opened, unsure, inflight, waiters, intent,
                   att, attIn, svcLease, effects>>

\* An unsure frame and no service answers: read the real state one-shot. It
\* starts only while no process holds service.lock; a process that takes the
\* lock later has none of the old frames and never resumes an accepted intent.
\* Otherwise the client resends with the same id, or waits for the lock.
InspectWithoutService(c) ==
    /\ cl[c] = "idle"
    /\ unsure[c] > 0
    /\ (InspectOnlyWhenFree => lock = None)
    /\ cl' = [cl EXCEPT ![c] = "inspect"]
    /\ UNCHANGED <<svcVars, conn, cid, opened, unsure, report, workVars>>

\* The serving process answered "accepted, no live attempt here".
StartInspect(c) ==
    /\ cl[c] = "unknown"
    /\ cl' = [cl EXCEPT ![c] = "inspect"]
    /\ conn' = [conn EXCEPT ![c] = None]
    /\ cid' = [cid EXCEPT ![c] = 0]
    /\ UNCHANGED <<svcVars, opened, unsure, report, workVars>>

\* Inspection reads the observable effect only; work that started and has not
\* completed is reported as unknown.
Inspect(c) ==
    /\ cl[c] = "inspect"
    /\ report' = [report EXCEPT ![c] =
                    CASE world[c] = "complete" -> "done"
                      [] world[c] = "none" -> "notdone"
                      [] OTHER -> "unknown"]
    /\ cl' = [cl EXCEPT ![c] = "finished"]
    /\ UNCHANGED <<svcVars, conn, cid, opened, unsure, workVars>>

Report(c) ==
    /\ cl[c] = "replied"
    /\ report' = [report EXCEPT ![c] = "done"]
    /\ cl' = [cl EXCEPT ![c] = "finished"]
    /\ conn' = [conn EXCEPT ![c] = None]
    /\ cid' = [cid EXCEPT ![c] = 0]
    /\ UNCHANGED <<svcVars, opened, unsure, workVars>>

-----------------------------------------------------------------------------

Next ==
    \/ \E c \in Clients :
        \/ Spawn(c) \/ Connect(c) \/ Send(c) \/ Retire(c) \/ Disconnect(c)
        \/ Fallback(c) \/ OneShotBegin(c) \/ OneShotEnd(c) \/ Settle(c)
        \/ InspectWithoutService(c) \/ StartInspect(c) \/ Inspect(c) \/ Report(c)
    \/ \E i \in Ids :
        \/ TakeLock(i) \/ Bind(i) \/ LoseRace(i) \/ Crash(i)
        \/ IdleExit(i) \/ ExitDrained(i)
    \/ \E f \in Frames, c \in Clients :
        \/ Admit(f, c) \/ Join(f, c) \/ AnswerDone(f, c) \/ AnswerUnknown(f, c)
        \/ RefuseDraining(f, c)
    \/ \E i \in Ids, c \in Clients : Begin(i, c) \/ Finish(i, c)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
\* Invariants.

\* Every serving or draining process holds service.lock.
LockedOwner == \A i \in Ids : inst[i].st \in Live => lock = i

\* At most one service process per home is serving or draining.
OneOwner == Cardinality({i \in Ids : inst[i].st \in Live}) <= 1

\* A client's mutation takes effect at most once, whatever was lost or retried.
AtMostOnce == \A c \in Clients : effects[c] <= 1

\* A mutation only ever runs in a service of the client's own build.
SameBuild == \A c \in Clients : att[c] # "none" => inst[attIn[c]].b = Build(c)

\* "Done" is said only when the effect completed; "not done" only when nothing
\* has started, now or later (the report stays, so a later start breaks it).
ReportHonest == \A c \in Clients :
    /\ (report[c] = "done" => world[c] = "complete")
    /\ (report[c] = "notdone" => world[c] = "none")

\* A running attempt always has a durable intent record.
NoEffectWithoutIntent == \A c \in Clients : att[c] = "running" => intent[c] # "none"

\* Reachability controls (expected to fail): each path is reachable, so the
\* model is not vacuous there.
NeverUnknown == \A c \in Clients : cl[c] # "unknown"
NeverNotDone == \A c \in Clients : report[c] # "notdone"
NeverOneShotDone == \A c \in Clients :
    ~(cl[c] = "finished" /\ report[c] = "done" /\ intent[c] = "none" /\ oneLease = NoClient)
NeverInconclusive == \A c \in Clients : report[c] # "unknown"

=============================================================================
