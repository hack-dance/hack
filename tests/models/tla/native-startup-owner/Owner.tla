----------------------------- MODULE Owner -----------------------------
\* HACK-1917: a foreground startup that fails after its graph started owned
\* resources must leave them owned by the project. Readiness publishes the run
\* mapping; a failure before readiness whose cleanup the frontend cannot confirm
\* publishes the authenticated receipt's identity instead. Recording never stops,
\* replays or retires anything.
EXTENDS TLC
CONSTANTS RecordFailedOwner
VARIABLES phase, resources, mapping, receipt, cleaned, readied
vars == <<phase, resources, mapping, receipt, cleaned, readied>>
TypeOK ==
    /\ phase \in {"idle", "serving", "ready", "failed", "exited"}
    /\ resources \in {"none", "present", "absent"}
    /\ mapping \in {"none", "published"}
    /\ receipt \in {"unknown", "authenticated", "refused"}
    /\ cleaned \in BOOLEAN
    /\ readied \in BOOLEAN
Init == /\ phase = "idle" /\ resources = "none" /\ mapping = "none"
        /\ receipt = "unknown" /\ cleaned = FALSE /\ readied = FALSE
Serve == /\ phase = "idle" /\ phase' = "serving"
         /\ UNCHANGED <<resources, mapping, receipt, cleaned, readied>>
\* Admission created owned containers, networks or relay state.
StartResources == /\ phase = "serving" /\ resources = "none"
                  /\ resources' = "present"
                  /\ UNCHANGED <<phase, mapping, receipt, cleaned, readied>>
Ready == /\ phase = "serving" /\ resources = "present"
         /\ phase' = "ready" /\ mapping' = "published" /\ readied' = TRUE
         /\ UNCHANGED <<resources, receipt, cleaned>>
Fail == /\ phase \in {"serving", "ready"} /\ phase' = "failed"
        /\ UNCHANGED <<resources, mapping, receipt, cleaned, readied>>
\* The graph owner's retaining cleanup either completes or is refused (for
\* example when the provider cannot be audited); refusal leaves resources.
OwnerCleanup == /\ phase = "failed" /\ receipt = "unknown"
                /\ resources = "present" /\ resources' = "absent"
                /\ UNCHANGED <<phase, mapping, receipt, cleaned, readied>>
\* The frontend's final read-only inspection authenticates the exact receipt
\* (run, owner, namespace, plan, complete journal) or is refused.
Inspect == /\ phase = "failed" /\ receipt = "unknown"
           /\ receipt' \in {"authenticated", "refused"}
           /\ UNCHANGED <<phase, resources, mapping, cleaned, readied>>
Confirm == /\ phase = "failed" /\ receipt = "authenticated"
           /\ resources # "present" /\ ~cleaned /\ cleaned' = TRUE
           /\ UNCHANGED <<phase, resources, mapping, receipt, readied>>
ExitConfirmed == /\ phase = "failed" /\ cleaned /\ phase' = "exited"
                 /\ UNCHANGED <<resources, mapping, receipt, cleaned, readied>>
\* Unconfirmed cleanup: record the authenticated owner when no mapping exists.
ExitUnconfirmed ==
    /\ phase = "failed" /\ receipt # "unknown" /\ ~cleaned
    /\ ~(receipt = "authenticated" /\ resources # "present")
    /\ phase' = "exited"
    /\ mapping' = IF RecordFailedOwner /\ mapping = "none"
                     /\ receipt = "authenticated"
                  THEN "published" ELSE mapping
    /\ UNCHANGED <<resources, receipt, cleaned, readied>>
Next == Serve \/ StartResources \/ Ready \/ Fail \/ OwnerCleanup \/ Inspect
        \/ Confirm \/ ExitConfirmed \/ ExitUnconfirmed
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
