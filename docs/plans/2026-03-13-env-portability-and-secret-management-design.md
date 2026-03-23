# Env Portability And Secret Management Design

## Context

Hack already has the beginnings of a useful env system:

- `.hack/hack.env.json` defines the committed project env contract
- `.hack/.env` stores local non-secret values
- the configured secret backend stores local secret values
- `hack env` can list, set, unset, and resolve values for runtime injection

What is still missing is an explicit product model for portability, sharing, recovery, and operator trust. Today the user can understand the local contract, but not yet the full lifecycle of:

- where portable values would live
- how encrypted values are modeled
- how another human or machine should gain access
- how key loss or rotation should behave
- how all of this preserves `.env` compatibility instead of replacing it

This design defines that product boundary for the full stream. It treats the existing remote encrypted env portability plan as one child slice inside the larger env portability and secret-management program.

## Goals

- Make the storage model explicit for committed, local, and portable env state.
- Define a portable project env artifact schema that is independent from any one device or local keychain.
- Define a separate encrypted key-sharing model so access is explicit and reviewable.
- Make rotation and recovery behavior safe enough to explain before it ships.
- Preserve `.env` compatibility and existing backend choices instead of forcing a new runtime model.
- Break the work into coherent child streams that can be implemented independently.

## Non-Goals

- Do not make local-only Hack usage require Hack account auth.
- Do not turn the broker into a plaintext env editor.
- Do not silently copy host env values to remote nodes.
- Do not auto-share env access to every org or team member.
- Do not replace `.hack/hack.env.json` with a value-bearing committed file.

## Approved Product Rules

### Local remains the default

The current local behavior remains valid:

- `.hack/hack.env.json` is the committed contract
- `.hack/.env` remains the local plaintext materialization for non-secret values
- the configured secret backend remains the local materialization for secret values
- `hack up`, `hack run`, and `hack restart` continue resolving local values first

Portable env management is opt-in per project binding. If a user never enables it, Hack should continue behaving as a local-only tool.

### Portability is a separate value artifact

The committed contract and the portable value artifact are different objects:

- `.hack/hack.env.json` describes what keys exist and how they should materialize locally
- the portable artifact stores encrypted values plus ownership and lineage metadata

This avoids putting secrets in git while still making the portable state explicit and inspectable.

### Shared or remote state requires Hack account ownership

Portable env bundles are owned by a Hack scope:

- user
- organization
- team

Provider identity is not the owner. A GitHub login method, Linear profile, or local keychain identity is not the durable ownership layer for portable env state.

## Explicit Storage Model

Hack should describe env storage in three layers.

### 1. Committed contract

File:

- `.hack/hack.env.json`

Purpose:

- declares required keys
- declares service scoping
- declares local materialization intent

This file stays safe to commit because it contains no values.

### 2. Local materialization

Files/backends:

- `.hack/.env` for `plain_env`
- configured secret backend for secret material

Purpose:

- stores the values a local machine actually uses for runtime injection
- stays compatible with existing Docker Compose env handling and local debugging workflows

### 3. Portable encrypted state

Artifact:

- `hack.project-env-bundle/v1`

Purpose:

- stores an immutable encrypted snapshot of project env values
- supports broker storage and explicit export/import
- is portable across machines because it does not rely on one local keychain as the only durable copy

Portable state must never be described as "the `.env` file in the cloud." It is an encrypted artifact that can be applied back into `.hack/.env` and the local secret backend.

## Portable Artifact Schema

The portable value artifact is one immutable bundle version. It may live in the broker and may also be exportable as a file for backup or manual transport.

Recommended schema:

```json
{
  "$schema": "https://schemas.hack/hack.project-env-bundle.schema.json",
  "kind": "hack.project-env-bundle",
  "version": 1,
  "bundleId": "peb_01JQ...",
  "projectBindingKey": "user:usr_123/my-project/default",
  "environment": "default",
  "ownerScope": {
    "type": "user",
    "id": "usr_123"
  },
  "createdAt": "2026-03-13T12:00:00.000Z",
  "createdBy": "usr_123",
  "supersedesBundleId": null,
  "contract": {
    "path": ".hack/hack.env.json",
    "version": 1,
    "digest": "sha256:2e7d..."
  },
  "crypto": {
    "scheme": "project-key-envelope-v1",
    "projectKeyId": "pek_01JQ...",
    "bundleKeyId": "bek_01JQ...",
    "bundleKeyWrap": {
      "wrapType": "project_key",
      "wrappedBundleKey": "base64..."
    },
    "entryAlgorithm": "aes-256-gcm"
  },
  "entries": [
    {
      "key": "DATABASE_URL",
      "required": true,
      "services": ["api", "worker"],
      "materialization": {
        "type": "secret_backend",
        "backendHint": "preserve_current"
      },
      "ciphertext": "base64...",
      "iv": "base64...",
      "tag": "base64...",
      "digest": "sha256:8b1a..."
    },
    {
      "key": "AWS_PROFILE",
      "required": true,
      "services": ["api"],
      "materialization": {
        "type": "plain_env"
      },
      "ciphertext": "base64...",
      "iv": "base64...",
      "tag": "base64...",
      "digest": "sha256:3a7d..."
    }
  ]
}
```

### Schema rules

- Every bundle version is immutable.
- All values are encrypted in the bundle, including values that will later be written into `.hack/.env`.
- `materialization.type` tells Hack where to place the decrypted value during apply:
  - `plain_env` writes to `.hack/.env`
  - `secret_backend` writes to the configured secret backend
- `backendHint` is advisory only. It should never force a backend switch during apply.
- `projectBindingKey` is stable across versions and is the join point for bundle history, key shares, and audit.

## Encrypted Entry And Key Model

