-------------------------- MODULE ImagePresence --------------------------
CONSTANT TrustReceipt, TrustExpired
VARIABLES phase, source, receipt, guest, archive, verified, uploaded, observed,
          mode, recorded, online, chose
imageVars == <<phase, source, receipt, guest, archive, verified, uploaded, observed>>
tagVars == <<mode, recorded, online, chose>>
vars == <<imageVars, tagVars>>

Init ==
    /\ phase = "begin"
    /\ source \in {"cached", "explicit"}
    /\ receipt \in {"complete", "loading", "none", "foreign", "wrong-pin"}
    /\ guest \in {"present", "absent", "wrong", "unknown"}
    /\ archive \in {"clean", "changed"}
    /\ verified = FALSE
    /\ uploaded = FALSE
    /\ observed = FALSE
    /\ mode \in {"digest", "normal", "refresh", "offline"}
    /\ recorded \in {"none", "fresh", "expired"}
    /\ online \in BOOLEAN
    /\ chose = "none"

Evict ==
    /\ phase \in {"begin", "ready"}
    /\ guest = "present"
    /\ guest' = "absent"
    /\ UNCHANGED <<phase, source, receipt, archive, verified, uploaded, observed, tagVars>>

Begin ==
    /\ phase = "begin"
    /\ phase' = IF source = "explicit" THEN "verify"
                ELSE IF mode = "digest" THEN "readback" ELSE "tag"
    /\ UNCHANGED <<source, receipt, guest, archive, verified, uploaded, observed, tagVars>>

ResolveTag ==
    /\ phase = "tag"
    /\ chose' = IF mode = "normal" /\ (recorded = "fresh" \/ (TrustExpired /\ recorded = "expired"))
                 THEN "recorded"
                 ELSE IF mode # "offline" /\ online THEN "registry"
                 ELSE IF recorded # "none" THEN "offline" ELSE "none"
    /\ phase' = IF chose' = "none" THEN "refused" ELSE "readback"
    /\ UNCHANGED <<source, receipt, guest, archive, verified, uploaded, observed, mode, recorded, online>>

Readback ==
    /\ phase = "readback"
    /\ phase' = CASE receipt \in {"foreign", "wrong-pin"} -> "refused"
                   [] receipt = "complete" /\ (guest = "present" \/ TrustReceipt) -> "ready"
                   [] receipt \in {"complete", "loading"} /\ guest \in {"wrong", "unknown"} -> "refused"
                   [] receipt = "loading" /\ guest = "absent" -> "refused"
                   [] OTHER -> "verify"
    /\ observed' = (receipt = "complete" /\ guest = "present")
    /\ UNCHANGED <<source, receipt, guest, archive, verified, uploaded, tagVars>>

Verify ==
    /\ phase = "verify"
    /\ phase' = IF archive = "clean" THEN "verified" ELSE "refused"
    /\ verified' = (archive = "clean")
    /\ UNCHANGED <<source, receipt, guest, archive, uploaded, observed, tagVars>>

Reconcile ==
    /\ phase = "verified"
    /\ phase' = CASE receipt \in {"foreign", "wrong-pin"} \/ guest \in {"wrong", "unknown"} -> "refused"
                   [] receipt = "loading" /\ guest = "absent" -> "refused"
                   [] guest = "present" -> "ready"
                   [] OTHER -> "upload"
    /\ observed' = (receipt \notin {"foreign", "wrong-pin"} /\ guest = "present")
    /\ UNCHANGED <<source, receipt, guest, archive, verified, uploaded, tagVars>>

Upload ==
    /\ phase = "upload"
    /\ phase' = "ready"
    /\ guest' = "present"
    /\ uploaded' = TRUE
    /\ observed' = TRUE
    /\ UNCHANGED <<source, receipt, archive, verified, tagVars>>

Create ==
    /\ phase = "ready"
    /\ phase' = IF guest = "present" THEN "created" ELSE "create_refused"
    /\ UNCHANGED <<source, receipt, guest, archive, verified, uploaded, observed, tagVars>>

Done == /\ phase \in {"created", "refused", "create_refused"} /\ UNCHANGED vars

Spec == Init /\ [][Evict \/ Begin \/ ResolveTag \/ Readback \/ Verify \/ Reconcile \/ Upload \/ Create \/ Done]_vars

Safe == /\ (phase = "ready" => observed)
        /\ (uploaded => verified /\ archive = "clean")
        /\ (phase = "created" => observed /\ guest = "present")
        /\ (phase = "ready" /\ source = "explicit" => verified)

TagSafe ==
    /\ chose = "recorded" => mode = "normal" /\ recorded = "fresh"
    /\ chose = "registry" => online /\ mode \in {"normal", "refresh"}
    /\ chose = "offline" => recorded # "none" /\ (mode = "offline" \/ ~online)
    /\ mode = "digest" => chose = "none"
    /\ phase = "ready" /\ source = "cached" /\ mode # "digest" => chose # "none"

NeverEvictionRefusal == phase # "create_refused"

NeverSkipsRead == ~(phase = "ready" /\ ~verified)
=============================================================================
