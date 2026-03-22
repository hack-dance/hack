# Tickets Normalization Model

The normalized tickets model lives in `src/control-plane/extensions/tickets/normalized-model.ts`.
It defines the canonical entity shape that storage and adapter sync should converge on before the
legacy flat `TicketSummary` projection is retired.

## Goals

- Keep one canonical ticket entity for local-only and dual-homed work.
- Make ticket origin, external links, and field authority explicit.
- Keep provider-specific data out of canonical fields.
- Stay generic enough for Linear, GitHub, and Asana.

## Entity Shape

```ts
type NormalizedTicketEntity = {
  schemaVersion: 1
  kind: "ticket"
  id: string
  canonical: {
    title: string
    body?: string
    status: "open" | "in_progress" | "blocked" | "done"
    assignee?: string
    project?: { id?: string; name?: string }
    tags: string[]
    relationships: {
      dependsOn: string[]
      blocks: string[]
    }
    timestamps: {
      createdAt: string
      updatedAt: string
    }
  }
  provenance: {
    origin:
      | { kind: "local"; system: "hack" }
      | { kind: "external"; system: "linear" | "github" | "asana"; linkId: string }
    links: NormalizedTicketLink[]
    authority: NormalizedTicketAuthority
  }
}
```

## Provenance

`origin` answers where the ticket started:

- `local` means the ticket originated in Hack and may or may not have synced links yet.
- `external` means the ticket was imported from a provider and points at the authoritative link.

`origin` is derived from source lineage, not current ownership. A ticket can stay `origin.local`
while an external system is the current owner or sync target.

`links` tracks each external relationship explicitly:

```ts
type NormalizedTicketLink = {
  linkId: string
  system: "linear" | "github" | "asana"
  role: "origin" | "synced" | "reference"
  syncDirection: "pull" | "push" | "bidirectional"
  connection?: {
    profileId?: string
    accountId?: string
    workspaceId?: string
    workspaceName?: string
  }
  remote: {
    id: string
    key?: string
    url?: string
    containers: {
      kind: "project" | "team" | "repo" | "workspace" | "board" | "list"
      id: string
      name?: string
    }[]
  }
  adapterMetadata?: Record<string, TicketSchemaValue>
}
```

Why generic containers matter:

- Linear uses `project` and `team`
- GitHub uses `repo`
- Asana uses `workspace`, `project`, `board`, or `list`

Those stay normalized instead of introducing more `externalProject*`-style top-level fields.

## Authority

Authority is modeled separately from origin because a linked ticket can still remain Hack-owned.

```ts
type NormalizedTicketAuthority = {
  defaultRule: {
    policy: "replace" | "append" | "set_union"
    winner?: { kind: "local" } | { kind: "origin" } | { kind: "link"; linkId: string }
  }
  fieldRules: Partial<
    Record<
      | "title"
      | "body"
      | "status"
      | "assignee"
      | "project"
      | "tags"
      | "dependsOn"
      | "blocks",
      {
        policy: "replace" | "append" | "set_union"
        winner?: { kind: "local" } | { kind: "origin" } | { kind: "link"; linkId: string }
      }
    >
  >
}
```

Current defaults:

- Local-origin tickets: `defaultRule = replace/local`
- External-origin tickets: `defaultRule = replace/origin`
- `tags`, `dependsOn`, `blocks`: `set_union`

This matches current Linear sync behavior while leaving room for GitHub or Asana-specific field
ownership later.

## Schema Invariants

The schema is intentionally stricter than a plain JSON shape. A valid normalized ticket must also
satisfy these cross-record rules:

- `provenance.links[*].linkId` values are unique within a ticket.
- `provenance.links[*].linkId` must equal `${system}:${remote.id}` so persisted records keep a stable
  provider-derived identity.
- Local-origin tickets cannot carry an `origin`-role external link.
- External-origin tickets must point at a matching `origin`-role link with the same `system` and
  `linkId`.
- Any authority winner with `{ kind: "link", linkId }` must reference a link that exists on the
  same ticket.
- `canonical.tags`, `canonical.relationships.dependsOn`, `canonical.relationships.blocks`, and
  `provenance.links[*].remote.containers` are deduplicated sets in persisted state, not just
  normalized on write.
- `buildNormalizedTicketLink()` validates remote identifiers and URLs up front, so adapter code
  cannot emit blank link records accidentally.
- Legacy summaries with `source` set to an external provider must include matching
  `externalSystem` and `externalId`; the bridge rejects incomplete external lineage instead of
  rewriting it as a local ticket.

Those invariants are what make the model precise enough for storage migration, conflict resolution,
and multi-provider sync instead of just being a documentation-only shape.

## Adapter Metadata Boundary

Canonical fields stop at `canonical`, `provenance.origin`, `provenance.links[*].remote`, and
`provenance.authority`.

Everything provider-specific goes in `adapterMetadata`, for example:

- Linear state ids or cycle ids
- GitHub label payloads, milestone ids, or issue type metadata
- Asana custom fields or section ids

That boundary lets storage index the normalized fields without understanding every provider payload.

## Migration Boundary

The current git-backed tickets store still materializes `TicketSummary` with flat `external*`
fields. `normalizeLegacyTicketSummary()` is the bridge layer that maps the legacy projection into
the normalized entity until storage is migrated.

Comments are intentionally out of scope for this core ticket entity. They remain separate ticket
records in the current store and should become their own normalized sync surface rather than a
field on `NormalizedTicketEntity`.
