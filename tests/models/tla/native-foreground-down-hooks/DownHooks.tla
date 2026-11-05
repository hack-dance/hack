----------------------------- MODULE DownHooks -----------------------------
EXTENDS Naturals
CONSTANTS EnforceJournal, EnforceUnknownBlock, RevertOwed
VARIABLES graph, jState, jGen, fpc, dpc, dRuns, dSaved, interrupts,
          upInterrupted, beforeOpen, beforeOk, afterOpen, afterDone, fHooks,
          newGen, unsafeBefore, unsafeAfter, unsafeGen, unsafeOwe
vars == <<graph, jState, jGen, fpc, dpc, dRuns, dSaved, interrupts,
          upInterrupted, beforeOpen, beforeOk, afterOpen, afterDone, fHooks,
          newGen, unsafeBefore, unsafeAfter, unsafeGen, unsafeOwe>>
journal == <<jState, jGen>>
counters == <<beforeOpen, beforeOk, afterOpen, afterDone>>
flags == <<unsafeBefore, unsafeAfter, unsafeGen, unsafeOwe>>

\* One native Compose-import generation whose project declares down hooks.
\* The frontend F has authenticated readiness and is running up.after. One
\* `hack down` client D may run (and be retried once) from another terminal.
\* The journal is one value-free record (state, owner generation) replaced by
\* compare-and-swap under a private lock; "absent" is no record.
Init == /\ graph = "upAfter" /\ jState = "absent" /\ jGen = "none"
        /\ fpc = "upAfter" /\ dpc = "idle" /\ dRuns = 0
        /\ dSaved = <<"absent", "none">> /\ interrupts = 0
        /\ upInterrupted = FALSE /\ beforeOpen = 0 /\ beforeOk = FALSE
        /\ afterOpen = 0 /\ afterDone = FALSE /\ fHooks = FALSE
        /\ newGen = FALSE /\ unsafeBefore = FALSE /\ unsafeAfter = FALSE
        /\ unsafeGen = FALSE /\ unsafeOwe = FALSE

Live == graph \in {"upAfter", "ready"}
Started == jState \in {"beforeStarted", "afterStarted"}
DActive == dpc \in {"before", "cleanup", "after", "afterRunning"}

\* An intent record precedes each hook spawn. A start is unsafe when another
\* start is still running or unknown, or a known success already exists.
StartBefore(g) ==
  /\ jState' = "beforeStarted" /\ jGen' = g
  /\ beforeOpen' = beforeOpen + 1
  /\ unsafeBefore' = (unsafeBefore \/ beforeOpen > 0 \/ beforeOk)
\* down.after requires Removed (stopped) and a known successful down.before.
StartAfter(g) ==
  /\ jState' = "afterStarted" /\ jGen' = g
  /\ afterOpen' = afterOpen + 1
  /\ unsafeAfter' = (unsafeAfter \/ afterOpen > 0 \/ afterDone
                     \/ graph # "stopped" \/ ~beforeOk)

\* ---------------------------------------------------------------- frontend
\* up.after succeeded: owe the down hooks only when no record exists (a
\* concurrent down may already own one). Readiness is published afterwards.
FOwe ==
  /\ fpc = "upAfter" /\ ~newGen
  /\ graph' = IF graph = "upAfter" THEN "ready" ELSE graph
  /\ fpc' = "publishing"
  /\ IF jState = "absent" \/ ~EnforceJournal
       THEN jState' = "owed" /\ jGen' = "F"
       ELSE UNCHANGED journal
  /\ UNCHANGED <<dpc, dRuns, dSaved, interrupts, upInterrupted, counters,
                 fHooks, newGen, flags>>
FPublish ==
  /\ fpc = "publishing" /\ fpc' = "serving"
  /\ UNCHANGED <<graph, journal, dpc, dRuns, dSaved, interrupts,
                 upInterrupted, counters, fHooks, newGen, flags>>
