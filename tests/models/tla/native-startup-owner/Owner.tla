----------------------------- MODULE Owner -----------------------------
\* HACK-1917: a foreground startup that fails after its graph started owned
\* resources must leave them owned by the project. The run mapping is published
\* at started (after the authoritative inspection); a failure before that whose
\* cleanup the frontend cannot confirm publishes the authenticated receipt's
\* identity instead. Recording never stops, replays or retires anything.
\*
\* `hack up` returns at started: every container started, goals possibly unmet.
\* The owner keeps waiting for every goal (`ready`) in the background. With
\* `--wait` (WaitForReady) the mapping is still saved at started (the CLI passes
\* --report-started in both modes); bookkeeping and the return wait for ready.
\* A `down` in the window between started and ready only queues a stop; the
\* owner accepts it at its next cancellation check, between passes of its start
\* loop, and that cancels its wait. The owner takes a queued stop only when no
\* publication is half done: the one service's publication under the lease is a
\* two-step commit, and acceptance waits for it to commit or be withdrawn.
\* The frontend (the CLI process) cancels separately: its own controller is
\* aborted when the stop reaches it or the user interrupts, and only that
\* closes its started chain (mapping, bookkeeping, launcher release). The
\* owner's acceptance does not; the stop's down.before runs only after the
\* frontend has cancelled.
EXTENDS TLC, Naturals
CONSTANTS RecordFailedOwner, EnforceDetachedStarted, EnforceBookkeeping,
          MappingBeforeNotify, CancelWaitOnDown, WaitForReady,
          StopWaitsForPublication, StopNeedsAccept, StopAfterFrontendCancel
VARIABLES phase, resources, mapping, receipt, cleaned, readied, startedSeen,
          wait, down, acceptAt, hooks, pub, route, recorded, frontend,
          launcher, accepted, bookkept
launch == <<launcher, accepted, bookkept>>
publication == <<pub, route, recorded>>
stopping == <<wait, down, acceptAt, hooks, publication, frontend>>
core == <<phase, resources, mapping, receipt, cleaned, readied, startedSeen>>
vars == <<core, stopping, launch>>
TypeOK ==
    /\ launcher \in {"waiting", "notified", "accepting", "handed", "returned", "lost"}
    /\ accepted \in BOOLEAN
    /\ bookkept \in BOOLEAN
    /\ phase \in {"idle", "serving", "started", "ready", "failed", "exited", "stopped"}
    /\ resources \in {"none", "present", "absent"}
    /\ mapping \in {"none", "published"}
    /\ receipt \in {"unknown", "authenticated", "refused"}
    /\ cleaned \in BOOLEAN
    /\ readied \in BOOLEAN
    /\ startedSeen \in BOOLEAN
    \* The owner's wait for every service goal after started.
    /\ wait \in {"none", "waiting", "cancelled", "done"}
    \* queued: `hack down` sent the stop; accepted: the owner's check took it.
    /\ down \in {"none", "queued", "accepted", "done"}
    \* The phase in which the owner accepted the stop.
    /\ acceptAt \in {"none", "started", "ready"}
    /\ hooks \in 0..2
    \* One service's publication under the lease: staged, then one atomic commit
    \* (route plus record) or a withdraw. route is the bound port/HTTPS route;
    \* recorded is the owner's record that a stop or down will withdraw.
    /\ pub \in {"idle", "publishing", "committed", "withdrawn"}
    /\ route \in {"none", "bound"}
    /\ recorded \in BOOLEAN
    \* The frontend's own controller: live, or aborted because the stop reached
    \* it ("down") or the user interrupted ("interrupt").
    /\ frontend \in {"live", "down", "interrupt"}
\* The phase at which bookkeeping and the launcher release run: started by
\* default, ready under --wait. The mapping is saved at started in both modes.
WorkPhase == IF WaitForReady THEN {"ready"} ELSE {"started", "ready"}
MappingPhase == {"started", "ready"}
\* The frontend's started chain runs until its own controller is aborted. The
\* owner's acceptance of a stop does not hold it back by itself.
FrontendLive == frontend = "live"
\* The owner keeps working (stages publications) until it accepts a stop.
OwnerLive == down \in {"none", "queued"}
\* The release point the launcher waits for: started, or ready under --wait.
Released == IF WaitForReady THEN readied ELSE startedSeen
CoreInit == /\ phase = "idle" /\ resources = "none" /\ mapping = "none"
        /\ receipt = "unknown" /\ cleaned = FALSE /\ readied = FALSE
        /\ startedSeen = FALSE
