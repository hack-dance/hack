----------------------------- MODULE Witness -----------------------------
EXTENDS Naturals, TLC
CONSTANTS EnforceSeedOnlyCold, UnsafeSeedOperation, EnforceWitness, EnforceCompletionProof,
          EnforceImmutableExpectation, EnforceReadOnlyEnrollment, FaultKind
VARIABLES intent, expected, originalExpected, enrolled, volumePresent, metadata, marker, phase, operation, seedCapability, completionCapability, proof, authority, crashes, resumes, seedWrites, enrollmentWrites, faulted, unsafeSeed, unsafeCompletion, unsafeStart, unsafeReplacement, unsafeReenrollment, disposition
vars == <<intent, expected, originalExpected, enrolled, volumePresent, metadata, marker, phase, operation, seedCapability, completionCapability, proof, authority, crashes, resumes, seedWrites, enrollmentWrites, faulted, unsafeSeed, unsafeCompletion, unsafeStart, unsafeReplacement, unsafeReenrollment, disposition>>

\* One volume and two distinguishable marker/binding values. Existing untracked
\* storage is included so cold success cannot hide silent legacy enrollment.
Init == /\ intent = FALSE
    /\ expected = 0
    /\ originalExpected = 0
    /\ enrolled = 0
    /\ volumePresent \in BOOLEAN
    /\ metadata = 1
    /\ marker \in (IF volumePresent THEN 0..2 ELSE {0})
    /\ phase = "cold"
    /\ operation = "cold"
    /\ seedCapability = FALSE
    /\ completionCapability = FALSE
    /\ proof = FALSE
    /\ authority = 1
    /\ crashes = 0
    /\ resumes = 0
    /\ seedWrites = 0
    /\ enrollmentWrites = 0
    /\ faulted = FALSE
    /\ unsafeSeed = FALSE
    /\ unsafeCompletion = FALSE
    /\ unsafeStart = FALSE
    /\ unsafeReplacement = FALSE
    /\ unsafeReenrollment = FALSE
    /\ disposition = "none"
ExactWitness == expected # 0 /\ volumePresent /\ metadata = 1 /\ marker = expected
CanFault == volumePresent /\ ~faulted
            /\ phase \in {"created", "published", "observed", "enrolled",
                           "stopped", "checking", "checked", "crashed", "interrupted"}

\* Exclusive slot publication precedes expectation bytes; a crash can leave an empty retained intent.
ReserveIntent == /\ phase = "cold"
    /\ ~volumePresent
    /\ expected = 0
    /\ ~intent
    /\ authority = 1
    /\ intent' = TRUE
    /\ phase' = "intent"
    /\ UNCHANGED <<expected, originalExpected, enrolled, volumePresent, metadata, marker, operation, seedCapability, completionCapability, proof, authority, crashes, resumes, seedWrites, enrollmentWrites, faulted, unsafeSeed, unsafeCompletion, unsafeStart, unsafeReplacement, unsafeReenrollment, disposition>>

\* An immutable durable expectation precedes all create/write effects.
PublishExpected == /\ phase = "intent"
    /\ intent
    /\ ~volumePresent
    /\ expected = 0
    /\ authority = 1
    /\ expected' = 1
    /\ originalExpected' = 1
    /\ seedCapability' = TRUE
    /\ completionCapability' = TRUE
    /\ phase' = "expected"
    /\ UNCHANGED <<intent, enrolled, volumePresent, metadata, marker, operation, proof, authority, crashes, resumes, seedWrites, enrollmentWrites, faulted, unsafeSeed, unsafeCompletion, unsafeStart, unsafeReplacement, unsafeReenrollment, disposition>>

\* Existing storage without an expectation is not silently enrolled.
RefuseLegacy == /\ phase = "cold"
    /\ volumePresent
    /\ phase' = "refused"
    /\ disposition' = "needs-adoption"
    /\ UNCHANGED <<intent, expected, originalExpected, enrolled, volumePresent, metadata, marker, operation, seedCapability, completionCapability, proof, authority, crashes, resumes, seedWrites, enrollmentWrites, faulted, unsafeSeed, unsafeCompletion, unsafeStart, unsafeReplacement, unsafeReenrollment>>

\* Only the original live opaque capability arms once, before awaiting effects.
ArmSeed == /\ phase = "expected"
    /\ seedCapability
    /\ authority = 1
    /\ seedCapability' = FALSE
    /\ phase' = "armed"
    /\ UNCHANGED <<intent, expected, originalExpected, enrolled, volumePresent, metadata, marker, operation, completionCapability, proof, authority, crashes, resumes, seedWrites, enrollmentWrites, faulted, unsafeSeed, unsafeCompletion, unsafeStart, unsafeReplacement, unsafeReenrollment, disposition>>

