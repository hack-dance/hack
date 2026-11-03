---- MODULE Instance ----
\* Lifecycle-session ownership for one shared-helper instance (one branch):
\* two overlapping `hack up` runs and one `hack down`. Source mapping, bounds
\* and omissions are in tests/models/tla/README.md ("Shared helper instance").
\*
\* Fix flags (all TRUE in positive.cfg; each control disables one):
\*   CheckEpoch          creator cleanup requires its own session epoch
\*   Revalidate          creation re-inspects the session under its lock
\*   StopOnEpochFailure  a failed epoch record stops the created session
\*                       before removing its entry
EXTENDS Naturals, TLC
CONSTANTS CheckEpoch, Revalidate, StopOnEpochFailure
Ups == {"a", "b"}
None == "none"
VARIABLES pc, cap, gen, epoch, owned, session, token, entry, healthy, lock, down
vars == <<pc, cap, gen, epoch, owned, session, token, entry, healthy, lock, down>>

Init == /\ pc = [u \in Ups |-> "idle"]
        /\ cap = [u \in Ups |-> 0]
        /\ gen = 0
        /\ epoch = <<None, None>>
        \* Cleanup authority: "no", "epoch" (created and recorded) or
        \* "token" (created, epoch record failed, stop unconfirmed).
        /\ owned = [u \in Ups |-> "no"]
        /\ session = "absent"
        /\ token = None          \* the live session's ownership token
        /\ entry = None          \* persisted lifecycle entry's token
        \* The entry is finalized with live processes (adoptable), not pending.
        /\ healthy = FALSE
        /\ lock = None           \* shared helper instance lock holder
        /\ down = "idle"

Free == lock = None

\* captureSharedHelperShutdownGeneration, before up.before hooks.
Capture(u) == /\ pc[u] = "idle"
              /\ pc' = [pc EXCEPT ![u] = "captured"]
              /\ cap' = [cap EXCEPT ![u] = gen]
              /\ UNCHANGED <<gen, epoch, owned, session, token, entry, healthy, lock, down>>

\* startProjectSharedHelpers refuses a start a down superseded.
Superseded(u) == /\ pc[u] = "captured" /\ gen # cap[u] /\ Free
                 /\ pc' = [pc EXCEPT ![u] = "done"]
                 /\ UNCHANGED <<cap, gen, epoch, owned, session, token, entry, healthy, lock, down>>

\* Helpers ready, then the controller's session decision under the lock:
\* adopt an owned healthy session (recording the adoption epoch), refuse a
\* session without matching state, or decide to create.
Decide(u) == /\ pc[u] = "captured" /\ gen = cap[u] /\ Free
             /\ IF session = "alive" /\ entry = token /\ healthy
                   THEN \* owned and healthy: adopt, recording the epoch
                        /\ pc' = [pc EXCEPT ![u] = "ready"]
                        /\ epoch' = <<u, "adopted">>
                        /\ UNCHANGED <<session, token, entry, healthy>>
                   ELSE IF session = "alive" /\ entry = token
                   THEN \* owned but stale (pending entry): replace it
                        /\ pc' = [pc EXCEPT ![u] = "create"]
                        /\ session' = "absent" /\ token' = None
                        /\ entry' = None /\ healthy' = FALSE
                        /\ UNCHANGED epoch
                   ELSE IF session = "alive"
                   THEN \* no matching state: refuse (block)
                        /\ pc' = [pc EXCEPT ![u] = "done"]
                        /\ UNCHANGED <<epoch, session, token, entry, healthy>>
                   ELSE /\ pc' = [pc EXCEPT ![u] = "create"]
                        /\ UNCHANGED <<epoch, session, token, entry, healthy>>
             /\ UNCHANGED <<cap, gen, owned, lock, down>>

\* Session creation transaction, one lock acquisition: revalidate, publish
\* pending ownership, create, record the epoch.
CreateBegin(u) == /\ pc[u] = "create" /\ Free
                  /\ IF Revalidate /\ session = "alive"
                        THEN /\ pc' = [pc EXCEPT ![u] = "done"]
                             /\ UNCHANGED lock
                        ELSE /\ pc' = [pc EXCEPT ![u] = "publish"]
                             /\ lock' = u
                  /\ UNCHANGED <<cap, gen, epoch, owned, session, token, entry, healthy, down>>

Publish(u) == /\ pc[u] = "publish" /\ lock = u
              /\ entry' = u /\ healthy' = FALSE
              /\ pc' = [pc EXCEPT ![u] = "createsess"]
              /\ UNCHANGED <<cap, gen, epoch, owned, session, token, lock, down>>

\* createSession fails when a session already exists; the pending entry is
\* removed only if it is still this start's (removeLifecycleStateEntryIfOwned).
CreateSession(u) ==
  /\ pc[u] = "createsess" /\ lock = u
  /\ IF session = "alive"
        THEN /\ entry' = IF entry = u THEN None ELSE entry
             /\ lock' = None
             /\ pc' = [pc EXCEPT ![u] = "done"]
             /\ UNCHANGED <<session, token>>
        ELSE /\ session' = "alive" /\ token' = u
             /\ pc' = [pc EXCEPT ![u] = "record"]
             /\ UNCHANGED <<entry, lock>>
  /\ UNCHANGED <<cap, gen, epoch, owned, healthy, down>>

