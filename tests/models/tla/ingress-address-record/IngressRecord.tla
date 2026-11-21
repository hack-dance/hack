------------------------- MODULE IngressRecord -------------------------
(* Hack's record of the global proxy/DNS addresses
   (src/lib/proxy-ingress-addresses.ts). `hack run` trusts a valid record
   without asking Docker; `up`, `run` (no record) and `hack global up` read
   Docker once and write the record. `hack global up/down` and the doctor
   proxy repair change the stack.

   A read is two steps (inspect, then write), so a Hack change can land
   between them. Hack therefore keeps a generation token: a change first
   marks it unsettled with a new value, applies the effect, then settles it
   with another new value. A reader records the token it read before its
   inspect; a record is valid only if its token is the current one and that
   token is settled. A crash mid-change leaves the token unsettled, so no
   record is trusted until the next settled change (every run reads Docker).

   Changes are serialized by a cross-process lock (`ingress-change.lock`,
   reclaimed only from a dead owner): two changers each run once, and either
   may crash at any point, releasing the lock but not settling the token.

   External changes (a container recreated outside Hack) are not detected;
   a failed run's single check refreshes them (not modelled here). *)
EXTENDS Naturals, FiniteSets
CONSTANTS Readers, Changers, MaxGen, UseGeneration, UseSettled, UseLock
Addrs == 1..2          \* possible addresses; 0 = stack stopped
NoRecord == [has |-> FALSE, addr |-> 0, gen |-> 0]

VARIABLES stack, gen, settled, record, pc, pgen, paddr,
          extSinceObserve, extSinceWrite, holder, cpc
vars == <<stack, gen, settled, record, pc, pgen, paddr,
          extSinceObserve, extSinceWrite, holder, cpc>>
readerVars == <<record, pc, pgen, paddr, extSinceObserve, extSinceWrite>>

Init == /\ stack \in {0} \cup Addrs /\ gen = 0 /\ settled = TRUE
        /\ record = NoRecord
        /\ pc = [p \in Readers |-> "idle"]
        /\ pgen = [p \in Readers |-> 0]
        /\ paddr = [p \in Readers |-> 0]
        /\ extSinceObserve = [p \in Readers |-> FALSE]
        /\ extSinceWrite = FALSE
        /\ holder = "none"
        /\ cpc = [c \in Changers |-> "idle"]

\* A record counts for `hack run` only under the current settled token.
Valid(r) == IF UseGeneration
              THEN r.has /\ r.gen = gen /\ (UseSettled => settled)
              ELSE r.has

\* hack global up/down, doctor repair: lock, unsettle, apply, settle, unlock.
HackBegin(c) == /\ cpc[c] = "idle" /\ gen + 1 <= MaxGen
                /\ (UseLock => holder = "none")
                /\ holder' = c
                /\ gen' = gen + 1 /\ settled' = FALSE
                /\ cpc' = [cpc EXCEPT ![c] = "begun"]
                /\ UNCHANGED <<stack, readerVars>>
HackApply(c) == /\ cpc[c] = "begun"
                /\ \E a \in {0} \cup Addrs : stack' = a
                /\ cpc' = [cpc EXCEPT ![c] = "applied"]
                /\ UNCHANGED <<gen, settled, holder, readerVars>>
HackEnd(c) == /\ cpc[c] \in {"begun", "applied"} /\ gen + 1 <= MaxGen
              /\ gen' = gen + 1 /\ settled' = TRUE
              /\ cpc' = [cpc EXCEPT ![c] = "done"]
              /\ holder' = IF holder = c THEN "none" ELSE holder
              /\ UNCHANGED <<stack, readerVars>>
\* The changer dies; its lock is reclaimed, its token stays unsettled.
Crash(c) == /\ cpc[c] \in {"begun", "applied"}
            /\ cpc' = [cpc EXCEPT ![c] = "crashed"]
            /\ holder' = IF holder = c THEN "none" ELSE holder
            /\ UNCHANGED <<stack, gen, settled, readerVars>>

\* A container recreated outside Hack: undetectable without asking Docker.
External == /\ \E a \in {0} \cup Addrs : a # stack /\ stack' = a
            /\ extSinceObserve' = [p \in Readers |-> TRUE]
            /\ extSinceWrite' = TRUE
            /\ UNCHANGED <<gen, settled, record, pc, pgen, paddr, holder, cpc>>

\* A fresh read: capture the token, inspect, then write or forget.
ReadToken(p) == /\ pc[p] = "idle"
                /\ pc' = [pc EXCEPT ![p] = "inspect"]
                /\ pgen' = [pgen EXCEPT ![p] = gen]
                /\ UNCHANGED <<stack, gen, settled, record, paddr,
                               extSinceObserve, extSinceWrite, holder, cpc>>
Inspect(p) == /\ pc[p] = "inspect"
              /\ pc' = [pc EXCEPT ![p] = "write"]
              /\ paddr' = [paddr EXCEPT ![p] = stack]
              /\ extSinceObserve' = [extSinceObserve EXCEPT ![p] = FALSE]
              /\ UNCHANGED <<stack, gen, settled, record, pgen,
                             extSinceWrite, holder, cpc>>
Write(p) == /\ pc[p] = "write"
            /\ pc' = [pc EXCEPT ![p] = "idle"]
            /\ IF paddr[p] = 0
                 THEN /\ record' = NoRecord          \* confirmed absence
                      /\ extSinceWrite' = FALSE
                 ELSE /\ record' = [has |-> TRUE, addr |-> paddr[p],
                                    gen |-> pgen[p]]
                      /\ extSinceWrite' = extSinceObserve[p]
            /\ UNCHANGED <<stack, gen, settled, pgen, paddr,
                           extSinceObserve, holder, cpc>>

Next == \/ \E c \in Changers :
          HackBegin(c) \/ HackApply(c) \/ HackEnd(c) \/ Crash(c)
        \/ External
        \/ \E p \in Readers : ReadToken(p) \/ Inspect(p) \/ Write(p)
Spec == Init /\ [][Next]_vars

TypeOK == /\ stack \in {0} \cup Addrs /\ gen \in 0..MaxGen
          /\ settled \in BOOLEAN
          /\ record \in [has : BOOLEAN, addr : {0} \cup Addrs, gen : 0..MaxGen]
          /\ pc \in [Readers -> {"idle", "inspect", "write"}]
          /\ holder \in Changers \cup {"none"}

(* A record `hack run` would trust names the running address, unless a
   change outside Hack happened after the observation it came from. *)
TrustedRecordIsCurrent ==
    (Valid(record) /\ ~extSinceWrite) => record.addr = stack
=======================================================================