\* Creation and marker publication are distinct crash boundaries.
CreateVolume == /\ phase = "armed"
    /\ ~volumePresent
    /\ authority = 1
    /\ completionCapability
    /\ volumePresent' = TRUE
    /\ phase' = "created"
    /\ UNCHANGED <<intent, expected, originalExpected, enrolled, metadata, marker, operation, seedCapability, completionCapability, proof, authority, crashes, resumes, seedWrites, enrollmentWrites, faulted, unsafeSeed, unsafeCompletion, unsafeStart, unsafeReplacement, unsafeReenrollment, disposition>>

\* An initial seed can finish only in its original live invocation.
PublishMarker == /\ phase = "created"
    /\ volumePresent
    /\ metadata = 1
    /\ authority = 1
    /\ completionCapability
    /\ seedWrites = 0
    /\ marker' = expected
    /\ seedWrites' = 1
    /\ phase' = "published"
    /\ UNCHANGED <<intent, expected, originalExpected, enrolled, volumePresent, metadata, operation, seedCapability, completionCapability, proof, authority, crashes, resumes, enrollmentWrites, faulted, unsafeSeed, unsafeCompletion, unsafeStart, unsafeReplacement, unsafeReenrollment, disposition>>

\* Read-only comparison is separate from committing the enrolled record.
ObserveEnrollment == /\ phase = "published"
    /\ proof' = ExactWitness
    /\ phase' = "observed"
    /\ UNCHANGED <<intent, expected, originalExpected, enrolled, volumePresent, metadata, marker, operation, seedCapability, completionCapability, authority, crashes, resumes, seedWrites, enrollmentWrites, faulted, unsafeSeed, unsafeCompletion, unsafeStart, unsafeReplacement, unsafeReenrollment, disposition>>

\* Recheck exact current marker and metadata after the observation await.
CommitEnrollment == /\ phase = "observed"
    /\ completionCapability
    /\ authority = 1
    /\ enrolled = 0
    /\ (EnforceCompletionProof => (proof /\ ExactWitness))
    /\ enrolled' = expected
    /\ enrollmentWrites' = enrollmentWrites + 1
    /\ completionCapability' = FALSE
    /\ phase' = "enrolled"
    /\ unsafeCompletion' = ~(proof /\ ExactWitness)
    /\ UNCHANGED <<intent, expected, originalExpected, volumePresent, metadata, marker, operation, seedCapability, proof, authority, crashes, resumes, seedWrites, faulted, unsafeSeed, unsafeStart, unsafeReplacement, unsafeReenrollment, disposition>>

\* Failure preserves the original durable expected bytes and never claims completion.
RefuseEnrollment == /\ phase = "observed"
    /\ ~(proof /\ ExactWitness /\ authority = 1)
    /\ phase' = "refused"
    /\ completionCapability' = FALSE
    /\ disposition' = "needs-explicit-reconcile"
    /\ UNCHANGED <<intent, expected, originalExpected, enrolled, volumePresent, metadata, marker, operation, seedCapability, proof, authority, crashes, resumes, seedWrites, enrollmentWrites, faulted, unsafeSeed, unsafeCompletion, unsafeStart, unsafeReplacement, unsafeReenrollment>>

\* Workload admission requires an enrolled reference and a fresh exact witness.
StartWorkload == /\ phase \in {"enrolled", "checked"}
    /\ enrolled # 0
    /\ enrolled = expected
    /\ authority = 1
    /\ (EnforceWitness => (proof /\ ExactWitness))
    /\ phase' = "running"
    /\ unsafeStart' = ~(proof /\ ExactWitness)
    /\ UNCHANGED <<intent, expected, originalExpected, enrolled, volumePresent, metadata, marker, operation, seedCapability, completionCapability, proof, authority, crashes, resumes, seedWrites, enrollmentWrites, faulted, unsafeSeed, unsafeCompletion, unsafeReplacement, unsafeReenrollment, disposition>>

\* Stop retains the enrollment and data witness; it cannot enroll a successor.
Down == /\ phase = "running"
    /\ resumes = 0
    /\ phase' = "stopped"
    /\ UNCHANGED <<intent, expected, originalExpected, enrolled, volumePresent, metadata, marker, operation, seedCapability, completionCapability, proof, authority, crashes, resumes, seedWrites, enrollmentWrites, faulted, unsafeSeed, unsafeCompletion, unsafeStart, unsafeReplacement, unsafeReenrollment, disposition>>

