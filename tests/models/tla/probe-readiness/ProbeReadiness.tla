--------------------------- MODULE ProbeReadiness ---------------------------
\* One native HTTP probe (guest/http-probe.c) against one app, and the host's
\* reading of its status file (http_probe.rs `assess`, graph/probes.rs
\* `observe_finding` / `observe_sample`), HACK-2440 (c, d) and HACK-2416.
\*
\* Time is in ticks. `t` is host time since the probe's recorded start
\* (`Probe.started_ms`); the probe's own clock starts when its exec runs
\* (`execAt`), so `cT` is the probe's elapsed time.
\*
\* The app is chosen at the start:
\*   "slow"     - the first request starts a compile that takes 1..MaxCompile
\*                ticks; a request abandoned before it answers drops that compile
\*                and the next request starts it again (the dev-server behaviour
\*                HACK-2440 c describes); after its first answer it answers at once.
\*   "refusing" - nothing listens: every request fails at once.
\*   "hanging"  - accepts and starts its compile, but never answers.
\*
\* Switches. Patient, Tolerate and HostBound, when FALSE, are the behaviour
\* before this change.
\*   Patient   - until the first success, inside the grace, one attempt may run for
\*               the rest of the grace (`attempt_timeout`).
\*   Tolerate  - inside the grace, an exec that has not started, a missing or
\*               unreadable status, and a late "starting" status read as starting.
\*   HostBound - a "starting" status read later than `Limit` after the probe's
\*               host-side start is stale, whatever its own timestamp says
\*               (`HttpProbe::starting_bound_ms`).
\*   ReadFaults - the host's read of the status may come back missing or torn.
\*   Legacy    - the probe tries at the steady interval until its first success, as
\*               a probe launched with an earlier build's arguments does.
\*   TightBound - control only: a host bound that forgets the failed attempts
\*               after the grace (what `starting_bound_ms` must not do).
EXTENDS Naturals
CONSTANTS Patient, Tolerate, HostBound, ReadFaults, Legacy, TightBound

Grace == 3          \* start_period_ms
Timeout == 1        \* timeout_ms
Interval == 2       \* interval_ms
SI == IF Legacy THEN Interval ELSE 1   \* cadence until the first success
Retries == 2
MaxCompile == 2     \* the slow app's slowest first answer; < Grace (see README)
Fresh == Interval + Timeout + 1                 \* freshness allowance
PatientAge == (IF Grace > Fresh THEN Grace ELSE Fresh) + Timeout + 1
Limit == IF TightBound THEN Grace + 1
         ELSE Grace + Timeout + Retries * (Interval + Timeout) + (Interval + Timeout) + 1
Horizon == Grace + Timeout + Retries * (Interval + Timeout) + (Interval + Timeout) + 2
Max(a, b) == IF a > b THEN a ELSE b
Min(a, b) == IF a < b THEN a ELSE b

VARIABLES t, app, exec, execAt, wedged, skewed, readFault,
          inflight, began, nextAt, compiling, compileEnd, compiles, restarts,
          served, ever, failures, health, sample, pubAt, verdict, vt, vh
vars == <<t, app, exec, execAt, wedged, skewed, readFault,
          inflight, began, nextAt, compiling, compileEnd, compiles, restarts,
          served, ever, failures, health, sample, pubAt, verdict, vt, vh>>

Health == {"starting", "healthy", "unhealthy"}
TypeOK ==
    /\ t \in 0..Horizon
    /\ app \in {"slow", "refusing", "hanging"}
    /\ exec \in {"created", "running", "exited"}
    /\ execAt \in 0..1
    /\ wedged \in BOOLEAN /\ skewed \in BOOLEAN /\ readFault \in BOOLEAN
    /\ inflight \in BOOLEAN /\ compiling \in BOOLEAN /\ served \in BOOLEAN
    /\ began \in 0..Horizon /\ nextAt \in 0..(Horizon + Interval)
    /\ compileEnd \in 0..(Horizon + MaxCompile)
    /\ compiles \in 0..3 /\ restarts \in 0..1
    /\ ever \in BOOLEAN /\ failures \in 0..Retries /\ health \in Health
    /\ sample \in {"none"} \cup Health /\ pubAt \in 0..Horizon
    /\ verdict \in {"none"} \cup Health /\ vt \in 0..Horizon
    /\ vh \in Health

