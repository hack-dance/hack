------------------------- MODULE PublisherStop -------------------------
EXTENDS Naturals, TLC
CONSTANTS EnforceProof, EnforceIsolation, EnforceLifetimeWatch, EnforceReservationRelease
VARIABLES phase, owner, publisher, bridge, version, selected, crashes,
          unsafeCleanup, interruptedPublisher, boot, selectedBoot, frontend, reservation
vars == <<phase, owner, publisher, bridge, version, selected, crashes,
          unsafeCleanup, interruptedPublisher, boot, selectedBoot, frontend, reservation>>

\* publisher denotes the recorded incarnation, never an unrelated reused PID.
Init == /\ phase \in {"ready", "enrolled"} /\ owner \in BOOLEAN
        /\ publisher \in BOOLEAN /\ bridge = TRUE
        /\ boot \in {"original", "successor"} /\ selectedBoot = "none"
        /\ (owner => publisher /\ boot = "original")
        /\ (~owner => phase = "enrolled") /\ frontend = owner
        /\ version = 1 /\ selected = 0 /\ crashes = IF owner THEN 0 ELSE 1
        /\ unsafeCleanup = FALSE /\ interruptedPublisher = FALSE /\ reservation = TRUE

Interrupt == /\ phase \in {"ready", "publisher-down"} /\ owner
             /\ phase' = "enrolled"
             /\ publisher' = IF EnforceIsolation THEN publisher ELSE FALSE
             /\ interruptedPublisher' = ~EnforceIsolation
             /\ UNCHANGED <<owner, bridge, version, selected, crashes, unsafeCleanup, boot, selectedBoot, frontend, reservation>>
\* Watch delivery and cleanup initiation are abstracted as one owner transition.
FrontendLost == /\ phase \in {"ready", "publisher-down"} /\ owner /\ frontend
                /\ frontend' = FALSE
                /\ phase' = IF EnforceLifetimeWatch THEN "enrolled" ELSE phase
                /\ UNCHANGED <<owner, publisher, bridge, version, selected, crashes,
                                unsafeCleanup, interruptedPublisher, boot, selectedBoot, reservation>>
\* Exact Child exit, reaping and a publication-down notice are abstracted together.
\* Compute stays live until an explicit stop or frontend loss requests cleanup.
PublisherCrash == /\ phase = "ready" /\ owner /\ publisher
                  /\ publisher' = FALSE /\ phase' = "publisher-down"
                  /\ UNCHANGED <<owner, bridge, version, selected, crashes,
                                  unsafeCleanup, interruptedPublisher, boot, selectedBoot, frontend, reservation>>
Crash == /\ owner /\ crashes = 0 /\ owner' = FALSE /\ crashes' = 1
         /\ UNCHANGED <<phase, publisher, bridge, version, selected,
                         unsafeCleanup, interruptedPublisher, boot, selectedBoot, frontend, reservation>>
RestartProvider == /\ boot = "original" /\ phase # "retired"
                   /\ boot' = "successor"
                   /\ UNCHANGED <<phase, owner, publisher, bridge, version, selected,
                                   crashes, unsafeCleanup, interruptedPublisher, selectedBoot, frontend, reservation>>
Recover == /\ ~owner /\ phase \in {"ready", "publisher-down", "enrolled", "intent", "bridge-retired"}
           /\ (selected = 0 \/ selected = version)
           /\ phase' = "intent" /\ selected' = version /\ selectedBoot' = boot
           /\ UNCHANGED <<owner, publisher, bridge, version, crashes,
                           unsafeCleanup, interruptedPublisher, boot, frontend, reservation>>
StopPublisher == /\ phase \in {"enrolled", "intent"} /\ publisher
                 /\ (owner \/ selected = version)
                 /\ publisher' = FALSE
                 /\ UNCHANGED <<phase, owner, bridge, version, selected, crashes,
                                 unsafeCleanup, interruptedPublisher, boot, selectedBoot, frontend, reservation>>
ReplaceIdentity == /\ phase = "intent" /\ version = 1 /\ version' = 2
                   /\ UNCHANGED <<phase, owner, publisher, bridge, selected,
                                   crashes, unsafeCleanup, interruptedPublisher, boot, selectedBoot, frontend, reservation>>
Proof == ~publisher /\ ((owner /\ boot = "original") \/
                        (~owner /\ selected = version /\ selected # 0 /\ selectedBoot = boot))
ReleaseBridge == /\ phase \in {"enrolled", "intent"}
                 /\ (EnforceProof => Proof)
                 /\ phase' = "bridge-retired" /\ bridge' = FALSE
                 /\ unsafeCleanup' = ~Proof
                 /\ UNCHANGED <<owner, publisher, version, selected, crashes,
                                 interruptedPublisher, boot, selectedBoot, frontend, reservation>>
CleanupGuest == /\ phase = "bridge-retired"
                /\ (EnforceProof => Proof)
                /\ phase' = "stopped" /\ unsafeCleanup' = ~Proof
                /\ UNCHANGED <<owner, publisher, bridge, version, selected,
                                crashes, interruptedPublisher, boot, selectedBoot, frontend, reservation>>
\* Guest completion can commit before the dependency-reservation release.
ReleaseDependencies == /\ phase = "stopped" /\ Proof /\ reservation
                       /\ reservation' = FALSE
                       /\ UNCHANGED <<phase, owner, publisher, bridge, version, selected,
                                       crashes, unsafeCleanup, interruptedPublisher, boot,
                                       selectedBoot, frontend>>
Retire == /\ phase = "stopped" /\ Proof
          /\ (EnforceReservationRelease => ~reservation)
          /\ phase' = "retired"
          /\ UNCHANGED <<owner, publisher, bridge, version, selected, crashes,
                          unsafeCleanup, interruptedPublisher, boot, selectedBoot, frontend, reservation>>
Next == Interrupt \/ FrontendLost \/ PublisherCrash \/ Crash \/ RestartProvider \/ Recover \/ StopPublisher
        \/ ReplaceIdentity \/ ReleaseBridge \/ CleanupGuest \/ ReleaseDependencies \/ Retire
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"ready", "publisher-down", "enrolled", "intent", "bridge-retired", "stopped", "retired"}
          /\ reservation \in BOOLEAN
          /\ owner \in BOOLEAN /\ publisher \in BOOLEAN /\ bridge \in BOOLEAN /\ frontend \in BOOLEAN
          /\ version \in 1..2 /\ selected \in 0..2 /\ crashes \in 0..1
          /\ unsafeCleanup \in BOOLEAN /\ interruptedPublisher \in BOOLEAN
          /\ boot \in {"original", "successor"}
          /\ selectedBoot \in {"none", "original", "successor"}
NoUnsafeCleanup == ~unsafeCleanup
NoInterruptRace == ~interruptedPublisher
NoSilentOrphan == (~frontend /\ owner) => phase \notin {"ready", "publisher-down"}
NoPrematureRelease == ~bridge => ~publisher
NoStrandedReservation == phase = "retired" => ~reservation
NeverComplete == phase # "retired"
=======================================================================
