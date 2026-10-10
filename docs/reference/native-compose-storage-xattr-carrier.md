# Native Compose directory-xattr carrier source

The candidate Compose command path uses this Linux helper and the
[witness foundation](native-compose-storage-witness.md) under the existing instance
mutation. Persistent PostgreSQL and ordinary CLI acceptance remain required gates;
source wiring and synthetic controls do not qualify that runtime behavior.

Storage startup requires the exact cached Linux arm64 or amd64 Bun 1.4.2 helper
image selected by the daemon architecture before any authored hook, enrollment
intent or volume effect. The command never pulls a dependency or falls back to
emulation. Uncached first-install dependency acquisition remains unsupported by
this candidate. Image-only projects do not need the helper.

Known enrolled storage is verified before hooks, workload admission and completion.
Only an originally absent selected name with no retained history may enroll inside
the original startup transaction or original cold storage-backed `run`. Cold run
creation uses a separate `storage-create` authority bound to the same owner,
pending run token and generation, with no current generation or prior storage.
It cannot grant general material effects, explicit adoption, or another attempt
after its effect returns. Warm and stopped runs verify enrolled content only;
they cannot enroll newly selected storage. Existing unenrolled v1/v2 storage refuses even
when its volume is missing; it is never treated as cold or silently adopted.
Storage-bearing saved exec verifies under the existing mutation owner without
parsing authored source or creating an exec pending operation. A fresh finite read carrier is used
after an arbitrary-duration known exec or run; the final proofs are retained.
Cancelled saved exec preserves its known exit without starting a late helper or
claiming post-return proof. An unknown exec return is refused, and future
admission always re-verifies content.
Image-only saved exec keeps its read lease only when the saved document and receipt
have no selected or retained storage, witness, pending generation or unknown intent.
Saved down and explicit down recovery do not require the helper dependency and
never seed or replay enrollment. Expected or unknown helper intent remains an
incomplete retained recovery anchor.

The proposed directory xattr avoids adding a directory entry to PostgreSQL's
authored data root. It detects a replacement missing its enrolled random witness;
it does not prove database integrity or detect a clone containing that witness.
No `PGDATA` rewrite, root marker directory, package install or helper image pull
is part of this source.

## Fixed helper contract

`scripts/native-storage-witness-helper.ts` is the helper entry. The candidate CLI
uses its fixed bundled artifact. Qualification must bind this entry with its strict
codec and kernel adapter; an exact declared local Linux image, Bun executable,
libc and program digest must be checked before any carrier effect. The candidate
dependency is an explicitly selected local `oven/bun:1.4.2-slim` image. A tag
alone is not an artifact pin. Bun FFI remains experimental; source inspection and
mocked ports do not qualify its behavior.

The input is one canonical JSON record, at most 4096 bytes, with required
`kind: "directory-xattr"` and `version: 1`. Output is at most 1024 bytes. Names
contain `user.hack.storage.` plus 256 random bits; values contain an independent
32-byte random token. Both travel only through bounded stdin/private stdout,
never command arguments, inherited environment, public errors or Docker logs.
Every failure emits only the fixed refused response and returns a failure code.
The enclosing carrier must set `logging=none` before start and privately capture
both streams.

The only operations are metadata discovery, seed and verify. There is no
enumeration, replace, remove, repair or caller-selected path. Device and inode
facts use canonical unsigned 64-bit decimal strings; UID/GID are unsigned
32-bit integers. Unknown kinds/versions, alternate encodings, duplicate JSON
keys, trailing data and extra fields refuse. This format cannot be relabeled as
the foundation's USTAR proof or attached to its version-one completion reference.
Xattr expectations and references require version three, `kind: "directory-xattr"`,
exact image/platform/Bun/libc/helper and kernel-ABI pins, and a required private
carrier-journal token. Their version-three generation intent requires the carrier
tag, artifact pins and journal token even while Expected. Older strict owners
reject the new required fields; absence of a journal, artifact or tag cannot
downgrade to USTAR. The xattr helper wire format remains version one.

The Linux adapter fixes the root at `/hack-storage-witness`. It checks Linux
arm64 or x64 open constants and fixed architecture-specific glibc paths, uses
64-bit `size_t`/`ssize_t`, and checks the directory descriptor's close-on-exec
flag. It opens with `O_RDONLY | O_DIRECTORY | O_NOFOLLOW`, checks descriptor
metadata and requires real/effective credentials to agree. `O_NOFOLLOW` covers
the leaf; trusted image parents and the daemon-side source chain remain separate
mount admission requirements.

