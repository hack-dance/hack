--------------------------- MODULE RuntimeService ---------------------------
\* HACK-2460: one runtime service per native home, started on demand by its
\* clients. Each client issues one mutation, identified by an intent id, and
\* may lose its reply, resend it, meet a service of another build, or fall back
\* to the one-shot path. Service processes may crash at any step.
\*
\* A written frame sits in the receiving process's socket buffer (inflight)
\* until that process reads it, whether or not the client is still connected:
\* a disconnect never takes back a frame that was written.
\*
\* Inspection is a one-shot read of real state. It cannot see another
\* process's memory, so it may decide "done" or "not done" only when no
\* service process can still admit or run the mutation: either no process
\* holds service.lock, or the serving process itself answered that the intent
\* was accepted and has no live attempt (its record then fences any resend).
\*
\* Safety only. Small bounds: two clients, MaxInstances service processes.
\* Each guard constant is TRUE in positive.cfg; each negative control turns one
\* off and must fail the invariant named in the registry.
EXTENDS Naturals, FiniteSets

CONSTANTS
    Clients,             \* model values, e.g. {c1, c2}
    NewClients,          \* clients whose CLI carries the "new" build
    NoClient,            \* model value: nobody holds the one-shot lease
    MaxInstances,        \* bound on service processes ever started
    LockBeforeBind,      \* only the holder of service.lock binds the socket
    AcceptBeforeEffect,  \* the durable intent record precedes any effect
    DedupeIntent,        \* a resent intent id is answered, never re-run
    FallbackOnlyUnsent,  \* one-shot fallback only for a request never sent
    RefuseSkew,          \* a service of another build never runs a mutation
    InspectOnlyWhenFree  \* one-shot inspection only while no service lives

ASSUME NewClients \subseteq Clients
ASSUME MaxInstances \in Nat /\ MaxInstances >= 1

None == 0
Ids == 1..MaxInstances
Live == {"serving", "draining"}
Build(c) == IF c \in NewClients THEN "new" ELSE "old"

VARIABLES
    inst,     \* [Ids -> [st, b]]: state and build of each service process
    lock,     \* holder of the flock on service.lock (freed by death)
    sock,     \* the instance whose listener the socket path names
    next,     \* next instance id a client may start
    cl,       \* client phase
    conn,     \* instance the client's open connection reaches
    sent,     \* the client may have a frame admitted (written, not refused)
    inflight, \* instances holding an unread frame of the client
    intent,   \* durable intent record: "none" | "accepted" | "done"
    att,      \* in-memory attempt: "none" | "admitted" | "running"
    attIn,    \* instance holding the attempt
    svcLease, \* provider lease held by a service attempt (instance id)
    oneLease, \* provider lease held by a one-shot process (client)
    effects,  \* ghost: how many times the client's effect started
    report    \* what the client finally told its user

svcVars == <<inst, lock, sock, next>>
cliVars == <<cl, conn, sent, report>>
workVars == <<inflight, intent, att, attIn, svcLease, oneLease, effects>>
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
    /\ sent \in [Clients -> BOOLEAN]
    /\ inflight \in [Clients -> SUBSET Ids]
    /\ intent \in [Clients -> {"none", "accepted", "done"}]
    /\ att \in [Clients -> {"none", "admitted", "running"}]
    /\ attIn \in [Clients -> Ids \cup {None}]
    /\ svcLease \in Ids \cup {None}
    /\ oneLease \in Clients \cup {NoClient}
    /\ effects \in [Clients -> 0..3]
    /\ report \in [Clients -> {"none", "done", "notdone", "unknown"}]

LeaseFree == svcLease = None /\ oneLease = NoClient

\* The reply to a frame read by i reaches c only on c's open connection to i.
Waiting(i, c) == conn[c] = i /\ cl[c] = "sent"

Init ==
    /\ inst = [i \in Ids |-> [st |-> "none", b |-> "-"]]
    /\ lock = None
    /\ sock = None
    /\ next = 1
    /\ cl = [c \in Clients |-> "idle"]
    /\ conn = [c \in Clients |-> None]
    /\ sent = [c \in Clients |-> FALSE]
    /\ inflight = [c \in Clients |-> {}]
    /\ intent = [c \in Clients |-> "none"]
    /\ att = [c \in Clients |-> "none"]
    /\ attIn = [c \in Clients |-> None]
    /\ svcLease = None
    /\ oneLease = NoClient
    /\ effects = [c \in Clients |-> 0]
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

