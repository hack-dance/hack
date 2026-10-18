# Proposed paired key/store rotation protocol

Status: design and executable ordering model, 2026-10-17, HACK-1127. This is not a
production rotation command. No key, ciphertext, crypto format or default reader
was changed. The bounded implementation in PR326 protects individual key writes;
it cannot make two independent replacements a transaction.

## Compatibility decision

Do not wire a two-file rotation into the existing CLI yet. In
`src/lib/secret-store.ts`, `createEncryptedScopedStore` captures a key when a
handle is created; `get` does not take the mutation lock; set/delete use the
store-path lock; and key provisioning has a separate path. A key can also serve
multiple configured stores or worktrees. Environment overrides and native keychain
custody are separate owners. Changing one pair cannot establish that every
consumer or writer participates.

The next implementation must first identify the complete consumer set and make
all participating reads, writes and provisioning honor one protocol. Existing v4
or external writers cannot be assumed to cooperate. Refuse rotation when the
consumer set is incomplete; do not infer exclusivity from one configuration file.
Keep keychain/env-backed rotation outside the initial file-backed transaction.

## Durable artifacts and authority

Use an explicitly selected, owner-controlled, canonical mode-0700 private state
root. Never place key snapshots or journals beside a publicly tracked ciphertext
file merely for convenience. Snapshots and journals contain secret material and
must be mode 0600, excluded from public archives and never printed. The operator
must select and approve any off-machine backup separately.

An exclusive transaction directory holds a versioned journal, complete old and new
key/ciphertext snapshots, bounded membership/identity receipts, and a completion
record. Store snapshot names as fixed relative members, not arbitrary write paths
supplied by a journal. The caller pins the authorized canonical key/store paths;
recovery must not let a copied journal redirect writes to another project.
Validate owner, type, permissions, ancestry, membership and size before effects.

Generate a fresh 256-bit key and fresh GCM IV using the existing construction.
Decrypt/authenticate the complete old envelope, preserve its complete plaintext
bytes, and verify the staged new envelope opens to those exact bytes. Do not
round-trip through a parser that silently drops unsupported fields. Preserve the
existing v1 envelope; any crypto/schema migration needs its own version/downgrade
contract and review. Recovery copies the captured ciphertext bytes rather than
inventing another encryption operation.

## Ordered transaction

1. Acquire the shared key-owner lock and every participating store lock in a
   deterministic order. Recheck the pinned selection. Quiesce incompatible writers
   through their supported ownership controls; do not kill unknown processes.
2. Capture the complete old pair and stage the complete verified new pair. Sync
   every snapshot file and its directory before publishing mutation authority.
3. Atomically publish and sync the `prepared` journal. From this point all
   participating readers refuse while recovery is pending; reads never repair.
4. Atomically replace and sync the selected key, then the ciphertext. Verify the
   complete selected new pair and that all members still have expected identities.
5. Atomically publish and sync `committed`. This is the durable outcome decision.
6. Archive the active journal only after the selected pair has been verified.
   Sync the directory entry, then release locks. Retain the private recovery
   snapshots and completion receipt; automatic backup deletion is not authorized.

A reader obtains the same cooperative lock and checks for an active journal before
acquiring key/store bytes. A pending transaction returns a closed, value-free
recovery-required error. A stale handle must fail before any write if its selected
key generation no longer matches. No fallback to plaintext or another backend is
permitted on authentication or journal errors.

## Explicit recovery

Recover only after proving the previous owner absent with the existing lock
protocol, then reacquire the same locks. Revalidate every journal/snapshot and
require current selected bytes to match authorized old or staged members. A
foreign edit, malformed journal, missing member, changed path, alias or uncertain
owner is a refusal: preserve evidence and do not overwrite it.

- No active journal: no transaction effects are authorized. An orphan staging
  directory is not permission to adopt or remove it.
- `prepared`: restore the exact old key and old ciphertext, verify both, then
  archive the aborted journal. Keep readers blocked through both replacements.
- `committed`: complete/verify the exact new pair, then archive the journal.

Recovery is idempotent and may itself be interrupted after either replacement.
The durable decision remains unchanged until verification and archival complete.
Do not discard the only decryptable old generation. Rotation cannot withdraw old
keys/plaintext already copied or revoke plaintext in existing runtime processes.

## Executable model and remaining implementation gates

Run `bun test tests/env-key-rotation-model.test.ts`. The finite model uses generation
labels only; it reads no filesystem or secret. It explores all reachable writer
crash cuts and recovery steps, checks that readers never accept a mixed pair, and
checks recovery converges to the durable decision. Negative controls deliberately
remove the reader journal fence, delay the journal until after key replacement,
or commit before durable snapshots; each must expose a violation. A foreign-member
control refuses recovery without rewriting that member or losing snapshots.

This proves properties of the proposed ordering under its assumptions, not the
production implementation, filesystem durability, cooperative-lock integration,
cryptographic strength or cross-process ownership. Physical file identity races,
malformed/oversized journals, multiple stores/worktrees, crashes during real fsync/
rename, old-version writers, stale handles, native credentials and backup recovery
still need implementation-level controls and independent review. Do not expose a
production command until those gates pass. HACK-1127 remains open.

See [the security decision](env-secrets.md) and [current env behavior](../env.md).
