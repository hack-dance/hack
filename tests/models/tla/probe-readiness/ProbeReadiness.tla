--------------------------- MODULE ProbeReadiness ---------------------------
\* One native HTTP probe (guest/http-probe.c) against one app, and the host's
\* reading of its status file (http_probe.rs `assess`, graph/probes.rs
\* `observe_finding` / `observe_sample`), HACK-2440 (c, d) and HACK-2416.
\*
\* Time is in ticks. `t` is host time since the probe's recorded start
\* (`Probe.started_ms`); the probe's own clock starts when its exec runs
\* (`execAt`), so `cT` is the probe's elapsed time.
\*
\* The app: the first request starts a compile that takes 1..MaxCompile ticks.
\* A request abandoned before it answers drops that compile, and the next
\* request starts it again. That is the dev-server behaviour HACK-2440 (c)
\* describes. After its first answer the app answers at once.
\*
\* Switches. Each one, when FALSE, is the behaviour before this change.
\*   Patient   - until the first success, inside the grace, one attempt may run for
\*               the rest of the grace (`attempt_timeout`).
\*   Tolerate  - inside the grace, an exec that has not started, a missing or
\*               unreadable status, and a late "starting" status read as starting.
\*   HostBound - a "starting" status read later than `Limit` after the probe's
\*               host-side start is stale, whatever its own timestamp says
\*               (`HttpProbe::starting_bound_ms`).
\*   ReadFaults - the host's read of the status may come back missing or torn.
EXTENDS Naturals
CONSTANTS Patient, Tolerate, HostBound, ReadFaults

Grace == 3          \* start_period_ms
Timeout == 1        \* timeout_ms
SI == 1             \* start interval, until the first success
Interval == 2       \* interval_ms
Retries == 2
MaxCompile == 2     \* the app's slowest first answer; < Grace (see README)
Fresh == Interval + Timeout + 1                 \* freshness allowance
PatientAge == (IF Grace > Fresh THEN Grace ELSE Fresh) + Timeout + 1
Limit == Grace + Timeout + Retries * (Interval + Timeout) + (Interval + Timeout) + 1
Horizon == Limit + 1
Max(a, b) == IF a > b THEN a ELSE b

VARIABLES t, exec, execAt, wedged, skewed, readFault,
          inflight, began, nextAt, compiling, compileEnd, compiles, served,
          ever, failures, health, sample, pubAt, verdict, vt
vars == <<t, exec, execAt, wedged, skewed, readFault,
          inflight, began, nextAt, compiling, compileEnd, compiles, served,
          ever, failures, health, sample, pubAt, verdict, vt>>

Health == {"starting", "healthy", "unhealthy"}
TypeOK ==
    /\ t \in 0..Horizon
    /\ exec \in {"created", "running", "exited"}
    /\ execAt \in 0..1
    /\ wedged \in BOOLEAN /\ skewed \in BOOLEAN /\ readFault \in BOOLEAN
    /\ inflight \in BOOLEAN /\ compiling \in BOOLEAN /\ served \in BOOLEAN
    /\ began \in 0..Horizon /\ nextAt \in 0..(Horizon + Interval)
    /\ compileEnd \in 0..(Horizon + MaxCompile) /\ compiles \in 0..3
    /\ ever \in BOOLEAN /\ failures \in 0..Retries /\ health \in Health
    /\ sample \in {"none"} \cup Health /\ pubAt \in 0..Horizon
    /\ verdict \in {"none"} \cup Health /\ vt \in 0..Horizon

Init ==
    /\ t = 0 /\ exec = "created" /\ execAt = 0
    /\ wedged = FALSE /\ skewed = FALSE /\ readFault = FALSE
    /\ inflight = FALSE /\ began = 0 /\ nextAt = 0
    /\ compiling = FALSE /\ compileEnd = 0 /\ compiles = 0 /\ served = FALSE
    /\ ever = FALSE /\ failures = 0 /\ health = "starting"
    /\ sample = "none" /\ pubAt = 0 /\ verdict = "none" /\ vt = 0

cT == t - execAt
Working == exec = "running" /\ ~wedged
\* `attempt_timeout(ever_healthy, begun - start, grace, timeout)`.
Lim == IF Patient /\ ~ever /\ began < Grace THEN Max(Grace - began, Timeout) ELSE Timeout
AnswerReady == served \/ (compiling /\ cT >= compileEnd)
\* `sample_period`: the start interval until the first success.
Period == IF ever THEN Interval ELSE SI
CanBegin == Working /\ ~inflight /\ cT >= nextAt /\ (served \/ compiling \/ compiles < 3)

\* `start_probe`: the exec starts right after it is created and publishes
\* sequence 0, health 2 before its first request.
ExecStart ==
    /\ exec = "created" /\ t <= 1
    /\ exec' = "running" /\ execAt' = t /\ sample' = "starting" /\ pubAt' = t
    /\ nextAt' = 0
    /\ UNCHANGED <<t, wedged, skewed, readFault, inflight, began, compiling,
                   compileEnd, compiles, served, ever, failures, health, verdict, vt>>

