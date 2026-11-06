---------------------------- MODULE Reconcile ----------------------------
(* Retained named-data handoff across Compose plan changes for stopped native
   graphs. Each instance owns one run receipt mapping logical volume keys to
   recorded volume identities. Compute is always recreated from the current
   plan; only named data is selected. Broken constants are negative controls. *)
EXTENDS Naturals, FiniteSets, TLC
CONSTANTS Instances, Keys, MaxVolumes,
          ReattachByKey,   \* adopt any live volume with the declared key
          SkipGeneration,  \* admit without rechecking the selected identities
          DropOrphans      \* forget retained data the new plan no longer declares
Vols == 1..MaxVolumes
None == 0
VARIABLES phase, plan, receipt, at, owner, vkey, live, data, attached,
          selection, fresh, foreignAttach, unrecordedAttach, lostData
vars == <<phase, plan, receipt, at, owner, vkey, live, data, attached,
          selection, fresh, foreignAttach, unrecordedAttach, lostData>>
NoKeys == [k \in Keys |-> None]

Init == /\ phase = [i \in Instances |-> "stopped"]
        /\ plan = [i \in Instances |-> Keys]
        /\ receipt = [i \in Instances |-> NoKeys]
        /\ at = [i \in Instances |-> NoKeys]
        /\ owner = [v \in Vols |-> None]
        /\ vkey = [v \in Vols |-> "none"]
        /\ live = [v \in Vols |-> FALSE]
        /\ data = [v \in Vols |-> FALSE]
        /\ attached = [i \in Instances |-> {}]
        /\ selection = [i \in Instances |-> NoKeys]
        /\ fresh = 1
        /\ foreignAttach = FALSE /\ unrecordedAttach = FALSE /\ lostData = FALSE

\* A Compose edit changes only the declared volume set here; command, image and
\* environment edits change compute, which every admission recreates anyway.
Edit(i, p) == /\ p # plan[i]
              /\ plan' = [plan EXCEPT ![i] = p]
              /\ UNCHANGED <<phase, receipt, at, owner, vkey, live, data, attached,
                    selection, fresh, foreignAttach, unrecordedAttach, lostData>>

\* restore-selection: bind the stopped receipt to the exact observed identities.
Select(i) == /\ phase[i] = "stopped"
             /\ phase' = [phase EXCEPT ![i] = "selected"]
             /\ selection' = [selection EXCEPT ![i] = at[i]]
             /\ UNCHANGED <<plan, receipt, at, owner, vkey, live, data, attached,
                   fresh, foreignAttach, unrecordedAttach, lostData>>

\* Between selection and admission an outside actor replaces the volume behind a
\* recorded name, even with copied ownership labels: the generation fence's case.
\* Admission through startup holds the provider mutation lease, which excludes it.
Replace(i, k) == /\ phase[i] = "selected"
                 /\ at[i][k] # None /\ fresh <= MaxVolumes
                 /\ at' = [at EXCEPT ![i][k] = fresh]
                 /\ owner' = [owner EXCEPT ![fresh] = i]
                 /\ vkey' = [vkey EXCEPT ![fresh] = k]
                 /\ live' = [live EXCEPT ![at[i][k]] = FALSE, ![fresh] = TRUE]
                 /\ fresh' = fresh + 1
                 /\ UNCHANGED <<phase, plan, receipt, data, attached, selection,
                       foreignAttach, unrecordedAttach, lostData>>

\* While stopped, another instance's labeled volume appears under a recorded name.
\* Label verification at selection and admission must refuse it.
Substitute(i, j, k) == /\ phase[i] = "stopped" /\ j # i
                       /\ at[i][k] # None /\ fresh <= MaxVolumes
                       /\ at' = [at EXCEPT ![i][k] = fresh]
                       /\ owner' = [owner EXCEPT ![fresh] = j]
                       /\ vkey' = [vkey EXCEPT ![fresh] = k]
                       /\ live' = [live EXCEPT ![at[i][k]] = FALSE, ![fresh] = TRUE]
                       /\ fresh' = fresh + 1
                       /\ UNCHANGED <<phase, plan, receipt, data, attached, selection,
                             foreignAttach, unrecordedAttach, lostData>>

\* Admission rechecks the selected generation and every retained volume's presence.
Admit(i) == /\ phase[i] = "selected"
            /\ IF (SkipGeneration \/ at[i] = selection[i])
                  /\ \A k \in Keys : receipt[i][k] # None =>
                        live[at[i][k]] /\ owner[at[i][k]] = i
                 THEN phase' = [phase EXCEPT ![i] = "admitting"]
                 ELSE phase' = [phase EXCEPT ![i] = "stopped"]
            /\ UNCHANGED <<plan, receipt, at, owner, vkey, live, data, attached,
                  selection, fresh, foreignAttach, unrecordedAttach, lostData>>

\* A newly declared key gets a fresh owned volume through exclusive create.
CreateDeclared(i, k) ==
    /\ phase[i] = "admitting" /\ k \in plan[i] /\ receipt[i][k] = None
    /\ IF ReattachByKey /\ \E v \in Vols : live[v] /\ vkey[v] = k
          THEN LET v == CHOOSE v \in Vols : live[v] /\ vkey[v] = k IN
               /\ receipt' = [receipt EXCEPT ![i][k] = v]
               /\ at' = [at EXCEPT ![i][k] = v]
               /\ UNCHANGED <<owner, vkey, live, fresh>>
          ELSE /\ fresh <= MaxVolumes
               /\ receipt' = [receipt EXCEPT ![i][k] = fresh]
               /\ at' = [at EXCEPT ![i][k] = fresh]
               /\ owner' = [owner EXCEPT ![fresh] = i]
               /\ vkey' = [vkey EXCEPT ![fresh] = k]
               /\ live' = [live EXCEPT ![fresh] = TRUE]
               /\ fresh' = fresh + 1
    /\ UNCHANGED <<phase, plan, data, attached, selection,
          foreignAttach, unrecordedAttach, lostData>>