Seed requires the directory's exact UID/GID, calls `fsetxattr` with
`XATTR_CREATE` once, requires directory `fsync`, and rechecks root facts. An
existing attribute, including empty, wrong or matching contents, refuses without
overwrite. There is no write retry. A synchronization or close failure is an
uncertain attempt. A `seeded` response is not enrollment, durability proof or
generation readiness: the owner must obtain a separate fresh read-only proof
before publishing completion.

Verify requires matching credentials and root facts, performs two exact bounded
`fgetxattr` reads with intervening/final root checks, and closes the descriptor.
It never writes or synchronizes storage. Absent, empty, oversized, wrong or
changing bytes refuse. These observations are finite fences, not an atomic
guard against later changes or a hostile daemon. UID/GID discovery only selects
an explicitly authorized reader; it is not witness proof. The reader must match
the same freshly observed root. Cold UID 0 to PostgreSQL UID 70 is covered by
mocked credential controls; real chown, mode 0700 and xattr access remain live
qualification cells. There is no capability or ownership-changing fallback.

## Required cold provisioning and receipt order

`startNativeComposeWorkloads` launches one Compose `up -d` child. The candidate
command supplies the following provisioning order before that child, under the
same existing instance mutation and generation effect authority. Actual artifact,
filesystem and PostgreSQL qualification remain separate from this source order:

1. Reacquire source, engine identity and exact owned inventory. Initial admission
   requires no retained storage history or earlier witness intent, the selected
   physical name absent, and no conflicting pending operation. Explicit adoption
   instead pins an already selected stopped volume and its birth; it cannot claim
   historical continuity. Existing v1/v2 or interrupted state never becomes cold
   merely because its data volume is missing.
2. Publish required `Expected` and the immutable expectation before provisioning.
   Cold intent contains the prospective name and no invented birth. The original
   one-shot enrollment capability is consumed before its effect callback.
3. Provision only that admitted cold volume with exact owner/storage labels.
   Check the create result, then freshly inspect and capture the actual birth,
   local driver/options, current Mountpoint and holders before seed. Idempotent
   `volume create` is not proof of original cold admission. No recovery invocation
   gains provisioning or seed authority. The owner exposes exactly one captured
   provisioning callback in the original consumed enrollment. A real engine
   implementation must prove newness across that transaction; idempotent create
   and synthetic observations do not qualify it.
4. Run one create-only seed while all selected workloads remain stopped and no
   foreign or unaccounted holder exists. Require stopped, exact owned helper
   absence before non-force helper removal. Obtain fresh read-only marker and
   metadata proof, then let the owner publish its opaque completion proof and
   required `Enrolled` reference.
5. Recheck witness/source/owner immediately before Compose workload admission and
   after startup, as well as both final receipt boundaries. Read-only proofs may
   coexist with only the exact admitted running generation's holders. They never
   stop an application to obtain a proof or omit the existing final fences.

The carrier handle synchronously captures its callbacks, immutable artifact,
AbortSignal and absolute deadline. Preparation captures that exact handle and
the source selection before its first await. The existing owner, private slot,
one-use enrollment and owner-issued publication proof serve both formats; there
is no second enrollment controller. Xattr completion additionally binds the
canonical kernel response hash and observed root. Fabricated references and
caller-supplied no-op verifiers cannot publish Enrolled.

Any crash before enrollment keeps `Expected`, even if the token matches. Saved
recovery may stop exact owned resources but must preserve the intent and pending
anchor, report incomplete and skip dependent retirement. No automatic promotion,
reseed, journal rewrite or volume deletion is authorized by a successful helper
response.

## Fresh selected-volume transport

The candidate mounts the exact selected existing named volume with
`--mount type=volume,src=<name>,dst=/hack-storage-witness,volume-nocopy` and
`readonly` for metadata and verification. Write access belongs only to the
original seed attempt. The helper program remains a separate nonrecursive,
read-only `rprivate` bind. The named-volume mount uses Docker's fixed private
propagation; the carrier does not bind the daemon's internal data directory or
broaden propagation. Configured `NoCopy`, selected name and read-only state must
match, with no driver, label or subpath overrides. Physical name, canonical
Mountpoint, local driver, read/write state and empty propagation must also match.

Docker can implicitly create a missing named volume even with `volume-nocopy`.
Complete fresh metadata checks precede carrier creation and repeat after its
exact ID and birth are recorded, before start. Missing, foreign or rebound
storage refuses before helper execution, seed or workload. An external removal
racing the create API can leave an empty unqualified volume and carrier anchor;
those effects remain uncertain and cannot grant enrollment, repair or readiness.
This is an observed identity fence, not an atomic engine absence guarantee.

