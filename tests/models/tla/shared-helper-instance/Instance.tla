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
\*   FinalizeRecheck     finalize publishes only while the entry and the
\*                       live session still carry this start's token
\*
\* Broken-design flags (all FALSE in positive.cfg; each control sets one):
\*   AbandonCreate       a timed-out createSession releases the lock while the
\*                       call keeps running and may create the session later
\*   AbandonReplace      a timed-out replacement releases the lock while its
\*                       stale ownership read and name-based kill continue
\*   MisreadTimeout      a timed-out session listing reads as absence
\*   UnlockedFailureCleanup  a failed creation's cleanup reads the token
\*                       under the lock but kills by name after releasing it
\*   UnfencedLaunch      process launch (and environment setup) mutate the
\*                       session by name without the lock and token check
\*   ReleaseOnFailedStop a down whose session stop failed or is unknown still
\*                       releases the instance's helper holders
EXTENDS Naturals, TLC
CONSTANTS CheckEpoch, Revalidate, StopOnEpochFailure, FinalizeRecheck,
          AbandonCreate, AbandonReplace, MisreadTimeout,
          UnlockedFailureCleanup, UnfencedLaunch, ReleaseOnFailedStop
Ups == {"a", "b"}
None == "none"
VARIABLES pc, cap, gen, epoch, owned, session, token, entry, healthy, lock, down,
          mytok, stale, foreign, released
vars == <<pc, cap, gen, epoch, owned, session, token, entry, healthy, lock, down,
          mytok, stale, foreign, released>>

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
        \* The session token this start created or adopted (finalize recheck).
        /\ mytok = [u \in Ups |-> None]
        \* Token an abandoned replacement read before its lock was released.
        /\ stale = [u \in Ups |-> None]
        \* A start launched a process into a session carrying another token.
        /\ foreign = FALSE
        \* The instance's helper holders were released (by a down) and not
        \* acquired again since.
        /\ released = FALSE

Free == lock = None

\* captureSharedHelperShutdownGeneration, before up.before hooks.
Capture(u) == /\ pc[u] = "idle"
              /\ pc' = [pc EXCEPT ![u] = "captured"]
              /\ cap' = [cap EXCEPT ![u] = gen]
              /\ UNCHANGED <<gen, epoch, owned, session, token, entry, healthy, lock, down, mytok, stale, foreign, released>>

\* startProjectSharedHelpers refuses a start a down superseded.
Superseded(u) == /\ pc[u] = "captured" /\ gen # cap[u] /\ Free
                 /\ pc' = [pc EXCEPT ![u] = "done"]
                 /\ UNCHANGED <<cap, gen, epoch, owned, session, token, entry, healthy, lock, down, mytok, stale, foreign, released>>

\* Helpers ready, then the controller's session decision under the lock:
\* adopt an owned healthy session (recording the adoption epoch), refuse a
\* session without matching state, or decide to create.
Decide(u) == /\ pc[u] = "captured" /\ gen = cap[u] /\ Free
             /\ IF session = "alive" /\ entry = token /\ healthy
                   THEN \* owned and healthy: adopt, recording the epoch
                        /\ pc' = [pc EXCEPT ![u] = "ready"]
                        /\ epoch' = <<u, "adopted">>
                        /\ mytok' = [mytok EXCEPT ![u] = token]
                        /\ UNCHANGED <<session, token, entry, healthy, stale>>
                   ELSE IF session = "alive" /\ entry = token
                   THEN \* owned but stale (pending entry): replace it
                        /\ pc' = [pc EXCEPT ![u] = "create"]
                        /\ session' = "absent" /\ token' = None
                        /\ entry' = None /\ healthy' = FALSE
                        /\ UNCHANGED <<epoch, mytok, stale>>
                   ELSE IF session = "alive"
                   THEN \* no matching state: refuse (block)
                        /\ pc' = [pc EXCEPT ![u] = "done"]
                        /\ UNCHANGED <<epoch, session, token, entry, healthy, mytok, stale>>
                   ELSE /\ pc' = [pc EXCEPT ![u] = "create"]
                        /\ UNCHANGED <<epoch, session, token, entry, healthy, mytok, stale>>
             /\ released' = FALSE
             /\ UNCHANGED <<cap, gen, owned, lock, down, stale, foreign>>

