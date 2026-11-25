--------------------------- MODULE DetachedPoolWatch ---------------------------
EXTENDS Naturals

CONSTANTS BindAtAdmission, RequireSameBoot, MaxBoot
VARIABLES phase, boot, live, selected, watched, grace, graph, stopped
vars == <<phase, boot, live, selected, watched, grace, graph, stopped>>

TypeOK ==
    /\ phase \in {"Selecting", "Bound", "Serving", "Retiring", "Settled"}
    /\ boot \in 1..MaxBoot /\ live \in BOOLEAN
    /\ selected \in 0..MaxBoot /\ watched \in 0..MaxBoot
    /\ grace \in 0..MaxBoot /\ graph \in 0..MaxBoot /\ stopped \in 0..MaxBoot

Init ==
    /\ phase = "Selecting" /\ boot = 1 /\ live = FALSE
    /\ selected = 0 /\ watched = 0 /\ grace = 0 /\ graph = 0 /\ stopped = 0

\* Old watch could read a running record whose provider had already exited.
ReadBeforeAdmission ==
    /\ ~BindAtAdmission /\ phase = "Selecting" /\ watched = 0
    /\ watched' = boot
    /\ UNCHANGED <<phase, boot, live, selected, grace, graph, stopped>>

\* Reboot may be part of this recovery or may be ordered by another up.
BootPool ==
    /\ ~live /\ boot < MaxBoot
    /\ boot' = boot + 1 /\ live' = TRUE
    /\ UNCHANGED <<phase, selected, watched, grace, graph, stopped>>

LoseProvider ==
    /\ live /\ live' = FALSE
    /\ UNCHANGED <<phase, boot, selected, watched, grace, graph, stopped>>

\* The successful runtime up reply binds this attempt to the admitted boot.
Bind ==
    /\ phase = "Selecting" /\ live
    /\ phase' = "Bound" /\ selected' = boot
    /\ watched' = IF BindAtAdmission \/ watched = 0 THEN boot ELSE watched
    /\ UNCHANGED <<boot, live, grace, graph, stopped>>

\* The graph's relay constructor compares the expected boot under the lease.
\* This includes the eventual readiness handoff, with or without HTTPS.
Serve ==
    /\ phase = "Bound" /\ live /\ (~RequireSameBoot \/ selected = boot)
    /\ phase' = "Serving" /\ graph' = boot
    /\ UNCHANGED <<boot, live, selected, watched, grace, stopped>>

Refuse ==
    /\ RequireSameBoot /\ phase = "Bound" /\ (~live \/ selected /= boot)
    /\ phase' = "Settled"
    /\ UNCHANGED <<boot, live, selected, watched, grace, graph, stopped>>

\* An indeterminate record has no transition. Evidence that the watched boot
\* ended sets the grace once and keeps its provenance.
ObserveEnded ==
    /\ phase \in {"Selecting", "Bound", "Serving"} /\ watched /= 0
    /\ grace = 0 /\ (~live \/ watched /= boot)
    /\ grace' = watched
    /\ UNCHANGED <<phase, boot, live, selected, watched, graph, stopped>>

\* Timer expiry retires its own frontend. The graph sees that exit separately.
ExpireGrace ==
    /\ phase \in {"Selecting", "Bound", "Serving"} /\ grace /= 0
    /\ phase' = "Retiring"
    /\ UNCHANGED <<boot, live, selected, watched, grace, graph, stopped>>

\* The graph cleans up on genuine parent loss. A lost boot has no live graph
\* to stop. The model assumes the existing native cleanup selects its own run.
OwnerCleanup ==
    /\ phase = "Retiring"
    /\ phase' = "Settled"
    /\ stopped' = IF live /\ graph = boot THEN graph ELSE 0
    /\ UNCHANGED <<boot, live, selected, watched, grace, graph>>

\* Normal down or startup completion cancels the watch.
Finish ==
    /\ phase \in {"Bound", "Serving"}
    /\ phase' = "Settled"
    /\ UNCHANGED <<boot, live, selected, watched, grace, graph, stopped>>

Next == ReadBeforeAdmission \/ BootPool \/ LoseProvider \/ Bind \/ Serve
        \/ Refuse \/ ObserveEnded \/ ExpireGrace \/ OwnerCleanup \/ Finish
Spec == Init /\ [][Next]_vars

NoStaleCleanup == stopped = 0 \/ stopped = grace
=============================================================================
