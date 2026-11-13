------------------------------ MODULE Session ------------------------------
EXTENDS Naturals, TLC
CONSTANTS Replay, RetireOnEOF, WrongBoot, RetireOnFailedInspect
VARIABLES exitedValidated, inspectFailed, stage, intent, recorded, starts, capable, boot, stopped, absent, ended, replacementStopped
vars == <<exitedValidated, inspectFailed, stage, intent, recorded, starts, capable, boot, stopped, absent, ended, replacementStopped>>
Init == /\ exitedValidated = FALSE /\ inspectFailed = FALSE
        /\ stage = "new" /\ intent = FALSE /\ recorded = FALSE
        /\ starts = 0 /\ capable = TRUE /\ boot = "original"
        /\ stopped = FALSE /\ absent = FALSE /\ ended = FALSE /\ replacementStopped = FALSE
TypeOK == /\ exitedValidated \in BOOLEAN /\ inspectFailed \in BOOLEAN
          /\ stage \in {"new", "admitted", "created", "recorded", "started", "attached", "ended", "abandoned", "retired", "withdrawn"}
          /\ intent \in BOOLEAN /\ recorded \in BOOLEAN /\ capable \in BOOLEAN
          /\ starts \in 0..2 /\ boot \in {"original", "replacement"}
          /\ stopped \in BOOLEAN /\ absent \in BOOLEAN /\ ended \in BOOLEAN /\ replacementStopped \in BOOLEAN
Admit == /\ stage = "new" /\ capable /\ ~stopped /\ ~absent /\ boot = "original"
         /\ intent' = TRUE /\ stage' = "admitted"
         /\ UNCHANGED <<exitedValidated, inspectFailed, recorded, starts, capable, boot, stopped, absent, ended, replacementStopped>>
Create == /\ stage = "admitted" /\ capable /\ ~stopped /\ ~absent /\ boot = "original"
          /\ stage' = "created"
          /\ UNCHANGED <<exitedValidated, inspectFailed, intent, recorded, starts, capable, boot, stopped, absent, ended, replacementStopped>>
\* Known refusal before dispatch may withdraw only the live capability.
Withdraw == /\ stage = "admitted" /\ capable /\ stage' = "withdrawn"
            /\ intent' = FALSE /\ capable' = FALSE
            /\ UNCHANGED <<exitedValidated, inspectFailed, recorded, starts, boot, stopped, absent, ended, replacementStopped>>
Record == /\ stage = "created" /\ capable
          /\ recorded' = TRUE /\ stage' = "recorded"
          /\ UNCHANGED <<exitedValidated, inspectFailed, intent, starts, capable, boot, stopped, absent, ended, replacementStopped>>
Start == /\ stage = "recorded" /\ capable /\ ~stopped /\ ~absent /\ boot = "original"
         /\ starts' = starts + 1 /\ stage' = "started" /\ capable' = FALSE
         /\ UNCHANGED <<exitedValidated, inspectFailed, intent, recorded, boot, stopped, absent, ended, replacementStopped>>
Attach == /\ stage = "started" /\ stage' = "attached"
          /\ UNCHANGED <<exitedValidated, inspectFailed, intent, recorded, starts, capable, boot, stopped, absent, ended, replacementStopped>>
EOF == /\ stage \in {"started", "attached"} /\ ended' = TRUE /\ stage' = "ended"
       /\ UNCHANGED <<exitedValidated, inspectFailed, intent, recorded, starts, capable, boot, stopped, absent, replacementStopped>>
Crash == /\ stage \notin {"new", "abandoned", "retired", "withdrawn"}
         /\ stage' = "abandoned" /\ capable' = FALSE
         /\ UNCHANGED <<exitedValidated, inspectFailed, intent, recorded, starts, boot, stopped, absent, ended, replacementStopped>>
\* Exact-boot proof is durable and survives later boot replacement.
StopBoot == /\ boot = "original" /\ ~stopped /\ stopped' = TRUE
            /\ UNCHANGED <<exitedValidated, inspectFailed, stage, intent, recorded, starts, capable, boot, absent, ended, replacementStopped>>
RemoveContainer == /\ ~absent /\ boot = "original" /\ absent' = TRUE
                   /\ UNCHANGED <<exitedValidated, inspectFailed, stage, intent, recorded, starts, capable, boot, stopped, ended, replacementStopped>>
\* Changed boot alone grants no cleanup proof, even when the new Engine says 404.
ReplaceBoot == /\ boot = "original" /\ boot' = "replacement"
               /\ UNCHANGED <<exitedValidated, inspectFailed, stage, intent, recorded, starts, capable, stopped, absent, ended, replacementStopped>>
Retire == /\ intent /\ stage # "retired" /\ (stopped \/ absent \/ exitedValidated \/ (RetireOnFailedInspect /\ inspectFailed) \/ (RetireOnEOF /\ ended) \/ (WrongBoot /\ replacementStopped))
          /\ stage' = "retired" /\ capable' = FALSE
          /\ UNCHANGED <<exitedValidated, inspectFailed, intent, recorded, starts, boot, stopped, absent, ended, replacementStopped>>
ReplayStart == /\ Replay /\ stage = "abandoned" /\ recorded /\ starts = 1
               /\ stage' = "started" /\ starts' = 2
               /\ UNCHANGED <<exitedValidated, inspectFailed, intent, recorded, capable, boot, stopped, absent, ended, replacementStopped>>
StopReplacement == /\ boot = "replacement" /\ ~replacementStopped /\ replacementStopped' = TRUE
                   /\ UNCHANGED <<exitedValidated, inspectFailed, stage, intent, recorded, starts, capable, boot, stopped, absent, ended>>
\* Engine inspection validates exact exec/container identity, generation, boot
\* and a non-running exec with exit code 0..255. No descendant claim is made.
ExecExitedValidated ==
    /\ recorded /\ starts = 1 /\ boot = "original" /\ ~exitedValidated
    /\ exitedValidated' = TRUE
    /\ UNCHANGED <<inspectFailed, stage, intent, recorded, starts, capable, boot, stopped, absent, ended, replacementStopped>>
InspectFailed ==
    /\ recorded /\ ~inspectFailed /\ ~exitedValidated
    /\ inspectFailed' = TRUE
    /\ UNCHANGED <<exitedValidated, stage, intent, recorded, starts, capable, boot, stopped, absent, ended, replacementStopped>>
Next == ExecExitedValidated \/ InspectFailed \/ Admit \/ Create \/ Withdraw \/ Record \/ Start \/ Attach \/ EOF \/ Crash \/ StopBoot \/ RemoveContainer \/ ReplaceBoot \/ StopReplacement \/ Retire \/ ReplayStart
Spec == Init /\ [][Next]_vars
WriteAhead == starts > 0 => intent /\ recorded
NoReplay == starts <= 1
RetiredWithProof == stage = "retired" => stopped \/ absent \/ exitedValidated
=============================================================================