\* Session creation transaction, one lock acquisition: revalidate, publish
\* pending ownership, create, record the epoch.
CreateBegin(u) == /\ pc[u] = "create" /\ Free
                  /\ IF Revalidate /\ session = "alive"
                        THEN /\ pc' = [pc EXCEPT ![u] = "done"]
                             /\ UNCHANGED lock
                        ELSE /\ pc' = [pc EXCEPT ![u] = "publish"]
                             /\ lock' = u
                  /\ UNCHANGED <<cap, gen, epoch, owned, session, token, entry, healthy, down, mytok, stale, foreign, released>>

Publish(u) == /\ pc[u] = "publish" /\ lock = u
              /\ entry' = u /\ healthy' = FALSE
              /\ pc' = [pc EXCEPT ![u] = "createsess"]
              /\ UNCHANGED <<cap, gen, epoch, owned, session, token, lock, down, mytok, stale, foreign, released>>

\* createSession fails when a session already exists; the pending entry is
\* removed only if it is still this start's (removeLifecycleStateEntryIfOwned).
CreateSession(u) ==
  /\ pc[u] = "createsess" /\ lock = u
  /\ IF session = "alive"
        THEN /\ entry' = IF entry = u THEN None ELSE entry
             /\ lock' = None
             /\ pc' = [pc EXCEPT ![u] = "done"]
             /\ UNCHANGED <<session, token, mytok, stale, foreign, released>>
        ELSE /\ session' = "alive" /\ token' = u
             /\ pc' = [pc EXCEPT ![u] = "record"]
             /\ UNCHANGED <<entry, lock, mytok, stale, foreign, released>>
  /\ UNCHANGED <<cap, gen, epoch, owned, healthy, down, mytok, stale, foreign, released>>

Record(u) == /\ pc[u] = "record" /\ lock = u
             /\ epoch' = <<u, "created">>
             /\ owned' = [owned EXCEPT ![u] = "epoch"]
             /\ mytok' = [mytok EXCEPT ![u] = u]
             /\ lock' = None
             /\ pc' = [pc EXCEPT ![u] = "starting"]
             /\ UNCHANGED <<cap, gen, session, token, entry, healthy, down, stale, foreign, released>>

\* Lifecycle processes start while the entry is still pending (not healthy),
\* so another start may replace the session between launches. Each launch
\* is fenced: under the lock, and only while the persisted entry and the
\* live session still carry this start's token; a displaced start gives up
\* its authority and fails. (tmux environment setup runs inside the locked
\* creation transaction, Publish..Record, so it needs no step of its own.)
\* The unfenced control launches by session name whatever it now holds.
StartProcesses(u) ==
  /\ pc[u] = "starting"
  /\ IF UnfencedLaunch
        THEN /\ pc' = [pc EXCEPT ![u] = "finalize"]
             /\ foreign' = (foreign \/ (session = "alive" /\ token # mytok[u]))
             /\ UNCHANGED owned
        ELSE /\ Free
             /\ IF entry = mytok[u] /\ token = mytok[u]
                   THEN /\ pc' = [pc EXCEPT ![u] = "finalize"]
                        /\ UNCHANGED owned
                   ELSE /\ owned' = [owned EXCEPT ![u] = "no"]
                        /\ pc' = [pc EXCEPT ![u] = "done"]
             /\ UNCHANGED foreign
  /\ UNCHANGED <<cap, gen, epoch, session, token, entry, healthy, lock, down, mytok, stale, released>>

