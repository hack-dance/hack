----------------------------- MODULE StartGraph -----------------------------
(* Start graph with reuse by specification digest (HACK-2459).
   Two services, one dependency edge (Dependent waits for Dependency).
   - cur[s]      desired spec digest; the user may edit it at any time.
   - eng[s][g]   the engine's container for service s, generation g:
                 st (absent, created, running, ready, stopped), spec (its
                 io.hack-local.spec label) and att (the VM boot in which its
                 boot-bound attachments were made: probe state, env files).
   - rgen[s]     the generation the receipt binds to s (0 = none).
   - pending     intents staged in memory; intents: durable intents.
                 Flush is the one grouped durable write of a wave.
   - unsure[s]   a create reply was lost, or a new owner took over: the
                 receipt names a container that may or may not exist.
   - snap, route publisher snapshot and committed route generation.
   - boot        the VM boot. Reboot stops containers, or (restart policy)
                 keeps them running with attachments of the old boot.
   - up          idle, running, returned (all started: the CLI returns),
                 done (ready and published: --wait returns).
   Reusable(s) reads the engine (one labelled list), never the journal.
   Negative controls (each must break a named invariant):
     NoFence         create from a staged, not yet durable intent
     IgnoreDeps      start before dependencies are ready
     NoPublishFence  commit a route from a stale snapshot
     ReuseByName     reuse a live container whatever its spec label
     NoUnpublish     the owner removes a container while a route points
                     at it
     KeepAcrossBoot  reuse a container whose attachments are from an
                     earlier boot
     BlindRetry      after an uncertain create (a lost reply, or an owner
                     takeover), plan and create again without inspecting
   Ghost variables: acted (this `up` planned or touched something), bad
   (unsafe-step flags) and base (the project was current, ready and routed
   when this `up` began). *)
EXTENDS Naturals, FiniteSets

CONSTANTS Services, Dependent, Dependency, Specs, MaxGen, MaxBoot,
          NoFence, IgnoreDeps, NoPublishFence, ReuseByName, NoUnpublish,
          KeepAcrossBoot, BlindRetry

VARIABLES cur, eng, rgen, pending, intents, nextGen, unsure, snap, route,
          boot, up, acted, bad, base
vars == <<cur, eng, rgen, pending, intents, nextGen, unsure, snap, route,
          boot, up, acted, bad, base>>

Gens == 1..MaxGen
Absent == [st |-> "absent", spec |-> 0, att |-> 0]
Deps(s) == IF s = Dependent THEN {Dependency} ELSE {}
Ctr(s) == IF rgen[s] = 0 THEN Absent ELSE eng[s][rgen[s]]
Live(s) == Ctr(s).st \in {"running", "ready"}
\* Attachments made in this boot; KeepAcrossBoot drops this fence everywhere.
ThisBoot(s) == KeepAcrossBoot \/ Ctr(s).att = boot
Reusable(s) == /\ ~unsure[s]
               /\ Live(s)
               /\ (ReuseByName \/ Ctr(s).spec = cur[s])
               /\ ThisBoot(s)
\* The true condition, independent of every control switch.
Current(s) == /\ rgen[s] # 0 /\ ~unsure[s]
              /\ Ctr(s).spec = cur[s] /\ Ctr(s).att = boot
Staged(s) == \E i \in pending \cup intents : i[1] = s /\ i[2] > rgen[s]
DepsReady(s) == \A d \in Deps(s) : Ctr(d).st = "ready" /\ ~unsure[d]
                                   /\ ThisBoot(d)
DepsSafe(s) == \A d \in Deps(s) : Ctr(d).st = "ready" /\ ~unsure[d]
                                  /\ Ctr(d).att = boot
OldGone(s) == rgen[s] = 0 \/ Ctr(s).st = "absent"
\* The true condition for committing snap[s], independent of every guard.
PublishSafe(s) == /\ snap[s] = rgen[s] /\ eng[s][snap[s]].st = "ready"
                  /\ eng[s][snap[s]].att = boot
