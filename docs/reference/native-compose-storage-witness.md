# Native Compose storage witness foundation

This is an internal protocol foundation. The CLI still uses the metadata guard
described in [ownership](native-compose-ownership.md). It does not yet enroll or
enforce these witness references. Identical volume labels, name and `CreatedAt`
remain insufficient to detect an empty replacement in the shipping path.

The candidate protocol binds a random marker leaf and independent 256-bit token
to the engine, instance owner, physical volume name, logical storage, admitting
generation and pending operation token. Marker names, contents, hashes and private
paths must stay out of public receipts, errors, argv and logs. A marker detects a
replacement that lacks the enrolled witness; it does not prove all database bytes
are intact, and a copy containing the original witness is outside this guarantee.

`prepareNativeComposeStorageWitness` runs under the existing generation mutation's
opaque material authority. The caller must prove either that the selected new
volume is genuinely absent or that an explicit adoption selected an exact stopped
volume. Adoption records the current birth but cannot prove historical continuity.
It creates an immutable private expectation with exclusive publication, file
synchronization and directory synchronization before any provisioning or seed
callback. An existing slot, including an empty interrupted slot, refuses. The
expectation is never deleted or replaced to admit a retry.

`enrollNativeComposeStorageWitness` consumes the same invocation's opaque
capability before awaiting effects. The transport must refuse an existing marker
path, symlink or special file rather than overwrite it. After one seed attempt,
fresh read-only observation must match the exact marker and volume metadata. Only
then does the owner append and synchronize an immutable completion record. The
private reference pins both directory identities and both journal file identities
and hashes. The current generation and pending token are rechecked around each
publication. Copied, reused or revoked capabilities cannot authorize another seed.

`verifyNativeComposeStorageWitness` reads and compares those records and the
observed marker. It does not create, write, delete or repair storage. Missing or
changed metadata, content, completion, engine or private journal identity refuses
before the caller's workload action. A pending expectation after interruption
remains uncertain even if a matching marker was written. There is no automatic
promotion or seed replay. Explicit reconciliation of such an expectation is a
separate recovery contract; saved resource stop must retain its witness anchor.

The archive codec accepts one bounded regular USTAR member with the exact random
leaf, permissions and token. It rejects encoded links, special files, extensions,
extra members, bad checksums and nonzero padding, and extracts nothing on the host.
Rejecting an encoded hardlink is not a claim about the daemon's file link count.

Activation requires a new mandatory receipt version with immutable references and
an enrollment intent anchored before effects. Existing v1/v2 readers must refuse
that format. Resume must never infer enrollment from metadata, scan arbitrary
marker names, or auto-enroll a legacy volume. Private state for failed, pending and
completed generations must remain monotonic through stop and recovery.

A stopped, unstarted owned carrier with a read-only volume mount is a possible
Docker read transport. It would need an exact already-selected local image ID,
no pull or start, `volume-nocopy`, complete accounting for image-declared volumes,
bounded output and deadlines, exact carrier ownership and saved cleanup. Docker
copy alone does not provide an exclusive marker write. That enrollment boundary,
carrier creation uncertainty, normal and explicit recovery, compiled CLI coverage
and real engine acceptance remain required gates. No carrier or helper download is
implemented by this foundation.
