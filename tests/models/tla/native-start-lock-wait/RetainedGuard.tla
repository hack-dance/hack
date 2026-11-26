---------------------------- MODULE RetainedGuard ----------------------------
EXTENDS Naturals
\* Two projects' retained starts, a and b, on one stopped pool (HACK-2732).
\* Each takes a selection in its preflight (`graph retained-preflight`), then
\* asks `runtime up` to start the pool bound to it. The startup lease is held
\* by a start for its whole boot.
\*
\* GuardUnderLease: the retained guard reads eligibility and compares the
\*   selection only under the startup lease. FALSE is the old order (the
\*   guard before the lease), the negative control.
\* JoinChanged: a selection that differs from the pool only by its boots is
\*   refused `graph_retained_pool_changed`; the CLI selects again and retries
\*   `runtime up` once. FALSE refuses it like any other change.
\* Replace: the pool's owner may be replaced while it is stopped (a new token,
\*   machine and disks). The run's receipt names the original token.
CONSTANT GuardUnderLease, JoinChanged, Replace
Starts == {"a", "b"}
Done == {"booted", "joined", "refused"}
VARIABLES pool, boots, token, lease, pc, sel, retried
vars == <<pool, boots, token, lease, pc, sel, retried>>

\* The pool as a selection binds it: its stable identity (the token), and
\* what every boot or stop rewrites (the boot count and the phase).
Current == <<token, boots, pool>>
\* `checked`: the run is retained-startable on this pool. A pool that is
\* booting is not, and a replaced owner's token does not match the receipt.
Eligible == pool \in {"stopped", "running"} /\ token = 0
NoSelection == <<0, 0, "none">>

Init == /\ pool = "stopped" /\ boots = 0 /\ token = 0 /\ lease = "free"
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
    /\ UNCHANGED <<pool, boots, token, lease, retried>>

\* The old order only: `runtime up` checked the guard before its lease.
EarlyGuard(s) ==
    /\ ~GuardUnderLease
    /\ pc[s] = "up"
    /\ pc' = [pc EXCEPT ![s] = IF Eligible /\ Current = sel[s]
                                 THEN "waiting" ELSE "refused"]
    /\ UNCHANGED <<pool, boots, token, lease, sel, retried>>

\* Under the startup lease: boot a stopped pool, join a running one, or find
\* the selection stale. A stale selection whose stable identity still holds is
\* a changed pool, selected again once; anything else refuses.
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
    /\ UNCHANGED <<token, sel>>

FinishBoot(s) ==
    /\ pc[s] = "booting"
    /\ pool' = "running" /\ lease' = "free"
    /\ pc' = [pc EXCEPT ![s] = "booted"]
    /\ UNCHANGED <<boots, token, sel, retried>>

ReplaceOwner ==
    /\ Replace /\ token = 0 /\ pool = "stopped" /\ lease = "free"
    /\ token' = 1
    /\ UNCHANGED <<pool, boots, lease, pc, sel, retried>>

Next == ReplaceOwner \/ \E s \in Starts :
    Preflight(s) \/ EarlyGuard(s) \/ Leased(s) \/ FinishBoot(s)
Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

\* Both starts reach their pool: one boots it, the other joins.
NoRefusal == \A s \in Starts : pc[s] # "refused"
OneBoot == boots <= 1
\* A start acts only on the pool its selection named: never on a replaced
\* owner, and never on a pool it did not check under the lease.
StartsOnItsPool ==
    \A s \in Starts : pc[s] \in {"booting", "booted", "joined"} =>
        /\ token = 0 /\ sel[s][1] = token
Settles == <>(\A s \in Starts : pc[s] \in Done)
\* Reachability control: a start selects again after a peer's boot, then
\* joins the pool that peer booted.
NeverJoinedAfterRetry == \A s \in Starts : ~(retried[s] /\ pc[s] = "joined")
=============================================================================