Record(u) == /\ pc[u] = "record" /\ lock = u
             /\ epoch' = <<u, "created">>
             /\ owned' = [owned EXCEPT ![u] = "epoch"]
             \* Processes start and the entry is finalized right after.
             /\ healthy' = TRUE
             /\ lock' = None
             /\ pc' = [pc EXCEPT ![u] = "ready"]
             /\ UNCHANGED <<cap, gen, session, token, entry, down>>

\* The epoch record fails after the session was created.
RecordFailStopped(u) ==
  /\ StopOnEpochFailure /\ pc[u] = "record" /\ lock = u
  /\ session' = "absent" /\ token' = None
  /\ entry' = IF entry = u THEN None ELSE entry
  /\ lock' = None /\ pc' = [pc EXCEPT ![u] = "done"]
  /\ UNCHANGED <<cap, gen, epoch, owned, healthy, down>>
RecordFailUnconfirmed(u) ==
  /\ StopOnEpochFailure /\ pc[u] = "record" /\ lock = u
  /\ owned' = [owned EXCEPT ![u] = "token"]
  /\ lock' = None /\ pc' = [pc EXCEPT ![u] = "failed"]
  /\ UNCHANGED <<cap, gen, epoch, session, token, entry, healthy, down>>
RecordFailUnstopped(u) ==
  /\ ~StopOnEpochFailure /\ pc[u] = "record" /\ lock = u
  /\ entry' = IF entry = u THEN None ELSE entry
  /\ lock' = None /\ pc' = [pc EXCEPT ![u] = "done"]
  /\ UNCHANGED <<cap, gen, epoch, owned, session, token, healthy, down>>

\* assertCurrent before containers start.
Launch(u) == /\ pc[u] = "ready" /\ gen = cap[u] /\ Free
             /\ pc' = [pc EXCEPT ![u] = "launched"]
             /\ UNCHANGED <<cap, gen, epoch, owned, session, token, entry, healthy, lock, down>>

\* assertCurrent after containers start.
Succeed(u) == /\ pc[u] = "launched" /\ gen = cap[u] /\ Free
              /\ pc' = [pc EXCEPT ![u] = "succeeded"]
              /\ UNCHANGED <<cap, gen, epoch, owned, session, token, entry, healthy, lock, down>>

\* Compose failure, SIGINT/SIGTERM, or a failed assertCurrent.
Fail(u) == /\ pc[u] \in {"ready", "launched"}
           /\ pc' = [pc EXCEPT ![u] = "failed"]
           /\ UNCHANGED <<cap, gen, epoch, owned, session, token, entry, healthy, lock, down>>

\* runIfOwned under the lock, then the token-checked kill and entry removal.
Authorized(u) == \/ owned[u] = "token"
                 \/ /\ owned[u] = "epoch"
                    /\ (~CheckEpoch \/ epoch = <<u, "created">>)
Cleanup(u) == /\ pc[u] = "failed" /\ Free
              /\ pc' = [pc EXCEPT ![u] = "done"]
              /\ IF Authorized(u) /\ session = "alive" /\ token = u
                    THEN /\ session' = "absent" /\ token' = None
                         /\ entry' = IF entry = u THEN None ELSE entry
                    ELSE UNCHANGED <<session, token, entry>>
              /\ UNCHANGED <<cap, gen, epoch, owned, healthy, lock, down>>

\* The instance lock stayed busy: ownership undecidable, session kept.
CleanupUndecidable(u) == /\ pc[u] = "failed"
                         /\ pc' = [pc EXCEPT ![u] = "done"]
                         /\ UNCHANGED <<cap, gen, epoch, owned, session, token, entry, healthy, lock, down>>

\* A committed down: the stopping mark advances the generation; then the
\* normal stop controller stops the session through the persisted entry
\* (it can only reclaim a session whose entry names its token) and the
\* release advances the generation again (one step here; see README).
DownMark == /\ down = "idle" /\ Free
            /\ down' = "marked" /\ gen' = gen + 1
            /\ UNCHANGED <<pc, cap, epoch, owned, session, token, entry, healthy, lock>>
DownStop == /\ down = "marked" /\ Free
            /\ down' = "stopped" /\ gen' = gen + 1
            /\ IF session = "alive" /\ entry = token
                  THEN /\ session' = "absent" /\ token' = None
                  ELSE UNCHANGED <<session, token>>
            /\ entry' = None /\ healthy' = FALSE
            /\ UNCHANGED <<pc, cap, epoch, owned, lock>>

Next == \/ \E u \in Ups :
             \/ Capture(u) \/ Superseded(u) \/ Decide(u)
             \/ CreateBegin(u) \/ Publish(u) \/ CreateSession(u)
             \/ Record(u) \/ RecordFailStopped(u)
             \/ RecordFailUnconfirmed(u) \/ RecordFailUnstopped(u)
             \/ Launch(u) \/ Succeed(u) \/ Fail(u)
             \/ Cleanup(u) \/ CleanupUndecidable(u)
        \/ DownMark \/ DownStop
Spec == Init /\ [][Next]_vars

\* An up that succeeded with no down since its capture keeps a live session.
SessionSafe == \A u \in Ups :
                 (pc[u] = "succeeded" /\ cap[u] = gen) => session = "alive"

\* A live session always has a persisted entry naming its token, so the
\* normal stop controller (hack down) can reclaim it.
Reclaimable == session = "alive" => entry = token
====
