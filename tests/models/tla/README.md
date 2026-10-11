# Runtime state models

`native-persistent-enrollment/Enrollment.tla` follows the Rust
`provider::graph::native::persistent_data::enrollment` owner. Its finite domain is
one storage slot, absent/original/replacement volume identities and two independent
compute references. Pending publication, exclusive creation, captured original
birth, enrolled rename, final directory synchronization and failure are distinct
steps. Failure retains the intent or an uncertain enrolled pathname and loses the
original invocation's promotion ability; read-only reopen cannot create or promote.
An uncertain enrolled pathname may compare as data, but does not establish the
original operation's successful return or runtime effect authority.

| Model operation | Source boundary and qualification |
| --- | --- |
| `ReserveIntent` | Exclusive private slot/lock, `owner.json` pending write and file/parent sync precede `create_new`. Real filesystem sync-failure controls require create count zero. |
| `CreateOriginal` / `CaptureBirth` | Sealed transport requires exclusive original creation relative to supported writers and returns its captured identity directly to the invocation. The native adapter holds the continuously fenced common guest mutation lease through absence, one POST and owner commit; Docker's idempotent create alone is insufficient. Real lock-owner and stand-in controls target contention, lease loss and ambiguous creation; their presence is not a passing run. |
| `ReplaceVolume` / `PublishEnrollment` | Captured binding/birth/directory must equal fresh observations; root/lock/record/staged inode and bytes remain exact before rename. Copied-label replacement and post-effect file/lock/root controls refuse. |
| `ConfirmDirectorySync` / `CrashOrFailure` | Commit return follows enrolled rename and parent sync, then final guest/observation/files/deadline fences. Failed final sync returns uncertainty even if the enrolled pathname is visible. No reopen recovers an original-create capability. |
| `ReadRetained` / `RetireCompute` | Existing-only locked read never rewrites binding or stable identity when caller compute references change. Native receipt4 keeps data outside compute resources, and teardown has no data-delete effect. This unchanged model does not qualify the newly wired runtime or real SQL retention. |

The positive exploration exhausts 38 distinct states. Four guard-removal
controls must fail `NoExistingAdoption`, `OriginalBirthAtCommit`, `NoPendingMatch`
and `RetirementPreservesData` at their corresponding named action with the exact
same-state witness. Registry/checker contracts reject incomplete exploration and
unrelated failures. This model does not prove fsync/crash durability, real guest or
volume observations, atomic ownership against unsynchronized external writers,
transport cancellation, SQL contents/retention or NC05 application acceptance.
No fairness or eventual recovery is asserted.

The original 38-state model treats abstract volume identities as distinct; it
does not establish unique continuity from name/labels/birth/device/inode metadata.
`MetadataAliasing.tla` adds the explicit empty-replacement counterexample: actual
volume changes while the complete reported metadata tuple stays identical, and
metadata-only `ReadRetained` falsely matches. Its separate `metadata-alias`
negative control requires that exact same-state witness. The new control is
qualified as a negative counterexample; the historical 38-state result is not its qualification.
The root-witness guard assumes an already-enrolled original witness and abstracts
subsequent read-only verification; its original-seed helper/runtime and whole-root/xattr copying exclusion remain
separate from this finite model. Ordinary native persistent startup stays gated.

Run `bun run test:models` with Java 17 available and `TLA2TOOLS_JAR` pointing to
TLA+ 1.7.4's `tla2tools.jar`. The runner checks the SHA-256 before executing Java:

```text
936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
```

Official artifact:
https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar

`JAVA_BIN` may select an explicit Java executable. The runner does not install tools
or change global Java settings. CI's Runtime state models job supplies Java and the
pinned artifact. Each check has a 120-second timeout, 512 MiB Java heap, two workers
and bounded output; temporary TLC metadata is removed after success or failure.
No credentials or running VM are needed.

## Native foreground recovery lease takeover

`native-frontend-recovery/Recovery.tla` models the explicit saved-run frontend
recovery lease protocol. The positive configuration exhausts **602 distinct
states** (695 generated, maximum depth 22). It bounds one lease to two new candidates,
one crash, one immutable resource selection and one possible foreign-binding
substitution. Two initial states cover a fresh active recovery at release and a
dead selected owner awaiting takeover. The same protocol serves the primary and
mutation leases; this model checks one lease and assumes its enclosing required
guard is held. It does not establish the ordering of both leases together.

Reservation, promotion, issuance, current-owner binding, release intent, owner
unlink and directory removal are separate transitions. A pending selector records
the current candidate's exact identity but grants no active lease. Crashes clear
live authority while retaining committed selectors and release phases. Unknown
pending publication refuses, and expected absence needs the preexisting release
intent. Fresh release-publication failure retains its owner. Retry can continue
from a committed candidate before/after promotion or an owner-unlinked directory;
resource progress still requires actual issued authority and unchanged original
membership. Four unsafe controls remove reservation, release, active-authority or
binding checks. Five reachability controls require completion after the named
crashes, unknown-pending refusal and fresh-release retention.

| Model boundary | Implementation mapping and separate evidence |
| --- | --- |
| `ReserveCandidate` / `BindCandidate` | `createNativeComposePrivateMutationLock.withPreparedRecoveryLock` exclusively writes `owner.pending`, then the frontend `publishIntent` commits its exact inode/raw-byte selector before promotion. Reservation callbacks change only lease metadata. |
| `PromoteCandidate` / `IssueLease` / `BindIssuedLease` | The shared owner rechecks the current/candidate selectors before rename, issues its private active lease only afterward, and the frontend commits the current owner before resource phases can advance. |
| `AdvanceResources` | `recoverNativeAuthoredProject` requires both actual guards, strict original Ready/start/source selections and an authenticated native Removed receipt with null current observations. The three abstract steps are retirement intent, exact Ready unlink and completion; native resource cleanup and other frontend members are omitted. |
| `ArmRelease` / `RemoveOwner` / `RemoveDirectory` | Frontend primary and mutation release flags commit before the shared owner removes the exact owner and directory. `withFreshRecoveryLock` retains both on a failed durable release callback. |
| `Crash` / `RecoverSavedCandidate` / `ReadmitOwner` | The finite child tests SIGKILL the retained child before promotion, after promotion and after owner unlink, then use the same saved intent to retry without replaying cleanup. |
| `RefuseUnknown` / `ReplaceBinding` / `LoseAuthority` | Implementation controls refuse unbound pending publication, live candidate, same-byte/new-inode candidate replacement and revoked issued authority. The model summarizes those identity fields by one version rather than proving real inode/boot/process readers. |

Each committed durable write is one abstract action; partial writes, pending
intent refusal, fsync durability, hash/entropy/UTF-8 bounds, real filesystem
substitution, OS process identity, deadlines, callback rejection, signal delivery,
socket/guest boot proof and native environment retirement need separate source and
implementation checks. Hardlink archive interruption remains a retained refusal
and is omitted. No fairness, unlimited-crash recovery, provider effects, old-format
compatibility, data deletion or whole NC05 acceptance is claimed.

## Native storage witness enrollment and read-only resume

`native-storage-witness/Witness.tla` checks a proposed storage continuity protocol.
This maintained model is separate from the storage-witness owner, codec and
required version-three generation-receipt foundation. It does not qualify those
implementations or their future engine carrier and CLI activation. The positive configuration exhausts **352 distinct
states** (550 generated, maximum depth 18), with four initial states: absent
storage, or untracked existing storage with a missing, matching or wrong marker.
Existing untracked storage requires explicit adoption; matching bytes alone do
not silently enroll it.

An exclusive enrollment slot is published before the immutable `Expected` record;
a crash between them leaves a retained empty slot that refuses ordinary retry.
The expectation is durably published before creation or seeding.
Only its original live opaque capability may arm the seed once; arming consumes
that capability before the effect can await. Creation, marker publication,
observation and enrolled-record completion are separate crash boundaries. The
completion step rechecks both the observed proof and the current exact witness.
A crash revokes initial seed and completion authority while retaining published
records. Reopening an interrupted `Expected` refuses even if the marker now
matches: it preserves the anchor and reports a need for explicit reconciliation.
That future reconciliation contract is not modeled as automatic promotion.

After successful enrollment, down/up and recovery use the saved expectation and
read-only witness comparison. Neither operation can seed or append another
enrollment. Workload admission requires the enrolled reference, matching marker,
matching resource binding and current mutation authority. `EmptyReplacement`
keeps metadata unchanged while removing the marker, representing a replacement
whose physical name, labels and reported birth cannot distinguish it. A copied
matching marker with foreign resource metadata also refuses.

