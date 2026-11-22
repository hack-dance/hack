-------------------------- MODULE ImagePresence --------------------------
CONSTANT TrustReceipt
VARIABLES phase, source, receipt, guest, archive, verified, uploaded, observed
vars == <<phase, source, receipt, guest, archive, verified, uploaded, observed>>

Init ==
    /\ phase = "begin"
    /\ source \in {"cached", "explicit"}
    /\ receipt \in {"complete", "loading", "none", "foreign", "wrong-pin"}
    /\ guest \in {"present", "absent", "wrong", "unknown"}
    /\ archive \in {"clean", "changed"}
    /\ verified = FALSE
    /\ uploaded = FALSE
    /\ observed = FALSE

Evict ==
    /\ phase \in {"begin", "ready"}
    /\ guest = "present"
    /\ guest' = "absent"
    /\ UNCHANGED <<phase, source, receipt, archive, verified, uploaded, observed>>

Begin ==
    /\ phase = "begin"
    /\ phase' = IF source = "explicit" THEN "verify" ELSE "readback"
    /\ UNCHANGED <<source, receipt, guest, archive, verified, uploaded, observed>>

Readback ==
    /\ phase = "readback"
    /\ phase' = CASE receipt \in {"foreign", "wrong-pin"} -> "refused"
                   [] receipt = "complete" /\ (guest = "present" \/ TrustReceipt) -> "ready"
                   [] receipt \in {"complete", "loading"} /\ guest \in {"wrong", "unknown"} -> "refused"
                   [] receipt = "loading" /\ guest = "absent" -> "refused"
                   [] OTHER -> "verify"
    /\ observed' = (receipt = "complete" /\ guest = "present")
    /\ UNCHANGED <<source, receipt, guest, archive, verified, uploaded>>

Verify ==
    /\ phase = "verify"
    /\ phase' = IF archive = "clean" THEN "verified" ELSE "refused"
    /\ verified' = (archive = "clean")
    /\ UNCHANGED <<source, receipt, guest, archive, uploaded, observed>>

Reconcile ==
    /\ phase = "verified"
    /\ phase' = CASE receipt \in {"foreign", "wrong-pin"} \/ guest \in {"wrong", "unknown"} -> "refused"
                   [] receipt = "loading" /\ guest = "absent" -> "refused"
                   [] guest = "present" -> "ready"
                   [] OTHER -> "upload"
    /\ observed' = (receipt \notin {"foreign", "wrong-pin"} /\ guest = "present")
    /\ UNCHANGED <<source, receipt, guest, archive, verified, uploaded>>

Upload ==
    /\ phase = "upload"
    /\ phase' = "ready"
    /\ guest' = "present"
    /\ uploaded' = TRUE
    /\ observed' = TRUE
    /\ UNCHANGED <<source, receipt, archive, verified>>

Create ==
    /\ phase = "ready"
    /\ phase' = IF guest = "present" THEN "created" ELSE "create_refused"
    /\ UNCHANGED <<source, receipt, guest, archive, verified, uploaded, observed>>

Done == /\ phase \in {"created", "refused", "create_refused"} /\ UNCHANGED vars

Spec == Init /\ [][Evict \/ Begin \/ Readback \/ Verify \/ Reconcile \/ Upload \/ Create \/ Done]_vars

Safe == /\ (phase = "ready" => observed)
        /\ (uploaded => verified /\ archive = "clean")
        /\ (phase = "created" => observed /\ guest = "present")
        /\ (phase = "ready" /\ source = "explicit" => verified)

NeverEvictionRefusal == phase # "create_refused"

NeverSkipsRead == ~(phase = "ready" /\ ~verified)
=============================================================================
