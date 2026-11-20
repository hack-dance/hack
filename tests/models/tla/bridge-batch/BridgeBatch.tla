---------------- MODULE BridgeBatch ----------------
(* One foreground owner publishes a batch of bridges (a route "r" and a
   loopback port "p") and a cleanup later releases them (HACK-2442).

   Source: `provider/graph/bridges.rs` (`reserve_publications`,
   `start_selected`, `publish_bridge`, `release_selected`), `relay.rs`
   (`operate_all`), `publication.rs` (`release_entries`) and
   `foreground/publishers.rs` (`Publishers::start`).

   One provider lease (`lease`) serializes every registry, journal and guest
   write. The owner holds it for the whole relay batch; each publisher child
   takes it in turn; cleanup holds it for the whole release. A target container
   can be replaced (new incarnation) or lose health at any time. The owner and
   the cleanup can each crash between any two steps (bounded by MaxCrashes);
   a crashed holder's lease is released by the kernel. A publisher child is a
   separate process and survives its owner.

   Collapsed: a fence is one atomic read; the per-slot `stop_slot` used for a
   slot that is stale after its relay started is one step (it already has its
   own model in relay-fence); journal saves are atomic renames.

   Guards, each turned off by one negative control:
   - EnforceIntent: record `starting` before the relay start effect.
   - EnforceChildFence: a child publishes only to a running relay whose target
     is still the reserved, healthy incarnation.
   - EnforceReleaseOrder: retire host publications before stopping relays. *)
EXTENDS Naturals
CONSTANTS EnforceIntent, EnforceChildFence, EnforceReleaseOrder, MaxCrashes
Slots == {"r", "p"}
Phases == {"none", "reserved", "starting", "running", "stopping", "stopped"}
OwnerPcs == {"idle", "start", "fence1", "fence2", "intent", "relays",
             "late", "fence3", "spawn", "await", "ready", "failed", "crashed"}
CleanPcs == {"idle", "pubs", "stopping", "stop", "stopped", "remove", "drop",
             "late", "done"}
VARIABLES inc, healthy, gen, phase, relay, pub, pubGen, lease, opc, cpc,
          rpc, crashes, staleLaunch
vars == <<inc, healthy, gen, phase, relay, pub, pubGen, lease, opc, cpc,
          rpc, crashes, staleLaunch>>

TypeOK ==
    /\ inc \in [Slots -> 0..1]
    /\ healthy \in [Slots -> BOOLEAN]
    /\ gen \in [Slots -> 0..1]
    /\ phase \in [Slots -> Phases]
    /\ relay \in [Slots -> {"absent", "running", "stopped"}]
    /\ pub \in [Slots -> {"none", "live", "retired"}]
    /\ pubGen \in [Slots -> 0..1]
    /\ lease \in {"free", "owner", "cleanup"} \cup Slots
    /\ opc \in OwnerPcs
    /\ cpc \in [Slots -> {"none", "waiting", "fence", "done", "refused"}]
    /\ rpc \in CleanPcs
    /\ crashes \in 0..MaxCrashes
    /\ staleLaunch \in BOOLEAN

Init ==
    /\ inc = [s \in Slots |-> 0]
    /\ healthy = [s \in Slots |-> TRUE]
    /\ gen = [s \in Slots |-> 0]
    /\ phase = [s \in Slots |-> "none"]
    /\ relay = [s \in Slots |-> "absent"]
    /\ pub = [s \in Slots |-> "none"]
    /\ pubGen = [s \in Slots |-> 0]
    /\ lease = "free"
    /\ opc = "idle"
    /\ cpc = [s \in Slots |-> "none"]
    /\ rpc = "idle"
    /\ crashes = 0
    /\ staleLaunch = FALSE

(* The narrow fence (`inspect_targets` + `Targets::current`): reserved
   incarnation, healthy, same boot (one boot here). *)
Current(s) == inc[s] = gen[s] /\ healthy[s]
AllCurrent == \A s \in Slots : Current(s)

(* ---------------- environment ---------------- *)
Replace(s) ==
    /\ inc[s] = 0
    /\ inc' = [inc EXCEPT ![s] = 1]
    /\ UNCHANGED <<healthy, gen, phase, relay, pub, pubGen, lease, opc, cpc,
                   rpc, crashes, staleLaunch>>
