---------------------------- MODULE ServingExit -----------------------------
(* HACK-2720. A routed run is ready; the shared HTTPS owner serves it with its *)
(* child pair: the hostname authority (which every request is routed        *)
(* through) and Caddy (which holds the HTTPS port). The owner is then killed  *)
(* outright, so none of its own cleanup runs. The authority learns that its   *)
(* owner is gone only from its stdin FIFO; Caddy only from its authority.     *)
(* Afterwards `hack down` recovers the run's lease and the next `up -d`       *)
(* starts a new owner, or finds records it cannot get past.                  *)
(*                                                                           *)
(* Old behaviour: PipeCheck = FALSE (the serving loop read its pipe only    *)
(* when `poll` reported it, which Darwin never does on a named FIFO whose    *)
(* writer closed, and it waited with no timeout when it had no clients),     *)
(* StopsCaddy = FALSE (nothing stopped Caddy but its owner), RetireExited =  *)
(* FALSE (recovery could only release a lease through a live owner).         *)
(* Fix: one non-blocking read of the pipe after every wake-up, with a wait   *)
(* of at most one tick (1 s); the authority asks its Caddy to stop whenever  *)
(* it stops serving; recovery retires an owner that exited while serving,    *)
(* after it proves the owner process gone, waits for the children, and stops *)
(* an orphaned authority only cooperatively, by its exact identity.          *)
EXTENDS Naturals
CONSTANTS PipeCheck, StopsCaddy, RetireExited, Deadline
VARIABLES owner, authority, caddy, since, records, down, up
vars == <<owner, authority, caddy, since, records, down, up>>

Init == /\ owner = "ready" /\ authority = "serving" /\ caddy = "running"
        /\ since = 0 /\ records = "held" /\ down = "idle" /\ up = "idle"

\* The environment kills the ready owner (kill -9): its FIFO writer closes.
Kill == /\ owner = "ready"
        /\ owner' = "killed" /\ since' = 0
        /\ UNCHANGED <<authority, caddy, records, down, up>>

(* One tick (a second) passes while the authority still serves a killed     *)
(* owner. With PipeCheck the loop wakes and checks at least once a tick, so *)
(* no second tick passes before it notices; the old loop could wait forever *)
(* (bounded here just past the deadline, to show the violation).           *)
Tick == /\ owner = "killed" /\ authority = "serving"
        /\ since < (IF PipeCheck THEN 1 ELSE Deadline + 1)
        /\ since' = since + 1
        /\ UNCHANGED <<owner, authority, caddy, records, down, up>>

\* The serving loop reads end of file on its owner pipe and stops serving,
\* stopping its Caddy on the way out (StopsCaddy) and removing its socket.
Notice == /\ owner = "killed" /\ authority = "serving" /\ PipeCheck
          /\ authority' = "exited"
          /\ caddy' = IF StopsCaddy THEN "stopped" ELSE caddy
          /\ UNCHANGED <<owner, since, records, down, up>>

(* `hack down` recovers the lease, at any time after the kill, so also     *)
(* before the authority noticed (an older runtime, or a faster caller). It  *)
(* has proved the owner process gone. An authority still serving after its  *)
(* wait is stopped cooperatively by its exact identity, and that stop takes *)
(* its Caddy with it (StopsCaddy). It retires the owner's records only when *)
(* both children are gone; otherwise it refuses with a next step.           *)
Down == /\ owner = "killed" /\ down = "idle"
        /\ IF RetireExited
             THEN LET c == IF authority = "serving" /\ StopsCaddy
                             THEN "stopped" ELSE caddy
                  IN /\ authority' = "exited"
                     /\ caddy' = c
                     /\ records' = IF c = "stopped" THEN "retired" ELSE records
                     /\ down' = IF c = "stopped" THEN "confirmed" ELSE "refused"
             ELSE /\ down' = "refused"
                  /\ UNCHANGED <<authority, caddy, records>>
        /\ UNCHANGED <<owner, since, up>>

\* The next `up -d`: a new owner starts unless the old records are retained.
Up == /\ up = "idle" /\ down # "idle"
      /\ up' = IF records = "retired" THEN "started" ELSE "recoveryRequired"
      /\ UNCHANGED <<owner, authority, caddy, since, records, down>>

Next == Kill \/ Tick \/ Notice \/ Down \/ Up
\* The kill, `down` and `up` are the environment: no fairness for them.
Spec == Init /\ [][Next]_vars /\ WF_vars(Notice) /\ WF_vars(Tick)

TypeOK ==
  /\ owner \in {"ready", "killed"}
  /\ authority \in {"serving", "exited"}
  /\ caddy \in {"running", "stopped"}
  /\ since \in 0..(Deadline + 1)
  /\ records \in {"held", "retired"}
  /\ down \in {"idle", "confirmed", "refused"}
  /\ up \in {"idle", "started", "recoveryRequired"}
\* The authority (and with it Caddy) is gone within the deadline (2 s).
NoticedInTime == (owner = "killed" /\ authority = "serving") => since <= Deadline
\* A healthy owner's authority never stops serving on its own.
NoFalseExit == owner = "ready" => (authority = "serving" /\ caddy = "running")
\* Recovery never retires the records of a live owner.
NoLiveRetire == records = "retired" => owner = "killed"
\* A confirmed `down` leaves no child of the killed owner running.
DownLeavesNothing == down = "confirmed" => (authority = "exited" /\ caddy = "stopped")
\* `hack down` after the kill does not fail, and the next `up` needs no recovery.
DownConfirms == down # "refused"
NoRecoveryRequired == up # "recoveryRequired"
\* Once the owner is killed, both children end without anyone's help.
ChildrenEnd == owner = "killed" ~> (authority = "exited" /\ caddy = "stopped")
\* Reachability: a killed owner is recovered and the next `up` starts.
NeverStartedAfterKill == ~(owner = "killed" /\ up = "started")
=============================================================================
