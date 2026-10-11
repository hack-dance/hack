# Native Compose storage witness foundation

This protocol foundation sits beneath the
[directory-xattr carrier](native-compose-storage-xattr-carrier.md) that ordinary
native Compose `up`, `restart`, `run` and storage-bearing saved `exec` use. It
adds content proof to the metadata guard described in
[ownership](native-compose-ownership.md): identical volume labels, name and
`CreatedAt` alone cannot detect an empty replacement, so the CLI enrolls and
verifies volume witnesses through that carrier.

The protocol binds a random marker leaf and independent 256-bit token
to the engine, instance owner, physical volume name, logical storage, admitting
generation and pending operation token. Marker names, contents, hashes and private
paths must stay out of public receipts, errors, argv and logs. A marker detects a
replacement that lacks the enrolled witness; it does not prove all database bytes
are intact, and a copy containing the original witness is outside this guarantee.

`prepareNativeComposeStorageWitness` runs under the existing generation mutation's
opaque material authority. The caller must prove either that the selected new
volume is genuinely absent or that an explicit adoption selected an exact stopped
volume. Adoption records the current birth but cannot prove historical continuity.
The generation owner first publishes a required version-three receipt containing
an `Expected` intent bound to the exact pending generation and operation token.
This precedes even creation of the witness slot, so a crash with an empty or absent
slot cannot fall back to an older receipt. It then creates an immutable private
expectation with exclusive publication, file
synchronization and directory synchronization before any provisioning or seed
callback. An existing slot, including an empty interrupted slot, refuses. The
expectation is never deleted or replaced to admit a retry.

`enrollNativeComposeStorageWitness` consumes the same invocation's opaque
capability before awaiting effects. The transport must refuse an existing marker
path, symlink or special file rather than overwrite it. After one seed attempt,
fresh read-only observation must match the exact marker and volume metadata. Only
then does the owner append and synchronize an immutable completion record. The
private reference pins both directory identities and both journal file identities
and hashes. A fresh read-only proof precedes attachment of that exact reference as
`Enrolled` in the version-three receipt. The current generation and pending token
are rechecked after the final filesystem await immediately before publication.
The owner privately issues and consumes a one-use completion proof bound to that
same live authority and generation. A fabricated reference or caller-supplied
no-op verifier cannot publish enrollment. Copied, reused or revoked capabilities
cannot authorize another seed or completion.

`verifyNativeComposeStorageWitness` reads and compares those records and the
observed marker. It does not create, write, delete or repair storage. Missing or
changed metadata, content, completion, engine or private journal identity refuses
before the caller's workload action. A pending expectation after interruption
remains uncertain even if a matching marker was written. There is no automatic
promotion or seed replay. Explicit reconciliation of such an expectation is a
separate recovery contract; saved resource stop must retain its witness anchor.
Explicit `down --recover` may stop saved engine resources, but returns incomplete
with `Expected` preserved, the pending generation retained and dependent ownership
retirement skipped. A stopped engine alone does not complete enrollment.

The archive codec accepts one bounded regular USTAR member with the exact random
leaf, permissions and token. It rejects encoded links, special files, extensions,
extra members, noncanonical raw numeric fields, bad checksums and nonzero padding,
and extracts nothing on the host.
Rejecting an encoded hardlink is not a claim about the daemon's file link count.

The required version-three decoder rejects missing, unknown or duplicate witness
entries, mismatched retained births and detached `Expected` bindings. Existing
v1/v2 readers refuse that format. An enrolled store requires fresh marker proof
before and after startup/run, including both final receipt boundaries. Missing
carrier authority refuses before a workload effect. Ordinary startup, run and
storage-bearing exec supply the Docker directory-xattr carrier; a daemon outside
the cataloged linux/arm64 and linux/amd64 platforms, or a missing cached helper
image, refuses before any hook, intent or volume effect. Resume
never infers enrollment from metadata, scans arbitrary marker names or auto-enrolls
a legacy volume. Failed, pending and completed witness state remains monotonic
through stop and recovery; storage capture never downgrades a v3 receipt.

The Docker directory-xattr carrier is the implemented transport: one fresh owned
helper container per proof, an exact cataloged local image ID, `--pull never`,
`volume-nocopy`, no image-declared volumes, bounded output and deadlines, exact
carrier ownership and saved cleanup. Docker copy alone does not provide an
exclusive marker write, so the archive codec below has no CLI carrier. Remaining
gates are PostgreSQL data roots, filesystem crash durability of the seeded
attribute, fresh-install acquisition of the pinned helper image, and daemons
other than linux/arm64 and linux/amd64, which refuse until their own artifact is
qualified. Explicit interrupted-enrollment reconciliation remains a separate
recovery contract. This foundation never downloads a carrier or helper. Store
and source-CLI tests use synthetic observation ports and engine transports; they
do not qualify Docker write or archive semantics.

The separate [directory-xattr owner and helper source](native-compose-storage-xattr-carrier.md)
uses a create-only token without a PostgreSQL data-root directory entry. Required
version-three expectation/reference records and tagged artifact/journal-bound intent keep
it distinct from USTAR under the same version-three receipt owner. It adds
injectable cold provisioning and fresh read-only proof ports. The Docker port
serves ordinary Compose startup, run and saved exec on the cataloged platforms.
PostgreSQL data roots and crash durability remain unqualified; a passing source
control is not runtime acceptance for them. Required finite carrier intent survives unknown
helper outcomes even after enrollment; saved recovery stops resources without
retiring that anchor. Its offline controls do not qualify a carrier.

Ordinary image-only `up` and `restart` can coalesce the opening and
closing witness checks within each of the two read phases immediately before
pending publication and effect entry. This applies only to already enrolled
directory-xattr storage with an exact unchanged storage merge, no hooks, build,
projection, recovery or newly declared volume. A speculative ownership read can
preview that merge but cannot publish it. A birth addition repeats the original
fully fenced path. Each qualifying phase keeps a fresh closing kernel proof and
exact source, generation and receipt-incarnation checks. No proof is reused across
pending publication or effects. Opening preparation, enrollment, pre-spawn and
both final receipt proofs remain separate. The one-volume offline counter is
three full proofs before effect entry rather than five; it establishes call
ordering and count, not CPU savings or atomic observation across the daemon and
private filesystem.

The one-off `run` path separately omits the enrollment-tail read that
would immediately repeat its mandatory pre-spawn witness read. `up` and `restart`
keep that tail read. Cold enrollment still seeds once and verifies before
publishing its enrolled reference. The one-volume cold-run control reaches the
actual pre-spawn boundary after eleven helper calls rather than fourteen; it
intercepts the workload there and does not qualify Docker execution or timing.
Post-effect generation and final receipt proofs remain separate.
