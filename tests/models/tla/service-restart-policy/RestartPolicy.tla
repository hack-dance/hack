--------------------------- MODULE RestartPolicy ---------------------------
EXTENDS Naturals, TLC
\* One owned Compose-file graph container whose admitted restart policy is
\* lowered to the guest engine. The engine may crash, restart it, or be
\* restarted itself while the foreground owner serves, disarms, stops, proves
\* terminal state and removes it. See README.md for the source mapping.
CONSTANTS EnforceDisarm, EnforceTerminal, EnforceGeneration, MaxIncarnation
VARIABLES engine, policy, cancelled, incarnation, phase, bound,
          daemonRestarts, lateStart, unsafeTerminal, staleUse
vars == <<engine, policy, cancelled, incarnation, phase, bound,
          daemonRestarts, lateStart, unsafeTerminal, staleUse>>

\* Owner phases after `serving` are all after the durable cleanup intent.
StopRequested == phase \in {"stopping", "stopped", "removed"}
Present == engine # "absent"

Init == /\ engine = "running" /\ policy = "armed" /\ cancelled = FALSE
        /\ incarnation = 1 /\ phase = "serving" /\ bound = 0
        /\ daemonRestarts = 0 /\ lateStart = FALSE
        /\ unsafeTerminal = FALSE /\ staleUse = FALSE

\* ---- Engine ----------------------------------------------------------------
\* An application exit. An armed, uncancelled policy may schedule a restart
\* (always/unless-stopped, or on-failure with retries left) or leave the
\* container exited (on-failure success or exhausted retries).
Exit == /\ engine = "running"
        /\ engine' \in IF policy = "armed" /\ ~cancelled
                       THEN {"restarting", "exited"} ELSE {"exited"}
        /\ UNCHANGED <<policy, cancelled, incarnation, phase, bound,
                        daemonRestarts, lateStart, unsafeTerminal, staleUse>>
\* A scheduled restart fires even if the policy was updated meanwhile; only a
\* stop (restart-manager cancel) prevents it. Each start is a new incarnation.
EngineRestart == /\ engine = "restarting" /\ ~cancelled
                 /\ incarnation < MaxIncarnation
                 /\ engine' = "running" /\ incarnation' = incarnation + 1
                 /\ lateStart' = (lateStart \/ StopRequested)
                 /\ UNCHANGED <<policy, cancelled, phase, bound,
                                 daemonRestarts, unsafeTerminal, staleUse>>
\* Guest engine restart or VM reboot. Restore restarts an armed container even
\* after a manual stop (Docker `always`); a disarmed one stays exited.
DaemonRestart == /\ Present /\ daemonRestarts = 0
                 /\ daemonRestarts' = 1 /\ cancelled' = FALSE
                 /\ IF policy = "armed" /\ incarnation < MaxIncarnation
                    THEN /\ engine' = "running"
                         /\ incarnation' = incarnation + 1
                         /\ lateStart' = (lateStart \/ StopRequested)
                    ELSE /\ engine' = "exited"
                         /\ UNCHANGED <<incarnation, lateStart>>
                 /\ UNCHANGED <<policy, phase, bound, unsafeTerminal, staleUse>>

\* ---- Owner -----------------------------------------------------------------
\* A generation-bound consumer (endpoint, exec, relay target) binds to the
\* currently observed incarnation: container ID plus StartedAt.
Bind == /\ phase = "serving" /\ engine = "running" /\ bound # incarnation
        /\ bound' = incarnation
        /\ UNCHANGED <<engine, policy, cancelled, incarnation, phase,
                        daemonRestarts, lateStart, unsafeTerminal, staleUse>>
\* Use re-verifies the bound generation at the effect boundary.
Use == /\ phase = "serving" /\ bound # 0
       /\ (EnforceGeneration => (bound = incarnation /\ engine = "running"))
       /\ staleUse' = (staleUse \/ bound # incarnation \/ engine # "running")
       /\ UNCHANGED <<engine, policy, cancelled, incarnation, phase, bound,
                       daemonRestarts, lateStart, unsafeTerminal>>
