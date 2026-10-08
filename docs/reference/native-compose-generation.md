# Private native Compose generations

The native Compose generation store is an internal execution boundary. It does
not start Docker, render workload policy, decrypt environment values, or implement
CLI dispatch. A caller must admit supported features and verify engine ownership.

`openNativeComposeGenerationStore` verifies the native checkout family and real
checkout/configuration directories. Explicit instance selection produces a stable
Compose project namespace. Real linked Git worktrees share verified repository
identity while retaining separate checkout/instance namespaces.

Preparation runs inside `withMutation`. `reserveGeneration` allocates a random
generation ID before rendering so the renderer can stamp reserved labels. `publish`
checks that reservation, reserved delivery identity and the document budget, then
synchronizes one private immutable `compose.json` and its manifest. Directory
permissions are `0700`; private files are `0600`. Current/pending receipts anchor
the exact manifest and document device, inode and digest. Input revisions and
document digests stay in private files. The private generation handle exposes its
non-enumerable immutable input revision only for saved down-hook binding validation; public
reports and engine labels omit it.
All rendered resources also carry the exact random store owner nonce, so a new
store cannot silently adopt resources with the same stable Compose namespace.
Container resources carry the reserved workload discriminator `service` or `job`
for the adapter's saved readiness checks. The store does not infer readiness.
A verified private `.gitignore` excludes generated state from normal Git staging.

The first verified persistent-volume observation upgrades the private instance
receipt to version `2`. It records each physical name, logical storage key and
Docker `CreatedAt` value under the existing mutation lock. These facts survive
`down`, new generations and removed mount declarations. Later observations may
add volumes, but cannot forget or replace recorded storage. Intent publication
and completion retain the freshly recorded facts; public command results omit
them. Missing storage or a changed birth refuses resume before Compose can
create an empty replacement. A genuinely cold instance may create its first
volumes.

Version `1` receipts have no historical birth evidence. Their saved declared
volumes must exist before any new effect, and the first verified observation
records their current birth. This cannot prove that a same-name replacement did
not happen before that first observation. Older clients refuse version `2`
receipts; do not remove or edit private receipts to force a downgrade. The birth
fence trusts engine metadata and cannot protect against a hostile daemon or an
administrator recreating the same metadata. No volume deletion or automatic
data-loss repair is added.

Verified readiness and one-off ownership observations also feed this storage
history. If a later readiness, route or child-completion check fails, the store
retains already verified birth facts without treating the operation as complete
or starting another probe of the uncertain child. Its pending effect remains
available only for explicit recovery.

`runEffect` verifies generation identity, invokes caller freshness and ownership
checks, and synchronizes a pending intent before calling the effect. Checks repeat
at the effect boundary. Only a caller-confirmed complete postcondition clears
intent; engine status alone does not establish it. Thrown effects, uncertain
returned outcomes, and failures in completion verification retain intent and block
automatic replay. A nonzero requested one-off command can still be complete after
the adapter verifies its removal and owned dependencies.
A complete cold `run` saves its generation for later observation and retained-data
stop. A run using the current saved generation preserves that anchor; the store
refuses another generation while a current anchor exists. The adapter requires
the exact saved document and explicit `up`/`restart` for input changes.

`publishRunProjection` derives a one-off document from the verified saved artifact
inside the mutation lock. It accepts a target service, never caller-supplied JSON.
The projection removes routing keys on that target and the saved route extension;
it preserves the original generation and all other delivery fields. Random
projection identity, source anchor, document hash and file identities remain in
private `oneoffs/<id>/` files under that generation. `runEffect` accepts only the
exact returned projection handle for a `run`; it verifies the actual projected
file before and after effects and records its private anchor in pending intent.
Inputs and delivery files are rechecked after potentially slow engine ownership
observations, immediately before intent or effect entry. This still cannot freeze
arbitrary outside edits atomically.

Failure or interruption retains the projection and recovery intent. Saved stop
continues to use the original generation, without requiring fresh environment
delivery or accepting the projection for replay. Projection files and manifests
can contain private values or their hashes; never log or publish them. The store
does not prune them or delete persistent data.

Saved mode reads only saved ownership state and Git/filesystem identity. It neither
reads authored contents nor resolves environment values. `loadCurrent`,
`loadPending` and `withLease` support pinned observation. A retained-data `down`
uses saved generation identity. The adapter may opt into fresh finite down hooks
only when the immutable document carries their saved source-selection binding.
Explicit recovery and generations without that binding require no current credentials. Explicit
pending recovery records a recovery token and clears uncertainty only after the
caller verifies its owned stop completed. No store API deletes persistent data,
prunes generations, or removes abandoned leases.
`readGenerationDocument` verifies the pinned artifact before returning its private
parsed contents for workload/readiness inspection. Call it within a generation
lease; never serialize or log that object because it includes delivered values.