\* Startup mounts exactly the declared keys; retained undeclared data stays recorded.
Start(i) ==
    /\ phase[i] = "admitting"
    /\ \A k \in plan[i] : receipt[i][k] # None
    /\ LET mounted == {at[i][k] : k \in plan[i]}
           kept == IF DropOrphans
                     THEN [k \in Keys |-> IF k \in plan[i] THEN receipt[i][k] ELSE None]
                     ELSE receipt[i]
           dropped == {at[i][k] : k \in {k \in Keys : kept[k] = None /\ receipt[i][k] # None}}
       IN /\ attached' = [attached EXCEPT ![i] = mounted]
          /\ receipt' = [receipt EXCEPT ![i] = kept]
          /\ at' = [at EXCEPT ![i] = [k \in Keys |-> IF kept[k] = None THEN None ELSE at[i][k]]]
          /\ phase' = [phase EXCEPT ![i] = "running"]
          /\ foreignAttach' = (foreignAttach \/ \E v \in mounted : owner[v] # i)
          /\ unrecordedAttach' = (unrecordedAttach \/
                \E k \in plan[i] : selection[i][k] # None /\ at[i][k] # selection[i][k])
          /\ lostData' = (lostData \/ \E v \in dropped : live[v] /\ data[v])
    /\ UNCHANGED <<plan, owner, vkey, live, data, selection, fresh>>

\* Failure before startup completes: cleanup keeps every created volume recorded.
Fail(i) == /\ phase[i] \in {"selected", "admitting"}
           /\ phase' = [phase EXCEPT ![i] = "stopped"]
           /\ UNCHANGED <<plan, receipt, at, owner, vkey, live, data, attached,
                 selection, fresh, foreignAttach, unrecordedAttach, lostData>>

Write(i) == /\ phase[i] = "running" /\ attached[i] # {}
            /\ \E v \in attached[i] : ~data[v]
            /\ data' = [v \in Vols |-> data[v] \/ v \in attached[i]]
            /\ UNCHANGED <<phase, plan, receipt, at, owner, vkey, live, attached,
                  selection, fresh, foreignAttach, unrecordedAttach, lostData>>

\* Ctrl-C or down: compute is removed, all recorded data is retained.
Stop(i) == /\ phase[i] = "running"
           /\ phase' = [phase EXCEPT ![i] = "stopped"]
           /\ attached' = [attached EXCEPT ![i] = {}]
           /\ UNCHANGED <<plan, receipt, at, owner, vkey, live, data,
                 selection, fresh, foreignAttach, unrecordedAttach, lostData>>

\* Explicit data removal is the only intended deletion of retained volumes.
RemoveData(i) == /\ phase[i] = "stopped"
                 /\ \E k \in Keys : receipt[i][k] # None
                 /\ live' = [v \in Vols |-> live[v] /\ \A k \in Keys : at[i][k] # v]
                 /\ data' = [v \in Vols |-> data[v] /\ \A k \in Keys : at[i][k] # v]
                 /\ receipt' = [receipt EXCEPT ![i] = NoKeys]
                 /\ at' = [at EXCEPT ![i] = NoKeys]
                 /\ UNCHANGED <<phase, plan, owner, vkey, attached, selection, fresh,
                       foreignAttach, unrecordedAttach, lostData>>

Next == \E i \in Instances :
          \/ \E p \in SUBSET Keys : Edit(i, p)
          \/ Select(i) \/ Admit(i) \/ Start(i) \/ Fail(i)
          \/ Write(i) \/ Stop(i) \/ RemoveData(i)
          \/ \E k \in Keys : Replace(i, k) \/ CreateDeclared(i, k)
          \/ \E j \in Instances, k \in Keys : Substitute(i, j, k)
Spec == Init /\ [][Next]_vars
\* Instances are interchangeable model values; checked up to their permutation.
InstanceSymmetry == Permutations(Instances)

TypeOK == /\ phase \in [Instances -> {"stopped", "selected", "admitting", "running"}]
          /\ plan \in [Instances -> SUBSET Keys]
          /\ receipt \in [Instances -> [Keys -> 0..MaxVolumes]]
          /\ at \in [Instances -> [Keys -> 0..MaxVolumes]]
          /\ owner \in [Vols -> {None} \cup Instances]
          /\ live \in [Vols -> BOOLEAN] /\ data \in [Vols -> BOOLEAN]
          /\ attached \in [Instances -> SUBSET Vols]
          /\ fresh \in 1..MaxVolumes + 1

\* Data is mounted only by the instance that owns it.
NoForeignAttach == /\ ~foreignAttach
                   /\ \A i \in Instances : \A v \in attached[i] : owner[v] = i
\* Retained data is mounted only under the identity bound at selection; data
\* first declared by this admission is the exclusively created volume.
AttachSelected == /\ ~unrecordedAttach
                  /\ \A i \in Instances : \A v \in attached[i] : \E k \in Keys : at[i][k] = v
\* Retained data stays recorded by its owner until explicit removal.
RetainedDataRecorded == /\ ~lostData
                        /\ \A v \in Vols : (live[v] /\ data[v]) =>
                             \E k \in Keys : at[owner[v]][k] = v
=============================================================================
