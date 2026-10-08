# Native Compose directory-xattr carrier source

This is an unactivated Linux helper source and an offline protocol. It does not
enroll CLI volumes or qualify an engine transport. The [witness foundation](native-compose-storage-witness.md)
still accepts only its regular-file/USTAR format. Ordinary CLI instances retain
the metadata guard's same-metadata replacement limitation.

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
the foundation's USTAR proof or attached to its existing completion reference.
An explicit required reference/expectation codec change and owner review must
precede xattr receipt integration; older owners must continue to refuse it.

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
Carrier activation must add the following boundary before that child, under the
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
   gains provisioning or seed authority. The final cold transaction and engine
   observation contract remain unimplemented and require review.
4. Run one create-only seed while all selected workloads remain stopped and no
   foreign or unaccounted holder exists. Require stopped, exact owned helper
   absence before non-force helper removal. Obtain fresh read-only marker and
   metadata proof, then let the owner publish its opaque completion proof and
   required `Enrolled` reference.
5. Recheck witness/source/owner immediately before Compose workload admission and
   after startup, as well as both final receipt boundaries. Read-only proofs may
   coexist with only the exact admitted running generation's holders. They never
   stop an application to obtain a proof or omit the existing final fences.

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
each be bracketed by fresh engine/birth/Mountpoint/holder checks. Drift refuses;
there is no UID retry loop or permission repair.

Durable carrier intent, exact image/program/ID labels, fixed mount correspondence,
no image-declared anonymous volumes, dropped capabilities, no network/ports/socket,
readonly root filesystem, finite CPU/memory/PID limits and absolute deadline/group
reaping are mandatory before implementing the engine owner. Cancellation or an
unknown create/start outcome keeps the anchor. Cleanup must prove the exact helper
stopped before non-force removal and never remove data, witness, material or
journals. This source contains no Docker transport or helper cleanup implementation.

## Evidence limits and remaining gates

Offline controls substitute synchronous syscall ports. They check strict input,
one create request, no overwrite/repair requests, missing/wrong witness under
unchanged metadata, root/credential drift, callback capture and uncertain fsync
or close. They do not execute the Linux adapter or qualify kernel atomicity,
permissions, xattr persistence, filesystem crash durability or Docker semantics.

Before activation: qualify exact source/artifact/image/Bun/libc ABI and filesystem;
non-creating current-root bind behavior; create-only existing/symlink/unsupported
refusals; unchanged PostgreSQL root initialization, real SQL retention, chown and
post-start proofs; same-metadata replacement including an old pinned carrier;
crash/timeout/cancellation with exact helper absence and retained uncertainty;
no daemon-log token persistence; full original engine/resource restoration.

Count every helper process, container and query. The first straightforward proof
needs metadata discovery followed by a matching-UID read; initial enrollment adds
a write helper and a separate read-only proof. Required pre/post/final proofs
therefore have a real startup cost. No performance improvement or production
activation is claimed, and no persistent helper is proposed.

Primary contracts: Linux [fsetxattr](https://man7.org/linux/man-pages/man2/fsetxattr.2.html),
[fgetxattr](https://man7.org/linux/man-pages/man2/getxattr.2.html),
[fsync](https://man7.org/linux/man-pages/man2/fsync.2.html),
[arm64 open flags](https://github.com/torvalds/linux/blob/master/arch/arm64/include/uapi/asm/fcntl.h),
[generic open flags](https://github.com/torvalds/linux/blob/master/include/uapi/asm-generic/fcntl.h),
[Bun FFI](https://bun.sh/docs/runtime/ffi), and Docker [bind mounts](https://docs.docker.com/engine/storage/bind-mounts/).
