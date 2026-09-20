---- MODULE __MODULE_NAME__ ----
EXTENDS Integers

VARIABLES
    \* @type: Str;
    status,
    \* @type: Int;
    reviewCount

Vars == <<status, reviewCount>>

Init ==
    /\ status = "draft"
    /\ reviewCount = 0

Next ==
    \/ /\ status = "draft"
       /\ status' = "in_review"
       /\ reviewCount' = reviewCount + 1
    \/ /\ status = "in_review"
       /\ status' \in {"approved", "rejected"}
       /\ reviewCount' = reviewCount
    \/ /\ status = "rejected"
       /\ status' = "draft"
       /\ reviewCount' = reviewCount
    \/ /\ status = "approved"
       /\ UNCHANGED Vars

Invariant_TypeOK ==
    /\ status \in {"draft", "in_review", "approved", "rejected"}
    /\ reviewCount \in Nat

Invariant_ApprovedIsTerminal ==
    status = "approved" => reviewCount > 0

Spec == Init /\ [][Next]_Vars

====
