----------------------------- MODULE PoolStart -----------------------------
\* One `runtime up` of a pool that is not running: host admission samples, the
\* content proofs, the startup lease and the first `machine start`.
\* Source: packages/runtime-core/src/provider/lifecycle.rs (start_pool_observed,
\* startup_admission_lease), provider/admission.rs (open, recheck_after_lease,
\* check, sample_checked), lifecycle/leased_trees.rs (recheck),
\* lifecycle/rootfs_proof.rs (prove, recheck) and
\* lifecycle/admission_pool.rs (settle, admit_boot) and
\* provider/admission/opening.rs (the record of an earlier passing sample).
EXTENDS Naturals, Sequences
CONSTANTS Window,               \* ticks between chained samples
          ResearchQuota,        \* Research samples before the lease
          MaxSwapouts,          \* bound on the host swapout counter
          MaxDips,              \* bound on the host failing and recovering
          EnforceFirstCheck,    \* the first sample must pass every predicate
          EnforceRecheckHost,   \* ... and Development's sample under the lease
          EnforceResearchHost,  \* ... and Research's second and third samples
          RootProofBeforeLease, \* TRUE: this start proved them in the window
          SampleUnderLease,     \* Development's second sample needs the lease
          EnforceWindow,        \* ... and the elapsed window
          EnforceChain,         \* ... and the first sample's swapout count
          ChainToBoot,          \* pre-boot check uses the last sample's count
          EnforceRootRecheck,   \* root metadata recheck under the lease
          EnforceTreeRecheck,   \* trees rechecked under the lease
          EnforceBootHost,      \* pre-boot observation must pass every predicate
          EnforceBootChain,     \* ... and show the count it is compared against
          EnforceRecordPassing, \* only a passing sample is recorded
          EnforceRecordBoot,    \* a reused record is from this OS boot
          EnforceRecordMinAge,  \* ... at least one window old
          EnforceRecordMaxAge,  \* ... at most one bound old
          EnforceRecordChain    \* ... with the leased sample's swapout count
VARIABLES profile, pc, lease, elapsed, hostOk, swapouts, dips, failedSince,
          acrossDip, samples, baseline, bootSample, bootAcrossDip, treeOk,
          treeProved, rootOk, rootProved, alias, selected, poolRunning, vm,
          recBoot, recAge, recSwap, recOk, recDip,
          reusedBoot, reusedAge, reusedSwap, reusedDip, missed
\* What the host is now, and what the observations did not see of it:
\* failedSince, the host failed at some moment since the last accepted
\* observation; acrossDip, some accepted sample came after such a moment.
host == <<hostOk, swapouts, dips, failedSince, acrossDip>>
\* The pre-boot check: the count it compared against, what it observed, and
\* whether the host had failed between the last sample and that observation.
boot == <<baseline, bootSample, bootAcrossDip>>
\* This home's record of an earlier passing sample: absent ("none"), or from
\* this OS boot or another; its age class against the window and the bound; the
\* sample's swapout count; whether the host passed when it was taken; and
\* whether the host has failed since.
rec == <<recBoot, recAge, recSwap, recOk, recDip>>
\* What this start made of it: the record it reused in place of the wait, as it
\* was then ("none": it reused nothing), or that it waited past an unusable one.
reuse == <<reusedBoot, reusedAge, reusedSwap, reusedDip, missed>>
kept == <<boot, rec, reuse>>
proofs == <<treeOk, treeProved, rootOk, rootProved>>
owner == <<alias, selected>>
vars == <<profile, pc, lease, elapsed, host, samples, kept, proofs, owner,
          poolRunning, vm>>
