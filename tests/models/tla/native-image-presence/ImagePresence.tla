-------------------------- MODULE ImagePresence --------------------------
CONSTANT TrustReceipt
VARIABLES phase, source, receipt, guest, archive, verified, uploaded, observed
vars == <<phase, source, receipt, guest, archive, verified, uploaded, observed>>

Init ==
    /\ phase = "begin"
    /\ source \in {"cached", "explicit"}
    /\ receipt \in {"complete", "loading", "none", "foreign"}
    /\ guest \in {"present", "absent", "wrong", "unknown"}
    /\ archive \in {"clean", "changed"}
    /\ verified = FALSE
    /\ uploaded = FALSE
    /\ observed = FALSE

Evict ==
    /\ phase = "begin"
    /\ guest = "present"
    /\ guest' = "absent"
    /\ UNCHANGED <<phase, source, receipt, archive, verified, uploaded, observed>>

Begin ==
    /\ phase = "begin"
    /\ phase' = IF source = "explicit" THEN "verify" ELSE "readback"
    /\ UNCHANGED <<source, receipt, guest, archive, verified, uploaded, observed>>

Readback ==
    /\ phase = "readback"
    /\ phase' = CASE receipt = "foreign" -> "refused"
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
    /\ phase' = CASE receipt = "foreign" \/ guest \in {"wrong", "unknown"} -> "refused"
                   [] receipt = "loading" /\ guest = "absent" -> "refused"
                   [] guest = "present" -> "ready"
                   [] OTHER -> "upload"
    /\ observed' = (receipt # "foreign" /\ guest = "present")
    /\ UNCHANGED <<source, receipt, guest, archive, verified, uploaded>>

Upload ==
    /\ phase = "upload"
    /\ phase' = "ready"
    /\ guest' = "present"
    /\ uploaded' = TRUE
    /\ observed' = TRUE
    /\ UNCHANGED <<source, receipt, archive, verified>>

Done == /\ phase \in {"ready", "refused"} /\ UNCHANGED vars

Spec == Init /\ [][Evict \/ Begin \/ Readback \/ Verify \/ Reconcile \/ Upload \/ Done]_vars

Safe == /\ (phase = "ready" => observed)
        /\ (uploaded => verified /\ archive = "clean")
        /\ (phase = "ready" /\ source = "explicit" => verified)

NeverSkipsRead == ~(phase = "ready" /\ ~verified)
=============================================================================
