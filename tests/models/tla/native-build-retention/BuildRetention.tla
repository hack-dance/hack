------------------------- MODULE BuildRetention -------------------------
(***************************************************************************)
(* Native image build retention: `provider::image_build` and its           *)
(* `reclaim` module. One build key, one namespace, a bounded supply of     *)
(* content IDs. A build is admitted under the provider lease (fence and    *)
(* `building` receipt), runs unleased, and is adopted under the lease only *)
(* when the reported image carries this incarnation's labels and the       *)
(* incarnation is the one admitted. `runtime down` stops the engine only   *)
(* when no build holds the shared fence. Reclamation removes only owned,   *)
(* non-current images that no retained graph state references; the engine *)
(* itself refuses images a container uses. Unsafe* constants remove one    *)
(* guard each for the negative controls.                                   *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets
CONSTANTS UnsafeReclaim, UnsafeAdopt, UnsafeDown
VARIABLES incarnation, engineUp, engine, owner, next, receipt, build,
          fence, refs, used, removed
vars == <<incarnation, engineUp, engine, owner, next, receipt, build,
          fence, refs, used, removed>>
Ids == 1..3
Phases == {"none", "building", "verified", "failed", "canceled",
           "indeterminate"}

Init == /\ incarnation = 1 /\ engineUp = TRUE /\ engine = {}
        /\ owner = [i \in Ids |-> 0] /\ next = 1
        /\ receipt = [phase |-> "none", image |-> 0, inc |-> 0]
        /\ build = "idle" /\ fence = FALSE
        /\ refs = {} /\ used = {} /\ removed = 0

(* Step 1: under the lease, take the fence and record the attempt. *)
BeginBuild == /\ engineUp /\ build = "idle"
              /\ build' = "running" /\ fence' = TRUE
              /\ receipt' = [phase |-> "building", image |-> 0, inc |-> incarnation]
              /\ UNCHANGED <<incarnation, engineUp, engine, owner, next, refs, used, removed>>
(* Step 4, unleased: BuildKit writes a fresh image with this pool's labels. *)
RunBuild == /\ build = "running" /\ engineUp /\ next \in Ids
            /\ engine' = engine \cup {next}
            /\ owner' = [owner EXCEPT ![next] = incarnation]
            /\ next' = next + 1 /\ build' = "done"
            /\ UNCHANGED <<incarnation, engineUp, receipt, fence, refs, used, removed>>
(* A forged or foreign image appears in the engine (Dockerfile labels, other pool). *)
ForeignImage == /\ engineUp /\ next \in Ids
                /\ engine' = engine \cup {next} /\ next' = next + 1
                /\ UNCHANGED <<incarnation, engineUp, owner, receipt, build, fence, refs, used, removed>>
(* Step 5: the reported ID may be any present image; only an owned one under   *)
(* the admitted incarnation is adopted.                                        *)
CompleteBuild == /\ build = "done" /\ engineUp
                 /\ \E reported \in engine :
                      receipt' = IF UnsafeAdopt \/
                                    (owner[reported] = incarnation /\ receipt.inc = incarnation)
                                 THEN [phase |-> "verified", image |-> reported, inc |-> receipt.inc]
                                 ELSE [receipt EXCEPT !.phase = "failed"]
                 /\ build' = "idle" /\ fence' = FALSE
                 /\ UNCHANGED <<incarnation, engineUp, engine, owner, next, refs, used, removed>>
Cancel == /\ build \in {"running", "done"}
          /\ build' = "idle" /\ fence' = FALSE
          /\ receipt' = [receipt EXCEPT !.phase = "canceled"]
          /\ UNCHANGED <<incarnation, engineUp, engine, owner, next, refs, used, removed>>
(* hack-native dies: the flock-backed fence and key lock are released; the     *)
(* receipt stays `building` and the next attempt records it indeterminate.     *)
CrashHost == /\ build # "idle" /\ build' = "idle" /\ fence' = FALSE
             /\ UNCHANGED <<incarnation, engineUp, engine, owner, next, receipt, refs, used, removed>>
RecordDeadAttempt == /\ build = "idle" /\ receipt.phase = "building"
                     /\ receipt' = [receipt EXCEPT !.phase = "indeterminate"]
                     /\ UNCHANGED <<incarnation, engineUp, engine, owner, next, build, fence, refs, used, removed>>
Down == /\ engineUp /\ (UnsafeDown \/ ~fence)
        /\ engineUp' = FALSE
        /\ UNCHANGED <<incarnation, engine, owner, next, receipt, build, fence, refs, used, removed>>
Up == /\ ~engineUp /\ engineUp' = TRUE
      /\ UNCHANGED <<incarnation, engine, owner, next, receipt, build, fence, refs, used, removed>>
(* The storage disk is recreated: a new incarnation with an empty engine.      *)
RecreateStorage == /\ ~engineUp /\ build = "idle" /\ incarnation = 1
                   /\ incarnation' = 2 /\ engine' = {} /\ used' = {}
                   /\ UNCHANGED <<engineUp, owner, next, receipt, build, fence, refs, removed>>
(* A graph starts from the verified image of this incarnation and retains a   *)
(* reference to it; its containers use it until removed.                       *)
StartGraph == /\ engineUp /\ receipt.phase = "verified"
              /\ receipt.inc = incarnation /\ receipt.image \in engine
              /\ owner[receipt.image] = incarnation
              /\ refs' = refs \cup {receipt.image} /\ used' = used \cup {receipt.image}
              /\ UNCHANGED <<incarnation, engineUp, engine, owner, next, receipt, build, fence, removed>>
(* Data-retaining cleanup removes containers but keeps the graph reference.    *)
RemoveContainers == /\ used # {} /\ used' = {}
                    /\ UNCHANGED <<incarnation, engineUp, engine, owner, next, receipt, build, fence, refs, removed>>
(* Restore uses retained references only and never builds.                    *)
Restore == /\ engineUp /\ build = "idle" /\ refs \cap engine # {}
           /\ used' = used \cup (refs \cap engine)
           /\ UNCHANGED <<incarnation, engineUp, engine, owner, next, receipt, build, fence, refs, removed>>
Reclaim == /\ engineUp /\ ~fence
           /\ \E image \in engine :
                /\ owner[image] = incarnation
                /\ ~(receipt.phase = "verified" /\ receipt.image = image)
                /\ (UnsafeReclaim \/ image \notin refs)
                /\ image \notin used
                /\ engine' = engine \ {image} /\ removed' = image
           /\ UNCHANGED <<incarnation, engineUp, owner, next, receipt, build, fence, refs, used>>
PruneCache == /\ engineUp /\ UNCHANGED vars
Next == BeginBuild \/ RunBuild \/ ForeignImage \/ CompleteBuild \/ Cancel
        \/ CrashHost \/ RecordDeadAttempt \/ Down \/ Up \/ RecreateStorage
        \/ StartGraph \/ RemoveContainers \/ Restore \/ Reclaim \/ PruneCache
Spec == Init /\ [][Next]_vars

TypeOK == /\ incarnation \in {1, 2} /\ engineUp \in BOOLEAN
          /\ engine \subseteq Ids /\ owner \in [Ids -> 0..2] /\ next \in 1..4
          /\ receipt.phase \in Phases /\ receipt.image \in 0..3 /\ receipt.inc \in 0..2
          /\ build \in {"idle", "running", "done"} /\ fence \in BOOLEAN
          /\ refs \subseteq Ids /\ used \subseteq Ids /\ removed \in 0..3
(* An image retained graph state references is never reclaimed.               *)
NoReclaimReferenced == removed = 0 \/ removed \notin refs
(* A verified receipt names an image produced under its own incarnation.      *)
NoForeignAdoption == receipt.phase = "verified" => owner[receipt.image] = receipt.inc
(* The engine never stops under a build its operation still controls.         *)
DownNotUnderBuild == build = "running" => engineUp
Safe == NoReclaimReferenced /\ NoForeignAdoption /\ DownNotUnderBuild
=============================================================================
