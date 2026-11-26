----------------------------- MODULE LeaseWait -----------------------------
EXTENDS Naturals
\* Bound: the waiter's budget in ticks. StopHold: the most ticks the first
\* holder keeps the lock (HACK-2724: another project's stop holds it for its
\* whole graph stop). EnforceOwnership = FALSE is the negative control.
CONSTANT Bound, StopHold, EnforceOwnership
VARIABLES holder, waiter, elapsed, earlyEffect
vars == <<holder, waiter, elapsed, earlyEffect>>
Init == /\ holder = "first" /\ waiter = "waiting"
        /\ elapsed = 0 /\ earlyEffect = FALSE
Release == /\ holder = "first" /\ holder' = "free"
           /\ UNCHANGED <<waiter, elapsed, earlyEffect>>
\* Time passes for the waiter only while the first holder still has the lock,
\* and that holder keeps it for at most StopHold ticks. The waiter polls every
\* 5 to 50 ms, so it does not sit on a free lock while a tick passes.
Tick == /\ waiter = "waiting" /\ elapsed < Bound
        /\ holder = "first" /\ elapsed < StopHold
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
    /\ WF_vars(Acquire \/ Tick \/ Expire) /\ WF_vars(Release)
NoEffectWhileHeld == ~earlyEffect
NoAdmissionAfterDeadline == waiter = "acquired" => elapsed < Bound
Settles == waiter = "waiting" ~> waiter # "waiting"
NeverAcquired == waiter # "acquired"
NeverExpired == waiter # "expired"
\* A holder that releases inside the waiter's budget never causes a refusal.
StopNeverRefuses == waiter # "expired"
=============================================================================