\* An interrupt observed before readiness publication takes the forced stop;
\* the frontend withdraws its own owed record (compare-and-swap). A record a
\* concurrent down claimed meanwhile belongs to that down, not the frontend.
FInterruptAtPublish ==
  /\ fpc = "publishing" /\ interrupts = 0
  /\ interrupts' = 1 /\ upInterrupted' = TRUE /\ fpc' = "stopping"
  /\ IF RevertOwed /\ jState = "owed" /\ jGen = "F"
       THEN jState' = "absent" /\ jGen' = "none"
       ELSE UNCHANGED journal
  /\ unsafeOwe' = (jState' = "owed" /\ jGen' = "F")
  /\ UNCHANGED <<graph, dpc, dRuns, dSaved, counters, fHooks, newGen,
                 unsafeBefore, unsafeAfter, unsafeGen>>
\* Ctrl-C while up.after runs: the forced stop never owes or runs down hooks.
FUpAfterInterrupted ==
  /\ fpc = "upAfter" /\ interrupts = 0 /\ ~newGen
  /\ interrupts' = 1 /\ upInterrupted' = TRUE /\ fpc' = "stopping"
  /\ UNCHANGED <<graph, journal, dpc, dRuns, dSaved, counters, fHooks, newGen,
                 flags>>
\* First Ctrl-C on a ready graph: claim the frontend's own owed record.
FInterrupt ==
  /\ fpc = "serving" /\ interrupts = 0 /\ ~newGen
  /\ interrupts' = 1
  /\ IF (jState = "owed" /\ jGen = "F") \/ ~EnforceJournal
       THEN /\ StartBefore("F") /\ fHooks' = TRUE /\ fpc' = "before"
            /\ UNCHANGED <<beforeOk, afterOpen, afterDone, unsafeAfter>>
       ELSE /\ fpc' = "stopping"
            /\ UNCHANGED <<journal, counters, fHooks, flags>>
  /\ UNCHANGED <<graph, dpc, dRuns, dSaved, upInterrupted, newGen, unsafeGen,
                 unsafeOwe>>
\* Known completion: success owes down.after; failure is terminal for this
\* generation and the stop still proceeds because the user asked to exit.
FBeforeDone(ok) ==
  /\ beforeOpen' = beforeOpen - 1 /\ beforeOk' = (beforeOk \/ ok)
  /\ IF jState = "beforeStarted" /\ jGen = "F"
       THEN jState' = (IF ok THEN "afterOwed" ELSE "beforeFailed")
            /\ UNCHANGED jGen
       ELSE UNCHANGED journal
  /\ fpc' = "stopping"
FBeforeFinish ==
  /\ fpc = "before" /\ \E ok \in BOOLEAN : FBeforeDone(ok)
  /\ UNCHANGED <<graph, dpc, dRuns, dSaved, interrupts, upInterrupted,
                 afterOpen, afterDone, fHooks, newGen, flags>>
\* A second Ctrl-C cancels the running hook: known, unsuccessful completion.
FCancelBefore ==
  /\ fpc = "before" /\ interrupts = 1
  /\ interrupts' = 2 /\ FBeforeDone(FALSE)
  /\ UNCHANGED <<graph, dpc, dRuns, dSaved, upInterrupted, afterOpen,
                 afterDone, fHooks, newGen, flags>>
\* The graph can also end by itself or be stopped by D while F serves.
FGraphEnds ==
  /\ fpc = "serving" /\ ~newGen
  /\ graph' = "stopped" /\ fpc' = "after"
  /\ UNCHANGED <<journal, dpc, dRuns, dSaved, interrupts, upInterrupted,
                 counters, fHooks, newGen, flags>>
\* Exact native cleanup confirmed and lifecycle processes stopped.
FCleanup ==
  /\ fpc = "stopping"
  /\ graph' = "stopped" /\ fpc' = "after"
  /\ UNCHANGED <<journal, dpc, dRuns, dSaved, interrupts, upInterrupted,
                 counters, fHooks, newGen, flags>>
FAfter ==
  /\ fpc = "after" /\ graph = "stopped"
  /\ IF IF EnforceJournal THEN jState = "afterOwed" /\ jGen = "F" ELSE fHooks
       THEN /\ StartAfter("F") /\ fHooks' = TRUE /\ fpc' = "afterRunning"
            /\ UNCHANGED <<beforeOpen, beforeOk, afterDone, unsafeBefore>>
       ELSE /\ fpc' = "done"
            /\ UNCHANGED <<journal, counters, fHooks, flags>>
  /\ UNCHANGED <<graph, dpc, dRuns, dSaved, interrupts, upInterrupted, newGen,
                 unsafeGen, unsafeOwe>>
