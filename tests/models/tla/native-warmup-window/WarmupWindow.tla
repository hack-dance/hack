---------------------------- MODULE WarmupWindow ----------------------------
(* HACK-2669, HACK-2707, HACK-2708, HACK-2709. After `hack up -d` returns     *)
(* with routes warming, the owner reaches its ready line and releases the     *)
(* provider lease. The detached frontend then takes the run's shared HTTPS    *)
(* lease: the shared owner's hostname authority waits for the provider lease  *)
(* to start (AuthorityWait), and the owner verifies the acquire with a graph  *)
(* read under the provider lease (VerifyWait). A release after the stop       *)
(* verifies the same way. Every one of these steps contends with whatever     *)
(* else holds the provider lease at that moment:                              *)
(*   - a brief holder (a `hack exec` or `hack run` that waited for ready, or  *)
(*     the ready owner's own restart tick), holding at most CmdHold ticks;    *)
(*   - a stop (`hack down`, Ctrl-C), holding it for StopHold ticks.          *)
(* A warm-up step that gives up while the run is ready makes the frontend    *)
(* stop the whole run (torn). A shared owner whose startup gave up keeps its *)
(* startup failure, so the frontend cannot release or recover its lease and  *)
(* the run needs explicit recovery (fin = "unconfirmed", E_RECOVERY_REQUIRED).*)
(*                                                                           *)
(* Old behaviour: VerifyWait = 0 (one nonblocking read), AuthorityWait = 1   *)
(* (5 s, shorter than a stop), Await = FALSE (cleanup did not wait for an    *)
(* acquisition still in flight, nor did a late acquisition stop after it),   *)
(* Retire = FALSE (a startup failure always stayed retained).                *)
(* Fix: the reads wait out contention (15 s), the authority waits as long as *)
(* owned cleanup does (30 s), cleanup awaits the in-flight acquisition, and  *)
(* recovery retires an owner generation whose startup admitted nothing, then *)
(* verifies the release through the retired record (Retire). The last one   *)
(* makes the outcome independent of the stop's length: a stop can hold the   *)
(* lease far longer than any authority wait (StopHold > AuthorityWait).      *)
EXTENDS Naturals
CONSTANTS VerifyWait, AuthorityWait, CmdHold, StopHold, Await, Retire
VARIABLES run, lease, held, https, waited, cmd, torn, fin, refusedSeen
vars == <<run, lease, held, https, waited, cmd, torn, fin, refusedSeen>>

\* Steps that wait for the provider lease, each with its own bound.
Waiting == {"authority", "verify", "releasing"}
Bound(step) == IF step = "authority" THEN AuthorityWait ELSE VerifyWait
\* The acquisition has not settled yet.
InFlight == {"pending", "authority", "verify"}

Init == /\ run = "ready" /\ lease = "free" /\ held = 0
        /\ https = "pending" /\ waited = 0
        /\ cmd = "idle" /\ torn = FALSE /\ fin = "open"
        /\ refusedSeen = FALSE

\* A warm-up step that gave up: while the run is still ready the frontend
\* stops the whole run; during a stop it changes nothing more.
GiveUp == /\ torn' = (torn \/ run = "ready")
          /\ run' = IF run = "ready" THEN "stopReq" ELSE run

(* The frontend starts the acquisition at the ready line. With the fix it   *)
(* starts none once the graph owner has exited.                             *)
Spawn == /\ https = "pending" /\ ~(Await /\ run = "stopped")
         /\ https' = "authority" /\ waited' = 0
         /\ UNCHANGED <<run, lease, held, cmd, torn, fin, refusedSeen>>
Skip == /\ Await /\ https = "pending" /\ run = "stopped"
        /\ https' = "none"
        /\ UNCHANGED <<run, lease, held, waited, cmd, torn, fin, refusedSeen>>

\* The authority takes the free lease for a moment, publishes, releases.
AuthorityStart == /\ https = "authority" /\ lease = "free"
                  /\ https' = "verify" /\ waited' = 0
                  /\ UNCHANGED <<run, lease, held, cmd, torn, fin, refusedSeen>>
AuthorityExpire == /\ https = "authority" /\ lease # "free"
                   /\ waited = AuthorityWait
                   /\ https' = "startupFailed" /\ GiveUp
                   /\ UNCHANGED <<lease, held, waited, cmd, fin, refusedSeen>>
\* The acquire's graph read: a ready graph is admitted; a stopping or stopped
\* one is refused cleanly (nothing admitted, recoverable).
VerifyTake == /\ https = "verify" /\ lease = "free"
              /\ https' = IF run = "ready" THEN "admitted" ELSE "refused"
              /\ refusedSeen' = (refusedSeen \/ run # "ready")
              /\ waited' = 0
              /\ UNCHANGED <<run, lease, held, cmd, torn, fin>>
VerifyExpire == /\ https = "verify" /\ lease # "free"
                /\ waited = VerifyWait
                /\ https' = "refused" /\ GiveUp /\ refusedSeen' = TRUE
                /\ UNCHANGED <<lease, held, waited, cmd, fin>>

\* One brief holder: a command, or the ready owner's tick. It may arrive at
\* any time, including after the stop (an exec that waited for the lease).
CmdTake == /\ cmd = "idle" /\ lease = "free"
           /\ lease' = "cmd" /\ held' = 0 /\ cmd' = "holding"
           /\ UNCHANGED <<run, https, waited, torn, fin, refusedSeen>>
CmdRelease == /\ lease = "cmd"
              /\ lease' = "free" /\ cmd' = "done"
              /\ UNCHANGED <<run, held, https, waited, torn, fin, refusedSeen>>

\* `hack down` or Ctrl-C; the stop waits for a free lease, then holds it.
Request == /\ run = "ready" /\ run' = "stopReq"
           /\ UNCHANGED <<lease, held, https, waited, cmd, torn, fin, refusedSeen>>
StopTake == /\ run = "stopReq" /\ lease = "free"
            /\ lease' = "stop" /\ held' = 0 /\ run' = "stopping"
            /\ UNCHANGED <<https, waited, cmd, torn, fin, refusedSeen>>
StopDone == /\ lease = "stop"
            /\ lease' = "free" /\ run' = "stopped"
            /\ UNCHANGED <<held, https, waited, cmd, torn, fin, refusedSeen>>

(* The frontend's cleanup after the graph stopped. With Await it first lets *)
(* the acquisition settle. An admitted or refused lease is released (a      *)
(* verified release); no intent needs nothing; an owner still starting      *)
(* leaves nothing to release or recover. A startup failure admitted nothing *)
(* (the authority's lease wait expired): with Retire, recovery retires that *)
(* owner generation and verifies the release through the retired record,    *)
(* which reads under the lease like any release; without it the failure is  *)
(* retained and the lease cannot be recovered.                              *)
CleanupStart ==
  /\ run = "stopped" /\ fin = "open"
  /\ https \notin {"releasing", "released", "retained"}
  /\ (Await => https \notin InFlight)
  /\ IF https \in {"admitted", "refused"}
        \/ (Retire /\ https = "startupFailed")
       THEN /\ https' = "releasing" /\ waited' = 0
            /\ UNCHANGED fin
       ELSE /\ fin' = IF https \in {"pending", "none"}
                        THEN "confirmed" ELSE "unconfirmed"
            /\ UNCHANGED <<https, waited>>
  /\ UNCHANGED <<run, lease, held, cmd, torn, refusedSeen>>
ReleaseTake == /\ https = "releasing" /\ lease = "free"
               /\ https' = "released" /\ fin' = "confirmed"
               /\ UNCHANGED <<run, lease, held, waited, cmd, torn, refusedSeen>>
ReleaseExpire == /\ https = "releasing" /\ lease # "free"
                 /\ waited = VerifyWait
                 /\ https' = "retained" /\ fin' = "unconfirmed"
                 /\ UNCHANGED <<run, lease, held, waited, cmd, torn, refusedSeen>>

(* One unit of time passes only while someone holds the lease. A waiting    *)
(* step polls far more often than a holder holds (50 ms against hundreds of *)
(* ms), so no time passes while it could take a free lease. A brief holder  *)
(* holds at most CmdHold ticks, a stop at most StopHold ticks, and a waiting *)
(* step's wait counts up to its bound across holders (one shared deadline). *)
Tick == /\ lease \in {"cmd", "stop"}
        /\ (lease = "cmd" => held < CmdHold)
        /\ (lease = "stop" => held < StopHold)
        /\ (https \in Waiting => waited < Bound(https))
        /\ held' = held + 1
        /\ waited' = IF https \in Waiting THEN waited + 1 ELSE waited
        /\ UNCHANGED <<run, lease, https, cmd, torn, fin, refusedSeen>>

Next == \/ Spawn \/ Skip \/ AuthorityStart \/ AuthorityExpire
        \/ VerifyTake \/ VerifyExpire \/ CmdTake \/ CmdRelease
        \/ Request \/ StopTake \/ StopDone
        \/ CleanupStart \/ ReleaseTake \/ ReleaseExpire \/ Tick
\* The command and the stop request are the environment: no fairness.
Spec == Init /\ [][Next]_vars
        /\ WF_vars(Spawn \/ Skip \/ AuthorityStart \/ AuthorityExpire
                   \/ VerifyTake \/ VerifyExpire \/ CmdRelease
                   \/ StopTake \/ StopDone \/ CleanupStart
                   \/ ReleaseTake \/ ReleaseExpire \/ Tick)

TypeOK ==
  /\ run \in {"ready", "stopReq", "stopping", "stopped"}
  /\ lease \in {"free", "cmd", "stop"}
  /\ held \in 0..(CmdHold + StopHold)
  /\ https \in {"pending", "none", "authority", "verify", "admitted",
                "refused", "startupFailed", "releasing", "released",
                "retained"}
  /\ waited \in 0..AuthorityWait \cup 0..VerifyWait
  /\ cmd \in {"idle", "holding", "done"}
  /\ torn \in BOOLEAN
  /\ fin \in {"open", "confirmed", "unconfirmed"}
  /\ refusedSeen \in BOOLEAN
\* Rows 1, 3, 4 and HACK-2709: a brief holder never tears the run down.
NoTeardownByBriefHolder == ~torn
\* HACK-2707 and HACK-2708: a stop during warm-up always ends with confirmed
\* cleanup, never a run that needs `down --recover`.
NoRecoveryRequired == fin # "unconfirmed"
\* Cleanup is never acknowledged while an acquisition can still land.
NoAcquisitionAfterCleanup == fin # "open" => https \notin InFlight
WarmupSettles == https \in InFlight ~> https \notin InFlight
StopSettles == run = "stopped" ~> fin # "open"
\* Reachability: a stop that lands during warm-up (a refused acquire) still
\* ends with a verified release and confirmed cleanup.
NeverReleasedAfterRefusal == ~(fin = "confirmed" /\ https = "released"
                               /\ refusedSeen)
=============================================================================
