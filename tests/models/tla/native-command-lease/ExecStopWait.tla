---------------------------- MODULE ExecStopWait ----------------------------
(* HACK-2729. Project Y runs `hack exec` while project X's `hack down` holds *)
(* the provider lease for its whole graph stop. Y's requesting process takes *)
(* the lease twice: for the dependency refresh (it reads the selection and   *)
(* releases the lease before it sends anything to Y's owner), then for the   *)
(* exec itself (`graph exec`), which sends the command once it holds the     *)
(* lease. Each wait has Bound ticks; one tick is one second. X's stop keeps  *)
(* the lease for at most StopHold ticks, then releases it.                   *)
(*                                                                           *)
(* On expiry the waiter has sent nothing. ExpiryUnconfirmed = TRUE is the    *)
(* old report, which called that refusal "unconfirmed"; FALSE is the fix,    *)
(* which says nothing ran. After the command was sent its reply may still be *)
(* lost: only that outcome is really unconfirmed.                            *)
EXTENDS Naturals
CONSTANTS Bound, StopHold, ExpiryUnconfirmed
VARIABLES holder, phase, elapsed, held, sent, report
vars == <<holder, phase, elapsed, held, sent, report>>

Init == /\ holder = "stop" /\ phase = "refresh"
        /\ elapsed = 0 /\ held = 0 /\ sent = FALSE /\ report = "none"

Waiting == phase \in {"refresh", "exec"}

\* X's stop releases the lease, at the latest after StopHold ticks.
Release == /\ holder = "stop" /\ holder' = "free"
           /\ UNCHANGED <<phase, elapsed, held, sent, report>>

\* Time passes for the waiter only while the stop still holds the lease: the
\* waiter polls every 5 to 50 ms, so it does not sit on a free lease.
Tick == /\ Waiting /\ elapsed < Bound
        /\ holder = "stop" /\ held < StopHold
        /\ elapsed' = elapsed + 1 /\ held' = held + 1
        /\ UNCHANGED <<holder, phase, sent, report>>

\* The refresh reads under the lease and releases it, sending nothing yet;
\* the exec's own wait starts with its own budget. The exec takes the lease
\* and sends the command, whose effects may start from here on.
Acquire == /\ Waiting /\ elapsed < Bound /\ holder = "free"
           /\ elapsed' = 0
           /\ phase' = IF phase = "refresh" THEN "exec" ELSE "sent"
           /\ sent' = (phase = "exec")
           /\ UNCHANGED <<holder, held, report>>

\* At the bound the wait refuses provider_busy, naming the holder.
Expire == /\ Waiting /\ elapsed = Bound
          /\ phase' = "refused"
          /\ report' = IF ExpiryUnconfirmed THEN "unconfirmed" ELSE "nothing-ran"
          /\ UNCHANGED <<holder, elapsed, held, sent>>

\* The command's reply arrives, or is lost after the send.
Finish == /\ phase = "sent" /\ phase' = "done"
          /\ report' \in {"ran", "unconfirmed"}
          /\ UNCHANGED <<holder, elapsed, held, sent>>

Next == Release \/ Tick \/ Acquire \/ Expire \/ Finish
Spec == Init /\ [][Next]_vars
        /\ WF_vars(Acquire \/ Tick \/ Expire \/ Finish) /\ WF_vars(Release)

TypeOK == /\ holder \in {"stop", "free"}
          /\ phase \in {"refresh", "exec", "sent", "done", "refused"}
          /\ elapsed \in 0..Bound /\ held \in 0..StopHold
          /\ sent \in BOOLEAN
          /\ report \in {"none", "ran", "unconfirmed", "nothing-ran"}
\* The command is sent only once the stop has released the lease.
NoSendWhileHeld == sent => holder = "free"
\* "unconfirmed" only when the command was sent, so effects may have happened.
UnconfirmedOnlyAfterSend == report = "unconfirmed" => sent
\* "nothing ran" only when nothing was sent.
NothingRanMeansNothingSent == report = "nothing-ran" => ~sent
\* A stop that releases inside the budget never makes the exec refuse.
StopNeverRefuses == phase # "refused"
Settles == Waiting ~> phase \in {"done", "refused"}
\* Reachability: the exec runs after the stop held the lease as long as it can.
NeverRanAfterStop == ~(report = "ran" /\ held = StopHold)
\* Reachability: a reply lost after the send is still reported as unconfirmed.
NeverUnconfirmed == report # "unconfirmed"
=============================================================================