Terminal == {"Started", "Refused", "Crashed", "Joined"}
BeforeLease == {"Idle", "Opened", "Proven"}
LeasedSteps == {"Leased", "Qualified", "Settled", "RootProven", "BootAdmitted"}
\* The start keeps the lease through `machine start` and the rest of the boot.
UnderLease == LeasedSteps \cup {"Started"}
Development == profile = "development"
Quota == IF Development THEN 2 ELSE ResearchQuota
\* The owner record is rewritten only when its alias moves to a fresh name.
OwnerVersion == IF alias = "moved" THEN 2 ELSE 1
Last == samples[Len(samples)]
\* Guards, named as the state chart names them.
WindowElapsed == elapsed = Window
SameSwapouts == swapouts = Last.swap
SameOwner == selected \in {0, OwnerVersion}
\* One host observation. hostOk stands for every predicate of admission::check
\* except the swapout chain; `gap` is the time since the previous sample and `ok`
\* is whether the host passed those predicates when the sample was taken.
Observe(leased) ==
    [swap |-> swapouts, gap |-> elapsed, leased |-> leased, ok |-> hostOk]
\* A sample is still due after one already taken ...
SampleDue == samples # <<>> /\ Len(samples) < Quota
\* ... or the pre-boot observation is: the stretch a dip can hide in.
ObservationDue == samples # <<>> /\ bootSample = <<>>
\* An accepted sample starts the next window and ends the stretch before it.
Accept(leased) == /\ samples' = Append(samples, Observe(leased)) /\ elapsed' = 0
                  /\ acrossDip' = (acrossDip \/ failedSince) /\ failedSince' = FALSE