\* Kill at any moment: flock and lease are freed, memory and unread frames
\* are lost, the socket path stays behind as a stale file, durable intent
\* records stay.
Crash(i) ==
    /\ inst[i].st \in {"starting", "serving", "draining"}
    /\ inst' = [inst EXCEPT ![i].st = "dead"]
    /\ lock' = IF lock = i THEN None ELSE lock
    /\ svcLease' = IF svcLease = i THEN None ELSE svcLease
    /\ att' = [c \in Clients |-> IF attIn[c] = i THEN "none" ELSE att[c]]
    /\ attIn' = [c \in Clients |-> IF attIn[c] = i THEN None ELSE attIn[c]]
    /\ inflight' = [c \in Clients |-> inflight[c] \ {i}]
    /\ conn' = [c \in Clients |-> IF conn[c] = i THEN None ELSE conn[c]]
    /\ cl' = [c \in Clients |->
                IF conn[c] = i /\ cl[c] \in {"hello", "sent"} THEN "idle" ELSE cl[c]]
    /\ UNCHANGED <<sock, next, sent, report, intent, oneLease, effects>>

\* Stops listening, drains the queue, re-checks, exits (spec 3.5). Atomic here.
IdleExit(i) ==
    /\ inst[i].st = "serving"
    /\ \A c \in Clients : conn[c] # i /\ attIn[c] # i /\ i \notin inflight[c]
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
    /\ inflight' = [c \in Clients |-> inflight[c] \ {i}]
    /\ conn' = [c \in Clients |-> IF conn[c] = i THEN None ELSE conn[c]]
    /\ cl' = [c \in Clients |->
                IF conn[c] = i /\ cl[c] \in {"hello", "sent"} THEN "idle" ELSE cl[c]]
    /\ UNCHANGED <<sock, next, sent, report, intent, att, attIn, svcLease,
                   oneLease, effects>>

-----------------------------------------------------------------------------
\* Frames, as the service reads them. A frame may be read after its client
\* disconnected; the reply is then lost.

Admit(i, c) ==
    /\ i \in inflight[c]
    /\ inst[i].st = "serving"
    /\ att[c] = "none"
    /\ (DedupeIntent => intent[c] = "none")
    /\ inflight' = [inflight EXCEPT ![c] = @ \ {i}]
    /\ intent' = [intent EXCEPT ![c] = IF AcceptBeforeEffect THEN "accepted" ELSE @]
    /\ att' = [att EXCEPT ![c] = "admitted"]
    /\ attIn' = [attIn EXCEPT ![c] = i]
    /\ UNCHANGED <<svcVars, cliVars, svcLease, oneLease, effects>>

\* A resent intent id whose attempt is still alive here joins it: the frame is
\* consumed and the attempt's reply answers it.
Join(i, c) ==
    /\ DedupeIntent
    /\ i \in inflight[c]
    /\ inst[i].st \in Live
    /\ att[c] # "none"
    /\ attIn[c] = i
    /\ inflight' = [inflight EXCEPT ![c] = @ \ {i}]
    /\ UNCHANGED <<svcVars, cliVars, intent, att, attIn, svcLease, oneLease, effects>>

\* A resent intent id that already finished gets its recorded result.
AnswerDone(i, c) ==
    /\ DedupeIntent
    /\ i \in inflight[c]
    /\ inst[i].st \in Live
    /\ intent[c] = "done"
    /\ inflight' = [inflight EXCEPT ![c] = @ \ {i}]
    /\ cl' = [cl EXCEPT ![c] = IF Waiting(i, c) THEN "replied" ELSE @]
    /\ UNCHANGED <<svcVars, conn, sent, report, intent, att, attIn, svcLease,
                   oneLease, effects>>

\* Accepted, but no live attempt holds it: the outcome is unproven. Under
\* OneOwner no other process can hold it either, and the record keeps any
\* later frame with this id from being admitted.
AnswerUnknown(i, c) ==
    /\ DedupeIntent
    /\ i \in inflight[c]
    /\ inst[i].st \in Live
    /\ intent[c] = "accepted"
    /\ att[c] = "none"
    /\ inflight' = [inflight EXCEPT ![c] = @ \ {i}]
    /\ cl' = [cl EXCEPT ![c] = IF Waiting(i, c) THEN "unknown" ELSE @]
    /\ UNCHANGED <<svcVars, conn, sent, report, intent, att, attIn, svcLease,
                   oneLease, effects>>

