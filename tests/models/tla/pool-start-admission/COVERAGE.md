# Pool start admission

Question: when a Development pool start admits on two host samples instead of two
three-sample windows, can a VM start without a second qualifying sample taken under
the startup lease, at least the window after the first, with one unbroken swapout
count from the first sample to the pre-boot check? And what does a start on two
samples no longer see? And when a start skips the wait between its two samples
because an earlier passing sample is on record, what did that record have to be?

![PoolStart: pool start admission](../../../../docs/diagrams/pool-start-admission.svg)

[Diagram source](../../../../docs/diagrams/pool-start-admission.mmd); states,
transitions and exits are listed in
[the statechart page](../../../../docs/pool-start-admission-statechart.md). The
diagram is a review aid, not an additional checked model.

`PoolStart.tla` enumerates one `runtime up` of a pool that is not running, for both
profiles, against a host that changes underneath it. The starting process samples
the host, proves the provider and engine trees and, for a pool that already has
root files, those too, takes the startup lease, samples again (Development only;
after the rest of the window, or at once when this home's record of an earlier
passing sample is usable), rechecks the trees and the root files against their
proofs, records its sample under the lease, settles its reserve
selection, proves the root files if no earlier proof exists, runs the pre-boot
check and starts the VM. The environment advances a monotonic clock, fails the
host's predicates and lets them pass again once, grows the swapout count, takes
and returns the lease, boots the pool from a concurrent start, changes a tree or
the root files while the lease is not held, squats the clean-stop HOME alias,
and, through another operation that holds the lease, records a host sample. The
process can refuse or crash at every step.

`stopped-pool-startup/Resume.tla` covers the same start's retained selection and
receipt evidence, with no host admission, clock or content proof. The two questions
share no variable, so this is a sibling model and `Resume.tla` is unchanged.

## Configurations

Two configurations describe the implementation. They differ in where the root
files are proven, and one start follows exactly one of them. In both,
Development's second sample is taken under the lease and the trees proven before
the lease are rechecked under it (`EnforceTreeRecheck = TRUE`). Both check the
same invariants.

- `root-before-lease` is a start that has an early proof of the root files
  (`lifecycle/rootfs_proof.rs::prove`): the owner record is a clean stop (the
  `stopped` phase with the marker a completed `down` writes) and names a root
  files pin, the root files are on a filesystem qualified for the metadata
  check, and they matched the pin before the lease. That is every start
  of a cleanly stopped pool whose root files are intact. The proof runs in the
  window before the lease and is rechecked under it
  (`RootProofBeforeLease = TRUE`, `EnforceRootRecheck = TRUE`).
- `positive` is a start without one: the root files are proven by content under
  the lease, where no step trusts an earlier proof (`RootProofBeforeLease = FALSE`).
  That is the first boot of a new home, whose root files are copied under the
  lease, and any start whose early proof gave nothing: an owner record that is
  not a clean stop (stopped by a failure, recovered, interrupted) or has no pin,
  root files off a qualified filesystem (no early proof is taken there, so they
  are hashed once, as before), an alias, an unreadable entry, root files that did
  not match their pin before the lease, a proof thread the host could not start,
  or one that died.

| Configuration | Kind | Distinct states | Result |
| --- | --- | ---: | --- |
| `positive` | the implementation, no early root files proof | 220,686 | no error |
| `root-before-lease` | the implementation, root files proven before the lease | 277,194 | no error |

Earlier revisions of this model: `positive` had no tree recheck (21,400 states)
and the recheck was a hypothetical third configuration, `tree-recheck`, until it
became code (`lifecycle/leased_trees.rs`). Then the host could only fail, never
pass again, and a sample did not record the host it was taken on (21,028 and
27,004 states). Every behaviour of that revision is a behaviour of this one, in
which the host never recovers. Then the pre-boot check recorded only the count
it compared against, not what it observed (56,252 and 71,588 states). Then no
record of an earlier sample existed and every Development start waited out its
window (58,022 and 73,754 states); every behaviour of that revision is a
behaviour of this one in which no record is ever written.

## Invariants

Every invariant holds in `positive` and `root-before-lease`.

| Invariant | In plain words |
| --- | --- |
| `DevelopmentTwoSamples`, `SecondSampleUnderLease`, `WindowRespected` | A Development VM starts only on two qualifying samples of its own, the second taken under the startup lease and at least the window after the first, or, when a record replaced the wait, at least the window after the recorded sample. |
| `ReusedRecordSameBoot`, `ReusedRecordWithinBound`, `ReusedRecordSameSwapouts` | With `WindowRespected`: a Development start that skipped the wait had a record from this OS boot, at least one window and at most one bound old, whose swapout count equals its sample's under the lease. |
| `RecordsFromPassingSamples` | Every record written while the start ran came from a sample taken on a passing host. A reader cannot check that, so the writers must. |
| `ResearchNeverReuses` | A Research start reuses nothing, and no record is written for a Research home. Only `Reuse` marks a reuse and only the writers write a record, and all three require Development, so this has no control: it guards against a later edit that drops one of those conditions. |
| `SamplesTakenOnPassingHost` | Every sample a start accepted was taken on a passing host: the first sample of either profile, Research's second and third, and Development's sample under the lease. Each recorded sample carries whether the host passed every predicate at the moment it was taken. Three controls remove the check at one of those samples each. |
| `ChainUnbroken` | No accepted sample shows a swapout count other than the first sample's. A sample that fails a predicate or shows another count is never appended: the only step from it is a refusal. |
| `BootChecked` | A pre-boot check ran before every start: its baseline and its observation exist. It says nothing about what the observation showed. |
| `BootBaselineIsLastSample` | The swapout count the pre-boot check was handed as its baseline is the last qualifying sample's. |
| `BootSampleOnPassingHost` | The pre-boot observation was taken on a passing host. The observation is recorded apart from the qualifying samples, with the host as it was at that moment. |
| `BootSampleMatchesBaseline` | The pre-boot observation showed the swapout count it was compared against. With `BootBaselineIsLastSample`, that is the last qualifying sample's count. |
| `ResearchThreeSamples` | A Research VM starts only on three samples, each at least the window after the one before, and none under the lease. |
| `TreesProvenThisStart` | The provider and engine trees were proven by content in this start before the lease was taken. |
| `NoStartFromChangedTree` | No VM starts from a tree that changed after that proof: the recheck under the lease refuses it. |
| `StartFromProvenRoot` | The root files a boot uses were proven and were unchanged when last checked under the lease. |
| `SelectionBound` | A reserve selection that continues past the settle step still names the current owner record. |
| `NoSecondVm` | This start never boots a pool that a concurrent start already booted. |
| `RefusalIsClean`, `LeaseHeldForEffects`, `VmOnlyWhenStarted` | A refusal, a crash or a join leaves no VM started and the lease returned; every step after the lease holds it. |

