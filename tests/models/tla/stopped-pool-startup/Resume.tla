----------------------------- MODULE Resume -----------------------------
EXTENDS Naturals, TLC
CONSTANTS EnforceSelection, EnforceNoReplay
VARIABLES phase, ownerVersion, receiptVersion, selectedOwner, selectedReceipt,
          retirementValid, locked, cancelled, attempts, uncertain,
          bootSelectionMatched, bootRetirementProved, bootAfterCancel,
          booted, liveProof, authority
identities == <<ownerVersion, receiptVersion, selectedOwner, selectedReceipt,
                retirementValid>>
effects == <<attempts, uncertain, bootSelectionMatched, bootRetirementProved,
             bootAfterCancel, booted, liveProof, authority>>
vars == <<phase, identities, locked, cancelled, effects>>
SelectionMatches == selectedOwner = ownerVersion /\ selectedReceipt = receiptVersion
EffectSafe == SelectionMatches /\ retirementValid
\* Init assumes shape-valid stopped owner/retained receipt evidence; no live proof.
Init == /\ phase = "idle" /\ ownerVersion = 1 /\ receiptVersion = 1
        /\ selectedOwner = 0 /\ selectedReceipt = 0 /\ retirementValid = TRUE
        /\ locked = FALSE /\ cancelled = FALSE /\ attempts = 0 /\ uncertain = FALSE
        /\ bootSelectionMatched = FALSE /\ bootRetirementProved = FALSE
        /\ bootAfterCancel = FALSE /\ booted = FALSE /\ liveProof = FALSE /\ authority = FALSE
Preflight == /\ phase = "idle" /\ ~cancelled /\ retirementValid
             /\ phase' = "preflight" /\ selectedOwner' = ownerVersion
             /\ selectedReceipt' = receiptVersion
             /\ UNCHANGED <<ownerVersion, receiptVersion, retirementValid,
                             locked, cancelled, effects>>
SubstituteOwner == /\ phase = "preflight" /\ ~locked /\ ownerVersion = 1
                   /\ ownerVersion' = 2
                   /\ UNCHANGED <<phase, receiptVersion, selectedOwner, selectedReceipt,
                                   retirementValid, locked, cancelled, effects>>
SubstituteReceipt == /\ phase = "preflight" /\ ~locked /\ receiptVersion = 1
                     /\ receiptVersion' = 2
                     /\ UNCHANGED <<phase, ownerVersion, selectedOwner, selectedReceipt,
                                     retirementValid, locked, cancelled, effects>>
LoseRetirement == /\ phase = "preflight" /\ ~locked /\ retirementValid
                  /\ retirementValid' = FALSE
                  /\ UNCHANGED <<phase, ownerVersion, receiptVersion, selectedOwner,
                                  selectedReceipt, locked, cancelled, effects>>
AcquireLease == /\ phase = "preflight" /\ ~cancelled
                /\ phase' = "leased" /\ locked' = TRUE
                /\ UNCHANGED <<identities, cancelled, effects>>
\* Guard revalidation and the first boot effect are atomic under the modeled lease.
\* File durability and uncooperative same-user changes are not established here.
Boot == /\ phase = "leased" /\ locked /\ ~cancelled /\ attempts = 0
        /\ retirementValid /\ (EnforceSelection => SelectionMatches)
        /\ phase' = "pending" /\ attempts' = 1
        /\ bootSelectionMatched' = SelectionMatches
        /\ bootRetirementProved' = retirementValid /\ bootAfterCancel' = cancelled
        /\ UNCHANGED <<identities, locked, cancelled, uncertain, booted, liveProof, authority>>
RefuseSelection == /\ phase = "leased" /\ ~EffectSafe
                   /\ phase' = "refused" /\ locked' = FALSE
                   /\ UNCHANGED <<identities, cancelled, effects>>
ReplySuccess == /\ phase = "pending"
                /\ phase' = "booted" /\ locked' = FALSE /\ booted' = TRUE
                /\ UNCHANGED <<identities, cancelled, attempts, uncertain,
                                bootSelectionMatched, bootRetirementProved,
                                bootAfterCancel, liveProof, authority>>
