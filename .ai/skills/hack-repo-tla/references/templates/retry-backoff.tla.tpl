---- MODULE __MODULE_NAME__ ----
EXTENDS Integers

CONSTANT
    \* @type: Int;
    MaxRetries

VARIABLES
    \* @type: Str;
    phase,
    \* @type: Int;
    attempt,
    \* @type: Int;
    waitSlots

Vars == <<phase, attempt, waitSlots>>

Init ==
    /\ phase = "ready"
    /\ attempt = 0
    /\ waitSlots = 0

Next ==
    \/ /\ phase = "ready"
       /\ phase' = "waiting"
       /\ attempt' = attempt + 1
       /\ waitSlots' = attempt + 1
    \/ /\ phase = "waiting"
       /\ waitSlots > 0
       /\ phase' = "waiting"
       /\ attempt' = attempt
       /\ waitSlots' = waitSlots - 1
    \/ /\ phase = "waiting"
       /\ waitSlots = 0
       /\ phase' \in {"ready", "succeeded", "failed"}
       /\ attempt' = attempt
       /\ waitSlots' = waitSlots
    \/ /\ phase \in {"succeeded", "failed"}
       /\ UNCHANGED Vars

Invariant_TypeOK ==
    /\ phase \in {"ready", "waiting", "succeeded", "failed"}
    /\ attempt \in 0..(MaxRetries + 1)
    /\ waitSlots \in Nat

Invariant_FailedOnlyAfterBudget ==
    phase = "failed" => attempt > MaxRetries

Spec == Init /\ [][Next]_Vars

====