LoseHealth(s) ==
    /\ healthy[s]
    /\ healthy' = [healthy EXCEPT ![s] = FALSE]
    /\ UNCHANGED <<inc, gen, phase, relay, pub, pubGen, lease, opc, cpc,
                   rpc, crashes, staleLaunch>>

(* ---------------- owner: reservation and relay batch ---------------- *)
(* `reserve_publications`: one snapshot (healthy, current) and one save. *)
Reserve ==
    /\ opc = "idle" /\ lease = "free"
    /\ AllCurrent
    /\ phase = [s \in Slots |-> "none"]
    /\ phase' = [s \in Slots |-> "reserved"]
    /\ gen' = inc
    /\ opc' = "start"
    /\ UNCHANGED <<inc, healthy, relay, pub, pubGen, lease, cpc, rpc,
                   crashes, staleLaunch>>
OwnerAcquire ==
    /\ opc = "start" /\ lease = "free"
    /\ lease' = "owner" /\ opc' = "fence1"
    /\ UNCHANGED <<inc, healthy, gen, phase, relay, pub, pubGen, cpc, rpc,
                   crashes, staleLaunch>>
OwnerSet(next) ==
    /\ opc' = next
    /\ UNCHANGED <<inc, healthy, gen, phase, relay, pub, pubGen, lease, cpc,
                   rpc, crashes, staleLaunch>>
(* A refusal before any intent writes nothing and returns the lease. *)
OwnerRefuse ==
    /\ lease' = "free" /\ opc' = "failed"
    /\ UNCHANGED <<inc, healthy, gen, phase, relay, pub, pubGen, cpc, rpc,
                   crashes, staleLaunch>>
Fence1 ==
    /\ opc = "fence1"
    /\ IF AllCurrent THEN OwnerSet("fence2") ELSE OwnerRefuse
