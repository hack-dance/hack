-------------------------- MODULE ImagePresence --------------------------
EXTENDS Naturals
CONSTANT TrustReceipt, TrustExpired, EarlyDigest
\* reads counts full archive passes that hash content before an upload or success.
VARIABLES phase, source, receipt, guest, archive, verified, uploaded, observed,
          mode, recorded, online, chose, reads
imageVars == <<phase, source, receipt, guest, archive, verified, uploaded, observed, reads>>
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
    /\ reads = 0
    /\ mode \in {"digest", "normal", "refresh", "offline"}
    /\ recorded \in {"none", "fresh", "expired"}
    /\ online \in BOOLEAN
    /\ chose = "none"

Evict ==
    /\ phase \in {"begin", "ready"}
    /\ guest = "present"
    /\ guest' = "absent"
    /\ UNCHANGED <<phase, source, receipt, archive, verified, uploaded, observed, reads, tagVars>>

Begin ==
    /\ phase = "begin"
    /\ phase' = IF source = "explicit" THEN "verify"
                ELSE IF mode = "digest" THEN "readback" ELSE "tag"
    /\ reads' = IF source = "explicit" THEN 1 ELSE 0
    /\ UNCHANGED <<source, receipt, guest, archive, verified, uploaded, observed, tagVars>>

Expire ==
    /\ phase \in {"begin", "tag"}
    /\ recorded = "fresh"
    /\ recorded' = "expired"
    /\ UNCHANGED <<imageVars, mode, online, chose>>

ChangeAvailability ==
    /\ phase \in {"begin", "tag"}
    /\ online' = ~online
    /\ UNCHANGED <<imageVars, mode, recorded, chose>>

ResolveTag ==
    /\ phase = "tag"
    /\ chose' = IF mode = "normal" /\ (recorded = "fresh" \/ (TrustExpired /\ recorded = "expired"))
                 THEN "recorded"
                 ELSE IF mode # "offline" /\ online THEN "registry"
                 ELSE IF mode # "refresh" /\ recorded # "none" THEN "offline" ELSE "none"
    /\ phase' = IF chose' = "none" THEN "refused" ELSE "readback"
    /\ UNCHANGED <<source, receipt, guest, archive, verified, uploaded, observed, reads, mode, recorded, online>>

Readback ==
    /\ phase = "readback"
    /\ phase' = CASE receipt \in {"foreign", "wrong-pin"} -> "refused"
                   [] chose = "offline" /\ guest # "present" -> "refused"
                   [] chose # "none" /\ guest = "present" -> "ready"
                   [] receipt = "complete" /\ (guest = "present" \/ TrustReceipt) -> "ready"
                   [] receipt \in {"complete", "loading"} /\ guest \in {"wrong", "unknown"} -> "refused"
                   [] receipt = "loading" /\ guest = "absent" -> "refused"
                   [] OTHER -> "verify"
    /\ observed' = (receipt \notin {"foreign", "wrong-pin"} /\
                     (receipt = "complete" \/ chose # "none") /\ guest = "present")
    /\ reads' = IF EarlyDigest /\ phase' = "verify" THEN reads + 1 ELSE reads
    /\ UNCHANGED <<source, receipt, guest, archive, verified, uploaded, tagVars>>

Verify ==
    /\ phase = "verify"
    /\ phase' = IF archive = "clean" THEN "verified" ELSE "refused"
    /\ verified' = (archive = "clean")
    /\ reads' = reads + 1
    /\ UNCHANGED <<source, receipt, guest, archive, uploaded, observed, tagVars>>

Reconcile ==
    /\ phase = "verified"
    /\ phase' = CASE receipt \in {"foreign", "wrong-pin"} \/ guest \in {"wrong", "unknown"} -> "refused"
                   [] receipt = "loading" /\ guest = "absent" -> "refused"
                   [] guest = "present" -> "ready"
                   [] OTHER -> "upload"
    /\ observed' = (receipt \notin {"foreign", "wrong-pin"} /\ guest = "present")
    /\ UNCHANGED <<source, receipt, guest, archive, verified, uploaded, reads, tagVars>>

Upload ==
    /\ phase = "upload"
    /\ phase' = "ready"
    /\ guest' = "present"
    /\ uploaded' = TRUE
    /\ observed' = TRUE
    /\ UNCHANGED <<source, receipt, archive, verified, reads, tagVars>>

Create ==
    /\ phase = "ready"
    /\ phase' = IF guest = "present" THEN "created" ELSE "create_refused"
    /\ UNCHANGED <<source, receipt, guest, archive, verified, uploaded, observed, reads, tagVars>>

Done == /\ phase \in {"created", "refused", "create_refused"} /\ UNCHANGED vars

Spec == Init /\ [][Evict \/ Begin \/ Expire \/ ChangeAvailability \/ ResolveTag \/ Readback \/ Verify \/ Reconcile \/ Upload \/ Create \/ Done]_vars

Safe == /\ (phase = "ready" => observed)
        /\ (uploaded => verified /\ archive = "clean")
        /\ (phase = "created" => observed /\ guest = "present")
        /\ (phase = "ready" /\ source = "explicit" => verified)

TagSafe ==
    /\ chose = "recorded" => mode = "normal" /\ recorded = "fresh"
    /\ chose = "registry" => online /\ mode \in {"normal", "refresh"}
    /\ chose = "offline" => recorded # "none" /\ (mode = "offline" \/ ~online)
    /\ chose = "offline" => ~verified /\ ~uploaded
    /\ mode = "digest" => chose = "none"
    /\ phase = "ready" /\ source = "cached" /\ mode # "digest" => chose # "none"

NeverEvictionRefusal == phase # "create_refused"

NeverSkipsRead == ~(phase = "ready" /\ ~verified)

\* A cached archive is hashed by exactly one pass, validation, before upload or success.
CachedSingleRead == source = "cached" => reads <= 1
=============================================================================