\* A new invocation receives only read-only authority, not initial seed/completion capabilities.
BeginResume == /\ phase = "stopped"
    /\ resumes = 0
    /\ operation' = "resume"
    /\ phase' = "checking"
    /\ seedCapability' = FALSE
    /\ completionCapability' = FALSE
    /\ proof' = FALSE
    /\ resumes' = 1
    /\ UNCHANGED <<intent, expected, originalExpected, enrolled, volumePresent, metadata, marker, authority, crashes, seedWrites, enrollmentWrites, faulted, unsafeSeed, unsafeCompletion, unsafeStart, unsafeReplacement, unsafeReenrollment, disposition>>

\* Resume and recovery observe the exact retained expectation without writing data.
ReadWitness == /\ phase = "checking"
    /\ enrolled # 0
    /\ proof' = ExactWitness
    /\ phase' = "checked"
    /\ UNCHANGED <<intent, expected, originalExpected, enrolled, volumePresent, metadata, marker, operation, seedCapability, completionCapability, authority, crashes, resumes, seedWrites, enrollmentWrites, faulted, unsafeSeed, unsafeCompletion, unsafeStart, unsafeReplacement, unsafeReenrollment, disposition>>

\* Missing or wrong witness refuses even if physical name, labels and birth still match.
RefuseResume == /\ phase = "checked"
    /\ ~(proof /\ ExactWitness /\ authority = 1)
    /\ phase' = "refused"
    /\ disposition' = "witness-mismatch"
    /\ UNCHANGED <<intent, expected, originalExpected, enrolled, volumePresent, metadata, marker, operation, seedCapability, completionCapability, proof, authority, crashes, resumes, seedWrites, enrollmentWrites, faulted, unsafeSeed, unsafeCompletion, unsafeStart, unsafeReplacement, unsafeReenrollment>>

\* One crash revokes live capabilities while retaining all published records and marker bytes.
Crash == /\ crashes = 0
    /\ phase \notin {"running", "refused", "crashed"}
    /\ phase' = "crashed"
    /\ seedCapability' = FALSE
    /\ completionCapability' = FALSE
    /\ proof' = FALSE
    /\ crashes' = 1
    /\ UNCHANGED <<intent, expected, originalExpected, enrolled, volumePresent, metadata, marker, operation, authority, resumes, seedWrites, enrollmentWrites, faulted, unsafeSeed, unsafeCompletion, unsafeStart, unsafeReplacement, unsafeReenrollment, disposition>>

\* A fresh validated mutation can read saved state, but cannot mint initial enrollment authority.
Recover == /\ phase = "crashed"
    /\ operation' = "recovery"
    /\ phase' = (IF enrolled # 0 THEN "checking" ELSE "interrupted")
    /\ seedCapability' = FALSE
    /\ completionCapability' = FALSE
    /\ proof' = FALSE
    /\ authority' = 1
    /\ UNCHANGED <<intent, expected, originalExpected, enrolled, volumePresent, metadata, marker, crashes, resumes, seedWrites, enrollmentWrites, faulted, unsafeSeed, unsafeCompletion, unsafeStart, unsafeReplacement, unsafeReenrollment, disposition>>

\* An interrupted Expected refuses even when its marker matches; reconciliation is a separate future contract.
RecoveryDisposition == /\ phase = "interrupted"
    /\ phase' = "refused"
    /\ disposition' = (IF intent THEN "needs-explicit-reconcile" ELSE "needs-adoption")
    /\ UNCHANGED <<intent, expected, originalExpected, enrolled, volumePresent, metadata, marker, operation, seedCapability, completionCapability, proof, authority, crashes, resumes, seedWrites, enrollmentWrites, faulted, unsafeSeed, unsafeCompletion, unsafeStart, unsafeReplacement, unsafeReenrollment>>

\* Same metadata and physical name can describe a new empty volume; only the witness changes.
EmptyReplacement == /\ CanFault
    /\ FaultKind \in {"all", "empty"}
    /\ marker' = 0
    /\ faulted' = TRUE
    /\ UNCHANGED <<intent, expected, originalExpected, enrolled, volumePresent, metadata, phase, operation, seedCapability, completionCapability, proof, authority, crashes, resumes, seedWrites, enrollmentWrites, unsafeSeed, unsafeCompletion, unsafeStart, unsafeReplacement, unsafeReenrollment, disposition>>