\* finalize() under the lock: publish the final (healthy) entry only while the
\* persisted entry and the live session still carry this start's token;
\* otherwise the start was displaced, gives up its authority and fails.
Finalize(u) ==
  /\ pc[u] = "finalize" /\ Free
  /\ IF ~FinalizeRecheck \/ (entry = mytok[u] /\ token = mytok[u])
        THEN /\ entry' = mytok[u] /\ healthy' = TRUE
             /\ pc' = [pc EXCEPT ![u] = "ready"]
             /\ UNCHANGED owned
        ELSE /\ owned' = [owned EXCEPT ![u] = "no"]
             /\ pc' = [pc EXCEPT ![u] = "done"]
             /\ UNCHANGED <<entry, healthy>>
  /\ UNCHANGED <<cap, gen, epoch, session, token, lock, down, mytok, stale, foreign, released>>

\* The epoch record fails after the session was created. Its cleanup (token
\* read, name-based kill, entry removal) runs inside the creation lock.
RecordFailStopped(u) ==
  /\ StopOnEpochFailure /\ ~UnlockedFailureCleanup
  /\ pc[u] = "record" /\ lock = u
  /\ session' = "absent" /\ token' = None
  /\ entry' = IF entry = u THEN None ELSE entry
  /\ lock' = None /\ pc' = [pc EXCEPT ![u] = "done"]
  /\ UNCHANGED <<cap, gen, epoch, owned, healthy, down, mytok, stale, foreign, released>>
\* Control: the cleanup reads the token under the lock, releases it, and the
\* name-based kill lands later (LateKill), possibly on a replacement.
RecordFailReadUnlocked(u) ==
  /\ StopOnEpochFailure /\ UnlockedFailureCleanup
  /\ pc[u] = "record" /\ lock = u
  /\ stale' = [stale EXCEPT ![u] = token]
  /\ lock' = None /\ pc' = [pc EXCEPT ![u] = "pendingkill"]
  /\ UNCHANGED <<cap, gen, epoch, owned, session, token, entry, healthy, down, mytok, foreign, released>>
RecordFailUnconfirmed(u) ==
  /\ StopOnEpochFailure /\ pc[u] = "record" /\ lock = u
  /\ owned' = [owned EXCEPT ![u] = "token"]
  /\ lock' = None /\ pc' = [pc EXCEPT ![u] = "failed"]
  /\ UNCHANGED <<cap, gen, epoch, session, token, entry, healthy, down, mytok, stale, foreign, released>>
RecordFailUnstopped(u) ==
  /\ ~StopOnEpochFailure /\ pc[u] = "record" /\ lock = u
  /\ entry' = IF entry = u THEN None ELSE entry
  /\ lock' = None /\ pc' = [pc EXCEPT ![u] = "done"]
  /\ UNCHANGED <<cap, gen, epoch, owned, session, token, healthy, down, mytok, stale, foreign, released>>

\* assertCurrent before containers start.
Launch(u) == /\ pc[u] = "ready" /\ gen = cap[u] /\ Free
             /\ pc' = [pc EXCEPT ![u] = "launched"]
             /\ UNCHANGED <<cap, gen, epoch, owned, session, token, entry, healthy, lock, down, mytok, stale, foreign, released>>

\* assertCurrent after containers start.
Succeed(u) == /\ pc[u] = "launched" /\ gen = cap[u] /\ Free
              /\ pc' = [pc EXCEPT ![u] = "succeeded"]
              /\ UNCHANGED <<cap, gen, epoch, owned, session, token, entry, healthy, lock, down, mytok, stale, foreign, released>>

\* Compose failure, SIGINT/SIGTERM, or a failed assertCurrent.
Fail(u) == /\ pc[u] \in {"starting", "finalize", "ready", "launched"}
           /\ pc' = [pc EXCEPT ![u] = "failed"]
           /\ UNCHANGED <<cap, gen, epoch, owned, session, token, entry, healthy, lock, down, mytok, stale, foreign, released>>

\* runIfOwned under the lock, then the token-checked kill and entry removal.
Authorized(u) == \/ owned[u] = "token"
                 \/ /\ owned[u] = "epoch"
                    /\ (~CheckEpoch \/ epoch = <<u, "created">>)
