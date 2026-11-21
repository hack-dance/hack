----------------------------- MODULE PoolStart -----------------------------
\* One `runtime up` of a pool that is not running: host admission samples, the
\* content proofs, the startup lease and the first `machine start`.
\* Source: packages/runtime-core/src/provider/lifecycle.rs (start_pool_observed,
\* startup_admission_lease), provider/admission.rs (open, recheck_after_lease,
\* check, sample_checked), lifecycle/leased_trees.rs (recheck),
\* lifecycle/rootfs_proof.rs (prove, recheck) and
\* lifecycle/admission_pool.rs (settle, admit_boot).
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
          EnforceBootChain      \* ... and show the count it is compared against
VARIABLES profile, pc, lease, elapsed, hostOk, swapouts, dips, failedSince,
          acrossDip, samples, baseline, bootSample, bootAcrossDip, treeOk,
          treeProved, rootOk, rootProved, alias, selected, poolRunning, vm
\* What the host is now, and what the observations did not see of it:
\* failedSince, the host failed at some moment since the last accepted
\* observation; acrossDip, some accepted sample came after such a moment.
host == <<hostOk, swapouts, dips, failedSince, acrossDip>>
\* The pre-boot check: the count it compared against, what it observed, and
\* whether the host had failed between the last sample and that observation.
boot == <<baseline, bootSample, bootAcrossDip>>
proofs == <<treeOk, treeProved, rootOk, rootProved>>
owner == <<alias, selected>>
vars == <<profile, pc, lease, elapsed, host, samples, boot, proofs, owner,
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
Init == /\ profile \in {"development", "research"}
        /\ pc = "Idle" /\ lease = "free" /\ elapsed = 0
        /\ hostOk = TRUE /\ swapouts = 0 /\ dips = 0
        /\ failedSince = FALSE /\ acrossDip = FALSE
        /\ samples = <<>> /\ baseline = <<>> /\ bootSample = <<>>
        /\ bootAcrossDip = FALSE
        /\ treeOk = TRUE /\ treeProved = FALSE /\ rootOk = TRUE /\ rootProved = FALSE
        /\ alias = "owned" /\ selected = 0 /\ poolRunning = FALSE /\ vm = FALSE

\* ---- Environment ----
\* A monotonic clock, saturating at the window: only "at least Window" matters,
\* and only while a later sample is still due.
Tick == /\ pc \notin Terminal /\ SampleDue
        /\ elapsed < Window /\ elapsed' = elapsed + 1
        /\ UNCHANGED <<profile, pc, lease, host, samples, boot, proofs, owner,
                        poolRunning, vm>>
\* Memory, pressure, thermal or disk headroom stops qualifying ...
Degrade == /\ pc \notin Terminal /\ hostOk /\ hostOk' = FALSE
           /\ failedSince' = (failedSince \/ ObservationDue)
           /\ UNCHANGED <<profile, pc, lease, elapsed, swapouts, dips, acrossDip,
                           samples, boot, proofs, owner, poolRunning, vm>>
\* ... and qualifies again. Nothing but a sample taken in between sees the dip.
Recover == /\ pc \notin Terminal /\ ~hostOk /\ dips < MaxDips
           /\ hostOk' = TRUE /\ dips' = dips + 1
           /\ UNCHANGED <<profile, pc, lease, elapsed, swapouts, failedSince,
                           acrossDip, samples, boot, proofs, owner, poolRunning,
                           vm>>
Swapout == /\ pc \notin Terminal /\ swapouts < MaxSwapouts
           /\ swapouts' = swapouts + 1
           /\ UNCHANGED <<profile, pc, lease, elapsed, hostOk, dips, failedSince,
                           acrossDip, samples, boot, proofs, owner, poolRunning,
                           vm>>
\* Another lifecycle operation of this home takes or returns the lease.
OtherAcquire == /\ pc \notin Terminal /\ lease = "free" /\ lease' = "other"
                /\ UNCHANGED <<profile, pc, elapsed, host, samples, boot, proofs,
                                owner, poolRunning, vm>>
