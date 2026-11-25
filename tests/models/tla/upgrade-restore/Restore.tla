------------------------------ MODULE Restore ------------------------------
\* One upgrade-snapshot target restored by `restoreUpgradeSnapshot`
\* (src/lib/upgrade-snapshot.ts), with a crash allowed after every step.
\* "O" is the snapshot's original, "S" the step output the snapshot recorded
\* as its after state, "E" a user's edit and "none" an empty path. `aside`
\* is the snapshot's displaced/ directory for this target, oldest first.
EXTENDS Naturals, Sequences

\* Resume: a rerun finds the newest displaced file of an empty target.
CONSTANTS Resume

VARIABLES target, aside, phase, expected, force, outcome, edited
vars == <<target, aside, phase, expected, force, outcome, edited>>

Newest == IF aside = <<>> THEN "nil" ELSE aside[Len(aside)]
InAside(c) == \E i \in 1..Len(aside) : aside[i] = c

Init == /\ target = "S" /\ aside = <<>> /\ phase = "idle"
        /\ expected = "none" /\ force = FALSE /\ outcome = "none"
        /\ edited = FALSE

\* restoreStart: the current state decides whether to go on.
Start(f) ==
  /\ phase = "idle"
  /\ force' = f
  /\ CASE target = "O" ->
            /\ outcome' = "already" /\ phase' = "idle"
            /\ UNCHANGED expected
       [] target = "S" ->
            /\ phase' = "checked" /\ expected' = "S"
            /\ outcome' = "none"
       [] target = "none" /\ Resume /\ Newest = "S" ->
            /\ phase' = "checked" /\ expected' = "none"
            /\ outcome' = "none"
       [] f ->
            /\ phase' = "checked" /\ expected' = target
            /\ outcome' = "none"
       [] OTHER ->
            /\ outcome' = "conflict" /\ phase' = "idle"
            /\ UNCHANGED expected
  /\ UNCHANGED <<target, aside, edited>>

\* stageFile plus the hard-link probe: private, never at the target.
Stage == /\ phase = "checked" /\ phase' = "staged"
         /\ UNCHANGED <<target, aside, expected, force, outcome, edited>>

\* displaceTarget: one rename of whatever is there now into displaced/.
Displace ==
  /\ phase = "staged"
  /\ IF target = "none"
       THEN /\ UNCHANGED <<target, aside>>
            /\ IF expected = "none" \/ force
                 THEN phase' = "displaced" /\ UNCHANGED outcome
                 ELSE phase' = "idle" /\ outcome' = "conflict"
       ELSE /\ aside' = Append(aside, target) /\ target' = "none"
            /\ phase' = IF target = expected \/ force
                          THEN "displaced" ELSE "linkback"
            /\ UNCHANGED outcome
  /\ UNCHANGED <<expected, force, edited>>

\* lateEditBack: a late edit is linked back unless the name was taken.
LinkBack ==
  /\ phase = "linkback" /\ phase' = "idle" /\ outcome' = "conflict"
  /\ IF target = "none"
       THEN target' = Newest /\ aside' = SubSeq(aside, 1, Len(aside) - 1)
       ELSE UNCHANGED <<target, aside>>
  /\ UNCHANGED <<expected, force, edited>>

\* publishStaged: a hard link, refused when anything took the name.
Publish ==
  /\ phase = "displaced" /\ phase' = "idle"
  /\ IF target = "none"
       THEN target' = "O" /\ outcome' = "restored"
       ELSE UNCHANGED target /\ outcome' = "conflict"
  /\ UNCHANGED <<aside, expected, force, edited>>

\* SIGKILL at any boundary: on-disk state stays, the invocation is gone.
Crash == /\ phase # "idle" /\ phase' = "idle" /\ outcome' = "crashed"
         /\ UNCHANGED <<target, aside, expected, force, edited>>

\* One user write at the path, at any time (a concurrent editor). `outcome`
\* is what the last restore step left, so a later write clears it.
UserEdit == /\ ~edited /\ edited' = TRUE /\ target' = "E"
            /\ outcome' = "none"
            /\ UNCHANGED <<aside, phase, expected, force>>

Next == \/ \E f \in BOOLEAN : Start(f)
        \/ Stage \/ Displace \/ LinkBack \/ Publish \/ Crash \/ UserEdit
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ target \in {"O", "S", "E", "none"}
  /\ aside \in Seq({"S", "E"}) /\ Len(aside) <= 2
  /\ phase \in {"idle", "checked", "staged", "displaced", "linkback"}
  /\ expected \in {"S", "E", "none"}
  /\ force \in BOOLEAN
  /\ outcome \in {"none", "already", "restored", "conflict", "crashed"}
  /\ edited \in BOOLEAN

\* Nothing is deleted: a user's edit is at the path or kept in the snapshot.
EditKept == edited => (target = "E" \/ InAside("E"))
\* The step's output is kept unless the user replaced it.
StepOutputKept == target = "S" \/ InAside("S") \/ edited
RestoredIsOriginal == outcome = "restored" => target = "O"
\* HACK-2188: a plain rerun never refuses a restore that was only interrupted
\* after moving the step's output aside.
InterruptedRestoreResumes ==
  (phase = "idle" /\ outcome = "conflict" /\ ~force)
    => ~(target = "none" /\ Newest = "S")
=============================================================================
