--------------------------- MODULE SupervisorJob ---------------------------
EXTENDS Naturals, FiniteSets

\* Reviewed statechart committed before this file: 7903351ccfb18664ad894ae98ca6371779424935.
\* Actual = TRUE follows the current implementation on serialized store schedules.
\* Actual = FALSE enables ONLY the named check's hypothetical reference protection.
\* Mutation removes that protection (or the existing P5 terminal memoization).
CONSTANTS Count, Check, Actual, Mutation, AllowFailure
Actors == 1..Count

VARIABLES step, live, exited, drained, claim, write, events, meta, ack,
          admitted, executions, faultUsed
vars == <<step, live, exited, drained, claim, write, events, meta, ack,
          admitted, executions, faultUsed>>

Reference == ~Actual
ExclusiveAdmission == Reference /\ Check = "P1" /\ ~Mutation
DeduplicateAdmission == Reference /\
    (Check = "P2" \/ (Check = "P3" /\ ~Mutation))
WaitForExit == Reference /\ Check = "P2" /\ ~Mutation
RecoverPersistence == Reference /\ Check = "P4" /\ ~Mutation
MemoizeOutcome == ~(Check = "P5" /\ Mutation)
\* Environment scheduling restriction, not a product lock: no other store call
\* overlaps the terminal event append and its captured-metadata rewrite.
StoreFree == \A r \in Actors : write[r] # "eventMeta"

Init ==
    /\ step = [r \in Actors |-> "idle"]
    /\ live = {}
    /\ exited = {}
    /\ drained = {}
    /\ claim = [r \in Actors |-> "none"]
    /\ write = [r \in Actors |-> "none"]
    /\ events = [r \in Actors |-> 0]
    /\ meta = "queued"
    /\ ack = {}
    /\ admitted = {}
    /\ executions = 0
    /\ faultUsed = FALSE

\* T2/T13: metadata existence/command validation; no actual ownership/status guard.
\* P3 restricts the caller schedule to a sequential retry of the same stored ID.
Begin(r) ==
    /\ StoreFree
    /\ step[r] = "idle"
    /\ Check # "P3" \/ r = 1 \/ step[1] = "done"
    /\ ~ExclusiveAdmission \/ \A a \in Actors : step[a] \in {"idle", "done"}
    /\ ~DeduplicateAdmission \/ admitted = {}
    /\ step' = [step EXCEPT ![r] = "starting"]
    /\ admitted' = admitted \cup {r}
    /\ UNCHANGED <<live, exited, drained, claim, write, events, meta, ack,
                    executions, faultUsed>>

\* T3/T5: complete successful store operations, serialized with other store calls.
\* This restriction is a real schedule, NOT a claim of store linearizability.
Starting(r) ==
    /\ StoreFree
    /\ step[r] = "starting"
    /\ meta' = "starting"
    /\ step' = [step EXCEPT ![r] = "startingEvent"]
    /\ UNCHANGED <<live, exited, drained, claim, write, events, ack,
                    admitted, executions, faultUsed>>
StartingEvent(r) ==
    /\ StoreFree
    /\ step[r] = "startingEvent"
    /\ step' = [step EXCEPT ![r] = "spawn"]
    /\ UNCHANGED <<live, exited, drained, claim, write, events, meta, ack,
                    admitted, executions, faultUsed>>
Spawn(r) ==
    /\ step[r] = "spawn"
    /\ step' = [step EXCEPT ![r] = "running"]
    /\ live' = live \cup {r}
    /\ executions' = executions + 1
    /\ UNCHANGED <<exited, drained, claim, write, events, meta, ack,
                    admitted, faultUsed>>
Running(r) ==
    /\ StoreFree
    /\ step[r] = "running"
    /\ meta' = "running"
    /\ step' = [step EXCEPT ![r] = "startedEvent"]
    /\ UNCHANGED <<live, exited, drained, claim, write, events, ack,
                    admitted, executions, faultUsed>>
Register(r) ==
    /\ StoreFree
    /\ step[r] = "startedEvent"
    /\ step' = [step EXCEPT ![r] = "ready"]
    /\ UNCHANGED <<live, exited, drained, claim, write, events, meta, ack,
                    admitted, executions, faultUsed>>

\* T6: signal does not imply exit. Synchronous claim precedes persistence awaits.
Cancel(r) ==
    /\ step[r] = "ready"
    /\ claim[r] = "none"
    /\ claim' = [claim EXCEPT ![r] = "cancelled"]
    /\ write' = [write EXCEPT ![r] = "status"]
    /\ UNCHANGED <<step, live, exited, drained, events, meta, ack,
                    admitted, executions, faultUsed>>
\* T7 environment: exit is independent of signal, followed by stream EOF/drain.
Exit(r) ==
    /\ r \in live
    /\ live' = live \ {r}
    /\ exited' = exited \cup {r}
    /\ UNCHANGED <<step, drained, claim, write, events, meta, ack,
                    admitted, executions, faultUsed>>
Drain(r) ==
    /\ r \in exited \ drained
    /\ drained' = drained \cup {r}
    /\ UNCHANGED <<step, live, exited, claim, write, events, meta, ack,
                    admitted, executions, faultUsed>>
