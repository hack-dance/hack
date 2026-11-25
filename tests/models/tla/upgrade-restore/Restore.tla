------------------------------ MODULE Restore ------------------------------
\* One upgrade-snapshot target restored by `restoreUpgradeSnapshot`
\* (src/lib/upgrade-snapshot.ts), with a crash allowed after every step.
\* "O" is the snapshot's original, "S" the step output the snapshot recorded
\* as its after state, "E" a user's edit and "none" an empty path. `aside`
\* is the snapshot's displaced/ directory for this target, oldest first;
\* its first `consumed` files have lost their key and are never adopted.
EXTENDS Naturals, Sequences

\* Resume: a rerun finds the newest keyed displaced file of an empty target.
\* Consume: once the path holds the original, every keyed file loses its key.
CONSTANTS Resume, Consume

VARIABLES target, aside, consumed, phase, expected, force, outcome, edited,
          deleted, done, emptied
vars == <<target, aside, consumed, phase, expected, force, outcome, edited,
          deleted, done, emptied>>

\* newestDisplaced: only keyed files count.
NewestLive == IF Len(aside) > consumed THEN aside[Len(aside)] ELSE "nil"
InAside(c) == \E i \in 1..Len(aside) : aside[i] = c
\* consumeDisplaced: drop the key from every displaced file of the target.
ConsumeAll == consumed' = IF Consume THEN Len(aside) ELSE consumed

Init == /\ target = "S" /\ aside = <<>> /\ consumed = 0 /\ phase = "idle"
        /\ expected = "none" /\ force = FALSE /\ outcome = "none"
        /\ edited = FALSE /\ deleted = "no" /\ done = FALSE
        /\ emptied = FALSE

\* restoreStart: the current state decides whether to go on. An
\* already-restored target settles its displaced files (settleDisplaced);
\* `done` records that a restore has completed for the user.
Start(f) ==
  /\ phase = "idle"
  /\ force' = f
  /\ CASE target = "O" ->
            /\ outcome' = "already" /\ phase' = "idle"
            /\ ConsumeAll /\ done' = TRUE
            /\ UNCHANGED expected
       [] target = "S" ->
            /\ phase' = "checked" /\ expected' = "S"
            /\ outcome' = "none" /\ UNCHANGED <<consumed, done>>
       [] target = "none" /\ Resume /\ NewestLive = "S" ->
            /\ phase' = "checked" /\ expected' = "none"
            /\ outcome' = "none" /\ UNCHANGED <<consumed, done>>
       [] f ->
            /\ phase' = "checked" /\ expected' = target
            /\ outcome' = "none" /\ UNCHANGED <<consumed, done>>
       [] OTHER ->
            /\ outcome' = "conflict" /\ phase' = "idle"
            /\ UNCHANGED <<expected, consumed, done>>
  /\ UNCHANGED <<target, aside, edited, deleted, emptied>>

\* stageFile plus the hard-link probe: private, never at the target.
Stage == /\ phase = "checked" /\ phase' = "staged"
         /\ UNCHANGED <<target, aside, consumed, expected, force, outcome,
                        edited, deleted, done, emptied>>

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
  /\ UNCHANGED <<consumed, expected, force, edited, deleted, done, emptied>>

\* lateEditBack: a late edit is linked back unless the name was taken.
LinkBack ==
  /\ phase = "linkback" /\ phase' = "idle" /\ outcome' = "conflict"
  /\ IF target = "none"
       THEN target' = aside[Len(aside)]
            /\ aside' = SubSeq(aside, 1, Len(aside) - 1)
       ELSE UNCHANGED <<target, aside>>
  /\ UNCHANGED <<consumed, expected, force, edited, deleted, done, emptied>>

\* publishStaged: a hard link, refused when anything took the name.
Publish ==
  /\ phase = "displaced"
  /\ IF target = "none"
       THEN target' = "O" /\ outcome' = "restored" /\ phase' = "settling"
       ELSE UNCHANGED target /\ outcome' = "conflict" /\ phase' = "idle"
  /\ UNCHANGED <<aside, consumed, expected, force, edited, deleted, done,
                 emptied>>

\* settleDisplaced after a publication: the restore returns `restored`.
Settle ==
  /\ phase = "settling" /\ phase' = "idle"
  /\ ConsumeAll /\ done' = TRUE
  /\ UNCHANGED <<target, aside, expected, force, outcome, edited, deleted,
                 emptied>>

\* SIGKILL at any boundary: on-disk state stays, the invocation is gone.
Crash == /\ phase # "idle" /\ phase' = "idle" /\ outcome' = "crashed"
         /\ UNCHANGED <<target, aside, consumed, expected, force, edited,
                        deleted, done, emptied>>

\* One user write at the path, at any time (a concurrent editor). `outcome`
\* is what the last restore step left, so a later write clears it.
UserEdit == /\ ~edited /\ edited' = TRUE /\ target' = "E"
            /\ outcome' = "none"
            /\ UNCHANGED <<aside, consumed, phase, expected, force, deleted,
                           done, emptied>>

\* One user deletion of whatever is at the path, at any time. `emptied`
\* records a deletion after a restore had completed.
UserDelete == /\ deleted = "no" /\ target # "none"
              /\ deleted' = target /\ target' = "none"
              /\ emptied' = done /\ outcome' = "none"
              /\ UNCHANGED <<aside, consumed, phase, expected, force, edited,
                             done>>

Next == \/ \E f \in BOOLEAN : Start(f)
        \/ Stage \/ Displace \/ LinkBack \/ Publish \/ Settle \/ Crash
        \/ UserEdit \/ UserDelete
Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ target \in {"O", "S", "E", "none"}
  /\ aside \in Seq({"S", "E"}) /\ Len(aside) <= 2
  /\ consumed \in 0..Len(aside)
  /\ phase \in {"idle", "checked", "staged", "displaced", "linkback",
                "settling"}
  /\ expected \in {"S", "E", "none"}
  /\ force \in BOOLEAN
  /\ outcome \in {"none", "already", "restored", "conflict", "crashed"}
  /\ edited \in BOOLEAN
  /\ deleted \in {"no", "O", "S", "E"}
  /\ done \in BOOLEAN
  /\ emptied \in BOOLEAN

\* Nothing is deleted: a user's edit is at the path or kept in the snapshot,
\* unless the user deleted it.
EditKept == edited => (target = "E" \/ InAside("E") \/ deleted = "E")
\* The step's output is kept unless the user replaced or deleted it.
StepOutputKept == target = "S" \/ InAside("S") \/ edited \/ deleted = "S"
RestoredIsOriginal == outcome = "restored" => target = "O"
\* HACK-2188: a plain rerun never refuses a restore that was only interrupted
\* after moving the step's output aside.
InterruptedRestoreResumes ==
  (phase = "idle" /\ outcome = "conflict" /\ ~force)
    => ~(target = "none" /\ NewestLive = "S")
\* HACK-2188 review: once a restore has completed, a plain rerun never
\* recreates a path the user emptied; only `overwrite` restores it.
DeletionKept == (emptied /\ outcome = "restored") => force
=============================================================================
