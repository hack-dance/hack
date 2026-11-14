------------------------------ MODULE StartStop ------------------------------
EXTENDS Naturals

CONSTANT EarlyUnlock

VARIABLES paused, holder, child, down, running, lateStart

vars == <<paused, holder, child, down, running, lateStart>>

Init ==
  /\ paused = FALSE
  /\ holder = "none"
  /\ child = "queued"
  /\ down = "idle"
  /\ running \in BOOLEAN
  /\ lateStart = FALSE

LoginLock ==
  /\ child = "queued"
  /\ holder = "none"
  /\ holder' = "login"
  /\ child' = "checking"
  /\ UNCHANGED <<paused, down, running, lateStart>>

LoginAdmit ==
  /\ holder = "login"
  /\ child = "checking"
  /\ ~paused
  /\ child' = "pending"
  /\ UNCHANGED <<paused, holder, down, running, lateStart>>

LoginRefuse ==
  /\ holder = "login"
  /\ child = "checking"
  /\ paused
  /\ holder' = "none"
  /\ child' = "refused"
  /\ UNCHANGED <<paused, down, running, lateStart>>

(* Negative control: release admission while the child can still start runtime. *)
ReleaseBeforeChildSettles ==
  /\ EarlyUnlock
  /\ holder = "login"
  /\ child = "pending"
  /\ holder' = "none"
  /\ UNCHANGED <<paused, child, down, running, lateStart>>

ChildStart ==
  /\ child = "pending"
  /\ child' = "started"
  /\ running' = TRUE
  /\ lateStart' = (lateStart \/ (down = "done"))
  /\ UNCHANGED <<paused, holder, down>>

ChildSettle ==
  /\ child = "started"
  /\ child' = "settled"
  /\ holder' = IF holder = "login" THEN "none" ELSE holder
  /\ UNCHANGED <<paused, down, running, lateStart>>

(* A dead lock-owning child has no remaining capability to issue startup effects. *)
ChildCrashOrFailure ==
  /\ child \in {"checking", "pending", "started"}
  /\ child' = "settled"
  /\ holder' = IF holder = "login" THEN "none" ELSE holder
  /\ UNCHANGED <<paused, down, running, lateStart>>

DownPause ==
  /\ down = "idle"
  /\ paused' = TRUE
  /\ down' = "waiting"
  /\ UNCHANGED <<holder, child, running, lateStart>>

DownLock ==
  /\ down = "waiting"
  /\ holder = "none"
  /\ holder' = "down"
  /\ down' = "stopping"
  /\ UNCHANGED <<paused, child, running, lateStart>>

DownStop ==
  /\ down = "stopping"
  /\ holder = "down"
  /\ running' = FALSE
  /\ down' = "returning"
  /\ UNCHANGED <<paused, holder, child, lateStart>>

DownReturn ==
  /\ down = "returning"
  /\ holder = "down"
  /\ down' = "done"
  /\ holder' = "none"
  /\ UNCHANGED <<paused, child, running, lateStart>>

DownFailure ==
  /\ down \in {"stopping", "returning"}
  /\ holder = "down"
  /\ down' = "failed"
  /\ holder' = "none"
  /\ UNCHANGED <<paused, child, running, lateStart>>

Next ==
  \/ LoginLock
  \/ LoginAdmit
  \/ LoginRefuse
  \/ ReleaseBeforeChildSettles
  \/ ChildStart
  \/ ChildSettle
  \/ ChildCrashOrFailure
  \/ DownPause
  \/ DownLock
  \/ DownStop
  \/ DownReturn
  \/ DownFailure

TypeOK ==
  /\ paused \in BOOLEAN
  /\ holder \in {"none", "login", "down"}
  /\ child \in {"queued", "checking", "pending", "started", "settled", "refused"}
  /\ down \in {"idle", "waiting", "stopping", "returning", "done", "failed"}
  /\ running \in BOOLEAN
  /\ lateStart \in BOOLEAN

NoStartAfterSuccessfulDown == ~lateStart
SuccessfulDownIsStopped == (down = "done") => ~running

Spec == Init /\ [][Next]_vars
=============================================================================