OtherRelease == /\ pc \notin Terminal /\ lease = "other" /\ lease' = "free"
                /\ UNCHANGED <<profile, pc, elapsed, host, samples, boot, proofs,
                                owner, poolRunning, vm>>
\* A concurrent start wins the lease and boots the pool itself.
OtherStart == /\ pc \notin Terminal /\ lease = "other" /\ ~poolRunning
              /\ poolRunning' = TRUE
              /\ UNCHANGED <<profile, pc, lease, elapsed, host, samples, boot,
                              proofs, owner, vm>>
\* A prepared tree or the root files change after a proof could have read them.
\* Assumed absent while this start holds the lease (see COVERAGE.md).
ChangeTree == /\ pc \notin Terminal /\ lease # "self" /\ treeOk /\ treeOk' = FALSE
              /\ UNCHANGED <<profile, pc, lease, elapsed, host, samples, boot,
                              treeProved, rootOk, rootProved, owner, poolRunning, vm>>
ChangeRoot == /\ pc \notin Terminal /\ lease # "self" /\ rootOk /\ rootOk' = FALSE
              /\ UNCHANGED <<profile, pc, lease, elapsed, host, samples, boot,
                              treeOk, treeProved, rootProved, owner, poolRunning, vm>>
\* Another entry takes the path of a clean stop's HOME alias. The lease does
\* not fence it; one squat, before the selection settles.
SquatAlias == /\ pc \in BeforeLease \cup {"Leased", "Qualified"}
              /\ alias = "owned" /\ alias' = "foreign"
              /\ UNCHANGED <<profile, pc, lease, elapsed, host, samples, boot,
                              proofs, selected, poolRunning, vm>>

\* ---- The start ----
Refuse == /\ pc' = "Refused" /\ lease' = Released
          /\ UNCHANGED <<profile, elapsed, host, samples, boot, proofs, owner,
                          poolRunning, vm>>
\* restore_released_short_home_before_use: lease taken, record rewritten, lease
\* returned, all before the first sample.
RestoreAliasBeforeUse == /\ pc = "Idle" /\ alias = "foreign" /\ lease = "free"
                         /\ alias' = "moved"
                         /\ UNCHANGED <<profile, pc, lease, elapsed, host, samples,
                                         boot, proofs, selected, poolRunning, vm>>
\* A squatted alias this start may not move (not a clean stop, or pinned
\* dependency socket paths).
RefuseAlias == pc \in {"Idle", "Qualified"} /\ alias = "foreign" /\ Refuse
\* admission_pool::select and probe, then admission::open: first sample.
Open == /\ pc = "Idle" /\ alias # "foreign" /\ ~poolRunning
        /\ (EnforceFirstCheck => hostOk)
        /\ pc' = "Opened" /\ Accept(FALSE)
        /\ selected' \in (IF Development THEN {0, OwnerVersion} ELSE {0})
        /\ UNCHANGED <<profile, lease, hostOk, swapouts, dips, boot, proofs,
                        alias, poolRunning, vm>>
RefuseFirst == pc = "Idle" /\ alias # "foreign" /\ ~poolRunning /\ ~hostOk /\ Refuse
\* running_start: a pool that already runs is rechecked under the lease and
\* reported. It takes no admission sample.
ResumeRunning == /\ pc = "Idle" /\ alias # "foreign" /\ poolRunning /\ lease = "free"
                 /\ pc' = "Joined"
                 /\ UNCHANGED <<profile, lease, elapsed, host, samples, boot,
                                 proofs, owner, poolRunning, vm>>