StopInit == /\ wait = "none" /\ down = "none" /\ acceptAt = "none" /\ hooks = 0
            /\ pub = "idle" /\ route = "none" /\ recorded = FALSE
            /\ frontend = "live"
Serve == /\ phase = "idle" /\ phase' = "serving"
         /\ UNCHANGED <<resources, mapping, receipt, cleaned, readied, startedSeen>>
    /\ UNCHANGED <<stopping, launch>>
\* Admission created owned containers, networks or relay state.
StartResources == /\ phase = "serving" /\ resources = "none"
                  /\ resources' = "present"
                  /\ UNCHANGED <<phase, mapping, receipt, cleaned, readied, startedSeen>>
    /\ UNCHANGED <<stopping, launch>>
\* graph_foreground_started, then the authoritative inspection (run, namespace,
\* plan, owner). The owner starts waiting for every service goal.
Started == /\ phase = "serving" /\ resources = "present"
           /\ phase' = "started" /\ startedSeen' = TRUE /\ wait' = "waiting"
           /\ UNCHANGED <<resources, mapping, receipt, cleaned, readied>>
           /\ UNCHANGED <<down, acceptAt, hooks, publication, frontend, launch>>
\* Save the run mapping (onStarted step 2), before anything acts on the line.
\* Both modes: a --wait start killed between started and ready has a mapping.
PublishMapping == /\ phase \in MappingPhase
                  /\ mapping = "none" /\ FrontendLive
                  /\ mapping' = "published"
                  /\ UNCHANGED <<phase, resources, receipt, cleaned, readied, startedSeen>>
                  /\ UNCHANGED <<stopping, launch>>
\* The service became ready: the owner stages its publication under the lease.
BeginPublish == /\ phase = "started" /\ wait = "waiting" /\ OwnerLive
                /\ pub = "idle" /\ pub' = "publishing" /\ route' = "bound"
                /\ UNCHANGED <<core, wait, down, acceptAt, hooks, recorded, frontend, launch>>
\* One atomic commit: the route stays bound and the record is written together.
CommitPublish == /\ pub = "publishing" /\ pub' = "committed" /\ recorded' = TRUE
                 /\ UNCHANGED <<core, wait, down, acceptAt, hooks, route, frontend, launch>>
\* Or the staged publication is withdrawn: nothing bound, nothing recorded.
WithdrawPublish == /\ pub = "publishing" /\ pub' = "withdrawn" /\ route' = "none"
                   /\ UNCHANGED <<core, wait, down, acceptAt, hooks, recorded, frontend, launch>>
\* graph_foreground_ready: every goal met and the service published. Only a
\* live wait can reach it.
Ready == /\ phase = "started" /\ resources = "present" /\ wait = "waiting"
         /\ pub = "committed"
         /\ phase' = "ready" /\ readied' = TRUE /\ wait' = "done"
         /\ UNCHANGED <<resources, mapping, receipt, cleaned, startedSeen>>
         /\ UNCHANGED <<down, acceptAt, hooks, publication, frontend, launch>>
Fail == /\ phase \in {"serving", "started", "ready"} /\ down = "none"
        /\ phase' = "failed"
        /\ wait' = IF wait = "waiting" THEN "cancelled" ELSE wait
        /\ UNCHANGED <<resources, mapping, receipt, cleaned, readied, startedSeen>>
        /\ UNCHANGED <<down, acceptAt, hooks, publication, frontend, launch>>
\* The graph owner's retaining cleanup either completes or is refused (for
\* example when the provider cannot be audited); refusal leaves resources.
OwnerCleanup == /\ phase = "failed" /\ receipt = "unknown"
                /\ resources = "present" /\ resources' = "absent"
                /\ UNCHANGED <<phase, mapping, receipt, cleaned, readied, startedSeen>>
                /\ UNCHANGED <<stopping, launch>>
\* The frontend's final read-only inspection authenticates the exact receipt
\* (run, owner, namespace, plan, complete journal) or is refused.
Inspect == /\ phase = "failed" /\ receipt = "unknown"
           /\ receipt' \in {"authenticated", "refused"}
           /\ UNCHANGED <<phase, resources, mapping, cleaned, readied, startedSeen>>
           /\ UNCHANGED <<stopping, launch>>
