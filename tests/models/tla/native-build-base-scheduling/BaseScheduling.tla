---- MODULE BaseScheduling ----
CONSTANTS OldColdOrder, UnsafeOverlap
VARIABLES phase, verified, retained, retention, foregroundDownload
vars == <<phase, verified, retained, retention, foregroundDownload>>
Init == /\ phase = "idle" /\ verified = FALSE /\ retained = FALSE
        /\ retention = FALSE /\ foregroundDownload = FALSE

(* Receipt verification is read-only and needs no provider mutation lease. *)
Reuse == /\ phase = "idle" /\ verified
         /\ phase' = "reused" /\ UNCHANGED <<verified, retained, retention, foregroundDownload>>
Cold == /\ phase = "idle" /\ ~verified /\ ~retention
        /\ phase' = "solving" /\ foregroundDownload' = OldColdOrder
        /\ UNCHANGED <<verified, retained, retention>>
Finish == /\ phase = "solving" /\ phase' = "starting" /\ verified' = TRUE
          /\ UNCHANGED <<retained, retention, foregroundDownload>>
Start == /\ phase \in {"starting", "reused"} /\ ~retention
         /\ phase' = "idle" /\ UNCHANGED <<verified, retained, retention, foregroundDownload>>
Stop == /\ phase = "idle" /\ (~retention \/ UnsafeOverlap) /\ phase' = "stopping"
        /\ UNCHANGED <<verified, retained, retention, foregroundDownload>>
Stopped == /\ phase = "stopping" /\ phase' = "idle"
           /\ UNCHANGED <<verified, retained, retention, foregroundDownload>>
IdleAdmission == /\ phase = "idle" /\ verified /\ ~retained /\ ~retention
                 /\ retention' = TRUE
                 /\ UNCHANGED <<phase, verified, retained, foregroundDownload>>
Retain == /\ retention /\ retention' = FALSE /\ retained' = TRUE
          /\ UNCHANGED <<phase, verified, foregroundDownload>>
Fail == /\ retention /\ retention' = FALSE
        /\ UNCHANGED <<phase, verified, retained, foregroundDownload>>
Next == Reuse \/ Cold \/ Finish \/ Start \/ Stop \/ Stopped \/ IdleAdmission \/ Retain \/ Fail
Spec == Init /\ [][Next]_vars
NoForegroundImport == ~foregroundDownload
OnlyIdleRetention == retention => phase \in {"idle", "reused"}
====