An interrupted writer's lock is never reclaimed automatically. Explicit
`recoverInterruptedLock` supports macOS and Linux on the same host boot: the
private owner receipt carries PID, UID, process birth, boot ID and a random token.
Recovery uses a separate exclusive guard, rechecks exact lock/receipt identities,
and requires fresh process absence checks. Live or reused PIDs, unknown inspection,
malformed/empty owner publication, prior boots, extra lock files and interrupted
recovery guards refuse, including a guard left after the mutation lock was removed.
Ordinary mutation admission honors that guard. Recovery removes only the verified dead writer's lock;
the pending engine intent still requires explicit owned inspection/stop.

This is cooperative serialization with held directory descriptors and repeated
filesystem/freshness checks. It cannot atomically freeze arbitrary external edits
or defend against a hostile process with the same user authority. Filesystem
checks do not prove Docker resource ownership, readiness or application parity.
The command adapter must verify reserved engine labels and qualify the complete
native-only app/database/job lifecycle separately.

Finite native `up.before` hooks use `runBeforeHooks` under this same mutation lock.
It synchronizes a separate random hook-intent token before any command starts.
The receipt contains no command, PID, environment value or input fingerprint for
the hook. The execution owner may clear the intent only after a complete finite
result and verified process-group absence. A known nonzero exit can complete this
ownership check while still blocking engine startup. An exception, uncertain
result or interrupted completion retains the intent across reopen and prevents
preparation, generation publication and startup replay.

Finite `up.after` runs inside the existing engine mutation after exact workload
and route readiness and before the completed receipt. Private approval and value
acquisition precede its journal. The explicit after intent binds its random token,
phase, pending operation token, generation and `up`/`restart` operation; completion
must match every field before clearing it. Known finite failure clears only the
host intent and retains the pending engine effect. Uncertain completion retains
both. Final source/environment checks and workload/route readiness precede the
ready receipt; an after hook cannot rebind the running generation.

Finite `down.before` and `down.after` use a separate `downHooks` callback contract,
accepted only for a fresh normal down with current running generation, null pending
operation, null host intent and a freshness callback. Recovery never replays these
callbacks. Each intent binds phase, exact down operation/token and generation; an
up/run/recovery callback cannot clear it. The adapter captures both phases' private
values before the stop journal. Before failure prevents engine effects. After runs
only after exact owned engine/proxy absence while route claims remain held. A known
finite nonzero clears only its exact hook intent and retains stop pending; unknown
completion retains both. Completion requires null host intent at both receipt
checks around the finalizer. The finalizer rechecks source/env freshness and whole
owner/proxy absence before claim retirement; a later failure or crash preserves the
pending recovery generation, including the retirement/receipt publication gap.

Saved observation exposes `beforeHooksPending` for every phase and
`hostHookPhase`. A legacy token-only receipt decodes as an uncertain before
intent. Unknown phases refuse without rewriting or clearing the receipt.
Saved retaining down may
stop engine resources while preserving that hook intent, and the command reports
the remaining uncertainty. Recovering a verified dead mutation lock does not
recover hook execution. No API guesses ownership from a missing or reused PID,
kills a recorded hook process, or automatically clears interrupted hook intent.
The spawn/publication gap deliberately remains blocked until a later explicit
hook recovery contract can qualify it. Existing receipts without the optional
hook field read as having no pending hook; older readers refuse receipts they
do not understand.

Private dependent owners receive an opaque capability from the actual generation
mutation. Public identities, copied reservations and copied capability objects do
not grant that authority. Each assertion rechecks the held lock token and its owner
and directory inodes, the exact receipt written by this invocation, immutable
generation membership and the live pending operation. Inspection remains available
without granting effect or retirement authority. Source freshness checks may run
during the invocation's own finite after-hook phase; an uncertain saved hook does
not grant new acquisition or retirement authority.

The capability is revoked when the mutation callback closes. The lock remains held
until any registered material work settles, so escaped asynchronous work cannot
continue under a replacement lease. Dependent filesystem owners must use this
capability and the existing `beforeComplete` boundary; a serialized identity or
saved extension is only a selector for immutable state.