Confirm == /\ phase = "failed" /\ receipt = "authenticated"
           /\ resources # "present" /\ ~cleaned /\ cleaned' = TRUE
           /\ UNCHANGED <<phase, resources, mapping, receipt, readied, startedSeen>>
           /\ UNCHANGED <<stopping, launch>>
ExitConfirmed == /\ phase = "failed" /\ cleaned /\ phase' = "exited"
                 /\ UNCHANGED <<resources, mapping, receipt, cleaned, readied, startedSeen>>
                 /\ UNCHANGED <<stopping, launch>>
\* Unconfirmed cleanup: record the authenticated owner when no mapping exists.
ExitUnconfirmed ==
    /\ phase = "failed" /\ receipt # "unknown" /\ ~cleaned
    /\ ~(receipt = "authenticated" /\ resources # "present")
    /\ phase' = "exited"
    /\ mapping' = IF RecordFailedOwner /\ mapping = "none"
                     /\ receipt = "authenticated"
                  THEN "published" ELSE mapping
    /\ UNCHANGED <<resources, receipt, cleaned, readied, startedSeen>>
    /\ UNCHANGED <<stopping, launch>>
\* `hack down` finds the run through its mapping and sends the stop through the
\* owner. This only queues it: the owner has not seen it yet. It is enabled
\* during a publication; the publication guard is on acceptance.
DownRequest ==
    /\ down = "none" /\ phase \in {"started", "ready"} /\ mapping = "published"
    /\ down' = "queued"
    /\ UNCHANGED <<core, wait, acceptAt, hooks, publication, frontend, launch>>
\* The owner's next cancellation check, between passes, accepts the stop and
\* aborts its own cancellation token, which cancels its wait for ready. It takes
\* a queued stop only when no publication is half done.
\* CancelWaitOnDown = FALSE drops the cancel. StopWaitsForPublication = FALSE
\* lets the owner accept mid-publication, so its stop misses the staged route.
AcceptStop ==
    /\ down = "queued" /\ down' = "accepted" /\ acceptAt' = phase
    /\ StopWaitsForPublication => pub # "publishing"
    /\ wait' = IF CancelWaitOnDown /\ wait = "waiting" THEN "cancelled" ELSE wait
    /\ UNCHANGED <<core, hooks, publication, frontend, launch>>
\* The frontend aborts its own controller (controller.abort()): the stop reached
\* it, or the user interrupted it. This is not the owner's acceptance; either
\* may come first. Its started chain (PublishMapping, Bookkeep, Notify) stops
\* here. An interrupt alone does not queue a stop in this model: the stop it
\* leads to is a DownRequest.
FrontendCancel ==
    /\ frontend = "live" /\ phase \in {"started", "ready"}
    /\ \/ down \in {"queued", "accepted"} /\ frontend' = "down"
       \/ frontend' = "interrupt"
    /\ UNCHANGED <<core, wait, down, acceptAt, hooks, publication, launch>>
\* The owner stops the graph, withdrawing every recorded publication.
\* down.before runs once when the debt was committed, after the frontend's
\* controller is aborted, so no debt is committed after it ran.
\* StopNeedsAccept = FALSE lets a queued stop take effect without the owner's
\* check, so the owner is never told and keeps waiting.
\* StopAfterFrontendCancel = FALSE lets the stop finish while the frontend is
\* still live, so it can still commit debt whose down.before never runs.
DownStop ==
    /\ IF StopNeedsAccept THEN down = "accepted" ELSE down \in {"queued", "accepted"}
    /\ StopAfterFrontendCancel => frontend # "live"
    /\ down' = "done"
    /\ phase' = "stopped" /\ resources' = "absent"
    /\ hooks' = IF bookkept THEN hooks + 1 ELSE hooks
    /\ route' = IF recorded THEN "none" ELSE route
    /\ recorded' = FALSE
    /\ UNCHANGED <<mapping, receipt, cleaned, readied, startedSeen>>
    /\ UNCHANGED <<wait, acceptAt, pub, frontend, launch>>
CoreNext == Serve \/ StartResources \/ Started \/ PublishMapping \/ Ready \/ Fail
        \/ OwnerCleanup \/ Inspect \/ Confirm \/ ExitConfirmed \/ ExitUnconfirmed
        \/ BeginPublish \/ CommitPublish \/ WithdrawPublish
        \/ DownRequest \/ AcceptStop \/ FrontendCancel \/ DownStop
\* The IPC launcher has no graph authority. A lost channel before acceptance
\* requests ordinary stop; failure/cleanup retains the original mapping rules.
Init == CoreInit /\ StopInit
        /\ launcher = "waiting" /\ accepted = FALSE /\ bookkept = FALSE
\* Successful completion of the durable down-hook obligation (stop.owe),
\* including its cancellation fence: no debt is committed once the frontend's
\* own controller is aborted. Neither a queued stop nor the owner's acceptance
\* fences it.
Bookkeep == /\ phase \in WorkPhase /\ ~bookkept /\ FrontendLive
            /\ bookkept' = TRUE
            /\ UNCHANGED <<core, stopping, launcher, accepted>>
\* Release the detached launcher: a `started` message (or `ready` under --wait).
Notify == /\ launcher = "waiting" /\ FrontendLive
          /\ (EnforceDetachedStarted => (Released /\ phase \in WorkPhase))
          /\ (EnforceBookkeeping => bookkept)
          \* MappingBeforeNotify = FALSE is finding B: the line can be acted on
          \* (and the start killed) before its mapping is saved.
          /\ (MappingBeforeNotify => mapping = "published")
          /\ launcher' = "notified"
          /\ UNCHANGED <<core, stopping, accepted, bookkept>>
Accept == /\ launcher = "notified" /\ launcher' = "accepting"
          /\ UNCHANGED <<core, stopping, accepted, bookkept>>
OwnerAccept == /\ launcher = "accepting" /\ launcher' = "handed"
               /\ accepted' = TRUE /\ UNCHANGED <<core, stopping, bookkept>>
\* The launcher exits 0 and prints the closing line.
Return == /\ launcher = "handed" /\ launcher' = "returned"
          /\ UNCHANGED <<core, stopping, accepted, bookkept>>
LauncherLoss == /\ launcher \in {"waiting", "notified", "accepting"}
                /\ launcher' = "lost"
                /\ UNCHANGED <<core, stopping, accepted, bookkept>>
Next == CoreNext \/ Bookkeep \/ Notify \/ Accept \/ OwnerAccept
        \/ Return \/ LauncherLoss
Spec == Init /\ [][Next]_vars
\* Return only after started (ready under --wait), with the mapping saved, the
\* down-hook debt committed and the owner's acceptance.
NoPrematureReturn ==
    launcher = "returned"
        => (Released /\ mapping = "published" /\ bookkept /\ accepted)
\* The launcher is never released before the run mapping is saved, so a start
\* killed after its closing line can still be found by `down`.
NoReturnWithoutMapping ==
    launcher \in {"notified", "accepting", "handed", "returned"}
        => mapping = "published"
NoLostHandoff == launcher = "lost" => ~accepted
\* A stop the owner accepted in the started window leaves it not waiting, and
\* no Ready follows.
DownCancelsWait == acceptAt = "started" => (wait # "waiting" /\ ~readied)
\* A stopped run has no owner still waiting for ready: every stop went through
\* the owner's acceptance.
StoppedOwnerNotWaiting == phase = "stopped" => wait # "waiting"
\* A stopped run has no frontend still live: its controller was aborted before
\* the stop ran down.before, so its started chain cannot run after the stop.
StoppedFrontendCancelled == phase = "stopped" => frontend # "live"
\* After a stop, no service is published but unrecorded, or recorded but
\* unpublished: the publication either committed and was withdrawn by the stop,
\* or was withdrawn before it.
NoHalfPublicationAfterStop == phase = "stopped" => ((route = "bound") = recorded)
\* down.before runs exactly once for committed debt, and never without it.
\* With the split, this relates the frontend's fence (Bookkeep) to the owner's
\* stop (DownStop).
DownHooksOnce == hooks = IF down = "done" /\ bookkept THEN 1 ELSE 0
\* Resources that outlive the frontend under an authenticated receipt are owned.
NoUnownedResources ==
    (phase = "exited" /\ resources = "present" /\ receipt = "authenticated")
        => mapping = "published"
\* Only the started inspection or an authenticated receipt may publish a mapping.
NoUnprovenOwner == mapping = "published" => (startedSeen \/ receipt = "authenticated")
\* A confirmed cleanup never leaves resources behind.
NoFalseCleanup == cleaned => resources # "present"
\* Coverage gap control: with a refused inspection nothing can be authenticated,
\* so the runtime journal alone retains the graph. Expected to be violated.
NoUnrecordedRefusal ==
    (phase = "exited" /\ resources = "present") => mapping = "published"
=============================================================================