Eight unsafe controls remove one obligation each: seed-only-initial authority for
resume and recovery; missing, wrong or foreign-binding witness admission;
completion after exact proof; immutable expectation; and read-only enrollment.
Ten safe-path controls deliberately violate reachability predicates: cold
creation, down/up without reseeding, enrolled recovery without reseeding,
interrupted slot publication, enrollment with missing or matching marker,
missing/wrong marker resume refusal, stale proof refusal and untracked legacy refusal. The interrupted
missing-marker witness requires an already-created volume, so it cannot pass only
through a pre-effect crash. All controls require TLC exit 12, the intended
invariant and complete action/field evidence in one state. Parser errors,
arbitrary failure, split-state evidence and an incomplete positive exploration
fail the runner.

| Model action/state | Intended foundation mapping and separate implementation obligation |
| --- | --- |
| `ReserveIntent` / `intent` | `prepareNativeComposeStorageWitness` first calls `armNativeComposeStorageWitnessIntent` to publish a required v3 `Expected` entry under the existing generation mutation, then exclusively creates and synchronizes the private per-volume slot before writing the expectation. An empty or absent interrupted slot retains the receipt intent and cannot be recreated. The model's slot intent abstracts that refusal; it does not model the enclosing generation receipt. |
| `PublishExpected` / `expected` | `prepareNativeComposeStorageWitness` validates active pending-generation authority, exclusively publishes/syncs an immutable random 32-byte expectation and exact engine/instance/owner/physical-volume/logical-volume/generation/pending binding, then returns an opaque live capability. Its explicit `prepareNativeComposeStorageXattrWitness` path additionally requires captured artifact pins and a distinct version-three directory-xattr expectation; the v3 intent requires the carrier tag, artifact and private journal token before slot creation. Initial xattr creation uses the generation owner's separate `storage-create` phase: startup or the original empty cold run only, never general run material effects or recovered seed authority. The model abstracts that original cold capability without distinguishing the CLI operation. A failed publication must not grant a capability. |
| `ArmSeed` / `PublishMarker` | `enrollNativeComposeStorageWitness` consumes the original capability before awaiting its single seed callback. The explicit xattr path instead permits one captured cold-provision callback and one seed invocation, then separate read-only proof. `runNativeComposeStorageXattrHelper` requests `XATTR_CREATE` once through syscall ports, without retry/repair. Actual cold newness, non-creating current-root transport, child ownership/reaping, Linux ABI and kernel durability remain unqualified. `CreateVolume` is an abstract boundary, not evidence that this source creates Docker volumes. |
| `ObserveEnrollment` / `CommitEnrollment` | The owner verifies the distinct archive or xattr result, exclusively publishes/syncs/re-reads the completion file, and rechecks owner/expectation anchors. The xattr path binds exact artifact/context/volume/root and canonical kernel response hash; fresh root discovery, token read and post-read root discovery are separate injectable invocations. It issues a private one-use proof bound to the exact live authority and generation; `publishNativeComposeStorageWitnessEnrollment` consumes only that issued proof and obtains its reference and fresh verifier from the owner. The receipt protocol verifies again before attaching `Enrolled` and rechecks live authority after the final filesystem await before publication. The model's current exact witness predicate is stronger than finite observations across real engine awaits; that remains a separate transport obligation. Its completion is the enrollment record, not a generation's ready receipt. |
| `Down` / `BeginResume` / `ReadWitness` | `verifyNativeComposeStorageWitness` validates the saved reference, anchored files/directories, fresh observation and exact archive or xattr value, then re-reads and rechecks ownership without writing storage. Xattr verification publishes/synchronizes private finite helper intent while keeping the volume read-only; it never provisions, seeds or reenrolls, and brackets each fresh invocation with exact daemon/birth/current-Mountpoint/holder and authority checks. The receipt protocol requires read-only storage proof before/after startup/run and at both completion receipt boundaries. The CLI refuses witness-bearing startup/run/exec; actual down/up activation remains unqualified. |
| `Crash` / `Recover` / `RecoveryDisposition` | Persisted `Expected` without confirmed completion retains its original bytes and refuses inspection-to-enrollment promotion. Reopened records cannot recover an original seed capability. Required finite xattr carrier intent also survives unknown outcomes after enrollment; saved checks block replay and retirement, including unpublished helper IDs. Explicit saved `down --recover` can stop engine resources but returns incomplete with unresolved intent and pending generation retained, skipping dependent ownership retirement. An explicit read-only reconciliation interface requires its own source review and tests; neither this model nor the foundation implements it. The model does not represent finite helper intent/publication/cleanup. |
| `EmptyReplacement` / `WrongMarker` / `ForeignMetadata` | Owner/codec controls distinguish absent/wrong bytes, fresh foreign binding and same-metadata empty replacement. Xattr owner controls also refuse an old pinned-root result and same-birth root exchange during final proof. `encodeNativeComposeStorageWitnessArchive` and the tagged xattr codec are distinct; byte decoding, namespace transport and read-only engine behavior are outside this model. A copied matching witness with otherwise identical metadata is outside the empty-replacement guarantee. |
| `DriftAuthority` | Existing opaque generation authority must reject changed pending selection or revoked lease before seed/completion, and recheck after asynchronous proofs. The model summarizes those identities by one version; it cannot qualify real lease/token/inode checks. |
| `ReplaceExpectation` / `ReenrollReadOnly` | Immutable anchored records must reject replacement and read-only reopen must not append enrollment, even with matching marker bytes. Filesystem substitution and exact write counts require separate source regressions. |

The finite bound has one volume, one crash, one down/up, two binding versions and
two distinguishable nonempty markers; marker `1` abstracts expected random bytes,
`0` absence and `2` wrong bytes. A single storage fault can occur before completion
or subsequent workload admission, including between observation and completion.
It is not an active watcher for corruption after a workload has started. Each
durable publication is modeled as one completed write; partial writes, fsync
durability, generation receipt decoding/publication, archive bytes/limits, entropy, secrecy, filesystem symlinks/inode reuse,
malicious same-user replacement, multiple-volume concurrency, repeated crashes,
real resource creation and child effects are omitted. Current resource and owner
proofs are abstract predicates; arbitrary concurrent engine changes and atomicity
between an actual carrier read and workload launch require separate qualification.
Explicit authorized legacy adoption is not modeled. No fairness, eventual
recovery, data-payload integrity, legacy historical continuity, command activation
or whole NC03 completion is claimed.

## Native file-material retirement

`native-file-material/Material.tla` checks the private file retirement protocol.
The filesystem owner and bounded acquisition are wired into the experimental
ordinary Compose command path. Source CLI controls use the real compiler, file,
generation and process owners with strict read-only Docker stand-ins; actual
compiled engine delivery remains a separate qualification. The model
starts after one uncertain startup has durably published its generation/reference
and two immutable material members. Generation completion, retirement intent,
each member unlink and the final retired marker are separate steps. One crash can
occur between any two effect or commit steps. Hook uncertainty, child uncertainty
and source availability give eight initial states. The positive configuration
explores **8,388 distinct states** (27,724 generated, maximum depth 21), including
durable stop arming, original-attempt reaping and unknown stop retention after a
crash. A subsequent stop never changes that unknown child into a reaped child.

Nine guard-removal controls distinguish the protocol obligations: retain the
pending generation until all material retires; require owned-container absence,
known hooks and known startup/stop children before deletion; refuse substituted saved anchors;
recheck ownership and pending intent after the finalizer; and refuse missing live
material without a previously recorded retirement intent. Two further controls
deliberately violate reachability predicates at safe completion: one after a crash
between member deletions, the other with unavailable authored source. These are
required counterexamples, so the positive model cannot pass by disabling cleanup
or requiring a fresh source to perform saved stop recovery. Each negative requires
TLC exit 12, its named invariant and complete witness in the same state.