\* A draining process refuses a frame it never admitted, before any effect.
\* The client learns "not admitted" only on its open connection, and may then
\* fall back once no other frame of its could still be admitted.
RefuseDraining(i, c) ==
    /\ i \in inflight[c]
    /\ inst[i].st = "draining"
    /\ intent[c] = "none"
    /\ att[c] = "none"
    /\ inflight' = [inflight EXCEPT ![c] = @ \ {i}]
    /\ IF Waiting(i, c)
          THEN /\ cl' = [cl EXCEPT ![c] = "idle"]
               /\ conn' = [conn EXCEPT ![c] = None]
               /\ sent' = [sent EXCEPT ![c] = inflight'[c] # {}]
          ELSE UNCHANGED <<cl, conn, sent>>
    /\ UNCHANGED <<svcVars, report, intent, att, attIn, svcLease, oneLease, effects>>

Begin(i, c) ==
    /\ att[c] = "admitted"
    /\ attIn[c] = i
    /\ inst[i].st \in Live
    /\ LeaseFree
    /\ effects[c] < 3
    /\ svcLease' = i
    /\ att' = [att EXCEPT ![c] = "running"]
    /\ effects' = [effects EXCEPT ![c] = @ + 1]
    /\ UNCHANGED <<svcVars, cliVars, inflight, intent, attIn, oneLease>>

\* The reply reaches the client only while its connection is still open.
Finish(i, c) ==
    /\ att[c] = "running"
    /\ attIn[c] = i
    /\ svcLease = i
    /\ svcLease' = None
    /\ intent' = [intent EXCEPT ![c] = "done"]
    /\ att' = [att EXCEPT ![c] = "none"]
    /\ attIn' = [attIn EXCEPT ![c] = None]
    /\ cl' = [cl EXCEPT ![c] = IF Waiting(i, c) THEN "replied" ELSE @]
    /\ UNCHANGED <<svcVars, conn, sent, report, inflight, oneLease, effects>>

-----------------------------------------------------------------------------
\* Clients.

Connect(c) ==
    /\ cl[c] = "idle"
    /\ sock # None
    /\ inst[sock].st = "serving"
    /\ conn' = [conn EXCEPT ![c] = sock]
    /\ cl' = [cl EXCEPT ![c] = "hello"]
    /\ UNCHANGED <<svcVars, sent, report, workVars>>

\* Writing the mutation frame. A resend carries the same intent id.
Send(c) ==
    /\ cl[c] = "hello"
    /\ conn[c] # None
    /\ inst[conn[c]].st \in Live
    /\ (RefuseSkew => inst[conn[c]].b = Build(c))
    /\ cl' = [cl EXCEPT ![c] = "sent"]
    /\ sent' = [sent EXCEPT ![c] = TRUE]
    /\ inflight' = [inflight EXCEPT ![c] = @ \cup {conn[c]}]
    /\ UNCHANGED <<svcVars, conn, report, intent, att, attIn, svcLease,
                   oneLease, effects>>

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
    /\ cl' = [cl EXCEPT ![c] = "idle"]
    /\ UNCHANGED <<lock, next, sent, report, workVars>>

\* A broken pipe or a lost reply. It never cancels an admitted attempt, and a
\* frame already written stays in the service's buffer.
Disconnect(c) ==
    /\ cl[c] \in {"hello", "sent"}
    /\ conn[c] # None
    /\ cl' = [cl EXCEPT ![c] = "idle"]
    /\ conn' = [conn EXCEPT ![c] = None]
    /\ UNCHANGED <<svcVars, sent, report, workVars>>

\* Today's one-process-per-request path.
Fallback(c) ==
    /\ cl[c] \in {"idle", "hello"}
    /\ (FallbackOnlyUnsent => ~sent[c])
    /\ cl' = [cl EXCEPT ![c] = "oneshot"]
    /\ conn' = [conn EXCEPT ![c] = None]
    /\ UNCHANGED <<svcVars, sent, report, workVars>>