(* After reading every target's start ticks (one guest call, no effect). *)
Fence2 ==
    /\ opc = "fence2"
    /\ IF AllCurrent
       THEN OwnerSet(IF EnforceIntent THEN "intent" ELSE "relays")
       ELSE OwnerRefuse
(* One save records every relay intent as `starting`. *)
Intent ==
    /\ opc \in {"intent", "late"}
    /\ phase' = [s \in Slots |-> "starting"]
    /\ opc' = IF opc = "intent" THEN "relays" ELSE "fence3"
    /\ UNCHANGED <<inc, healthy, gen, relay, pub, pubGen, lease, cpc, rpc,
                   crashes, staleLaunch>>
(* One guest call starts every relay. *)
Relays ==
    /\ opc = "relays"
    /\ relay' = [s \in Slots |-> "running"]
    /\ opc' = IF EnforceIntent THEN "fence3" ELSE "late"
    /\ UNCHANGED <<inc, healthy, gen, phase, pub, pubGen, lease, cpc, rpc,
                   crashes, staleLaunch>>
(* Current slots become `running`; a stale slot is stopped through the
   ordinary durable stop (its publication, if any, is released first); the
   batch refuses if any slot was stale. The owner then gives up the lease. *)
Fence3 ==
    /\ opc = "fence3"
    /\ phase' = [s \in Slots |-> IF Current(s) THEN "running" ELSE "stopped"]
    /\ relay' = [s \in Slots |-> IF Current(s) THEN "running" ELSE "stopped"]
    /\ opc' = IF AllCurrent THEN "spawn" ELSE "failed"
    /\ lease' = "free"
    /\ UNCHANGED <<inc, healthy, gen, pub, pubGen, cpc, rpc, crashes,
                   staleLaunch>>
(* Every publisher child exists at once. *)
Spawn ==
    /\ opc = "spawn"
    /\ cpc' = [s \in Slots |-> "waiting"]
    /\ opc' = "await"
    /\ UNCHANGED <<inc, healthy, gen, phase, relay, pub, pubGen, lease, rpc,
                   crashes, staleLaunch>>
(* The owner observes every publication, or any child's refusal. *)
Await ==
    /\ opc = "await"
    /\ \/ /\ \A s \in Slots : cpc[s] = "done"
          /\ opc' = "ready"
       \/ /\ \E s \in Slots : cpc[s] = "refused"
          /\ opc' = "failed"
    /\ UNCHANGED <<inc, healthy, gen, phase, relay, pub, pubGen, lease, cpc,
                   rpc, crashes, staleLaunch>>
OwnerCrash ==
    /\ opc \notin {"idle", "ready", "failed", "crashed"}
    /\ crashes < MaxCrashes
    /\ opc' = "crashed"
    /\ lease' = IF lease = "owner" THEN "free" ELSE lease
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<inc, healthy, gen, phase, relay, pub, pubGen, cpc, rpc,
                   staleLaunch>>

(* ---------------- publisher children ---------------- *)
ChildAcquire(s) ==
    /\ cpc[s] = "waiting" /\ lease = "free"
    /\ lease' = s
    /\ cpc' = [cpc EXCEPT ![s] = "fence"]
    /\ UNCHANGED <<inc, healthy, gen, phase, relay, pub, pubGen, opc, rpc,
                   crashes, staleLaunch>>
(* `publish_bridge`: exact running reservation, narrow fence, relay inspect,
   then the journaled launch (the publisher's own crash phases are modeled by
   publication-journal). *)
ChildPublish(s) ==
    /\ cpc[s] = "fence" /\ lease = s
    /\ phase[s] = "running"
    /\ EnforceChildFence => (Current(s) /\ relay[s] = "running")
    /\ pub' = [pub EXCEPT ![s] = "live"]
    /\ pubGen' = [pubGen EXCEPT ![s] = inc[s]]
    /\ staleLaunch' = (staleLaunch \/ ~Current(s) \/ relay[s] # "running")
    /\ cpc' = [cpc EXCEPT ![s] = "done"]
    /\ lease' = "free"
    /\ UNCHANGED <<inc, healthy, gen, phase, relay, opc, rpc, crashes>>
ChildRefuse(s) ==
    /\ cpc[s] = "fence" /\ lease = s
    /\ ~(phase[s] = "running" /\ Current(s) /\ relay[s] = "running")
    /\ cpc' = [cpc EXCEPT ![s] = "refused"]
    /\ lease' = "free"
    /\ UNCHANGED <<inc, healthy, gen, phase, relay, pub, pubGen, opc, rpc,
                   crashes, staleLaunch>>

(* ---------------- cleanup: batched release ---------------- *)
Owned == {s \in Slots : phase[s] # "none"}
CleanSet(next) ==
    /\ rpc' = next
    /\ UNCHANGED <<inc, healthy, gen, phase, relay, pub, pubGen, lease, opc,
                   cpc, crashes, staleLaunch>>
CleanAcquire ==
    /\ opc \in {"failed", "crashed"}
    /\ rpc = "idle" /\ lease = "free"
    /\ lease' = "cleanup"
    /\ rpc' = IF EnforceReleaseOrder THEN "pubs" ELSE "stopping"
    /\ UNCHANGED <<inc, healthy, gen, phase, relay, pub, pubGen, opc, cpc,
                   crashes, staleLaunch>>
(* `release_reservations`: every host publication of the run, at once. *)
CleanPubs ==
    /\ rpc \in {"pubs", "late"} /\ lease = "cleanup"
    /\ pub' = [s \in Slots |-> IF pub[s] = "live" THEN "retired" ELSE pub[s]]
    /\ rpc' = IF rpc = "pubs" THEN "stopping" ELSE "stopped"
    /\ UNCHANGED <<inc, healthy, gen, phase, relay, pubGen, lease, opc, cpc,
                   crashes, staleLaunch>>
(* One save: same-boot relays not yet stopped become `stopping`. *)
CleanStopping ==
    /\ rpc = "stopping" /\ lease = "cleanup"
    /\ phase' = [s \in Slots |->
                   IF phase[s] \in {"starting", "running"} THEN "stopping"
                   ELSE phase[s]]
    /\ rpc' = "stop"
    /\ UNCHANGED <<inc, healthy, gen, relay, pub, pubGen, lease, opc, cpc,
                   crashes, staleLaunch>>
(* One guest call stops every relay recorded `stopping`. *)
CleanStop ==
    /\ rpc = "stop" /\ lease = "cleanup"
    /\ relay' = [s \in Slots |->
                   IF phase[s] = "stopping" THEN "stopped" ELSE relay[s]]
    /\ rpc' = IF EnforceReleaseOrder THEN "stopped" ELSE "late"
    /\ UNCHANGED <<inc, healthy, gen, phase, pub, pubGen, lease, opc, cpc,
                   crashes, staleLaunch>>
CleanStopped ==
    /\ rpc = "stopped" /\ lease = "cleanup"
    /\ phase' = [s \in Slots |->
                   IF phase[s] = "stopping" THEN "stopped" ELSE phase[s]]
    /\ rpc' = "remove"
    /\ UNCHANGED <<inc, healthy, gen, relay, pub, pubGen, lease, opc, cpc,
                   crashes, staleLaunch>>
