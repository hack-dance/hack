------------------------- MODULE CacheReconcile -------------------------
(* Dependency-cache selection when a stopped native graph is reconciled after a
   Compose edit. A cache is a volume named by an identity of its inputs; run-owned
   data lives under the run's own names. Compute is always recreated, so only
   which volume backs the cache key is modeled, for one trusted instance. `inputs`
   are the cache's own inputs (initializer definition, declaration, image,
   lockfiles and every service mount of the cache volume); `other` is every other
   part of the Compose file. `writable` says a non-initializer service mounts the
   cache read-write: it can change the contents with inputs the identity does not
   hash, so the cache is scoped to this instance. A linked worktree or branch
   instance with its own writable consumer may write into the caches it selects.
   Broken constants are negative controls. *)
EXTENDS Naturals, TLC
CONSTANTS Values,
          WholeDocument,  \* identity also binds `other` (the earlier formula)
          KeepStale,      \* reattach the recorded cache whatever its identity
          DataAsCache,    \* reselect retained run data newly declared as a cache
          ShareWritable   \* keep a cache with a writable consumer shared
Entry(k, id, i, w) == [kind |-> k, id |-> id, rin |-> i, rw |-> w]
None == Entry("none", <<0, 0, "none">>, 0, FALSE)
Scope(w) == IF w /\ ~ShareWritable THEN "here" ELSE "shared"
Id(i, o, w) == <<i, IF WholeDocument THEN o ELSE 0, Scope(w)>>
VARIABLES phase, inputs, other, writable, declared, recorded, caches, tainted,
          mounted, staleMounted, dataMounted, needlessRebuild, foreignMounted
vars == <<phase, inputs, other, writable, declared, recorded, caches, tainted,
          mounted, staleMounted, dataMounted, needlessRebuild, foreignMounted>>
flags == <<staleMounted, dataMounted, needlessRebuild, foreignMounted>>

\* A first admission populated the cache for the initial inputs; it was shared.
Init == /\ phase = "stopped"
        /\ inputs = 1 /\ other = 1 /\ writable = FALSE /\ declared = "cache"
        /\ recorded = Entry("cache", Id(1, 1, FALSE), 1, FALSE)
        /\ caches = {Id(1, 1, FALSE)}
        /\ tainted = {}
        /\ mounted = None
        /\ staleMounted = FALSE /\ dataMounted = FALSE
        /\ needlessRebuild = FALSE /\ foreignMounted = FALSE

\* Edits between ups: the cache's own inputs, anything else, a writable consumer
\* added or removed, or whether the key is declared as a cache at all.
EditInputs(v) == /\ phase = "stopped" /\ v # inputs /\ inputs' = v
                 /\ UNCHANGED <<phase, other, writable, declared, recorded, caches,
                       tainted, mounted, flags>>
EditOther(v) == /\ phase = "stopped" /\ v # other /\ other' = v
                /\ UNCHANGED <<phase, inputs, writable, declared, recorded, caches,
                      tainted, mounted, flags>>
EditConsumer == /\ phase = "stopped" /\ writable' = ~writable
                /\ UNCHANGED <<phase, inputs, other, declared, recorded, caches,
                      tainted, mounted, flags>>
EditDeclaration == /\ phase = "stopped"
                   /\ declared' = IF declared = "cache" THEN "data" ELSE "cache"
                   /\ UNCHANGED <<phase, inputs, other, writable, recorded, caches,
                         tainted, mounted, flags>>

\* Another instance whose writable consumer runs with any inputs writes into the
\* cache it selects. Its own instance-scoped identity is never "here".
ForeignWrite(v, o) ==
    LET id == <<v, IF WholeDocument THEN o ELSE 0, IF ShareWritable THEN "shared" ELSE "there">> IN
    /\ tainted' = tainted \cup {id}
    /\ caches' = caches \cup {id}
    /\ UNCHANGED <<phase, inputs, other, writable, declared, recorded, mounted, flags>>

\* plan_reconcile::Verified::project then Session::create_resources: keep a
\* recorded cache of the same identity; otherwise select that identity's cache
\* (adopt or create; the initializer populates it) and release the old
\* reference. Retained run data declared as a cache is refused.
UpCache ==
    LET want == Id(inputs, other, writable)
        entry == Entry("cache", want, inputs, writable) IN
    /\ phase = "stopped" /\ declared = "cache"
    /\ IF recorded.kind = "data"
          THEN IF DataAsCache
                 THEN /\ phase' = "running" /\ mounted' = recorded
                      /\ dataMounted' = TRUE
                      /\ UNCHANGED <<recorded, caches, staleMounted, needlessRebuild,
                            foreignMounted>>
                 ELSE UNCHANGED <<phase, mounted, recorded, caches, flags>>
       ELSE IF recorded.kind = "cache" /\ (recorded.id = want \/ KeepStale)
          THEN /\ phase' = "running" /\ mounted' = recorded
               /\ staleMounted' = (staleMounted \/ recorded.rin # inputs)
               /\ foreignMounted' = (foreignMounted \/ recorded.id \in tainted)
               /\ UNCHANGED <<recorded, caches, dataMounted, needlessRebuild>>
          ELSE /\ phase' = "running" /\ mounted' = entry
               /\ recorded' = entry
               /\ caches' = caches \cup {want}
               /\ needlessRebuild' = (needlessRebuild \/
                     (recorded.kind = "cache" /\ recorded.rin = inputs
                      /\ recorded.rw = writable /\ want \notin caches))
               /\ foreignMounted' = (foreignMounted \/ want \in tainted)
               /\ UNCHANGED <<staleMounted, dataMounted>>
    /\ UNCHANGED <<inputs, other, writable, declared, tainted>>

\* The key is ordinary run data: reattach recorded data, or create fresh run data
\* when it was a cache (whose shared volume is only released, never deleted).
UpData ==
    /\ phase = "stopped" /\ declared = "data"
    /\ phase' = "running"
    /\ recorded' = IF recorded.kind = "data" THEN recorded
                   ELSE Entry("data", <<0, 0, "none">>, 0, FALSE)
    /\ mounted' = recorded'
    /\ UNCHANGED <<inputs, other, writable, declared, caches, tainted, flags>>

Stop == /\ phase = "running" /\ phase' = "stopped" /\ mounted' = None
        /\ UNCHANGED <<inputs, other, writable, declared, recorded, caches,
              tainted, flags>>

Next == \/ \E v \in Values : EditInputs(v) \/ EditOther(v)
        \/ \E v, o \in Values : ForeignWrite(v, o)
        \/ EditConsumer \/ EditDeclaration \/ UpCache \/ UpData \/ Stop
Spec == Init /\ [][Next]_vars

TypeOK == /\ phase \in {"stopped", "running"}
          /\ inputs \in Values /\ other \in Values /\ writable \in BOOLEAN
          /\ declared \in {"cache", "data"}
          /\ recorded.kind \in {"none", "cache", "data"}
          /\ mounted.kind \in {"none", "cache", "data"}

\* A running graph's cache was populated for exactly its current inputs.
CacheMatchesInputs == /\ ~staleMounted
                      /\ (phase = "running" /\ mounted.kind = "cache") =>
                            mounted.rin = inputs
\* Run-owned data is never mounted as a shared cache.
NoDataAsCache == ~dataMounted
\* An edit that leaves the cache's own inputs and consumers unchanged keeps the
\* cache: it never selects a not-yet-populated cache for the same inputs.
UnrelatedEditKeepsCache == ~needlessRebuild
\* A cache that another instance's writable consumer wrote is never mounted here.
NoForeignWrites == ~foreignMounted
=============================================================================
