---------------- MODULE LoopbackPort ----------------
(* Loopback TCP publication of one reviewed Compose host port.

   Owners "a" and "b" are foreground graph owners that both declare the same
   host port; "foreign" is an unrelated host process. An owner publishes by
   recording its publication entry and binding the host listener (one step:
   `publication::launch` writes the entry before exec, and the real probe/bind
   window is not modeled). The listener forwards through a bridge pinned to the
   container incarnation that was current when it was published.

   Guards, each turned off by one negative control:
   - EnforceProbe: refuse when any listener already accepts on loopback
     (`publication::require_loopback_port_free`, TS preflight).
   - EnforceIdentity: forward only to the pinned incarnation (bridge endpoint
     generation and pinned relay target).
   - EnforceOrder: close the host listener before retiring and acknowledging
     stop (`publication::release` before guest bridge stop).
   - EnforceDeadOwner: recovery retires an entry only for a dead owner
     (dead-owner cleanup, `publisher::stop` by exact identity). *)
EXTENDS Naturals, FiniteSets
CONSTANTS EnforceProbe, EnforceIdentity, EnforceOrder, EnforceDeadOwner
Owners == {"a", "b"}
Entries == {"none", "bound", "stopping", "retired"}
VARIABLES holders, entry, alive, incarnation, target,
          shared, staleForward, retiredLive, ackedListening
vars == <<holders, entry, alive, incarnation, target,
          shared, staleForward, retiredLive, ackedListening>>
others == <<shared, staleForward, retiredLive, ackedListening>>

TypeOK ==
    /\ holders \subseteq (Owners \cup {"foreign"})
    /\ entry \in [Owners -> Entries]
    /\ alive \in [Owners -> BOOLEAN]
    /\ incarnation \in [Owners -> 0..1]
    /\ target \in [Owners -> 0..1]
    /\ {shared, staleForward, retiredLive, ackedListening} \subseteq BOOLEAN

Init ==
    /\ holders = {}
    /\ entry = [o \in Owners |-> "none"]
    /\ alive = [o \in Owners |-> TRUE]
    /\ incarnation = [o \in Owners |-> 0]
    /\ target = [o \in Owners |-> 0]
    /\ shared = FALSE /\ staleForward = FALSE
    /\ retiredLive = FALSE /\ ackedListening = FALSE

(* An unrelated wildcard listener appears or goes away. *)
ForeignBind ==
    /\ holders = {}
    /\ holders' = {"foreign"}
    /\ UNCHANGED <<entry, alive, incarnation, target, others>>
ForeignRelease ==
    /\ "foreign" \in holders
    /\ holders' = holders \ {"foreign"}
    /\ UNCHANGED <<entry, alive, incarnation, target, others>>

(* The pool journal admits one live entry per host port across owners. *)
Publish(o) ==
    /\ alive[o]
    /\ entry[o] \in {"none", "retired"}
    /\ \A p \in Owners \ {o} : entry[p] \in {"none", "retired"}
    /\ o \notin holders
    /\ EnforceProbe => holders = {}
    /\ shared' = (shared \/ holders # {})
    /\ holders' = holders \cup {o}
    /\ entry' = [entry EXCEPT ![o] = "bound"]
    /\ target' = [target EXCEPT ![o] = incarnation[o]]
    /\ UNCHANGED <<alive, incarnation, staleForward, retiredLive, ackedListening>>

(* The container is replaced (restart or recreate) while published. *)
Replace(o) ==
    /\ incarnation[o] = 0
    /\ incarnation' = [incarnation EXCEPT ![o] = 1]
    /\ UNCHANGED <<holders, entry, alive, target, others>>

(* A host connection is forwarded through the bridge. *)
Forward(o) ==
    /\ o \in holders
    /\ entry[o] = "bound"
    /\ EnforceIdentity => target[o] = incarnation[o]
    /\ staleForward' = (staleForward \/ target[o] # incarnation[o])
    /\ UNCHANGED <<holders, entry, alive, incarnation, target,
                   shared, retiredLive, ackedListening>>

(* Ordered stop by the live owner: close the listener, then retire. *)
CloseListener(o) ==
    /\ alive[o]
    /\ o \in holders
    /\ entry[o] = "bound"
    /\ holders' = holders \ {o}
    /\ entry' = [entry EXCEPT ![o] = "stopping"]
    /\ UNCHANGED <<alive, incarnation, target, others>>
Retire(o) ==
    /\ alive[o]
    /\ entry[o] \in IF EnforceOrder THEN {"stopping"} ELSE {"bound", "stopping"}
    /\ EnforceOrder => o \notin holders
    /\ ackedListening' = (ackedListening \/ o \in holders)
    /\ entry' = [entry EXCEPT ![o] = "retired"]
    /\ incarnation' = [incarnation EXCEPT ![o] = 0]
    /\ UNCHANGED <<holders, alive, target, shared, staleForward, retiredLive>>

(* The owner dies; its publisher child may survive it. *)
Crash(o) ==
    /\ alive[o]
    /\ alive' = [alive EXCEPT ![o] = FALSE]
    /\ UNCHANGED <<holders, entry, incarnation, target, others>>
PublisherExit(o) ==
    /\ o \in holders
    /\ holders' = holders \ {o}
    /\ UNCHANGED <<entry, alive, incarnation, target, others>>

(* Dead-owner cleanup stops the exact publisher, then retires the entry. *)
Recover(o) ==
    /\ entry[o] \in {"bound", "stopping"}
    /\ EnforceDeadOwner => ~alive[o]
    /\ retiredLive' = (retiredLive \/ alive[o])
    /\ holders' = holders \ {o}
    /\ entry' = [entry EXCEPT ![o] = "retired"]
    /\ UNCHANGED <<alive, incarnation, target, shared, staleForward, ackedListening>>

Next ==
    \/ ForeignBind \/ ForeignRelease
    \/ \E o \in Owners :
        \/ Publish(o) \/ Replace(o) \/ Forward(o) \/ CloseListener(o)
        \/ Retire(o) \/ Crash(o) \/ PublisherExit(o) \/ Recover(o)

(* Every owner listener is journaled, and the four safety properties hold:
   one listener per host port, no forwarding to a replaced incarnation, no
   retirement of a live owner's publication, no listener after acknowledged
   stop. *)
ListenerJournaled == \A o \in Owners : o \in holders => entry[o] \in {"bound", "stopping"}
OneListener == Cardinality(holders) <= 1
Safe ==
    /\ ListenerJournaled
    /\ OneListener
    /\ ~shared /\ ~staleForward /\ ~retiredLive /\ ~ackedListening

Spec == Init /\ [][Next]_vars
====================================================