## Controls that must fail

Each control keeps every invariant and changes one constant. The registry requires
TLC exit 12, the named invariant and the final-state fields. A
control stops at its first violation, so it has no state count of its own.

| Control | Change | Violated invariant | At |
| --- | --- | --- | --- |
| `negative` | the second sample may be taken before the lease | `SecondSampleUnderLease` | `Recheck`, `pc = "Proven"` |
| `window-not-enforced` | the second sample ignores the clock | `WindowRespected` | `Recheck` |
| `unchained-recheck` | the second sample is not compared with the first one's swapouts | `ChainUnbroken` | `Recheck`, `swapouts = 1` |
| `unchained-boot` | the pre-boot check uses its own swapout count | `BootBaselineIsLastSample` | `AdmitBoot`, `baseline = <<1>>` |
| `research-two-samples` | Research takes two samples | `ResearchThreeSamples` | `Start` |
| `root-unchecked` | `root-before-lease` without the root files recheck under the lease | `StartFromProvenRoot` | `RecheckRoot`, `rootOk = FALSE` |
| `changed-tree-start` | the trees are not rechecked under the lease | `NoStartFromChangedTree` | `Start`, `treeOk = FALSE` |
| `first-sample-unchecked` | the first sample is recorded without its predicate check | `SamplesTakenOnPassingHost` | `Open`, `hostOk = FALSE` |
| `second-sample-unchecked` | Development's sample under the lease is recorded without its predicate check | `SamplesTakenOnPassingHost` | `Recheck`, `profile = "development"`, `hostOk = FALSE` |
| `research-sample-unchecked` | Research's second and third samples are recorded without their predicate check | `SamplesTakenOnPassingHost` | `ResearchSample`, `profile = "research"`, `hostOk = FALSE` |
| `boot-host-unchecked` | the pre-boot check admits without its predicate check | `BootSampleOnPassingHost` | `AdmitBoot`, `hostOk = FALSE` |
| `boot-swapouts-unchecked` | the pre-boot check admits without comparing its swapout count with the baseline | `BootSampleMatchesBaseline` | `AdmitBoot`, `swapouts = 1`, `baseline = <<0>>` |
| `reuse-other-boot` | a record from another OS boot may replace the wait | `ReusedRecordSameBoot` | `Reuse`, `reusedBoot = "other"` |
| `reuse-too-young` | a record younger than the window may replace the wait | `WindowRespected` | `Reuse`, `reusedAge = "young"` |
| `reuse-too-old` | a record older than the bound may replace the wait | `ReusedRecordWithinBound` | `Reuse`, `reusedAge = "old"` |
| `reuse-changed-count` | the sample under the lease is not compared with the record's swapout count | `ReusedRecordSameSwapouts` | `Reuse`, `reusedSwap = 0`, `swapouts = 1` |
| `record-unchecked` | a sample is recorded without its predicate check | `RecordsFromPassingSamples` | `OtherRecords`, `hostOk = FALSE` |

`changed-tree-start` is the implementation as it was before the recheck; see "What
a proof before the lease relies on". `first-sample-unchecked` removes the check
that `admission::open` makes. Before the two-sample change the first probe was
read only for its `admitted` field, and the samples after it carried the
predicates; now the first probe is itself a qualifying sample.

`second-sample-unchecked` and `research-sample-unchecked` remove the same check
at the later samples, one profile each (`EnforceRecheckHost`,
`EnforceResearchHost`), so each fails at the action it names. In both the first
sample is taken on a passing host, the window elapses and the host fails
(`Degrade`). Development then proves its trees, takes the lease and records its
second sample on the failing host at `Recheck`; Research records its second
sample on it at `ResearchSample`. In the code these are the calls of `check` in
`recheck_after_lease` and in `sample_checked`'s loop. The first is covered by
`post_lease_sample_blocks_allocation_when_prelease_admission_goes_stale`. The
loop runs one `check` for every sample;
`startup_windows_keep_profile_floors_and_distinguish_warning_from_normal` fails
a predicate at its first sample for both profiles, and
`swapouts_must_be_observed_and_unchanged_across_the_full_window` fails its
second sample on the swapout count. No test fails another predicate at a later
Research sample.

`boot-host-unchecked` and `boot-swapouts-unchecked` remove one of the two checks
`admission_pool::admit_boot` makes on its observation. In the first, the host
fails after the last sample and the boot is admitted on it: `Open`, the window,
`ProveTrees`, `AcquireLease`, `Recheck`, then `Degrade`, `Settle`, `ProveRoot`
and `AdmitBoot` with `hostOk = FALSE`. The second has `Swapout` in the place of
`Degrade`, and `AdmitBoot` observes one swapout against a baseline of none.
`unchained-boot` is a different fault: there the check is handed its own count as
the baseline, so the observation matches the baseline and the baseline is wrong.

Nine reachability controls state that something never happens and must be
violated at `Start`. Three show that the invariants are not vacuous:
`development-start-reachable`, `research-start-reachable` and
`moved-alias-start-reachable` (a start whose alias moved before its first sample,
on a reserve selection bound to the rewritten owner record). Three show what the
observations do not see; the next section describes them. Three belong to the
record of an earlier sample and are described in "The record that replaces the
wait".

## What the samples do not see

A sample is one moment, and between two accepted samples nothing reads the
host. Only the swapout count carries over, because it is cumulative: the next
sample sees a swapout that happened in between. So a start is admitted although
the host failed a predicate at some moment between two of its samples, when the
host passes again by the time of the next one. Both profiles have this gap in
the code: `recheck_after_lease` sleeps the rest of the window and then observes
once, and `sample_checked` observes three times with a pause between, and
neither reads the host while it waits. The model checks it as a reachable fact:

