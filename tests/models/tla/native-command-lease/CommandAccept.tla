---------------------------- MODULE CommandAccept ----------------------------
(* HACK-2742 review (Codex P1). One authored command (exec, one-off run or    *)
(* interactive exec) on one connection to the project's owner. The owner     *)
(* serves one request at a time on its only loop: it takes the connection    *)
(* from its listen backlog, reads and validates the request, queues one      *)
(* accept byte, and only then starts the command. If it cannot queue the     *)
(* byte (this side is gone) or refuses the request, it closes with no byte.  *)
(* After acceptance the reply may be delivered or lost (its write failed, or *)
(* the owner failed). Between requests the owner may end through its own     *)
(* cleanup (publication retired, run removed) or fail (publication kept). A  *)
(* connection still in the backlog closes unread when the owner ends.        *)
(*                                                                           *)
(* The requester decides once the connection ended. AcceptRule = TRUE is the *)
(* fix: "not started" only when no byte at all arrived; after the byte every *)
(* failure is "unconfirmed". AcceptRule = FALSE is the rule before it, which *)
(* had no accept byte and read "closed with no byte of answer, then retired  *)
(* by the owner's own cleanup" as not started: Codex's case, a reply lost    *)
(* after the command ran followed by the owner's `hack down`, breaks it.     *)
(*                                                                           *)
(* For interactive exec this side's leash watcher shuts the stream down once *)
(* the frontend is gone (Shutdown). That local close can hide a queued byte, *)
(* so with LeashCheck = TRUE a requester that shut down never claims "not    *)
(* started". LeashCheck = FALSE is the negative control without that check.  *)
EXTENDS Naturals
CONSTANTS AcceptRule, LeashCheck
VARIABLES conn, took, accepted, started, replied, owner, local, report
vars == <<conn, took, accepted, started, replied, owner, local, report>>

Init == /\ conn = "queued" /\ took = FALSE /\ accepted = FALSE
        /\ started = FALSE /\ replied = FALSE /\ owner = "live"
        /\ local = FALSE /\ report = "none"

Live == owner = "live"

\* The owner takes the connection from its backlog and reads the request.
Take == /\ Live /\ conn = "queued" /\ conn' = "taken" /\ took' = TRUE
        /\ UNCHANGED <<accepted, started, replied, owner, local, report>>

\* It refuses the request, or cannot queue the accept byte: close, no byte.
Drop == /\ Live /\ conn = "taken" /\ conn' = "closed"
        /\ UNCHANGED <<took, accepted, started, replied, owner, local, report>>

\* It queues the accept byte. A side that shut down makes that send fail.
Accept == /\ Live /\ conn = "taken" /\ ~local
          /\ conn' = "accepted" /\ accepted' = TRUE
          /\ UNCHANGED <<took, started, replied, owner, local, report>>

\* Effects may start only after acceptance.
Start == /\ Live /\ conn = "accepted" /\ ~started /\ started' = TRUE
         /\ UNCHANGED <<conn, took, accepted, replied, owner, local, report>>

\* The reply is delivered.
Reply == /\ Live /\ conn = "accepted" /\ started
         /\ conn' = "replied" /\ replied' = TRUE
         /\ UNCHANGED <<took, accepted, started, owner, local, report>>

\* No reply after acceptance: a failure before the start, a lost reply write.
Lose == /\ Live /\ conn = "accepted" /\ conn' = "closed"
        /\ UNCHANGED <<took, accepted, started, replied, owner, local, report>>

\* The owner fails during the request; the connection closes.
Crash == /\ Live /\ conn \in {"taken", "accepted"}
         /\ owner' = "failed" /\ conn' = "closed"
         /\ UNCHANGED <<took, accepted, started, replied, local, report>>

\* Between requests the owner ends: its cleanup, or a failure. A backlog
\* connection closes unread.
End == /\ Live /\ conn \in {"queued", "closed", "replied"}
       /\ owner' \in {"cleanup", "failed"}
       /\ conn' = IF conn = "queued" THEN "closed" ELSE conn
       /\ UNCHANGED <<took, accepted, started, replied, local, report>>

\* The interactive leash watcher shuts this side down (frontend gone).
Shutdown == /\ report = "none" /\ ~local /\ local' = TRUE
            /\ UNCHANGED <<conn, took, accepted, started, replied, owner,
                           report>>

\* What the requester can read first: the accept byte, unless its own
\* shutdown hid it.
SawByte == accepted /\ ~local

NewReport == IF replied /\ ~local THEN "ran"
             ELSE IF ~SawByte /\ (~local \/ ~LeashCheck) THEN "not-started"
             ELSE "unconfirmed"

\* The rule before the fix: no answer byte, then the owner's own cleanup.
OldReport == IF replied /\ ~local THEN "ran"
             ELSE IF owner = "cleanup" THEN "not-started"
             ELSE "unconfirmed"

\* The requester decides once the connection ended, or it shut down. The
\* old rule's short wait for the retirement is the interleaving of End.
Decide == /\ report = "none"
          /\ conn \in {"closed", "replied"} \/ local
          /\ report' = IF AcceptRule THEN NewReport ELSE OldReport
          /\ UNCHANGED <<conn, took, accepted, started, replied, owner, local>>

Next == Take \/ Drop \/ Accept \/ Start \/ Reply \/ Lose \/ Crash \/ End
        \/ Shutdown \/ Decide
Spec == Init /\ [][Next]_vars

TypeOK == /\ conn \in {"queued", "taken", "accepted", "replied", "closed"}
          /\ took \in BOOLEAN /\ accepted \in BOOLEAN /\ started \in BOOLEAN
          /\ replied \in BOOLEAN /\ owner \in {"live", "cleanup", "failed"}
          /\ local \in BOOLEAN
          /\ report \in {"none", "ran", "unconfirmed", "not-started"}
\* The owner starts only what it accepted.
StartOnlyAfterAccept == started => accepted
\* "not started" only when no accept byte was sent.
NotStartedOnlyWithoutAccept == report = "not-started" => ~accepted
\* "not started" is true: the command never began.
NothingRanWhenNotStarted == report = "not-started" => ~started
\* After the accept byte, every failure is "unconfirmed".
UnconfirmedAfterAccept ==
    (accepted /\ report \notin {"none", "ran"}) => report = "unconfirmed"
\* Reachability (VM row 4): a backlog request the owner never took, then its
\* own cleanup, is reported as not started.
NeverBacklogNotStarted == ~(report = "not-started" /\ ~took
                            /\ owner = "cleanup")
\* Reachability (Codex's case): the command ran, its reply was lost and the
\* owner then ended through its cleanup; it is reported as unconfirmed.
NeverLostReplyUnconfirmed == ~(report = "unconfirmed" /\ started /\ ~replied
                               /\ owner = "cleanup")
=============================================================================
