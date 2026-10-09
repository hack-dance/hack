------------------------ MODULE MetadataAliasing ------------------------
EXTENDS Naturals
CONSTANT EnforceRootWitness
VARIABLES phase, actualVolume, reportedMetadata, capturedMetadata,
          witness, expectedWitness, matched
vars == <<phase, actualVolume, reportedMetadata, capturedMetadata,
          witness, expectedWitness, matched>>

\* A previously enrolled original; reported metadata abstracts ALL selected
\* name/labels/CreatedAt/device/inode values. They are not a unique incarnation.
Init == /\ phase = "retained" /\ actualVolume = 1
        /\ reportedMetadata = 1 /\ capturedMetadata = 1
        /\ witness = 1 /\ expectedWitness = 1 /\ matched = FALSE

\* An empty successor can report the SAME complete metadata tuple. It does
\* not contain the original root witness. Whole-root/xattr copying is excluded.
ReplaceWithAliasedMetadata == /\ phase = "retained"
                             /\ actualVolume' = 2 /\ witness' = 0
                             /\ phase' = "replaced"
                             /\ UNCHANGED <<reportedMetadata, capturedMetadata,
                                   expectedWitness, matched>>
ReadRetained == /\ phase \in {"retained", "replaced"}
               /\ reportedMetadata = capturedMetadata
               /\ (~EnforceRootWitness \/ witness = expectedWitness)
               /\ matched' = TRUE /\ phase' = "observed"
               /\ UNCHANGED <<actualVolume, reportedMetadata, capturedMetadata,
                     witness, expectedWitness>>
Next == ReplaceWithAliasedMetadata \/ ReadRetained
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"retained", "replaced", "observed"}
          /\ actualVolume \in 1..2
          /\ reportedMetadata = 1 /\ capturedMetadata = 1
          /\ witness \in 0..1 /\ expectedWitness = 1
          /\ matched \in BOOLEAN
NoAliasedMatch == matched => actualVolume = 1
=========================================================================