\* A lost reply consumes the attempt. booted means confirmed, not physical state.
Timeout == /\ phase = "pending"
           /\ phase' = "uncertain" /\ locked' = FALSE /\ uncertain' = TRUE
           /\ UNCHANGED <<identities, cancelled, attempts, bootSelectionMatched,
                           bootRetirementProved, bootAfterCancel, booted, liveProof, authority>>
Retry == /\ phase = "uncertain" /\ ~EnforceNoReplay /\ ~cancelled
         /\ EffectSafe /\ attempts = 1
         /\ phase' = "pending" /\ locked' = TRUE /\ attempts' = 2
         /\ bootSelectionMatched' = SelectionMatches
         /\ bootRetirementProved' = retirementValid /\ bootAfterCancel' = cancelled
         /\ UNCHANGED <<identities, cancelled, uncertain, booted, liveProof, authority>>
\* This oracle includes live resource proof and the later restore-selection guard.
InspectLive == /\ phase = "booted" /\ ~cancelled /\ booted
               /\ phase' = "proven" /\ liveProof' = TRUE
               /\ UNCHANGED <<identities, locked, cancelled, attempts, uncertain,
                               bootSelectionMatched, bootRetirementProved,
                               bootAfterCancel, booted, authority>>
RefuseLive == /\ phase = "booted" /\ ~cancelled
              /\ phase' = "refused"
              /\ UNCHANGED <<identities, locked, cancelled, effects>>
GrantGraph == /\ phase = "proven" /\ ~cancelled /\ booted /\ liveProof
              /\ phase' = "graph" /\ authority' = TRUE
              /\ UNCHANGED <<identities, locked, cancelled, attempts, uncertain,
                              bootSelectionMatched, bootRetirementProved,
                              bootAfterCancel, booted, liveProof>>
Cancel == /\ phase \notin {"graph", "refused", "cancelled"} /\ ~cancelled
          /\ cancelled' = TRUE
          /\ UNCHANGED <<phase, identities, locked, effects>>
RefuseCancelled == /\ phase \notin {"graph", "refused", "cancelled"} /\ cancelled
                   /\ phase' = "cancelled" /\ locked' = FALSE
                   /\ UNCHANGED <<identities, cancelled, effects>>
Next == Preflight \/ SubstituteOwner \/ SubstituteReceipt \/ LoseRetirement \/ AcquireLease
        \/ Boot \/ RefuseSelection \/ ReplySuccess \/ Timeout \/ Retry \/ InspectLive
        \/ RefuseLive \/ GrantGraph \/ Cancel \/ RefuseCancelled
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"idle", "preflight", "leased", "pending", "booted", "uncertain",
                         "proven", "graph", "refused", "cancelled"}
          /\ ownerVersion \in 1..2 /\ receiptVersion \in 1..2
          /\ selectedOwner \in 0..2 /\ selectedReceipt \in 0..2
          /\ retirementValid \in BOOLEAN /\ locked \in BOOLEAN /\ cancelled \in BOOLEAN
          /\ attempts \in 0..2 /\ uncertain \in BOOLEAN
          /\ bootSelectionMatched \in BOOLEAN /\ bootRetirementProved \in BOOLEAN
          /\ bootAfterCancel \in BOOLEAN /\ booted \in BOOLEAN
          /\ liveProof \in BOOLEAN /\ authority \in BOOLEAN
NoSubstitutedBoot == attempts > 0 => bootSelectionMatched
NoUnretiredBoot == attempts > 0 => bootRetirementProved
NoCancelledBoot == ~bootAfterCancel
NoUncertainReplay == uncertain => attempts <= 1
AtMostOneResume == attempts <= 1
NoOfflineAuthority == authority => (booted /\ liveProof /\ attempts = 1 /\ ~uncertain /\ ~cancelled)
NoUnleasedAttempt == phase = "pending" => locked
=======================================================================
