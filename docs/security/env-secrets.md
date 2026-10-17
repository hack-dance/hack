# Env secret security decision and remaining qualification

Status: bounded source review, 2026-10-17, for HACK-1127. This records a
no-format-change decision and required follow-up, not complete security or
cryptographic qualification. No real keys or secrets were accessed or migrated.

## Decision

Keep the existing AES-256-GCM formats while closing concrete custody and recovery
gaps. Do not introduce a new cipher, deterministic encryption, recipient format,
or post-quantum label as part of key-file hardening. A new format needs a separate
migration contract and appropriately scoped independent cryptographic review.

The existing construction uses random 12-byte IVs, 16-byte authentication tags and
SHA-256 of key text as the AES key. Generated key text encodes 32 random bytes;
hashing a human password does not give it that entropy. These facts are verified
in `src/lib/project-env-config.ts` and `src/lib/secret-store.ts`; they do not
establish nonce-collision budgets or password-hardening suitability.

[NIST SP 800-38D](https://csrc.nist.gov/pubs/sp/800/38/d/final) specifies GCM.
NIST's [June 2026 revision consultation](https://csrc.nist.gov/pubs/sp/800/38/d/r1/2prd)
is a pre-draft, not a replacement final standard. Hack's current 128-bit tags do
not depend on the short-tag support proposed for removal.
[FIPS 203](https://csrc.nist.gov/pubs/fips/203/final) specifies ML-KEM for establishing
a shared key; it does not replace symmetric file encryption or solve local key
custody. A recipient-sharing design must first define identities, authenticated
recipient keys, revocation limits and recovery. No recipient implementation,
hybrid composition, interoperability or performance claim is made here.

## Threat boundaries and artifacts

Assume public Git, forks, caches and downloaded artifacts can be retained forever.
An attacker can modify a repository, copy ciphertext or obtain an old key. A
compromised collaborator or runtime with plaintext access can disclose that
plaintext; storage encryption does not prevent it. Changing a key cannot withdraw
old plaintext, keys or ciphertext already copied. Long-term ciphertext retention
therefore remains part of the threat model even after rotation.

| Surface | Current treatment | Publication policy |
| --- | --- | --- |
| Shared YAML env files and legacy inline `v1:` values | Values may be plaintext or AES-GCM ciphertext; names/scopes and other configuration remain visible | Public only after reviewing every plaintext field and accepting metadata disclosure; ciphertext alone is not blanket approval |
| Checkout/shared project key, environment key override | Decrypts selected project values; worktrees may share key custody | Private only; forbidden in public history, images, argv or logs |
| `encrypted_file` store | One authenticated encrypted map; project scoping is inside plaintext | Private by default; a public-copy decision requires reviewing envelope metadata, custody and retained history |
| `cloud` shim | Uses encrypted local storage; a provider label is not proof of a managed KMS | Apply the encrypted-file policy; qualify actual provider behavior separately |
| Native keychain backend | Delegates storage/access to Bun and the OS | Never export credentials to qualify tests; preserve native approval boundaries |
| Materialized dotenv/Compose files and runtime injection | May contain plaintext by design | Private only; inspect synthetic fixtures for leakage, not production values |
| Backups, session archives, application output and private ledgers | May contain plaintext, keys or historical disclosures | Private only until independently reviewed; no complete-redaction claim |

The inline `v1:` and encrypted-store envelope authenticate no associated data.
Inline ciphertext is not bound to its variable, project or path; the store scopes
entry names inside its encrypted map. Cross-context copying needs explicit controls
in any future format. Existing negative controls reject incorrect decryption
material, altered or truncated payloads, invalid IV/tag lengths and oversized
ciphertext. Passing those controls does not prove all backends, exports or endpoint
behavior safe.

## Key writes and rotation

Project-env key creation already uses exclusive private-file creation and
worktree selection rules. Encrypted-store provisioning now stages and syncs a
mode-0600 sibling and atomically replaces a regular key; key-path and immediate
parent symlinks refuse. Store set/delete have their own cooperative lock. These
are separate operations: neither the store lock nor atomic key replacement makes
key provisioning converge across concurrent processes or coordinates rotation of
a key with its ciphertext.

Before rotating real data, preserve a private recoverable key/ciphertext snapshot,
validate recovery, inventory every overlay, linked-worktree override and backend,
and stop competing writers using supported ownership controls. Do not overwrite
or discard the only old key. Use a hidden prompt or managed stdin for secret input.
Do not print secrets to verify equality or recovery.

A future crash-safe rotation implementation must define one durable commit point
for a versioned key/ciphertext generation and recovery rules before implementation.
It must retain the old decryptable generation until the new generation has been
verified, reject concurrent/stale writers and downgrade attempts, and test crashes
before/after each durable step. Keychain and environment-backed keys need their
own custody and rollback contracts; a two-file rename sequence is insufficient.

## Remaining acceptance

HACK-1127 stays open for a complete backend/export inventory, synthetic Git-history
and runtime leakage controls, concurrent key provisioning, cross-context controls,
nonce/usage limits, crash-safe paired rotation and interrupted recovery, primary
and linked-worktree isolation, and independent review where a new construction is
proposed. Compare maintained alternatives only against a concrete distribution
and migration design; this decision does not claim they have been benchmarked or
qualified. Production rotation, private off-machine backup and publication require
their actual authorized destination and scope.

See [env configuration](../env.md) for current selection and compatibility rules.