Each proof must create a fresh carrier from a freshly checked current root. An
old carrier can retain a removed root even when the replacement repeats its
name, birth and Mountpoint string. Do not accept its token or reuse that pinned
mount across operations. Metadata discovery and the matching-UID reader must
each be bracketed by fresh engine/birth/Mountpoint/holder checks. After the token
read, a third fresh metadata carrier must still observe that exact root. This
detects a reader pinned to an old removed root across its await even when Docker
metadata repeats; it is a finite observation fence, not an atomic exclusion of
later swaps. Drift refuses; there is no UID retry loop or permission repair.

The source port contract requires a complete selected-volume holder inventory,
the exact daemon and Compose owner, canonical local Mountpoint and empty local
driver options. Only current/pending owned generations may hold the volume;
enrollment forbids every running holder. Every invocation has a fresh nonce,
exact generation/pending context, artifact and UID/GID. Its response must match
those fields, contain one strict canonical helper result, and report exact
stopped helper identity followed by empty helper inventory. Replayed accepted
carrier IDs or invocation IDs refuse. These predicates validate an injectable
contract; they are not proof of actual engine identity or cleanup without the
qualified transport.

The owner initializes a required private `carrier.json` in the anchored witness
slot before provisioning. Every invocation atomically publishes and synchronizes
a prospective intent before calling the captured transport. The transport must
publish the exact created carrier ID and birth through its one-use callback before
start. A response cannot substitute that pin or omit its publication. Only the
owner may publish idle after matching that pin with complete stopped and empty
cleanup observations. No marker values, helper output or commands enter the journal.
An exact canonical refused response with exit one may clear its proven absent
finite helper intent; it still rejects the witness and admits no workload or repair.
The journal changes independently of the generation receipt; the existing exact
material-binding comparison remains unchanged.

An interrupted prospective or created intent, missing journal or changed anchor
blocks startup, run and normal down without another helper call. Explicit saved
recovery may stop saved engine resources, but remains incomplete with its pending
generation, witness reference and dependent claims retained. It cannot infer helper
absence from an unpublished ID, replay the invocation or reset the journal. Fresh
saved checks also precede both final receipt boundaries and material retirement.

Exact image/program/ID labels, fixed mount correspondence,
no image-declared anonymous volumes, dropped capabilities, no network/ports/socket,
readonly root filesystem, finite CPU/memory/PID limits and absolute deadline/group
reaping are mandatory before implementing the engine owner. Cancellation or an
unknown create/start outcome keeps the anchor. Cleanup must prove the exact helper
stopped before non-force removal and never remove data, witness, material or
journals. The candidate Docker port now uses the shared bounded query and child
owners, captures canonical stdin privately, and records the created helper before
start. It inspects all selected-volume holders, mounts only the exact selected
named volume with `volume-nocopy`, and rechecks fresh metadata before start.
It never requests bind source creation. Known completion requires an exact stopped
helper, non-force removal and fresh empty helper inventory. Unknown disposition
retains the private journal and input. Journal bytes do not replace these actual
stop and absence observations. The candidate CLI calls this port; persistent
runtime acceptance remains required before promoting support.

Holder selection includes normalized ancestor and descendant bind paths; similarly
named sibling roots stay independent. Command stdin and captures use held no-follow
descriptors, checked after the final admission await and held until owned group
absence. A fixed shell file-size quota bounds each capture to at most 8192 bytes
on the admitted shell platforms; acceptance is at most 4096 bytes per stream.
Unknown child disposition retains descriptors and the pending journal rather than
starting competing cleanup. No child redirects through a reopened named path.

The declared dependencies use the fixed Linux arm64 and amd64 Bun 1.4.2 image index
`sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61`.
The packaged helper pins its bytes and the qualified Bun/libc bytes separately.
Dependency/platform checks precede volume effects; every helper uses `--pull never`.
Each architecture has separate manifest/config identities and Bun/libc byte pins.
Inspection and create use the immutable `oven/bun@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61`
repository reference. Classic Engine stores resolve this reference to the selected
config ID; containerd stores may expose the index or manifest ID. The response
must retain one of the three qualified IDs and the exact selected platform.
The carrier policy requires that same configured reference and `--pull never`;
it never retries another image, tag or platform.
There is no image download, emulation fallback or platform substitution. Uncached
first installation remains outside this qualification.
Maintain the packaged source with
`bun scripts/generate-native-storage-witness-helper.ts --check` or `--write`;
the generator refuses a changed artifact pin rather than approving new bytes.

