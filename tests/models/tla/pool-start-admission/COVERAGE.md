# Pool start admission

Question: when a Development pool start admits on two host samples instead of two
three-sample windows, can a VM start without a second qualifying sample taken under
the startup lease, at least the window after the first, with one unbroken swapout
count from the first sample to the pre-boot check?

![PoolStart: pool start admission](../../../../docs/diagrams/pool-start-admission.svg)

[Diagram source](../../../../docs/diagrams/pool-start-admission.mmd); states,
transitions and exits are listed in
[the statechart page](../../../../docs/pool-start-admission-statechart.md). The
diagram is a review aid, not an additional checked model.

`PoolStart.tla` enumerates one `runtime up` of a pool that is not running, for both
profiles, against a host that changes underneath it. The starting process samples
the host, proves the provider and engine trees, takes the startup lease, samples
again (Development only), rechecks the trees against their proof, settles its
reserve selection, proves the root files, runs the pre-boot check and starts the
VM. The environment advances a monotonic clock, degrades the host, grows the
swapout count, takes and returns the lease, boots the pool from a concurrent
start, changes a tree or the root files while the lease is not held, and squats
the clean-stop HOME alias. The process can refuse or crash at every step.

`stopped-pool-startup/Resume.tla` covers the same start's retained selection and
receipt evidence, with no host admission, clock or content proof. The two questions
share no variable, so this is a sibling model and `Resume.tla` is unchanged.

## Configurations

`positive` is the implementation: Development's second sample is taken under the
lease, the trees proven before the lease are rechecked under it
(`EnforceTreeRecheck = TRUE`), and the root files are proven under the lease
(`RootProofBeforeLease = FALSE`). `root-before-lease` is the follow-up ordering:
the root files are proven in the window before the lease and their metadata is
rechecked under it (`RootProofBeforeLease = TRUE`, `EnforceRootRecheck = TRUE`).
Both check the same invariants.

| Configuration | Kind | Distinct states | Result |
| --- | --- | ---: | --- |
| `positive` | the implementation | 21,028 | no error |
| `root-before-lease` | follow-up ordering | 27,004 | no error |

An earlier revision of this model had no tree recheck in `positive` (21,400
states) and kept the recheck as a hypothetical third configuration,
`tree-recheck`. The recheck is now code (`lifecycle/leased_trees.rs`), so that
configuration became `positive` and was removed.

## Invariants

Every invariant holds in `positive` and `root-before-lease`.

| Invariant | In plain words |
| --- | --- |
| `DevelopmentTwoSamples`, `SecondSampleUnderLease`, `WindowRespected` | A Development VM starts only on two qualifying samples, the second taken under the startup lease and at least the window after the first. |
| `ChainUnbroken` | No accepted sample shows a swapout count other than the first sample's. A sample that fails a predicate or shows another count is never appended: the only step from it is a refusal. |
| `BootBaselineIsLastSample`, `BootChecked` | The pre-boot check ran before every start and compared against the last qualifying sample's swapout count. |
| `ResearchThreeSamples` | A Research VM starts only on three samples, each at least the window after the one before, and none under the lease. |
| `TreesProvenThisStart` | The provider and engine trees were proven by content in this start before the lease was taken. |
| `NoStartFromChangedTree` | No VM starts from a tree that changed after that proof: the recheck under the lease refuses it. |
| `StartFromProvenRoot` | The root files a boot uses were proven and were unchanged when last checked under the lease. |
| `SelectionBound` | A reserve selection that continues past the settle step still names the current owner record. |
| `NoSecondVm` | This start never boots a pool that a concurrent start already booted. |
| `RefusalIsClean`, `LeaseHeldForEffects`, `VmOnlyWhenStarted` | A refusal, a crash or a join leaves no VM started and the lease returned; every step after the lease holds it. |

## Controls that must fail

Each control keeps every invariant and changes one constant. The registry requires
TLC exit 12, the named invariant, the named action and the same-state fields.

| Control | Change | Violated invariant | At |
| --- | --- | --- | --- |
| `negative` | the second sample may be taken before the lease | `SecondSampleUnderLease` | `Recheck`, `pc = "Proven"` |
| `window-not-enforced` | the second sample ignores the clock | `WindowRespected` | `Recheck` |
| `unchained-recheck` | the second sample is not compared with the first one's swapouts | `ChainUnbroken` | `Recheck`, `swapouts = 1` |
| `unchained-boot` | the pre-boot check uses its own swapout count | `BootBaselineIsLastSample` | `AdmitBoot`, `baseline = <<1>>` |
| `research-two-samples` | Research takes two samples | `ResearchThreeSamples` | `Start` |
| `root-unchecked` | follow-up ordering without the recheck under the lease | `StartFromProvenRoot` | `RecheckRoot`, `rootOk = FALSE` |
| `changed-tree-start` | the trees are not rechecked under the lease | `NoStartFromChangedTree` | `Start`, `treeOk = FALSE` |