\* Known completion of down.after, successful or not, is never rerun.
FAfterDone ==
  /\ fpc = "afterRunning"
  /\ afterOpen' = afterOpen - 1 /\ afterDone' = TRUE
  /\ IF jState = "afterStarted" /\ jGen = "F"
       THEN jState' = "complete" /\ UNCHANGED jGen
       ELSE UNCHANGED journal
  /\ fpc' = "done"
  /\ UNCHANGED <<graph, dpc, dRuns, dSaved, interrupts, upInterrupted,
                 beforeOpen, beforeOk, fHooks, newGen, flags>>
\* A crash keeps the durable record; a started phase becomes unknown.
FCrash ==
  /\ fpc \in {"upAfter", "publishing", "serving", "before", "stopping",
              "after", "afterRunning"}
  /\ fpc' = "dead"
  /\ UNCHANGED <<graph, journal, dpc, dRuns, dSaved, interrupts,
                 upInterrupted, counters, fHooks, newGen, flags>>
\* A dead frontend's graph may finish stopping, or be stopped by recovery.
OrphanStops ==
  /\ fpc = "dead" /\ graph # "stopped" /\ ~DActive
  /\ graph' = "stopped"
  /\ UNCHANGED <<journal, fpc, dpc, dRuns, dSaved, interrupts, upInterrupted,
                 counters, fHooks, newGen, flags>>

\* ------------------------------------------------------------- hack down
\* D claims an owed record, or no record for a live graph (an older frontend
\* or one still in up.after). A started record is unknown and refuses.
\* A stopped graph is read only after the frontend's finalization completed.
DClaims ==
  IF ~EnforceJournal THEN TRUE
  ELSE jState = "owed" \/ (Live /\ jState = "absent")
DStart ==
  /\ ~DActive /\ dRuns < 2 /\ ~newGen
  /\ Live \/ fpc \in {"done", "dead"}
  /\ dRuns' = dRuns + 1
  /\ IF EnforceJournal /\ Started
       THEN /\ dpc' = "refused"
            /\ UNCHANGED <<journal, dSaved, counters, flags>>
       ELSE IF DClaims
         THEN /\ StartBefore("D") /\ dSaved' = journal /\ dpc' = "before"
              /\ UNCHANGED <<beforeOk, afterOpen, afterDone, unsafeAfter>>
         ELSE /\ dpc' = IF Live THEN "cleanup"
                        ELSE IF jState = "afterOwed" THEN "after" ELSE "done"
              /\ UNCHANGED <<journal, dSaved, counters, flags>>
  /\ UNCHANGED <<graph, fpc, interrupts, upInterrupted, fHooks, newGen,
                 unsafeGen, unsafeOwe>>
\* Success owes down.after. A failure leaves cleanup unrequested and restores
\* the claimed record, so an explicit later down may retry a known failure.
DBeforeFinish ==
  /\ dpc = "before" /\ beforeOpen' = beforeOpen - 1
  /\ \E ok \in BOOLEAN :
       IF ok
         THEN /\ beforeOk' = TRUE
              /\ IF jState = "beforeStarted" /\ jGen = "D"
                   THEN jState' = "afterOwed" /\ UNCHANGED jGen
                   ELSE UNCHANGED journal
              /\ dpc' = IF graph = "stopped" THEN "after" ELSE "cleanup"
         ELSE /\ UNCHANGED beforeOk
              /\ IF jState = "beforeStarted" /\ jGen = "D"
                   THEN jState' = dSaved[1] /\ jGen' = dSaved[2]
                   ELSE UNCHANGED journal
              /\ dpc' = "failed"
  /\ UNCHANGED <<graph, fpc, dRuns, dSaved, interrupts, upInterrupted,
                 afterOpen, afterDone, fHooks, newGen, flags>>
DCleanup ==
  /\ dpc = "cleanup"
  /\ graph' = "stopped" /\ dpc' = "after"
  /\ UNCHANGED <<journal, fpc, dRuns, dSaved, interrupts, upInterrupted,
                 counters, fHooks, newGen, flags>>
