------------------------- MODULE PublisherStop -------------------------
EXTENDS Naturals, TLC
CONSTANTS EnforceProof, EnforceIsolation, EnforceLifetimeWatch, EnforceReservationRelease, EnforceExitProof
VARIABLES phase, owner, publisher, bridge, version, selected, crashes,
          unsafeCleanup, interruptedPublisher, boot, selectedBoot, frontend, reservation, exitProof
vars == <<phase, owner, publisher, bridge, version, selected, crashes,
          unsafeCleanup, interruptedPublisher, boot, selectedBoot, frontend, reservation, exitProof>>

\* publisher denotes the recorded incarnation, never an unrelated reused PID.
Init == /\ phase \in {"ready", "enrolled"} /\ owner \in BOOLEAN
        /\ publisher \in BOOLEAN /\ bridge = TRUE
        /\ boot \in {"original", "successor"} /\ selectedBoot = "none"
        /\ (owner => publisher /\ boot = "original")
        /\ (~owner => phase = "enrolled") /\ frontend = owner
        /\ version = 1 /\ selected = 0 /\ crashes = IF owner THEN 0 ELSE 1
        /\ unsafeCleanup = FALSE /\ interruptedPublisher = FALSE /\ reservation = TRUE
        /\ exitProof = ~publisher

Interrupt == /\ phase \in {"ready", "publisher-down", "publisher-exit-pending"} /\ owner
             /\ phase' = "enrolled"
             /\ publisher' = IF EnforceIsolation THEN publisher ELSE FALSE
             /\ interruptedPublisher' = ~EnforceIsolation
             /\ UNCHANGED <<owner, bridge, version, selected, crashes, unsafeCleanup, boot, selectedBoot, frontend, reservation, exitProof>>
\* Watch delivery and cleanup initiation are abstracted as one owner transition.
FrontendLost == /\ phase \in {"ready", "publisher-down", "publisher-exit-pending"} /\ owner /\ frontend
                /\ frontend' = FALSE
                /\ phase' = IF EnforceLifetimeWatch THEN "enrolled" ELSE phase
                /\ UNCHANGED <<owner, publisher, bridge, version, selected, crashes,
                                unsafeCleanup, interruptedPublisher, boot, selectedBoot, reservation, exitProof>>
\* Observe exit without reaping; provider contention can stutter here indefinitely.
\* Compute stays live until an explicit stop or frontend loss requests cleanup.
PublisherCrash == /\ phase = "ready" /\ owner /\ publisher
                  /\ publisher' = FALSE /\ phase' = "publisher-exit-pending"
                  /\ UNCHANGED <<owner, bridge, version, selected, crashes,
                                  unsafeCleanup, interruptedPublisher, boot, selectedBoot, frontend, reservation, exitProof>>
\* Only a lease-bound journal commit authorizes an owner to clean a dead child.
CommitExit == /\ owner /\ ~publisher /\ ~exitProof
              /\ exitProof' = TRUE
              /\ phase' = IF phase = "publisher-exit-pending" THEN "publisher-down" ELSE phase
              /\ UNCHANGED <<owner, publisher, bridge, version, selected, crashes,
                              unsafeCleanup, interruptedPublisher, boot, selectedBoot, frontend, reservation>>
Crash == /\ owner /\ crashes = 0 /\ owner' = FALSE /\ crashes' = 1
         /\ UNCHANGED <<phase, publisher, bridge, version, selected,
                         unsafeCleanup, interruptedPublisher, boot, selectedBoot, frontend, reservation, exitProof>>
RestartProvider == /\ boot = "original" /\ phase # "retired"
                   /\ boot' = "successor"
                   /\ UNCHANGED <<phase, owner, publisher, bridge, version, selected,
                                   crashes, unsafeCleanup, interruptedPublisher, selectedBoot, frontend, reservation, exitProof>>
Recover == /\ ~owner /\ phase \in {"ready", "publisher-down", "publisher-exit-pending", "enrolled", "intent", "bridge-retired"}
           /\ (selected = 0 \/ selected = version)
           /\ phase' = "intent" /\ selected' = version /\ selectedBoot' = boot
           /\ UNCHANGED <<owner, publisher, bridge, version, crashes,
                           unsafeCleanup, interruptedPublisher, boot, frontend, reservation, exitProof>>