| Model action | Implementation boundary |
| --- | --- |
| `Recover` / `StopContainers` | The generation mutation owner retains the exact saved pending/current generation and stops owned resources. `retireNativeComposeSavedFiles` rereads the immutable private document; saved stop does not acquire authored files or decrypt values. |
| `ArmStop` / `ReapStop` | `prepareNativeComposeSavedFileStop` appends/syncs `stop-armed` on every exact retained reference before Compose. `runNativeComposeOwnedFileChild` rechecks cancellation, deadline and ownership after arming; a synchronous normal/terminal spawn fence prevents delayed launch. The original live opaque stop attempt alone may record `stop-reaped`; actual child natural exit and owned-group absence are separate from resource absence. An older unknown stop returns no new completion capability and continues to veto retirement. |
| `BeginRetirement` | `native-compose-file-owner.ts` validates all immutable members before appending and syncing a retirement intent to its fixed-inode private journal. Missing material before intent refuses. |
| `DeleteMember` / `MarkRetired` | `retireMembers` checks the live generation authority, root/manifest/journal anchors, callback-provided owned-container absence and exact member identities. Every unlink has a separate directory sync; the final retired record is synced separately. |
| `ResumeRetired` | Saved recovery selects the exact private generated extension and validates its immutable root, snapshot, manifest and journal inode. Existing retirement intent permits missing original members; replacements refuse. No orphan discovery or material recreation occurs. |
| `CommitStop` | `native-compose-generation.ts` provides `beforeComplete` followed by fresh generation, ownership and pending checks. The command callback retires old file snapshots before completion and rechecks the saved engine during final ownership checks. The source CLI drift control changes the engine only after the retired marker and verifies retained pending/retry. |
| `DriftAnchor` / `DriftOwner` / `DriftPending` | Independent substitution during an await must cause refusal, including after retirement and before the generation receipt commits. |

The model summarizes exact root, receipt, lease, token and device/inode identities
by version 1; version 2 is a substitution that the saved reference cannot adopt.
It treats persisted writes and individual unlinks as atomic, and summarizes fresh
whole-owner container absence as one boolean. It does not model acquisition,
source descriptors, fsync durability, byte bounds, binary/empty material, encryption,
actual inode reuse, mode/UID/GID, Docker mount projection, arbitrary simultaneous
external container creation, replacement of a live generation, repeated crashes,
or uncertain-child containment. Stop-child proof callback internals and real process
identity checks remain outside this finite model. Pre-stage ancestor-bind confidentiality
and literal mount overlap observations also remain implementation obligations outside
the modeled deletion predicate. No fairness or eventual cleanup is asserted.
`tests/native-compose-material-authority.test.ts` covers copied identity, lock/receipt
substitution, lease revocation and awaited escaped work.
`tests/native-compose-file-sources.test.ts` exercises actual compiler planning,
binary/empty acquisition, the existing managed encryption owner, tombstones,
overlay scope, linked worktrees and source drift.
`tests/native-compose-file-command.test.ts` uses the real source CLI and strict
Docker stand-ins to cover exact bytes/modes, missing managed key, before-hook file
creation, source-free stop, replacement, unknown startup/stop children, hook crash
and post-retirement engine, member and mount drift. Preexisting ancestor binds must
refuse before any member staging; late drift must reach the retired marker and
preserve pending. These controls do not qualify actual Docker binds.
`tests/native-compose-file-owner.test.ts` covers exact bind projection, missing or
replaced members, partial unlink interruption, source-free retry, replacement
handoff, uncertain hooks, unknown startup children and post-finalizer ownership
drift. The owner records reaping only through the original live armed attempt;
container absence does not create missing child-completion evidence. Cancellation
from the final startup/stop arm keeps the exact pending reference and spawns no child.

These filesystem regressions and injected proof callbacks do not qualify a real
engine, arbitrary unsynchronized external writers, crash durability on every
filesystem, or whole NC03 acceptance. The model omits acquisition, unarmed rollback
and creation of the reaped record; source tests cover those separate boundaries.
The compiled synthetic engine fixture and frontend source review remain required.

## Native Compose routing stop recovery

`native-route-stop/Stop.tla` checks the generation receipt and hostname claims as
two separate durable stores. It starts with one uncertain routed startup, with
either a known or uncertain host-hook outcome. Stopping owned containers, Caddy
route convergence, observation, claim exclusion, claim retirement and generation
completion are separate actions. One crash can occur between any two effect or
commit steps; explicit retry retains the same saved generation and route reference.
The positive configuration explores **202 distinct states** (338 generated,
maximum depth 16), including completion after claim retirement and a crash between
those commits. No fairness or eventual cleanup is asserted.

The main negative control removes only the completion-order guard. It reproduces
the lost-recovery failure: `CommitStop` clears the pending generation while
`claimHeld = TRUE`, even though the owned workload is absent. Three further
controls remove the absence, exact-reference or hook-completion guard and require
`NoUnprovedRelease` to fail in the same `RetireClaims` state. The
`completion-reachable` control instead asserts `NeverComplete` and must fail at a
safe `CommitStop`; the positive model does not pass by disabling all recovery.
Every control requires TLC exit 12, its named invariant and complete same-state
witness. Parse errors, timeouts and partial exploration are failures.

| Model action | Implementation boundary under `src/lib/` |
| --- | --- |
| `Recover` / `StopWorkload` | `native-compose-generation.ts` mutation/recovery owner writes pending `down` before the command removes exact owned containers and networks. Persistent volumes remain. |
| `ConvergeProxy` / `Observe` | `native-compose-route-owner.ts` independently verifies whole-owner container absence, exact ingress and active proxy route absence. Container absence alone is insufficient. |
| `ReplaceReference` / `AcquireClaims` | `native-compose-route-claims.ts` validates anchored journals under the cooperative claim lock; selection before exclusion cannot authorize a replaced reference. |
| `RetireClaims` | Explicit verified stop recovery retires retained/armed attempts only after fresh absence proof and revalidation. It cannot grant live completion or clear unknown host-hook effects. |
| `CommitStop` | `native-compose-command.ts` invokes route retirement in `beforeComplete`; `native-compose-generation.ts` rechecks generation, engine ownership and pending intent before the completed receipt. |
| `Crash` | Durable generation/reference survive, while process locks do not; retry does not replay startup or infer completion from a missing process. |

Claim retirement is one aggregate modeled step; interrupted per-host journal
writes and unlinks require the separate implementation crash/retry regressions.
The abstraction treats durable writes as atomic and summarizes exact engine,
proxy, resource and filesystem identities by one reference version. Cooperative
exclusion prevents version replacement after claim admission. The modeled
pre-lock substitution is a refusal control. Arbitrary external Docker writers,
same-user filesystem replacement, actual fsync/inode checks, journal parsing,
PID reuse, boot changes, repeated unbounded crashes, actual TLS, data continuity
and the cleanup of a pre-fix already-lost receipt are outside this model.
Implementation regressions and the registered `native-config-routing` Docker
scenario supply separate evidence. The model does not prove those checks,
browser access, performance or whole NC03 completion.

## Projects registry writer ownership

`registry-writer/RegistryWriter.tla` models two one-shot writers, two independent
reclaimers, immutable receipt identities, writer/reclaimer crashes, and conservative
PID-reuse refusal. The positive configuration exhausts **7,721 distinct states**
(24,575 generated, maximum depth 21). It checks type safety, mutual exclusion and
that every live writer retains its published lock until its own release. TLC action
coverage includes 232 enabled `Reap` transitions, 1,290 `Release` transitions and
3,930 `CrashRecovery` transitions; the safety checks do not pass by excluding recovery
or crashes. No fairness or eventual recovery is asserted.

The negative control removes only the recovery guard. It must exit 12 and violate
`NoLiveOwnershipLoss` in a single `Reap` state with `unsafeReap = TRUE`, `lock = 0`
and `guard = 0`. `unsafeReap` means that the unlink removed a live receipt different
from the receipt previously checked by that reclaimer. The counterexample is:
publish writer 1; writer 1 dies; both reclaimers independently inspect and validate
receipt 1; one unlinks it; writer 2 publishes; the second unlinks writer 2's receipt.
Which symmetric writer/reclaimer acts first is immaterial. A parse error, arbitrary
nonzero exit, different invariant or witness split across states is not success.

| Model action/state | `src/lib/projects-registry-lock.ts` boundary |
| --- | --- |
| `Prepare` / `Publish` | `withProjectsRegistryLock` finishes the private owner receipt; `publish` uses exclusive hardlink creation. Receipt completion and publication are separate; an empty shared owner is never a modeled state. |
| `InspectRelease` / `Release` | `releaseIfOwned` validates exact receipt identity/bytes before unlink. The model separates inspection from unlink instead of assuming an atomic compare-and-unlink. |
| `ObserveBeforeGuard` / `AcquireGuard` | `recoverDeadOwner` may cheaply inspect before exclusive `mkdir` of the recovery guard; this prior observation never authorizes removal. The model permits even irrelevant preliminary observations, a conservative superset of the implementation. |
| `Observe` / `CheckReceipt` / `Reap` | Fresh receipt/death inspection and identity revalidation under the guard, followed by a separate path unlink. No other cooperative reclaimer can remove/rebind the selected dead receipt between those steps. |
| `FinishRecovery` | Remove only this invocation's recovery guard. Another writer may publish once the dead receipt is removed, including before guard retirement. |
| `CrashWriter` / `ReusePid` | Process exit preserves a published receipt; only modeled ESRCH permits recovery. An occupied/reused PID conservatively refuses, even when the old writer really died. |
| `CrashRecovery` | An interrupted reclaimer leaves its non-reclaiming guard. Offline inspection can be required; automatically stealing that guard is not modeled or authorized. |

