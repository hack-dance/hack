# Remote Secret Sync Plan

Status: proposed

## Problem

Remote execution needs a safe, explicit way to deliver scoped secrets from controller to node.
Today, auth refs are stored in configured secret backends, but project env secrets are not automatically synchronized host-to-node.

## Goals

1. Explicit sync, never implicit ambient copy.
2. No raw secret values in CLI args, logs, or run artifacts.
3. Fine-grained scope: project + key allowlist + node target.
4. Auditable operations with actor, rationale, and expiry.
5. Backend-agnostic storage (`keychain` / `encrypted_file` / `cloud`).

## Non-goals (v1)

1. Full bidirectional sync.
2. Secret editing inside remote nodes from app UI.
3. Provider-native KMS integration for all clouds.

## Proposed v1 command surface

```bash
hack env sync push --project <name|id> --node <id|default> --keys KEY1,KEY2 [--ttl <seconds>] [--json]
hack env sync status --project <name|id> --node <id|default> [--json]
hack env sync revoke --project <name|id> --node <id|default> [--keys KEY1,KEY2] [--json]
```

## Data flow (push)

1. Controller resolves selected keys from local secret backend.
2. Controller generates one-time envelope key + request id.
3. Controller encrypts payload (AES-GCM) and posts to node gateway over authenticated channel.
4. Node decrypts in-memory and writes values to node secret backend under project scope.
5. Node returns per-key success metadata (never values).
6. Controller appends audit event in runs/tickets channel.

## Security controls

1. Write-scoped gateway token required.
2. `allowWrites=true` enforced for sync/revoke endpoints.
3. Envelope key never persisted; only ciphertext traverses wire.
4. Payload redaction in logs by key name patterns and request context.
5. TTL metadata optionally sets expiry window for synced values.

## Audit model

Each operation emits:
1. actor (local user / automation id)
2. node id + project id
3. key names only
4. action (`push` | `revoke`)
5. timestamp + request id
6. optional reason

## Open decisions

1. Should v1 TTL enforce hard deletion on node or soft-expiry at read time?
2. Should node backend key namespace include branch in addition to project?
3. Should app present per-project secret profiles or only key allowlists?

