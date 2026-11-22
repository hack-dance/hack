# Pool start admission statechart

- Model: [PoolStart.tla](../tests/models/tla/pool-start-admission/PoolStart.tla).
  Checked properties, bounds and limits:
  [COVERAGE.md](../tests/models/tla/pool-start-admission/COVERAGE.md).
- Source: `start_pool_observed` and `startup_admission_lease` in
  `packages/runtime-core/src/provider/lifecycle.rs`, `provider/admission.rs`,
  `provider/admission/opening.rs`, `provider/lifecycle/leased_trees.rs`,
  `provider/lifecycle/rootfs_proof.rs` and `provider/lifecycle/admission_pool.rs`.
- Boundary: one `runtime up` of a pool that is not running, from its first host
  sample to `machine start`. A pool that already runs takes
  `lifecycle::running_start` and samples nothing.

The chart uses the model's state, guard and action names. It is a review aid,
not a checked specification: the model and its controls are the checked part.

![PoolStart: pool start admission](diagrams/pool-start-admission.svg)

[Diagram source](diagrams/pool-start-admission.mmd), rendered with Pele 1.9.0.

## States

Each state is one value of the model's `pc`.

| State | Meaning | Lease |
| --- | --- | --- |
| `Idle` | Nothing sampled yet. A squatted clean-stop alias is moved here. | Not held |
| `Opened` | The first sample qualified and the window clock started. Research takes its second and third samples here. | Not held |
| `Proven` | The provider and engine trees were proven by content, and a cleanly stopped pool's root files beside them. Nothing fences them until the lease is taken. | Not held |
| `Leased` | The startup lease is held. Development sleeps the rest of the window here, or skips it when this home's record of an earlier passing sample is usable. | Held |
| `Qualified` | Every qualifying sample exists: two for Development, three for Research. The trees are rechecked against their proof here. | Held |
| `Settled` | The trees are still what their proof saw, the reserve selection, if any, still names the owner record, and the pool is not running. A Development start has recorded its sample under the lease. | Held |
| `RootProven` | The guest root files were proven, or rechecked against their earlier proof. | Held |
| `BootAdmitted` | The pre-boot observation was admitted: taken on a passing host, showing the last qualifying sample's swapout count. | Held |
| `Started` | `machine start` ran. The lease stays held for the rest of the boot. | Held |
| `Joined` | The pool was already running, or a concurrent start made it so. Nothing was started. | Returned |
| `Refused` | A check refused. Nothing was started. | Returned |
| `Crashed` | The process died. The kernel returned its lock. | Returned |

## Transitions

| Action | Guard | Effect | Source |
| --- | --- | --- | --- |
| `RestoreAliasBeforeUse` | alias path held by another entry; lease free | owner record names a fresh alias; lease taken and returned | `restore_released_short_home_before_use` |
| `ResumeRunning` | `poolRunning` | report the running pool | `running_start::select`, `resume` |
| `Open` | `hostOk` | first sample recorded; `elapsed` reset; reserve selection bound to the owner record | `admission_pool::select`, `probe`; `admission::open` |
| `ResearchSample` | Research; `WindowElapsed`; `hostOk`; `SameSwapouts` | next pre-lease sample recorded | `admission::sample_with` |
| `ProveTrees` | `treeOk`; Research has all its samples | trees proven by content | `artifact::verify_witnessed` |
| `ProveRootEarly` | `RootProofBeforeLease`; `rootOk` | root files proven in the window | `rootfs_proof::prove`, on a thread beside `ProveTrees` (`rootfs_proof::early_beside`); a clean stop on a qualified filesystem only |
| `AcquireLease` | `lease = free` | lease held | `startup_lease` |
| `Recheck` | Development; `WindowElapsed`; `hostOk`; `SameSwapouts` | second sample recorded under the lease | `admission::recheck_after_lease` |
| `Reuse` | Development; a wait is due; `RecordUsable`; `hostOk`; `SameSwapouts` | second sample recorded under the lease at once; the record it used is kept in `reusedBoot`, `reusedAge`, `reusedSwap`, `reusedDip` | `admission::recheck_after_lease`, `admission::opening` |
| `Qualify` | Research (all samples already taken) | none | `admission::recheck_after_lease` returns no sample |
| `RestoreAliasLeased` | alias path held by another entry | owner record names a fresh alias | `restore_released_short_home` |
| `Settle` | `TreesStillProven`; `SameOwner`; pool not running | selection settled; a Development start's sample under the lease becomes the home's record (`RecordOpening`) | `leased_trees::recheck`; `admission::opening::record`; `admission_pool::settle` and the owner checks after it |
| `ObserveRunning` | `TreesStillProven`; `poolRunning`; no selection | report the running pool; `RecordOpening` as in `Settle` | `leased_trees::recheck`; `admission::opening::record`; the `owner.phase == "running"` branch of `start_pool_observed` |
| `ProveRoot` | `rootOk`; no root proof before the lease | root files proven by content | `prepare_rootfs`, `prove_rootfs` |
| `RecheckRoot` | `RootProofBeforeLease`; `rootOk` | the earlier proof still describes the root files, or they passed a second content proof | `rootfs_proof::recheck` straight after the tree recheck, then `Leased::stands` in `prepare_rootfs` |
| `AdmitBoot` | `hostOk`; `SameSwapouts` | baseline is the last sample's swapout count; the observation is recorded with the host as it was | `admission_pool::admit_boot` |
| `Start` | none | VM started | `BootAdmission::release`, `start_machine` |