`changed-tree-start` is the implementation as it was before the recheck; see "What
a proof before the lease relies on".

Three reachability controls show that the invariants are not vacuous. Each states
that a start never happens and must be violated at `Start`:
`development-start-reachable`, `research-start-reachable` and
`moved-alias-start-reachable` (a start whose alias moved before its first sample,
on a reserve selection bound to the rewritten owner record).

## Source and regression mapping

Rust paths are relative to `packages/runtime-core/src/provider/`. Tests are unit
tests of the named module unless marked.

| Model action | Source | Regression |
| --- | --- | --- |
| `RestoreAliasBeforeUse`, `RefuseAlias` | `lifecycle.rs::restore_released_short_home_before_use`, `state.rs::Owner::restore_released_short_home` | `lifecycle/short_home/tests.rs`: `a_squatted_alias_is_moved_before_start_reads_the_owner`, `public_up_moves_a_squatted_alias_before_its_profile_lookup`, `a_squatted_alias_of_a_pool_with_pinned_dependency_sockets_is_refused_unchanged` |
| `ResumeRunning` | `lifecycle/running_start.rs::select`, `resume` | `lifecycle/running_start/tests.rs`: `only_a_running_created_pool_of_the_requested_profile_takes_the_fast_path`, `a_live_owned_running_pool_takes_the_fast_path` |
| `Open`, `RefuseFirst` | `lifecycle/admission_pool.rs::select`, `probe`; `admission.rs::open`, `check` | `admission/pressure_tests.rs`: `the_first_development_sample_must_pass_every_predicate_to_open_the_window` |
| `ResearchSample`, `RefuseSample` | `admission.rs::sample_with`, `sample_checked` | `startup_windows_keep_profile_floors_and_distinguish_warning_from_normal`, `incomplete_or_unsafe_samples_cannot_be_authorized_by_admitted_or_legacy_booleans`, `swapouts_must_be_observed_and_unchanged_across_the_full_window` |
| `ProveTrees`, `RefuseTree` | `artifact.rs::verify_witnessed`, `verify_tree` | `artifact.rs`: `a_tree_pruned_of_empty_directories_is_repaired_from_its_retained_archive`; `lifecycle/running_start/tests.rs`: `a_changed_tree_file_is_caught_by_the_cheap_check_and_proven_by_content` |
| `AcquireLease`, `LeaseTimeout`, `OtherAcquire`, `OtherRelease` | `lifecycle.rs::startup_lease`, `operation_lease` | `lifecycle.rs`: `startup_lease_waits_out_a_brief_holder_and_refuses_a_lasting_one` |
| `Tick` under the lease, `Recheck` | `lifecycle.rs::startup_admission_lease`, `admission.rs::recheck_after_lease` | `a_fast_start_still_waits_out_the_admission_window_and_a_slow_one_does_not_pause`, `an_early_wake_does_not_shorten_the_admission_window`, `healthy_post_lease_warning_is_resampled_before_allocation`; `lifecycle/pressure_tests.rs`: `lease_wait_pressure_change_refuses_owner_commit_and_releases_the_mutation_lease` (sampled only under the lease and after the window) |
| `RefuseRecheck` with `Degrade` or `Swapout` | the same | `post_lease_sample_blocks_allocation_when_prelease_admission_goes_stale`, `a_swapout_change_between_the_chained_samples_refuses_whatever_the_wait`; the lifecycle test above (the lease is free again and no owner was written) |
| `Qualify` | `admission.rs::recheck_after_lease` (Research returns no sample) | last assertions of `post_lease_sample_blocks_allocation_when_prelease_admission_goes_stale` |
| `RestoreAliasLeased` | `lifecycle.rs::restore_released_short_home` | `lifecycle/short_home/tests.rs`: `a_clean_stop_whose_alias_host_cleanup_removed_is_restored_exactly`, `a_squatted_alias_is_never_used_and_the_receipt_moves_to_a_fresh_alias` |
| `TreesStillProven` in `Settle` and `ObserveRunning`, `RefuseTreeRecheck` | `lifecycle/leased_trees.rs::recheck`, `tree_witness.rs::qualified_digest`, `artifact.rs::verify_record`, `verify_witnessed` | `lifecycle/leased_trees/tests.rs`: `unchanged_trees_keep_their_proofs_and_hash_nothing_under_the_lease`, `a_tree_changed_between_its_proof_and_the_lease_refuses_before_any_effect`, `a_tree_whose_metadata_changed_but_whose_bytes_did_not_is_proven_again_and_continues`, `a_tree_reinstalled_with_its_recorded_content_is_proven_again_and_continues`, `off_a_qualified_filesystem_both_trees_are_proven_again_under_the_lease`, `a_rewritten_record_or_an_aliased_tree_is_refused_under_the_lease`, `the_recorded_witness_names_what_was_verified_under_the_lease` |
| `Settle`, `RefuseSelection` | `lifecycle/admission_pool.rs::settle`, `Selection::reverify` | `lifecycle/admission_pool/tests.rs`: `selected_owner_or_provider_changes_refuse_reverification`, `selected_stopped_owner_drift_refuses_reverification`, `a_start_with_fresh_headroom_drops_the_reserve_and_runs_no_release_check` |
| `AdmitBoot`, `RefuseBoot` | `lifecycle/admission_pool.rs::admit_boot` | `the_boot_gate_samples_the_qualifying_basis_and_its_swapouts`, `the_boot_gate_rechecks_the_selection_around_its_sample` |
| `Start` | `BootAdmission::release`, `lifecycle.rs::start_machine` | `machine_start_needs_a_final_leased_recheck_of_the_selection` |
| Order of the steps, one clock for the window, the baseline handed to `admit_boot`, the tree recheck before any write or tree read under the lease, the rechecked proofs handed to the boot's witness | `lifecycle.rs::start_pool` | `lifecycle/pressure_tests.rs`: `start_pool_takes_its_admission_steps_in_the_modelled_order`. It reads source order only. |