| Control | States that this never happens | Violated at |
| --- | --- | --- |
| `development-dip-start-reachable` | a Development VM starts although the host failed between its two samples (`NeverStartsDevelopmentAcrossADip`) | `Start`, `acrossDip = TRUE`, `dips = 1` |
| `research-dip-start-reachable` | a Research VM starts although the host failed between two of its three samples (`NeverStartsResearchAcrossADip`) | `Start`, `acrossDip = TRUE`, `dips = 1` |
| `boot-dip-start-reachable` | a VM starts although the host failed between its last sample and the pre-boot observation (`NeverStartsAcrossADipBeforeBoot`) | `Start`, `bootAcrossDip = TRUE`, `dips = 1` |

One Development trace that TLC reports:

1. `Open`: the first sample, on a passing host. The window clock starts.
2. `Tick`, `Tick`: the window elapses.
3. `Degrade`: the host stops qualifying (`failedSince = TRUE`).
4. `Recover`: it qualifies again (`dips = 1`).
5. `ProveTrees`, then `AcquireLease`.
6. `Recheck`: the second sample, under the lease, on a passing host that shows
   the first sample's swapout count. It is accepted, and `acrossDip` becomes
   true.
7. `Settle`, `ProveRoot`, `AdmitBoot` and `Start`: `vm = TRUE`.

The Research trace has the same `Degrade` and `Recover` between its first and
second samples, then the third sample, `Qualify` and the same last four steps.
With two workers TLC does not always report the same interleaving; the dip can
sit anywhere after one accepted sample and before the next.

`failedSince` is set when the host fails while a later observation is still
due, and cleared by the next accepted one. An accepted sample copies it into
`acrossDip`. A sample is accepted only on a passing host, so `acrossDip` means a
failure that began after one accepted sample and ended before the next.

The pre-boot observation leaves the same gap after the last sample, and it is
not part of the two-sample change: nothing in `start_pool_observed` reads the host
between its last sample and `admit_boot`. `AdmitBoot` copies `failedSince` into
`bootAcrossDip`. The trace of `boot-dip-start-reachable` is a start whose two
samples are taken with no dip, then `Degrade` and `Recover` under the lease,
then `Settle`, `ProveRoot`, `AdmitBoot` on a passing host and `Start`.

This is the weakening of the two-sample change, and its size is not something
the model measures. The earlier code took seven samples around four fixed
one-second pauses; a dip had to miss all of them. Now it has to miss two, at
least one second apart. Research is unchanged by that change and has the same
gap between its three samples, fifteen seconds wide; the model has one `Window`
for both and does not compare them.

What still holds across a dip, in `positive` and `root-before-lease`:

- `ChainUnbroken`: a swapout during the dip refuses the next sample
  (`RefuseRecheck`, `RefuseSample`).
- `BootSampleMatchesBaseline` with `BootBaselineIsLastSample`: the same at the
  pre-boot check, whose observation shows the last sample's count.
- `SamplesTakenOnPassingHost`: the host passed every predicate at each sample.
- `BootSampleOnPassingHost`: and at the pre-boot observation after the last
  sample. `BootChecked` adds only that this observation exists before a start.

Two starts that pass together on a host with room for one are outside this
model: it has one start, and each home samples the host by itself. More samples
would not close that either; a host-wide admission reservation would.

### Existing controls after this change

No existing control changed its expected invariant, action or witness fields.
Each removes one guard (`SampleUnderLease`, `EnforceWindow`, `EnforceChain`,
`ChainToBoot`, `ResearchQuota`, `EnforceRootRecheck`, `EnforceTreeRecheck`) and
none of those guards reads whether the host passes. The refusals on a failing
host (`RefuseFirst`, `RefuseSample`, `RefuseRecheck`, `RefuseBoot`) are enabled
exactly as before: `Recover` adds the behaviours in which the host passes again
before the check and removes none, so every earlier counterexample is still a
behaviour. Each control now searches a larger state space for the same first
violation, and the two passing configurations grew.

Recording the pre-boot observation changed no existing control either. It adds
two history variables and two guards that are on in every earlier configuration.
The switches for the host check at the later samples are on everywhere but in
their own two controls, and add no state: the passing counts did not move.
`unchained-boot` still fails `BootBaselineIsLastSample` and nothing else: its
observation matches the baseline it was handed, which is its own count.

## The record that replaces the wait

A home keeps a record of one earlier host sample that passed every Development
predicate on its own (`admission/opening.rs`): the OS boot session, a time on a
clock that counts through sleep, and the swapout count. Under the startup lease,
when part of the window is still to be slept, a Development start reads it. If
the record is usable, the start takes its sample under the lease at once
(`Reuse`) instead of after the wait (`Tick`, then `Recheck`).

In the model the record is `recBoot` (`none`, `this` or `other`), `recAge`
(`young`: under one window; `ok`; `old`: over the bound), `recSwap`, `recOk` and
`recDip`. Its writers are `OtherRecords`, another operation of this home that
holds the lease (a stop, or another start), and the start itself, after its
rechecks (`RecordOpening`, folded into `Settle` and `ObserveRunning`). `AgeRecord`
moves a record from `young` to `ok` to `old`. `Reuse` copies the record it used
into `reusedBoot`, `reusedAge`, `reusedSwap` and `reusedDip`, because the start
overwrites the record afterwards.

The property, in one sentence: a Development start that skipped the wait had a
record from this OS boot, at least one window and at most one bound old, whose
swapout count equals its sample's under the lease. It is four invariants, so
that each control names the condition it removes: `WindowRespected` (at least
one window: the window is now measured from the start's own first sample or
from the recorded one), `ReusedRecordSameBoot`, `ReusedRecordWithinBound` and
`ReusedRecordSameSwapouts`. Every other invariant holds unchanged. In
particular a reused start still has two samples of its own, the second under
the lease, each taken on a passing host and both with the first one's swapout
count (`DevelopmentTwoSamples`, `SecondSampleUnderLease`,
`SamplesTakenOnPassingHost`, `ChainUnbroken`): `Reuse` keeps every guard of
`Recheck` except the elapsed window.

