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
(*                                                                           *)
(* HACK-2739, the authored path. An authored project's `hack exec` sends one *)
(* request to its owner, which takes the lease on its only loop thread and   *)
(* then starts the command. The same two waits model it: the first wait      *)
(* ("refresh") is the requesting process's wait for a free lease, which      *)
(* reads nothing, holds nothing and sends nothing; the second ("exec") is    *)
(* the owner's own wait, which may block its loop only briefly, so it has    *)
(* its own bound, SecondBound (15 s inside the owner's 30 s budget, which    *)
(* the requester reads for 40 s). Probe = FALSE is the authored path before  *)
(* the fix: no requester wait, only the owner's 15 s. The Compose configs    *)
(* set SecondBound = Bound and Probe = TRUE.                                 *)
(*                                                                           *)
(* PeerTake is enabled only in phase "exec": a second holder takes the lease *)
(* between the two waits, never during the first. The model does not cover   *)
(* a second holder that arrives while the first wait is still running; that  *)
(* holder only lengthens a wait that sends nothing, and its expiry is the    *)
(* same not-run refusal that a StopHold past Bound already reaches.          *)
(*                                                                           *)
(* HACK-2742. The authored owner's check (a pending signal, its own `hack    *)
(* down`) runs before every lease attempt, so it can end the owner's wait    *)
(* (Cancellable = TRUE). Nothing was sent. CancelUnconfirmed = TRUE is the   *)
(* report before the fix, which called that refusal "unconfirmed". The same  *)
(* model covers authored one-off `hack run` and interactive `hack exec`:     *)
(* their requester and owner waits have the same shape.                      *)
EXTENDS Naturals
CONSTANTS Bound, SecondBound, Probe, StopHold, ExpiryUnconfirmed, Holders,
          EnforceLease, Cancellable, CancelUnconfirmed
VARIABLES holder, holds, phase, elapsed, held, sent, sentHeld, report,
          cancelled
vars == <<holder, holds, phase, elapsed, held, sent, sentHeld, report,
          cancelled>>

Init == /\ holder = "stop" /\ holds = 1
        /\ phase = IF Probe THEN "refresh" ELSE "exec"
        /\ elapsed = 0 /\ held = 0 /\ sent = FALSE /\ sentHeld = FALSE
        /\ report = "none" /\ cancelled = FALSE

Waiting == phase \in {"refresh", "exec"}

\* The bound of the wait in progress.
PhaseBound == IF phase = "refresh" THEN Bound ELSE SecondBound

\* The current holder releases the lease, at the latest after StopHold ticks.
Release == /\ holder \in {"stop", "peer"} /\ holder' = "free"
           /\ UNCHANGED <<holds, phase, elapsed, held, sent, sentHeld, report,
                          cancelled>>

\* A second holder takes the free lease after the refresh, before the exec
\* (for the authored path: after the requester's wait, before the owner's).
\* It is not enabled during the first wait.
PeerTake == /\ phase = "exec" /\ holder = "free" /\ holds < Holders
            /\ holder' = "peer" /\ holds' = holds + 1 /\ held' = 0
            /\ UNCHANGED <<phase, elapsed, sent, sentHeld, report, cancelled>>

\* Time passes for the waiter only while someone else holds the lease: the
\* waiter polls every 5 to 50 ms, so it does not sit on a free lease.
Tick == /\ Waiting /\ elapsed < PhaseBound
        /\ holder # "free" /\ held < StopHold
        /\ elapsed' = elapsed + 1 /\ held' = held + 1
        /\ UNCHANGED <<holder, holds, phase, sent, sentHeld, report, cancelled>>

\* The refresh reads under the lease and releases it, sending nothing yet;
\* the exec's own wait starts with its own budget. The exec takes the lease
\* and sends the command, whose effects may start from here on.
Acquire == /\ Waiting /\ elapsed < PhaseBound
           /\ (EnforceLease => holder = "free")
           /\ elapsed' = 0
           /\ phase' = IF phase = "refresh" THEN "exec" ELSE "sent"
           /\ sent' = (phase = "exec")
           /\ sentHeld' = (phase = "exec" /\ holder # "free")
           /\ UNCHANGED <<holder, holds, held, report, cancelled>>

\* At the bound the wait refuses: provider_busy naming the holder for the
\* requester, its own pre-effect code for the authored owner.
Expire == /\ Waiting /\ elapsed = PhaseBound
          /\ phase' = "refused"
          /\ report' = IF ExpiryUnconfirmed THEN "unconfirmed" ELSE "not-run"
          /\ UNCHANGED <<holder, holds, elapsed, held, sent, sentHeld,
                         cancelled>>

\* HACK-2742: the authored owner's check (a pending signal, its `hack down`)
\* ends its own wait before acquisition; it answers its not-started code.
Cancel == /\ Cancellable /\ phase = "exec"
          /\ phase' = "refused" /\ cancelled' = TRUE
          /\ report' = IF CancelUnconfirmed THEN "unconfirmed" ELSE "not-run"
          /\ UNCHANGED <<holder, holds, elapsed, held, sent, sentHeld>>

\* The command's reply arrives, or is lost after the send.
Finish == /\ phase = "sent" /\ phase' = "done"
          /\ report' \in {"ran", "unconfirmed"}
          /\ UNCHANGED <<holder, holds, elapsed, held, sent, sentHeld,
                         cancelled>>

Next == Release \/ PeerTake \/ Tick \/ Acquire \/ Expire \/ Cancel \/ Finish
Spec == Init /\ [][Next]_vars
        /\ WF_vars(Acquire \/ Tick \/ Expire \/ Finish) /\ WF_vars(Release)

MaxBound == IF Bound >= SecondBound THEN Bound ELSE SecondBound
TypeOK == /\ holder \in {"stop", "peer", "free"} /\ holds \in 1..Holders
          /\ phase \in {"refresh", "exec", "sent", "done", "refused"}
          /\ elapsed \in 0..MaxBound /\ held \in 0..StopHold
          /\ sent \in BOOLEAN /\ sentHeld \in BOOLEAN
          /\ report \in {"none", "ran", "unconfirmed", "not-run"}
          /\ cancelled \in BOOLEAN
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
\* Reachability: the second wait refuses as not run, with nothing sent.
NeverRefusedAtSecondWait == ~(phase = "refused" /\ elapsed = SecondBound
                              /\ report = "not-run" /\ holds = 2)
\* Reachability (HACK-2742): the owner's check ends its wait as not run.
NeverCancelled == ~(cancelled /\ report = "not-run")
=============================================================================
