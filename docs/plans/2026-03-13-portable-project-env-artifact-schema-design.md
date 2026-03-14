# Portable Project Env Artifact Schema Design

## Context

The current env model has two clear layers:

- `.hack/hack.env.json` is a committed contract with key names, required flags, service scope, and descriptions.
- `.hack/.env` plus the configured secret backend hold local runtime values.

That split works for local development, but it is not a portable managed-value model. It does not give Hack a stable artifact that can be exported, encrypted, published remotely, re-applied on another machine, or used as the canonical source for future CLI and desktop env workflows.

This design introduces a separate portable managed env artifact instead of expanding `.hack/hack.env.json` in place.

## Decision

Keep `.hack/hack.env.json` as the declaration contract and introduce a second artifact for managed values:

- Contract file: `.hack/hack.env.json`
- Portable artifact format: `PortableProjectEnvArtifactV1`
- Suggested import/export filename: `.hack/hack.env.managed.json`
- Default durable storage: encrypted bundle transport or remote storage, not a committed plaintext repo file

This avoids schema churn in the existing contract parser and keeps the portable artifact focused on values, scope, and intent.

## Approaches Considered

### 1. Separate portable artifact

Recommended.

Pros:

- preserves compatibility with current `hack init`, parser, docs, and tests
- keeps the committed contract safe to share and review
- gives portability its own stable schema and lifecycle
- makes `.hack/.env` and the secret backend clearly derived compatibility targets

Cons:

- introduces one more schema to document and maintain
- requires explicit reconciliation rules between contract and artifact

### 2. Expand `.hack/hack.env.json` into the managed artifact

Pros:

- fewer files to explain
- one JSON document to parse

Cons:

- mixes safe shareable contract data with managed values
- creates migration pressure for existing repos and templates
- makes future remote encryption and local compatibility logic harder to reason about

### 3. Keep only local compatibility files and derive portability ad hoc

Pros:

- no new schema immediately

Cons:

- `.hack/.env` cannot represent secrets safely or service intent
- the secret backend cannot represent descriptions or service scope
- export/apply/publish behavior would stay heuristic and brittle

## Layer Model

The env system should be treated as three distinct layers.

### 1. Declaration contract

`.hack/hack.env.json`

Purpose:

- defines which env keys exist
- captures default required flags, service scope, and descriptions
- remains safe to commit

### 2. Portable managed artifact

`PortableProjectEnvArtifactV1`

Purpose:

- canonical managed-value snapshot for publish, fetch, apply, import, and export
- contains logical plaintext and secret values plus the metadata needed to materialize them anywhere
- should be encrypted as a whole when stored outside the local machine

### 3. Local compatibility materialization

- `.hack/.env`
- configured secret backend (`keychain`, `encrypted_file`, `cloud`)

Purpose:

- runtime compatibility for Compose, local shells, and existing commands
- derived output only

## Artifact Schema

```json
{
  "$schema": "https://schemas.hack/hack.env.managed.schema.json",
  "version": 1,
  "environment": "default",
  "metadata": {
    "description": "Shared dev environment for Hack App",
    "updatedAt": "2026-03-13T18:00:00Z",
    "updatedBy": "cli",
    "source": "hack-cli"
  },
  "entries": [
    {
      "key": "AWS_REGION",
      "value": {
        "kind": "plaintext",
        "text": "us-east-1"
      },
      "required": true,
      "services": ["api"],
      "description": "AWS region used by the API"
    },
    {
      "key": "DATABASE_URL",
      "value": {
        "kind": "secret",
        "text": "postgres://..."
      },
      "required": true,
      "services": ["api", "worker"],
      "description": "Primary application database"
    }
  ]
}
```

## Field Semantics

### Top-level fields

- `$schema`: schema URL for tooling and validation
- `version`: artifact schema version; starts at `1`
- `environment`: named managed environment, defaulting to `"default"`
- `metadata.description`: human summary for the artifact as a whole
- `metadata.updatedAt`: RFC 3339 timestamp for the last artifact mutation
- `metadata.updatedBy`: actor class such as `cli`, `desktop`, or `api`
- `metadata.source`: producing surface such as `hack-cli` or `hack-desktop`
- `entries`: stable, key-sorted list of managed env entries. Duplicate keys and unsorted lists are parser and writer errors even though JSON Schema cannot enforce them directly.

### Entry fields

- `key`: uppercase snake-case env var name
- `value.kind`:
  - `plaintext`: write to `.hack/.env` during compatibility materialization
  - `secret`: write to the configured secret backend during compatibility materialization
- `value.text`: canonical string value
- `required`: whether the value is required when targeted services use it
- `services`: `null` or omitted means all services; otherwise a sorted list of Compose service names
- `description`: human intent note shown in CLI and UI

## Why Secrets Are Still Plaintext Inside The Artifact

The artifact is the normalized logical payload. Encryption belongs to the outer transport or storage envelope, not to individual entry fields.

That means:

- the artifact stays simple and deterministic
- plaintext and secret entries are distinguished by intent, not by nested encryption machinery
- the entire artifact can be encrypted, versioned, and audited as one unit for remote portability

This design keeps the schema stable even if the remote encryption envelope changes later.

## Portable Artifact Rules

The portable artifact must include:

- canonical key names
- canonical values
- whether each value is `plaintext` or `secret`
- required flag
- service scope
- human-readable description
- environment name
- artifact-level update metadata

The portable artifact must not include:

- local absolute paths
- machine hostnames
- keychain service names
- encrypted file paths
- cloud backend provider config
- `resolvedFrom` state such as `dotenv`, `process`, or `keychain`
- prompt history, interactive defaults, or shell fallback behavior
- per-machine compose override output

## Local Compatibility Rules

`.hack/.env` should contain only:

- plaintext values
- no secret entries
- no descriptions
- no service scope metadata
- no timestamps or actor metadata

The configured secret backend should contain only:

- secret values keyed by env var name
- no plaintext entries
- no descriptions
- no service scope metadata

Local compatibility files are not canonical. The CLI may regenerate them from the managed artifact at any time.

## Reconciliation With `.hack/hack.env.json`

The contract and artifact intentionally overlap on a few fields. The rules should be:

- contract defines the expected shape of the project env surface
- artifact carries the managed snapshot used for portability
- when both exist, key names must be validated against the normalized contract
- if `required`, `services`, or `description` disagree, the artifact wins for apply/export behavior and the CLI should surface drift
- unknown artifact keys should warn by default and require explicit confirmation before apply

Today the live contract parser is looser than the published contract schema. Artifact-aware commands should therefore normalize and compare contract entries explicitly instead of assuming the current parser already enforces uppercase key, source, or service-shape invariants.

This keeps the artifact self-contained while still treating the committed contract as the project declaration surface.

## CLI Read Behavior

When portable env management is enabled for a project, CLI reads should use this order:

1. load the portable artifact or fetched remote bundle payload
2. validate entry keys against `.hack/hack.env.json` when present
3. materialize compatibility state in memory:
   - plaintext entries to `.env`-style map
   - secret entries to secret-store map
4. compare local compatibility files against the canonical artifact
5. report drift, missing values, and unknown keys explicitly

If no managed artifact is configured, current local-only behavior remains unchanged.

## CLI Write Behavior

`hack env set` and `hack env set --secret` should behave as follows when a managed artifact is active:

1. mutate the canonical artifact entry
2. update top-level metadata timestamps/source
3. regenerate the corresponding local compatibility target:
   - plaintext to `.hack/.env`
   - secret to the configured secret backend
4. keep the other compatibility target untouched unless the entry kind changed

If an entry changes kind:

- `plaintext -> secret`: remove it from `.hack/.env`, then write it to the secret backend
- `secret -> plaintext`: remove it from the secret backend, then write it to `.hack/.env`

`hack env list` should show:

- contract intent
- artifact intent and value kind
- local compatibility resolution status
- drift when local files do not match the canonical artifact

## Service Scope Rules

Service scope belongs in the artifact because apply and export need stable intent even outside the originating machine.

Rules:

- omit or set `services` to `null` for all services
- store service names sorted and de-duplicated
- never infer service scope from `.hack/.env`
- when targeting a service subset, only required entries whose scope intersects that subset should block execution

## Migration And Compatibility

No existing repo should be forced to adopt the portable artifact immediately.

Initial compatibility rules:

- existing projects with only `.hack/hack.env.json` plus local values continue to work unchanged
- the portable artifact is opt-in
- import/export and remote publish/apply should use the new artifact
- local-only projects can be upgraded by normalizing current values into the artifact on first publish or explicit `env managed init`

## Validation And Error Handling

The schema should fail closed on structural errors and fail loud on semantic drift.

Rules:

- reject unknown schema versions
- reject entries without a valid uppercase env key
- reject duplicate keys inside one artifact during parser/CLI validation, since the JSON Schema cannot express key uniqueness within an array of objects
- reject invalid `value.kind` values
- reject non-array `services` values other than `null`/omitted
- reject empty `services` arrays
- sort and de-duplicate service names at serialization boundaries
- warn, rather than silently discard, when artifact keys are not declared in `.hack/hack.env.json`
- require explicit confirmation before applying artifact entries that are unknown to the contract

This keeps corruption visible and makes CLI behavior predictable for publish, fetch, and apply flows.

## Recommended Implementation Boundary

Implement the artifact as a typed model and serializer first, before wiring remote storage.

Suggested first implementation units:

- parser and serializer for `PortableProjectEnvArtifactV1`
- normalization from contract + `.hack/.env` + secret store into artifact shape
- materialization from artifact back into local compatibility files
- drift reporting between artifact and local compatibility state

## Testing Expectations

The first implementation should be verifiable with deterministic unit tests around the artifact model before any remote transport work lands.

Minimum test coverage:

- parse valid plaintext and secret entries
- reject invalid versions and duplicate keys
- preserve `required`, `services`, and `description` through parse/serialize round trips
- keep entry ordering stable by key and service ordering stable within each entry
- normalize current local contract + value state into the artifact without leaking secret entries into `.hack/.env`
- materialize artifact entries back into local compatibility storage, including kind changes and stale-key cleanup

## Notes

- The referenced Linear spec URL was not directly accessible from this environment, so this design is inferred from the issue text, current repo docs, and the existing remote env portability plan.
- This design intentionally keeps the remote encryption envelope out of the inner artifact schema to minimize version churn.
