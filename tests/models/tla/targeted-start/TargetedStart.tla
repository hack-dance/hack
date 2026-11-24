---- MODULE TargetedStart ----
EXTENDS FiniteSets

CONSTANTS DropIntent, ReplaceExisting
VARIABLES phase, run, receipt, containers, published, started
vars == <<phase, run, receipt, containers, published, started>>

Existing == "web"
Selected == {"cache", "redis"}
Services == Selected \cup {Existing, "unused"}
Dependencies == [s \in Selected |-> IF s = "redis" THEN {"cache"} ELSE {}]
OriginalRun == 1

Init == /\ phase = "Ready"
        /\ run = OriginalRun
        /\ receipt = {Existing}
        /\ containers = [s \in Services |-> IF s = Existing THEN 1 ELSE 0]
        /\ published = {Existing}
        /\ started = {Existing}

Reserve == /\ phase = "Ready" /\ receipt = {Existing}
           /\ phase' = "Extending"
           /\ receipt' = receipt \cup (IF DropIntent THEN {"redis"} ELSE Selected)
           /\ containers' = IF ReplaceExisting THEN [containers EXCEPT ![Existing] = 2] ELSE containers
           /\ UNCHANGED <<run, published, started>>

Create(s) == /\ phase = "Extending" /\ containers[s] = 0
             /\ Dependencies[s] \subseteq started
             /\ containers' = [containers EXCEPT ![s] = 2]
             /\ UNCHANGED <<phase, run, receipt, published, started>>

Start(s) == /\ phase = "Extending" /\ containers[s] = 2 /\ s \notin started
            /\ started' = started \cup {s}
            /\ UNCHANGED <<phase, run, receipt, containers, published>>

Publish(s) == /\ phase = "Extending" /\ s \in started \ published
              /\ published' = published \cup {s}
              /\ UNCHANGED <<phase, run, receipt, containers, started>>

Commit == /\ phase = "Extending" /\ Selected \subseteq published
          /\ phase' = "Ready"
          /\ UNCHANGED <<run, receipt, containers, published, started>>

Crash == /\ phase = "Extending" /\ phase' = "Interrupted"
         /\ UNCHANGED <<run, receipt, containers, published, started>>

Down == /\ phase \in {"Ready", "Interrupted"} /\ phase' = "Cleaning"
        /\ UNCHANGED <<run, receipt, containers, published, started>>

Remove(s) == /\ phase = "Cleaning" /\ s \in receipt /\ containers[s] # 0
             /\ containers' = [containers EXCEPT ![s] = 0]
             /\ published' = published \ {s}
             /\ started' = started \ {s}
             /\ UNCHANGED <<phase, run, receipt>>

FinishDown == /\ phase = "Cleaning"
              /\ \A s \in receipt : containers[s] = 0
              /\ phase' = "Stopped"
              /\ UNCHANGED <<run, receipt, containers, published, started>>

Next == Reserve \/ Commit \/ Crash \/ Down \/ FinishDown
        \/ (\E s \in Selected : Create(s) \/ Start(s) \/ Publish(s))
        \/ (\E s \in Services : Remove(s))

Spec == Init /\ [][Next]_vars

SameRun == run = OriginalRun
PreserveExisting == phase \in {"Ready", "Extending", "Interrupted"}
                    => containers[Existing] = 1 /\ Existing \in published
OnlySelected == containers["unused"] = 0
OwnedEffects == {s \in Services : containers[s] # 0} \subseteq receipt
PublishAfterStart == published \subseteq started
DependencyBeforeCreate == phase \in {"Ready", "Extending", "Interrupted"}
                          /\ containers["redis"] # 0 => "cache" \in started
CleanStop == phase = "Stopped" => \A s \in Services : containers[s] = 0
====