Cleanup(u) == /\ pc[u] = "failed" /\ Free
              /\ pc' = [pc EXCEPT ![u] = "done"]
              /\ IF Authorized(u) /\ session = "alive" /\ token = u
                    THEN /\ session' = "absent" /\ token' = None
                         /\ entry' = IF entry = u THEN None ELSE entry
                    ELSE UNCHANGED <<session, token, entry, mytok, stale, foreign, released>>
              /\ UNCHANGED <<cap, gen, epoch, owned, healthy, lock, down, mytok, stale, foreign, released>>

\* The instance lock stayed busy: ownership undecidable, session kept.
CleanupUndecidable(u) == /\ pc[u] = "failed"
                         /\ pc' = [pc EXCEPT ![u] = "done"]
                         /\ UNCHANGED <<cap, gen, epoch, owned, session, token, entry, healthy, lock, down, mytok, stale, foreign, released>>

\* A committed down: the stopping mark advances the generation; then the
\* normal stop controller stops the session through the persisted entry
\* (it can only reclaim a session whose entry names its token) and the
\* release advances the generation again (one step here; see README).
DownMark == /\ down = "idle" /\ Free
            /\ down' = "marked" /\ gen' = gen + 1
            /\ UNCHANGED <<pc, cap, epoch, owned, session, token, entry, healthy, lock, mytok, stale, foreign, released>>
DownStop == /\ down = "marked" /\ Free
            /\ down' = "stopped" /\ gen' = gen + 1
            /\ IF session = "alive" /\ entry = token
                  THEN /\ session' = "absent" /\ token' = None
                  ELSE UNCHANGED <<session, token>>
            /\ entry' = None /\ healthy' = FALSE /\ released' = TRUE
            /\ UNCHANGED <<pc, cap, epoch, owned, lock, mytok, stale, foreign>>
\* The session stop failed or its outcome is unknown: the session and its
\* entry stay, and so do the helper holders (the down fails; a later down
\* releases both). The control releases the holders anyway.
DownStopFailed == /\ down = "marked" /\ Free /\ session = "alive"
                  /\ down' = "failed"
                  /\ IF ReleaseOnFailedStop
                        THEN /\ gen' = gen + 1 /\ released' = TRUE
                        ELSE UNCHANGED <<gen, released>>
                  /\ UNCHANGED <<pc, cap, epoch, owned, session, token, entry, healthy, lock, mytok, stale, foreign>>

\* Bounded mux calls settle under the lock (positive design): a timed-out
\* createSession was killed; the server either created the session first
\* (outcome unknown: keep the entry and token authority) or not (retire it).
CreateTimeoutCreated(u) ==
  /\ ~AbandonCreate /\ pc[u] = "createsess" /\ lock = u /\ session = "absent"
  /\ session' = "alive" /\ token' = u
  /\ owned' = [owned EXCEPT ![u] = "token"]
  /\ lock' = None /\ pc' = [pc EXCEPT ![u] = "failed"]
  /\ UNCHANGED <<cap, gen, epoch, entry, healthy, down, mytok, stale, foreign, released>>
CreateTimeoutNotCreated(u) ==
  /\ ~AbandonCreate /\ pc[u] = "createsess" /\ lock = u /\ session = "absent"
  /\ entry' = IF entry = u THEN None ELSE entry
  /\ lock' = None /\ pc' = [pc EXCEPT ![u] = "done"]
  /\ UNCHANGED <<cap, gen, epoch, owned, session, token, healthy, down, mytok, stale, foreign, released>>

\* Broken design: the deadline stops waiting but the call keeps running.
CreateAbandon(u) ==
  /\ AbandonCreate /\ pc[u] = "createsess" /\ lock = u /\ session = "absent"
  /\ lock' = None /\ pc' = [pc EXCEPT ![u] = "pending"]
  /\ UNCHANGED <<cap, gen, epoch, owned, session, token, entry, healthy, down, mytok, stale, foreign, released>>
LateCreate(u) ==
  /\ pc[u] = "pending"
  /\ IF session = "absent"
        THEN /\ session' = "alive" /\ token' = u
        ELSE UNCHANGED <<session, token>>
  /\ pc' = [pc EXCEPT ![u] = "done"]
  /\ UNCHANGED <<cap, gen, epoch, owned, entry, healthy, lock, down, mytok, stale, foreign, released>>

