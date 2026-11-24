---------------- MODULE BridgeSlots ----------------
(* Application bridge slots shared by two project runs in one running pool (U13).

   The pool has a fixed number of slots (`Capacity`); a running pool is never
   resized. Each run asks for `need` slots for its routes and published ports.
   A start has two steps:
   - `Check`: `runtime up --minimum-bridge-sockets` reads the validated slot
     registry under the startup lease and refuses early when the slots other
     runs hold leave too few (`graph/bridges.rs` `require_free_slots`). It
     reserves nothing.
   - `Reserve`: graph start reserves every slot of the run in one registry
     update under the provider mutation lock (`reserve_publications`,
     `bridge_capacity_exhausted` with "no ports were reserved"). This is the
     authority.
   A run that stops releases all its slots (`release_run`).

   Guards, each turned off by one negative control:
   - EnforceFreeCheck: the early check counts the slots other runs hold, not
     only the pool's total capacity.
   - EnforceAtomic: a reservation that cannot take every slot takes none.
   - EnforceReserveCheck: a reservation takes only free slots, whatever the
     early check said.

   Ghosts: `raced[r]` records that another run reserved slots after `r` passed
   its check; `stolen` that a reservation took a slot another run held. *)
EXTENDS Naturals, FiniteSets
CONSTANTS Capacity, MaxNeed, EnforceFreeCheck, EnforceAtomic, EnforceReserveCheck
Runs == {"a", "b"}
Slots == 1..Capacity
Phases == {"idle", "checked", "running", "refused", "failed"}
VARIABLES holder, phase, need, raced, stolen
vars == <<holder, phase, need, raced, stolen>>

Held(r) == {s \in Slots : holder[s] = r}
Free == {s \in Slots : holder[s] = "none"}
HeldByOthers(r) == {s \in Slots : holder[s] \notin {"none", r}}

TypeOK ==
    /\ holder \in [Slots -> Runs \cup {"none"}]
    /\ phase \in [Runs -> Phases]
    /\ need \in [Runs -> 0..MaxNeed]
    /\ raced \in [Runs -> BOOLEAN]
    /\ stolen \in BOOLEAN

Init ==
    /\ holder = [s \in Slots |-> "none"]
    /\ phase = [r \in Runs |-> "idle"]
    /\ need = [r \in Runs |-> 0]
    /\ raced = [r \in Runs |-> FALSE]
    /\ stolen = FALSE

(* `hack up`: the CLI counts the project's routes and ports, and `runtime up`
   checks them against the running pool. *)
Check(r, n) ==
    /\ phase[r] \in {"idle", "refused", "failed"}
    /\ Held(r) = {}
    /\ need' = [need EXCEPT ![r] = n]
    /\ raced' = [raced EXCEPT ![r] = FALSE]
    /\ LET fits == IF EnforceFreeCheck
                   THEN n <= Capacity - Cardinality(HeldByOthers(r))
                   ELSE n <= Capacity
       IN phase' = [phase EXCEPT ![r] = IF fits THEN "checked" ELSE "refused"]
    /\ UNCHANGED <<holder, stolen>>

(* The lowest `k` slots of a set, as `reserve_publications` allocates them. *)
RECURSIVE Lowest(_, _)
Lowest(set, k) ==
    IF k = 0 \/ set = {} THEN {}
    ELSE LET low == CHOOSE s \in set : \A t \in set : s <= t
         IN {low} \cup Lowest(set \ {low}, k - 1)

(* Graph start: one registry update under the provider mutation lock. *)
Reserve(r) ==
    /\ phase[r] = "checked"
    /\ LET pool == IF EnforceReserveCheck THEN Free ELSE Slots \ Held(r)
           taken == Lowest(pool, need[r])
           whole == Cardinality(taken) = need[r]
           granted == IF whole \/ ~EnforceAtomic THEN taken ELSE {}
       IN /\ holder' = [s \in Slots |-> IF s \in granted THEN r ELSE holder[s]]
          /\ phase' = [phase EXCEPT ![r] = IF whole THEN "running" ELSE "failed"]
          /\ stolen' = (stolen \/ \E s \in granted : holder[s] \notin {"none", r})
          /\ raced' = [o \in Runs |->
                IF o # r /\ phase[o] = "checked" /\ granted # {} THEN TRUE
                ELSE raced[o]]
    /\ UNCHANGED need

(* `hack down`, or cleanup of a failed start: every slot of the run is released. *)
Release(r) ==
    /\ phase[r] \in {"running", "failed"}
    /\ holder' = [s \in Slots |-> IF holder[s] = r THEN "none" ELSE holder[s]]
    /\ phase' = [phase EXCEPT ![r] = "idle"]
    /\ UNCHANGED <<need, raced, stolen>>

Next ==
    \E r \in Runs :
        \/ \E n \in 1..MaxNeed : Check(r, n)
        \/ Reserve(r)
        \/ Release(r)

Spec == Init /\ [][Next]_vars

(* A run that was refused, or whose start failed, holds no slot. A failed start
   is released by its cleanup, so "failed" is checked before that release. *)
NothingHeldWithoutStart ==
    \A r \in Runs : phase[r] \in {"idle", "checked", "refused", "failed"} => Held(r) = {}

(* No slot is ever taken from another run. *)
NoSteal == ~stolen

(* A running run holds exactly the slots it asked for. *)
RunningHoldsNeed ==
    \A r \in Runs : phase[r] = "running" => Cardinality(Held(r)) = need[r]

(* A start that passed the early check fails at reservation only when another
   run reserved slots in between: the check is advisory, never wrong alone. *)
LateFailureOnlyOnRace ==
    \A r \in Runs : phase[r] = "failed" => raced[r]

(* Violated by the `both-running` control: two projects do run side by side. *)
NeverBothRunning == ~(\A r \in Runs : phase[r] = "running")

Safe ==
    /\ NothingHeldWithoutStart
    /\ NoSteal
    /\ RunningHoldsNeed
    /\ LateFailureOnlyOnRace
=====================================================
