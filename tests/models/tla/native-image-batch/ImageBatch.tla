-------------------------- MODULE ImageBatch --------------------------
EXTENDS Naturals, FiniteSets
CONSTANT AllowParallelImports
Jobs == 1..4
VARIABLES phase, verified, graph, canceled
vars == <<phase, verified, graph, canceled>>
Workers == {j \in Jobs : phase[j] \in {"fetch", "ready", "import"}}
Imports == {j \in Jobs : phase[j] = "import"}
Init ==
    /\ phase = [j \in Jobs |-> "queued"]
    /\ verified = {}
    /\ graph = FALSE
    /\ canceled = FALSE
Fetch(j) ==
    /\ ~canceled /\ phase[j] = "queued" /\ Cardinality(Workers) < 3
    /\ phase' = [phase EXCEPT ![j] = "fetch"]
    /\ UNCHANGED <<verified, graph, canceled>>
Archive(j) ==
    /\ ~canceled /\ phase[j] = "fetch"
    /\ phase' = [phase EXCEPT ![j] = "ready"]
    /\ verified' = verified \cup {j}
    /\ UNCHANGED <<graph, canceled>>
Fail(j) ==
    /\ ~canceled /\ phase[j] \in {"fetch", "import"}
    /\ phase' = [phase EXCEPT ![j] = "failed"]
    /\ UNCHANGED <<verified, graph, canceled>>
Import(j) ==
    /\ ~canceled /\ phase[j] = "ready"
    /\ Imports = {} \/ AllowParallelImports
    /\ phase' = [phase EXCEPT ![j] = "import"]
    /\ UNCHANGED <<verified, graph, canceled>>
Confirm(j) ==
    /\ ~canceled /\ phase[j] = "import"
    /\ phase' = [phase EXCEPT ![j] = "confirmed"]
    /\ UNCHANGED <<verified, graph, canceled>>
Cancel ==
    /\ ~graph /\ ~canceled
    /\ canceled' = TRUE
    /\ phase' = [j \in Jobs |-> CASE phase[j] = "import" -> "unknown"
                                 [] phase[j] \in {"queued", "fetch", "ready"} -> "stopped"
                                 [] OTHER -> phase[j]]
    /\ UNCHANGED <<verified, graph>>
Start ==
    /\ ~graph /\ ~canceled /\ \A j \in Jobs : phase[j] = "confirmed"
    /\ graph' = TRUE
    /\ UNCHANGED <<phase, verified, canceled>>
Stop ==
    /\ canceled \/ graph \/ (Workers = {} /\ \A j \in Jobs : phase[j] # "queued")
    /\ UNCHANGED vars
Next ==
    (\E j \in Jobs : Fetch(j) \/ Archive(j) \/ Fail(j) \/ Import(j) \/ Confirm(j))
    \/ Cancel \/ Start \/ Stop
Spec == Init /\ [][Next]_vars
Safe ==
    /\ Cardinality(Workers) <= 3
    /\ Cardinality(Imports) <= 1
    /\ \A j \in Jobs : phase[j] \in {"ready", "import", "confirmed", "unknown"} => j \in verified
    /\ graph => (\A j \in Jobs : phase[j] = "confirmed")
    /\ canceled => Workers = {} /\ ~graph
=============================================================================