Init ==
    /\ t = 0 /\ app \in {"slow", "refusing", "hanging"}
    /\ exec = "created" /\ execAt = 0
    /\ wedged = FALSE /\ skewed = FALSE /\ readFault = FALSE
    /\ inflight = FALSE /\ began = 0 /\ nextAt = 0
    /\ compiling = FALSE /\ compileEnd = 0 /\ compiles = 0 /\ restarts = 0
    /\ served = FALSE /\ ever = FALSE /\ failures = 0 /\ health = "starting"
    /\ sample = "none" /\ pubAt = 0 /\ verdict = "none" /\ vt = 0
    /\ vh = "starting"

cT == t - execAt
Working == exec = "running" /\ ~wedged
\* `attempt_timeout(ever_healthy, begun - start, grace, timeout)`.
Lim == IF Patient /\ ~ever /\ began < Grace THEN Max(Grace - began, Timeout) ELSE Timeout
AnswerReady == app = "slow" /\ (served \/ (compiling /\ cT >= compileEnd))
\* A refused connection fails at once; otherwise the attempt runs to its limit.
FailsNow == app = "refusing" \/ cT - began >= Lim
\* `sample_period`: the start interval until the first success.
Period == IF ever THEN Interval ELSE SI
CanBegin == Working /\ ~inflight /\ cT >= nextAt

\* `start_probe`: the exec starts right after it is created and publishes
\* sequence 0, health 2 before its first request.
ExecStart ==
    /\ exec = "created" /\ t <= 1
    /\ exec' = "running" /\ execAt' = t /\ sample' = "starting" /\ pubAt' = t
    /\ nextAt' = 0
    /\ UNCHANGED <<t, app, wedged, skewed, readFault, inflight, began, compiling,
                   compileEnd, compiles, restarts, served, ever, failures, health,
                   verdict, vt, vh>>

\* A request reaches an app that is not compiling yet: it starts a compile.
\* A compile started again inside the grace is a restart the probe caused.
Begin ==
    /\ CanBegin
    /\ inflight' = TRUE /\ began' = cT
    /\ IF app /= "refusing" /\ ~served /\ ~compiling
       THEN /\ compiling' = TRUE /\ compiles' = Min(compiles + 1, 3)
            /\ restarts' = IF compiles >= 1 /\ cT < Grace THEN 1 ELSE restarts
            /\ compileEnd' \in (cT + 1)..(cT + MaxCompile)
       ELSE UNCHANGED <<compiling, compiles, restarts, compileEnd>>
    /\ UNCHANGED <<t, app, exec, execAt, wedged, skewed, readFault, nextAt, served,
                   ever, failures, health, sample, pubAt, verdict, vt, vh>>

\* `sample_health(success = true)`, then publish.
Answer ==
    /\ Working /\ inflight /\ AnswerReady /\ cT - began <= Lim
    /\ inflight' = FALSE /\ served' = TRUE /\ compiling' = FALSE
    /\ ever' = TRUE /\ failures' = 0 /\ health' = "healthy"
    /\ sample' = "healthy" /\ pubAt' = t /\ nextAt' = began + Interval
    /\ UNCHANGED <<t, app, exec, execAt, wedged, skewed, readFault, began,
                   compileEnd, compiles, restarts, verdict, vt, vh>>

\* The attempt fails: refused, or it reached its limit (the compile is abandoned).
\* `sample_health(success = false)`: a failure counts only after the first
\* success or once the grace has passed.
Expire ==
    /\ Working /\ inflight /\ FailsNow
    /\ LET counted == ever \/ cT >= Grace
           f == IF counted /\ failures < Retries THEN failures + 1 ELSE failures
           h == IF counted /\ f >= Retries THEN "unhealthy" ELSE health
       IN /\ failures' = f /\ health' = h /\ sample' = h
    /\ inflight' = FALSE /\ compiling' = FALSE /\ pubAt' = t
    /\ nextAt' = began + Period
    /\ UNCHANGED <<t, app, exec, execAt, wedged, skewed, readFault, began,
                   compileEnd, compiles, restarts, served, ever, verdict, vt, vh>>

\* Faults.
ExecExit ==
    /\ exec = "running" /\ exec' = "exited" /\ inflight' = FALSE
    /\ UNCHANGED <<t, app, execAt, wedged, skewed, readFault, began, nextAt,
                   compiling, compileEnd, compiles, restarts, served, ever, failures,
                   health, sample, pubAt, verdict, vt, vh>>
