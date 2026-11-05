------------------------- MODULE AutoRefresh -------------------------
(* Owner-side automatic host dependency refresh (foreground graph owner).
   A stale notice (authenticated traffic drift or a watched listener's exit)
   arms one attempt. Attempts are single-flight. A refusal before the rebind
   journal is retried after a bounded backoff; a verified refresh clears the
   backoff; a rebind that wrote its journal and did not complete closes the
   schedule, so no uncertain rebind is ever replayed. The dependency-rebind
   protocol itself (fence, retire, register, commit) is Rebind.tla. *)
EXTENDS Naturals
CONSTANT EnforceClose, MaxRetries, MaxAttempts
VARIABLES listener, armed, inFlight, journal, retries, closed,
          unconfirmed, replayed, attempts
vars == <<listener, armed, inFlight, journal, retries, closed,
          unconfirmed, replayed, attempts>>

Init == /\ listener = "live" /\ armed = FALSE /\ inFlight = 0
        /\ journal = "none" /\ retries = 0 /\ closed = FALSE
        /\ unconfirmed = FALSE /\ replayed = FALSE /\ attempts = 0

\* A stale notice arms an attempt unless one is already scheduled or closed.
Arm == IF closed \/ armed THEN armed ELSE TRUE

\* The pinned listener exits (watched EVFILT_PROC notice).
ListenerExits == /\ listener = "live"
                 /\ listener' = "gone" /\ armed' = Arm
                 /\ UNCHANGED <<inFlight, journal, retries, closed,
                                unconfirmed, replayed, attempts>>
\* Authenticated traffic reaches the stale endpoint and reports drift.
Traffic == /\ listener # "live"
           /\ armed' = Arm
           /\ UNCHANGED <<listener, inFlight, journal, retries, closed,
                          unconfirmed, replayed, attempts>>
\* The host owner starts a replacement listener beneath the pinned supervisor.
Replace == /\ listener = "gone" /\ listener' = "replaced"
           /\ UNCHANGED <<armed, inFlight, journal, retries, closed,
                          unconfirmed, replayed, attempts>>

Start == /\ armed /\ inFlight = 0 /\ attempts < MaxAttempts
         /\ (EnforceClose => ~closed)
         /\ armed' = FALSE /\ inFlight' = 1 /\ journal' = "none"
         /\ attempts' = attempts + 1
         /\ replayed' = (replayed \/ unconfirmed)
         /\ UNCHANGED <<listener, retries, closed, unconfirmed>>

\* No replacement yet: refused before the journal; bounded backoff re-arms.
RefuseBeforeEffects ==
    /\ inFlight = 1 /\ journal = "none" /\ listener = "gone"
    /\ inFlight' = 0
    /\ IF retries < MaxRetries
          THEN /\ armed' = TRUE /\ retries' = retries + 1
          ELSE /\ armed' = armed /\ retries' = 0
    /\ UNCHANGED <<listener, journal, closed, unconfirmed, replayed, attempts>>

WriteJournal == /\ inFlight = 1 /\ journal = "none" /\ listener = "replaced"
                /\ journal' = "written"
                /\ UNCHANGED <<listener, armed, inFlight, retries, closed,
                               unconfirmed, replayed, attempts>>

Complete == /\ inFlight = 1 /\ journal = "written"
            /\ journal' = "completed" /\ inFlight' = 0 /\ retries' = 0
            /\ listener' = "live"
            /\ UNCHANGED <<armed, closed, unconfirmed, replayed, attempts>>

\* Any failure after the journal leaves the outcome unconfirmed.
FailAfterJournal ==
    /\ inFlight = 1 /\ journal = "written"
    /\ journal' = "failed" /\ inFlight' = 0 /\ unconfirmed' = TRUE
    /\ IF EnforceClose
          THEN /\ closed' = TRUE /\ armed' = FALSE
          ELSE /\ closed' = closed /\ armed' = TRUE
    /\ UNCHANGED <<listener, retries, replayed, attempts>>

Next == ListenerExits \/ Traffic \/ Replace \/ Start \/ RefuseBeforeEffects
        \/ WriteJournal \/ Complete \/ FailAfterJournal
Spec == Init /\ [][Next]_vars

TypeOK == /\ listener \in {"live", "gone", "replaced"}
          /\ armed \in BOOLEAN /\ inFlight \in 0..1
          /\ journal \in {"none", "written", "completed", "failed"}
          /\ retries \in 0..MaxRetries /\ closed \in BOOLEAN
          /\ unconfirmed \in BOOLEAN /\ replayed \in BOOLEAN
          /\ attempts \in 0..MaxAttempts
SingleFlight == inFlight <= 1
BoundedBackoff == retries <= MaxRetries
NoReplayAfterUnconfirmed == ~replayed
ClosedAfterUnconfirmed == (EnforceClose /\ unconfirmed) => (closed /\ ~armed)
======================================================================