## Evidence limits and remaining gates

Offline controls substitute synchronous syscall ports and synthetic engine/carrier
observations through the public generation store. They check strict input,
one create request, no overwrite/repair requests, missing/wrong witness under
unchanged metadata, root/credential drift, callback capture and uncertain fsync
or close; required Expected before cold provisioning; one seed; exact stopped
adoption; resumed missing/same-birth-empty/foreign-root refusals; artifact,
holder, context and cleanup drift; cancellation; retained interrupted state; and
unknown enrolled-helper refusal through explicit saved recovery. These controls
also reject an omitted created callback or changed carrier birth despite a
synthetic successful response.
They do not execute the Linux adapter or qualify kernel atomicity,
permissions, xattr persistence, filesystem crash durability or Docker semantics.

Before activation: qualify exact source/artifact/image/Bun/libc ABI and filesystem;
fresh named-volume/current-root correspondence and missing/rebound refusal before
start; create-only existing/symlink/unsupported
refusals; unchanged PostgreSQL root initialization, real SQL retention, chown and
post-start proofs; same-metadata replacement including an old pinned carrier;
crash/timeout/cancellation with exact helper absence and retained uncertainty;
no daemon-log token persistence; full original engine/resource restoration.

Count every helper process, container and query. The first straightforward proof
needs metadata discovery, a matching-UID read and a fresh metadata observation
after that read. Initial enrollment adds a discovery and write helper before its
separate three-invocation read-only proof. Required pre/post/final proofs
therefore have a real startup cost. Each finite invocation adds three synchronized
private journal publications (intent, created pin and idle), without weakening the
existing main receipt comparison. No performance improvement or production
activation is claimed, and no persistent helper is proposed.