Existing(s) == {g \in Gens : eng[s][g].st # "absent"}
\* Ghost flags: bad[k] becomes TRUE when a guarded step was taken unsafely.
Flags == {"start", "publish", "replace", "return"}
Flag(k, c) == [bad EXCEPT ![k] = @ \/ c]

Init == /\ cur \in [Services -> Specs]
        /\ eng = [s \in Services |-> [g \in Gens |-> Absent]]
        /\ rgen = [s \in Services |-> 0]
        /\ pending = {} /\ intents = {}
        /\ nextGen = [s \in Services |-> 1]
        /\ unsure = [s \in Services |-> FALSE]
        /\ snap = [s \in Services |-> 0]
        /\ route = [s \in Services |-> 0]
        /\ boot = 1
        /\ up = "idle"
        /\ acted = FALSE
        /\ bad = [k \in Flags |-> FALSE]
        /\ base = FALSE

\* A new `hack up`, including one on a running or finished project.
BeginUp == /\ up \in {"idle", "returned", "done"}
           /\ up' = "running" /\ acted' = FALSE
           /\ base' = \A s \in Services : /\ Current(s) /\ Ctr(s).st = "ready"
                                          /\ route[s] = rgen[s]
           /\ UNCHANGED <<cur, eng, rgen, pending, intents, nextGen, unsure,
                          snap, route, boot, bad>>

\* Rule 3: an unsure service is inspected before anything else touches it.
Inspect(s) == /\ unsure[s] /\ unsure' = [unsure EXCEPT ![s] = FALSE]
              /\ UNCHANGED <<base, cur, eng, rgen, pending, intents, nextGen, snap,
                             route, boot, up, acted, bad>>

\* Plan a new generation unless the observed container is reusable.
Plan(s) == /\ up = "running" /\ ~Reusable(s) /\ ~Staged(s)
           /\ (BlindRetry \/ ~unsure[s])
           /\ nextGen[s] <= MaxGen
           /\ pending' = pending \cup {<<s, nextGen[s], cur[s]>>}
           /\ nextGen' = [nextGen EXCEPT ![s] = @ + 1]
           /\ acted' = TRUE
           /\ UNCHANGED <<base, cur, eng, rgen, intents, unsure, snap, route, boot,
                          up, bad>>

\* One grouped durable write for every intent staged so far (one wave).
Flush == /\ pending # {}
         /\ intents' = intents \cup pending /\ pending' = {}
         /\ UNCHANGED <<base, cur, eng, rgen, nextGen, unsure, snap, route, boot,
                        up, acted, bad>>

Unpublish(s) == /\ route[s] # 0 /\ ~Reusable(s)
                /\ route' = [route EXCEPT ![s] = 0]
                /\ UNCHANGED <<base, cur, eng, rgen, pending, intents, nextGen,
                               unsure, snap, boot, up, acted, bad>>

\* Remove the old generation before its replacement is created.
RemoveOld(s) ==
  /\ rgen[s] # 0 /\ Ctr(s).st # "absent" /\ ~unsure[s]
  /\ \E i \in intents : i[1] = s /\ i[2] > rgen[s]
  /\ (NoUnpublish \/ route[s] # rgen[s])
  /\ bad' = Flag("replace", route[s] = rgen[s])
  /\ eng' = [eng EXCEPT ![s][rgen[s]] = Absent]
  /\ acted' = TRUE
  /\ UNCHANGED <<base, cur, rgen, pending, intents, nextGen, unsure, snap, route,
                 boot, up>>

\* Create, with the reply received (ok) or lost (the engine may have it).
Create(s, ok) ==
  \E i \in (IF NoFence THEN intents \cup pending ELSE intents) :
    /\ up = "running"
    /\ i[1] = s /\ i[2] > rgen[s]
    /\ (OldGone(s) \/ (BlindRetry /\ unsure[s]))
    /\ (BlindRetry \/ ~unsure[s])
    /\ rgen' = [rgen EXCEPT ![s] = i[2]]
    /\ IF ok
         THEN /\ eng' = [eng EXCEPT ![s][i[2]] =
                           [st |-> "created", spec |-> i[3], att |-> 0]]
              /\ unsure' = [unsure EXCEPT ![s] = FALSE]
         ELSE /\ \E made \in BOOLEAN :
                   eng' = IF made
                            THEN [eng EXCEPT ![s][i[2]] =
                                    [st |-> "created", spec |-> i[3], att |-> 0]]
                            ELSE eng
              /\ unsure' = [unsure EXCEPT ![s] = TRUE]
    /\ acted' = TRUE
    /\ UNCHANGED <<base, cur, pending, intents, nextGen, snap, route, boot, up,
                   bad>>

Start(s) == /\ up = "running" /\ ~unsure[s]
            /\ Ctr(s).st = "created" /\ (IgnoreDeps \/ DepsReady(s))
            /\ bad' = Flag("start", ~DepsSafe(s))
            /\ eng' = [eng EXCEPT ![s][rgen[s]].st = "running",
                                  ![s][rgen[s]].att = boot]
            /\ acted' = TRUE
            /\ UNCHANGED <<base, cur, rgen, pending, intents, nextGen, unsure, snap,
                           route, boot, up>>

