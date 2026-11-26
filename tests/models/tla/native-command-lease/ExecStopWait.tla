---------------------------- MODULE ExecStopWait ----------------------------
(* HACK-2729. Project Y runs `hack exec` while project X's `hack down` holds *)
(* the provider lease for its whole graph stop. Y's requesting process takes *)
(* the lease twice: for the dependency refresh (it reads the selection and   *)
(* releases the lease before it sends anything to Y's owner), then for the   *)
(* exec itself (`graph exec`), which sends the command once it holds the     *)
(* lease. Each wait has Bound ticks; one tick is one second. Every holder    *)
(* keeps the lease for at most StopHold ticks, then releases it.             *)
(*                                                                           *)
(* Holders = 2 lets a second holder (another project's stop or start) take   *)
(* the lease between the refresh and the exec. EnforceLease = FALSE is the   *)
(* negative control: an exec that sends while the lease is still held.       *)
(* On expiry the waiter has not sent the command. ExpiryUnconfirmed = TRUE   *)
(* is the old report, which called that refusal "unconfirmed"; FALSE is the  *)
(* fix ("nothing ran" at the refresh, "the command did not run" at the       *)
(* exec). After the send the reply may still be lost: only that outcome is   *)
(* really unconfirmed.                                                       *)
EXTENDS Naturals
CONSTANTS Bound, StopHold, ExpiryUnconfirmed, Holders, EnforceLease
VARIABLES holder, holds, phase, elapsed, held, sent, sentHeld, report
vars == <<holder, holds, phase, elapsed, held, sent, sentHeld, report>>

Init == /\ holder = "stop" /\ holds = 1 /\ phase = "refresh"
        /\ elapsed = 0 /\ held = 0 /\ sent = FALSE /\ sentHeld = FALSE
        /\ report = "none"

Waiting == phase \in {"refresh", "exec"}

\* The current holder releases the lease, at the latest after StopHold ticks.
Release == /\ holder \in {"stop", "peer"} /\ holder' = "free"
           /\ UNCHANGED <<holds, phase, elapsed, held, sent, sentHeld, report>>

\* A second holder takes the free lease after the refresh, before the exec.
PeerTake == /\ phase = "exec" /\ holder = "free" /\ holds < Holders
            /\ holder' = "peer" /\ holds' = holds + 1 /\ held' = 0
            /\ UNCHANGED <<phase, elapsed, sent, sentHeld, report>>

\* Time passes for the waiter only while someone else holds the lease: the
\* waiter polls every 5 to 50 ms, so it does not sit on a free lease.
Tick == /\ Waiting /\ elapsed < Bound
        /\ holder # "free" /\ held < StopHold
        /\ elapsed' = elapsed + 1 /\ held' = held + 1
        /\ UNCHANGED <<holder, holds, phase, sent, sentHeld, report>>

\* The refresh reads under the lease and releases it, sending nothing yet;
\* the exec's own wait starts with its own budget. The exec takes the lease
\* and sends the command, whose effects may start from here on.
Acquire == /\ Waiting /\ elapsed < Bound
           /\ (EnforceLease => holder = "free")
           /\ elapsed' = 0
           /\ phase' = IF phase = "refresh" THEN "exec" ELSE "sent"
           /\ sent' = (phase = "exec")
           /\ sentHeld' = (phase = "exec" /\ holder # "free")
           /\ UNCHANGED <<holder, holds, held, report>>

\* At the bound the wait refuses provider_busy, naming the holder.
Expire == /\ Waiting /\ elapsed = Bound
          /\ phase' = "refused"
          /\ report' = IF ExpiryUnconfirmed THEN "unconfirmed" ELSE "not-run"
          /\ UNCHANGED <<holder, holds, elapsed, held, sent, sentHeld>>

\* The command's reply arrives, or is lost after the send.
Finish == /\ phase = "sent" /\ phase' = "done"
          /\ report' \in {"ran", "unconfirmed"}
          /\ UNCHANGED <<holder, holds, elapsed, held, sent, sentHeld>>

Next == Release \/ PeerTake \/ Tick \/ Acquire \/ Expire \/ Finish
Spec == Init /\ [][Next]_vars
        /\ WF_vars(Acquire \/ Tick \/ Expire \/ Finish) /\ WF_vars(Release)

TypeOK == /\ holder \in {"stop", "peer", "free"} /\ holds \in 1..Holders
          /\ phase \in {"refresh", "exec", "sent", "done", "refused"}
          /\ elapsed \in 0..Bound /\ held \in 0..StopHold
          /\ sent \in BOOLEAN /\ sentHeld \in BOOLEAN
          /\ report \in {"none", "ran", "unconfirmed", "not-run"}
\* The command is sent only while no one else holds the lease.
NoSendWhileHeld == ~sentHeld
\* "unconfirmed" only when the command was sent, so effects may have happened.
UnconfirmedOnlyAfterSend == report = "unconfirmed" => sent
\* "did not run" only when the command was not sent.
NotRunMeansNotSent == report = "not-run" => ~sent
\* Holders that release inside the budget never make the exec refuse.
StopNeverRefuses == phase # "refused"
Settles == Waiting ~> phase \in {"done", "refused"}
\* Reachability: the exec runs after the stop held the lease as long as it can.
NeverRanAfterStop == ~(report = "ran" /\ held = StopHold)
\* Reachability: the exec waits out a second holder after the refresh.
NeverRanAfterPeer == ~(report = "ran" /\ holds = 2)
\* Reachability: a reply lost after the send is still reported as unconfirmed.
NeverUnconfirmed == report # "unconfirmed"
=============================================================================
