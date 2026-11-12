------------------------- MODULE PublisherStop -------------------------
EXTENDS Naturals, TLC
CONSTANTS EnforceProof, EnforceIsolation, EnforceLifetimeWatch
VARIABLES phase, owner, publisher, bridge, version, selected, crashes,
          unsafeCleanup, interruptedPublisher, boot, selectedBoot, frontend
vars == <<phase, owner, publisher, bridge, version, selected, crashes,
          unsafeCleanup, interruptedPublisher, boot, selectedBoot, frontend>>

\* publisher denotes the recorded incarnation, never an unrelated reused PID.
Init == /\ phase \in {"ready", "enrolled"} /\ owner \in BOOLEAN
        /\ publisher \in BOOLEAN /\ bridge = TRUE
        /\ boot \in {"original", "successor"} /\ selectedBoot = "none"
        /\ (owner => publisher /\ boot = "original")
        /\ (~owner => phase = "enrolled") /\ frontend = owner
        /\ version = 1 /\ selected = 0 /\ crashes = IF owner THEN 0 ELSE 1
        /\ unsafeCleanup = FALSE /\ interruptedPublisher = FALSE

Interrupt == /\ phase = "ready" /\ owner
             /\ phase' = "enrolled"
             /\ publisher' = IF EnforceIsolation THEN publisher ELSE FALSE
             /\ interruptedPublisher' = ~EnforceIsolation
             /\ UNCHANGED <<owner, bridge, version, selected, crashes, unsafeCleanup, boot, selectedBoot, frontend>>
\* Watch delivery and cleanup initiation are abstracted as one owner transition.
FrontendLost == /\ phase = "ready" /\ owner /\ frontend
                /\ frontend' = FALSE
                /\ phase' = IF EnforceLifetimeWatch THEN "enrolled" ELSE phase
                /\ UNCHANGED <<owner, publisher, bridge, version, selected, crashes,
                                unsafeCleanup, interruptedPublisher, boot, selectedBoot>>
\* Exact Child exit, try_wait and its pinned exit receipt are abstracted together.
PublisherCrash == /\ phase = "ready" /\ owner /\ publisher
                  /\ publisher' = FALSE /\ phase' = "enrolled"
                  /\ UNCHANGED <<owner, bridge, version, selected, crashes,
                                  unsafeCleanup, interruptedPublisher, boot, selectedBoot, frontend>>
Crash == /\ owner /\ crashes = 0 /\ owner' = FALSE /\ crashes' = 1
         /\ UNCHANGED <<phase, publisher, bridge, version, selected,
                         unsafeCleanup, interruptedPublisher, boot, selectedBoot, frontend>>
RestartProvider == /\ boot = "original" /\ phase # "retired"
                   /\ boot' = "successor"
                   /\ UNCHANGED <<phase, owner, publisher, bridge, version, selected,
                                   crashes, unsafeCleanup, interruptedPublisher, selectedBoot, frontend>>
Recover == /\ ~owner /\ phase \in {"ready", "enrolled", "intent", "bridge-retired"}
           /\ (selected = 0 \/ selected = version)
           /\ phase' = "intent" /\ selected' = version /\ selectedBoot' = boot
           /\ UNCHANGED <<owner, publisher, bridge, version, crashes,
                           unsafeCleanup, interruptedPublisher, boot, frontend>>
StopPublisher == /\ phase \in {"enrolled", "intent"} /\ publisher
                 /\ (owner \/ selected = version)
                 /\ publisher' = FALSE
                 /\ UNCHANGED <<phase, owner, bridge, version, selected, crashes,
                                 unsafeCleanup, interruptedPublisher, boot, selectedBoot, frontend>>
ReplaceIdentity == /\ phase = "intent" /\ version = 1 /\ version' = 2
                   /\ UNCHANGED <<phase, owner, publisher, bridge, selected,
                                   crashes, unsafeCleanup, interruptedPublisher, boot, selectedBoot, frontend>>
Proof == ~publisher /\ ((owner /\ boot = "original") \/
                        (~owner /\ selected = version /\ selected # 0 /\ selectedBoot = boot))
ReleaseBridge == /\ phase \in {"enrolled", "intent"}
                 /\ (EnforceProof => Proof)
                 /\ phase' = "bridge-retired" /\ bridge' = FALSE
                 /\ unsafeCleanup' = ~Proof
                 /\ UNCHANGED <<owner, publisher, version, selected, crashes,
                                 interruptedPublisher, boot, selectedBoot, frontend>>
CleanupGuest == /\ phase = "bridge-retired"
                /\ (EnforceProof => Proof)
                /\ phase' = "stopped" /\ unsafeCleanup' = ~Proof
                /\ UNCHANGED <<owner, publisher, bridge, version, selected,
                                crashes, interruptedPublisher, boot, selectedBoot, frontend>>
Retire == /\ phase = "stopped" /\ Proof
          /\ phase' = "retired"
          /\ UNCHANGED <<owner, publisher, bridge, version, selected, crashes,
                          unsafeCleanup, interruptedPublisher, boot, selectedBoot, frontend>>
Next == Interrupt \/ FrontendLost \/ PublisherCrash \/ Crash \/ RestartProvider \/ Recover \/ StopPublisher
        \/ ReplaceIdentity \/ ReleaseBridge \/ CleanupGuest \/ Retire
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"ready", "enrolled", "intent", "bridge-retired", "stopped", "retired"}
          /\ owner \in BOOLEAN /\ publisher \in BOOLEAN /\ bridge \in BOOLEAN /\ frontend \in BOOLEAN
          /\ version \in 1..2 /\ selected \in 0..2 /\ crashes \in 0..1
          /\ unsafeCleanup \in BOOLEAN /\ interruptedPublisher \in BOOLEAN
          /\ boot \in {"original", "successor"}
          /\ selectedBoot \in {"none", "original", "successor"}
NoUnsafeCleanup == ~unsafeCleanup
NoInterruptRace == ~interruptedPublisher
NoSilentOrphan == (~frontend /\ owner) => phase # "ready"
NoPrematureRelease == ~bridge => ~publisher
NeverComplete == phase # "retired"
=======================================================================