Primary contracts: Linux [fsetxattr](https://man7.org/linux/man-pages/man2/fsetxattr.2.html),
[fgetxattr](https://man7.org/linux/man-pages/man2/getxattr.2.html),
[fsync](https://man7.org/linux/man-pages/man2/fsync.2.html),
[arm64 open flags](https://github.com/torvalds/linux/blob/master/arch/arm64/include/uapi/asm/fcntl.h),
[generic open flags](https://github.com/torvalds/linux/blob/master/include/uapi/asm-generic/fcntl.h),
[Bun FFI](https://bun.sh/docs/runtime/ffi), Docker [volumes](https://docs.docker.com/engine/storage/volumes/),
and tagged Moby [mount fields](https://github.com/moby/moby/blob/v28.5.1/api/types/mount/mount.go).

## Saved readonly carrier observation

The internal `observeNativeComposeStorageCarrierRecovery` API requires a live,
explicit saved down-recovery mutation. It reads an already enrolled v3 witness
and its exact readonly `verify` intent, including the recorded full helper ID and
birth. It reopens the original helper and request without creating or repairing
files, then checks the selected daemon, cached artifact, complete helper policy,
empty selected-volume holder set, volume birth, and unchanged private ownership
before and after the observations. Running, missing, writable, changed or
unrecorded work refuses. The original generation and pending scope must still
match; observation does not rebind an old intent to a new command.

The result says `readonly-verification-retained`. Its host-command status is
`unknown` for legacy, missing, malformed, incomplete or changed command records.
It can report `records-settled` only after reading the complete matching version-2
prefix and observing the recorded PID and group absent in the same host boot
session. A created helper requires exactly the settled create command; an exited
helper requires create and start. A remove record cannot match a retained helper.
This status describes checked saved evidence, not successful return of the original
owner, durable completion of a late publication, or a fresh xattr verification.
Empty captures or a stopped helper alone cannot establish it.
The API performs no helper start, exec, removal, volume effect, enrollment,
journal completion or pending clear. It is not called automatically by ordinary
`down --recover`; the existing incomplete-stop result and retained uncertainty
remain even with `records-settled` evidence. This observation seam has no live
recovery acceptance yet.

## Original readonly command records

The internal `originalCommandRecords: true` transport option creates a distinct
private command-record version 2 beside the existing carrier journal version 1.
New ordinary readonly verify commands select this option. Root/seed keep the
legacy transport/order and interrupted work remains unknown. Old journals and
missing command records retain unknown host-command settlement; no record is reconstructed from
an old PID, empty capture or stopped guest helper.

For each readonly verify invocation, the fixed create/start/remove commands
synchronize their arm record and parent directory. The existing captured `run()` owner starts
a fixed wrapper that stops itself before executing Docker. The original owner
observes that stopped PID, owned group, process birth and shell executable,
publishes and synchronizes that identity, then repeats identity, boot, executable
and admission checks before a one-use continuation of the captured child. A
missing or failed publication cancels that original invocation; an armed record
alone proves neither spawn nor absence. The command's original budget includes
the handshake. No guessed PID or retry is used to rescue a fast command.
Live handshake and settlement budgets use a captured monotonic deadline; the
saved wall deadline is a record field only. Executable device/inode identities
use exact decimal strings from bigint metadata, including sealed macOS binaries.
The one-use continuation uses the original owner's captured PID and checks its
original completion state. It does not acquire a PID from the durable record.

The carrier uses held regular capture files, not pipes. Version 2 therefore names
its capture evidence `held-files-quiescent`, never EOF. The original exit callback,
strict ESRCH group absence, held file/path identity, both synchronized bounded
captures and their hashes precede settlement publication. EPERM/EIO and unknown
exit or capture disposition refuse. Settlement publication shares the existing
three-second post-command group-observation budget; timeout/cancellation remain
refused results and cannot grant a subsequent daemon command.

Only the original in-memory writer can advance its exact sequence. Publication
failure or deadline permanently invalidates that writer and retains its private
files/descriptors. A rename or sync may finish after refusal, so a serialized
settlement is an observation, not standalone successful-return, enrollment or
cleanup authority. The observation-only consumer does not grant helper removal,
intent clear, volume effects or automatic legacy upgrades. Linux process birth
additionally binds kernel start ticks; macOS uses the existing `ps` birth representation while
the captured subprocess remains the delivery owner. Future recovery must never
use that representation to acquire or signal a replacement process.

Writer and reader share two fixed projections. `sourceHash` binds the exact
runtime/owner identity, generation ID, checkout and generation anchors, document
hash, current and pending generation IDs, and original pending token. Receipt and
lease incarnations are excluded because a saved recovery invocation has new ones;
the recovery token does not replace the original pending token. `fixedInvocationHash`
binds the artifact, volume birth and fixed target policy/ownership, readonly flag,
UID/GID, exact request and generation scope. Only live holder inventory and the
callback are excluded. The historical full material/invocation hashes remain in
the record and are not compared to a newly reconstructed recovery context.
Earlier version-2 shapes without these required projections stay unknown.

The reader reopens existing private regular single-link captures and records,
checks bounded UTF-8 bytes, inode/path identity and exact hashes, and repeats source,
executable, boot and absence checks. It matches create output to the saved full
helper ID and start output/exit to the closed response and observed helper exit.
EPERM, EIO, live or reused PIDs, output mismatch and any missing evidence refuse
settlement status. Its opaque result is bound to the observed invocation/helper
selection; copied objects cannot carry it. It holds no resources after the read
and cannot authorize a later effect. Carrier journal version 1 is unchanged.

Focused private-filesystem and owned-child controls qualify only their tested
writer/handshake boundaries. Installed carrier transport, interruption/recovery
and persistent SQL acceptance remain separate runtime gates.

### Removed readonly work recovery

New original v2 transports retain their private command files until the witness
owner has completed the exact journal intent. An original-only one-use finish
capability then rechecks source, lifetime, completion and current helper absence
before retiring those files. Failure after completion retains evidence and never
recreates the intent or confers a second cleanup attempt. The default v1 port
keeps its prior retirement order.

Saved `down --recover`, after known compute removal, can complete one narrower
postcondition: a readonly verification whose original create, successful start
and successful remove records are complete, whose exact successful outputs and
captures match, and whose original child and groups are currently absent. Fresh
source, engine/artifact, complete invocation inventory and retained volume birth,
labels, policy and holder checks are required under the current mutation lease.
The journal is compared again after the last awaited proof and only its captured
unchanged intent is cleared. Existing final receipt/source/kernel fences still
precede ordinary completion. Recovery does not replay a helper command, remove a
helper or volume, enroll storage, or retire the retained command evidence.

Expected/non-v3 witnesses, uncreated verification and missing or incomplete
original command prefixes remain ineligible for reconciliation. Known compute
stop keeps its existing incomplete-stop result and every unresolved storage
anchor; it does not probe or replay a helper for those cases. A selected complete
prefix still needs every fresh proof above: malformed current records, changed
source or volume and drift during that attempt refuse. Retained helpers, failed
verification and seed/root uncertainty never gain completion authority.
The settled-record observation API remains observation-only; it exposes no journal
completion callback. Portable source-CLI tests use a stand-in daemon/kernel and
real private files/children. They do not qualify installed interruption/recovery,
Linux transport, SQL retention, or the discarded older disposable fixtures.