\* sample_checked: Research's second and third samples, before the lease.
ResearchSample == /\ pc = "Opened" /\ ~Development /\ Len(samples) < ResearchQuota
                  /\ WindowElapsed /\ (EnforceResearchHost => hostOk)
                  /\ SameSwapouts
                  /\ Accept(FALSE)
                  /\ UNCHANGED <<profile, pc, lease, hostOk, swapouts, dips,
                                  boot, proofs, owner, poolRunning, vm>>
RefuseSample == /\ pc = "Opened" /\ ~Development /\ Len(samples) < ResearchQuota
                /\ WindowElapsed /\ ~(hostOk /\ SameSwapouts) /\ Refuse
PreLeaseSampled == Development \/ Len(samples) = ResearchQuota
\* artifact::verify_witnessed for the provider and engine trees.
ProveTrees == /\ pc = "Opened" /\ PreLeaseSampled /\ treeOk
              /\ pc' = "Proven" /\ treeProved' = TRUE
              /\ UNCHANGED <<profile, lease, elapsed, host, samples, boot, treeOk,
                              rootOk, rootProved, owner, poolRunning, vm>>
RefuseTree == pc = "Opened" /\ PreLeaseSampled /\ ~treeOk /\ Refuse
\* rootfs_proof::prove: a cleanly stopped pool's root files are proven
\* inside the window. A start without that proof is
\* RootProofBeforeLease = FALSE.
ProveRootEarly == /\ RootProofBeforeLease /\ pc = "Proven" /\ ~rootProved /\ rootOk
                  /\ rootProved' = TRUE
                  /\ UNCHANGED <<profile, pc, lease, elapsed, host, samples, boot,
                                  treeOk, treeProved, rootOk, owner, poolRunning, vm>>
\* startup_lease. A lease another operation keeps refuses provider_busy.
AcquireLease == /\ pc = "Proven" /\ lease = "free"
                /\ (RootProofBeforeLease => rootProved)
                /\ pc' = "Leased" /\ lease' = "self"
                /\ UNCHANGED <<profile, elapsed, host, samples, boot, proofs,
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
           /\ pc' = IF pc = "Leased" THEN "Qualified" ELSE pc
           /\ UNCHANGED <<profile, lease, hostOk, swapouts, dips, boot, proofs,
                           owner, poolRunning, vm>>
RefuseRecheck == /\ pc = "Leased" /\ Development /\ Len(samples) = 1
                 /\ WindowElapsed
                 /\ ~(hostOk /\ SelectionReadable /\ SameSwapouts)
                 /\ Refuse
\* Research takes no sample under the lease.
Qualify == /\ pc = "Leased" /\ Len(samples) = Quota /\ pc' = "Qualified"
           /\ UNCHANGED <<profile, lease, elapsed, host, samples, boot, proofs,
                           owner, poolRunning, vm>>
\* restore_released_short_home, under the lease and after the sample.
RestoreAliasLeased == /\ pc = "Qualified" /\ alias = "foreign" /\ alias' = "moved"
                      /\ UNCHANGED <<profile, pc, lease, elapsed, host, samples,
                                      boot, proofs, selected, poolRunning, vm>>
\* leased_trees::recheck, first under the lease after the sample: each tree is
\* still what its proof saw, or is proven by content again. It is folded into
\* the two steps that leave Qualified without refusing; no tree changes under
\* the lease, so its place among the leased steps does not matter here.
TreesStillProven == EnforceTreeRecheck => treeOk
\* admission_pool::settle and the owner checks: the selection still names the
\* owner record, and no concurrent start made the pool running.
Settle == /\ pc = "Qualified" /\ alias # "foreign" /\ ~poolRunning
          /\ SameOwner
          /\ TreesStillProven
          /\ pc' = "Settled"
          /\ UNCHANGED <<profile, lease, elapsed, host, samples, boot, proofs,
                          owner, poolRunning, vm>>
RefuseSelection == /\ pc = "Qualified" /\ alias # "foreign" /\ selected # 0
                   /\ (~SameOwner \/ poolRunning) /\ Refuse