The finite model treats each receipt as a unique identity and each exclusive link,
mkdir or unlink as one filesystem operation. It does **not** make a multi-operation
inspection/removal sequence atomic. It assumes cooperating new-protocol writers in
a private local directory; legacy v4 writers with age-based reclamation and arbitrary
same-user path replacement violate those assumptions. It omits actual device/inode
reuse, hardlink counts, permissions, symlinks, byte parsing, disk durability, registry
content, process-probe errors, signals, elapsed-time bounds and repeated/unbounded
restarts. Missing or inaccessible process information is never abstracted as death.
Receipt preparation can fail or be cancelled without publication; publication errors,
descriptor cleanup and cancellation during I/O require implementation tests.

Process-based registry tests must connect the counterexample to overlapping
reclaimers and a live successor, prove old live receipts are retained, and exercise
dead-owner, malformed-owner, symlink and release-identity refusal. The abstract pass
does not prove the implementation, mixed-version safety, performance or application
acceptance. Logs and TLC metadata belong in ignored run directories, not this tree.

## Missing post-reboot publications

`absent-publication-recovery/Absent.tla` checks one explicitly selected cleanup
racing one foreground publisher. The positive configuration explores 247 distinct
states, including one recovery-process crash, two non-volume cleanup effects and
one input-version change. Both participants acquire the foreground lock before the
Engine lease. Ordinary publication occurs under the foreground lock before Engine
admission, matching the implementation. The durable absence intent survives a
crash; a restart cannot publish until cleanup and separate absence retirement are
confirmed. A changed selection
cannot resume cleanup. Completion and retirement are separate steps, so a crash
between them remains visible.

Four guard-removal controls require TLC exit 12 and a named same-state witness:

| Control | Required failure |
| --- | --- |
| `negative` | `NoPrematurePublication` in `Publish`, with a durable intent, incomplete cleanup, no retirement and a newly published owner |
| `unwitnessed-cleanup` | `NoUnwitnessedCleanup` in `CleanupOne`, with both locks held but no intent |
| `stale-selection` | `NoUnwitnessedCleanup` in `CleanupOne`, with a durable intent but selected version 1 and current version 2 |
| `unconfirmed-retirement` | `NoUnconfirmedRetirement` in `RetireAbsentPublisher`, before cleanup or intent |

| Model action | Implementation boundary under `packages/runtime-core/src/provider/` |
| --- | --- |
| `AcquireRecoveryForeground` / `AcquireRecoveryEngine` | `graph/absent_publication_cleanup.rs`: deterministic lock-only reservation before the Engine lease; matches foreground startup's lock order |
| `WriteIntent` | Private durable run-scoped absence intent before any cleanup effects |
| `CleanupOne` / `CommitCleanup` | Exact selected, data-retaining `cleanup_owned(..., false)` and stopped receipt confirmation; tagged absent bridge authority remains distinct from pinned predecessors |
| `RetireAbsentPublisher` | Separate durable absent-publication retirement proof tied to completed cleanup |
| `AcquirePublisherForeground` / `AcquirePublisherEngine` / `Publish` | `graph/foreground/transport.rs` admission barrier plus `graph/foreground.rs` Engine acquisition; explicit retired binding needs completed proof |
| `CrashRecovery` / `ChangeInputs` | Retained intent and exact retry; reinspection refuses changed host/guest boot, input bytes or resources |

The model assumes validated legacy inputs, absent roots and resource observations
are summarized by one version. It represents cooperating writers under two kernel
locks and durable writes as atomic commits. It does not prove filesystem fsync,
FD/path identity, raw hashes, PID reuse, private permissions, actual guest or
physical host reboot, bridge cleanup, volume preservation, source-device migration,
later restore generations, browser readiness or performance. Concrete refusal,
interruption and data-marker tests remain required. The recorded old Owner is
legacy corroboration, never a reconstructed foreground Pin or proof of original
physical-volume continuity. No fairness or eventual recovery claim is made.

## Shared HTTPS lifetime

`shared-https-lifetime/SharedHttps.tla` checks the last-lease release racing
with a second application's acquisition. A socket disconnect preserves the lease;
release requires a separate graph-cleanup observation. Closing admission and
finishing shutdown are separate actions so the model exposes that interleaving.
An owner crash retains ownership and permits no automatic adoption.

| Model action | TypeScript boundary under `src/backends/` |
| --- | --- |
| `Acquire` | `native-https-owner-server.ts`: serialized acquisition after exact pool/graph checks and durable lease publication |
| `Disconnect` | Socket closure retains the lease; connection lifetime alone cannot justify retirement |
| `CleanupProof` / `Release` | Independent stopped/removed graph, resource, bridge and hostname checks precede lease retirement; `native-project-recovery.ts` selects the complete recorded lease identity |
| `BeginClose` / `FinishClose` | Last release closes admission before awaiting frontend shutdown; queued acquisitions cannot reopen the closing owner |
| `OwnerCrash` | Retained owner state refuses automatic reuse; absence of a process or socket is not child-cleanup proof |

The positive control explores 64 states, checking lease preservation and no shutdown with a live lease.
The negative control admits the second application during closing and must violate
`NoPrematureShutdown` in a `FinishClose` state with `mode = "closed"`,
`leases = {2}` and `unsafeShutdown = TRUE`. Parser errors or an arbitrary nonzero
exit are not that witness.

This finite safety model has two applications and one helper generation. Cleanup
observations and lease publication are abstract atomic steps; the model does not
prove filesystem durability, authentication, lost-response recovery, executable
identity, descriptor inheritance, child containment or real Caddy behavior. It
does not establish eventual recovery or resource/performance improvements. The
shared-owner process tests and startup/finalization/recovery regressions provide
separate implementation evidence; native multi-application acceptance remains
required before claiming complete concurrent application support.

## Previous-boot shared HTTPS archival

`previous-boot-shared-https/ArchiveHttps.tla` checks one explicit recovery racing
another application's owner startup. It models the owner directory and control
socket as separate atomic renames in either order. Native archival moves the
socket first; the owner-first interleaving is an additional barrier control.
The admission barrier survives one recovery
crash while the provider cleanup lease does not; resume reacquires that lease and
rechecks the exact selection before another move. Startup can observe an absent
owner directory between the two moves, so retaining admission is essential.

The positive configuration explores 92 distinct states from two initial inputs
(eligible or refused), with one crash/resume and one input-generation change.
Original artifacts remain in exactly one original or archived location. Completed
archival and explicit frontend finalization are separate facts. Another
application may create the next owner after archival commits; the selected
application must still finish its own exact frontend recovery.

Three guard-removal controls require TLC exit 12, the named invariant, and one
complete same-state witness. Each accepted archive set follows the model action;
the oracle rejects fields split across states.

| Control | Required failure |
| --- | --- |
| `negative` | `NoPrematurePublication` in `Publish`, after recovery crashes with incomplete archival and owner already archived; socket may still be original or also archived |
| `stale-selection` | `NoUnprovedArchive` in `ArchiveOwner` or `ArchiveSocket`, with selected generation 1 and current generation 2; the action's artifact must be archived |
| `unproved-archive` | `NoUnprovedArchive` in `ArchiveOwner` or `ArchiveSocket`, with an ineligible selection despite held locks and a recorded intent; the action's artifact must be archived |

`Publish` never accepts an empty or socket-only archive set. The archive controls
accept only the action's artifact alone or both artifacts, preserving the exact
selected-proof and unsafe-effect fields. These are scheduling alternatives in the
unchanged model, not weaker invariants.