\* Wrong contents are independently distinguishable from an absent marker.
WrongMarker == /\ CanFault
    /\ FaultKind \in {"all", "wrong"}
    /\ marker' = 2
    /\ faulted' = TRUE
    /\ UNCHANGED <<intent, expected, originalExpected, enrolled, volumePresent, metadata, phase, operation, seedCapability, completionCapability, proof, authority, crashes, resumes, seedWrites, enrollmentWrites, unsafeSeed, unsafeCompletion, unsafeStart, unsafeReplacement, unsafeReenrollment, disposition>>

\* Even a copied marker does not authorize a different engine/owner/resource binding.
ForeignMetadata == /\ CanFault
    /\ FaultKind \in {"all", "foreign"}
    /\ metadata' = 2
    /\ faulted' = TRUE
    /\ UNCHANGED <<intent, expected, originalExpected, enrolled, volumePresent, marker, phase, operation, seedCapability, completionCapability, proof, authority, crashes, resumes, seedWrites, enrollmentWrites, unsafeSeed, unsafeCompletion, unsafeStart, unsafeReplacement, unsafeReenrollment, disposition>>

\* Ownership or pending selection may drift during an await.
DriftAuthority == /\ phase \in {"intent", "expected", "armed", "created", "published", "observed", "enrolled", "stopped", "checking", "checked"}
    /\ authority = 1
    /\ authority' = 2
    /\ UNCHANGED <<intent, expected, originalExpected, enrolled, volumePresent, metadata, marker, phase, operation, seedCapability, completionCapability, proof, crashes, resumes, seedWrites, enrollmentWrites, faulted, unsafeSeed, unsafeCompletion, unsafeStart, unsafeReplacement, unsafeReenrollment, disposition>>

\* Intentionally unsafe control: healing a missing witness on resume destroys continuity evidence.
SeedOnResume == /\ ~EnforceSeedOnlyCold
    /\ UnsafeSeedOperation = "resume"
    /\ operation = "resume"
    /\ phase \in {"checking", "checked"}
    /\ expected # 0
    /\ marker # expected
    /\ seedWrites = 1
    /\ marker' = expected
    /\ seedWrites' = 2
    /\ unsafeSeed' = TRUE
    /\ UNCHANGED <<intent, expected, originalExpected, enrolled, volumePresent, metadata, phase, operation, seedCapability, completionCapability, proof, authority, crashes, resumes, enrollmentWrites, faulted, unsafeCompletion, unsafeStart, unsafeReplacement, unsafeReenrollment, disposition>>

\* Intentionally unsafe control: replacing old expected bytes must never make new storage acceptable.
ReplaceExpectation == /\ ~EnforceImmutableExpectation
    /\ phase = "checking"
    /\ expected = 1
    /\ expected' = 2
    /\ unsafeReplacement' = TRUE
    /\ UNCHANGED <<intent, originalExpected, enrolled, volumePresent, metadata, marker, phase, operation, seedCapability, completionCapability, proof, authority, crashes, resumes, seedWrites, enrollmentWrites, faulted, unsafeSeed, unsafeCompletion, unsafeStart, unsafeReenrollment, disposition>>

\* Intentionally unsafe control: read-only reopen must not append a new enrollment.
ReenrollReadOnly == /\ ~EnforceReadOnlyEnrollment
    /\ operation \in {"resume", "recovery"}
    /\ phase = "checked"
    /\ proof /\ ExactWitness
    /\ enrolled = expected
    /\ enrollmentWrites = 1
    /\ enrollmentWrites' = 2
    /\ unsafeReenrollment' = TRUE
    /\ UNCHANGED <<intent, expected, originalExpected, enrolled, volumePresent, metadata, marker, phase, operation, seedCapability, completionCapability, proof, authority, crashes, resumes, seedWrites, faulted, unsafeSeed, unsafeCompletion, unsafeStart, unsafeReplacement, disposition>>

\* Intentionally unsafe control: interrupted saved Expected never grants a recovery seed.
SeedOnRecovery == /\ ~EnforceSeedOnlyCold
    /\ UnsafeSeedOperation = "recovery"
    /\ operation = "recovery"
    /\ phase = "interrupted"
    /\ volumePresent
    /\ expected # 0
    /\ marker # expected
    /\ seedWrites = 0
    /\ marker' = expected
    /\ seedWrites' = 1
    /\ unsafeSeed' = TRUE
    /\ UNCHANGED <<intent, expected, originalExpected, enrolled, volumePresent, metadata, phase, operation, seedCapability, completionCapability, proof, authority, crashes, resumes, enrollmentWrites, faulted, unsafeCompletion, unsafeStart, unsafeReplacement, unsafeReenrollment, disposition>>

