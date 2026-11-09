----------------------------- MODULE Owner -----------------------------
\* HACK-1917: a foreground startup that fails after its graph started owned
\* resources must leave them owned by the project. Readiness publishes the run
\* mapping; a failure before readiness whose cleanup the frontend cannot confirm
\* publishes the authenticated receipt's identity instead. Recording never stops,
\* replays or retires anything.
EXTENDS TLC
CONSTANTS RecordFailedOwner, EnforceDetachedReady, EnforceBookkeeping
VARIABLES phase, resources, mapping, receipt, cleaned, readied, launcher, accepted, bookkept
launch == <<launcher, accepted, bookkept>>
core == <<phase, resources, mapping, receipt, cleaned, readied>>
vars == <<core, launch>>
TypeOK ==
    /\ launcher \in {"waiting", "notified", "accepting", "handed", "returned", "lost"}
    /\ accepted \in BOOLEAN
    /\ bookkept \in BOOLEAN
    /\ phase \in {"idle", "serving", "ready", "failed", "exited"}
    /\ resources \in {"none", "present", "absent"}
    /\ mapping \in {"none", "published"}
    /\ receipt \in {"unknown", "authenticated", "refused"}
    /\ cleaned \in BOOLEAN
    /\ readied \in BOOLEAN
CoreInit == /\ phase = "idle" /\ resources = "none" /\ mapping = "none"
        /\ receipt = "unknown" /\ cleaned = FALSE /\ readied = FALSE
Serve == /\ phase = "idle" /\ phase' = "serving"
         /\ UNCHANGED <<resources, mapping, receipt, cleaned, readied>>
    /\ UNCHANGED launch
\* Admission created owned containers, networks or relay state.
StartResources == /\ phase = "serving" /\ resources = "none"
                  /\ resources' = "present"
                  /\ UNCHANGED <<phase, mapping, receipt, cleaned, readied>>
    /\ UNCHANGED launch
Ready == /\ phase = "serving" /\ resources = "present"
         /\ phase' = "ready" /\ mapping' = "published" /\ readied' = TRUE
         /\ UNCHANGED <<resources, receipt, cleaned>>
    /\ UNCHANGED launch
Fail == /\ phase \in {"serving", "ready"} /\ phase' = "failed"
        /\ UNCHANGED <<resources, mapping, receipt, cleaned, readied>>
    /\ UNCHANGED launch
\* The graph owner's retaining cleanup either completes or is refused (for
\* example when the provider cannot be audited); refusal leaves resources.
OwnerCleanup == /\ phase = "failed" /\ receipt = "unknown"
                /\ resources = "present" /\ resources' = "absent"
                /\ UNCHANGED <<phase, mapping, receipt, cleaned, readied>>
    /\ UNCHANGED launch
\* The frontend's final read-only inspection authenticates the exact receipt
\* (run, owner, namespace, plan, complete journal) or is refused.
Inspect == /\ phase = "failed" /\ receipt = "unknown"
           /\ receipt' \in {"authenticated", "refused"}
           /\ UNCHANGED <<phase, resources, mapping, cleaned, readied>>
    /\ UNCHANGED launch
Confirm == /\ phase = "failed" /\ receipt = "authenticated"
           /\ resources # "present" /\ ~cleaned /\ cleaned' = TRUE
           /\ UNCHANGED <<phase, resources, mapping, receipt, readied>>
    /\ UNCHANGED launch
ExitConfirmed == /\ phase = "failed" /\ cleaned /\ phase' = "exited"
                 /\ UNCHANGED <<resources, mapping, receipt, cleaned, readied>>
    /\ UNCHANGED launch
\* Unconfirmed cleanup: record the authenticated owner when no mapping exists.
ExitUnconfirmed ==
    /\ phase = "failed" /\ receipt # "unknown" /\ ~cleaned
    /\ ~(receipt = "authenticated" /\ resources # "present")
    /\ phase' = "exited"
    /\ mapping' = IF RecordFailedOwner /\ mapping = "none"
                     /\ receipt = "authenticated"
                  THEN "published" ELSE mapping
    /\ UNCHANGED <<resources, receipt, cleaned, readied>>
    /\ UNCHANGED launch
CoreNext == Serve \/ StartResources \/ Ready \/ Fail \/ OwnerCleanup \/ Inspect
        \/ Confirm \/ ExitConfirmed \/ ExitUnconfirmed
\* The IPC launcher has no graph authority. A lost channel before acceptance
\* requests ordinary stop; failure/cleanup retains the original mapping rules.
Init == CoreInit /\ launcher = "waiting" /\ accepted = FALSE /\ bookkept = FALSE
\* Successful completion of up.after's durable down-hook obligation, including
\* its cancellation fence. Delay/failure cannot issue a launcher notification.
Bookkeep == /\ phase = "ready" /\ ~bookkept /\ bookkept' = TRUE
            /\ UNCHANGED <<core, launcher, accepted>>
Notify == /\ launcher = "waiting" /\ (EnforceDetachedReady => phase = "ready")
          /\ (EnforceBookkeeping => bookkept)
          /\ launcher' = "notified" /\ UNCHANGED <<core, accepted, bookkept>>
Accept == /\ launcher = "notified" /\ launcher' = "accepting"
          /\ UNCHANGED <<core, accepted, bookkept>>
OwnerAccept == /\ launcher = "accepting" /\ launcher' = "handed"
               /\ accepted' = TRUE /\ UNCHANGED <<core, bookkept>>
Return == /\ launcher = "handed" /\ launcher' = "returned"
          /\ UNCHANGED <<core, accepted, bookkept>>
LauncherLoss == /\ launcher \in {"waiting", "notified", "accepting"}
                /\ launcher' = "lost" /\ UNCHANGED <<core, accepted, bookkept>>
Next == CoreNext \/ Bookkeep \/ Notify \/ Accept \/ OwnerAccept
        \/ Return \/ LauncherLoss
NoPrematureReturn == launcher = "returned" => (readied /\ bookkept /\ accepted)
NoLostHandoff == launcher = "lost" => ~accepted
Spec == Init /\ [][Next]_vars
\* Resources that outlive the frontend under an authenticated receipt are owned.
NoUnownedResources ==
    (phase = "exited" /\ resources = "present" /\ receipt = "authenticated")
        => mapping = "published"
\* Only readiness or an authenticated receipt may publish a mapping.
NoUnprovenOwner == mapping = "published" => (readied \/ receipt = "authenticated")
\* A confirmed cleanup never leaves resources behind.
NoFalseCleanup == cleaned => resources # "present"
\* Coverage gap control: with a refused inspection nothing can be authenticated,
\* so the runtime journal alone retains the graph. Expected to be violated.
NoUnrecordedRefusal ==
    (phase = "exited" /\ resources = "present") => mapping = "published"
=============================================================================
