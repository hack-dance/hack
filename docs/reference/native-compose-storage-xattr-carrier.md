# Native Compose directory-xattr carrier source

This is an unactivated Linux helper source, injectable owner protocol and offline
controls. The [witness foundation](native-compose-storage-witness.md) accepts its
distinct xattr expectation/reference format under the same opaque generation
authority. A candidate Docker implementation of the carrier ports is unactivated;
the CLI does not enroll volume witnesses. Ordinary CLI instances retain the metadata
guard's same-metadata replacement limitation.

The proposed directory xattr avoids adding a directory entry to PostgreSQL's
authored data root. It detects a replacement missing its enrolled random witness;
it does not prove database integrity or detect a clone containing that witness.
No `PGDATA` rewrite, root marker directory, package install or helper image pull
is part of this source.

## Fixed helper contract

`scripts/native-storage-witness-helper.ts` is the future helper entry. The CLI
does not invoke it. A qualified artifact must bundle this entry with its strict
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

`startNativeComposeWorkloads` currently launches one Compose `up -d` child.
The injectable owner implements the following order; activation must supply a
qualified cold provisioning and carrier transport before that child, under the
same existing instance mutation and generation effect authority:

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

## Non-creating transport prerequisite

A Docker named-volume mount can auto-create an absent name even when readonly
and `volume-nocopy`; it is not an admitted resume transport. The candidate is a
fresh non-creating `--mount type=bind` of the exact current qualified local
volume's daemon-side Mountpoint, with `readonly,bind-recursive=disabled`, no
`bind-create-src`, no `-v` and no fallback. Write access is permitted only for the
original seed attempt. Local driver, empty options, canonical source/parent chain,
engine support and exact volume-root correspondence must all be qualified. A
missing source refuses without creating a volume or directory.

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
start. It inspects all selected-volume holders, binds the fresh canonical local
Mountpoint with `bind-recursive=disabled`, and never uses a named-volume helper
mount or requests bind source creation. Known completion requires an exact stopped
helper, non-force removal and fresh empty helper inventory. Unknown disposition
retains the private journal and input. Journal bytes do not replace these actual
stop and absence observations. The CLI does not call this unactivated port.

Holder selection includes normalized ancestor and descendant bind paths; similarly
named sibling roots stay independent. Command stdin and captures use held no-follow
descriptors, checked after the final admission await and held until owned group
absence. A fixed shell file-size quota bounds each capture to at most 8192 bytes
on the admitted shell platforms; acceptance is at most 4096 bytes per stream.
Unknown child disposition retains descriptors and the pending journal rather than
starting competing cleanup. No child redirects through a reopened named path.

The first declared dependency is the fixed Linux arm64 Bun 1.4.2 image
`sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61`.
The packaged helper pins its bytes and the qualified Bun/libc bytes separately.
Dependency/platform checks precede volume effects; every helper uses `--pull never`.
There is no image download, emulation fallback or platform substitution. Linux
amd64 and uncached first installation remain outside this qualification.
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
non-creating current-root bind behavior; create-only existing/symlink/unsupported
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
[Bun FFI](https://bun.sh/docs/runtime/ffi), and Docker [bind mounts](https://docs.docker.com/engine/storage/bind-mounts/).