RefuseTreeRecheck == /\ EnforceTreeRecheck /\ pc = "Qualified" /\ ~treeOk /\ Refuse
\* The pool became running after running_start::select: report it, start nothing.
ObserveRunning == /\ pc = "Qualified" /\ alias # "foreign" /\ poolRunning
                  /\ selected = 0 /\ TreesStillProven
                  /\ pc' = "Joined" /\ lease' = "free"
                  /\ UNCHANGED <<profile, elapsed, host, samples, boot, proofs,
                                  owner, poolRunning, vm>>
\* prepare_rootfs under the lease without an earlier proof, or the comparison
\* of the root files with the metadata the earlier proof recorded. The code
\* compares twice: rootfs_proof::recheck straight after the tree recheck, and
\* Leased::stands in prepare_rootfs, which is this action's place. No root
\* file changes under the lease here, so one comparison or two is one guard.
ProveRoot == /\ ~RootProofBeforeLease /\ pc = "Settled" /\ rootOk
             /\ pc' = "RootProven" /\ rootProved' = TRUE
             /\ UNCHANGED <<profile, lease, elapsed, host, samples, boot, treeOk,
                             treeProved, rootOk, owner, poolRunning, vm>>
RecheckRoot == /\ RootProofBeforeLease /\ pc = "Settled" /\ rootProved
               /\ (EnforceRootRecheck => rootOk)
               /\ pc' = "RootProven"
               /\ UNCHANGED <<profile, lease, elapsed, host, samples, boot, proofs,
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
                             acrossDip, samples, proofs, owner, poolRunning, vm>>
RefuseBoot == pc = "RootProven" /\ ~(hostOk /\ SameSwapouts) /\ Refuse
\* BootAdmission::release, begin_boot and `machine start`.
Start == /\ pc = "BootAdmitted" /\ pc' = "Started" /\ vm' = TRUE
         /\ UNCHANGED <<profile, lease, elapsed, host, samples, boot, proofs,
                         owner, poolRunning>>
\* Any other check of the start refuses; the lease is returned on the way out.
RefuseOther == pc \notin Terminal /\ Refuse
\* The process dies; the kernel returns its lock.
Crash == /\ pc \notin Terminal /\ pc' = "Crashed" /\ lease' = Released
         /\ UNCHANGED <<profile, elapsed, host, samples, boot, proofs, owner,
                         poolRunning, vm>>
Next == \/ Tick \/ Degrade \/ Recover \/ Swapout
        \/ OtherAcquire \/ OtherRelease \/ OtherStart
        \/ ChangeTree \/ ChangeRoot \/ SquatAlias
        \/ RestoreAliasBeforeUse \/ RefuseAlias \/ Open \/ RefuseFirst
        \/ ResumeRunning
        \/ ResearchSample \/ RefuseSample \/ ProveTrees \/ RefuseTree
        \/ ProveRootEarly \/ AcquireLease \/ LeaseTimeout \/ Recheck
        \/ RefuseRecheck \/ Qualify \/ RestoreAliasLeased \/ Settle
        \/ RefuseSelection \/ RefuseTreeRecheck \/ ObserveRunning \/ ProveRoot
        \/ RecheckRoot \/ RefuseRoot \/ AdmitBoot \/ RefuseBoot \/ Start
        \/ RefuseOther \/ Crash
Spec == Init /\ [][Next]_vars

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
          /\ alias \in {"owned", "foreign", "moved"} /\ selected \in 0..2
          /\ poolRunning \in BOOLEAN /\ vm \in BOOLEAN
\* A Development VM starts on exactly two qualifying samples ...
DevelopmentTwoSamples == (vm /\ Development) => Len(samples) = 2
\* ... the second taken under the startup lease ...
SecondSampleUnderLease == (Development /\ Len(samples) >= 2) => samples[2].leased
\* ... and every later sample at least the window after the one before it.
WindowRespected == \A i \in 2..Len(samples) : samples[i].gap >= Window
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
=============================================================================