\* A changed generation refuses; a fresh Bind is required.
RefuseStale == /\ phase = "serving" /\ bound # 0
               /\ (bound # incarnation \/ engine # "running")
               /\ bound' = 0
               /\ UNCHANGED <<engine, policy, cancelled, incarnation, phase,
                               daemonRestarts, lateStart, unsafeTerminal,
                               staleUse>>
\* Cleanup intent, then `update RestartPolicy=no` confirmed by reinspection.
\* Retries after a refused proof repeat the idempotent disarm.
Disarm == /\ phase \in {"serving", "retry"}
          /\ policy' = IF EnforceDisarm THEN "no" ELSE policy
          /\ phase' = "disarmed" /\ bound' = 0
          /\ UNCHANGED <<engine, cancelled, incarnation, daemonRestarts,
                          lateStart, unsafeTerminal, staleUse>>
\* The stop request cancels any pending restart (Docker restart-manager cancel)
\* and marks the container manually stopped. The process exit is separate.
RequestStop == /\ phase = "disarmed"
               /\ phase' = "stopping" /\ cancelled' = TRUE
               /\ UNCHANGED <<engine, policy, incarnation, bound,
                               daemonRestarts, lateStart, unsafeTerminal,
                               staleUse>>
EngineStop == /\ cancelled /\ engine \in {"running", "restarting"}
              /\ engine' = "exited"
              /\ UNCHANGED <<policy, cancelled, incarnation, phase, bound,
                              daemonRestarts, lateStart, unsafeTerminal,
                              staleUse>>
\* Terminal evidence needs a fresh observation with Running and Restarting
\* both false; transport success of the stop is not proof.
Terminal == engine \in {"exited", "absent"}
ObserveTerminal == /\ phase = "stopping"
                   /\ (EnforceTerminal => Terminal)
                   /\ phase' = "stopped"
                   /\ unsafeTerminal' = (unsafeTerminal \/ ~Terminal)
                   /\ UNCHANGED <<engine, policy, cancelled, incarnation, bound,
                                   daemonRestarts, lateStart, staleUse>>
\* A non-terminal observation refuses and keeps evidence for a retry.
RefuseNonTerminal == /\ phase \in {"stopping", "stopped"} /\ ~Terminal
                     /\ phase' = "retry"
                     /\ UNCHANGED <<engine, policy, cancelled, incarnation, bound,
                                     daemonRestarts, lateStart, unsafeTerminal,
                                     staleUse>>
\* Docker refuses to remove a running container without force; Hack never forces.
Remove == /\ phase = "stopped" /\ engine = "exited"
          /\ engine' = "absent" /\ phase' = "removed"
          /\ UNCHANGED <<policy, cancelled, incarnation, bound, daemonRestarts,
                          lateStart, unsafeTerminal, staleUse>>

Next == Exit \/ EngineRestart \/ DaemonRestart \/ Bind \/ Use \/ RefuseStale
        \/ Disarm \/ RequestStop \/ EngineStop \/ ObserveTerminal
        \/ RefuseNonTerminal \/ Remove
Spec == Init /\ [][Next]_vars

TypeOK == /\ engine \in {"running", "restarting", "exited", "absent"}
          /\ policy \in {"armed", "no"} /\ cancelled \in BOOLEAN
          /\ incarnation \in 1..MaxIncarnation /\ bound \in 0..MaxIncarnation
          /\ phase \in {"serving", "disarmed", "stopping", "stopped", "retry",
                        "removed"}
          /\ daemonRestarts \in 0..1 /\ lateStart \in BOOLEAN
          /\ unsafeTerminal \in BOOLEAN /\ staleUse \in BOOLEAN
\* 1. No generation-bound use targets a stale incarnation.
NoStaleIncarnation == ~staleUse
\* 2. After the stop request no new incarnation starts.
NoIncarnationAfterStop == ~lateStart
\* 3. Terminal evidence is recorded only while Running and Restarting are false.
TerminalProof == ~unsafeTerminal
Safe == NoStaleIncarnation /\ NoIncarnationAfterStop /\ TerminalProof
\* Control: cleanup completion is reachable in the positive configuration.
NeverRemoved == phase # "removed"
=============================================================================
