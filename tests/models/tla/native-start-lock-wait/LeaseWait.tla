----------------------------- MODULE LeaseWait -----------------------------
EXTENDS Naturals
CONSTANT Bound, EnforceOwnership
VARIABLES holder, waiter, elapsed, earlyEffect
vars == <<holder, waiter, elapsed, earlyEffect>>
Init == /\ holder = "first" /\ waiter = "waiting"
        /\ elapsed = 0 /\ earlyEffect = FALSE
Release == /\ holder = "first" /\ holder' = "free"
           /\ UNCHANGED <<waiter, elapsed, earlyEffect>>
Tick == /\ waiter = "waiting" /\ elapsed < Bound
        /\ elapsed' = elapsed + 1
        /\ UNCHANGED <<holder, waiter, earlyEffect>>
Acquire == /\ waiter = "waiting" /\ elapsed < Bound
           /\ (EnforceOwnership => holder = "free")
           /\ earlyEffect' = (holder # "free")
           /\ holder' = "second" /\ waiter' = "acquired"
           /\ UNCHANGED elapsed
Expire == /\ waiter = "waiting" /\ elapsed = Bound
          /\ waiter' = "expired"
          /\ UNCHANGED <<holder, elapsed, earlyEffect>>
Next == Release \/ Tick \/ Acquire \/ Expire
Spec == Init /\ [][Next]_vars
    /\ WF_vars(Acquire \/ Tick \/ Expire)
NoEffectWhileHeld == ~earlyEffect
NoAdmissionAfterDeadline == waiter = "acquired" => elapsed < Bound
Settles == waiter = "waiting" ~> waiter # "waiting"
NeverAcquired == waiter # "acquired"
NeverExpired == waiter # "expired"
=============================================================================