\* Health observed through one labelled list (or the probe sample).
Ready(s) == /\ Ctr(s).st = "running" /\ ~unsure[s] /\ ThisBoot(s)
            /\ eng' = [eng EXCEPT ![s][rgen[s]].st = "ready"]
            /\ UNCHANGED <<base, cur, rgen, pending, intents, nextGen, unsure, snap,
                           route, boot, up, acted, bad>>

Snap(s) == /\ Ctr(s).st = "ready" /\ ~unsure[s] /\ snap[s] = 0
           /\ route[s] # rgen[s]
           /\ snap' = [snap EXCEPT ![s] = rgen[s]]
           /\ UNCHANGED <<base, cur, eng, rgen, pending, intents, nextGen, unsure,
                          route, boot, up, acted, bad>>

\* The batch commit re-checks the generation (the bridge fence).
Publish(s) ==
  /\ snap[s] # 0
  /\ LET fresh == /\ snap[s] = rgen[s] /\ eng[s][snap[s]].st = "ready"
                  /\ eng[s][snap[s]].att = boot
     IN /\ route' = IF fresh \/ NoPublishFence
                      THEN [route EXCEPT ![s] = snap[s]] ELSE route
        \* Judged by what was committed, independently of the guard.
        /\ bad' = Flag("publish", route'[s] = snap[s] /\ ~PublishSafe(s))
  /\ snap' = [snap EXCEPT ![s] = 0]
  /\ UNCHANGED <<base, cur, eng, rgen, pending, intents, nextGen, unsure, boot, up,
                 acted>>

\* `up` returns when every container is started with the current spec.
Return == /\ up = "running"
          /\ \A s \in Services : Reusable(s)
          /\ bad' = Flag("return", \E s \in Services :
                           Ctr(s).spec # cur[s] \/ Ctr(s).att # boot)
          /\ up' = "returned"
          /\ UNCHANGED <<base, cur, eng, rgen, pending, intents, nextGen, unsure,
                         snap, route, boot, acted>>

\* The owner keeps going after the CLI returned: ready and published.
Done == /\ up \in {"running", "returned"}
        /\ \A s \in Services : Reusable(s) /\ Ctr(s).st = "ready"
                               /\ route[s] = rgen[s]
        /\ up' = "done"
        /\ UNCHANGED <<base, cur, eng, rgen, pending, intents, nextGen, unsure, snap,
                       route, boot, acted, bad>>

Edit(s) == /\ \E v \in Specs \ {cur[s]} : cur' = [cur EXCEPT ![s] = v]
           /\ up' = IF up = "done" THEN "idle" ELSE up
           /\ UNCHANGED <<base, eng, rgen, pending, intents, nextGen, unsure, snap,
                          route, boot, acted, bad>>

