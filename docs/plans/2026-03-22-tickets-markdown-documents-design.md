# Tickets Markdown Documents Design

## Goal

Add ticket-linked markdown documents so specs and working notes can live beside normalized ticket state without losing plain-text portability, git readability, or clean integration boundaries.

## Constraints

- Keep tickets local-first and git-backed under `.hack/tickets/`.
- Fit beside the normalized ticket core rather than replacing it with a second document system.
- Keep markdown files readable as normal `.md` files without requiring Hack-specific tooling.
- Avoid inventing rich document semantics such as comments, blocks, or WYSIWYG structure in v1.
- Keep external ticket sync conservative. Extra documents should not silently become remote issue comments or attachments.

## Design Summary

- The normalized ticket record stays small and owns document metadata.
- Document content lives in plain markdown files on disk, one file per document.
- Ticket `body` remains the short overview field for lists, summaries, and lightweight integrations.
- Richer long-form content moves into ticket documents with explicit metadata:
  - `spec`
  - `notes`
  - `attachment`
- Documents are stored inside the same ticket-scoped directory as normalized ticket state and sync through the existing tickets git ref.
- Exactly zero or one document may opt into `ticket_body` projection for integrations that only have a single body field. All other documents stay local-only.

## Normalized Model

Each normalized ticket record gains a `documents` array.

```json
{
  "ticketId": "T-00042",
  "title": "Normalize ticket storage",
  "body": "Short overview used in lists and lightweight sync targets.",
  "status": "in_progress",
  "documents": [
    {
      "documentId": "doc_01HV6M3Y7P8JQ6J6V2M4G2R5HX",
      "slug": "spec",
      "title": "Normalization spec",
      "kind": "spec",
      "format": "markdown",
      "path": "docs/spec.md",
      "role": "primary",
      "syncMode": "ticket_body",
      "createdAt": "2026-03-22T18:30:11.000Z",
      "updatedAt": "2026-03-22T20:01:04.000Z",
      "createdBy": "symphony@hack",
      "updatedBy": "symphony@hack"
    },
    {
      "documentId": "doc_01HV6M43TQX11P1Q3V14F5FD8A",
      "slug": "working-notes",
      "title": "Working notes",
      "kind": "notes",
      "format": "markdown",
      "path": "docs/working-notes.md",
      "role": "secondary",
      "syncMode": "local_only",
      "createdAt": "2026-03-22T18:41:08.000Z",
      "updatedAt": "2026-03-22T18:41:08.000Z"
    }
  ]
}
```

### Document Metadata

Required fields:

- `documentId`: stable identity for references and renames
- `slug`: ticket-local selector used for human selection and path derivation
- `title`: user-facing label
- `kind`: `spec | notes | attachment`
- `format`: `markdown`
- `path`: ticket-local relative path to the markdown file
- `role`: `primary | secondary`
- `syncMode`: `local_only | ticket_body`
- `createdAt`
- `updatedAt`

Optional fields:

- `createdBy`
- `updatedBy`
- `source`: `hack | imported | mirrored`
- `externalUrl`: when the markdown file is a repo-local copy of an external spec

### Semantics

- `spec`: durable long-form design or implementation document tied to the ticket.
- `notes`: mutable working notes, investigation logs, and handoff context.
- `attachment`: supporting markdown imported from elsewhere or kept as a secondary reference.
- `primary`: the default document shown in ticket detail and the only role eligible for `ticket_body` projection.
- `secondary`: visible in detail and CLI document lists, but not used as the default rendered document.
- `ticket_body`: project the markdown content into a single remote issue body field when a sync integration explicitly supports it.
- `local_only`: keep the document repo-shared only.

Rules:

- A ticket may have many documents.
- A ticket may have at most one `primary` document.
- A ticket may have at most one document with `syncMode: "ticket_body"`.
- `syncMode: "ticket_body"` is only valid on a `primary` document.
- `slug` must be unique within a ticket.

## On-Disk Layout

Documents live beside normalized ticket state, not inside JSON blobs.

```text
.hack/tickets/
  tickets/
    T-00042/
      ticket.json
      docs/
        spec.md
        working-notes.md
```

Rules:

- All document files are UTF-8 markdown with LF line endings.
- Filenames are lower-kebab-case and end in `.md`.
- `path` is always relative to the ticket directory.
- Hack does not require YAML frontmatter. Existing frontmatter may be preserved but is not authoritative for metadata.
- The normalized record, not the markdown heading, is the source of truth for `title`, `kind`, `role`, and `syncMode`.

