------------------------------ MODULE Session ------------------------------
EXTENDS Naturals, TLC
CONSTANTS Replay, RetireOnEOF, WrongBoot
VARIABLES stage, intent, recorded, starts, capable, boot, stopped, absent, ended, replacementStopped
vars == <<stage, intent, recorded, starts, capable, boot, stopped, absent, ended, replacementStopped>>
Init == /\ stage = "new" /\ intent = FALSE /\ recorded = FALSE
        /\ starts = 0 /\ capable = TRUE /\ boot = "original"
        /\ stopped = FALSE /\ absent = FALSE /\ ended = FALSE /\ replacementStopped = FALSE
TypeOK == /\ stage \in {"new", "admitted", "created", "recorded", "started", "attached", "ended", "abandoned", "retired", "withdrawn"}
          /\ intent \in BOOLEAN /\ recorded \in BOOLEAN /\ capable \in BOOLEAN
          /\ starts \in 0..2 /\ boot \in {"original", "replacement"}
          /\ stopped \in BOOLEAN /\ absent \in BOOLEAN /\ ended \in BOOLEAN /\ replacementStopped \in BOOLEAN
Admit == /\ stage = "new" /\ capable /\ ~stopped /\ ~absent /\ boot = "original"
         /\ intent' = TRUE /\ stage' = "admitted"
         /\ UNCHANGED <<recorded, starts, capable, boot, stopped, absent, ended, replacementStopped>>
Create == /\ stage = "admitted" /\ capable /\ ~stopped /\ ~absent /\ boot = "original"
          /\ stage' = "created"
          /\ UNCHANGED <<intent, recorded, starts, capable, boot, stopped, absent, ended, replacementStopped>>
\* Known refusal before dispatch may withdraw only the live capability.
Withdraw == /\ stage = "admitted" /\ capable /\ stage' = "withdrawn"
            /\ intent' = FALSE /\ capable' = FALSE
            /\ UNCHANGED <<recorded, starts, boot, stopped, absent, ended, replacementStopped>>
Record == /\ stage = "created" /\ capable
          /\ recorded' = TRUE /\ stage' = "recorded"
          /\ UNCHANGED <<intent, starts, capable, boot, stopped, absent, ended, replacementStopped>>
Start == /\ stage = "recorded" /\ capable /\ ~stopped /\ ~absent /\ boot = "original"
         /\ starts' = starts + 1 /\ stage' = "started" /\ capable' = FALSE
         /\ UNCHANGED <<intent, recorded, boot, stopped, absent, ended, replacementStopped>>
Attach == /\ stage = "started" /\ stage' = "attached"
          /\ UNCHANGED <<intent, recorded, starts, capable, boot, stopped, absent, ended, replacementStopped>>
EOF == /\ stage \in {"started", "attached"} /\ ended' = TRUE /\ stage' = "ended"
       /\ UNCHANGED <<intent, recorded, starts, capable, boot, stopped, absent, replacementStopped>>
Crash == /\ stage \notin {"new", "abandoned", "retired", "withdrawn"}
         /\ stage' = "abandoned" /\ capable' = FALSE
         /\ UNCHANGED <<intent, recorded, starts, boot, stopped, absent, ended, replacementStopped>>
\* Exact-boot proof is durable and survives later boot replacement.
StopBoot == /\ boot = "original" /\ ~stopped /\ stopped' = TRUE
            /\ UNCHANGED <<stage, intent, recorded, starts, capable, boot, absent, ended, replacementStopped>>
RemoveContainer == /\ ~absent /\ boot = "original" /\ absent' = TRUE
                   /\ UNCHANGED <<stage, intent, recorded, starts, capable, boot, stopped, ended, replacementStopped>>
\* Changed boot alone grants no cleanup proof, even when the new Engine says 404.
ReplaceBoot == /\ boot = "original" /\ boot' = "replacement"
               /\ UNCHANGED <<stage, intent, recorded, starts, capable, stopped, absent, ended, replacementStopped>>
Retire == /\ intent /\ stage # "retired" /\ (stopped \/ absent \/ (RetireOnEOF /\ ended) \/ (WrongBoot /\ replacementStopped))
          /\ stage' = "retired" /\ capable' = FALSE
          /\ UNCHANGED <<intent, recorded, starts, boot, stopped, absent, ended, replacementStopped>>
ReplayStart == /\ Replay /\ stage = "abandoned" /\ recorded /\ starts = 1
               /\ stage' = "started" /\ starts' = 2
               /\ UNCHANGED <<intent, recorded, capable, boot, stopped, absent, ended, replacementStopped>>
StopReplacement == /\ boot = "replacement" /\ ~replacementStopped /\ replacementStopped' = TRUE
                   /\ UNCHANGED <<stage, intent, recorded, starts, capable, boot, stopped, absent, ended>>
Next == Admit \/ Create \/ Withdraw \/ Record \/ Start \/ Attach \/ EOF \/ Crash \/ StopBoot \/ RemoveContainer \/ ReplaceBoot \/ StopReplacement \/ Retire \/ ReplayStart
Spec == Init /\ [][Next]_vars
WriteAhead == starts > 0 => intent /\ recorded
NoReplay == starts <= 1
RetiredWithProof == stage = "retired" => stopped \/ absent
=============================================================================
