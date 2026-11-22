---------------- MODULE PerServicePublication ----------------
EXTENDS FiniteSets
CONSTANT UnsafeRecord
Services == {"first", "second"}
VARIABLES ready, intents, listening, recorded, phase, foreign
vars == <<ready, intents, listening, recorded, phase, foreign>>

Init == /\ ready = {} /\ intents = {} /\ listening = {} /\ recorded = {}
        /\ phase = "starting" /\ foreign = TRUE
Ready(s) == /\ phase = "starting" /\ s \notin ready
            /\ ready' = ready \cup {s}
            /\ UNCHANGED <<intents, listening, recorded, phase, foreign>>
Admit(s) == /\ phase = "starting" /\ s \in ready \ intents
            /\ intents' = intents \cup {s}
            /\ UNCHANGED <<ready, listening, recorded, phase, foreign>>
Connect(s) == /\ phase = "starting" /\ s \in intents \ listening
              /\ listening' = listening \cup {s}
              /\ UNCHANGED <<ready, intents, recorded, phase, foreign>>
Record(s) == /\ phase = "starting" /\ s \in intents \ recorded
             /\ UnsafeRecord \/ s \in listening
             /\ recorded' = recorded \cup {s}
             /\ UNCHANGED <<ready, intents, listening, phase, foreign>>
Finish == /\ phase = "starting" /\ recorded = Services
          /\ phase' = "ready"
          /\ UNCHANGED <<ready, intents, listening, recorded, foreign>>
Abort(reason) == /\ phase = "starting"
                 /\ phase' = reason
                 /\ UNCHANGED <<ready, intents, listening, recorded, foreign>>
Retire(s) == /\ phase \in {"failed", "cancelled", "dead"} /\ s \in intents
             /\ listening' = listening \ {s}
             /\ recorded' = recorded \ {s}
             /\ intents' = intents \ {s}
             /\ UNCHANGED <<ready, phase, foreign>>
Settled == /\ phase \in {"failed", "cancelled", "dead"} /\ intents = {}
           /\ phase' = "retired"
           /\ UNCHANGED <<ready, intents, listening, recorded, foreign>>
Next == \/ \E s \in Services : Ready(s) \/ Admit(s) \/ Connect(s) \/ Record(s) \/ Retire(s)
        \/ \E reason \in {"failed", "cancelled", "dead"} : Abort(reason)
        \/ Finish \/ Settled
Safe == /\ recorded \subseteq listening
        /\ listening \subseteq intents
        /\ intents \subseteq ready
        /\ phase = "ready" => recorded = Services
        /\ phase = "retired" => listening = {}
        /\ foreign
Spec == Init /\ [][Next]_vars
===============================================================
