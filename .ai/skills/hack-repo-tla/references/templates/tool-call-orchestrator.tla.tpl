---- MODULE __MODULE_NAME__ ----
EXTENDS Sequences, FiniteSets

CONSTANT
    \* @type: Set(Str);
    ToolNames

VARIABLES
    \* @type: Seq(Str);
    pending,
    \* @type: Set(Str);
    inflight,
    \* @type: Set(Str);
    completed

Vars == <<pending, inflight, completed>>

Init ==
    /\ pending = <<>>
    /\ inflight = {}
    /\ completed = {}

Enqueue(tool) ==
    /\ tool \in ToolNames
    /\ tool \notin inflight
    /\ tool \notin completed
    /\ pending' = Append(pending, tool)
    /\ UNCHANGED <<inflight, completed>>

Dispatch ==
    /\ Len(pending) > 0
    /\ LET head == Head(pending) IN
       /\ pending' = Tail(pending)
       /\ inflight' = inflight \cup {head}
       /\ UNCHANGED completed

Finish(tool) ==
    /\ tool \in inflight
    /\ inflight' = inflight \ {tool}
    /\ completed' = completed \cup {tool}
    /\ UNCHANGED pending

Next ==
    \/ \E tool \in ToolNames: Enqueue(tool)
    \/ Dispatch
    \/ \E tool \in inflight: Finish(tool)

Invariant_TypeOK ==
    /\ pending \in Seq(ToolNames)
    /\ inflight \subseteq ToolNames
    /\ completed \subseteq ToolNames

Invariant_NoOverlap ==
    inflight \cap completed = {}

Spec == Init /\ [][Next]_Vars

====