The four `reuse-*` controls each turn one condition off and must fail at
`Reuse`. In `reuse-other-boot` the record was left by another boot. In
`reuse-too-young` and `reuse-too-old` another operation records a sample while
this start is before its lease, and the record is read before it is a window
old, or after it has aged past the bound. In `reuse-changed-count` the record
is written at no swapouts, the host swaps out once before the start's first
sample, and both of the start's samples show one swapout: they agree with each
other and not with the record. `record-unchecked` removes the writers' check:
another operation records a sample on a failing host.

A miss is not a step of its own. A record that is not usable leaves `Reuse`
disabled, and the only way on is the one a start without a record takes: `Tick`
to the end of the window, then `Recheck`, chained to the start's own first
sample. No refusing action reads the record, so no refusal depends on it.
`Recheck` notes in `missed` that a record was present and not usable.

| Control | States that this never happens | Violated at |
| --- | --- | --- |
| `reuse-start-reachable` | a VM starts after a record replaced its wait (`NeverStartsOnReuse`) | `Start`, `reusedBoot = "this"`, `reusedAge = "ok"` |
| `reuse-miss-start-reachable` | a VM starts after finding an unusable record and waiting out its own window (`NeverStartsPastAnUnusableRecord`) | `Start`, `missed = TRUE`, `reusedBoot = "none"` |
| `reuse-dip-start-reachable` | a VM starts on a reused record although the host failed between the recorded sample and the sample under the lease (`NeverStartsOnReuseAcrossADip`) | `Start`, `reusedDip = TRUE`, `dips = 1` |

The third is the weakening reuse adds, as a checked fact. One trace:

1. `OtherAcquire`, `OtherRecords`: another operation of this home holds the
   lease and records a sample taken on a passing host, as a stop does.
2. `Degrade`, `Recover`: the host fails and passes again (`recDip = TRUE`,
   `dips = 1`).
3. `OtherRelease`.
4. `Open`: this start's first sample, on a passing host.
5. `ProveTrees`, then `AcquireLease`.
6. `AgeRecord`: the record is now at least a window old.
7. `Reuse`: with part of the window still to wait, the sample under the lease
   is taken at once, on a passing host, with the first sample's swapout count
   and the record's (`reusedDip = TRUE`).
8. `Settle`, `ProveRoot`, `AdmitBoot` and `Start`: `vm = TRUE`.

Without a record the start's two samples are a window apart. With one they can
be as close as the start's own checks, and the evidence that the host held for
a window is the recorded sample, up to the bound old. A host that failed and
passed again anywhere between that sample and the one under the lease is
admitted. A swapout in that stretch still refuses the reuse
(`ReusedRecordSameSwapouts`), and the start then waits as before. The bound
limits how long the unseen stretch is; the model has one age class for it and
does not measure it.

When the age counts: `Reuse` judges the record and accepts the sample in one
step, so in the model the record's age is its age at the sample. The code reads
and judges the record first, takes the sample, and then judges the age again on
the same clock (`Earlier::in_age`) before the sample may replace the wait, so a
record that passes the bound during the probe is a miss. The tests
`a_record_that_passes_the_bound_while_the_sample_is_taken_does_not_replace_the_wait`
and `a_clock_that_cannot_be_read_once_the_sample_exists_does_not_replace_the_wait`
in `admission/opening/tests.rs` pin that.

Assumption about the bound: in the code it is a setting of whole seconds from 0
to 600 (default 60). Zero turns reuse off, and a value above 600 refuses the
start instead of being reduced. The model assumes a bound exists and is at least
one window; it does not check the setting's range, which
`admission/opening/tests.rs::the_bound_setting_is_whole_seconds_up_to_ten_minutes_and_anything_else_is_refused`
pins.

What the model leaves out about the record:

- The file. Whether the record is a private regular file of this user (not a
  link, one name, mode 0600), whether it parses as an object of exactly three
  named fields (a list of the three values is a miss), and the
  pending file of an interrupted write are checks of
  `admission/opening.rs::read` and `discard_pending`. In the model a record that
  fails them is `recBoot = "none"`. Their evidence is `admission/opening/tests.rs`.
- The clocks. The model has three age classes. That the age is taken on a clock
  that counts through sleep, that an unreadable clock or boot session is a miss,
  and the bound's setting are code and its tests.
- A sample taken early for a reuse and then discarded, when its count differs
  from the record's or it fails a predicate. The model has no such step: it
  takes `Reuse` only when the sample fits. The discarded sample costs time, not
  a state.
- The order of the start's own write. The code writes the record after the tree
  and root files rechecks, the alias restore, the settle and the creation of the
  pool's owner record, and before the check before boot; the model folds it into
  `Settle` and `ObserveRunning`. A start refused before the owner record exists
  has written no record in the code, and one refused at the check before boot
  removes the record it wrote. No invariant reads the record after the start's
  sample under the lease.
- A later start that reads what this start wrote. The model has one start; a
  record another start or a stop wrote is `OtherRecords`.
- Removing the record. The code unlinks it when a sample Hack took fails, is
  refused or shows another swapout count (`Earlier::forget`,
  `opening::forget_unleased`, `StopSample::settle`), and never writes it into a
  pool without its owner record. A removed record is `recBoot = "none"`, a miss,
  so the model's safety properties do not depend on the removal; its evidence is
  `a_sample_that_fails_under_the_lease_removes_the_record`,
  `a_refusal_before_the_lease_removes_the_record_only_if_the_lease_is_free`,
  `a_stop_sample_is_settled_without_waiting`,
  `a_stop_sample_is_taken_on_its_own_thread_for_a_development_pool_only` and
  `a_pool_without_its_owner_record_gets_no_record_and_its_root_stays_as_it_was`
  in `admission/opening/tests.rs`.
- `runtime down` itself. Its writer is `OtherRecords`: an operation holding the
  lease records a passing sample. Where in the stop the sample is taken, and
  that a failing sample never fails the stop, are
  `a_stop_records_a_passing_sample_and_a_failing_one_removes_the_record` and
  `down_samples_the_host_beside_the_stop_and_settles_it_after`.
