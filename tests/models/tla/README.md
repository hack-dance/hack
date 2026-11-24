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
and bounded output. Every gate owns a private directory for TLC metadata, copied
models, and Java standard-module extraction (`java.io.tmpdir`). The runner waits
for Java to exit before removing that directory after success, failure, SIGINT,
or SIGTERM. Concurrent worktrees therefore do not share unpacked standard modules.
No credentials or running VM are needed.

Run `bun run test:models:concurrent <other-worktree>` to check failure and
signal cleanup, then run three pairs of complete gates. The other checkout must
contain the same runner revision; omit it to run both gates in this checkout.
The check verifies separate Java temp roots, marker isolation, and removal of
each run's scratch. It uses the same Java and pinned jar as `test:models`.
This check runs on demand, outside `bun test` and CI; each TLC invocation retains
the 120-second timeout.

## Native foreground recovery lease takeover

The companion [PreReady coverage](native-frontend-recovery/COVERAGE.md) checks
settled pre-Ready selection, durable admission release and startup exclusion
during incomplete recovery: 160 states and three intentional negative controls.
It adds no authority for pending effects or live/uncertain host processes.

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

## Native foreground down hooks

`native-foreground-down-hooks/DownHooks.tla` checks the value-free down-hook journal
that a native Compose-import foreground `up` shares with `hack down`. One generation
whose project declares down hooks starts with the frontend running `up.after`. The
frontend owes the hooks, publishes readiness, and on the first interrupt claims its
owed record, runs `down.before`, stops the graph, retires lifecycle processes and runs
`down.after`. A second interrupt cancels a running `down.before` (known, unsuccessful
completion). The graph can also end by itself. One `hack down` client may run, and be
retried once, from another terminal: on a live graph it claims an owed record, or no
record (an older frontend, or one still in `up.after`); on a stopped graph it waits for
the frontend's finalization and runs only what is still owed. A known `down.before`
failure of `down` restores the claimed record so an explicit retry may run it, as on
Compose. Either process may crash at any step; a crash keeps the durable record, so a
started phase becomes unknown. A later `up` (`NewUp`) supersedes any record except a
started one. The journal is one record replaced by compare-and-swap; the model treats
each replacement as atomic.

The positive configuration explores **1,246 distinct states**. `Safe` requires that
`down.before` never starts while another start is running or unknown, or after a known
success; that `down.after` starts once, only after the graph stopped and a known
successful `down.before`; that a started-unknown phase blocks a new generation; and
that an interrupt during `up.after` never runs, or leaves owed, the frontend's down
hooks. No fairness or eventual cleanup is asserted.

The main negative control removes the journal guard (claims ignore the record) and
must fail `Safe` when `DStart` or `FInterrupt` starts a second concurrent
`down.before`. `unknown-generation` removes the started-phase refusal and must fail at
`NewUp` with `unsafeGen = TRUE`. `owed-after-interrupt` removes the owe withdrawal and
must fail at `FInterruptAtPublish` with the frontend's owed record left behind.
`complete-reachable` and `recovery-reachable` assert `NeverComplete` and
`NeverRecovered` and must fail at a safe `FAfterDone`/`DAfterDone`, and at `DAfterDone`
after a frontend crash: the positive model does not pass by disabling the stop or the
crash-recovery path.

| Model action | Implementation boundary under `src/backends/` |
| --- | --- |
| `FOwe` / `FPublish` / `FInterruptAtPublish` | `native-project-start.ts` calls the journal's `owe` as the last step of readiness publication; `native-project-down-hooks.ts` withdraws it when an interrupt was observed. |
| `FUpAfterInterrupted` | `native-project-process.ts` takes the forced stop path for a stop request before readiness; no `beforeStop`. |
| `FInterrupt` / `FBeforeFinish` / `FCancelBefore` | `beforeStop` from `native-project-foreground-stop.ts`; the second interrupt aborts the force signal that cancels the hook (`runLifecycleCommands` in `src/commands/project.ts`). |
| `FCleanup` / `FAfter` / `FAfterDone` | Confirmed foreground cleanup, `hooks.cleanup` and then the journal's `after`, before the finalization acknowledgement. |
| `DStart` / `DBeforeFinish` / `DCleanup` / `DAfter` / `DAfterDone` | `openNativeDownHookSession` in `native-project-down-hooks.ts`, used by `native-project-down.ts`; the stopped path reads the journal only after `waitNativeProjectFinalization`. |
| `NewUp` | `admitNativeDownHookGeneration`, called before `up.before`. |
| `FCrash` / `DCrash` / `OrphanStops` | Process death leaves the record; a detached graph owner may finish stopping or be stopped by recovery. |

The model does not cover real fsync or power-loss durability, a journal lock left by a
crash inside the lock (it refuses closed and needs inspection), multiple generations,
more than two `down` invocations, environment resolution, or the graph owner's process
group on a real host. Ordinary tests map its counterexamples: concurrent claim,
second-interrupt cancellation, failure, crash recovery and unknown refusal.

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

## Automatic dependency refresh

`dependency-auto-refresh/AutoRefresh.tla` checks the foreground owner's
schedule for automatic host dependency refresh. Its positive configuration
(`MaxRetries = 2`, `MaxAttempts = 5`) exhausts 141 distinct states. A stale
notice (traffic drift or a watched listener exit) arms one attempt; attempts are
single-flight; a refusal before the rebind journal re-arms after a bounded
backoff; a completed rebind clears it; and a failure after the journal closes
the schedule. The negative control removes the close guard (`EnforceClose =
FALSE`) and must fail `NoReplayAfterUnconfirmed` at `Start` with a second attempt
after an unconfirmed rebind.

| Model operation | Source boundary |
| --- | --- |
| `ListenerExits` / `Traffic` | `foreground/signals.rs` `watch_listener_exit` and `Wake::ListenerExit`; relay owner identity notices drained in `foreground.rs` |
| `Start` / `RefuseBeforeEffects` | `foreground/dependency_refresh.rs` `AutomaticRefresh` (`take_due`, `finish`, `AUTOMATIC_RETRY_DELAYS`) and `automatic_outcome` |
| `WriteJournal` / `FailAfterJournal` | `startup/runtime/rebind.rs` sets the sticky `rebind_unconfirmed` flag before the first journal write; only a completed refresh clears it |
| `Complete` | verified `refresh_dependencies` result; `ListenerWatches::sync` re-watches the admitted endpoints |

The rebind protocol itself is `dependency-rebind/Rebind.tla`. This model does
not prove the kqueue exit delivery, timer accuracy, provider lease acquisition
or that a replacement listener appears; it abstracts the listener as live, gone
or replaced, and the retry delays as an ordered bound.


### recovery-archive-bound

`recovery-archive-bound/ArchiveBound.tla` checks HACK-2576: each pool stop under a
running project ends a boot, the next `up` recovers the run, and a recovery that finds
an earlier completed record moves it aside as bounded history. The bound once
refused the recovery for ever.

| Configuration | What it checks | Result |
| --- | --- | --- |
| `positive` | the oldest proven finished record makes room (`DropOldest`) and files that cannot be proven finished are not counted, over twelve pool stops with a bound of eight | passes: `AlwaysRecoverable`, `Bounded`, `Recovers` |
| `negative` | today: the archive step refuses at the bound and counts every file with the prefix | `AlwaysRecoverable` fails: the stopped run can no longer be recovered |

## Native pool stop under a live run

`native-pool-stop/PoolStop.tla` checks HACK-2456: a VM pool that stops (`runtime down`)
or dies (VM or provider crash, host reboot) while a project's graph is ready. It
models:

- the pool: running, stopped or crashed, with a boot counter;
- the run receipt: none, ready or retained, and the boot its containers belong to;
- the foreground owner (live or dead) and its publication.

