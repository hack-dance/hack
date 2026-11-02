---------------------------- MODULE Barrier ----------------------------
EXTENDS Integers, FiniteSets, TLC
CONSTANT BypassBarrier
Services == {1, 2}
VARIABLES phase, targets, journal, generation, active, connections, connectionGen,
          ownerAlive, ownerEpoch, deathObserved, coordinatorAlive, commandEpoch,
          ackOwner, ackCommand, unsafeCommit, unsafeWrite, reopened, unrelatedWrite
vars == <<phase, targets, journal, generation, active, connections, connectionGen,
          ownerAlive, ownerEpoch, deathObserved, coordinatorAlive, commandEpoch,
          ackOwner, ackCommand, unsafeCommit, unsafeWrite, reopened, unrelatedWrite>>
Init == /\ phase = "ready" /\ targets = {} /\ journal = FALSE
        /\ generation = [s \in Services |-> 0]
        /\ active = Services /\ connections = Services
        /\ connectionGen = [s \in Services |-> 0]
        /\ ownerAlive = TRUE /\ ownerEpoch = 0 /\ deathObserved = FALSE
        /\ coordinatorAlive = TRUE /\ commandEpoch = 0
        /\ ackOwner = -1 /\ ackCommand = -1
        /\ unsafeCommit = FALSE /\ unsafeWrite = FALSE
        /\ reopened = FALSE /\ unrelatedWrite = FALSE
BeginMutation ==
    /\ phase = "ready" /\ coordinatorAlive
    /\ targets' \in (SUBSET Services) \ {{}}
    /\ journal' = TRUE /\ phase' = "intent"
    /\ UNCHANGED <<generation, active, connections, connectionGen, ownerAlive,
        ownerEpoch, deathObserved, coordinatorAlive, commandEpoch, ackOwner,
        ackCommand, unsafeCommit, unsafeWrite, reopened, unrelatedWrite>>
Revoke(s) ==
    /\ phase = "intent" /\ journal /\ ownerAlive /\ s \in targets /\ s \in active
    /\ active' = active \ {s}
    /\ UNCHANGED <<phase, targets, journal, generation, connections, connectionGen,
        ownerAlive, ownerEpoch, deathObserved, coordinatorAlive, commandEpoch,
        ackOwner, ackCommand, unsafeCommit, unsafeWrite, reopened, unrelatedWrite>>
Drain(s) ==
    /\ phase = "intent" /\ ownerAlive /\ s \in targets /\ s \notin active
    /\ s \in connections /\ connections' = connections \ {s}
    /\ UNCHANGED <<phase, targets, journal, generation, active, connectionGen,
        ownerAlive, ownerEpoch, deathObserved, coordinatorAlive, commandEpoch,
        ackOwner, ackCommand, unsafeCommit, unsafeWrite, reopened, unrelatedWrite>>
Acknowledge ==
    /\ phase = "intent" /\ ownerAlive /\ coordinatorAlive
    /\ active \intersect targets = {} /\ connections \intersect targets = {}
    /\ ackOwner' = ownerEpoch /\ ackCommand' = commandEpoch
    /\ UNCHANGED <<phase, targets, journal, generation, active, connections,
        connectionGen, ownerAlive, ownerEpoch, deathObserved, coordinatorAlive,
        commandEpoch, unsafeCommit, unsafeWrite, reopened, unrelatedWrite>>
LoseAck ==
    /\ ackOwner >= 0 /\ ackCommand >= 0
    /\ ackOwner' = -1 /\ ackCommand' = -1
    /\ UNCHANGED <<phase, targets, journal, generation, active, connections,
        connectionGen, ownerAlive, ownerEpoch, deathObserved, coordinatorAlive,
        commandEpoch, unsafeCommit, unsafeWrite, reopened, unrelatedWrite>>
OwnerCrash ==
    /\ ownerAlive /\ ownerAlive' = FALSE /\ active' = {} /\ connections' = {}
    /\ UNCHANGED <<phase, targets, journal, generation, connectionGen, ownerEpoch,
        deathObserved, coordinatorAlive, commandEpoch, ackOwner, ackCommand,
        unsafeCommit, unsafeWrite, reopened, unrelatedWrite>>
ObserveDeath ==
    /\ ~ownerAlive /\ deathObserved' = TRUE
    /\ UNCHANGED <<phase, targets, journal, generation, active, connections,
        connectionGen, ownerAlive, ownerEpoch, coordinatorAlive, commandEpoch,
        ackOwner, ackCommand, unsafeCommit, unsafeWrite, reopened, unrelatedWrite>>
RestartOwner ==
    /\ ~ownerAlive /\ ownerEpoch = 0
    /\ ownerAlive' = TRUE /\ ownerEpoch' = 1 /\ deathObserved' = FALSE
    /\ UNCHANGED <<phase, targets, journal, generation, active, connections,
        connectionGen, coordinatorAlive, commandEpoch, ackOwner, ackCommand,
        unsafeCommit, unsafeWrite, reopened, unrelatedWrite>>