Not covered by an executable test:

- `start_pool` as a whole. Its steps are tested one function at a time; the source
  order test above is the only link between them. Running the sequence needs a VM.
- `ObserveRunning`: the `owner.phase == "running"` branch after a concurrent start
  won the lease.
- The tree recheck inside a real start. Its tests call `leased_trees::recheck`
  under a real lease on fixture trees; that `start_pool` calls it first under the
  lease is the source order test's claim. A tree changed between the proof and the
  lease of a real `runtime up` was not exercised.
- `ProveRoot` and `RefuseRoot` in a cold start (`prepare_rootfs`, `prove_rootfs`).
- `Crash`. The model relies on the kernel returning an advisory file lock when its
  holder dies; no test kills a start.
- `ProveRootEarly` and `RecheckRoot`. They describe the follow-up change, which is
  not in this tree. When it lands, the source order test must change with it.

## What a proof before the lease relies on

The provider and engine trees are proven by content before the lease
(`ProveTrees`), so the proof fills the admission window. Until the lease is taken
nothing fences them: `prepare`, `prepare_engine` and `repair_tree` take the same
lease and install only content that matches the recorded digest, and any other
writer ignores it.

`leased_trees::recheck` runs first under the lease, after Development's second
sample and before the start writes anything or reads a tree. For each tree it
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
  no VM exists and the lease is free, not that nothing was written.

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

The root files differ. In this tree they are proven under the lease, so no step
trusts an earlier proof. In the follow-up ordering the proof moves before the lease
and the model requires the metadata recheck (`RecheckRoot`); `root-unchecked`
removes it and fails.

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

`Window = 2` ticks, `MaxSwapouts = 1`, one tree change, one root change, one alias
squat before the settle step, one concurrent start, any number of lease
acquisitions by others. One start; a retry is a new behaviour from `Idle`.

- A sample is one atomic observation. The real probe runs four host tools over
  about 50 ms.
- `hostOk` stands for every predicate of `admission::check` except the swapout
  chain. The host degrades once and does not recover: pressure that comes and goes
  between two samples is invisible to the code and to the model. The swapout count
  is the only cumulative signal.
- The pre-boot check is modelled with the same predicate as a sample. The code
  uses the probe's `admitted` field there, which the probe computes from the same
  observations.
- The clock saturates at the window. Research's fifteen-second pause and
  Development's one second are the same `Window`; the model does not compare them.
  Research's extra first probe, which is checked but not part of its window, is
  folded into `Open`.
- Tree and root changes happen only while this start does not hold the lease.
  Writers that ignore the lease are outside both content proofs' threat model
  (`tree_witness`), under the lease as well as before it. The tree recheck is what
  makes the lease the boundary for the trees: a change before it is caught, a
  change after it is this assumption.
- A tree is one bit. The metadata comparison, the qualified-filesystem condition
  and the second content proof are one guard in the model; their unit tests are
  the evidence for them.
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