Begin ==
    /\ CanBegin
    /\ inflight' = TRUE /\ began' = cT
    /\ IF ~served /\ ~compiling
       THEN /\ compiling' = TRUE /\ compiles' = compiles + 1
            /\ compileEnd' \in (cT + 1)..(cT + MaxCompile)
       ELSE UNCHANGED <<compiling, compiles, compileEnd>>
    /\ UNCHANGED <<t, exec, execAt, wedged, skewed, readFault, nextAt, served,
                   ever, failures, health, sample, pubAt, verdict, vt>>

\* `sample_health(success = true)`, then publish.
Answer ==
    /\ Working /\ inflight /\ AnswerReady /\ cT - began <= Lim
    /\ inflight' = FALSE /\ served' = TRUE /\ compiling' = FALSE
    /\ ever' = TRUE /\ failures' = 0 /\ health' = "healthy"
    /\ sample' = "healthy" /\ pubAt' = t /\ nextAt' = began + Interval
    /\ UNCHANGED <<t, exec, execAt, wedged, skewed, readFault, began,
                   compileEnd, compiles, verdict, vt>>

\* The attempt reaches its limit: the app's compile is abandoned.
\* `sample_health(success = false)`: a failure counts only after the first
\* success or once the grace has passed.
Expire ==
    /\ Working /\ inflight /\ cT - began >= Lim
    /\ LET counted == ever \/ cT >= Grace
           f == IF counted /\ failures < Retries THEN failures + 1 ELSE failures
           h == IF counted /\ f >= Retries THEN "unhealthy" ELSE health
       IN /\ failures' = f /\ health' = h /\ sample' = h
    /\ inflight' = FALSE /\ compiling' = FALSE /\ pubAt' = t
    /\ nextAt' = began + Period
    /\ UNCHANGED <<t, exec, execAt, wedged, skewed, readFault, began,
                   compileEnd, compiles, served, ever, verdict, vt>>

\* Faults.
ExecExit ==
    /\ exec = "running" /\ exec' = "exited" /\ inflight' = FALSE
    /\ UNCHANGED <<t, execAt, wedged, skewed, readFault, began, nextAt, compiling,
                   compileEnd, compiles, served, ever, failures, health, sample,
                   pubAt, verdict, vt>>
\* The probe stops publishing while its exec still runs.
Wedge ==
    /\ Working /\ wedged' = TRUE
    /\ UNCHANGED <<t, exec, execAt, skewed, readFault, inflight, began, nextAt,
                   compiling, compileEnd, compiles, served, ever, failures, health,
                   sample, pubAt, verdict, vt>>
\* The same, with its last "starting" status dated in the future by the guest clock.
Skew ==
    /\ Working /\ sample = "starting" /\ skewed' = TRUE /\ wedged' = TRUE
    /\ UNCHANGED <<t, exec, execAt, readFault, inflight, began, nextAt,
                   compiling, compileEnd, compiles, served, ever, failures, health,
                   sample, pubAt, verdict, vt>>

\* Probe steps that are due happen before time moves on.
Urgent == Working /\ (CanBegin \/ (inflight /\ (AnswerReady \/ cT - began >= Lim)))
Tick ==
    /\ t < Horizon /\ ~Urgent /\ t' = t + 1
    /\ UNCHANGED <<exec, execAt, wedged, skewed, readFault, inflight, began, nextAt,
                   compiling, compileEnd, compiles, served, ever, failures, health,
                   sample, pubAt, verdict, vt>>

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
          /\ verdict' = V(read) /\ vt' = t
          /\ readFault' = (readFault \/ (read /= sample /\ t > Grace))
    /\ UNCHANGED <<t, exec, execAt, wedged, skewed, inflight, began, nextAt,
                   compiling, compileEnd, compiles, served, ever, failures, health,
                   sample, pubAt>>

Next == ExecStart \/ Begin \/ Answer \/ Expire \/ ExecExit \/ Wedge \/ Skew
        \/ Tick \/ Observe
Spec == Init /\ [][Next]_vars

\* Something definite went wrong: the exec exited or never started, the probe
\* stopped publishing, or a read failed after the grace.
Faulted == exec = "exited" \/ (exec = "created" /\ t > 1) \/ wedged \/ readFault

\* A start is never failed on a doubtful reading (HACK-2416): an app that answers
\* within its grace, with a working probe, is never judged unhealthy.
NoFalseFailure == verdict = "unhealthy" => Faulted
\* "Starting" cannot hold a start open: no reading says starting later than the
\* bound measured on the host from the probe's start.
BoundedStarting == verdict = "starting" => vt <= Limit
\* Nothing is ready that never answered.
NoReadyWithoutSuccess == verdict = "healthy" => ever
\* The probe stops fighting the app: one compile, never restarted by an
\* abandoned request (HACK-2440 c).
OneCompile == compiles <= 1
=============================================================================