Released == IF lease = "self" THEN "free" ELSE lease
\* The record is read once, under the lease, before Development's second sample.
RecordLive == Development /\ Len(samples) < 2
Reused == reusedBoot # "none"
\* The conditions of admission::opening for replacing the wait.
RecordUsable == /\ recBoot # "none"
                /\ (EnforceRecordBoot => recBoot = "this")
                /\ (EnforceRecordMinAge => recAge # "young")
                /\ (EnforceRecordMaxAge => recAge # "old")
                /\ (EnforceRecordChain => recSwap = swapouts)
InitWithAlias(initialAlias) == /\ profile \in {"development", "research"}
        /\ pc = "Idle" /\ lease = "free" /\ elapsed = 0
        /\ hostOk = TRUE /\ swapouts = 0 /\ dips = 0
        /\ failedSince = FALSE /\ acrossDip = FALSE
        /\ samples = <<>> /\ baseline = <<>> /\ bootSample = <<>>
        /\ bootAcrossDip = FALSE
        \* A record left by another OS boot carries that boot's clock: any age
        \* class is possible, so it has the one only the boot check stops.
        /\ recBoot \in (IF Development THEN {"none", "other"} ELSE {"none"})
        /\ recAge = (IF recBoot = "other" THEN "ok" ELSE "young")
        /\ recSwap = 0 /\ recOk = TRUE /\ recDip = FALSE
        /\ reusedBoot = "none" /\ reusedAge = "young" /\ reusedSwap = 0
        /\ reusedDip = FALSE /\ missed = FALSE
        /\ treeOk = TRUE /\ treeProved = FALSE /\ rootOk = TRUE /\ rootProved = FALSE
        /\ alias = initialAlias /\ selected = 0 /\ poolRunning = FALSE /\ vm = FALSE

Init == InitWithAlias("owned")

\* ---- Environment ----
\* A monotonic clock, saturating at the window: only "at least Window" matters,
\* and only while a later sample is still due.
Tick == /\ pc \notin Terminal /\ SampleDue
        /\ elapsed < Window /\ elapsed' = elapsed + 1
        /\ UNCHANGED <<profile, pc, lease, host, samples, kept, proofs, owner,
                        poolRunning, vm>>
\* Memory, pressure, thermal or disk headroom stops qualifying ...
Degrade == /\ pc \notin Terminal /\ hostOk /\ hostOk' = FALSE
           /\ failedSince' = (failedSince \/ ObservationDue)
           /\ recDip' = (recDip \/ (RecordLive /\ recBoot = "this"))
           /\ UNCHANGED <<profile, pc, lease, elapsed, swapouts, dips, acrossDip,
                           samples, boot, recBoot, recAge, recSwap, recOk, reuse,
                           proofs, owner, poolRunning, vm>>
\* ... and qualifies again. Nothing but a sample taken in between sees the dip.
Recover == /\ pc \notin Terminal /\ ~hostOk /\ dips < MaxDips
           /\ hostOk' = TRUE /\ dips' = dips + 1
           /\ UNCHANGED <<profile, pc, lease, elapsed, swapouts, failedSince,
                           acrossDip, samples, kept, proofs, owner, poolRunning,
                           vm>>
Swapout == /\ pc \notin Terminal /\ swapouts < MaxSwapouts
           /\ swapouts' = swapouts + 1
           /\ UNCHANGED <<profile, pc, lease, elapsed, hostOk, dips, failedSince,
                           acrossDip, samples, kept, proofs, owner, poolRunning,
                           vm>>
\* Another lifecycle operation of this home takes or returns the lease.
OtherAcquire == /\ pc \notin Terminal /\ lease = "free" /\ lease' = "other"
                /\ UNCHANGED <<profile, pc, elapsed, host, samples, kept, proofs,
                                owner, poolRunning, vm>>
OtherRelease == /\ pc \notin Terminal /\ lease = "other" /\ lease' = "free"
                /\ UNCHANGED <<profile, pc, elapsed, host, samples, kept, proofs,
                                owner, poolRunning, vm>>
\* A concurrent start wins the lease and boots the pool itself.
OtherStart == /\ pc \notin Terminal /\ lease = "other" /\ ~poolRunning
              /\ alias # "missing"
              /\ poolRunning' = TRUE
              /\ UNCHANGED <<profile, pc, lease, elapsed, host, samples, kept,
                              proofs, owner, vm>>
\* Another operation of this home, holding the lease, records a host sample: a
\* stop, or another start's sample under the lease (admission::opening). Only a
\* sample that passed is recorded. A Research home has no record.
OtherRecords == /\ Development /\ pc \notin Terminal /\ lease = "other"
                /\ (EnforceRecordPassing => hostOk)
                /\ recBoot' = "this" /\ recAge' = "young" /\ recSwap' = swapouts
                /\ recOk' = hostOk /\ recDip' = FALSE
                /\ UNCHANGED <<profile, pc, lease, elapsed, host, samples, boot,
                                reuse, proofs, owner, poolRunning, vm>>
\* Time passes for the record: younger than a window, then usable, then older
\* than the bound. Only the read under the lease looks at its age, so the model
\* lets it age there and nowhere earlier.
AgeRecord == /\ RecordLive /\ pc = "Leased" /\ recBoot = "this" /\ recAge # "old"
             /\ recAge' = (IF recAge = "young" THEN "ok" ELSE "old")
             /\ UNCHANGED <<profile, pc, lease, elapsed, host, samples, boot,
                             recBoot, recSwap, recOk, recDip, reuse, proofs, owner,
                             poolRunning, vm>>
\* A prepared tree or the root files change after a proof could have read them.
\* Assumed absent while this start holds the lease (see COVERAGE.md).
ChangeTree == /\ pc \notin Terminal /\ lease # "self" /\ treeOk /\ treeOk' = FALSE
              /\ UNCHANGED <<profile, pc, lease, elapsed, host, samples, kept,
                              treeProved, rootOk, rootProved, owner, poolRunning, vm>>
ChangeRoot == /\ pc \notin Terminal /\ lease # "self" /\ rootOk /\ rootOk' = FALSE
              /\ UNCHANGED <<profile, pc, lease, elapsed, host, samples, kept,
                              treeOk, treeProved, rootProved, owner, poolRunning, vm>>
\* Another entry takes the path of a clean stop's HOME alias. The lease does
\* not fence it; one squat, before the selection settles.
SquatAlias == /\ pc \in BeforeLease \cup {"Leased", "Qualified"}
              /\ alias = "owned" /\ alias' = "foreign"
              /\ UNCHANGED <<profile, pc, lease, elapsed, host, samples, kept,
                              proofs, selected, poolRunning, vm>>

\* ---- The start ----
Refuse == /\ pc' = "Refused" /\ lease' = Released
          /\ UNCHANGED <<profile, elapsed, host, samples, kept, proofs, owner,
                          poolRunning, vm>>
\* restore_released_short_home_before_use: lease taken, record rewritten, lease
\* returned, all before the first sample.
RestoreAliasBeforeUse == /\ pc = "Idle" /\ alias = "foreign" /\ lease = "free"
                         /\ alias' = "moved"
                         /\ UNCHANGED <<profile, pc, lease, elapsed, host, samples,
                                         kept, proofs, selected, poolRunning, vm>>
\* A squatted alias this start may not move (not a clean stop, or pinned
\* dependency socket paths).
RefuseAlias == pc \in {"Idle", "Qualified"} /\ alias = "foreign" /\ Refuse
\* admission_pool::select and probe, then admission::open: first sample.
Open == /\ pc = "Idle" /\ alias # "foreign" /\ ~poolRunning
        /\ (EnforceFirstCheck => hostOk)
        /\ pc' = "Opened" /\ Accept(FALSE)
        /\ selected' \in (IF Development THEN {0, OwnerVersion} ELSE {0})
        /\ UNCHANGED <<profile, lease, hostOk, swapouts, dips, kept, proofs,
                        alias, poolRunning, vm>>
RefuseFirst == pc = "Idle" /\ alias # "foreign" /\ ~poolRunning /\ ~hostOk /\ Refuse
\* running_start: a pool that already runs is rechecked under the lease and
\* reported. It takes no admission sample.
ResumeRunning == /\ pc = "Idle" /\ alias # "foreign" /\ poolRunning /\ lease = "free"
                 /\ pc' = "Joined"
                 /\ UNCHANGED <<profile, lease, elapsed, host, samples, kept,
                                 proofs, owner, poolRunning, vm>>
\* sample_checked: Research's second and third samples, before the lease.
ResearchSample == /\ pc = "Opened" /\ ~Development /\ Len(samples) < ResearchQuota
                  /\ WindowElapsed /\ (EnforceResearchHost => hostOk)
                  /\ SameSwapouts
                  /\ Accept(FALSE)
                  /\ UNCHANGED <<profile, pc, lease, hostOk, swapouts, dips,
                                  kept, proofs, owner, poolRunning, vm>>
RefuseSample == /\ pc = "Opened" /\ ~Development /\ Len(samples) < ResearchQuota
                /\ WindowElapsed /\ ~(hostOk /\ SameSwapouts) /\ Refuse
PreLeaseSampled == Development \/ Len(samples) = ResearchQuota
\* artifact::verify_witnessed for the provider and engine trees.
ProveTrees == /\ pc = "Opened" /\ PreLeaseSampled /\ treeOk
              /\ pc' = "Proven" /\ treeProved' = TRUE
              /\ UNCHANGED <<profile, lease, elapsed, host, samples, kept, treeOk,
                              rootOk, rootProved, owner, poolRunning, vm>>
RefuseTree == pc = "Opened" /\ PreLeaseSampled /\ ~treeOk /\ Refuse
\* rootfs_proof::prove: a cleanly stopped pool's root files are proven
\* inside the window. A start without that proof is
\* RootProofBeforeLease = FALSE.
ProveRootEarly == /\ RootProofBeforeLease /\ pc = "Proven" /\ ~rootProved /\ rootOk
                  /\ rootProved' = TRUE
                  /\ UNCHANGED <<profile, pc, lease, elapsed, host, samples, kept,
                                  treeOk, treeProved, rootOk, owner, poolRunning, vm>>
\* startup_lease. A lease another operation keeps refuses provider_busy.
AcquireLease == /\ pc = "Proven" /\ lease = "free"
                /\ (RootProofBeforeLease => rootProved)
                /\ pc' = "Leased" /\ lease' = "self"
                /\ UNCHANGED <<profile, elapsed, host, samples, kept, proofs,
                                owner, poolRunning, vm>>
LeaseTimeout == /\ \/ pc = "Idle" /\ alias = "foreign"
                   \/ pc = "Proven"
                /\ lease = "other" /\ Refuse
\* The reserve selection is read strictly around the sample.
SelectionReadable == selected = 0 \/ alias # "foreign"
\* admission::recheck_after_lease: Development's second sample. The remainder
\* of the window is slept (Tick) with the lease held.
Recheck == /\ Development /\ Len(samples) = 1
           /\ pc \in (IF SampleUnderLease THEN {"Leased"} ELSE {"Proven", "Leased"})
           /\ (EnforceWindow => WindowElapsed)
           /\ (EnforceRecheckHost => hostOk) /\ SelectionReadable
           /\ (EnforceChain => SameSwapouts)
           /\ Accept(lease = "self")
           /\ missed' = (recBoot # "none" /\ ~RecordUsable)
           /\ pc' = IF pc = "Leased" THEN "Qualified" ELSE pc
           /\ UNCHANGED <<profile, lease, hostOk, swapouts, dips, boot, rec,
                           reusedBoot, reusedAge, reusedSwap, reusedDip, proofs,
                           owner, poolRunning, vm>>
\* admission::recheck_after_lease with a usable record: a wait is due, and the
\* sample under the lease is taken at once instead. It passes every predicate
\* and shows the first sample's count, as in Recheck, and the record's. A
\* record that is not usable, or a sample that does not fit, is no step here:
\* the start goes on to Tick and Recheck, as it does without a record.
Reuse == /\ Development /\ Len(samples) = 1 /\ pc = "Leased" /\ ~WindowElapsed
         /\ RecordUsable
         /\ hostOk /\ SelectionReadable /\ SameSwapouts
         /\ Accept(TRUE)
         /\ reusedBoot' = recBoot /\ reusedAge' = recAge /\ reusedSwap' = recSwap
         /\ reusedDip' = recDip
         /\ pc' = "Qualified"
         /\ UNCHANGED <<profile, lease, hostOk, swapouts, dips, boot, rec, missed,
                         proofs, owner, poolRunning, vm>>
RefuseRecheck == /\ pc = "Leased" /\ Development /\ Len(samples) = 1
                 /\ WindowElapsed
                 /\ ~(hostOk /\ SelectionReadable /\ SameSwapouts)
                 /\ Refuse
\* Research takes no sample under the lease.
Qualify == /\ pc = "Leased" /\ Len(samples) = Quota /\ pc' = "Qualified"
           /\ UNCHANGED <<profile, lease, elapsed, host, samples, kept, proofs,
                           owner, poolRunning, vm>>
\* restore_released_short_home, under the lease and after the sample.
RestoreAliasLeased == /\ pc = "Qualified" /\ alias \in {"foreign", "missing"}
                      /\ alias' = (IF alias = "missing" THEN "owned" ELSE "moved")
                      /\ UNCHANGED <<profile, pc, lease, elapsed, host, samples,
                                      kept, proofs, selected, poolRunning, vm>>
\* leased_trees::recheck, first under the lease after the sample: each tree is
\* still what its proof saw, or is proven by content again. It is folded into
\* the two steps that leave Qualified without refusing; no tree changes under
\* the lease, so its place among the leased steps does not matter here.
TreesStillProven == EnforceTreeRecheck => treeOk
\* admission::opening::record, after both rechecks: a Development start's
\* sample under the lease becomes the home's record, also when it reused one.
\* Folded into the same two steps; a refusal at Qualified writes nothing here.
RecordOpening ==
    IF Development
    THEN /\ recBoot' = "this" /\ recAge' = "young" /\ recSwap' = Last.swap
         /\ recOk' = Last.ok /\ recDip' = FALSE
    ELSE UNCHANGED rec
\* admission_pool::settle and the owner checks: the selection still names the
\* owner record, and no concurrent start made the pool running.
Settle == /\ pc = "Qualified" /\ alias \in {"owned", "moved"} /\ ~poolRunning
          /\ SameOwner
          /\ TreesStillProven
          /\ pc' = "Settled" /\ RecordOpening
          /\ UNCHANGED <<profile, lease, elapsed, host, samples, boot, reuse,
                          proofs, owner, poolRunning, vm>>
RefuseSelection == /\ pc = "Qualified" /\ alias # "foreign" /\ selected # 0
                   /\ (~SameOwner \/ poolRunning) /\ Refuse
RefuseTreeRecheck == /\ EnforceTreeRecheck /\ pc = "Qualified" /\ ~treeOk /\ Refuse
\* The pool became running after running_start::select: report it, start nothing.
ObserveRunning == /\ pc = "Qualified" /\ alias # "foreign" /\ poolRunning
                  /\ selected = 0 /\ TreesStillProven
                  /\ pc' = "Joined" /\ lease' = "free" /\ RecordOpening
                  /\ UNCHANGED <<profile, elapsed, host, samples, boot, reuse,
                                  proofs, owner, poolRunning, vm>>
\* prepare_rootfs under the lease without an earlier proof, or the comparison
\* of the root files with the metadata the earlier proof recorded. The code
\* compares twice: rootfs_proof::recheck straight after the tree recheck, and
\* Leased::stands in prepare_rootfs, which is this action's place. No root
\* file changes under the lease here, so one comparison or two is one guard.
ProveRoot == /\ ~RootProofBeforeLease /\ pc = "Settled" /\ rootOk
             /\ pc' = "RootProven" /\ rootProved' = TRUE
             /\ UNCHANGED <<profile, lease, elapsed, host, samples, kept, treeOk,
                             treeProved, rootOk, owner, poolRunning, vm>>
RecheckRoot == /\ RootProofBeforeLease /\ pc = "Settled" /\ rootProved
               /\ (EnforceRootRecheck => rootOk)
               /\ pc' = "RootProven"
               /\ UNCHANGED <<profile, lease, elapsed, host, samples, kept, proofs,
                               owner, poolRunning, vm>>
RefuseRoot == \/ /\ RootProofBeforeLease /\ pc = "Proven" /\ ~rootProved /\ ~rootOk
                 /\ Refuse
              \/ /\ pc = "Settled" /\ ~rootOk
                 /\ (RootProofBeforeLease => EnforceRootRecheck) /\ Refuse
\* admission_pool::admit_boot with samples.last().swapouts as its baseline: one
\* more observation, which must be admitted and show that count.
AdmitBoot == /\ pc = "RootProven"
             /\ (EnforceBootHost => hostOk)
             /\ ((ChainToBoot /\ EnforceBootChain) => SameSwapouts)
             /\ pc' = "BootAdmitted"
             /\ baseline' = <<IF ChainToBoot THEN Last.swap ELSE swapouts>>
             /\ bootSample' = <<[swap |-> swapouts, ok |-> hostOk]>>
             /\ bootAcrossDip' = failedSince /\ failedSince' = FALSE
             /\ UNCHANGED <<profile, lease, elapsed, hostOk, swapouts, dips,
                             acrossDip, samples, rec, reuse, proofs, owner,
                             poolRunning, vm>>
RefuseBoot == pc = "RootProven" /\ ~(hostOk /\ SameSwapouts) /\ Refuse
\* BootAdmission::release, begin_boot and `machine start`.
Start == /\ pc = "BootAdmitted" /\ pc' = "Started" /\ vm' = TRUE
         /\ UNCHANGED <<profile, lease, elapsed, host, samples, kept, proofs,
                         owner, poolRunning>>
\* Any other check of the start refuses; the lease is returned on the way out.
RefuseOther == pc \notin Terminal /\ Refuse
\* The process dies; the kernel returns its lock.
Crash == /\ pc \notin Terminal /\ pc' = "Crashed" /\ lease' = Released
         /\ UNCHANGED <<profile, elapsed, host, samples, kept, proofs, owner,
                         poolRunning, vm>>
Next == \/ Tick \/ Degrade \/ Recover \/ Swapout
        \/ OtherAcquire \/ OtherRelease \/ OtherStart
        \/ OtherRecords \/ AgeRecord
        \/ ChangeTree \/ ChangeRoot \/ SquatAlias
        \/ RestoreAliasBeforeUse \/ RefuseAlias \/ Open \/ RefuseFirst
        \/ ResumeRunning
        \/ ResearchSample \/ RefuseSample \/ ProveTrees \/ RefuseTree
        \/ ProveRootEarly \/ AcquireLease \/ LeaseTimeout \/ Recheck \/ Reuse
        \/ RefuseRecheck \/ Qualify \/ RestoreAliasLeased \/ Settle
        \/ RefuseSelection \/ RefuseTreeRecheck \/ ObserveRunning \/ ProveRoot
        \/ RecheckRoot \/ RefuseRoot \/ AdmitBoot \/ RefuseBoot \/ Start
        \/ RefuseOther \/ Crash
Spec == Init /\ [][Next]_vars
ReleasedAliasSpec == InitWithAlias("missing") /\ [][Next]_vars
BootHasAlias == (poolRunning \/ vm) => alias # "missing"

TypeOK == /\ profile \in {"development", "research"}
          /\ pc \in BeforeLease \cup LeasedSteps \cup Terminal
          /\ lease \in {"free", "self", "other"} /\ elapsed \in 0..Window
          /\ hostOk \in BOOLEAN /\ swapouts \in 0..MaxSwapouts
          /\ dips \in 0..MaxDips /\ failedSince \in BOOLEAN
          /\ acrossDip \in BOOLEAN
          /\ Len(samples) \in 0..3
          /\ \A i \in 1..Len(samples) :
               /\ samples[i].swap \in 0..MaxSwapouts /\ samples[i].gap \in 0..Window
               /\ samples[i].leased \in BOOLEAN /\ samples[i].ok \in BOOLEAN
          /\ Len(baseline) \in 0..1 /\ Len(bootSample) \in 0..1
          /\ \A i \in 1..Len(bootSample) :
               /\ bootSample[i].swap \in 0..MaxSwapouts
               /\ bootSample[i].ok \in BOOLEAN
          /\ bootAcrossDip \in BOOLEAN
          /\ treeOk \in BOOLEAN /\ treeProved \in BOOLEAN
          /\ rootOk \in BOOLEAN /\ rootProved \in BOOLEAN
          /\ alias \in {"owned", "foreign", "missing", "moved"} /\ selected \in 0..2
          /\ poolRunning \in BOOLEAN /\ vm \in BOOLEAN
          /\ recBoot \in {"none", "this", "other"}
          /\ recAge \in {"young", "ok", "old"} /\ recSwap \in 0..MaxSwapouts
          /\ recOk \in BOOLEAN /\ recDip \in BOOLEAN
          /\ reusedBoot \in {"none", "this", "other"}
          /\ reusedAge \in {"young", "ok", "old"}
          /\ reusedSwap \in 0..MaxSwapouts /\ reusedDip \in BOOLEAN
          /\ missed \in BOOLEAN
\* A Development VM starts on exactly two qualifying samples ...
DevelopmentTwoSamples == (vm /\ Development) => Len(samples) = 2
\* ... the second taken under the startup lease ...
SecondSampleUnderLease == (Development /\ Len(samples) >= 2) => samples[2].leased
\* ... and every later sample at least the window after the one before it,
\* or, when it replaced the wait with a record, after the recorded sample.
WindowRespected ==
    \A i \in 2..Len(samples) :
        IF Reused /\ i = 2 THEN reusedAge # "young" ELSE samples[i].gap >= Window
\* A start that skipped the wait had a record from this OS boot ...
ReusedRecordSameBoot == reusedBoot # "other"
\* ... at most one bound old (WindowRespected: and at least one window) ...
ReusedRecordWithinBound == Reused => reusedAge # "old"
\* ... whose swapout count is its sample's under the lease.
ReusedRecordSameSwapouts == Reused => reusedSwap = samples[2].swap
\* Every record written while this start ran came from a passing sample.
RecordsFromPassingSamples == recBoot = "this" => recOk
\* Research reads no record and none is written for it.
ResearchNeverReuses == ~Development => (~Reused /\ ~missed /\ recBoot = "none")
\* Every sample a start accepted was taken on a passing host.
SamplesTakenOnPassingHost == \A i \in 1..Len(samples) : samples[i].ok
\* No accepted sample shows a swapout count other than the first one's.
ChainUnbroken == \A i \in 1..Len(samples) : samples[i].swap = samples[1].swap
\* The pre-boot check compares against the last qualifying sample.
BootBaselineIsLastSample == baseline # <<>> => baseline[1] = Last.swap
\* The pre-boot check ran before every start.
BootChecked == vm => (baseline # <<>> /\ bootSample # <<>>)
\* Its observation was taken on a passing host ...
BootSampleOnPassingHost == \A i \in 1..Len(bootSample) : bootSample[i].ok
\* ... and showed the swapout count it was compared against.
BootSampleMatchesBaseline ==
    \A i \in 1..Len(bootSample) : bootSample[i].swap = baseline[1]
\* Research keeps three samples, all before the lease.
ResearchThreeSamples ==
    (vm /\ ~Development) =>
        (Len(samples) = 3 /\ \A i \in 1..Len(samples) : ~samples[i].leased)
\* The provider and engine trees were proven by content in this start.
TreesProvenThisStart == pc \in UnderLease => treeProved
\* The root files a boot uses were proven, and unchanged when last checked
\* under the lease.
StartFromProvenRoot ==
    pc \in {"RootProven", "BootAdmitted", "Started"} => (rootProved /\ rootOk)
\* A reserve selection that continues still names the current owner record.
SelectionBound ==
    pc \in {"Settled", "RootProven", "BootAdmitted", "Started"} => SameOwner
\* No boot uses a tree that changed after its content proof.
NoStartFromChangedTree == vm => treeOk
NoSecondVm == ~(vm /\ poolRunning)
\* Every way out without a start leaves no VM and returns the lease.
RefusalIsClean == pc \in {"Refused", "Crashed", "Joined"} => (~vm /\ lease # "self")
LeaseHeldForEffects == pc \in UnderLease => lease = "self"
VmOnlyWhenStarted == vm <=> pc = "Started"

\* Not invariants of the implementation: each control below must be violated.
NeverStartsDevelopment == ~(vm /\ Development)
NeverStartsResearch == ~(vm /\ ~Development)
NeverStartsOnMovedAlias == ~(vm /\ alias = "moved" /\ selected = 2)
\* The weakening of admitting on few samples, as a checked fact: a VM starts
\* although the host failed at some moment between two of its accepted samples.
NeverStartsDevelopmentAcrossADip == ~(vm /\ Development /\ acrossDip)
NeverStartsResearchAcrossADip == ~(vm /\ ~Development /\ acrossDip)
\* The same between the last sample and the pre-boot observation.
NeverStartsAcrossADipBeforeBoot == ~(vm /\ bootAcrossDip)
\* A start that replaced its wait with a record is reachable ...
NeverStartsOnReuse == ~(vm /\ Reused)
\* ... and so is one that found an unusable record and waited as before ...
NeverStartsPastAnUnusableRecord == ~(vm /\ missed /\ ~Reused)
\* ... and the weakening of reuse: the host failed at some moment between the
\* recorded sample and the sample under the lease.
NeverStartsOnReuseAcrossADip == ~(vm /\ reusedDip)
=============================================================================