ExtRemove(s) == /\ rgen[s] # 0 /\ Ctr(s).st # "absent"
                /\ eng' = [eng EXCEPT ![s][rgen[s]] = Absent]
                /\ up' = IF up = "done" THEN "idle" ELSE up
                /\ UNCHANGED <<base, cur, rgen, pending, intents, nextGen, unsure,
                               snap, route, boot, acted, bad>>

\* The owner dies: memory is lost; the next owner inspects every service.
Crash == /\ up # "idle"
         /\ pending' = {} /\ snap' = [s \in Services |-> 0] /\ up' = "idle"
         /\ unsure' = [s \in Services |-> rgen[s] # 0]
         /\ UNCHANGED <<base, cur, eng, rgen, intents, nextGen, route, boot,
                        acted, bad>>

\* The VM restarts: relays and the owner are gone; a container either stops
\* or is restarted by its policy with attachments from the old boot.
Reboot == /\ boot < MaxBoot
          /\ boot' = boot + 1
          /\ \E keep \in [Services -> BOOLEAN] :
               eng' = [s \in Services |-> [g \in Gens |->
                        IF eng[s][g].st \in {"running", "ready"}
                          THEN [eng[s][g] EXCEPT !.st =
                                  IF keep[s] THEN "running" ELSE "stopped"]
                          ELSE eng[s][g]]]
          /\ route' = [s \in Services |-> 0]
          /\ snap' = [s \in Services |-> 0]
          /\ pending' = {} /\ up' = "idle"
          /\ unsure' = [s \in Services |-> rgen[s] # 0]
          /\ UNCHANGED <<base, cur, rgen, intents, nextGen, acted, bad>>

Next == \/ BeginUp \/ Flush \/ Return \/ Done \/ Crash \/ Reboot
        \/ \E s \in Services :
             \/ Inspect(s) \/ Plan(s) \/ Unpublish(s) \/ RemoveOld(s)
             \/ Create(s, TRUE) \/ Create(s, FALSE)
             \/ Start(s) \/ Ready(s) \/ Snap(s) \/ Publish(s)
             \/ Edit(s) \/ ExtRemove(s)

Spec == Init /\ [][Next]_vars

\* Every container that exists has a durable intent for its generation.
NoEffectWithoutIntent ==
  \A s \in Services, g \in Gens :
    eng[s][g].st # "absent" =>
      \E i \in intents : i[1] = s /\ i[2] = g /\ i[3] = eng[s][g].spec
\* A service starts only after its dependencies are ready in this boot.
DepsBeforeStart == ~bad["start"]
\* A route is never committed to a replaced, unready or previous-boot
\* generation.
NoPublishToReplaced == ~bad["publish"]
\* The owner never removes a container while a route points at it.
\* (ExtRemove of a routed container is a modelled failure, not covered.)
NoReplaceWhileRouted == ~bad["replace"]
\* At most one container exists per service.
OneContainerPerService == \A s \in Services : Cardinality(Existing(s)) <= 1
\* `up` returns only when every container runs the current spec with
\* attachments made in the current boot.
ReturnIsCurrent == ~bad["return"]
\* `done` means every service runs the current spec, made in this boot,
\* ready and routed.
DoneIsCurrent ==
  up = "done" => \A s \in Services : /\ Ctr(s).spec = cur[s]
                                     /\ Ctr(s).att = boot
                                     /\ Ctr(s).st = "ready"
                                     /\ route[s] = rgen[s]
Safe == /\ NoEffectWithoutIntent /\ DepsBeforeStart /\ NoPublishToReplaced
        /\ NoReplaceWhileRouted /\ OneContainerPerService
        /\ ReturnIsCurrent /\ DoneIsCurrent
\* Reachability: an `up` that began on a current, ready and routed project
\* returns without planning anything (the no-op up). `base` records that
\* condition at BeginUp. Checked as a violated invariant.
NeverNoOpUp == ~(up = "returned" /\ ~acted /\ base)
=============================================================================
