------------------------- MODULE PublisherStop -------------------------
EXTENDS Naturals, TLC
CONSTANTS EnforceProof, EnforceIsolation
VARIABLES phase, owner, publisher, bridge, version, selected, crashes,
          unsafeCleanup, interruptedPublisher, boot, selectedBoot
vars == <<phase, owner, publisher, bridge, version, selected, crashes,
          unsafeCleanup, interruptedPublisher, boot, selectedBoot>>

\* Live ready/enrolled owners and the actual legacy state: dead owner with an
\* independently exited or still-live publisher, on the same or successor boot.
Init == /\ phase \in {"ready", "enrolled"} /\ owner \in BOOLEAN
        /\ publisher \in BOOLEAN /\ bridge = TRUE
        /\ boot \in {"original", "successor"} /\ selectedBoot = "none"
        /\ (owner => publisher /\ boot = "original")
        /\ (~owner => phase = "enrolled")
        /\ version = 1 /\ selected = 0 /\ crashes = IF owner THEN 0 ELSE 1
        /\ unsafeCleanup = FALSE /\ interruptedPublisher = FALSE

Interrupt == /\ phase = "ready" /\ owner
             /\ phase' = "enrolled"
             /\ publisher' = IF EnforceIsolation THEN publisher ELSE FALSE
             /\ interruptedPublisher' = ~EnforceIsolation
             /\ UNCHANGED <<owner, bridge, version, selected, crashes, unsafeCleanup, boot, selectedBoot>>
Crash == /\ owner /\ crashes = 0 /\ owner' = FALSE /\ crashes' = 1
         /\ UNCHANGED <<phase, publisher, bridge, version, selected,
                         unsafeCleanup, interruptedPublisher, boot, selectedBoot>>
\* One audited immediate successor, never an inferred arbitrary older boot.
RestartProvider == /\ boot = "original" /\ phase # "retired"
                   /\ boot' = "successor"
                   /\ UNCHANGED <<phase, owner, publisher, bridge, version, selected,
                                   crashes, unsafeCleanup, interruptedPublisher, selectedBoot>>
\* Re-admit old coordinator, owner, bridge and environment evidence for the
\* selected boot; only unchanged incarnations can resume a committed intent.
Recover == /\ ~owner /\ phase \in {"ready", "enrolled", "intent", "bridge-retired"}
           /\ (selected = 0 \/ selected = version)
           /\ phase' = "intent" /\ selected' = version /\ selectedBoot' = boot
           /\ UNCHANGED <<owner, publisher, bridge, version, crashes,
                           unsafeCleanup, interruptedPublisher, boot>>
StopPublisher == /\ phase \in {"enrolled", "intent"} /\ publisher
                 /\ (owner \/ selected = version)
                 /\ publisher' = FALSE
                 /\ UNCHANGED <<phase, owner, bridge, version, selected, crashes,
                                 unsafeCleanup, interruptedPublisher, boot, selectedBoot>>
ReplaceIdentity == /\ phase = "intent" /\ version = 1 /\ version' = 2
                   /\ UNCHANGED <<phase, owner, publisher, bridge, selected,
                                   crashes, unsafeCleanup, interruptedPublisher, boot, selectedBoot>>
Proof == ~publisher /\ ((owner /\ boot = "original") \/
                        (~owner /\ selected = version /\ selected # 0 /\ selectedBoot = boot))
\* Bridge helper absence and its registry release precede container removal in
\* cleanup_owned_fenced; a crash here must keep the recovery intent resumable.
ReleaseBridge == /\ phase \in {"enrolled", "intent"}
                 /\ (EnforceProof => Proof)
                 /\ phase' = "bridge-retired" /\ bridge' = FALSE
                 /\ unsafeCleanup' = ~Proof
                 /\ UNCHANGED <<owner, publisher, version, selected, crashes,
                                 interruptedPublisher, boot, selectedBoot>>
CleanupGuest == /\ phase = "bridge-retired"
                /\ (EnforceProof => Proof)
                /\ phase' = "stopped" /\ unsafeCleanup' = ~Proof
                /\ UNCHANGED <<owner, publisher, bridge, version, selected,
                                crashes, interruptedPublisher, boot, selectedBoot>>
Retire == /\ phase = "stopped" /\ Proof
          /\ phase' = "retired"
          /\ UNCHANGED <<owner, publisher, bridge, version, selected, crashes,
                          unsafeCleanup, interruptedPublisher, boot, selectedBoot>>
Next == Interrupt \/ Crash \/ RestartProvider \/ Recover \/ StopPublisher
        \/ ReplaceIdentity \/ ReleaseBridge \/ CleanupGuest \/ Retire
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"ready", "enrolled", "intent", "bridge-retired", "stopped", "retired"}
          /\ owner \in BOOLEAN /\ publisher \in BOOLEAN /\ bridge \in BOOLEAN
          /\ version \in 1..2 /\ selected \in 0..2 /\ crashes \in 0..1
          /\ unsafeCleanup \in BOOLEAN /\ interruptedPublisher \in BOOLEAN
          /\ boot \in {"original", "successor"}
          /\ selectedBoot \in {"none", "original", "successor"}
NoUnsafeCleanup == ~unsafeCleanup
NoInterruptRace == ~interruptedPublisher
NoPrematureRelease == ~bridge => ~publisher
NeverComplete == phase # "retired"
=======================================================================