The user commands are the ones the CLI names: `hack up`, `hack down` /
`hack down --recover` and `hack native recover`. Faults are bounded to three:
`runtime down`, a crash, an owner crash, and a boot by something else (another
project's `hack up`, or `runtime up` by hand). A live owner notices when its guest
is gone (the pool stopped, or a later boot replaced it) and exits without retiring its
publication.

`NoDeadEnd` says that from every reachable state some named command can act, or
the owner is still noticing its guest is gone. `Recovers` (`[]<>Settled` under weak
fairness of the user commands) says the project keeps reaching up or down. Up means
ready in the current boot with a live owner; down means nothing running and no
publication left. `BootBoundUnreached` shows the boot bound (8) never limits a command.

| Control | Switches | Result |
| --- | --- | --- |
| `positive` | stopped-pool recovery and recovery from any earlier boot; something else may boot the pool; a fault may strike between a recovery's boot and its graph recovery | 210 states; `NoDeadEnd`, `BootBoundUnreached` and `Recovers` hold |
| `negative` | `next` before HACK-2456 | `NoDeadEnd` fails in an `OwnerCrash` or `OwnerNotices` state: stopped pool, ready run, dead owner, publication left |
| `by-hand` | `next`, counting an unnamed `runtime up` | fails in a `RuntimeUp` state with `boot = 3`, `runBoot = 1` |
| `strict` | stopped-pool recovery with the old predecessor-only rule, while something else boots the pool | fails in `RecoverStopped` (or `RuntimeUp`) with `boot = 3`, `runBoot = 1` |
| `crash-in-recovery` | the old predecessor-only rule; the pool stops between the recovery's boot and its graph recovery | fails in `RecoverStopped` with `boot = 3`, `runBoot = 1`, `recovering = TRUE` |
| `https` | recovery from any earlier boot with every fault, for a project with HTTPS routes (`Https`) | 608 states; all hold, including `NoArchiveOverListener` |
| `https-no-retire` | `https` controls: the shared HTTPS owner keeps running after its boot ended | fails in `RecoverRunning` (or `RecoverStopped`): pool running, `https = "live"` bound to the old boot, `fin = TRUE` |
| `https-archive` | the previous-boot archive cannot prove the owner quiescent | fails with `https = "records"`, `fin = TRUE`, pool running |
| `https-stopped` | `hack down --recover` does not start a stopped pool for a pending finalization | fails with the pool stopped, `run = "retained"`, `fin = TRUE` |
| `https-finish-bound` | `https`, but a completed recovery's archive may run only in the boot the recovery ran in (`FinishAnyBoot = FALSE`) | fails once that boot ends with the archive still owed: `https = "records"`, `fin = TRUE`, pool running |
| `reuse-no-check` | `https`, with the archive's port claim binding with address reuse but of the wildcard alone, without the exact claim of every local address (`ListenerCheck = FALSE`) | `NoArchiveOverListener` fails: the archive runs while another process listens on the port |
| `idle-restart` | `positive`, plus another project's `up` that stops the running pool to add its share when the pool is idle (`IdleRestart`, HACK-2535) | passes: `NoDeadEnd`, `Recovers` and `NoRestartOverLiveRun` (a run that became live before the stop is never stopped by it) |
| `idle-restart-one-check` | `idle-restart` without the second idle check right before the guest stops (`SecondCheck = FALSE`) | `NoRestartOverLiveRun` fails: a start that took no lease and turned live between the first check and the stop is stopped. In the code every start takes the lease the stop holds, so this shows what the second check guards on its own, not a race the code has |

`Recovers` also fails on `next` (TLC exit 13: the behavior stutters in the dead end).
That is checked by hand, because the runner's controls are invariant violations only.

`strict` and `crash-in-recovery` document the old rule: recovery of a dead owner's
ready run accepted only the immediate predecessor boot, because it needs that boot's
raw id to find its host-side relays, and `owner.json` keeps only the current and
previous ids. Each boot now first records the ids it supersedes in a bounded
boot history (`provider/boot_history.rs`, 16 boots, bound to the pool's owner
token), and `graph/boot_match.rs` selects the one earlier boot the run's receipt
names (relay cleanup marker, control root, or one-off job boot); zero or several
matches, or the current boot, refuse. The model does not bound the history: a run
whose boot was evicted after 16 later boots is refused with its data kept. Two paths
stay predecessor-only and are not modeled: a stopped-pool `graph recover-cleanup`
selection (`prepare`; boots in between may have restarted the run's containers),
and absent-publication cleanup after a host reboot.

| Model action | Implementation boundary |
| --- | --- |
| `RuntimeDown` | `provider/lifecycle.rs::down`, which reports `interrupted_runs` (`lifecycle/pool_users.rs::live_graph_runs`) |
| `RecoverStopped` | `inspectOrStartStoppedPool` / `StoppedPoolStarted` in `native-project-down.ts`; `selectNativeStartupRecoveringStoppedPool` in `native-project-start.ts` |
| `RecoverRunning` | `resumeSelectedOwner` → `recover-cleanup` → `retire-recovered-publisher`; `CanRecover` without `Strict` is `graph/dead_owner_cleanup.rs` `recovery_selection` / `execute` with `graph/boot_match.rs` over `provider/boot_history.rs` |
| `Start` / `Stop` | ordinary `hack up` (fresh or retained) and `hack down` |
| `PoolRecover` | `hack native recover` (`lifecycle::recover`) |
| `OwnerRetire` | `native-https-owner-server.ts` pool-boot check (`native-https-pool-boot.ts`), which retires through `failOwner` and keeps the configuration and lease |
| `TimeWaitEnds`, `Listen`, `ListenerExits`, `PortClaimable` | the shared HTTPS port after the owner's Caddy stops: TIME_WAIT expires on its own, or another process listens and later stops. The archive claims the port through `https_recovery::port_absent`: with `ReuseBind` (HACK-2550) it binds with `SO_REUSEADDR` (never `SO_REUSEPORT`), so TIME_WAIT does not block it, and it binds the wildcard, the loopback and every interface address from `getifaddrs` exactly, so another listener on any of them refuses it; the addresses are listed again after binding and must match. Otherwise it falls back to the strict claim, which waits for TIME_WAIT to end |
| `RestartCheck`, `RestartStop`, `RestartRefused` | another project's `up` needs a share the running pool lacks (HACK-2535). `share_update::add_project_share_stopping_idle_pool` stops the pool through `lifecycle::stop_idle_pool`, which checks `pool_users::require_idle` under the provider lease and again right before `guest_stop`, and releases the host side (managed hostname authority, publishers) only after that second check; the lease is held from the first check to the stop, and graph starts take it before they write a live receipt. The model is deliberately more permissive: it lets a start turn live between the checks, so `idle-restart-one-check` shows what the second check guards on its own. The share is then added to the stopped pool and that `up` boots it (`RuntimeUp`) |
| `FinishCompleted` | the same archive after the recovery's boot ended (HACK-2550, z338, z282): `HttpsArchiveGuard` admits the completed intent from any boot, and `host_relay::inspect_cleanup_completed` with `bridges::cleanup::read_completed_recovery` admit its bridge selection by the run's own evidence; everything else is observed in the current boot |
| `Finalize` | the frontend finalization's `recoverNativeHttpsLease`: release through a live owner of this boot, or `runtime archive-previous-boot-shared-https` (`provider/shared_https_recovery.rs`), whose quiescence proof is `prove_quiescence` plus `await_owner_exit` |
| `RecoverStopped` (finalization) | `deadOwnerOfLiveRun` in `native-project-down.ts`: a retained stop with no owner and an interrupted frontend lifetime |

The model does not represent bridges. On a real VM, the run that recovery met had been
stopped in one boot and restored in a later one. The first boot's bridge sidecar was still in
its directory, two boots back. Recovery accepts a completed earlier generation with routes
from any boot but the live one, because what proves it complete does not depend on its boot.
That proof is the restore history's stopped receipt, plus every current route having
launched after it (`graph/bridges/cleanup.rs` `prior_generation`). An empty sidecar keeps
the previous boot.

The shared HTTPS owner (HACK-2456, seen on a real VM) is a host process bound to one
pool boot that holds the run's lease. `runtime down` does not stop it. Before this change it
kept running after its boot ended, its lease could not be released (release requires the
same boot), and the previous-boot archive could never succeed, because it required the
frontend and runtime executables to run nowhere while the CLI asking for it ran them. A
recovery then stopped the graph and retired the publication, failed at the lease, and
left a retained run that `up` refused and `down --recover` could not reach once the pool
stopped again. The three `https-*` controls each restore one of those parts. The model
abstracts the owner's 5-second boot check and the archive's 20-second wait for a retiring
owner as one `OwnerRetire` step; it does not represent several projects sharing one owner.

The CLI tests in `tests/native-project-down.test.ts`, `tests/native-project-start.test.ts`
and `tests/native-refusal-cli.test.ts` walk these transitions against a fake runtime.
`tests/native-https-owner.test.ts` runs the real owner process through its boot check;
`provider/shared_https_recovery/tests.rs` (macOS) runs the archive with the same bundle's
CLI and runtime processes present and with a live or retiring owner invocation.
The model does not represent concurrent starts of the same instance, the startup
marker, or image and admission work. A real VM must qualify `runtime up` booting a
stopped pool as it was recorded.

## Native run mapping release after the home is gone

`native-run-mapping-release/MappingRelease.tla` checks HACK-2524. A checkout's run mapping names the native home that owns its run. When that home is deleted, its records (the proof of a clean stop) go with it. The model covers the home at its recorded path (present, deleted, moved, or replaced by another identity), whether a process of the home is alive and whether it names the recorded path, and the mapping (held or released).

`NoStrandedMapping` says a held mapping whose home is gone, with no process of it alive, can always be released. `NeverReleaseLive` says no release happens while a process of the home that names the recorded path is alive.

| Control | Switches | Result |
| --- | --- | --- |
| `positive` | the gone-home release: the path no longer holds the home and the process scan finds no process naming it | 21 states; both invariants hold |
| `negative` | today: only the clean-stop release from the home's own records | `NoStrandedMapping` fails right after `Delete` (or `Move`) |
| `path-only` | the gone-home release without the process scan | `NeverReleaseLive` fails: released while a process of the home lives |

| Model action | Implementation boundary |
| --- | --- |
| `CleanRelease` | `releaseNativeProjectRunForeignHome` (the home's frontend records show a completed lifetime) |
| `GoneHomeRelease` | the gone-home release in `native-project-run.ts`: the recorded path is absent, not a directory, or another identity, and the runtime's process scan finds no process naming the home |
| `StartMoved` | the residual: a moved home started from its new path has processes that do not name the recorded path, so a release then leaves that home's run without a checkout mapping (its data and its own recovery stay in that home) |

## Pool amd64 emulation

`pool-emulation/Emulation.tla` checks the Rosetta 2 translation intent of one shared
native VM pool. The positive control explores 13 states. A start that needs
translation records `Owner.amd64_emulation` before any provider effect; `machine
create` passes `--rosetta` exactly when it is recorded, and a stopped pool whose
stored setting lacks it is updated (`machine update --rosetta`). An interrupted update
is the absence of that step and is repeated by the next start. A foreign actor may
flip the stored setting while the pool is stopped. Each boot runs the stored setting;
the engine starts only when the stored setting, running configuration and guest
`binfmt_misc` registration all equal the recorded intent, otherwise the boot is
refused. An amd64 container needs the audited pool's intent, and a running pool
without translation refuses a request for it instead of changing intent.

Removing the boot audit must fail `NoUntranslatedAmd64` in one `StartAmd64` state
with `amd64 = TRUE`, `intent = TRUE`, `config = FALSE`, `registered = FALSE` and
`engine = TRUE`. Allowing a running pool to gain intent must fail
`EngineMatchesIntent` in one `RequestRunning` state with `phase = "running"`,
`intent = TRUE`, `config = FALSE` and `engine = TRUE`. Both controls require TLC
exit 12, the named action and same-state witness.

| Model action | Implementation boundary |
| --- | --- |
| `RecordIntent` | `provider/lifecycle.rs::enable_amd64_emulation` saves `Owner.amd64_emulation` before any provider command |
| `Create` / `Update` | `start_pool` adds `--rosetta` to `machine create`; `enable_amd64_emulation` runs `machine update --rosetta` when `config_audit::recorded_amd64_emulation` is false |
| `ForeignRecord` | A stopped machine changed outside Hack; `config_audit::verify_value` compares the stored `rosetta` setting with the owner |
| `Boot` / `StartEngine` / `RefuseBoot` | `audit_boot` (running config `resources.rosetta`), then `guest-translation.sh` in `finish_boot` before the engine starts |
| `RequestRunning` | `check_amd64_emulation_request` refuses `amd64_emulation_restart_required` |
| `StartAmd64` | `graph::admitted_architecture` (opted-in service and `OwnedGuest::amd64_emulation`), and `image_load::load_for` for amd64 archives |

The model omits image selection, the registry and Docker's own platform handling;
those are covered by `registry_image`, `image_ensure` and graph admission unit tests.
Actual Rosetta execution in the guest needs host evidence.

## Native probe readiness

`probe-readiness/ProbeReadiness.tla` checks how the host reads one native HTTP probe
before a start counts its service ready (HACK-2440 c and d, HACK-2416). It models the
probe loop in `guest/http-probe.c`: the patient first attempt, failures counted only
after the first success or once the grace has passed, and the start interval. The app
is chosen at the start: `slow` (its first answer takes 1..`MaxCompile` ticks, and an
abandoned request restarts its compile), `refusing` (every request fails at once) or
`hanging` (accepts, never answers). It also models the host's reading in `assess`,
`observe_finding` and `observe_sample`. Faults are an exec that exits or never starts,
a probe that stops publishing, a frozen status dated in the future, and a missing or
torn read. Bounds, in ticks: grace 3, timeout 1, start interval 1 (2 with `Legacy`),
interval 2, two retries, `MaxCompile` 2, `Limit` 14 and a horizon of 15.

The positive control explores 175,757 distinct states to depth 52; `legacy` (the
steady cadence before the first success, as a probe launched with an earlier build's
arguments) explores 132,615. Both check:

- `NoFalseFailure`: an app that answers within its grace is never failed without a
  probe fault.
- `NoPrematureFailure`: without a probe fault, the host fails a start only once the
  probe itself has reached unhealthy, so its bounds never cut a working probe short.
- `BoundedStarting`: no reading says starting later than `Limit`, counted on the host.
- `NoReadyWithoutSuccess`, and `OneCompile`: inside the grace the probe never makes
  the app start its compile again.

Controls, each required to fail in the named state:

- `negative` (`Patient = FALSE`): `OneCompile` in a `Begin` state with `restarts = 1`.
- `no-host-bound` (`HostBound = FALSE`): `BoundedStarting` in an `Observe` state with
  `verdict = "starting"`, `skewed = TRUE` and `vt = 15`.
- `no-tolerance` (`Tolerate = FALSE`): `NoFalseFailure` in an `Observe` state with
  `verdict = "unhealthy"` and `app = "slow"`.
- `exhausts`: `NeverExhausted` in an `Expire` state with `health = "unhealthy"` and
  `failures = 2`. It shows the positive run reaches exhausted retries.
- `tight-bound` (`TightBound = TRUE`, a bound without the failed attempts after the
  grace): `NoPrematureFailure` in an `Observe` state with `verdict = "unhealthy"`.

| Model action | Implementation boundary |
| --- | --- |
| `ExecStart` | `start_probe` creates and starts the exec; the probe publishes sequence 0, health 2 |
| `Begin` / `Answer` / `Expire` | `request` with `attempt_timeout`, then `sample_health` and `publish` in `guest/http-probe.c` |
| `Observe` / `V` | `graph/probes.rs::observe_finding` and `observe_sample`, `HttpProbe::assess` and `starting_bound_ms` in `http_probe.rs` |
| `ExecExit` / `Wedge` / `Skew` | An exited exec, a probe that stops publishing, a guest clock ahead of the host's |

`graph/probes.rs` `the_probe_readiness_model_verdicts_match_observe_sample` walks each
branch of `V` through `observe_sample` with the model's constants (one tick = 1000 ms).
It fails if the code's bounds drift from the model. `http_probe.rs`
`inside_the_start_period_one_slow_first_answer_is_waited_for` runs the compiled probe
against a server that answers in 300 ms with a 40 ms timeout. The model assumes
`MaxCompile < Grace` (an app answering exactly at the end of its grace races the
attempt's own deadline) and an exec that starts within one tick of its recorded start.
It does not model HTTP parsing, several probes, the whole-graph deadline or arbitrary
engine scheduling delays.

## Stopped retained-pool startup

`native-startup-owner/Owner.tla` checks project ownership after a foreground
Compose startup fails (HACK-1917). The positive control explores 136 states.
Readiness publishes the run mapping. A failure before readiness lets the graph
owner's retaining cleanup either complete or be refused; the frontend then makes
one read-only inspection that authenticates the exact receipt or is refused.
`NoUnownedResources` requires resources that outlive the frontend under an
authenticated receipt to have a published mapping; the `negative` control (no
recording on failure) violates it with an unowned started graph. `NoUnprovenOwner`
allows only readiness or an authenticated receipt to publish. The
`refused-inspection` control violates `NoUnrecordedRefusal` to keep the remaining
gap explicit: when inspection itself is refused, nothing can be authenticated and
only the runtime journal retains the graph. The model does not cover crashes
between finalization registration and mapping publication, concurrent starts, or
the later dead-owner recovery, which other models and runtime tests own.

HACK-1940 extends this same owner model with launcher notification, acceptance,
owner acknowledgement, return and channel loss. `NoPrematureReturn` requires
readiness, committed down-hook bookkeeping and acceptance before detached success; `NoLostHandoff` prevents a
lost pre-acceptance launcher from being handed off later. The
`detached-before-ready` negative control bypasses both notification gates and returns
before Ready.
`Bookkeep` separates graph readiness from successful journal completion and its
cancellation fence. The `detached-before-bookkeeping` control keeps Ready but
removes the journal guard, allowing false success while `bookkept = FALSE`.
The delayed, failed and canceled journal regressions in `native-project-start.test.ts`
map that boundary to `stop.owe` before `onReady`. Source: `native-detached-up.ts`, image onReady after hooks,
and authored `startupSelection.onReady` after durable publication. The synthetic
`native-detached-up.test.ts` process fixtures cover post-launcher control,
pre-acceptance launcher death, timeout and child failure. They do not execute
real hooks or a VM.

The existing `native-frontend-recovery` model also distinguishes launcher loss
from retained owner death. `TryLauncherRecovery` abstracts recovery admission:
with a live exact frontend it must refuse, even when its launcher is gone. The
positive now explores 1752 states. `live-launcher-recovery` disables this guard
and fails `NoLiveLauncherRecovery`; `live-launcher-refusal-reachable` proves the
refusal is reachable. Original publication, crash, binding and lease transitions
remain unchanged. The model bounds two recovery candidates and does not model
OS IPC delivery, process incarnation probing or real resource cleanup.

## Interrupted native restart intent

`native-restart-intent/RestartIntent.tla` checks that an interrupted
`hack restart` never leaves a pending restart that `hack up` and `hack restart`
both refuse (HACK-1953). The positive control explores 40 states with one
Ctrl-C, one frontend crash and two restart attempts. A restart saves a
`prepared` intent for the exact old run, asks the old foreground owner to stop,
and marks the intent `cleaned` only after the stop is confirmed. The old owner
can stop on that request or on its own Ctrl-C. `up` refuses while an intent is
pending. `NoRecoveryLoop` requires `up` or `restart` to accept every quiet state
in which the old owner has stopped. `InterruptLeavesNoIntent` requires the first
Ctrl-C to end with no pending restart. `NoFreshFallback` and
`NoReplacementOverLiveOwner` keep the exact selection and the stop ordering.

Three negative controls remove one mechanism each. In `negative`, the stop
request shares the terminal's process group, so the Ctrl-C ends it and leaves the
intent (`Interrupt`). In `no-resume`, a prepared intent requires an active graph,
so a crashed frontend after the old owner stopped itself leaves a loop (`Crash`
or `OwnerStops`). `shared-group-loop` has neither mechanism and reproduces the
v5.0.0-next.12 loop. Preflight review, hooks, finalization records and the
restart lock are abstracted. The model does not cover a stale restart lock left
by a crashed frontend, which still refuses until it is inspected.

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

## Pool start admission

`pool-start-admission/PoolStart.tla` checks the host admission of one `runtime up`
of a pool that is not running. A Development start takes one sample before the
startup lease and one under it, at least the admission window after the first, or
at least the window after a recorded earlier sample of the same home; a Research
start keeps three samples before the lease. The positive control explores
220,686 states for both profiles, with the provider and engine trees rechecked and
the root files proven under the lease: a start without an early root files proof,
such as the first boot of a new home.
The clock, a host that fails and passes again once, the swapout count, another
lease holder that may record a host sample, a concurrent start, a changed tree or
root file, a squatted HOME alias and a crash interleave with every step. See its
[coverage](pool-start-admission/COVERAGE.md) and
[statechart](../../../docs/pool-start-admission-statechart.md).

A VM starts only on the qualifying samples of its profile, each taken on a
passing host (`SamplesTakenOnPassingHost`), with one unbroken swapout count from
the first sample to the pre-boot check, and the pre-boot check compares against
the last qualifying sample. The pre-boot observation is recorded apart from the
samples: it was taken on a passing host (`BootSampleOnPassingHost`) and showed
the count it was compared against (`BootSampleMatchesBaseline`). No VM starts from a provider or
engine tree that changed after its content proof (`NoStartFromChangedTree`). A
refusal, a crash or a pool that a concurrent start already booted leaves no VM
started and the lease returned. The `root-before-lease` control (277,194 states)
checks the same invariants for the other path of the implementation, a cleanly
stopped pool's start, in which the root files are proven before the lease and
rechecked under it.

Twelve controls remove one mechanism each and must fail the named invariant: the
second sample before the lease (`negative`, `SecondSampleUnderLease`), no window
(`window-not-enforced`), no swapout comparison at the second sample
(`unchained-recheck`) or at the pre-boot check (`unchained-boot`), two Research
samples (`research-two-samples`), no root files recheck after a proof before the
lease (`root-unchecked`), no tree recheck under the lease (`changed-tree-start`,
`NoStartFromChangedTree`), no predicate check of the first sample
(`first-sample-unchecked`), of Development's sample under the lease
(`second-sample-unchecked`) or of Research's later samples
(`research-sample-unchecked`), and a pre-boot check that admits without its
predicate check (`boot-host-unchecked`) or without its swapout comparison
(`boot-swapouts-unchecked`). Three more show that a Development start, a Research
start and a start after an alias rewrite are reachable.

Three reachability controls state what the observations do not see:
`development-dip-start-reachable` and `research-dip-start-reachable` require a
start that is admitted although the host failed at some moment between two of its
accepted samples, and `boot-dip-start-reachable` one admitted although the host
failed between its last sample and the pre-boot observation. Nothing reads the
host between observations except the cumulative swapout count, so such a dip
passes; with two Development samples instead of seven it has fewer samples to
miss. The model shows that the gap exists, not how wide it is.

A home's record of an earlier passing sample (`admission/opening.rs`) may replace
the wait between a Development start's two samples, never a sample. A start that
skipped the wait had a record from this OS boot, at least one window and at most
one bound old, whose swapout count equals its sample's under the lease
(`ReusedRecordSameBoot`, `WindowRespected`, `ReusedRecordWithinBound`,
`ReusedRecordSameSwapouts`); every record written came from a passing host
(`RecordsFromPassingSamples`); Research reuses nothing (`ResearchNeverReuses`).
Five more controls remove one of these each: `reuse-other-boot`,
`reuse-too-young`, `reuse-too-old`, `reuse-changed-count` and `record-unchecked`.
Three reachability controls require a start on a reused record
(`reuse-start-reachable`), a start that found an unusable record and waited out
its own window (`reuse-miss-start-reachable`), and the weakening of reuse: a host
that failed and passed again between the recorded sample and the sample under the
lease is admitted (`reuse-dip-start-reachable`). The record's file checks, its
parsing and its clock are not modelled; their tests are in
`provider/admission/opening/tests.rs`.

The provider and engine trees are proven by content before the lease, inside the
admission window, and rechecked first under it (`lifecycle/leased_trees.rs`): a
tree whose metadata digest and content anchor equal its proof's keeps the proof,
any other tree is proven by content again, and a changed tree refuses the start.
`changed-tree-start` is the start without that recheck: a tree that changes
between its proof and the lease is booted once, and only the next command's
witness check refuses it. The model keeps one bit for the trees, so the metadata
comparison and the second proof are one guard in it. A cleanly stopped pool's
root files are held to the same rule (`lifecycle/rootfs_proof.rs`): proven in the
window, rechecked as the step after the tree recheck and compared once more where
their digest is used, with one bit and one recheck action in the model. A sample is one atomic
observation, pressure that comes and goes between samples is invisible, tree and
root changes are assumed absent while the lease is held, and nothing after
`machine start` is modelled. There is no fairness or eventual-start claim, and a
model pass is not a measured boot.

## Retained-data handoff across plan changes

`native-plan-reconcile/Reconcile.tla` checks how a stopped native graph hands its
named data to the next admission after a Compose edit. Two interchangeable
instances (checked up to permutation), two logical volume keys and three volume
identities explore 747,656 distinct states. Every admission recreates compute from
the current plan, so command, image and environment edits are abstracted; the model
varies only the declared volume set. A declared key that the run already records is
reattached; a newly declared key gets an exclusively created volume; recorded data
the plan no longer declares stays recorded and unmounted until explicit removal.

| Model action | Implementation boundary |
| --- | --- |
| `Edit` | Compose edit between ups; a new review and normalized identity |
| `Select` | `provider/graph/foreground.rs::restore_selection` generation over the receipt and observed volume identities |
| `Replace` / `Substitute` | Volume replaced between selection and admission, or a foreign-labeled volume under a recorded name |
| `Admit` | `provider/graph/restore.rs::restore_inputs`: `plan_reconcile::Verified::verify_fresh` generation recheck and label/presence checks under the provider lease |
| `CreateDeclared` | `plan_reconcile::Verified::project` fresh `reserved` names, then `Session::create_resources` exclusive create |
| `Start` / `Stop` / `RemoveData` | Container creation with projected mounts; ordinary stop keeps volumes; `down --remove-data` deletes recorded volumes |

The `negative` control adopts any live volume with a declared key and must fail
`NoForeignAttach` in a `Start` state with `foreignAttach = TRUE`. The `replacement`
control skips the generation recheck and must fail `AttachSelected` with
`unrecordedAttach = TRUE`. The `drop-orphans` control forgets undeclared retained
data and must fail `RetainedDataRecorded` with `lostData = TRUE`.

Assumptions: admission through startup holds the provider mutation lease, so no
replacement happens inside it. A replacement with copied ownership labels before
selection is indistinguishable from the recorded volume by name and labels, as in
the implementation; the generation fence protects only the selection-to-admission
window. Dependency caches are checked by the next model; live source and
source-device rebinding keep their own proofs and are outside this model. It does
not prove engine mount behavior, crash durability of the receipt, image resolution
or application data contents.

## Dependency caches across plan changes

`native-cache-reconcile/CacheReconcile.tla` checks which volume backs a dependency
cache key when a stopped graph is reconciled after a Compose edit. A cache is a
volume named by an identity of its inputs; run-owned data uses the run's own names.
Edits change the cache's own inputs (initializer definition, declaration, image,
lockfiles, and every service mount of the cache volume), anything else in the
Compose file, whether a non-initializer service mounts the cache read-write, or
whether the key is declared as a cache. Such a writable consumer can change the
contents with inputs the identity does not hash, so its cache is scoped to this
checkout or branch instance; another instance with its own writable consumer may
write into the caches it selects (`ForeignWrite`). Two values for each explore
2,208 distinct states.

| Model action | Implementation boundary |
| --- | --- |
| `EditInputs` / `EditOther` / `EditConsumer` / `EditDeclaration` | Compose or lockfile edit between ups; `dependency_cache::resolve_with_legacy` computes the current identity and `instance_scoped_volumes` the scope |
| `ForeignWrite` | A linked worktree or branch instance whose writable consumer changes the cache it mounts |
| `UpCache` | `plan_reconcile::prepare` refuses run data declared as a cache; `Verified::project` keeps a cache of the same identity or selects the new identity's cache, then `Session::create_resources` adopts it by labels or creates it |
| `UpData` | A key that is no longer a cache gets a fresh run-owned volume; the cache reference is released, never deleted |
| `Stop` | Ctrl-C or `down` keeps every recorded volume |

The `negative` control binds the whole Compose document into the identity (the
earlier formula) and must fail `UnrelatedEditKeepsCache` in an `UpCache` state with
`needlessRebuild = TRUE`. The `stale` control reattaches the recorded cache whatever
its identity and must fail `CacheMatchesInputs` with `staleMounted = TRUE`. The
`data-as-cache` control mounts retained run data newly declared as a cache and must
fail `NoDataAsCache` with `dataMounted = TRUE`. The `poison` control keeps caches
with a writable consumer shared across instances and must fail `NoForeignWrites`
with `foreignMounted = TRUE`.

Assumptions: identities are exact (no collisions), the initializer populates a newly
selected cache before dependents start, read-only consumers and initializers only
produce what the identity describes, and admission holds the provider lease. Within
one instance the same author controls every input, so writes there are trusted. The
compatibility path that keeps a receipt recorded under the earlier identity while
its inputs still match (never for a writable consumer) is covered by
`plan_reconcile.rs` tests, not this model. It does not prove initializer
idempotence, cache content, capacity limits or cache-wide collection.

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
| bridge-batch | 14674 | One provider lease starts a batch of route and port bridges and a cleanup releases them: no relay without its durable intent, no listener launched without its own fence admitting the reserved, healthy target, no relay stopped under a live listener, a finished release leaves nothing, `ready` means everything is published. Negative controls: relays before intent (`negative`), child without fence (`child-fence`), relays stopped before listeners (`release-order`); reachability of ready, release, release after ready and a mid-batch stale stop. See [COVERAGE.md](bridge-batch/COVERAGE.md) | `graph/bridges.rs` (`reserve_publications`, `start_selected`, `publish_bridge`, `release_selected`), `graph/relay.rs`, `publication.rs`, `graph/foreground/publishers.rs` |
| loopback-port-publication | 1008 | One listener per published host port, forwarding only to the pinned container incarnation, recovery only for a dead owner, and no listener after acknowledged stop. Negative controls: recovery without the dead-owner check (`negative`), no loopback probe (`no-probe`), no endpoint identity check (`stale-target`), acknowledging stop before closing the listener (`ack-before-close`) | `publication.rs` (`require_loopback_port_free`, `release`), `graph/bridges.rs` loopback bridges, `graph/foreground/publishers.rs` |
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
Loopback port publication uses two owners and one foreign listener for one host
port, and one container replacement per publication. Publish is one step: the
real interval between the loopback probe and the publisher's own bind is not
modeled, so a foreign wildcard listener that binds inside it is a documented
residual risk rather than a checked property.
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
initial health and confirmed cleanup do not qualify a real application or all failure paths.

Keep the remaining acceptance questions explicit: lost acknowledgement and resend,
stale owner/command evidence, death versus timeout, pre/post-effect crashes without
replay, selective retirement with unaffected traffic, and new-generation provisioning
must be tied to the actual operation being claimed. Component checks, the model and
one graph cleanup fixture do not establish every VM mutation, complete application
compatibility, resource improvements or release readiness. The model also omits the
implementation's graph-receipt/coordinator acknowledgement gap and startup release
gate; those require their own implementation tests rather than an expanded claim
about this unchanged specification.

## Shared helper instance

`shared-helper-instance/Instance.tla` models lifecycle-session ownership for one
shared-helper instance (one branch, HACK-1142): two overlapping `hack up` runs
(`a`, `b`) and one `hack down`, with the shared helper instance lock (`lock`), the
live session and its ownership token (`session`, `token`) and the persisted
lifecycle entry (`entry`, `healthy`) as explicit state.

- `SessionSafe`: an up that succeeded with no down since it captured the shutdown
  generation still has a live session, so an overlapping up's cleanup never kills a
  session a successful up adopted.
- `Reclaimable`: a live session always has a persisted entry naming its token, so
  the normal stop controller (`hack down`) can reclaim it.
- `NoForeignLaunch`: a start never launches a process into a session that carries
  another start's token.
- `HelpersKeptForSession`: a down that could not confirm the session stopped keeps
  the instance's helper holders while that session lives.

| Model operation | Source boundary and regression |
| --- | --- |
| `Capture` / `Superseded` | `captureSharedHelperShutdownGeneration` before `up.before`; `startProjectSharedHelpers` refuses a changed generation before ensuring helpers. |
| `Decide` | The controller's session decision under the instance lock (`resolveSessionDisposition`): adopt an owned healthy session and record the adoption epoch, replace an owned stale (pending) one, refuse one without matching state, or decide to create. |
| `CreateBegin` | Start of the creation transaction (`ensureSession` → `createOwnedSession` under one `withLock`): `assertSessionStillAbsent` re-inspects and refuses unless the session is still absent. `tests/project-lifecycle-controller-ownership.test.ts` interleaving regression. |
| `Publish` / `CreateSession` | Pending entry published, then `createSession`; a failed creation removes only this start's pending entry (`removeLifecycleStateEntryIfOwned`). |
| `Record` / `RecordFail*` | tmux environment setup and `record("created")`, then the lock is released with the entry still pending. On failure the cleanup (`releaseFailedSessionCreation`: token read, name-based kill, entry removal) runs inside the same lock: the created session is stopped with its token before the entry is removed (`RecordFailStopped`); an unconfirmed (or timed-out) stop keeps the entry and token (`RecordFailUnconfirmed`). Controller regressions for both, including a hung `createSession`, a replacement overlapping the cleanup, and a replacement overlapping environment setup. |
| `StartProcesses` | Each launch (`startLifecycleProcess`) runs under the lock and only while the persisted entry and the live session still carry this start's token; otherwise the start is displaced (`LifecycleSessionDisplacedError`) and launches nothing. The pending entry is not adoptable, so another start may replace the session between launches. Controller regression: a displaced start's later process never reaches the replacement. |
| `Finalize` | `finalize()` under the lock (`publishFinalEntryIfStillOwned`): publish the final, adoptable entry only while the persisted entry and the live session still carry this start's created or adopted token; otherwise the start is displaced, gives up its authority and fails (`LifecycleSessionDisplacedError`). Controller regression: replacement after creation but before finalization, reclaimed by `stopLifecycleProcessController`. |
| `CreateTimeoutCreated` / `CreateTimeoutNotCreated` | A `createSession` that exceeds `muxCommandTimeoutMs()` is killed by `runMuxCommand`, so the call settles under the lock and throws `MuxCommandTimeoutError`: either the server created the session first (outcome unknown: entry and token kept for reclaim) or it did not (proven absent: entry retired). Controller regressions for both. |
| `InspectTimeout` | A timed-out listing, ownership-token read or window listing throws instead of returning an empty or absent result, and a listing that omits the session followed by an exact-presence query without a definite answer fails the inspection (`LifecycleSessionPresenceUnknownError`) instead of reading absence; the decision fails closed. Real tmux backend regressions with a hanging `tmux`, including that listing-omits-then-presence-times-out path; controller regression over a healthy owned session. |
| `CreateAbandon` / `LateCreate`, `ReplaceAbandon` / `LateKill`, `RecordFailReadUnlocked`, `MisreadDecide` / `MisreadCreateBegin` | Broken designs only (each enabled by one control): a deadline that stops waiting without cancelling the call, a failure cleanup whose kill lands after the lock was released, and a timeout read as absence. |
| `Launch` / `Succeed` / `Fail` | `assertCurrent` before and after containers start; Compose failure, SIGINT/SIGTERM or a failed check. |
| `Cleanup` / `CleanupUndecidable` | `SharedHelperSessionOwnership.runIfOwned`, which the combined operation cleanup and the controller's `abort()` / signal cleanup both go through: under the lock, a creator with a recorded epoch kills only while the epoch is its own; a creator whose record failed kills by token; the kill always checks the token. An unavailable lock keeps the session (and the helper holders: `LIFECYCLE_SESSION_RETAINED`). Controller regressions (abort overlapping a replacement; a signal callback already waiting on the lock while another up adopts; a startup whose second process fails with an unconfirmed stop, through `startLifecycleProcesses`), module tests and e2e overlap variants. |
| `DownMark` / `DownStop` / `DownStopFailed` | `markSharedHelperInstanceStopping` once the down is committed; the stop controller reclaims the session through the persisted entry; `releaseProjectSharedHelpers` advances the generation again. When the session stop failed or is unknown (including an inspection that could not tell whether the session exists), `stopSessionBeforeReleasingHelpers` keeps every holder, configured or recorded, and down, restart and native retirement fail (`DownStopFailed`). Unit regressions for both outcomes. |

The positive configuration checks all four invariants and exhausts 7,649 distinct states
(TLC 1.7.4, Java 17, no fairness, `CHECK_DEADLOCK FALSE`). Each control disables one
fix through a constant and must fail with a named same-state witness:

| Control | Fix disabled | Fails | Witness |
| --- | --- | --- | --- |
| `negative` | `CheckEpoch` (creator kills by token alone) | `SessionSafe` at `Succeed` | `a` created, `b` adopted, `a` failed and killed it, `b` succeeded: `session = "absent"`, `epoch = <<"b", "adopted">>` |
| `no-revalidation` | `Revalidate` | `Reclaimable` at `Publish` | `a` created and finalized meanwhile; `b`'s stale create decision overwrites the entry: `token = "a"`, `entry = "b"` |
| `epoch-failure-unstopped` | `StopOnEpochFailure` | `Reclaimable` at `RecordFailUnstopped` | the entry is removed while the created session lives: `token = "a"`, `entry = "none"` |
| `stale-finalize` | `FinalizeRecheck` | `Reclaimable` at `Finalize` | `b` replaced `a`'s pending session (token `b`); `a`'s stale finalize publishes its own token: `token = "b"`, `entry = "a"` |
| `abandoned-create` | `AbandonCreate` (call not settled before the lock is released) | `Reclaimable` at `LateCreate` | a down retires the pending entry while `a`'s creation is still running; it then creates the session: `token = "a"`, `entry = "none"` |
| `abandoned-replace` | `AbandonReplace` | `SessionSafe` at `LateKill` | `b`'s replacement released the lock with its stale read pending; `a` created and succeeded; `b`'s name-based kill stops `a`'s session |
| `timeout-as-absence` | `MisreadTimeout` | `Reclaimable` at `Publish` | a timed-out listing reads `a`'s live session as absent; `b` publishes over it: `token = "a"`, `entry = "b"` |
| `unlocked-failure-cleanup` | `UnlockedFailureCleanup` (cleanup kill after the lock is released) | `SessionSafe` at `LateKill` | `a`'s epoch record failed and its cleanup read the token; `b` replaced the pending session, created and succeeded; `a`'s name-based kill stops `b`'s session |
| `unfenced-launch` | `UnfencedLaunch` (launch by name without lock and token check) | `NoForeignLaunch` at `StartProcesses` | `b` replaced `a`'s pending session; `a`'s next launch lands in `b`'s session: `foreign = TRUE`, `token = "b"` |
| `release-on-failed-stop` | `ReleaseOnFailedStop` | `HelpersKeptForSession` at `DownStopFailed` | the down's session stop failed with `a`'s session alive; the holders are released anyway: `released = TRUE` |

Bounds and assumptions: two ups, each running once; one down. `Decide`, the three
creation steps (with environment setup), `Record`, its failure cleanup,
`StartProcesses` and `Finalize` are lock-held steps; the container launch steps are
not. Environment setup has no step of its own because it runs inside the creation
transaction. `Decide` is one step because the source holds the lock
across inspect and record. Every mux call made by the lifecycle controller and the
tmux/zellij backends is bounded by `runMuxCommand`: the caller stops waiting
within the bound (a timed-out client is killed), and a timed-out call is unknown,
never absence. That does not prove the server will not still apply the command;
see the timeout residual below. The model covers tmux only: projects with shared
helpers refuse zellij for their lifecycle session, both before any hook runs
(`assertSharedHelperSessionMuxSupported`) and again at the backend the controller
actually selects (`MuxBackend.createsWithOwnerToken`), so a selection that changes
while hooks run is refused too, because zellij records the ownership
token with a separate `rename-tab` after creation, so an interrupted start could
leave a live session without a token that neither `hack up` nor `hack down` can
reclaim. tmux sets the token as part of `new-session` (`-e`), which is what
`CreateSession` and `CreateTimeoutCreated` assume. Helper ensure/holder counts, helper rollback
ownership (the operation record), the acquired-helper record and claim-level stop
confirmation are not modeled; the shared-host claim protocol has its own fixtures in
`tests/shared-host-lifecycle.test.ts`. `DownStop` joins the down's session stop and
its release into one step. In the implementation an up that captured after the
down's stopping mark can still succeed between the down's session stop and its
release; that is the documented first-slice limitation (launch prevention across a
concurrent down is detected after launch, not prevented). Real mux sessions,
process groups, lock-file durability and Compose behavior are outside this model.

Timeout settlement is an assumption of the positive model, not a guarantee of the
code. `CreateTimeout*` treat a call as settled once `runMuxCommand` killed its
client. Killing the client does not prove that the tmux server will not still apply
the command: commands queue per client, so a command a stalled server already
received may run after it answered a later client. The `abandoned-create` and
`abandoned-replace` controls are that residual, and they fail. It needs a tmux
server that stalled past the deadline and then ran the dead client's command after
answering a later client; every call made while the server stays stalled also
times out and fails closed. What the code guarantees is weaker than the positive
model in that case. Consequences per late command, all for the same instance (one
project and branch):

- create (`new-session`): a session that carries the failed start's token, possibly
  without an entry. No lifecycle process runs in it, because launches only follow a
  confirmed create. The next `hack up` refuses it ("already exists without matching
  Hack lifecycle state"); stop it by hand. Helper holders are not affected.
- name-based kill (replacement, cleanup, down): it may stop a newer, successful
  session of the instance, so `SessionSafe` does not hold for that start. Its entry
  remains, so `hack down` and the next `hack up` reclaim or recreate it: recovery,
  not prevention.
- environment, window or pane commands: they may reach a newer session of the
  instance after its ownership check, so `NoForeignLaunch` does not hold for that
  start; its `hack down` stops the whole session.

Closing the residual needs a mutation fence rather than a timeout: target tmux
mutations by session ID (`#{session_id}`, never reused by a server) captured with
the token read. That fence, and full zellij support for shared-helper lifecycle
sessions, are tracked in HACK-1849 and are not in this slice.

## Multi-root pool shares

`multi-root-share/Shares.tla` models one development pool that hosts several
project roots. The share set is the pool's mount intent. It changes only through
the journaled stopped-pool update in `provider::share_update`: the provider record
commits before the owner receipt, and startup refuses while the journal exists.
Boot mounts exactly the audited set. A graph binds only the share whose root equals
its own reviewed source, and a share stays while any graph of that project is live
or retained.

The positive configuration (three roots, a two-share bound) exhausts **55 distinct
states**. Four guard-removal controls must fail at the named action with the exact
same-state witness: `negative` (a graph may select any mounted share) fails
`OwnShareOnly` at `StartGraph`; `unfenced-boot` fails `RunningMountsAudited` at
`Boot`; `owner-first` fails `OwnerNeverAhead` at `CommitOwner`; and
`referenced-removal` fails `ReferencedSharesKept` at `CommitRecord`. The controls
check two roots (`a`, `b`), so no symmetric third root can stand in for `b`.
TLC's two-worker search also does not always report the shortest trace, so each
control accepts exactly the first violations its model can reach (9, 12, 4 and 2
complete states). They were enumerated from each control's complete state graph,
restricted to steps from states that still satisfy the invariant, and are listed in
`scripts/lib/tla-runtime-models.ts`.

| Model operation | Source boundary |
| --- | --- |
| `BeginAdd` / `BeginRemove` | `share_update::plan`: owned stopped pool (`network_update::stopped_with`), primary share kept, bounded set, removal refused while a graph record names the share (`require_unreferenced`). An interrupted add resumes from its recorded share without a live root check (`addition`). |
| `CommitRecord` / `CommitOwner` / `Finish` | `network_update::apply_record`, then the owner save, then journal removal; `validate_sides` refuses an owner ahead of its record. |
| `Boot` | `share_update::require_complete`, `project_share::check_boot` and `config_audit` mount verification before `machine start`. |
| `CleanGraph` | One run's own cleanup; a native receipt that the pool owner proves `Removed` (`graph::native::retired`) no longer counts as a reference. |
| `StartGraph` | `OwnedGuest::project_share_for(plan.source)` in shared source selection; `ProjectShareIntent::bind_path` keeps every bind under that share. |

The model does not cover provider behavior: that the pinned provider mounts an
updated record at the next boot, virtio-fs device limits, or live multi-project
graphs on a host VM. Cleanup is abstracted to one run's own resources.

## Native image build retention

`native-build-retention/BuildRetention.tla` follows `provider::image_build` and its
`reclaim` module for one build key in one namespace, with three content IDs and two
storage incarnations. The positive configuration exhausts **6,181 distinct states**.

| Model operation | Source boundary |
| --- | --- |
| `BeginBuild` | Under the provider lease: shared build fence, per-key lock, `building` receipt. |
| `RunBuild` / `ForeignImage` | Unleased BuildKit run writing an image with this pool's labels; a forged or foreign image may appear at any time. |
| `CompleteBuild` | Under the lease: the reported ID is adopted only with this incarnation's labels and the admitted incarnation; otherwise `failed`. |
| `Cancel` / `CrashHost` / `RecordDeadAttempt` | Cancellation and host death release the fence; a `building` receipt under the key lock is recorded `indeterminate`. |
| `Down` / `RecreateStorage` | `runtime down` refuses while the fence is held; recreated storage is a new incarnation with an empty engine. |
| `StartGraph` / `RemoveContainers` / `Restore` | Graphs use only a verified image of this incarnation and keep a reference to it; data-retaining cleanup removes containers but not the reference; restore never builds. |
| `Reclaim` / `PruneCache` | Owned, non-current, unreferenced, unused images only, with no build admitted; cache pruning never touches images. |

Three controls each remove one guard and must fail at the named action:
`negative` (reclaim ignores retained references) fails `NoReclaimReferenced` at
`Reclaim`; `foreign-adoption` (adoption without the label/incarnation check) fails
`NoForeignAdoption` at `CompleteBuild`; `down-under-build` (down ignores the fence)
fails `DownNotUnderBuild` at `Down`. The model does not cover a build client that
outlives a killed `hack-native` process (the implementation keeps the fence and key
lock held by the inherited descriptors until that client exits), real BuildKit or
engine behavior, receipt durability, or more than one key and namespace.

`shutdown-rebase/ShutdownRebase.tla` covers retained stop evidence across removed
and recreated services. Its 43-state positive bound separates stopped history,
evidence reset, receipt publication and crash/retry. The two negative controls
remove reset and fresh old-ID absence respectively. Source mapping, regression
coverage and native proof limits are in `docs/reference/v5-model-coverage.md`.

## Foreground port publisher shutdown

`native-publisher-stop/PublisherStop.tla` bounds one graph and publisher, one
owner crash, one incarnation replacement and one audited successor boot. Its six
initial states include live ready/enrolled owners and the actual legacy state:
a dead owner with an exited or still-live publisher on either admitted boot. `Interrupt` maps to the
frontend's group isolation; `StopPublisher` abstracts authenticated control plus
kernel exit proof; `Recover` pins the exact old owner/coordinator/inventories;
`ReleaseBridge` maps to confirmed publisher/guest-helper retirement and registry
release, before `CleanupGuest` removes compute. `Retire` represents command success
after compute absence, publication retirement and dependency-reservation release
are verified. Publication archival itself is abstracted and may precede dependency
release in the implementation. `ReleaseDependencies` is separate from guest completion: an
interrupted release is retried during `retire_recovered_publisher` under the exact
retired owner, completion digest, provider lease and any enrolled host-pin guard. A failed or stale proof preserves capacity and evidence.
The positive configuration explores 168 states. The two guard-removal controls
must violate `NoUnsafeCleanup` at `ReleaseBridge` and `NoInterruptRace` at
`Interrupt`. The `NeverComplete` control must reach `Retire`, establishing that
the positive guards permit completion. A fifth configuration removes the
frontend lifetime watch and must violate `NoSilentOrphan` at `FrontendLost`.
A sixth configuration omits reservation release before `Retire` and must violate
`NoStrandedReservation` with `reservation = TRUE`. Real reservation-file tests
check capacity reuse, idempotent retry, stale-process refusal and preserved bytes
when the caller fence fails. The predecessor VM fixture also pauses after the
completion commit for its dependency-free project; it covers publication retry,
not reservation release. The real-file reservation tests execute on macOS CI.
A seventh configuration omits committed owner exit proof and must violate
`NoUncommittedExit` at `ReleaseBridge`. SIGHUP follows the same stop transition
as SIGINT/SIGTERM. `PublisherCrash` enters `publisher-exit-pending`: the port is
down but the child stays unreaped while the provider lease is busy. `CommitExit`
binds its identity and persists proof before entering `publisher-down` and
announcing. Services stay up until explicit stop or frontend loss. Lease contention
may stutter indefinitely; signals and control remain available. Notice emission
is abstracted with the successful commit; stream framing and ps port projection
are implementation-test obligations. Notices begin only after readiness is
flushed; startup reaping does not emit a notice or grant readiness. An early
notice must not interrupt startup cleanup or hide its failure diagnostics.
Notice delivery can fail after frontend
loss without gating cleanup; a closed-stream implementation regression covers
that boundary outside the model. Watch delivery plus stop initiation and
exact child reaping plus durable journal publication are atomic assumptions; native event/reaping tests exercise these boundaries.
No fairness/eventual recovery is claimed.
Atomic journal steps, identity and exit observations are assumptions here; real
process tests, legacy journal and opt-in published-port VM fixtures, source
compilation and Apple Silicon VM qualification remain separate evidence. This
model abstracts the audited predecessor-boot proof and does not cover provider-loss
detection, concrete boot identity, host frontend hooks or filesystem power-loss
durability.

The model collapses the stopped receipt and recovery-intent completion commits.
It does not check frontend dispatch between them. TypeScript predecessor-recovery
tests cover stopped receipts with pending, completed and absent completion hints;
Rust `current_recovery_dispatch_does_not_select_historical_completion` checks the
exact completion digest rather than treating a stopped receipt as completion.
Publication-registry sync/rename is also abstracted: portable retirement tests
exercise the real writer's synchronized pending-removal boundary, fenced
reconciliation and unchanged evidence on refusal. The opt-in legacy VM fixtures
interrupt this registry commit on both admitted boots, and the predecessor
fixture also interrupts between stopped receipt and intent completion.

The publisher model permits reselecting a same-boot intent on the successor boot
as a permissive safety abstraction. The implementation refuses that unfinished
cross-boot takeover; the qualified predecessor slice starts from the legacy
Ready/Pending state before any new recovery intent. No completion claim covers
that abstract reselection. `startup::cleanup_guest(..., false)` checks startup
artifacts/listener state without removing containers; bridge release then
precedes `shutdown::stop_owned` and container DELETE in `cleanup_owned_fenced`.


A new owner process for a retained run receives a distinct native-incarnation
control generation in its startup receipt. Legacy receipts still select their
original deterministic path. This avoids admitting a new owner into an old
pending coordinator's directory; it does not acknowledge or roll over that
coordinator. Directory derivation and a real coordinator start/stop regression
cover this restored-owner boundary outside the finite publisher model.

## CLI process exit

`cli-process-exit/ProcessExit.tla` checks how the CLI process ends
(`src/lib/process-exit.ts`, `index.ts`): the command returns, `exitWhenDone`
waits for registered holds, ends stdout and stderr, then exits. Invariants:
`NoExitWithPendingHold` (the process never ends while held work runs, including
a hold registered while waiting) and `NoLostOutput` (everything written before
the exit was delivered).

| Model operation | Source boundary |
| --- | --- |
| `Register` / `Settle` | `holdProcessUntil`: the stdio MCP session and each tool call, the foreground daemon, TUI and remote monitor renderer `closed`, TUI action child plus its stderr drain. |
| `CommandReturns` / `SnapshotSettled` | `runCli` resolves; `waitForHolds` awaits a snapshot and loops while holds remain. |
| `EndStreams` / `Exit` | `endStream` on stdout and stderr (`end` callback), then `process.exit`. |

Bounds: three holds. The positive configuration exhausts 298 distinct states at
depth 11. Controls: `negative` (wait for one snapshot, no re-check) fails
`NoExitWithPendingHold` at `SnapshotSettled`; `no-end` (exit after
`write("", cb)` instead of `end`) fails `NoLostOutput` at `Exit`. The second
matches a measurement: with `write("", cb)` only 950 KB of a 2 MiB pipe write
arrived. `tests/process-exit.test.ts` walks both against real processes. Not
covered: whether every command that outlives `runCli` registers a hold (an
audit, listed in the PR), and a reader that never drains (the exit waits, as
the event loop did before).

## Global proxy address record

`ingress-address-record/IngressRecord.tla` checks the record `hack run` trusts
instead of asking Docker for the global proxy and DNS addresses
(`src/lib/proxy-ingress-addresses.ts`). Invariant `TrustedRecordIsCurrent`: a
record a run would trust names the running address, unless a change made
outside Hack followed the observation it came from.

| Model operation | Source boundary |
| --- | --- |
| `HackBegin` / `HackApply` / `HackEnd` | `withIngressChange` around `hack global up` (`runGlobalUpChange`), the proxy `down` in `hack global down`, and the doctor proxy repair: under the `ingress-change.lock` cross-process lock, an unsettled new token, the Compose effect, a settled new token (also after a failure). |
| `Crash` | The changer's process dies: the lock is reclaimed from a dead owner only, and the token stays unsettled until the next change settles it. |
| `ReadToken` / `Inspect` / `Write` | `resolveIngressAddresses(..., "fresh")`: the token is read before the one `docker inspect`; a read that finds both containers writes the record with that token; one that reaches the engine and finds a container gone removes it. |
| `Valid` | `resolveIngressAddresses(..., "recorded")`: trusted only when the record's token is the current one and settled. |
| `External` | A container recreated outside Hack. Not detected; a failed `hack run` checks once and refreshes. |

Bounds: two concurrent readers, two changers that each run once and may
crash at any step, addresses {stopped, 1, 2}, `MaxGen = 4`. The positive
configuration exhausts 922,875 distinct states at depth 19 (about 12 s with
two workers). Negative controls, all failing `TrustedRecordIsCurrent` at
`Write`: `negative` (no generation check) and `unsettled` (validity ignores the
settled flag), where a reader inspects while a change is in progress and the
change stops the stack; and `unlocked` (changes not serialized), where one
change settles the token while the other is still moving the containers. The same interleavings are walked
against the real record and token files in `tests/proxy-ingress-addresses.test.ts`.
Not covered: atomicity of the file writes themselves (each is an atomic rename),
Docker's own answers, and the stored per-instance override file, which is
rendered from whatever addresses the command resolved. The model has one
Docker engine; in the code a record is also trusted only for the engine it
was read from (`engine`: `DOCKER_HOST`, else the Docker context), which
`tests/proxy-ingress-addresses.test.ts` and
`tests/compose-exec-run-probes-cli.test.ts` cover.

## Runtime service per native home

`runtime-service/RuntimeService.tla` is the design model for HACK-2460: one
long-lived runtime service per native home, started on demand by its clients,
with today's one-process-per-request path kept as the fallback. Each slice that
builds one of its actions adds the test that walks it. Two clients (one of each
build) each send one mutation with an intent id, over at most two connections
each. Up to three service processes start, bind, lose the start race, crash at
any step, exit when idle, or drain after a client of the other build asks them
to retire.

Frames and replies belong to connections. A written frame stays in the
receiving process's buffer until that process reads it, whether or not the
client is still connected, and its reply reaches the client only on that same
connection. The client counts the frames it wrote that were not refused to it
before admission (`unsure`); fallback needs none. The effect is observable as
none, started or complete, and work that started may complete after its process
died (`Settle`). Inspection reads only that: complete is "done", none is "not
done", started is "unknown". It sees no process's memory, so without a service
it starts only while no process holds `service.lock`; a process that takes the
lock later has none of the old frames and never resumes an accepted intent.
After the serving process answers "accepted, no live attempt", its intent record
answers any later frame with that id.

The model makes dispatched work visible as started in the same step. An
implementation must not rely on that: each mutation's inspector distinguishes
proven absence from missing evidence (for example work a provider accepted but
has not yet made visible), and missing evidence yields "unknown", never "not
done".

State charts: [one service process](../../../docs/diagrams/runtime-service-process.svg) and
[one client mutation](../../../docs/diagrams/runtime-service-client.svg) (Mermaid sources beside them).

| Model operation | Planned source boundary |
| --- | --- |
| `Spawn` / `Connect` | The client connects, and on `ENOENT` or `ECONNREFUSED` starts the service detached with the closed environment. |
| `TakeLock` / `Bind` / `LoseRace` | `service.lock` (exclusive `flock`) is taken before a stale socket is removed and the socket bound; a loser exits and the client connects to the winner. |
| `Admit` / `Join` / `AnswerDone` / `AnswerUnknown` | The intent record is written and synced before any effect. A resent id joins a live attempt (its reply then answers both connections), gets the recorded result, or gets "outcome unknown". |
| `RefuseDraining` / `Retire` / `ExitDrained` | A draining service unlinks its socket, refuses frames it never admitted, finishes its own attempts and exits holding the lock until then. |
| `Begin` / `Finish` / `OneShotBegin` / `OneShotEnd` / `Settle` | The effect runs under the provider lease shared with one-shot processes; started work may complete without its process. |
| `Fallback` / `InspectWithoutService` / `StartInspect` / `Inspect` | The one-shot path only with no unsure frame; inspection without a service only while the lock is free; inspection reports what it observes. |

The positive configuration exhausts 1,006,849 distinct states and checks
`LockedOwner`, `OneOwner`, `AtMostOnce`, `SameBuild`, `ReportHonest` and
`NoEffectWithoutIntent`. Each guard-removal control must fail at its named
action with the same-state witness:

| Control | Guard removed | Fails |
| --- | --- | --- |
| `negative` | lock before bind | `LockedOwner` at the first `Bind` |
| `effect-before-accept` | intent record before the effect | `AtMostOnce` at `Begin` |
| `no-dedupe` | resent intent answered, not re-run | `AtMostOnce` at `Begin` |
| `fallback-after-send` | fallback only with no unsure frame | `AtMostOnce` at `OneShotBegin` or `Begin` |
| `ignore-skew` | another build never runs a mutation | `SameBuild` at `Admit` |
| `inspect-while-held` | inspection only while the lock is free | `ReportHonest` at `Begin`, after "not done" |

Four reachability controls must reach "outcome unknown" (`NeverUnknown` at
`AnswerUnknown`), an honest "not done" (`NeverNotDone` at `Inspect`), an
inconclusive inspection of started work (`NeverInconclusive` at `Inspect`) and a
completed one-shot fallback that frees the lease (`NeverOneShotDone` at
`OneShotEnd`), so none of those paths is vacuous.

Not covered: liveness (a command finishes, a drain ends); more than one intent
per client; several leases; the per-project owners, start graph and engine (an
effect is one abstract step with three observable states); joined-attempt
cancellation; event streams and cursors; dashboard authentication; the
idle-exit race between closing the listener and a queued connection (atomic
here); socket path attacks, uid checks and frame parsing; the version order
(any skewed client may retire any service); and durability of the intent write
itself.

## Global logging opt-in

`global-logging-optin/LoggingOptIn.tla` checks when Hack runs the global
logging stack (Loki, Alloy, Grafana): `src/lib/global-logging.ts` and
`hack global install` / `up` / `down` in `src/commands/global.ts`.
`logging.enabled` decides when set; unset is on only for a home that has the
stack's directory (`~/.hack/logging/`), which every install before opt-in
wrote, and the first manual install or up in such a home saves `on`.
Any save may fail (`SaveMayFail`): the run then uses its choice anyway, so
routing is not blocked, and warns that it was not saved; `unsaved` records
that warning until a later save.

| Model operation | Source boundary |
| --- | --- |
| `On` | `resolveGlobalLogging`: the config value, else whether `logging/` exists. |
| `Saved` | `resolveAndSaveGlobalLogging` (via `settleGlobalLoggingSetting`): an existing home's first manual install or up writes `logging.enabled: true`; login only reads. |
| `SaveOrReport` | The same save, and the `--logging`/`--no-logging` save in the `global up` handler: a failure keeps the setting, warns "was not saved", and the run follows the choice (`saveError`, `loggingOverride`). |
| `Install` | `globalInstall`: `materializeGlobalInstallFiles` writes the logging files only when on, then `runGlobalUp`. |
| `Up` / `UpWith` | `runGlobalUp`: on writes missing files (`materializeGlobalLoggingFiles`) and starts the stack; off stops its containers found by their Compose project label (`stopDisabledLoggingStack`), with or without its files. |
| `UpFlag` | `hack global up --logging` / `--no-logging`: saves `logging.enabled`, then `runGlobalUp`. |
| `Set` | `hack config set|unset --global logging.enabled` (no Docker effect). |
| `MoveFiles` / `MoveDir` | The compose file, or the whole directory after a first start, moved aside by hand. |
| `Down` / `Reset` | `hack global down` (`compose down`, volumes kept) and `hack global logs-reset` (`down -v`). |

Invariants:
- `FreshNeverStartsUnasked`: a new home runs the stack only after someone turned it on.
- `ExistingHomeKept`: after a start, a home that had the stack still has it unless someone turned it off or cleared the setting, even with its files moved aside.
- `OffMeansStopped` and `NoOrphanedStack`: after any start, a running stack is one the setting says is on.
- These three hold unless Hack warned that this home's choice was not saved (`unsaved`): then the run followed a choice the setting does not hold yet.
- `NoSurpriseDataLoss`: logs disappear only in a `logs-reset` step. `prevData` is `data` before the step, so this step property is an invariant.

Bounds: one home that is either from before opt-in (directory, compose file, logs, running or not) or new; every command, setting change and move, in any order. Every save may fail. The positive configuration exhausts 1,014 distinct states at depth 7.

Controls:
- `negative` (install writes the logging files whatever the setting) fails `FreshNeverStartsUnasked` at a new home's first `Install`.
- `legacy-unset-off` (unset means off) fails `ExistingHomeKept` at `Install` or `Up`.
- `off-removes-volumes` (off is `down -v`) fails `NoSurpriseDataLoss` at `UpFlag`.
- `decision-not-saved` (the first start does not save `on`) fails `ExistingHomeKept` once the logging directory is moved aside.
- `unsaved-silent` (a failed save is not reported) fails `OffMeansStopped` at `UpFlag`: `--logging` ran the stack while the setting stayed off, and nothing said so.

Writing the model found two code gaps, fixed with it: stopping only when the compose file existed, and keying the decision on that file rather than on the directory.

Tied to the code: `tests/global-command.test.ts` ("the opt-in logging stack") walks the same paths with a stub Docker, and `tests/global-logging.test.ts` the resolution and save rules.

Not covered:
- readiness (healthchecks, their bounds and the end-to-end route probe are in `tests/global-stack-state.test.ts` and `tests/global-readiness.test.ts`);
- the login path, which only reads the setting and starts routing;
- a home whose whole logging directory is removed before its first manual start, which then counts as new.