(* One guest call removes every stopped allocation. *)
CleanRemove ==
    /\ rpc = "remove" /\ lease = "cleanup"
    /\ relay' = [s \in Slots |->
                   IF phase[s] = "stopped" THEN "absent" ELSE relay[s]]
    /\ rpc' = "drop"
    /\ UNCHANGED <<inc, healthy, gen, phase, pub, pubGen, lease, opc, cpc,
                   crashes, staleLaunch>>
(* One save drops every slot of the run. *)
CleanDrop ==
    /\ rpc = "drop" /\ lease = "cleanup"
    /\ phase' = [s \in Slots |-> "none"]
    /\ rpc' = "done" /\ lease' = "free"
    /\ UNCHANGED <<inc, healthy, gen, relay, pub, pubGen, opc, cpc, crashes,
                   staleLaunch>>
(* A crashed cleanup restarts from its first step on the durable phases. *)
CleanCrash ==
    /\ rpc \notin {"idle", "done"}
    /\ crashes < MaxCrashes
    /\ rpc' = "idle"
    /\ lease' = IF lease = "cleanup" THEN "free" ELSE lease
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<inc, healthy, gen, phase, relay, pub, pubGen, opc, cpc,
                   staleLaunch>>

Next ==
    \/ \E s \in Slots : Replace(s) \/ LoseHealth(s)
    \/ Reserve \/ OwnerAcquire \/ Fence1 \/ Fence2 \/ Intent \/ Relays
    \/ Fence3 \/ Spawn \/ Await \/ OwnerCrash
    \/ \E s \in Slots : ChildAcquire(s) \/ ChildPublish(s) \/ ChildRefuse(s)
    \/ CleanAcquire \/ CleanPubs \/ CleanStopping \/ CleanStop
    \/ CleanStopped \/ CleanRemove \/ CleanDrop \/ CleanCrash

Spec == Init /\ [][Next]_vars

(* ---------------- properties ---------------- *)
(* No guest relay exists without its durable intent. *)
IntentBeforeEffect ==
    \A s \in Slots : relay[s] = "running" =>
        phase[s] \in {"starting", "running", "stopping"}
(* A host listener is only ever launched to a running relay whose target is
   still the reserved, healthy incarnation. *)
NoStalePublication == ~staleLaunch
(* A relay is never stopped while its host listener still serves. *)
ListenerClosedBeforeRelayStop ==
    \A s \in Slots : relay[s] = "stopped" => pub[s] # "live"
(* A completed release leaves no guest relay and no live listener. *)
ReleaseComplete ==
    rpc = "done" => \A s \in Slots : relay[s] = "absent" /\ pub[s] # "live"
(* Ready means every bridge of the batch was published. *)
ReadyComplete ==
    opc = "ready" => \A s \in Slots : pub[s] = "live" /\ phase[s] = "running"
Safe ==
    /\ IntentBeforeEffect
    /\ NoStalePublication
    /\ ListenerClosedBeforeRelayStop
    /\ ReleaseComplete
    /\ ReadyComplete

(* Reachability witnesses: each must be violated by its control. *)
NeverReady == opc # "ready"
NeverReleased == rpc # "done"
NeverStaleStop == ~(opc = "failed" /\ \E s \in Slots :
                      phase[s] = "stopped" /\ \E t \in Slots : phase[t] = "running")
=============================================================================