OneShotBegin(c) ==
    /\ cl[c] = "oneshot"
    /\ LeaseFree
    /\ effects[c] < 3
    /\ oneLease' = c
    /\ effects' = [effects EXCEPT ![c] = @ + 1]
    /\ cl' = [cl EXCEPT ![c] = "oneshotRunning"]
    /\ UNCHANGED <<svcVars, conn, sent, report, inflight, intent, att, attIn, svcLease>>

OneShotEnd(c) ==
    /\ cl[c] = "oneshotRunning"
    /\ oneLease = c
    /\ oneLease' = NoClient
    /\ cl' = [cl EXCEPT ![c] = "finished"]
    /\ report' = [report EXCEPT ![c] = "done"]
    /\ UNCHANGED <<svcVars, conn, sent, workVars>>

\* Sent once and no service answers: read the real state one-shot. Only
\* while no process holds service.lock, so nothing can still read a buffered
\* frame or run an attempt. Otherwise the client resends with the same id,
\* or waits for the lock to be free.
InspectWithoutService(c) ==
    /\ cl[c] = "idle"
    /\ sent[c]
    /\ (InspectOnlyWhenFree => lock = None)
    /\ cl' = [cl EXCEPT ![c] = "inspect"]
    /\ UNCHANGED <<svcVars, conn, sent, report, workVars>>

StartInspect(c) ==
    /\ cl[c] = "unknown"
    /\ cl' = [cl EXCEPT ![c] = "inspect"]
    /\ conn' = [conn EXCEPT ![c] = None]
    /\ UNCHANGED <<svcVars, sent, report, workVars>>

\* Inspection reads what happened on disk and in the engine: an effect that
\* started is visible, memory of any process is not.
Inspect(c) ==
    /\ cl[c] = "inspect"
    /\ report' = [report EXCEPT ![c] = IF effects[c] > 0 THEN "done" ELSE "notdone"]
    /\ cl' = [cl EXCEPT ![c] = "finished"]
    /\ UNCHANGED <<svcVars, conn, sent, workVars>>

Report(c) ==
    /\ cl[c] = "replied"
    /\ report' = [report EXCEPT ![c] = "done"]
    /\ cl' = [cl EXCEPT ![c] = "finished"]
    /\ conn' = [conn EXCEPT ![c] = None]
    /\ UNCHANGED <<svcVars, sent, workVars>>

-----------------------------------------------------------------------------

Next ==
    \/ \E c \in Clients :
        \/ Spawn(c) \/ Connect(c) \/ Send(c) \/ Retire(c) \/ Disconnect(c)
        \/ Fallback(c) \/ OneShotBegin(c) \/ OneShotEnd(c)
        \/ InspectWithoutService(c) \/ StartInspect(c) \/ Inspect(c) \/ Report(c)
    \/ \E i \in Ids :
        \/ TakeLock(i) \/ Bind(i) \/ LoseRace(i) \/ Crash(i)
        \/ IdleExit(i) \/ ExitDrained(i)
    \/ \E i \in Ids, c \in Clients :
        \/ Admit(i, c) \/ Join(i, c) \/ AnswerDone(i, c) \/ AnswerUnknown(i, c)
        \/ RefuseDraining(i, c) \/ Begin(i, c) \/ Finish(i, c)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
\* Invariants.

\* At most one service process per home is serving or draining.
OneOwner == Cardinality({i \in Ids : inst[i].st \in Live}) <= 1

\* A client's mutation takes effect at most once, whatever was lost or retried.
AtMostOnce == \A c \in Clients : effects[c] <= 1

\* A mutation only ever runs in a service of the client's own build.
SameBuild == \A c \in Clients : att[c] # "none" => inst[attIn[c]].b = Build(c)

\* "Done" is said only after an effect; "not done" only when none happened
\* and none can happen later.
ReportHonest == \A c \in Clients :
    /\ (report[c] = "done" => effects[c] >= 1)
    /\ (report[c] = "notdone" => effects[c] = 0 /\ att[c] = "none" /\ inflight[c] = {})

\* A running attempt always has a durable intent record.
NoEffectWithoutIntent == \A c \in Clients : att[c] = "running" => intent[c] # "none"

\* Reachability controls (expected to fail): each path is reachable, so the
\* model is not vacuous there.
NeverUnknown == \A c \in Clients : cl[c] # "unknown"
NeverNotDone == \A c \in Clients : report[c] # "notdone"

=============================================================================
