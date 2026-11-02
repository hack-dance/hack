---- MODULE __MODULE_NAME__ ----
EXTENDS Sequences

CONSTANT
    \* @type: Set(Str);
    Jobs

VARIABLES
    \* @type: Seq(Str);
    queued,
    \* @type: Set(Str);
    active,
    \* @type: Set(Str);
    done

Vars == <<queued, active, done>>

Init ==
    /\ queued = <<>>
    /\ active = {}
    /\ done = {}

Enqueue(job) ==
    /\ job \in Jobs
    /\ job \notin active
    /\ job \notin done
    /\ queued' = Append(queued, job)
    /\ UNCHANGED <<active, done>>

Start ==
    /\ Len(queued) > 0
    /\ LET head == Head(queued) IN
       /\ queued' = Tail(queued)
       /\ active' = active \cup {head}
       /\ UNCHANGED done

Complete(job) ==
    /\ job \in active
    /\ active' = active \ {job}
    /\ done' = done \cup {job}
    /\ UNCHANGED queued

Next ==
    \/ \E job \in Jobs: Enqueue(job)
    \/ Start
    \/ \E job \in active: Complete(job)

Invariant_TypeOK ==
    /\ queued \in Seq(Jobs)
    /\ active \subseteq Jobs
    /\ done \subseteq Jobs

Invariant_NoActiveDoneOverlap ==
    active \cap done = {}

Spec == Init /\ [][Next]_Vars

====