`WindowElapsed` is `elapsed = Window`: at least one second for Development and
fifteen seconds for Research, on a monotonic clock, since the previous sample.
`SameSwapouts` is `swapouts = Last.swap`: the host's swapout count equals the
last recorded sample's. `SameOwner` is `selected \in {0, OwnerVersion}`: there is
no reserve selection, or it was taken from the owner record as it is now.
`RecordUsable` is the reuse condition of `admission::opening`: this home has a
record of an earlier passing sample (`recBoot` is not `none`), it is from this OS
boot (`recBoot = "this"`), it is at least one window and at most one bound old
(`recAge = "ok"`), and its swapout count is the host's now (`recSwap = swapouts`).
`Reuse` also needs a wait to be due (`elapsed < Window`); a start whose window has
already elapsed takes `Recheck` and reads no record. A record that is not usable
enables nothing: the start goes on to `Recheck` after the window, exactly as a
start without a record. The record replaces the wait, never the sample.
`TreesStillProven` is `treeOk` (drawn as `treeOk` on the `Settle` edge): under
the lease, each tree's metadata digest and content anchor equal what its proof
returned, or the tree passed a second content proof. The code runs this recheck
first under the lease, before the alias restore; the model folds it into the two
steps that leave `Qualified` without refusing. No tree changes under the lease, so
that changes no checked invariant.

`RootProofBeforeLease` names which of two paths one start takes. With an early
proof of the root files it is true: `ProveRootEarly` and `RecheckRoot` fire and
`ProveRoot` does not. That is every start of a cleanly stopped pool (the
`stopped` phase with the marker a completed `down` writes) whose owner record
names a root files pin that the root files matched before the lease. Without one
it is false: the root files are proven under the lease by `ProveRoot`. That is
the first boot of a new home, a pool whose record is not a clean stop, root
files that are not on a qualified filesystem (no early proof is taken there), and
any start whose early proof gave nothing, including one whose proof thread the
host could not start. The model checks each path as its own configuration
(`root-before-lease`, `positive`).

`RecheckRoot` is drawn once, after `Settle`. The code compares the root files
with their proof twice under the lease: straight after the tree recheck, before
the alias restore and the settle step, and again in `prepare_rootfs`, where the
model's `RootProven` is reached and the digest is used. The drawn edge is the
second; the first has no edge of its own. No root file changes under the lease
in the model, so that changes no checked invariant. One difference is not folded
away: the model's `RefuseRoot` from `Proven` refuses before the lease when the
early proof fails, and the code instead continues without an early proof and
refuses the same root files at `ProveRoot`.

## Exits

Every state before `Started` can leave through `Refuse` or `Crash`. Each
refusal below conjoins the model's `Refuse`, which returns the lease.

| Action | From | When | Error code |
| --- | --- | --- | --- |
| `RefuseAlias` | `Idle`, `Qualified` | the alias path is held and this start may not move it | `foreign_state`, `socket_alias_collision` |
| `RefuseFirst` | `Idle` | the first sample does not qualify | `admission_rejected` |
| `RefuseSample` | `Opened` | a Research sample does not qualify or its swapouts changed | `admission_rejected` |
| `RefuseTree` | `Opened` | a tree does not match its pin | `artifact_digest_mismatch` |
| `LeaseTimeout` | `Idle`, `Proven` | another operation keeps the lease past the wait | `provider_busy` |
| `RefuseRecheck` | `Leased` | the sample under the lease does not qualify, its swapouts changed, or the selection cannot be read | `admission_rejected`, `foreign_state` |
| `RefuseTreeRecheck` | `Qualified` | a tree changed after its proof and no longer matches its pin | `artifact_digest_mismatch` |
| `RefuseSelection` | `Qualified` | the selection no longer names the owner record, or the pool is running | `admission_owner_changed` |
| `RefuseRoot` | `Proven` (model only), `Settled` | the root files do not match their pin, or changed since their proof and no longer match it | `artifact_digest_mismatch` |
| `RefuseBoot` | `RootProven` | the pre-boot sample does not qualify or its swapouts changed | `admission_rejected` |
| `RefuseOther` | any | any other check of the start refuses | various |
| `Crash` | any | the process dies | none |