- When a record ages. Only the read under the lease looks at the age, so
  `AgeRecord` runs there and nowhere earlier; aging before the lease would reach
  the same states.

## Source and regression mapping

Rust paths are relative to `packages/runtime-core/src/provider/`. Tests are unit
tests of the named module unless marked.

| Model action | Source | Regression |
| --- | --- | --- |
| `RestoreAliasBeforeUse`, `RefuseAlias` | `lifecycle.rs::restore_released_short_home_before_use`, `state.rs::Owner::restore_released_short_home` | `lifecycle/short_home/tests.rs`: `a_squatted_alias_is_moved_before_start_reads_the_owner`, `public_up_moves_a_squatted_alias_before_its_profile_lookup`, `a_squatted_alias_of_a_pool_with_pinned_dependency_sockets_is_refused_unchanged` |
| `ResumeRunning` | `lifecycle/running_start.rs::select`, `resume` | `lifecycle/running_start/tests.rs`: `only_a_running_created_pool_of_the_requested_profile_takes_the_fast_path`, `a_live_owned_running_pool_takes_the_fast_path` |
| `Open`, `RefuseFirst`; `SamplesTakenOnPassingHost` at the first sample | `lifecycle/admission_pool.rs::select`, `probe`; `admission.rs::open`, `check` | `admission/pressure_tests.rs`: `the_first_development_sample_must_pass_every_predicate_to_open_the_window` |
| `Degrade` then `Recover` between two accepted samples (`acrossDip`) | `admission.rs::recheck_after_lease` (Development) and `sample_checked` (Research): nothing reads the host between two samples | `a_dip_between_the_two_development_samples_is_not_seen`: the sampler is asked twice, at the first sample and no sooner than one second later, and a host failing at every moment in between is admitted. Research's pause has no such test. |
| `Reuse`, and no step for a miss | `admission.rs::recheck_after_lease`; `admission/opening.rs::Opening::judge`, `read` | `admission/opening/tests.rs`: `a_same_boot_record_between_one_window_and_the_bound_old_replaces_the_wait`, `a_reused_start_still_takes_both_of_its_own_samples_and_each_must_pass`, and one test for each miss, each asserting that the start is not refused, sleeps the rest of its own window and takes the sample a home without a record takes: `a_missing_record_is_the_start_without_one`, `an_unreadable_record_is_the_start_without_one`, `an_unparsable_record_is_the_start_without_one`, `a_record_with_unknown_missing_or_mistyped_fields_is_the_start_without_one`, `a_record_that_is_not_a_regular_file_is_the_start_without_one`, `a_record_not_owned_by_this_user_is_the_start_without_one`, `a_group_or_world_accessible_record_is_the_start_without_one`, `a_record_from_another_boot_session_is_the_start_without_one`, `a_boot_session_that_cannot_be_read_is_the_start_without_a_record`, `a_record_younger_than_the_window_is_the_start_without_one`, `a_record_older_than_the_bound_is_the_start_without_one`, `a_clock_that_cannot_be_read_is_the_start_without_a_record`, `a_swapout_count_that_differs_from_the_record_is_the_start_without_one`, `a_sample_that_cannot_be_taken_early_is_taken_after_the_wait`, `reuse_turned_off_reads_no_record`, `a_start_with_no_wait_left_does_not_ask_for_the_record`; `lifecycle/pressure_tests.rs`: `a_start_that_reuses_a_recorded_sample_still_takes_and_records_two_samples` |
| `reusedDip` (a dip between the recorded sample and the sample under the lease) | the same: nothing reads the host between the record and the start | `admission/opening/tests.rs`: `a_dip_between_the_record_and_the_leased_sample_is_not_seen` |
| `OtherRecords`, `RecordOpening`; `RecordsFromPassingSamples` | `admission/opening.rs::record`, `StopSample`; `lifecycle.rs::start_pool_observed`, `down_observed` | `admission/opening/tests.rs`: `the_record_holds_exactly_three_fields_and_only_this_user_can_read_it`, `only_a_sample_that_passes_every_predicate_on_its_own_is_recorded`, `an_interrupted_write_does_not_block_the_next_record`, `a_stop_records_a_passing_sample_and_a_failing_one_removes_the_record`; `lifecycle/pressure_tests.rs`: `down_samples_the_host_beside_the_stop_and_settles_it_after` |
| `ResearchNeverReuses` | `admission.rs::recheck_after_lease` returns before it asks for the record; `admission/opening.rs::record`, `StopSample::beside` | `admission/opening/tests.rs`: `research_neither_reads_nor_writes_a_record` |
| `ResearchSample`, `RefuseSample` | `admission.rs::sample_with`, `sample_checked` | `startup_windows_keep_profile_floors_and_distinguish_warning_from_normal`, `incomplete_or_unsafe_samples_cannot_be_authorized_by_admitted_or_legacy_booleans`, `swapouts_must_be_observed_and_unchanged_across_the_full_window` |
| `ProveTrees`, `RefuseTree` | `artifact.rs::verify_witnessed`, `verify_tree` | `artifact.rs`: `a_tree_pruned_of_empty_directories_is_repaired_from_its_retained_archive`; `lifecycle/running_start/tests.rs`: `a_changed_tree_file_is_caught_by_the_cheap_check_and_proven_by_content` |
| `AcquireLease`, `LeaseTimeout`, `OtherAcquire`, `OtherRelease` | `lifecycle.rs::startup_lease`, `operation_lease` | `lifecycle.rs`: `startup_lease_waits_out_a_brief_holder_and_refuses_a_lasting_one` |
| `Tick` under the lease, `Recheck` | `lifecycle.rs::startup_admission_lease`, `admission.rs::recheck_after_lease` | `a_fast_start_still_waits_out_the_admission_window_and_a_slow_one_does_not_pause`, `an_early_wake_does_not_shorten_the_admission_window`, `healthy_post_lease_warning_is_resampled_before_allocation`; `lifecycle/pressure_tests.rs`: `lease_wait_pressure_change_refuses_owner_commit_and_releases_the_mutation_lease` (sampled only under the lease and after the window) |
| `RefuseRecheck` with `Degrade` or `Swapout` | the same | `post_lease_sample_blocks_allocation_when_prelease_admission_goes_stale`, `a_swapout_change_between_the_chained_samples_refuses_whatever_the_wait`; the lifecycle test above (the lease is free again and no owner was written) |
| `Qualify` | `admission.rs::recheck_after_lease` (Research returns no sample) | last assertions of `post_lease_sample_blocks_allocation_when_prelease_admission_goes_stale` |
| `RestoreAliasLeased` | `lifecycle.rs::restore_released_short_home` | `lifecycle/short_home/tests.rs`: `a_clean_stop_whose_alias_host_cleanup_removed_is_restored_exactly`, `a_squatted_alias_is_never_used_and_the_receipt_moves_to_a_fresh_alias` |
| `TreesStillProven` in `Settle` and `ObserveRunning`, `RefuseTreeRecheck` | `lifecycle/leased_trees.rs::recheck`, `tree_witness.rs::qualified_digest`, `artifact.rs::verify_record`, `verify_witnessed` | `lifecycle/leased_trees/tests.rs`: `unchanged_trees_keep_their_proofs_and_hash_nothing_under_the_lease`, `a_tree_changed_between_its_proof_and_the_lease_refuses_before_any_effect`, `a_tree_whose_metadata_changed_but_whose_bytes_did_not_is_proven_again_and_continues`, `a_tree_reinstalled_with_its_recorded_content_is_proven_again_and_continues`, `off_a_qualified_filesystem_both_trees_are_proven_again_under_the_lease`, `a_rewritten_record_or_an_aliased_tree_is_refused_under_the_lease`, `the_recorded_witness_names_what_was_verified_under_the_lease` |
| `ProveRootEarly` | `lifecycle/rootfs_proof.rs::prove`, `lifecycle.rs::prove_rootfs` | `lifecycle/rootfs_proof.rs`: `unchanged_root_files_are_accepted_without_a_second_content_proof`, `root_files_that_do_not_match_the_pin_or_cannot_be_read_give_no_early_proof`, `a_pool_that_is_not_cleanly_stopped_gets_no_early_proof_and_no_recheck`, `an_unqualified_filesystem_gets_no_early_proof_no_thread_and_one_content_proof`; the thread beside the tree proofs: `a_proof_that_panics_is_no_proof_and_no_refusal`, `a_tree_proof_error_is_returned_after_the_proof_thread_has_ended`, `a_thread_the_host_cannot_start_is_no_proof_and_no_refusal` |
| `RecheckRoot`, and `RefuseRoot` after an early proof | `lifecycle/rootfs_proof.rs::recheck`, `Early::holds`, `Leased::stands`; `tree_witness.rs::qualified_digest`; `lifecycle.rs::prove_rootfs` | `lifecycle/rootfs_proof.rs`: `the_recheck_keeps_an_unchanged_proof_and_hashes_nothing_under_the_lease`, `a_root_file_changed_between_the_proof_and_the_lease_refuses_at_the_recheck`, `root_files_whose_metadata_changed_but_whose_bytes_did_not_are_proven_again`, `off_a_qualified_filesystem_no_earlier_digest_is_accepted_and_nothing_is_rechecked`, `another_marker_or_pin_under_the_lease_is_proven_against_the_lease_held_record`, `the_recheck_reads_the_lease_held_owner_record_and_writes_nothing`, `a_rewrite_that_puts_the_modification_time_back_still_takes_the_full_proof`, `every_ordinary_change_between_the_proof_and_the_lease_takes_the_full_proof`; the comparison where the digest is used: `where_the_digest_is_used_the_root_files_are_walked_again_and_nothing_is_hashed`, `a_root_file_changed_after_the_recheck_is_not_accepted_where_the_digest_is_used`, `prepare_rootfs_refuses_a_root_file_changed_after_the_recheck_under_the_lease` |
| `Settle`, `RefuseSelection` | `lifecycle/admission_pool.rs::settle`, `Selection::reverify` | `lifecycle/admission_pool/tests.rs`: `selected_owner_or_provider_changes_refuse_reverification`, `selected_stopped_owner_drift_refuses_reverification`, `a_start_with_fresh_headroom_drops_the_reserve_and_runs_no_release_check` |
| `AdmitBoot`, `RefuseBoot`; `BootSampleOnPassingHost`, `BootSampleMatchesBaseline` | `lifecycle/admission_pool.rs::admit_boot`, `admit_boot_with` (the `admitted` check, then the swapout comparison) | `the_boot_gate_samples_the_qualifying_basis_and_its_swapouts`, `the_boot_gate_rechecks_the_selection_around_its_sample` |
| `Start` | `BootAdmission::release`, `lifecycle.rs::start_machine` | `machine_start_needs_a_final_leased_recheck_of_the_selection` |
| Order of the steps, one clock for the window, the baseline handed to `admit_boot`, the tree recheck as the first step after the leased sample (before the start's next write, provider command or tree read), the root files recheck as the step after it, the record of the start's sample as its first write under the lease and after both rechecks, the record read only inside the leased sample's call, the bound's setting refused before the first effect, the root files compared again in `prepare_rootfs` after the provider command a start can run before it, the rechecked proofs and the root files digest of that last comparison handed to the boot's witness | `lifecycle.rs::start_pool_observed` | `lifecycle/pressure_tests.rs`: `start_pool_takes_its_admission_steps_in_the_modelled_order`. It reads source order only. |

Not covered by an executable test:

- `start_pool_observed` as a whole. Its steps are tested one function at a time; the source
  order test above is the only link between them. Running the sequence needs a VM.
- `ObserveRunning`: the `owner.phase == "running"` branch after a concurrent start
  won the lease.
- The tree recheck inside a real start. Its tests call `leased_trees::recheck`
  under a real lease on fixture trees; that `start_pool_observed` calls it first under the
  lease is the source order test's claim. A tree changed between the proof and the
  lease of a real `runtime up` was not exercised.
- `ProveRoot` and `RefuseRoot` in a cold start (`prepare_rootfs`, `prove_rootfs`).
- The root files comparisons inside a real start. Their tests call
  `rootfs_proof::recheck` under a real lease on a fixture pool, `prepare_rootfs`
  on that pool, and the functions they wrap on fixture trees; that
  `start_pool_observed` calls the recheck straight after the tree recheck, calls
  `prepare_rootfs` after `enable_amd64_emulation`, and hands its digest to the
  boot's witness, is the source order test's claim. A root file changed between
  the proof and the lease, or between the lease and its use, of a real
  `runtime up` was not exercised here.
- `Crash`. The model relies on the kernel returning an advisory file lock when its
  holder dies; no test kills a start.
- `RefuseRoot` from `Proven`. The model refuses before the lease when the early
  proof finds root files that do not match their pin. The code does not refuse
  there: it takes the lease without an early proof and `prepare_rootfs` refuses the
  same root files under it, which is `positive`'s `RefuseRoot` from `Settled`.

Not modelled, although `start_pool_observed` does it between its first line and
`machine start`:

- The HOME alias beyond a squat. The model's alias is owned, held by another
  entry, or moved to a fresh name, and the move is one step. It has no absent
  alias (host cleanup removed the link; `restore_released_short_home` creates it
  again under the lease and leaves the record as it is) and no state between
  `move_to_fresh_short_home`'s save of the record and its creation of the link.
  A crash there leaves a clean stop whose recorded alias is absent, which the
  next restore creates. The unit tests of `lifecycle/short_home/tests.rs` cover
  the absent and the squatted alias one call at a time
  (`a_clean_stop_whose_alias_host_cleanup_removed_is_restored_exactly`,
  `a_squatted_alias_is_never_used_and_the_receipt_moves_to_a_fresh_alias`); no
  test interrupts a restore between the save and the link.
  These states are about the alias, not about admission, and no admission guard
  reads them, so they are not added here: they would multiply every state before
  `Settled`, and one start cannot state their property. A model of the alias
  repair needs the recorded alias name and the state of its path as separate
  variables (absent, this pool's link, another entry); the clean-stop marker that
  alone permits an absent or moved alias, and the phase writes that clear it; the
  pending owner update and the dependency-socket pin that refuse a repair; the
  save and the link as two steps with a crash between them; a cleanup or a squat
  at any moment, because no lease fences the path; the three callers (before the
  first owner read, under the startup lease, and `runtime recover`); and more
  than one start. Its properties: every state a start or a crash leaves is one
  from which a later start completes or refuses by name (`foreign_state`,
  `provider_home_missing`, `socket_alias_collision`); no provider command runs
  with an alias that is not this pool's link to its own home; and another entry
  is never followed, replaced or removed.
- `interrupted::before_boot`. Under the lease, after the alias repair and before
  `settle`, the start removes the intent of a set-aside that the owner record
  committed, or refuses `recovery_required` while one is unfinished. In this
  model the refusal is one of `RefuseOther`'s, so `RefusalIsClean` covers it: no
  VM, lease returned. The removal and the property it protects (a boot's new
  disks never meet an unfinished set-aside) are not modelled, because the model
  has neither the owner phase nor `runtime recover`. A model of the set-aside
  needs the intent's states (absent, written, files moved, committed by the
  owner's `stopped-before-engine`, removed) with a crash between each; the owner
  phase and the steps of a start that rewrite it; `before_boot` as the first
  read of that phase under the lease; and a recovery that takes the same lease.
  Its unit test is one block of
  `unverified_templates_never_move_adopted_or_foreign_files` in
  `lifecycle/interrupted.rs`, and the source order test above requires only that
  the call comes after the tree recheck.

## What a proof before the lease relies on

The provider and engine trees are proven by content before the lease
(`ProveTrees`), so the proof fills the admission window. Until the lease is taken
nothing fences them: `prepare`, `prepare_engine` and `repair_tree` take the same
lease and install only content that matches the recorded digest, and any other
writer ignores it.

`leased_trees::recheck` is the start's first step after Development's second
sample under the lease: between that sample and the recheck the start writes
nothing, runs no provider command and reads no tree. (Before the lease it has
already read both trees to prove them and may have repaired the HOME alias.) For each tree it
recomputes the metadata digest and compares it, and the record's content anchor,
with what the proof returned:

- Equal, on a filesystem qualified for the metadata check: the proof stands and
  nothing is hashed.
- Anything else, including a tree off a qualified filesystem: the tree is proven
  by content again under the lease. A change that kept the bytes (a touch, or a
  repair that reinstalled the recorded content) continues; a changed byte refuses
  `artifact_digest_mismatch` and the lease is returned. The recheck writes
  nothing, and the refusal comes before the admission record, later owner
  updates and any provider command. A HOME alias repaired before admission and
  the lease file's bookkeeping are not rolled back; `RefusalIsClean` checks that
  this start created no VM and no longer holds the lease, not that nothing was
  written.

`artifact::verify_witnessed` takes the metadata digest before the content hash and
requires the same digest after it, so the digest the recheck compares describes
the tree on both sides of the hash. The boot's tree witness
(`tree_witness::record_boot`) records the proofs the recheck left.

The model keeps one bit for both trees, `treeOk`: the content is what the record
names. `TreesStillProven` is the recheck's outcome on that bit. A change that
keeps the bytes is not modelled; in the code it costs one content proof and
changes no outcome. The model folds the recheck into `Settle` and
`ObserveRunning`, the two steps that leave `Qualified` without refusing, although
the code runs it before the alias restore. No tree changes while the lease is
held, so its place among the leased steps changes no checked invariant. The model
therefore also allows an alias restore before a tree refusal, which the code never
does.

`changed-tree-start` removes the recheck and reaches `Start` with
`treeOk = FALSE`: a tree changed between its proof and the lease is booted once
and detected only by the next command's witness check
(`running_start::verify_trees`). That was the implementation before the recheck.

What the recheck does not cover: a writer that ignores the lease and changes a
tree after the recheck and before `machine start` (the model assumes none), and
the content changes that keep all metadata, which `tree_witness` lists.

## The root files proof before the lease

A cleanly stopped pool's root files are proven by content in the admission
window too (`ProveRootEarly`, `lifecycle/rootfs_proof.rs::prove`), on a thread
beside the tree proofs (`rootfs_proof::early_beside`), against the pin the owner
record names. The proof is read-only and grants nothing by itself. Whether it is
taken is decided before the thread is started: root files that are not on a
qualified filesystem get no early proof, no thread and no recheck, because no
later comparison could accept it, and are proven once in `prepare_rootfs`. A
qualification that cannot be read, a thread the host cannot start and a proof
that panics are no early proof either, and never a refusal.

`rootfs_proof::recheck` is the start's next step after the tree recheck: between
the two the start writes nothing and runs no provider command. It reads the owner
record the lease now fences and recomputes the root files' metadata digest. A
record that is no longer a clean stop (another start booted the pool) is not
rechecked at all and takes the path it took before. Otherwise:

- The marker and the pin are the ones the lease-held record names, the root files
  are on a qualified filesystem and the digest equals what the proof saw: the
  proof stands and nothing is hashed.
- Root files that left the qualified filesystem after their early proof: left
  to the content proof in `prepare_rootfs`, with nothing hashed here.
- Anything else: the root files are proven by content again under the lease,
  against the lease-held pin. A change that kept the bytes continues; a changed
  byte refuses `artifact_digest_mismatch` and the lease is returned. The recheck
  writes nothing, and the refusal comes before the admission record, later owner
  updates and any provider command. What the start did before the lease is not
  rolled back, as for the tree recheck.

The root files are compared a third time where the result is used.
`prepare_rootfs` runs after the owner record updates of the start and after the
provider command a start can run before it (`machine update --rosetta`, when
translation is being enabled). There `Leased::stands` walks the metadata once
more, reading no file content: for the marker and pin the recheck used, on a
qualified filesystem, a digest equal to the recheck's stands in for a second
content proof; anything else runs the content proof at that point, where it ran
before the early proof existed. `start_pool_observed` hands the digest of that
last walk, or of that proof, to the boot's tree witness with the rechecked tree
proofs. From there to `machine start` nothing looks at the root files again,
which is the interval the proof under the lease left too.

Without an early proof nothing is rechecked and `prepare_rootfs` proves the root
files by content under the lease (`ProveRoot`), which is `positive`. Doubt before
the lease never accepts and never refuses by itself.

The model keeps one bit, `rootOk`: the content is what the pin names.
`RecheckRoot` is the outcome of the comparisons under the lease on that bit, and a
change that keeps the bytes is not modelled. The model has one `RecheckRoot`,
after `Settle`: that is where the code's last comparison is (`prepare_rootfs`).
The code's first comparison under the lease, straight after the tree recheck and
before the alias restore and the settle step, has no action of its own. In the
model no root file changes while the lease is held, so one comparison or two, and
their place among the leased steps, change no checked invariant; the second
comparison exists for what the model assumes away, a root file changed under the
lease by the start's own provider command or by a writer that ignores the lease,
and its evidence is its unit tests. `root-unchecked` removes the recheck and
reaches `RootProven` with `rootOk = FALSE`.

What the comparisons do not cover: a writer that ignores the lease after the last
of them, and the content changes that keep all metadata (`tree_witness`) between
the content proof before the lease and that last comparison.

## The alias rewrite before the first sample

`restore_released_short_home_before_use` can take the lease, write a fresh alias
into the owner record and return the lease before anything is sampled
(`RestoreAliasBeforeUse`). It affects no invariant:

- No sample or clock exists yet, so the window, the chain and the lease that the
  second sample needs are all later than the rewrite.
- `admission_pool::select` reads the owner record after it, so a reserve selection
  is bound to the rewritten record (`moved-alias-start-reachable`).

A rewrite under the lease (`RestoreAliasLeased`) can only follow a squat during
this start. With a reserve selection the start then refuses
`admission_owner_changed` at the settle step, and the next start succeeds. Without
one it continues: nothing was bound to the old record.

## Bounds and proof limits

`Window = 2` ticks, `MaxSwapouts = 1`, `MaxDips = 1` (the host fails, passes
again once, and may fail again for good), one tree change, one root change, one
alias squat before the settle step, one concurrent start, any number of lease
acquisitions by others, any number of records written by them, and at most one
record left by another OS boot. One start; a retry is a new behaviour from
`Idle`.

- A sample is one atomic observation. The real probe runs four host tools over
  about 50 ms.
- `hostOk` stands for every predicate of `admission::check` except the swapout
  chain, as one bit: which predicate failed, and by how much, is not modelled.
  The host recovers at most once. Pressure that comes and goes between two
  observations is invisible to the code; the model records it (`failedSince`,
  `acrossDip`, `bootAcrossDip`) so that the three dip controls can show it.
  `failedSince` is tracked from the first sample to the pre-boot observation and
  not after it. The swapout count is the only cumulative signal.
- The pre-boot check is modelled with the same predicate as a sample. The code
  uses the probe's `admitted` field there, which the probe computes from the same
  observations.
- The clock saturates at the window. Research's fifteen-second pause and
  Development's one second are the same `Window`; the model does not compare them.
  Research's extra first probe, which is checked but not part of its window, is
  folded into `Open`.
- Tree and root changes happen only while this start does not hold the lease.
  Writers that ignore the lease are outside both content proofs' threat model
  (`tree_witness`), under the lease as well as before it. The two rechecks are
  what make the lease the boundary for the trees and for root files proven before
  it: a change before it is caught, a change after it is this assumption.
- A tree is one bit, and so are the root files. The metadata comparison, the
  qualified-filesystem condition and the second content proof are one guard in the
  model; their unit tests are the evidence for them.
- The reserve selection is checked at the sample under the lease only for a
  readable owner record, and bound at `Settle`. The receipt and release checks
  around every sample are `admission_pool`'s own tests.
- Each step is atomic and durable. Partial writes, file synchronisation, real
  process identity, the provider and everything after `machine start` are not
  modelled. There is no fairness or liveness claim: a start may wait or refuse
  forever.

A pass is evidence about this finite abstraction. It is not a measurement, and it
does not qualify the implementation or a real boot.

## Checker

Checked with the repository's pinned TLC 1.7.4 (`tla2tools.jar`, SHA-256
`936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`, banner
`TLC2 Version 2.19 of 08 August 2024 (rev: 5a47802)`) on Temurin 17.0.20.1+1,
through `bun run test:models`: two workers, a 512 MiB heap, a 120-second limit per
configuration and deadlock checking off. Apalache was not run. The registry in
`scripts/lib/tla-runtime-models.ts` pins the counts and witnesses above.