StopPublisher == /\ phase \in {"enrolled", "intent"} /\ publisher
                 /\ (owner \/ selected = version)
                 /\ publisher' = FALSE /\ exitProof' = TRUE
                 /\ UNCHANGED <<phase, owner, bridge, version, selected, crashes,
                                 unsafeCleanup, interruptedPublisher, boot, selectedBoot, frontend, reservation>>
ReplaceIdentity == /\ phase = "intent" /\ version = 1 /\ version' = 2
                   /\ UNCHANGED <<phase, owner, publisher, bridge, selected,
                                   crashes, unsafeCleanup, interruptedPublisher, boot, selectedBoot, frontend, reservation, exitProof>>
Proof == ~publisher /\ ((owner /\ boot = "original" /\ (EnforceExitProof => exitProof)) \/
                        (~owner /\ selected = version /\ selected # 0 /\ selectedBoot = boot))
ReleaseBridge == /\ phase \in {"enrolled", "intent"}
                 /\ (EnforceProof => Proof)
                 /\ phase' = "bridge-retired" /\ bridge' = FALSE
                 /\ unsafeCleanup' = ~Proof
                 /\ UNCHANGED <<owner, publisher, version, selected, crashes,
                                 interruptedPublisher, boot, selectedBoot, frontend, reservation, exitProof>>
CleanupGuest == /\ phase = "bridge-retired"
                /\ (EnforceProof => Proof)
                /\ phase' = "stopped" /\ unsafeCleanup' = ~Proof
                /\ UNCHANGED <<owner, publisher, bridge, version, selected,
                                crashes, interruptedPublisher, boot, selectedBoot, frontend, reservation, exitProof>>
\* Guest completion can commit before the dependency-reservation release.
ReleaseDependencies == /\ phase = "stopped" /\ Proof /\ reservation
                       /\ reservation' = FALSE
                       /\ UNCHANGED <<phase, owner, publisher, bridge, version, selected,
                                       crashes, unsafeCleanup, interruptedPublisher, boot,
                                       selectedBoot, frontend, exitProof>>
Retire == /\ phase = "stopped" /\ Proof
          /\ (EnforceReservationRelease => ~reservation)
          /\ phase' = "retired"
          /\ UNCHANGED <<owner, publisher, bridge, version, selected, crashes,
                          unsafeCleanup, interruptedPublisher, boot, selectedBoot, frontend, reservation, exitProof>>
Next == CommitExit \/ Interrupt \/ FrontendLost \/ PublisherCrash \/ Crash \/ RestartProvider \/ Recover \/ StopPublisher
        \/ ReplaceIdentity \/ ReleaseBridge \/ CleanupGuest \/ ReleaseDependencies \/ Retire
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"ready", "publisher-down", "publisher-exit-pending", "enrolled", "intent", "bridge-retired", "stopped", "retired"}
          /\ reservation \in BOOLEAN /\ exitProof \in BOOLEAN
          /\ owner \in BOOLEAN /\ publisher \in BOOLEAN /\ bridge \in BOOLEAN /\ frontend \in BOOLEAN
          /\ version \in 1..2 /\ selected \in 0..2 /\ crashes \in 0..1
          /\ unsafeCleanup \in BOOLEAN /\ interruptedPublisher \in BOOLEAN
          /\ boot \in {"original", "successor"}
          /\ selectedBoot \in {"none", "original", "successor"}
NoUnsafeCleanup == ~unsafeCleanup
NoInterruptRace == ~interruptedPublisher
NoSilentOrphan == (~frontend /\ owner) => phase \notin {"ready", "publisher-down", "publisher-exit-pending"}
NoPrematureRelease == ~bridge => ~publisher
NoStrandedReservation == phase = "retired" => ~reservation
NoUncommittedExit == (owner /\ ~bridge) => exitProof
NeverComplete == phase # "retired"
=======================================================================