| Model action | Implementation boundary |
| --- | --- |
| `AcquireAdmission` / `AcquireEngine` | Explicit previous-boot shared-owner recovery takes shared HTTPS admission before native provider/graph cleanup exclusion |
| `Prepare` / `eligible` / `selected` | Exact current completed dead-owner cleanup, retired publisher, immediate boot succession and unchanged owner/lease/socket/executable/data observations |
| `ArchiveOwner` / `ArchiveSocket` | Journaled no-signal, same-filesystem moves preserve selected owner/lease and socket inodes; each effect rechecks the selected state |
| `Crash` / `Resume` / `ChangeInputs` | Durable admission barrier and intent survive interruption; exact dead recovery ownership and unchanged inputs are required to resume |
| `Commit` / `Finalize` | Completed archive proof remains distinct from ordinary lease-release acknowledgement; explicit v3 frontend recovery consumes only its exact selected proof |
| `AcquireStartup` / `Publish` | Normal shared-owner admission prevents a new owner during incomplete archival |

Validated graph, process, filesystem and boot observations are summarized by one
eligibility flag and input version. Admission identity and recovery-process death
are assumed validated before resume. Cooperating provider writers cannot change
the selection under the provider lease; legacy startup must separately remain
quiescent. Atomic renames and durable intent/completion writes are abstractions,
not fsync proofs. The native implementation is in
`packages/runtime-core/src/provider/shared_https_recovery.rs`; explicit v3
frontend selection is in `src/backends/native-project-recovery.ts` and
`src/backends/native-https-owner.ts`. This model covers the present-socket path
with two moves. The both-absent socket/parent variant has one owner move and
requires separate concrete absence, process and port regression controls.
The implementation also refuses completed replay while a newer shared owner is
active; the model's post-commit startup interleaving is a safety bound, not proof
that this interrupted frontend can finish without first restoring quiescence.
This model does not establish executable absence, PID reuse,
socket/FD identity, permissions, hash integrity, physical reboot, retained volume
continuity, multiple-lease recovery, browser readiness or performance. Concrete
refusal, interrupted-archive, process/socket and native application checks remain
required. No fairness or eventual recovery claim is made.

## Missing publication lock retirement

`missing-publication-lock/MissingLock.tla` models one explicitly selected repair of
a missing `operation.lock`, one ordinary consumer, and one retired-publication
consumer. The positive configuration explores **96 distinct states** from two
eligibility inputs. The durable stages are intent, private temp marker, flock,
exclusive hard link, temp unlink, standard retirement journal, socket archive,
owner archive, and completion. One repair crash releases the held locks but keeps
all committed evidence. The model rechecks the selected proof and replacement lock
before each archive move and completion. Neither consumer can enter after both
original paths are gone until the exact completion is durable. The
`completion-reachable` control intentionally violates `NeverComplete` in `Commit`
with the selected replacement lock and no unsafe effect; it proves a finite
completion path exists, not eventual recovery.

| Guard-removal control | Required same-state TLC failure |
| --- | --- |
| `negative` | `NoPrematureConsumer` in `AdmitOrdinary`: archived originals, crashed repair, incomplete intent, ordinary consumer admitted |
| `retired-admission` | `NoPrematureConsumer` in `AdmitRetired` at the same incomplete stage |
| `stale-proof` | `NoUnprovedCompletion` in `Commit` with selected version 1, current version 2 |
| `replaced-lock` | `NoUnprovedCompletion` in `Commit` with a foreign lock path after crash |
| `old-holder` | `NoUncoordinatedLegacy` in `OldHolderPublish` with the gate held at any durable incomplete repair stage from intent through owner archive |

| Model action | Runtime boundary under `packages/runtime-core/src/provider/graph/` |
| --- | --- |
| `Begin` / `WriteIntent` | `acknowledged_publisher/missing_lock.rs::retire` takes the pool publication gate, validates current acknowledged cleanup and exact selection, then writes immutable intent before any lock-path effect |
| `CreateTemp` / `AcquireTemp` / `LinkLock` / `RemoveTemp` / `AcquireReplacement` | `missing_lock.rs::replacement_lock` fsyncs a private marker, holds flock, links it exclusively to `operation.lock`, removes only its exact temp name, and resumes exact partial states |
| `StartJournal` / `ArchiveSocket` / `ArchiveOwner` | `foreground/transport.rs::retire_recovered_publisher_locked_fenced` uses its durable journal and exact effect fence, moving the selected socket before owner receipt |
| `Commit` | `missing_lock.rs::retire` writes completion bound to the intent, retirement journal and replacement lock; `require_no_pending_root` checks the archived identities before consumers proceed |
| `AdmitOrdinary` / `AdmitRetired` | `foreground/transport.rs` and `acknowledged_publisher/missing_lock.rs::require_no_pending_root` refuse incomplete repair for both entry paths |
| `Crash` / `Resume` / `ChangeInputs` / `ReplacePath` | Exact intent, marker and journal retry refuses stale selection or a foreign lock; no ambiguous artifact is deleted to force progress |

The positive protocol assumes an externally enforced maintenance window excludes
pre-gate binaries. The `old-holder` counterexample shows why the new gate alone
cannot exclude a process holding the old unlinked lock inode. The checker accepts
only those explicit incomplete stages in the same `OldHolderPublish` state; TLC may
reach any one first. Each TLA stage is an
abstract durable commit; the model does not prove fsync order, pathname and FD
identity, raw SHA checks, kernel flock behavior, process death, actual graph or
volume preservation, or multi-crash liveness. No fairness is asserted. Native
fault, refusal and exact-retry tests and an observed retained-graph run remain
separate evidence.

This model covers the foreground publication. It does not model the companion
relay-control publication or the CLI's relay construction before foreground
admission. Their acknowledgement-bound retirement, partial-unlink retries and
pre-publication admission checks require implementation regressions and native
restart/data-readback evidence; a `MissingLock` pass does not establish those
properties.

## Active dependency rebinding

`dependency-rebind/Rebind.tla` checks one physical slot shared by two logical
bindings, with old and replacement generations. The unchanged all-running control
explores 21 states. A mixed running/completed control explores 19: the terminal
target must have declared `Completed` readiness and an observed successful exit.
Both targets' old grants and streams retire, but only the running target receives
a replacement grant/helper. The completed service retains its generation/StartedAt;
a shared slot's endpoint generation may change without readmitting that service.
The wholly completed control explores 18 states and ends with original target
admission closed after retirement, without a replacement grant. A terminal-only
slot may complete an empty fence for a later one-off; its old targets stay revoked.

The barrier requires reviewed ownership, fenced target admission, retirement and
stream drain for all historical bindings, replacement readiness for running targets,
and durable receipt commit before activation. Cancellation or owner death leaves
admission closed. A fence here means closed target authority, not necessarily a
closed physical host socket or a concrete `SlotFence` token for terminal-only slots.
The implementation can still accept a bounded unauthenticated preamble.

Two refusal controls each explore exactly two states (initial and owner crash):
an unexpected exit under Started/Healthy readiness and a failed Completed job
cannot pass review. Guard-removal controls must exit with TLC code 12 and violate
`NoWrongTerminalReadiness` in one `Review` state containing `completed = {2}`,
`reviewed = TRUE` and `admitted = FALSE`. The original premature-release control
still violates `NoEarlyAdmission` in one `Release` state with old streams present,
unrevoked targets and no committed replacement. CI rejects other failures.

| Model action | Implementation boundary under `packages/runtime-core/src/` |
| --- | --- |
| `Review` / `completed` | `provider/graph/startup/runtime/rebind.rs` executable, exclusive listener and supervisor checks; exact stopped exit-0 identity with declared Completed readiness; `RebindJournal.completed_services` |
| `Fence` / `Retire` | `provider/relay_owner/managed.rs` slot admission fence, batch revocation and stream drain |
| `Register` | Fresh grants and exact owned guest helper replacement for running services only in `provider/graph/startup/runtime/rebind.rs` |
| `Commit` / `Release` | Synced receipt and committed nonterminal journal before atomic `ManagedOwner::complete_rebinds`; completed terminal journal follows activation |
| `CloseTerminal` | Scoped retirement of all terminal services' historical bindings and empty-fence completion, without terminal replacement grants/helpers; `Phase::Completed` retains service generation/StartedAt with `binding.process = None` |
| `Cancel` / `Crash` | Fenced incomplete journal and explicit owned cleanup; no replay |

The model abstracts individual registration steps for two bindings and assumes
atomic revocation/drain and durable commit. Successful terminal observations remain
fixed during this finite operation; source must recheck exact container Id, image,
StartedAt, exited status, zero PID/exit code, and false Dead/OOM before effects and
commit. Completed services retire all their historical bindings across slots; one
binding per target represents that set here. Helper `None` is valid only for a
journaled Completed service with declared Completed readiness, never for Released
or an unjournaled terminal service. The model does not prove these inspection and
helper-identity checks, native process/supervisor identity, credential secrecy,
filesystem durability, partial multi-slot activation, real guest readiness,
application health, or performance. Rust tests and live replacement traffic remain
required. There is no fairness or eventual recovery claim.