## Storage And Sync Rules

### 1. Authority

- `ticket.json` owns document metadata.
- `docs/*.md` owns document content.
- A document update may change metadata, content, or both, but both changes should land in the same tickets-ref commit when they are part of one user action.

### 2. Sync Surface

- Document files live under `.hack/tickets/**`, so they sync with the same hidden tickets ref as normalized ticket state.
- No separate git ref, blob store, or broker table is needed for repo-shared markdown documents.
- Normalization should canonicalize:
  - relative paths
  - filename casing
  - LF endings
  - stable JSON key order in `ticket.json`

### 3. Lifecycle

Create:

- Add metadata entry to `ticket.json`
- Write markdown file to `docs/<slug>.md`

Update content:

- Rewrite only the markdown file
- Update `updatedAt` and `updatedBy` in `ticket.json`

Rename:

- Change `slug`, `title`, and `path` in `ticket.json`
- Rename the markdown file in the same commit
- Preserve `documentId`

Delete:

- Remove the metadata entry from `ticket.json`
- Delete the markdown file in the same commit
- Rely on git history for recovery rather than adding a second soft-delete system

### 4. Conflict Model

- Repo-local document edits rely on normal git text merge behavior first.
- Hack should not invent line-level document merge semantics in the ticket model.
- If a document is projected into an external ticket body, projection conflicts are handled at the sync boundary, not by rewriting the local markdown model.

### 5. External Integrations

- Extra documents are `local_only` by default.
- Integrations that only support one markdown body may read from the single `ticket_body` document.
- External systems should not receive secondary documents until Hack adds an explicit export or attachment transport for them.
- If no document is marked `ticket_body`, integrations continue using the normalized ticket `body` field exactly as they do today.

This keeps the markdown document model portable while avoiding accidental remote noise.

## Workflow Guidance

### CLI

Documents should become a first-class sub-surface instead of overloading `body`.

Recommended commands:

- `hack tickets docs list <ticket-id>`
- `hack tickets docs show <ticket-id> <document-id|slug>`
- `hack tickets docs add <ticket-id> --kind spec --title "..." [--primary] [--stdin|--file]`
- `hack tickets docs update <ticket-id> <document-id|slug> [--stdin|--file]`
- `hack tickets docs remove <ticket-id> <document-id|slug>`

`hack tickets show` should:

- keep the short ticket body summary
- list document metadata in a `Documents` section
- identify which document is primary and whether one is projected to `ticket_body`

`hack tickets show --json` should return document metadata by default and include markdown content only behind an explicit flag such as `--include-documents` to avoid bloated agent payloads.

### TUI And Desktop

- Ticket list surfaces should show only a lightweight document indicator, not full markdown previews.
- Ticket detail should show:
  - short overview body
  - primary document preview or open action
  - secondary documents list
- Specs and notes should read as repo-backed artifacts, not synced comments.

### Agents And MCP

- Agent-facing ticket detail should expose document metadata and filesystem paths by default.
- Inline markdown content should be opt-in to keep prompts bounded.
- Agents should be able to reference documents as stable ticket-scoped assets instead of scraping long markdown out of `ticket.body`.

### Integrated Workflows

- For Linear or similar issue trackers, Hack keeps syncing the normalized ticket summary fields as today.
- A team that wants its long-form spec mirrored into the remote issue description can opt one primary document into `ticket_body`.
- Secondary notes remain local/repo-shared unless a later feature adds explicit publish/export semantics.

## Why This Fits The Normalized Core

- The ticket record stays normalized: metadata in structured JSON, content in files.
- Document identity is stable independent of path changes.
- Markdown content is not duplicated into multiple structured stores.
- The model preserves the current local-first tickets ref instead of introducing a second persistence system.
- It gives the normalized core a single attachment shape now, so future UI and sync work can build on fixed semantics rather than inventing them ad hoc.

## Non-Goals

- Binary attachments
- Rich-text block models
- Inline comments or annotations
- Automatic export of every ticket document to external systems
- Replacing the existing append-only history model with document diffs

## Implementation Notes

This model should be implemented as part of the normalized ticket layout, not by stuffing markdown into event payloads.

During migration from the current event-log-only store:

- keep `ticket.body` as the short summary field
- add normalized document metadata plus `docs/*.md` files
- treat markdown documents as first-class normalized assets
- keep legacy event logs as history and operational input until the normalized core fully owns ticket reads