\* Broken design: a stale (pending) session's replacement reads its token,
\* then its deadline releases the lock; the kill and retirement continue.
ReplaceAbandon(u) ==
  /\ AbandonReplace /\ pc[u] = "captured" /\ gen = cap[u] /\ Free
  /\ session = "alive" /\ entry = token /\ ~healthy
  /\ stale' = [stale EXCEPT ![u] = token]
  /\ pc' = [pc EXCEPT ![u] = "pendingkill"]
  /\ UNCHANGED <<cap, gen, epoch, owned, session, token, entry, healthy, lock, down, mytok, foreign, released>>
LateKill(u) ==
  /\ pc[u] = "pendingkill"
  \* The stale read matched, so the kill goes out by session name.
  /\ session' = "absent" /\ token' = None
  /\ entry' = IF entry = stale[u] THEN None ELSE entry
  /\ pc' = [pc EXCEPT ![u] = "done"]
  /\ UNCHANGED <<cap, gen, epoch, owned, healthy, lock, down, mytok, stale, foreign, released>>

\* A timed-out inspection (positive design): unknown, fail closed.
InspectTimeout(u) ==
  /\ pc[u] \in {"captured", "create"} /\ Free
  /\ pc' = [pc EXCEPT ![u] = "done"]
  /\ UNCHANGED <<cap, gen, epoch, owned, session, token, entry, healthy, lock, down, mytok, stale, foreign, released>>
\* Broken design: a timed-out listing reads as absence, both in the decision
\* and in the creation transaction's revalidation.
MisreadDecide(u) ==
  /\ MisreadTimeout /\ pc[u] = "captured" /\ gen = cap[u] /\ Free
  /\ session = "alive"
  /\ pc' = [pc EXCEPT ![u] = "create"]
  /\ UNCHANGED <<cap, gen, epoch, owned, session, token, entry, healthy, lock, down, mytok, stale, foreign, released>>
MisreadCreateBegin(u) ==
  /\ MisreadTimeout /\ pc[u] = "create" /\ Free /\ session = "alive"
  /\ pc' = [pc EXCEPT ![u] = "publish"] /\ lock' = u
  /\ UNCHANGED <<cap, gen, epoch, owned, session, token, entry, healthy, down, mytok, stale, foreign, released>>

Next == \/ \E u \in Ups :
             \/ Capture(u) \/ Superseded(u) \/ Decide(u)
             \/ CreateBegin(u) \/ Publish(u) \/ CreateSession(u)
             \/ Record(u) \/ StartProcesses(u) \/ Finalize(u)
             \/ RecordFailStopped(u) \/ RecordFailReadUnlocked(u)
             \/ RecordFailUnconfirmed(u) \/ RecordFailUnstopped(u)
             \/ CreateTimeoutCreated(u) \/ CreateTimeoutNotCreated(u)
             \/ CreateAbandon(u) \/ LateCreate(u)
             \/ ReplaceAbandon(u) \/ LateKill(u)
             \/ InspectTimeout(u) \/ MisreadDecide(u) \/ MisreadCreateBegin(u)
             \/ Launch(u) \/ Succeed(u) \/ Fail(u)
             \/ Cleanup(u) \/ CleanupUndecidable(u)
        \/ DownMark \/ DownStop \/ DownStopFailed
Spec == Init /\ [][Next]_vars

\* An up that succeeded with no down since its capture keeps a live session.
SessionSafe == \A u \in Ups :
                 (pc[u] = "succeeded" /\ cap[u] = gen) => session = "alive"

\* A live session always has a persisted entry naming its token, so the
\* normal stop controller (hack down) can reclaim it.
Reclaimable == session = "alive" => entry = token

\* A start never mutates (launches into) a session carrying another token.
NoForeignLaunch == ~foreign

\* A down that could not confirm the session stopped keeps the helper
\* holders that session's processes may still use.
HelpersKeptForSession == (down = "failed" /\ session = "alive") => ~released
====