`dependency-rebind/TerminalReuse.tla` separately checks a terminal-only slot's
reuse for one new one-off target. It preserves the established Rebind controls:
closed original-target authority does not imply that a later, distinct job can
never register. Five fixed Boolean observations represent exact original scope,
old generation, all historical targets retired, zero live authorities and no
unresolved lifecycle intent. The 32 possible initial combinations explore 82
states; unsafe combinations cannot initiate the prepared journal or new effects.
For the eligible case, a prepared journal precedes the empty fence, durable commit
precedes empty completion, and only then may one distinct target receive a grant.
No original terminal target receives a grant or helper. Cancellation/owner death
closes admission, retains prepared evidence and cannot replay this operation.

The negative control registers the new target while still fenced, before commit.
It must violate `NoPrematureNewGrant` in one `RegisterNew` state with `grants = {3}`,
`committed = FALSE`, `slotReady = FALSE` and `fenced = TRUE`. An arbitrary checker
failure or those fields spread across different states cannot satisfy the control.

| Terminal reuse action | Implementation boundary under `packages/runtime-core/src/` |
| --- | --- |
| `Review` / inputs | `provider/graph/startup/runtime/rebind.rs` reuses the original selector/context and exact old endpoint generation; terminal service/container checks remain required |
| `Prepare` / `BeginEmpty` | Prepared rebind journal precedes `ManagedOwner::begin_terminal_rebind`; it requires the same scope, retired targets, no live authority or unresolved lifecycle intent and pins the newly reviewed endpoint with expected count zero |
| `Commit` / `CompleteEmpty` | Receipt and committed journal precede atomic `ManagedOwner::complete_rebinds`; `JournalSlot.terminal_only` distinguishes an empty terminal fence from active helper replacement |
| `RegisterNew` | Original-scope ordinary registration for a unique one-off target; `register_replacement` remains forbidden on a terminal fence |
| `Cancel` / `Crash` | Abort, dropped token and reply loss retain a fenced uncertain operation, requiring owned cleanup rather than replay |

This is a second bounded safety abstraction, not a composition proof or a live
one-off test. The eligibility observations are fixed during the operation, and
target 3 assumes a uniquely derived fresh job identity. Native selector/process
checks, endpoint reinspection, real target uniqueness, durable writes, guest helper
behavior, repeated jobs, multiple slots and real one-off traffic remain separate
implementation and runtime gates. The existing Rebind model covers original-target
drain/revocation; this model checks the later commit-before-new-grant boundary.

## Stopped retained-pool startup

`stopped-pool-startup/Resume.tla` checks one explicit startup from shape-valid
stopped owner/retained receipt evidence. The positive control explores 71 states.
Offline preflight records owner and receipt generations without granting graph
authority. Either generation, or the retired-publication evidence, can change
before the provider mutation lease. The boot effect requires revalidated exact
selection and retirement under that lease. Cancellation observed before a new
effect refuses it; a successful reply still requires fresh live resource and
restore-selection proof before graph authority. Timeout/lost reply consumes the
one attempt and cannot cause automatic replay. `booted` means a confirmed reply;
its false value after timeout does not mean the VM remained stopped.

Removing the selection guard must fail `NoSubstitutedBoot` in one `Boot` state
with `attempts = 1`, `bootSelectionMatched = FALSE`, both selected generations
equal to 1, and `locked = TRUE`. Removing the no-replay guard must fail
`NoUncertainReplay` in one `Retry` state with `attempts = 2`, `uncertain = TRUE`,
`bootSelectionMatched = TRUE`, `authority = FALSE` and `locked = TRUE`. Both
controls require TLC exit 12, the named action and same-state witness; parser
errors or other nonzero exits do not qualify.

| Model action | Implementation boundary |
| --- | --- |
| `Preflight` | `provider/graph/retained_startup.rs::preflight` / `Guard::acquire` and `src/backends/native-project-retained-startup.ts`; exact durable Owner/Receipt digest and retired publication, explicitly `live_resources_verified = false` |
| `SubstituteOwner` / `SubstituteReceipt` / `LoseRetirement` | Changes between offline preflight and runtime-up; `Guard::verify` rechecks full evidence rather than trusting the response |
| `AcquireLease` / `Boot` | `provider/lifecycle.rs::up_with_retained_project_share` / `up_selected`; paired expected run/selection flags, provider mutation lease and retained guard verification before writes and immediately before `begin_boot`/start |
| `Cancel` / `RefuseCancelled` / `Timeout` | Startup's abort checks and single guarded runtime-up invocation in `src/backends/native-project-start.ts`; `native-runtime-client.ts` refuses an already-aborted spawn and reaps only its own child on active abort, returning an uncertain outcome without replay |
| `InspectLive` / `GrantGraph` | Post-boot `confirmedNativeRetainedGraph`, then `provider/graph/foreground.rs::restore_selection` and `provider/graph/restore.rs` generation verification before a fresh graph owner restores data |

Rust paths above are relative to `packages/runtime-core/src/`. Owner and receipt
each have two abstract versions and may be substituted once; these are pre-boot
inputs, not the owner bytes written by a successful boot. Relevant cooperating
mutations are excluded while the lease and retired-publication guard are held.
The model treats final revalidation plus boot effect as atomic: this requires the
implementation's guards across that boundary and does not prove filesystem race
resistance. Offline shape checks are assumed, and live proof is a trusted oracle
that includes the later restore-selection guard. Source/env/profile/AWS and disk
validation, actual lock/process identity, hashing, cancellation delivery, durable
writes, partial boot cleanup, multiple clients, later explicit user recovery,
volume integrity and live application behavior remain separate tests. `Cancel`
represents an observed abort check, not arbitrary OS signal delivery; cancellation
does not reverse an already-admitted boot. There is no fairness or eventual-start
claim, and a model pass is not native startup qualification.

## Graph admission

`graph-admission/Admission.tla` checks the smallest admission race: two clients
competing for one capacity unit. The positive configuration requires the lock
across capacity observation and reservation; the negative configuration removes it.
The positive run must explore all five expected distinct states. The negative run
must produce TLC's invariant-violation exit code, name the `Capacity` invariant and
show both clients occupying the unit. A syntax error, crash, timeout, wrong invariant
or arbitrary nonzero exit is not a successful negative control.

| Model element | Implementation boundary |
| --- | --- |
| `Check` | `provider/graph/admission.rs::check`, under the `OwnedGuest` provider lock |
| `Reserve` | durable preparing receipt and container allocation in graph run/restore |
| `used` | other graphs' retained compute reservations, including exited containers |
| `Retire` | ownership-verified graph cleanup completes before capacity is available |
| `owner` | provider mutation lease held through observation and allocation |
| `Capacity` | combined reservations cannot exceed the admitted capacity |

Paths above are relative to `packages/runtime-core/src/`. The abstraction represents
one capacity dimension; Rust regression tests cover actual CPU, memory and service
limits. It omits crashes, source-job coexistence, engine failures, route lifetime,
filesystem persistence and scheduling fairness. Passing it does not prove those
properties or that all callers hold the lock correctly. Keep the live two-graph
and over-budget controls and ordinary Rust tests as implementation evidence.

When changing admission semantics, review the model and mapping, rerun both controls,
and update expected exploration bounds only with an explanation. Preserve useful
counterexamples as ordinary regression tests. Add recovery and idle/wake models when
their state machines and concrete invariants are defined; do not expand this small
model merely to represent unrelated product behavior.

## Balloon reuse accounting

`balloon-reuse/BalloonReuse.tla` models one guest mapping's unmap, discard,
reuse-accounting restoration, remap, and terminal failure transitions. The positive
model explores seven states. Its invariant requires mapped guest memory to be
outside the host's reusable/discounted accounting state. The negative control omits
reuse accounting and must fail `MappedMemoryAccounted` with both `phase = "mapped"`
and `reusable = TRUE` in the same remap step. Fields appearing in different trace
states, another invariant, or a tool failure do not qualify the negative control.

| Model action | Provider boundary |
| --- | --- |
| `Unmap` | Successful `hv_vm_unmap` in libkrun `balloon_reclaim_range` |
| `Discard` | `MADV_FREE_REUSABLE`; both success and failure are represented |
| `Reuse` | Experimental correction: successful `MADV_FREE_REUSE` before remapping |
| `ReuseFailure` | Refuse a live mapping and stop on failed reuse accounting |
| `Remap` / `RemapFailure` | Successful `hv_vm_map`, or existing fatal remap failure |
| `Stop` | Abstract terminal shutdown of this mapping's owning process |