CoordinatorCrash ==
    /\ coordinatorAlive /\ commandEpoch = 0 /\ coordinatorAlive' = FALSE
    /\ UNCHANGED <<phase, targets, journal, generation, active, connections,
        connectionGen, ownerAlive, ownerEpoch, deathObserved, commandEpoch,
        ackOwner, ackCommand, unsafeCommit, unsafeWrite, reopened, unrelatedWrite>>
RecoverCoordinator ==
    /\ ~coordinatorAlive /\ commandEpoch = 0
    /\ coordinatorAlive' = TRUE /\ commandEpoch' = 1
    /\ UNCHANGED <<phase, targets, journal, generation, active, connections,
        connectionGen, ownerAlive, ownerEpoch, deathObserved, ackOwner, ackCommand,
        unsafeCommit, unsafeWrite, reopened, unrelatedWrite>>
BeginEffect ==
    /\ phase = "intent" /\ coordinatorAlive /\ journal
    /\ (BypassBarrier \/ (ackOwner = ownerEpoch /\ ackCommand = commandEpoch)
                      \/ (~ownerAlive /\ deathObserved))
    /\ unsafeCommit' = (active \intersect targets # {} \/ connections \intersect targets # {})
    /\ generation' = [s \in Services |-> IF s \in targets THEN 1 ELSE generation[s]]
    /\ phase' = "effect-started"
    /\ UNCHANGED <<targets, journal, active, connections, connectionGen,
        ownerAlive, ownerEpoch, deathObserved, coordinatorAlive, commandEpoch,
        ackOwner, ackCommand, unsafeWrite, reopened, unrelatedWrite>>
\* Confirmation is a separate verified observation, not an atomic effect/receipt write.
ConfirmEffect ==
    /\ phase = "effect-started" /\ coordinatorAlive
    /\ phase' = "mutated"
    /\ UNCHANGED <<targets, journal, generation, active, connections, connectionGen,
        ownerAlive, ownerEpoch, deathObserved, coordinatorAlive, commandEpoch,
        ackOwner, ackCommand, unsafeCommit, unsafeWrite, reopened, unrelatedWrite>>
Register(s) ==
    /\ ownerAlive /\ s \notin connections
    /\ (~journal \/ s \notin targets \/ phase = "mutated")
    /\ active' = active \union {s} /\ connections' = connections \union {s}
    /\ connectionGen' = [connectionGen EXCEPT ![s] = generation[s]]
    /\ reopened' = (reopened \/ (phase = "mutated" /\ s \in targets))
    /\ UNCHANGED <<phase, targets, journal, generation, ownerAlive, ownerEpoch,
        deathObserved, coordinatorAlive, commandEpoch, ackOwner, ackCommand,
        unsafeCommit, unsafeWrite, unrelatedWrite>>
Write(s) ==
    /\ ownerAlive /\ s \in active /\ s \in connections
    /\ unsafeWrite' = (unsafeWrite \/ (connectionGen[s] # generation[s]))
    /\ unrelatedWrite' = (unrelatedWrite \/ (phase = "intent" /\ s \notin targets))
    /\ UNCHANGED <<phase, targets, journal, generation, active, connections,
        connectionGen, ownerAlive, ownerEpoch, deathObserved, coordinatorAlive,
        commandEpoch, ackOwner, ackCommand, unsafeCommit, reopened>>
Next == BeginMutation \/ Acknowledge \/ LoseAck \/ OwnerCrash
        \/ ObserveDeath \/ RestartOwner \/ CoordinatorCrash \/ RecoverCoordinator
        \/ BeginEffect \/ ConfirmEffect \/ (\E s \in Services : Revoke(s) \/ Drain(s) \/ Register(s) \/ Write(s))
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"ready", "intent", "effect-started", "mutated"} /\ targets \subseteq Services
          /\ journal \in BOOLEAN /\ generation \in [Services -> 0..1]
          /\ active \subseteq connections /\ connections \subseteq Services
          /\ connectionGen \in [Services -> 0..1] /\ ownerAlive \in BOOLEAN
          /\ ownerEpoch \in 0..1 /\ deathObserved \in BOOLEAN
          /\ coordinatorAlive \in BOOLEAN /\ commandEpoch \in 0..1
          /\ ackOwner \in {-1, 0, 1} /\ ackCommand \in {-1, 0, 1}
          /\ unsafeCommit \in BOOLEAN /\ unsafeWrite \in BOOLEAN
          /\ reopened \in BOOLEAN /\ unrelatedWrite \in BOOLEAN
NoUnretiredTarget == ~unsafeCommit
NoWrongGenerationWrite == ~unsafeWrite
=============================================================================
