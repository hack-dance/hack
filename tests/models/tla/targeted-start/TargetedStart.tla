---- MODULE TargetedStart ----
EXTENDS Naturals, FiniteSets

CONSTANTS DropIntent, ReplaceExisting
VARIABLES phase, run, receipt, extending, containers, published, started, probes, attempt, free
vars == <<phase, run, receipt, extending, containers, published, started, probes, attempt, free>>

Existing == "web"
Services == {"web", "cache", "redis", "api", "unused"}
Routed == {"web", "redis", "api"}
Selection(i) == IF i = 0 THEN {"cache", "redis"} ELSE {"api"}
Dependencies(s) == IF s = "redis" THEN {"cache"} ELSE {}
OriginalRun == 1

Init == /\ phase = "Ready"
        /\ run = OriginalRun
        /\ receipt = {Existing}
        /\ extending = {}
        /\ containers = [s \in Services |-> IF s = Existing THEN 1 ELSE 0]
        /\ published = {Existing}
        /\ started = {Existing}
        /\ probes = {Existing}
        /\ attempt = 0
        /\ free \in 0..2

Demand == Cardinality((Selection(attempt) \cup published) \cap Routed) - 1
Reserve == /\ phase = "Ready" /\ attempt < 2
           /\ Demand <= free
           /\ phase' = "Extending"
           /\ extending' = Selection(attempt) \cup (IF ReplaceExisting THEN {Existing} ELSE {})
           /\ receipt' = receipt \cup (IF DropIntent THEN extending' \ {"cache"} ELSE extending')
           /\ UNCHANGED <<run, containers, published, started, probes, attempt, free>>

CapacityRefuse == /\ phase = "Ready" /\ attempt < 2 /\ Demand > free
                  /\ attempt' = attempt + 1
                  /\ UNCHANGED <<phase, run, receipt, extending, containers, published, started, probes, free>>

(* A second request during an append or uncertain rollback is refused before intent. *)
RefuseConcurrent == /\ phase \in {"Extending", "Degraded"}
                    /\ UNCHANGED vars

Create(s) == /\ phase = "Extending" /\ s \in extending
             /\ (containers[s] = 0 \/ (ReplaceExisting /\ s = Existing /\ containers[s] = 1))
             /\ Dependencies(s) \subseteq started
             /\ containers' = [containers EXCEPT ![s] = 2]
             /\ UNCHANGED <<phase, run, receipt, extending, published, started, probes, attempt, free>>

Start(s) == /\ phase = "Extending" /\ s \in extending /\ containers[s] = 2
            /\ s \notin started
            /\ started' = started \cup {s}
            /\ UNCHANGED <<phase, run, receipt, extending, containers, published, probes, attempt, free>>

Publish(s) == /\ phase = "Extending" /\ s \in (extending \cap Routed \cap started) \ published
              /\ published' = published \cup {s}
              /\ probes' = probes \cup {s}
              /\ UNCHANGED <<phase, run, receipt, extending, containers, started, attempt, free>>

Commit == /\ phase = "Extending" /\ extending \subseteq started
          /\ extending \cap Routed \subseteq published \cap probes
          /\ phase' = "Ready"
          /\ extending' = {}
          /\ attempt' = attempt + 1
          /\ UNCHANGED <<run, receipt, containers, published, started, probes, free>>

Fail == /\ phase = "Extending" /\ phase' = "Degraded"
        /\ UNCHANGED <<run, receipt, extending, containers, published, started, probes, attempt, free>>

Rollback == /\ phase = "Degraded"
            /\ phase' = "Ready"
            /\ containers' = [s \in Services |-> IF s \in extending THEN 0 ELSE containers[s]]
            /\ receipt' = receipt \ extending
            /\ published' = published \ extending
            /\ started' = started \ extending
            /\ probes' = probes \ extending
            /\ extending' = {}
            /\ attempt' = attempt + 1
            /\ UNCHANGED <<run, free>>

Crash == /\ phase \in {"Extending", "Degraded"} /\ phase' = "Interrupted"
         /\ UNCHANGED <<run, receipt, extending, containers, published, started, probes, attempt, free>>

Reconcile == /\ phase = "Interrupted" /\ phase' = "Reconciled"
             /\ extending' = {}
             /\ UNCHANGED <<run, receipt, containers, published, started, probes, attempt, free>>

Down == /\ phase \in {"Ready", "Extending", "Degraded", "Reconciled"}
        /\ phase' = "Cleaning"
        /\ extending' = {}
        /\ UNCHANGED <<run, receipt, containers, published, started, probes, attempt, free>>

Remove(s) == /\ phase = "Cleaning" /\ s \in receipt /\ containers[s] # 0
             /\ containers' = [containers EXCEPT ![s] = 0]
             /\ published' = published \ {s}
             /\ started' = started \ {s}
             /\ probes' = probes \ {s}
             /\ UNCHANGED <<phase, run, receipt, extending, attempt, free>>

FinishDown == /\ phase = "Cleaning"
              /\ \A s \in receipt : containers[s] = 0
              /\ phase' = "Stopped"
              /\ UNCHANGED <<run, receipt, extending, containers, published, started, probes, attempt, free>>

Next == Reserve \/ CapacityRefuse \/ RefuseConcurrent \/ Commit \/ Fail \/ Rollback \/ Crash \/ Reconcile \/ Down \/ FinishDown
        \/ (\E s \in Services : Create(s) \/ Start(s) \/ Publish(s) \/ Remove(s))

Spec == Init /\ [][Next]_vars

SameRun == run = OriginalRun
PreserveExisting == phase \notin {"Cleaning", "Stopped"}
                    => containers[Existing] = 1 /\ Existing \in published
OnlySelected == containers["unused"] = 0
OwnedEffects == {s \in Services : containers[s] # 0} \subseteq receipt
PublishAfterStart == published \subseteq started
SupervisorSeeded == published \subseteq probes
Capacity == Cardinality(published) <= free + 1
Loadable == phase \in {"Reconciled", "Cleaning", "Stopped"} => extending = {}
DependencyBeforeCreate == phase \notin {"Cleaning", "Stopped"}
                          /\ containers["redis"] # 0 => "cache" \in started
CleanStop == phase = "Stopped" => \A s \in Services : containers[s] = 0
====