Next == ReserveIntent \/ PublishExpected \/ RefuseLegacy \/ ArmSeed \/ CreateVolume \/ PublishMarker \/ ObserveEnrollment \/ CommitEnrollment \/ RefuseEnrollment \/ StartWorkload \/ Down \/ BeginResume \/ ReadWitness \/ RefuseResume \/ Crash \/ Recover \/ RecoveryDisposition \/ EmptyReplacement \/ WrongMarker \/ ForeignMetadata \/ DriftAuthority \/ SeedOnResume \/ SeedOnRecovery \/ ReplaceExpectation \/ ReenrollReadOnly
Spec == Init /\ [][Next]_vars
TypeOK == /\ intent \in BOOLEAN
    /\ expected \in 0..2
    /\ originalExpected \in 0..1
    /\ enrolled \in 0..2
    /\ volumePresent \in BOOLEAN
    /\ metadata \in 1..2
    /\ marker \in 0..2
    /\ phase \in {"cold", "intent", "expected", "armed", "created", "published", "observed", "enrolled", "running", "stopped", "checking", "checked", "crashed", "interrupted", "refused"}
    /\ operation \in {"cold", "resume", "recovery"}
    /\ seedCapability \in BOOLEAN
    /\ completionCapability \in BOOLEAN
    /\ proof \in BOOLEAN
    /\ authority \in 1..2
    /\ crashes \in 0..1
    /\ resumes \in 0..1
    /\ seedWrites \in 0..2
    /\ enrollmentWrites \in 0..2
    /\ faulted \in BOOLEAN
    /\ unsafeSeed \in BOOLEAN
    /\ unsafeCompletion \in BOOLEAN
    /\ unsafeStart \in BOOLEAN
    /\ unsafeReplacement \in BOOLEAN
    /\ unsafeReenrollment \in BOOLEAN
    /\ disposition \in {"none", "needs-adoption", "needs-explicit-reconcile", "witness-mismatch"}
NoUnanchoredCapability == (seedCapability \/ completionCapability) => (intent /\ expected # 0)
NoSeedOnReopen == ~unsafeSeed
NoUnprovedCompletion == ~unsafeCompletion
NoWorkloadWithoutWitness == ~unsafeStart
NoChangedExpectation == ~unsafeReplacement /\ expected = originalExpected
NoReadOnlyReenrollment == ~unsafeReenrollment /\ enrollmentWrites <= 1
NoRecoveredCapability == operation # "cold" => (~seedCapability /\ ~completionCapability)

\* Required violations of these predicates demonstrate safe useful paths.
NeverColdWorkload == ~(phase = "running" /\ operation = "cold")
NeverReadOnlyResume == ~(phase = "running" /\ operation = "resume"
                        /\ resumes = 1 /\ seedWrites = 1 /\ enrollmentWrites = 1)
NeverEnrolledRecovery == ~(phase = "running" /\ operation = "recovery"
                          /\ crashes = 1 /\ seedWrites = 1 /\ enrollmentWrites = 1)
NeverEmptyIntentRefusal ==
    ~(phase = "refused" /\ operation = "recovery" /\ intent /\ expected = 0
      /\ enrolled = 0 /\ ~volumePresent /\ marker = 0
      /\ disposition = "needs-explicit-reconcile")
NeverInterruptedMissingRefusal ==
    ~(phase = "refused" /\ operation = "recovery" /\ expected = 1 /\ enrolled = 0
      /\ volumePresent /\ marker = 0 /\ metadata = 1
      /\ seedWrites = 0 /\ disposition = "needs-explicit-reconcile")
NeverInterruptedMatchingRefusal ==
    ~(phase = "refused" /\ operation = "recovery" /\ expected = 1 /\ enrolled = 0
      /\ volumePresent /\ marker = 1 /\ metadata = 1
      /\ seedWrites = 1 /\ disposition = "needs-explicit-reconcile")
NeverMissingResumeRefusal ==
    ~(phase = "refused" /\ operation = "resume" /\ expected = 1 /\ enrolled = 1
      /\ marker = 0 /\ metadata = 1 /\ disposition = "witness-mismatch")
NeverWrongResumeRefusal ==
    ~(phase = "refused" /\ operation = "resume" /\ expected = 1 /\ enrolled = 1
      /\ marker = 2 /\ metadata = 1 /\ disposition = "witness-mismatch")
NeverStaleProofRefusal ==
    ~(phase = "refused" /\ operation = "cold" /\ expected = 1 /\ enrolled = 0
      /\ marker = 0 /\ proof /\ disposition = "needs-explicit-reconcile")
NeverLegacyRefusal == ~(phase = "refused" /\ expected = 0 /\ volumePresent
                       /\ disposition = "needs-adoption")
=======================================================================
