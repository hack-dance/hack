---- MODULE ProjectRemoteSelection ----
CONSTANT AtomicPublish
Writers == {"first", "second"}
Targets == {"local", "qa"}
VARIABLES owner, saved, staged, running, applied

vars == <<owner, saved, staged, running, applied>>

Init ==
  /\ owner = "none"
  /\ saved = "local"
  /\ staged = "none"
  /\ running = FALSE
  /\ applied = "none"

Claim(w, t) ==
  /\ owner = "none"
  /\ ~running
  /\ owner' = w
  /\ staged' = t
  /\ saved' = IF AtomicPublish THEN saved ELSE "partial"
  /\ UNCHANGED <<running, applied>>

Publish(w) ==
  /\ owner = w
  /\ saved' = staged
  /\ owner' = "none"
  /\ staged' = "none"
  /\ UNCHANGED <<running, applied>>

Crash(w) ==
  /\ owner = w
  /\ owner' = "none"
  /\ staged' = "none"
  /\ UNCHANGED <<saved, running, applied>>

Start ==
  /\ ~running
  /\ running' = TRUE
  /\ applied' = saved
  /\ UNCHANGED <<owner, staged, saved>>

Stop ==
  /\ running
  /\ running' = FALSE
  /\ applied' = "none"
  /\ UNCHANGED <<owner, staged, saved>>

Next ==
  \/ \E w \in Writers, t \in Targets : Claim(w, t)
  \/ \E w \in Writers : Publish(w) \/ Crash(w)
  \/ Start
  \/ Stop

Spec == Init /\ [][Next]_vars

ReaderSeesWholeChoice == saved \in Targets
AppliedChoiceIsWhole == running => applied \in Targets
====
