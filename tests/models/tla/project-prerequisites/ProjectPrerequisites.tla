---- MODULE ProjectPrerequisites ----
EXTENDS FiniteSets

CONSTANT RecheckAfterLogin
VARIABLES phase, checked, consent, loggedIn, groupStopped

vars == <<phase, checked, consent, loggedIn, groupStopped>>

Init ==
  /\ phase = "check"
  /\ checked = FALSE
  /\ consent = FALSE
  /\ loggedIn = FALSE
  /\ groupStopped = FALSE

CheckPass ==
  /\ phase \in {"check", "recheck"}
  /\ phase' = "allowed"
  /\ checked' = TRUE
  /\ UNCHANGED <<consent, loggedIn, groupStopped>>

CheckFails ==
  /\ phase \in {"check", "recheck"}
  /\ (IF phase = "check" THEN phase' \in {"offer", "blocked"}
      ELSE phase' = "blocked")
  /\ UNCHANGED <<checked, consent, loggedIn, groupStopped>>

Decide ==
  /\ phase = "offer"
  /\ consent' \in BOOLEAN
  /\ phase' = IF consent' THEN "login" ELSE "blocked"
  /\ UNCHANGED <<checked, loggedIn, groupStopped>>

Login ==
  /\ phase = "login"
  /\ loggedIn' \in BOOLEAN
  /\ phase' = IF ~loggedIn' THEN "blocked"
              ELSE IF RecheckAfterLogin THEN "recheck" ELSE "allowed"
  /\ UNCHANGED <<checked, consent, groupStopped>>

Timeout ==
  /\ phase \in {"check", "recheck"}
  /\ phase' = "stopping"
  /\ UNCHANGED <<checked, consent, loggedIn, groupStopped>>

StopGroup ==
  /\ phase = "stopping"
  /\ phase' = "timeoutBlocked"
  /\ groupStopped' = TRUE
  /\ UNCHANGED <<checked, consent, loggedIn>>

Next == CheckPass \/ CheckFails \/ Decide \/ Login \/ Timeout \/ StopGroup

Spec == Init /\ [][Next]_vars

CheckedBeforeHooks == phase = "allowed" => checked
LoginRequiresConsent == (phase = "login" \/ loggedIn) => consent
TimeoutRequiresGroupStop == phase = "timeoutBlocked" => groupStopped
====
