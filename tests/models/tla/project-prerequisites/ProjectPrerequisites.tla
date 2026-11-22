---- MODULE ProjectPrerequisites ----
EXTENDS FiniteSets

CONSTANT RecheckAfterLogin
VARIABLES phase, checked, consent, loggedIn

vars == <<phase, checked, consent, loggedIn>>

Init ==
  /\ phase = "check"
  /\ checked = FALSE
  /\ consent = FALSE
  /\ loggedIn = FALSE

CheckPass ==
  /\ phase \in {"check", "recheck"}
  /\ phase' = "allowed"
  /\ checked' = TRUE
  /\ UNCHANGED <<consent, loggedIn>>

CheckFails ==
  /\ phase \in {"check", "recheck"}
  /\ (IF phase = "check" THEN phase' \in {"offer", "blocked"}
      ELSE phase' = "blocked")
  /\ UNCHANGED <<checked, consent, loggedIn>>

Decide ==
  /\ phase = "offer"
  /\ consent' \in BOOLEAN
  /\ phase' = IF consent' THEN "login" ELSE "blocked"
  /\ UNCHANGED <<checked, loggedIn>>

Login ==
  /\ phase = "login"
  /\ loggedIn' \in BOOLEAN
  /\ phase' = IF ~loggedIn' THEN "blocked"
              ELSE IF RecheckAfterLogin THEN "recheck" ELSE "allowed"
  /\ UNCHANGED <<checked, consent>>

Next == CheckPass \/ CheckFails \/ Decide \/ Login

Spec == Init /\ [][Next]_vars

CheckedBeforeHooks == phase = "allowed" => checked
LoginRequiresConsent == (phase = "login" \/ loggedIn) => consent
====
