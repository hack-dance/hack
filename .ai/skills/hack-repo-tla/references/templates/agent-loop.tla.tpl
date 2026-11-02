---- MODULE __MODULE_NAME__ ----
EXTENDS Integers

CONSTANT
    \* @type: Int;
    MaxAttempts

VARIABLES
    \* @type: Str;
    phase,
    \* @type: Int;
    attempts,
    \* @type: Bool;
    approved

Vars == <<phase, attempts, approved>>

Init ==
    /\ phase = "idle"
    /\ attempts = 0
    /\ approved = FALSE

Next ==
    \/ /\ phase = "idle"
       /\ phase' = "running"
       /\ attempts' = attempts + 1
       /\ approved' = approved
    \/ /\ phase = "running"
       /\ approved = FALSE
       /\ attempts < MaxAttempts
       /\ phase' = "awaiting_approval"
       /\ attempts' = attempts
       /\ approved' = approved
    \/ /\ phase = "awaiting_approval"
       /\ phase' = "done"
       /\ attempts' = attempts
       /\ approved' = TRUE
    \/ /\ phase = "running"
       /\ attempts = MaxAttempts
       /\ phase' = "failed"
       /\ attempts' = attempts
       /\ approved' = approved
    \/ /\ phase \in {"done", "failed"}
       /\ UNCHANGED Vars

Invariant_TypeOK ==
    /\ phase \in {"idle", "running", "awaiting_approval", "done", "failed"}
    /\ attempts \in 0..MaxAttempts
    /\ approved \in BOOLEAN

Invariant_ApprovedImpliesDone ==
    approved => phase = "done"

Spec == Init /\ [][Next]_Vars

====
