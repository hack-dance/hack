----------------------------- MODULE LeaseWait -----------------------------
EXTENDS Naturals
\* Bound: the waiter's budget in ticks. StopHold: the most ticks the first
\* holder keeps the lock (HACK-2724: another project's stop holds it for its
\* whole graph stop). EnforceOwnership = FALSE is the negative control.
\* ResumeRunning: a boot that finds, under the lock, that the first holder
\* booted the pool resumes it instead of refusing (HACK-2724 review).
CONSTANT Bound, StopHold, EnforceOwnership, ResumeRunning
VARIABLES holder, waiter, elapsed, earlyEffect, pool
vars == <<holder, waiter, elapsed, earlyEffect, pool>>
Init == /\ holder = "first" /\ waiter = "waiting"
        /\ elapsed = 0 /\ earlyEffect = FALSE /\ pool = "stopped"
\* The first holder releases. A stop leaves the pool as it was; a concurrent
\* start's boot leaves it running.
Release == /\ holder = "first" /\ holder' = "free"
           /\ pool' \in {"stopped", "running"}
           /\ UNCHANGED <<waiter, elapsed, earlyEffect>>
\* Time passes for the waiter only while the first holder still has the lock,
\* and that holder keeps it for at most StopHold ticks. The waiter polls every
\* 5 to 50 ms, so it does not sit on a free lock while a tick passes.
Tick == /\ waiter = "waiting" /\ elapsed < Bound
        /\ holder = "first" /\ elapsed < StopHold
        /\ elapsed' = elapsed + 1
        /\ UNCHANGED <<holder, waiter, earlyEffect, pool>>
\* Under the lock the waiter reads the pool first: a stopped pool is its own
\* to boot; a running one is resumed, or, without ResumeRunning, its rechecks
\* refuse against the stopped pool it selected (admission_owner_changed).
Acquire == /\ waiter = "waiting" /\ elapsed < Bound
           /\ (EnforceOwnership => holder = "free")
           /\ earlyEffect' = (holder # "free")
           /\ holder' = "second"
           /\ waiter' = CASE pool = "stopped" -> "acquired"
                          [] ResumeRunning -> "resumed"
                          [] OTHER -> "refused"
           /\ UNCHANGED <<elapsed, pool>>
Expire == /\ waiter = "waiting" /\ elapsed = Bound
          /\ waiter' = "expired"
          /\ UNCHANGED <<holder, elapsed, earlyEffect, pool>>
Next == Release \/ Tick \/ Acquire \/ Expire
Spec == Init /\ [][Next]_vars
    /\ WF_vars(Acquire \/ Tick \/ Expire) /\ WF_vars(Release)
NoEffectWhileHeld == ~earlyEffect
NoAdmissionAfterDeadline ==
    waiter \in {"acquired", "resumed"} => elapsed < Bound
Settles == waiter = "waiting" ~> waiter # "waiting"
NeverAcquired == waiter # "acquired"
NeverExpired == waiter # "expired"
\* A holder that releases inside the waiter's budget never ends the wait in
\* a refusal: neither expiry nor a refused boot after a peer's boot.
StopNeverRefuses == waiter \notin {"expired", "refused"}
NeverResumed == waiter # "resumed"
=============================================================================