This is the intended contract for the **experimental correction**, not a claim that
Hack's currently pinned provider implements it. The pinned libkrun commit
`5de9ab51c1bb166af2324de3c9413d00022eb178` omits reuse advice in
`src/hvf/src/lib.rs::balloon_remap_if_reclaimed`. The native accounting control and
initial matched guest results are recorded in the
provider investigation (local `_docs/docs/plans/v5/balloon-guarded-pair-20260916.md`).

The model abstracts the serialized reclaim-map lock and one mapping. It omits PFN
sorting, overlapping ranges, mapping geometry, multiple vCPUs, real kernel return
codes, physical residency, persistent data, performance and process restart. A
passing model cannot replace native accounting, mapping-boundary or guest readback
tests, and must not turn an apparent footprint reduction into a RAM-savings claim.

## Restore history retention

`restore-history/RestoreHistory.tla` models publication of a bounded history window,
legacy retirement, process crashes and repeated capture/restore. Capacity 2 and
limit 6 explore 27 states, including more restores than history slots. The negative
control retires legacy history during preparation; it must violate
`HistoryPreserved` in a single `Prepare` state with both legacy and committed
manifest empty. The verifier rejects unrelated failures or split-state evidence.

| Model action/state | Implementation boundary |
| --- | --- |
| `Prepare` / `pending` | Deterministic replacement from committed history and the current receipt |
| `Publish` / `manifest` | Synced atomic `restore-history.json` publication |
| `Retire` / `legacy` | Witness-checked removal of legacy diagnostic files after publication |
| `Crash` | Pending-prefix recovery or resumption after a published manifest |
| `Restore` / `current` | Graph execution continues using current state, never a historical receipt |
| `HistoryPreserved` | The last committed bounded window remains available across transitions |

Implementation: `provider/graph/restore_history.rs`, relative to
`packages/runtime-core/src/`. Process-kill tests at pre-publication, publication
and retirement boundaries exercise the model's ordering; partial-prefix, foreign
content, symlink/hardlink and byte-budget tests cover filesystem details omitted
by the abstraction. The model does not prove fsync semantics, hash collision
resistance, malicious same-user races, byte limits, eventual progress under
unlimited crashes, engine behavior or persistent-volume correctness. Live migration
and repeated data readbacks remain separate acceptance gates.

## Organization and recovered runtime models

