------------------------- MODULE CacheReconcile -------------------------
(* Dependency-cache selection when a stopped native graph is reconciled after a
   Compose edit. A cache is a shared volume named by an identity of its inputs;
   run-owned data lives under the run's own names. Compute is always recreated,
   so only which volume backs the cache key is modeled. `inputs` are the cache's
   own inputs (initializer definition, declaration, image, lockfiles and every
   service mount of the cache volume, since each can write it); `other` is every
   other part of the Compose file. Broken constants are negative controls. *)
EXTENDS Naturals, TLC
CONSTANTS Values,
          WholeDocument,  \* identity also binds `other` (the earlier formula)
          KeepStale,      \* reattach the recorded cache whatever its identity
          DataAsCache     \* reselect retained run data newly declared as a cache
None == [kind |-> "none", id |-> <<0, 0>>, rin |-> 0]
Id(i, o) == IF WholeDocument THEN <<i, o>> ELSE <<i, 0>>
VARIABLES phase, inputs, other, declared, recorded, caches, mounted,
          staleMounted, dataMounted, needlessRebuild
vars == <<phase, inputs, other, declared, recorded, caches, mounted,
          staleMounted, dataMounted, needlessRebuild>>

\* A first admission populated the cache for the initial inputs.
Init == /\ phase = "stopped"
        /\ inputs = 1 /\ other = 1 /\ declared = "cache"
        /\ recorded = [kind |-> "cache", id |-> Id(1, 1), rin |-> 1]
        /\ caches = {Id(1, 1)}
        /\ mounted = None
        /\ staleMounted = FALSE /\ dataMounted = FALSE /\ needlessRebuild = FALSE

\* Edits between ups: the cache's own inputs, anything else, or whether the key
\* is declared as a cache at all.
EditInputs(v) == /\ phase = "stopped" /\ v # inputs /\ inputs' = v
                 /\ UNCHANGED <<phase, other, declared, recorded, caches, mounted,
                       staleMounted, dataMounted, needlessRebuild>>
EditOther(v) == /\ phase = "stopped" /\ v # other /\ other' = v
                /\ UNCHANGED <<phase, inputs, declared, recorded, caches, mounted,
                      staleMounted, dataMounted, needlessRebuild>>
EditDeclaration == /\ phase = "stopped"
                   /\ declared' = IF declared = "cache" THEN "data" ELSE "cache"
                   /\ UNCHANGED <<phase, inputs, other, recorded, caches, mounted,
                         staleMounted, dataMounted, needlessRebuild>>

\* plan_reconcile::Verified::project then Session::create_resources: keep a
\* recorded cache of the same identity; otherwise select that identity's shared
\* cache (adopt or create; the initializer populates it) and release the old
\* reference. Retained run data declared as a cache is refused.
UpCache ==
    LET want == Id(inputs, other)
        entry == [kind |-> "cache", id |-> want, rin |-> inputs] IN
    /\ phase = "stopped" /\ declared = "cache"
    /\ IF recorded.kind = "data"
          THEN IF DataAsCache
                 THEN /\ phase' = "running" /\ mounted' = recorded
                      /\ dataMounted' = TRUE
                      /\ UNCHANGED <<recorded, caches, staleMounted, needlessRebuild>>
                 ELSE UNCHANGED <<phase, mounted, recorded, caches, dataMounted,
                        staleMounted, needlessRebuild>>
       ELSE IF recorded.kind = "cache" /\ (recorded.id = want \/ KeepStale)
          THEN /\ phase' = "running" /\ mounted' = recorded
               /\ staleMounted' = (staleMounted \/ recorded.rin # inputs)
               /\ UNCHANGED <<recorded, caches, dataMounted, needlessRebuild>>
          ELSE /\ phase' = "running" /\ mounted' = entry
               /\ recorded' = entry
               /\ caches' = caches \cup {want}
               /\ needlessRebuild' = (needlessRebuild \/
                     (recorded.kind = "cache" /\ recorded.rin = inputs
                      /\ want \notin caches))
               /\ UNCHANGED <<staleMounted, dataMounted>>
    /\ UNCHANGED <<inputs, other, declared>>

\* The key is ordinary run data: reattach recorded data, or create fresh run data
\* when it was a cache (whose shared volume is only released, never deleted).
UpData ==
    /\ phase = "stopped" /\ declared = "data"
    /\ phase' = "running"
    /\ recorded' = IF recorded.kind = "data" THEN recorded
                   ELSE [kind |-> "data", id |-> <<0, 0>>, rin |-> 0]
    /\ mounted' = recorded'
    /\ UNCHANGED <<inputs, other, declared, caches, staleMounted, dataMounted,
          needlessRebuild>>

Stop == /\ phase = "running" /\ phase' = "stopped" /\ mounted' = None
        /\ UNCHANGED <<inputs, other, declared, recorded, caches, staleMounted,
              dataMounted, needlessRebuild>>

Next == \/ \E v \in Values : EditInputs(v) \/ EditOther(v)
        \/ EditDeclaration \/ UpCache \/ UpData \/ Stop
Spec == Init /\ [][Next]_vars

TypeOK == /\ phase \in {"stopped", "running"}
          /\ inputs \in Values /\ other \in Values
          /\ declared \in {"cache", "data"}
          /\ recorded.kind \in {"none", "cache", "data"}
          /\ mounted.kind \in {"none", "cache", "data"}

\* A running graph's cache was populated for exactly its current inputs.
CacheMatchesInputs == /\ ~staleMounted
                      /\ (phase = "running" /\ mounted.kind = "cache") =>
                            mounted.rin = inputs
\* Run-owned data is never mounted as a shared cache.
NoDataAsCache == ~dataMounted
\* An edit that leaves the cache's own inputs unchanged keeps the cache: it never
\* selects a not-yet-populated cache for the same inputs.
UnrelatedEditKeepsCache == ~needlessRebuild
=============================================================================