\* The probe stops publishing while its exec still runs.
Wedge ==
    /\ Working /\ wedged' = TRUE
    /\ UNCHANGED <<t, app, exec, execAt, skewed, readFault, inflight, began, nextAt,
                   compiling, compileEnd, compiles, restarts, served, ever, failures,
                   health, sample, pubAt, verdict, vt, vh>>
\* The same, with its last "starting" status dated in the future by the guest clock.
Skew ==
    /\ Working /\ sample = "starting" /\ skewed' = TRUE /\ wedged' = TRUE
    /\ UNCHANGED <<t, app, exec, execAt, readFault, inflight, began, nextAt,
                   compiling, compileEnd, compiles, restarts, served, ever, failures,
                   health, sample, pubAt, verdict, vt, vh>>

\* Probe steps that are due happen before time moves on.
Urgent == Working /\ (CanBegin \/ (inflight /\ (AnswerReady \/ FailsNow)))
Tick ==
    /\ t < Horizon /\ ~Urgent /\ t' = t + 1
    /\ UNCHANGED <<app, exec, execAt, wedged, skewed, readFault, inflight, began,
                   nextAt, compiling, compileEnd, compiles, restarts, served, ever,
                   failures, health, sample, pubAt, verdict, vt, vh>>

\* The host's reading, as `observe_finding` and `assess` decide it.
V(read) ==
    IF exec = "exited" THEN "unhealthy"
    ELSE IF exec = "created" THEN (IF Tolerate /\ t <= Grace THEN "starting" ELSE "unhealthy")
    ELSE IF read = "none"
         THEN (IF (Tolerate /\ t <= Grace) \/ t <= Fresh THEN "starting" ELSE "unhealthy")
    ELSE IF read = "garbage" THEN (IF Tolerate /\ t <= Grace THEN "starting" ELSE "unhealthy")
    ELSE IF read = "starting"
         THEN IF ~Tolerate
              THEN (IF skewed \/ t - pubAt > Fresh THEN "unhealthy" ELSE "starting")
              ELSE IF HostBound /\ t > Limit THEN "unhealthy"
              ELSE IF ~skewed /\ t - pubAt > PatientAge THEN "unhealthy"
              ELSE "starting"
    ELSE IF read = "healthy"
         THEN (IF skewed \/ t - pubAt > Fresh THEN "unhealthy" ELSE "healthy")
    ELSE "unhealthy"
Reads == {sample} \cup (IF ReadFaults /\ exec = "running" THEN {"none", "garbage"} ELSE {})
\* Any number of readiness passes; the start fails at the first unhealthy verdict.
Observe ==
    /\ verdict /= "unhealthy"
    /\ \E read \in Reads :
          /\ verdict' = V(read) /\ vt' = t /\ vh' = health
          /\ readFault' = (readFault \/ (read /= sample /\ t > Grace))
    /\ UNCHANGED <<t, app, exec, execAt, wedged, skewed, inflight, began, nextAt,
                   compiling, compileEnd, compiles, restarts, served, ever, failures,
                   health, sample, pubAt>>

Next == ExecStart \/ Begin \/ Answer \/ Expire \/ ExecExit \/ Wedge \/ Skew
        \/ Tick \/ Observe
Spec == Init /\ [][Next]_vars

\* Something definite went wrong with the probe: the exec exited or never
\* started, the probe stopped publishing, or a read failed after the grace.
Faulted == exec = "exited" \/ (exec = "created" /\ t > 1) \/ wedged \/ readFault

\* A start is never failed on a doubtful reading (HACK-2416): an app that answers
\* within its grace, with a working probe, is never judged unhealthy.
NoFalseFailure == (verdict = "unhealthy" /\ app = "slow") => Faulted
\* Without a probe fault, the host fails a start only once the probe itself has
\* reached unhealthy: its bounds never cut a working probe short.
NoPrematureFailure == (verdict = "unhealthy" /\ ~Faulted) => vh = "unhealthy"
\* "Starting" cannot hold a start open: no reading says starting later than the
\* bound measured on the host from the probe's start.
BoundedStarting == verdict = "starting" => vt <= Limit
\* Nothing is ready that never answered.
NoReadyWithoutSuccess == verdict = "healthy" => ever
\* The probe stops fighting the app (HACK-2440 c): inside the grace it never makes
\* the app start its compile again.
OneCompile == restarts = 0
\* Control only, expected to FAIL: the probe does reach exhausted retries, so the
\* positive run exercises failure counting.
NeverExhausted == health /= "unhealthy"
=============================================================================