Each topic directory owns its source modules and finite `positive.cfg` /
`negative.cfg` controls. Broken modules are intentional negative controls, never
implementation alternatives. This follows the topic/module/config organization of
[the official TLA+ examples](https://github.com/tlaplus/Examples); the directory
name `tests/models/tla` is Hack's convention. Reusable authoring and artifact
handling instructions live in the repository's `hack-repo-tla` skill.

The runner copies sources to temporary scratch space before invoking TLC, then
removes sources and generated state on success or failure. Private originals and
review snapshots in `.hack-local` are historical evidence, not canonical sources.
Generated trace-validation wrappers were not promoted: the core models below do
not claim trace replay coverage. The three earlier model families above already
have canonical copies and were not duplicated.

| Topic | Positive distinct states | Contract and negative control | Implementation boundary under `packages/runtime-core/src/provider/` |
| --- | ---: | --- | --- |
| authority-snapshot | 11 | Deliver to the observed reservation or fail; reusing the frontend delivers generation 2 after observing 1 | `hostname_authority.rs`, `hostname_authority/managed.rs` routing ownership |
| authority-lifetime | 9 | Authority cannot outlive completed runtime shutdown; removing the startup lease permits a late bind | `hostname_authority.rs` startup lock and shutdown |
| publication-journal | 50 | Recovery cannot adopt a live writer's pending entry; unsafe recovery violates that condition | `publication.rs` journal recovery |
| publication | 16 | A live native publication retains its intent, directory and guest; early retirement breaks ownership | `publication.rs`, `publication_stage.rs` |
| fence-first | 24 | First recovery needs terminal prior state, no occupied slot, and complete evidence; ignoring occupancy fails | `graph/relay-fence.sh` initial recovery |
| fence-pending | 7 | Recover only permitted pending transitions; accepting launching-to-stopped leaves a live process | `graph/relay-fence.sh` pending recovery |
| relay-staging | 9 | Discarded preparation cannot contain a live child; discarding an authorized launch fails | `publication_stage.rs` and `graph/relay-fence.sh` launch ordering |
| relay-fence | 16 | Retired generations cannot launch again; removing the monotonic fence allows stale launch | `graph/relay-fence.sh` generation fencing |

These are small safety abstractions recovered from local investigations. Snapshot
uses two generations; relay fencing uses `Limit = 3`; journal counters stop at 4;
other models use finite phase/boolean sets. No fairness or eventual-progress claim
is made. The first-fence model checks an admission predicate, not an interleaving
proof. Journal `skipped` is constrained by the recovery guard and its negative
control specifically tests live-writer recovery, not every corruption condition.
OS process identity, file locks, fsync, symlink races, host mounts, credentials,
network behavior and actual crash recovery require implementation tests and live
qualification. A passing abstract model does not close those runtime gates.

Runtime contracts in `scripts/lib/tla-runtime-models.ts` require completed positive
exploration at the stated bound. Negative runs must exit with TLC code 12, name the
intended invariant, and contain the expected action and violating fields together
in one state. Parser failures, wrong invariants, split-state evidence and timeouts
are rejected.

## MCP startup watchdog design

`mcp-startup/Startup.tla` checks the startup handoff's finite safety contract.
Implementation tests qualify the specific native boundaries below; this model is
not a complete implementation or recovery proof. With two clients, the positive configuration explores 27 distinct
states. The negative control grants readiness before relinquishing timeout authority;
it must fail `NoRevokedGrant` in one `Timeout` state containing both `granted = TRUE`
and `killed = TRUE`. A grant waiting in an inherited channel is already observable:
waiting until a separate ready receipt is noticed is too late to authorize a kill.

| Model action | Intended implementation boundary / present status |
| --- | --- |
| `Request` | `src/mcp/startup-channel.ts` observes loss early and requests permission after ownership publication |
| `Commit` | `mcp_owner/supervision.rs::run` disarms its direct-child guard before writing the grant |
| `Grant` / `Ready` | Separate channel delivery, asynchronous grant validation, descriptor closure and `socket-backend.ts` session activation |
| `Timeout` | `UngrantedChild::drop` kills/reaps only a retained direct child before commitment; adapter cleanup remains limited to its direct launcher |
| `Release` | Native supervisor exits after grant without a resident helper; the backend retains the inherited lease |
| `Attach` / `Detach` / `Retire` | Existing per-client sessions and backend idle retirement, exercised by `tests/mcp-managed-startup.test.ts` |
| `BackendCrash` / `WatchdogCrash` | Process loss before/after handoff; native tests cover post-publication timeout recovery and refusal of a later grant request after supervisor loss |

The backend's independent grant-channel deadline maps to `BackendCrash`: before
grant acceptance it departs without activating sessions. The native owner sets
eight-second receive/send socket timeouts before exec; these end with that private
descriptor and do not affect MCP session I/O. After poll returns, the supervisor
rechecks its absolute deadline before accepting queued readiness. The stopped-owner
test observes publication, bounded refusal and owned cleanup, then resumes the
fixture owner for reaping and lease release. The unchanged finite model checks
handoff safety only; its state graph does not prove either elapsed-time bound.

The finite safety check separates commitment, grant visibility, readiness, client
attachment, retirement and process loss. `Commit` is a local serialized decision,
not a claim that filesystem writes are atomic. It assumes a direct-child handle
cannot be reused before reaping. No fairness, wall-clock deadline, eventual recovery,
pipe behavior, signal delivery, inherited-descriptor correctness, filesystem cleanup
or malicious same-user interference is proved. A watchdog lost before granting can
leave an unready child; this is intentionally represented and remains an open
recovery/liveness requirement. A backend stuck before reaching the grant exchange
can outlive a lost supervisor. `tests/mcp-startup-supervision.test.ts` checks the
real channel, unready timeout/reaping, valid-receipt cleanup, supervisor exit after
grant, supervisor-loss refusal and forced grant-write failure. The failed-write
control suspends the supervisor until its peer has queued a request and closed the
channel; commitment must still prevent killing. Managed 32-client tests cover the
integrated launch path. These tests do not prove all crash windows or eventual
recovery and do not authorize default rollout based on a finite model pass.


## MCP startup cancellation

`mcp-startup-cancellation/Cancellation.tla` has ten positive states: idle; pending,
owned and published with either cancellation value; ready without cancellation;
and closed with either cancellation value. Cancellation means observed channel
failure/deadline, not the instant a remote process physically exits. `Complete`
represents finishing an already-started filesystem effect and capturing its
ownership evidence. `Publish` represents initiating the next publication effect,
not an atomic filesystem transaction or a guarantee that an in-flight write cannot
finish after cancellation. Refusal waits for that completion before cleanup.

The negative control removes the pre-publication check and must violate
`NoLatePublication` in one `Publish` state containing `cancelled = TRUE` and
`latePublication = TRUE`. `NoCancelledReady` also holds in the positive model.
`tests/mcp-startup-supervision.test.ts` maps this counterexample to a claim-creation
barrier: supervisor loss is observed before a delayed effect returns; publication
must not resume, the owned claim is removed and replacement ownership succeeds.
The old implementation fails by binding after the delayed effect completes.

This model checks cancellation ordering at an await boundary. It omits filesystem
errors, malicious replacement, descriptor reuse, elapsed time, blocked JavaScript,
permanent I/O stalls and liveness/fairness. Real descriptor callbacks must settle
before close, and the startup descriptor must close before session activation.
The existing startup model separately covers commit-before-grant kill authority.


## Relay authorization and revocation

`relay-authorization/Authorization.tla` asks whether an already authenticated session
can admit a write after its authority is revoked. The positive model holds one mutex
from `Check` through `Write`; `Revoke` takes that mutex. Its seven states comprise
initial/new, ready, checked and done while active, plus revoked new/ready/done.
The negative control drops the lock after checking and must fail `NoLateWrite` in
`Write` with `active = FALSE`, `phase = "done"` and `lateWrite = TRUE` together.

| Action/state | Implementation boundary |
| --- | --- |
| Authenticate | Successful `relay_auth::ServerHandshake::finish`; crypto validity is assumed in this model |
| Check / held | `AuthorizedSession::with_active` locks the authority and requires its key to remain present |
| Write | Bounded non-reentrant effect callback while the mutex guard remains held |
| Revoke / active | `Authority::revoke` clears the stored key under the same mutex |

This finite one-session abstraction checks effect admission, not network delivery.
Bytes written before revocation may still be in kernel buffers. It omits cryptography,
OS scheduling, callback cancellation, multi-process state, VM lifecycle events, key
provisioning and socket shutdown. The Rust race/poison/revocation tests are the source
regressions; a model pass does not prove consumers wrap every effect correctly.


## Managed relay lifecycle barrier (model and implementation mapping)

`relay-lifecycle-barrier/Barrier.tla` checks the retirement protocol used to guide
managed relay lifecycle work. The implementation now includes a durable coordinator,
private owner control transport, graph cleanup enrollment and a foreground managed
owner. One owned synthetic graph now qualifies initial dependency exchange, health and
enrolled cleanup through the startup integration. This is not full application or
crash-recovery qualification. The model remains an abstraction: its pass does not prove these source paths, native
behavior, or general graph/VM lifecycle acceptance.

In the model, a lifecycle operation records target retirement intent before requesting
revocation.
The relay owner stops each targeted capability (`Revoke`) and drops each service's
owned connections and queues (`Drain`) in separate transitions, then acknowledges
the specific owner/command incarnation only after all targets have retired.
`BeginEffect` requires that matching acknowledgement or confirmed death of the exact
owner. Missing response, a timeout, or a stale PID is not death proof. The model
assumes the owner exclusively holds all relevant sockets/capabilities; inherited
copies must be ruled out before process death can justify fallback.

`BeginEffect` and `ConfirmEffect` are separate transitions. The latter represents
verified new graph/VM identity and a confirmed receipt; it is not an atomic mutation
plus filesystem write. A crash between them leaves targets fenced. Registration
remains blocked by retained intent until confirmation, including after owner restart.
An acknowledgement can be lost and resent; coordinator recovery changes its command
incarnation and cannot reuse a previous acknowledgement. Other services can keep
writing during targeted retirement; a VM-wide change targets both modeled services.

| Model boundary | Current source mapping and limits |
| --- | --- |
| BeginMutation / journal | `relay_owner/lifecycle_intent.rs`: `Coordinator::begin_graph_enrolled` persists the graph selection through its callback before publishing Intent. `graph/host_relay.rs` records the matching `Receipt.relay_cleanup`; `graph/cleanup_enrollment.rs` blocks ordinary mutations and unsafe retention while enrollment is unresolved. This is a graph cleanup integration, not a claim that every VM lifecycle operation uses the barrier. |
| Revoke / Write | `relay_auth::Authority::revoke`, the effect guard, and `relay_owner.rs::retire`; the separate authorization model checks their mutex boundary. |
| Drain / Acknowledge | `RelayOwner::retire` retires the selected authorities and closes their owned flows before producing the matching acknowledgement. `relay_owner/transport.rs` handles bounded selection/retirement exchanges; `publication.rs` pins the private endpoint and native peer identity. `managed.rs` owns the foreground reactor, listener admission and revoke-before-listener-drop shutdown. |
| OwnerCrash / ObserveDeath | Native process start/executable identity is checked at the publication/transport boundary. The managed owner publishes its foreground process identity, which does not independently prove reactor-thread liveness. The model's confirmed-death alternative is not permission to bypass the implementation's fresh retirement proof after a timeout or thread failure. Exclusive descriptor ownership and any death fallback require separate evidence. |
| BeginEffect / ConfirmEffect | `Coordinator::execute` durably records EffectStarted before the effect; recovery cannot replay it. `graph/host_relay.rs::{resume_relay_cleanup,confirm_relay_cleanup}` distinguishes pre-effect resumption from independent post-effect inspection, including archived receipts. Confirmation persists the graph marker before coordinator acknowledgement permits rollover; pending acknowledgement also gates retention. |
| Register | `graph/host_relay.rs::HostRelayService` derives graph/service bindings from inspected identity. `relay_owner/managed.rs::register` uses a caller-selected graph, slot and captured host endpoint; untrusted traffic cannot select a registration. `graph/startup/runtime.rs` provisions the canonical credential through private stdin to the verified guest executable and releases the application gate. The native synthetic startup fixture requires authenticated dependency traffic before initial health; listener binding alone is not readiness, and failure/crash windows remain separate gates. |

One abstract connection per service represents all its pending/active sockets and
retained queues; implementation acknowledgement must account for all of them. The
command incarnation must bind a unique operation and its exact target generations,
not just a coordinator PID.

The finite model has two services, one lifecycle change (one service or both), two
resource generations, at most one owner restart and one coordinator restart. It
explores 1590 states. It checks no effect starts with an unretired target and no
active connection writes under the wrong generation. TLC coverage includes effect
confirmation, fresh registration and unrelated-service writes. No fairness/liveness,
elapsed time, cryptographic proof, filesystem durability, malicious replacement,
process inheritance, transport authentication or kernel-buffer recall is modeled.
Already delivered bytes cannot be recalled by revocation.

The maintained negative control bypasses the barrier and must violate
`NoUnretiredTarget` in one `BeginEffect` state with `unsafeCommit = TRUE`,
`phase = "effect-started"`, retained journal, live owner and both connections still
present. Parser errors or an arbitrary nonzero exit do not satisfy that witness.

Implementation regression coverage lives in `relay_owner/lifecycle_intent/tests.rs`,
`relay_owner/{tests,publication/tests,managed}.rs`, and graph cleanup/enrollment tests.
`graph/host_relay/live_tests/recovery.rs` exercises owned interrupted cleanup and
confirmation boundaries; `graph/startup/native_test.rs` defines the separate initial
application-health acceptance fixture. A test's presence is not a passing run.
Record the exact source/artifact and result when claiming component or native proof;
the synthetic startup fixture passed on September 17, 2026; its 64 KiB exchange,
initial health and confirmed cleanup do not qualify Event Agent or all failure paths.

Keep the remaining acceptance questions explicit: lost acknowledgement and resend,
stale owner/command evidence, death versus timeout, pre/post-effect crashes without
replay, selective retirement with unaffected traffic, and new-generation provisioning
must be tied to the actual operation being claimed. Component checks, the model and
one graph cleanup fixture do not establish every VM mutation, complete application
compatibility, resource improvements or release readiness. The model also omits the
implementation's graph-receipt/coordinator acknowledgement gap and startup release
gate; those require their own implementation tests rather than an expanded claim
about this unchanged specification.