The stream needs two different key concepts.

### Project key

The project key is a long-lived wrapping key for one project binding. It is not the value-encryption key for every entry directly. Its job is to make sharing, rotation, and recovery explicit.

Responsibilities:

- wraps each bundle version key
- is the object shared with collaborators or recovery targets
- can be rotated without forcing an operator to hand-edit every env value

### Bundle key

Each bundle version gets a fresh random bundle key.

Responsibilities:

- encrypts each entry payload in the bundle
- is wrapped by the project key
- is discarded from plaintext after publish/apply completes

This separation keeps snapshot publication simple and makes project-key sharing possible without treating one giant ciphertext blob as the only unit of control.

## Manual Project-Key Sharing Model

Sharing access to a portable project env must be manual and additive. The portable bundle and the key share record are separate objects.

Recommended key-share schema:

```json
{
  "$schema": "https://schemas.hack/hack.project-env-key-share.schema.json",
  "kind": "hack.project-env-key-share",
  "version": 1,
  "shareId": "pks_01JQ...",
  "projectBindingKey": "user:usr_123/my-project/default",
  "projectKeyId": "pek_01JQ...",
  "recipient": {
    "type": "user",
    "id": "usr_456"
  },
  "wrapMethod": "x25519-sealed-box-v1",
  "wrappedProjectKey": "base64...",
  "createdAt": "2026-03-13T12:15:00.000Z",
  "createdBy": "usr_123",
  "revokedAt": null,
  "lastUsedAt": null
}
```

### Sharing rules

- Sharing happens one recipient at a time.
- The broker may store key-share records, but it should not auto-grant them based on org membership alone.
- A user or team receiving access gets a wrapped project key, not plaintext env values.
- Revocation removes future access by invalidating the share record and blocking fresh unwrap operations. It does not rewrite old local materializations that a recipient already applied.

Manual sharing is the explicit trust boundary. If a project owner never creates a share, nobody else gets access by default.

## Rotation And Recovery Behavior

The program needs three different operator actions, with different UX and audit implications.

### 1. Value rotation

Use when actual env values changed.

Behavior:

- publish a new immutable bundle version
- mint a fresh bundle key
- keep the same project key unless crypto rotation is also requested

### 2. Share rotation

Use when recipients change.

Behavior:

- add or revoke key-share records
- do not rewrite bundle values
- do not require env republish unless an operator explicitly wants a new bundle

### 3. Project-key rotation

Use when the project key itself is suspected compromised or when the owner wants to re-anchor trust.

Behavior:

- mint a new project key
- re-wrap the latest active bundle keys to the new project key
- require explicit regeneration of all active key-share records
- keep prior project-key lineage in audit metadata

### Recovery policy

Hack should not silently escrow plaintext secrets. Recovery must be explicit.

Required rule:

- portable env enablement must require at least one recovery path before the operator can delete the only local authority

Allowed recovery paths:

- an encrypted recovery package exported by the operator
- a second admin/owner key share
- a designated recovery recipient created manually

Unsafe behavior to reject:

- deleting the last active owner share with no recovery path
- rotating the project key while leaving no valid recipient or backup
- revoking the last usable recovery share without an explicit forced override

## `.env` Compatibility And Backend UX

Portability should preserve the current local runtime model instead of replacing it.

### Apply behavior

When a portable bundle is applied locally:

- entries with `materialization.type = plain_env` are written to `.hack/.env`
- entries with `materialization.type = secret_backend` are written to the configured secret backend
- the contract file remains `.hack/hack.env.json`

This means portability changes where values are sourced from, not how local services consume them.

### UX rule

Hack should always show three things separately:

- contract location
- local value location
- portable copy state

Example user-facing explanations:

- `AWS_PROFILE`:
  - contract: `.hack/hack.env.json`
  - local value: `.hack/.env`
  - portable copy: enabled, latest bundle `peb_...`
- `DATABASE_URL`:
  - contract: `.hack/hack.env.json`
  - local value: `keychain`
  - portable copy: enabled, protected by project key `pek_...`

That separation is what makes the trust model understandable.

## Child Streams

The program should be implemented as five child streams.

### Stream 1: Current-state trust model and operator UX

Deliverables:

- clearer docs for current local storage
- CLI or UI surfaces that explain contract vs local vs portable state
- explicit trust-boundary copy for backends and remote ownership

### Stream 2: Portable bundle registry and project binding

Deliverables:

- broker schema for bundle versions and bindings
- CLI publish/list/pull/apply flows
- immutable version lineage and audit metadata

This stream is the direct successor to the existing remote encrypted env portability plan.

### Stream 3: Manual project-key sharing

Deliverables:

- key-share schema and broker routes
- share and revoke flows
- audit for recipient grants and use

### Stream 4: Rotation and recovery safeguards

Deliverables:

- project-key rotation
- recovery package flow
- last-share / last-recovery-path guardrails

### Stream 5: `.env` compatibility and desktop/backend UX

Deliverables:

- consistent apply behavior into `.hack/.env` and configured secret backend
- visibility-first CLI and macOS UX
- explicit backend hints and warnings when apply target differs from publish

## Open Questions

- Should export/import use the same portable bundle JSON as broker storage, or a wrapped archive that contains both bundle metadata and selected key shares?
- Do we want a single default environment first, or named environments such as `default`, `staging`, and `prod` in the first release?
- Should org-owned project keys require more than one active admin share before rotation/revocation is allowed?
- How much audit retention is required before remote portability is safe to recommend broadly?

## Links

- `docs/env.md`
- `docs/plans/2026-03-06-remote-encrypted-project-env-portability-plan.md`
- `docs/plans/2026-03-06-hack-account-auth-and-provider-ux-design.md`
