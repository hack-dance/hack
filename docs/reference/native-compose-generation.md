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
document digests stay in private files and are absent from returned generation
identity and engine labels.
All rendered resources also carry the exact random store owner nonce, so a new
store cannot silently adopt resources with the same stable Compose namespace.
Container resources carry the reserved workload discriminator `service` or `job`
for the adapter's saved readiness checks. The store does not infer readiness.
A verified private `.gitignore` excludes generated state from normal Git staging.

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

Saved mode reads only saved ownership state and Git/filesystem identity. It neither
reads authored contents nor resolves environment values. `loadCurrent`,
`loadPending` and `withLease` support pinned observation. A retained-data `down`
uses saved generation identity without requiring current credentials. Explicit
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
