---------------------------- MODULE RetainedGuard ----------------------------
EXTENDS Naturals
\* Retained starts of different projects on one stopped pool (HACK-2732).
\* Each takes a selection in its preflight (`graph retained-preflight`), then
\* asks `runtime up` to start the pool bound to it. The startup lease is held
\* by a start for its whole boot.
\*
\* Starts: the starting projects (two, or three).
\* GuardUnderLease: the retained guard reads eligibility and compares the
\*   selection only under the startup lease. FALSE is the old order (the
\*   guard before the lease), the negative control.
\* JoinChanged: a selection that differs from the pool only outside its stable
\*   identity is refused `graph_retained_pool_changed`; the CLI selects again
\*   and retries `runtime up` once. FALSE refuses it like any other change.
\* Replace: the pool's owner may be replaced while it is stopped (a new token,
\*   machine and disks). The run's receipt names the original token.
\* PeerChanges: how often another project may change the pool outside these
\*   runs' identity while no start holds the lease (its own share added, which
\*   stops an idle pool; a network or capacity change).
CONSTANT Starts, GuardUnderLease, JoinChanged, Replace, PeerChanges
Done == {"booted", "joined", "refused"}
VARIABLES pool, boots, token, peer, lease, pc, sel, retried
vars == <<pool, boots, token, peer, lease, pc, sel, retried>>

\* The pool as a selection binds it: its stable identity (the token), and
\* what boots, stops and other projects rewrite (boots, phase, peer changes).
Current == <<token, boots, pool, peer>>
\* `checked`: the run is retained-startable on this pool. A pool that is
\* booting is not, and a replaced owner's token does not match the receipt.
Eligible == pool \in {"stopped", "running"} /\ token = 0
NoSelection == <<0, 0, "none", 0>>

Init == /\ pool = "stopped" /\ boots = 0 /\ token = 0 /\ peer = 0
        /\ lease = "free"
        /\ pc = [s \in Starts |-> "preflight"]
        /\ sel = [s \in Starts |-> NoSelection]
        /\ retried = [s \in Starts |-> FALSE]

\* The preflight: under the lease (taken and released in one step) or, in the
\* old order, before it, so it can see a peer's boot in progress.
Preflight(s) ==
    /\ pc[s] = "preflight"
    /\ GuardUnderLease => lease = "free"
    /\ IF Eligible
         THEN /\ sel' = [sel EXCEPT ![s] = Current]
              /\ pc' = [pc EXCEPT ![s] = "up"]
         ELSE /\ pc' = [pc EXCEPT ![s] = "refused"]
              /\ UNCHANGED sel
    /\ UNCHANGED <<pool, boots, token, peer, lease, retried>>

\* The old order only: `runtime up` checked the guard before its lease.
EarlyGuard(s) ==
    /\ ~GuardUnderLease
    /\ pc[s] = "up"
    /\ pc' = [pc EXCEPT ![s] = IF Eligible /\ Current = sel[s]
                                 THEN "waiting" ELSE "refused"]
    /\ UNCHANGED <<pool, boots, token, peer, lease, sel, retried>>

\* Under the startup lease: boot a stopped pool, join a running one, or find
\* the selection stale. A stale selection whose stable identity still holds is
\* a changed pool, selected again once; anything else refuses. A second change
\* is reported as it comes, naming the retry (`hack up` again).
Leased(s) ==
    /\ pc[s] = IF GuardUnderLease THEN "up" ELSE "waiting"
    /\ lease = "free"
    /\ IF Eligible /\ Current = sel[s]
         THEN IF pool = "stopped"
                THEN /\ pool' = "booting" /\ boots' = boots + 1
                     /\ lease' = s
                     /\ pc' = [pc EXCEPT ![s] = "booting"]
                     /\ UNCHANGED retried
                ELSE /\ pc' = [pc EXCEPT ![s] = "joined"]
                     /\ UNCHANGED <<pool, boots, lease, retried>>
         ELSE IF JoinChanged /\ Eligible /\ sel[s][1] = token /\ ~retried[s]
                THEN /\ pc' = [pc EXCEPT ![s] = "preflight"]
                     /\ retried' = [retried EXCEPT ![s] = TRUE]
                     /\ UNCHANGED <<pool, boots, lease>>
                ELSE /\ pc' = [pc EXCEPT ![s] = "refused"]
                     /\ UNCHANGED <<pool, boots, lease, retried>>
    /\ UNCHANGED <<token, peer, sel>>

FinishBoot(s) ==
    /\ pc[s] = "booting"
    /\ pool' = "running" /\ lease' = "free"
    /\ pc' = [pc EXCEPT ![s] = "booted"]
    /\ UNCHANGED <<boots, token, peer, sel, retried>>

ReplaceOwner ==
    /\ Replace /\ token = 0 /\ pool = "stopped" /\ lease = "free"
    /\ token' = 1
    /\ UNCHANGED <<pool, boots, peer, lease, pc, sel, retried>>

\* Another project's change outside these runs' identity, under its own lease.
PeerChange ==
    /\ peer < PeerChanges /\ lease = "free" /\ pool # "booting"
    /\ peer' = peer + 1
    /\ UNCHANGED <<pool, boots, token, lease, pc, sel, retried>>

Next == ReplaceOwner \/ PeerChange \/ \E s \in Starts :
    Preflight(s) \/ EarlyGuard(s) \/ Leased(s) \/ FinishBoot(s)
Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

\* Every start reaches the pool: one boots it, the others join.
NoRefusal == \A s \in Starts : pc[s] # "refused"
OneBoot == boots <= 1
\* A start acts only on the pool its selection named: never on a replaced owner.
StartsOnItsPool ==
    \A s \in Starts : pc[s] \in {"booting", "booted", "joined"} =>
        /\ token = 0 /\ sel[s][1] = token
\* With the guard under the lease and the retry, a start refuses only for a
\* replaced owner, or after its one retry met another change.
RefusedOnlyAfterRetry ==
    \A s \in Starts : pc[s] = "refused" => token # 0 \/ retried[s]
Settles == <>(\A s \in Starts : pc[s] \in Done)
\* Reachability control: a start selects again after a change, then joins
\* the pool another start booted.
NeverJoinedAfterRetry == \A s \in Starts : ~(retried[s] /\ pc[s] = "joined")
=============================================================================