\* T7 finish: failed/completed are equivalent for these checks; use completed.
Finish(r) ==
    /\ step[r] = "ready"
    /\ r \in drained
    /\ claim[r] = "none" \/
       (~MemoizeOutcome /\ claim[r] = "cancelled" /\ write[r] = "done")
    /\ claim' = [claim EXCEPT ![r] = "completed"]
    /\ write' = [write EXCEPT ![r] = "status"]
    /\ UNCHANGED <<step, live, exited, drained, events, meta, ack,
                    admitted, executions, faultUsed>>

\* T8/T9: status write, event append, and event-sequence metadata write are distinct.
PersistStatus(r) ==
    /\ StoreFree
    /\ write[r] = "status"
    /\ meta' = claim[r]
    /\ write' = [write EXCEPT ![r] = "event"]
    /\ UNCHANGED <<step, live, exited, drained, claim, events, ack,
                    admitted, executions, faultUsed>>
AppendEvent(r) ==
    /\ StoreFree
    /\ write[r] = "event"
    /\ events' = [events EXCEPT ![r] = @ + 1]
    /\ write' = [write EXCEPT ![r] = "eventMeta"]
    /\ UNCHANGED <<step, live, exited, drained, claim, meta, ack,
                    admitted, executions, faultUsed>>
PersistEventMeta(r) ==
    /\ write[r] = "eventMeta"
    /\ write' = [write EXCEPT ![r] = "done"]
    /\ UNCHANGED <<step, live, exited, drained, claim, events, meta, ack,
                    admitted, executions, faultUsed>>
\* T10: ack is history, never reset by another invocation or terminal transition.
Acknowledge(r) ==
    /\ claim[r] = "cancelled"
    /\ write[r] = "done"
    /\ r \notin ack
    /\ ~WaitForExit \/ r \in exited
    /\ ack' = ack \cup {r}
    /\ UNCHANGED <<step, live, exited, drained, claim, write, events, meta,
                    admitted, executions, faultUsed>>
\* T11/T12: run cannot settle before exit and drain, even when persistence rejected.
Return(r) ==
    /\ step[r] = "ready"
    /\ r \in drained
    /\ write[r] = "done" \/ (write[r] = "rejected" /\ ~RecoverPersistence)
    /\ step' = [step EXCEPT ![r] = "done"]
    /\ UNCHANGED <<live, exited, drained, claim, write, events, meta, ack,
                    admitted, executions, faultUsed>>
\* One finite terminal status failure. Later store operations can succeed.
RejectStatus(r) ==
    /\ StoreFree
    /\ AllowFailure /\ ~faultUsed
    /\ write[r] = "status"
    /\ faultUsed' = TRUE
    /\ write' = [write EXCEPT ![r] = "rejected"]
    /\ UNCHANGED <<step, live, exited, drained, claim, events, meta, ack,
                    admitted, executions>>
\* Hypothetical reference only; the product has no recovery transition.
Recover(r) ==
    /\ RecoverPersistence
    /\ write[r] = "rejected"
    /\ write' = [write EXCEPT ![r] = "status"]
    /\ UNCHANGED <<step, live, exited, drained, claim, events, meta, ack,
                    admitted, executions, faultUsed>>

Advance(r) == Begin(r) \/ Starting(r) \/ StartingEvent(r) \/ Spawn(r) \/
              Running(r) \/ Register(r) \/ Finish(r) \/ Return(r)
\* Stutter only after all invocations settle, including rejected persistence.
\* Reference deduplication can leave an invocation permanently unstarted.
\* A rejected terminal write still violates P4; returning is not durable success.
Idle ==
    /\ \A r \in Actors :
        \/ /\ step[r] = "done"
           /\ write[r] = "done" \/ (write[r] = "rejected" /\ ~RecoverPersistence)
           /\ claim[r] # "cancelled" \/ write[r] = "rejected" \/ r \in ack
        \/ /\ step[r] = "idle"
           /\ DeduplicateAdmission /\ admitted # {}
    /\ UNCHANGED vars
Next == (\E r \in Actors : Advance(r) \/ Cancel(r) \/ Exit(r) \/ Drain(r) \/
        PersistStatus(r) \/ AppendEvent(r) \/ PersistEventMeta(r) \/
        Acknowledge(r) \/ RejectStatus(r) \/ Recover(r)) \/ Idle

\* Weak fairness: runnable continuations and store operations complete; processes
\* eventually exit and streams drain. No fairness requires cancellation or failure.
\* RejectStatus can disable persistence once; fairness cannot invent actual recovery.
Fairness == \A r \in Actors :
    WF_vars(Advance(r)) /\ WF_vars(Exit(r)) /\ WF_vars(Drain(r)) /\
    WF_vars(PersistStatus(r)) /\ WF_vars(AppendEvent(r)) /\
    WF_vars(PersistEventMeta(r)) /\ WF_vars(Acknowledge(r)) /\ WF_vars(Recover(r))
Spec == Init /\ [][Next]_vars /\ Fairness

SingleRunner == Cardinality(live) <= 1
CancelQuiescent == ack # {} => live = {}
RetryIdempotent == executions <= 1
ClaimedTerminal == \A r \in Actors : (claim[r] # "none") ~> (write[r] = "done")
CancelWins == \A r \in ack : claim[r] = "cancelled" /\ meta = "cancelled" /\ events[r] = 1
=============================================================================
