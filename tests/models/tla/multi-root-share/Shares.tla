------------------------------ MODULE Shares ------------------------------
(* One development pool hosts several project roots. The share set is the     *)
(* pool's mount intent: it changes only through a journaled stopped-pool       *)
(* update (provider record first, then owner receipt), boot mounts exactly the *)
(* audited set, each graph binds only its own root's share, and a share stays  *)
(* while any graph of that project is live or retained.                        *)
EXTENDS Naturals, FiniteSets
CONSTANTS Projects, Primary, MaxShares,
          EnforceFence, EnforceOrder, EnforceOwnShare, EnforceUnreferenced
VARIABLES phase, ownerSet, recordSet, journal, mounted, graph, bound
vars == <<phase, ownerSet, recordSet, journal, mounted, graph, bound>>
None == "none"
Ops == {"add", "remove"}
\* An absent journal is the idle record, so every journal value is comparable.
Idle == [op |-> "idle", p |-> Primary]
Journals == {Idle} \cup [op : Ops, p : Projects]
Apply(set, j) == IF j.op = "add" THEN set \cup {j.p} ELSE set \ {j.p}

Init == /\ phase = "stopped" /\ ownerSet = {Primary} /\ recordSet = {Primary}
        /\ journal = Idle /\ mounted = {}
        /\ graph = [p \in Projects |-> "none"] /\ bound = [p \in Projects |-> None]

\* Startup and source admission refuse while a journal exists (require_complete),
\* and boot audits owner receipt against the provider record (config_audit).
Boot == /\ phase = "stopped"
        /\ (EnforceFence => (journal = Idle /\ ownerSet = recordSet))
        /\ phase' = "running" /\ mounted' = recordSet
        /\ UNCHANGED <<ownerSet, recordSet, journal, graph, bound>>
\* Stopping keeps graph receipts as retained data; no mount survives.
Stop == /\ phase = "running"
        /\ phase' = "stopped" /\ mounted' = {}
        /\ graph' = [p \in Projects |-> IF graph[p] = "live" THEN "retained" ELSE graph[p]]
        /\ UNCHANGED <<ownerSet, recordSet, journal, bound>>
\* The stopped update plans one add or remove (share_update::plan).
BeginAdd(p) == /\ phase = "stopped" /\ journal = Idle /\ p \notin ownerSet
               /\ Cardinality(ownerSet) < MaxShares
               /\ journal' = [op |-> "add", p |-> p]
               /\ UNCHANGED <<phase, ownerSet, recordSet, mounted, graph, bound>>
BeginRemove(p) == /\ phase = "stopped" /\ journal = Idle /\ p \in ownerSet
                  /\ p # Primary
                  /\ (EnforceUnreferenced => graph[p] = "none")
                  /\ journal' = [op |-> "remove", p |-> p]
                  /\ UNCHANGED <<phase, ownerSet, recordSet, mounted, graph, bound>>
CommitRecord == /\ phase = "stopped" /\ journal # Idle
                /\ recordSet = ownerSet
                /\ recordSet' = Apply(recordSet, journal)
                /\ UNCHANGED <<phase, ownerSet, journal, mounted, graph, bound>>
CommitOwner == /\ phase = "stopped" /\ journal # Idle
               /\ ownerSet # Apply(ownerSet, journal)
               /\ (EnforceOrder => recordSet = Apply(ownerSet, journal))
               /\ ownerSet' = Apply(ownerSet, journal)
               /\ UNCHANGED <<phase, recordSet, journal, mounted, graph, bound>>
Finish == /\ journal # Idle
          /\ ownerSet = recordSet /\ ownerSet = Apply(ownerSet, journal)
          /\ journal' = Idle
          /\ UNCHANGED <<phase, ownerSet, recordSet, mounted, graph, bound>>
\* A graph selects the share whose root equals its reviewed source.
StartGraph(p, s) == /\ phase = "running" /\ graph[p] \in {"none", "retained"}
                    /\ s \in mounted
                    /\ (EnforceOwnShare => s = p)
                    /\ graph' = [graph EXCEPT ![p] = "live"]
                    /\ bound' = [bound EXCEPT ![p] = s]
                    /\ UNCHANGED <<phase, ownerSet, recordSet, journal, mounted>>
\* Cleanup acts on one run's own labelled resources only.
CleanGraph(p) == /\ graph[p] # "none"
                 /\ graph' = [graph EXCEPT ![p] = "none"]
                 /\ bound' = [bound EXCEPT ![p] = None]
                 /\ UNCHANGED <<phase, ownerSet, recordSet, journal, mounted>>

Next == \/ Boot \/ Stop \/ CommitRecord \/ CommitOwner \/ Finish
        \/ \E p \in Projects : BeginAdd(p) \/ BeginRemove(p) \/ CleanGraph(p)
        \/ \E p, s \in Projects : StartGraph(p, s)
Spec == Init /\ [][Next]_vars

TypeOK == /\ phase \in {"stopped", "running"}
          /\ ownerSet \subseteq Projects /\ recordSet \subseteq Projects
          /\ mounted \subseteq Projects /\ journal \in Journals
          /\ graph \in [Projects -> {"none", "live", "retained"}]
          /\ bound \in [Projects -> Projects \cup {None}]
\* A running pool's mounts are exactly the audited, unchanging share set.
RunningMountsAudited == phase = "running" =>
                          (mounted = ownerSet /\ mounted = recordSet /\ journal = Idle)
\* A live graph binds only its own root, and that share is mounted.
OwnShareOnly == \A p \in Projects : graph[p] = "live" => (bound[p] = p /\ p \in mounted)
\* A retained or live graph keeps its share in both owner and provider record.
ReferencedSharesKept == \A p \in Projects :
                          graph[p] # "none" => (p \in ownerSet /\ p \in recordSet)
\* The owner receipt never commits a share change the provider record lacks.
OwnerNeverAhead == journal # Idle =>
                     ~(ownerSet # recordSet /\ ownerSet = Apply(recordSet, journal))
PrimaryKept == Primary \in ownerSet /\ Primary \in recordSet
Bounded == Cardinality(ownerSet) <= MaxShares /\ Cardinality(recordSet) <= MaxShares
=============================================================================