DAfter ==
  /\ dpc = "after" /\ graph = "stopped"
  /\ IF jState = "afterOwed" \/ ~EnforceJournal
       THEN /\ StartAfter("D") /\ dpc' = "afterRunning"
            /\ UNCHANGED <<beforeOpen, beforeOk, afterDone, unsafeBefore>>
       ELSE /\ dpc' = "done"
            /\ UNCHANGED <<journal, counters, flags>>
  /\ UNCHANGED <<graph, fpc, dRuns, dSaved, interrupts, upInterrupted, fHooks,
                 newGen, unsafeGen, unsafeOwe>>
DAfterDone ==
  /\ dpc = "afterRunning"
  /\ afterOpen' = afterOpen - 1 /\ afterDone' = TRUE
  /\ IF jState = "afterStarted" /\ jGen = "D"
       THEN jState' = "complete" /\ UNCHANGED jGen
       ELSE UNCHANGED journal
  /\ dpc' = "done"
  /\ UNCHANGED <<graph, fpc, dRuns, dSaved, interrupts, upInterrupted,
                 beforeOpen, beforeOk, fHooks, newGen, flags>>
DCrash ==
  /\ DActive /\ dpc' = "dead"
  /\ UNCHANGED <<graph, journal, fpc, dRuns, dSaved, interrupts,
                 upInterrupted, counters, fHooks, newGen, flags>>

\* --------------------------------------------------------- next generation
\* A later up supersedes any record except a started (unknown) phase.
NewUp ==
  /\ ~newGen /\ graph = "stopped" /\ fpc \in {"done", "dead"} /\ ~DActive
  /\ EnforceUnknownBlock => ~Started
  /\ newGen' = TRUE /\ unsafeGen' = Started
  /\ jState' = "absent" /\ jGen' = "none"
  /\ UNCHANGED <<graph, fpc, dpc, dRuns, dSaved, interrupts, upInterrupted,
                 counters, fHooks, unsafeBefore, unsafeAfter, unsafeOwe>>

Next == FOwe \/ FPublish \/ FInterruptAtPublish \/ FUpAfterInterrupted \/ FInterrupt \/ FBeforeFinish
        \/ FCancelBefore \/ FGraphEnds \/ FCleanup \/ FAfter \/ FAfterDone
        \/ FCrash \/ OrphanStops \/ DStart \/ DBeforeFinish \/ DCleanup
        \/ DAfter \/ DAfterDone \/ DCrash \/ NewUp
Spec == Init /\ [][Next]_vars

States == {"absent", "owed", "beforeStarted", "beforeFailed", "afterOwed",
           "afterStarted", "complete"}
TypeOK == /\ graph \in {"upAfter", "ready", "stopped"}
          /\ jState \in States /\ jGen \in {"none", "F", "D"}
          /\ fpc \in {"upAfter", "publishing", "serving", "before", "stopping",
                      "after", "afterRunning", "done", "dead"}
          /\ dpc \in {"idle", "before", "cleanup", "after", "afterRunning",
                      "done", "failed", "refused", "dead"}
          /\ dRuns \in 0..2 /\ dSaved \in States \X {"none", "F", "D"}
          /\ interrupts \in 0..2 /\ upInterrupted \in BOOLEAN
          /\ beforeOpen \in 0..3 /\ beforeOk \in BOOLEAN
          /\ afterOpen \in 0..2 /\ afterDone \in BOOLEAN /\ fHooks \in BOOLEAN
          /\ newGen \in BOOLEAN /\ unsafeBefore \in BOOLEAN
          /\ unsafeAfter \in BOOLEAN /\ unsafeGen \in BOOLEAN
          /\ unsafeOwe \in BOOLEAN
\* down.before starts at most once except to retry a known failure;
\* down.after only after Removed and a known successful down.before, once;
\* a started-unknown phase blocks a new generation;
\* Ctrl-C during up.after never runs, or leaves owed, the frontend's down hooks.
Safe == /\ ~unsafeBefore /\ ~unsafeAfter /\ ~unsafeGen /\ ~unsafeOwe
        /\ (upInterrupted => ~fHooks)
NeverComplete == ~(jState = "complete" /\ afterDone)
\* Reachability: after a frontend crash, down runs the owed hooks once.
NeverRecovered == ~(fpc = "dead" /\ jState = "complete" /\ jGen = "D")
=============================================================================