The recheck writes nothing, and in the code it is the first step under the lease
after the sample, so `RefuseTreeRecheck` comes before the admission record and
any provider command. A HOME alias the start repaired before admission stays
repaired. The model is coarser here: it still allows the alias repair under the
lease before the guard. The `changed-tree-start` control removes the recheck and
reaches `Started` with a changed tree.

The root files recheck is the code's next step after the tree recheck and writes
nothing either. A `RefuseRoot` at that step also comes before the admission
record and any provider command, and it is only this one: the root files are on a
qualified filesystem, their marker, pin or metadata differs from the early proof,
and the content proof run there finds they no longer match the pin. Every other
`RefuseRoot` comes from `prepare_rootfs`, after the admission record and after
`machine update --rosetta`: root files that changed after the recheck, root files
that are no longer on a qualified filesystem at the recheck (nothing is hashed
there), and a start without an early proof. The `root-unchecked` control
removes the recheck and reaches `RootProven` with changed root files.

## Environment

These actions belong to the host and to other processes. None is drawn.
`Degrade` followed by `Recover` between two accepted samples is a dip that no
sample sees: the start is admitted, and the model records it in `acrossDip`. Two
controls, `development-dip-start-reachable` and `research-dip-start-reachable`,
require that such a start is reachable. `SamplesTakenOnPassingHost` holds all the
same: `hostOk` was true at each sample, on the `Open`, `ResearchSample` and
`Recheck` edges. Each of those three guards has a control that removes it and
must fail that invariant at its edge: `first-sample-unchecked`,
`research-sample-unchecked` and `second-sample-unchecked`.

The pre-boot observation on the `AdmitBoot` edge is recorded apart from the
samples. `BootSampleOnPassingHost` says it was taken on a passing host, and
`BootSampleMatchesBaseline` that it showed the swapout count it was compared
against; `BootChecked` says only that it exists before a start. A dip between
the last sample and that observation is unseen in the same way
(`bootAcrossDip`, control `boot-dip-start-reachable`).

A start that takes the `Reuse` edge skipped its wait on a record. Four invariants
say what that record was, and each has a control that removes one condition and
must fail at `Reuse`: from this OS boot (`ReusedRecordSameBoot`,
`reuse-other-boot`), at least one window old (`WindowRespected`,
`reuse-too-young`), at most one bound old (`ReusedRecordWithinBound`,
`reuse-too-old`) and showing the swapout count of the sample under the lease
(`ReusedRecordSameSwapouts`, `reuse-changed-count`). `RecordsFromPassingSamples`
says every record written came from a passing host (`record-unchecked`). Three
more controls require that a start on a reused record is reachable
(`reuse-start-reachable`), that a start which found an unusable record and waited
is (`reuse-miss-start-reachable`), and that a host which failed and passed again
between the recorded sample and the sample under the lease is admitted on reuse
(`reuse-dip-start-reachable`): the same unseen dip, over a stretch as long as the
bound.

| Action | Meaning |
| --- | --- |
| `Tick` | the monotonic clock advances, up to the window |
| `Degrade` | memory, pressure, thermal state or disk headroom stops qualifying |
| `Recover` | the host qualifies again, at most once |
| `Swapout` | the host's swapout count grows |
| `OtherAcquire`, `OtherRelease` | another lifecycle operation of this home takes or returns the lease |
| `OtherStart` | a concurrent start, holding the lease, boots the pool |
| `OtherRecords` | another operation holding the lease (a stop, or another start) records a passing host sample for this Development home |
| `AgeRecord` | the record grows older: under one window, then usable, then past the bound (60 s by default, at most 600 s) |
| `ChangeTree`, `ChangeRoot` | a prepared tree or the root files change while this start does not hold the lease |
| `SquatAlias` | another entry takes the path of a clean stop's HOME alias |
