# Linear Sync Phase 2 Design

## Goal
Ship the next phase of the Linear integration with durable sync state, append-only comment sync, assignee mapping, webhook-driven pending updates, and user/team-aware server-side ownership.

## Existing Foundation
- Tickets remain git-backed via `.hack/tickets` event logs.
- Manual Linear OAuth, profile routing, project binding, and manual sync already exist.
- Auth broker already has Better Auth plus organization/team primitives and a Neon/Postgres database.
- The macOS app already exposes global Linear settings, project routing, and ticket-level sync controls.

## Decisions
- Keep ticket source-of-truth local and git-backed.
- Do not introduce SQLite in this phase.
- Use Postgres in the auth broker for remote webhook/event durability and access metadata.
- Keep manual sync as the default; webhook events should become pending work that local clients can apply.
- Continue origin-derived authority:
  - `hack` owns title/body/status/project binding for hack-origin tickets.
  - `linear` owns title/body/status/project binding for linear-origin tickets.
- Comments are append-only, immutable, FIFO. No edit/delete mirroring.
- Assignees, labels, dependencies, and sub-issue links remain mergeable best-effort fields.
- Ambiguous mergeable-field updates or dual-edited authoritative fields create durable review records instead of silent overwrite.

## Sync Data Model
### Local ticket store
Extend local ticket data with:
- `assignee?: string`
- append-only ticket comments
- sync checkpoints per external system/profile
- durable sync conflict records
- durable conflict resolutions

New local ticket event types:
- `ticket.comment_appended`
- `ticket.assignee_set`
- `ticket.sync_checkpointed`
- `ticket.sync_conflict_recorded`
- `ticket.sync_conflict_resolved`

The ticket detail response should grow from `ticket + events` to:
- `ticket`
- `events`
- `comments`
- `conflicts`
- `syncState`

### Broker database
Add durable broker tables for Linear sync infrastructure:
- `linear_connections`
  - profile/account linkage bound to Better Auth user/org/team where available
- `linear_assignee_mappings`
  - per profile/team local-user <-> Linear-user mappings
- `linear_webhook_events`
  - verified inbound webhook deliveries with delivery/apply status
- `linear_sync_subscriptions`
  - optional future autosync config per profile/project/team/user scope

Broker ownership model:
- connection records may exist without an authenticated Better Auth user in early/dev flows
- when Better Auth is available, bind connections to `userId` and optionally `organizationId` / `teamId`
- provider discovery remains public, but mutating broker routes should be designed so they can later require session/user context without changing core data shapes

## Access And Usage Direction
We are now shipping real server-backed integration state, so the design must stop assuming a single trusted operator forever.

Phase 2 access model:
- Treat every remote Linear connection as a first-class broker record.
- Record who created or refreshed a connection when Better Auth is enabled.
- Preserve room for org/team scoping even if enforcement starts permissive.
- Keep CLI/macOS local use working when Better Auth is disabled locally.

Practical rule set for this phase:
- Local ticket mutations remain local and repo-scoped.
- Broker webhook/event persistence is server-scoped.
- Broker records should store optional `betterAuthUserId`, `organizationId`, and `teamId` fields when known.
- Future enforcement can then answer:
  - who owns this connection?
  - which team/project may apply these pending events?
  - who consumed/applicated a webhook delivery?

We are not building full billing/quota enforcement in this phase, but we are adding the ownership fields needed for it.

## Sync Mechanics
### Comments
- Pull from Linear:
  - fetch issue comments
  - append only comments not yet seen locally
  - never rewrite or delete local comment history
- Push from Hack:
  - append only local comments not yet mirrored to Linear
  - use dedupe markers/cursors so the same comment is never reposted

### Assignees
Resolution order:
1. explicit assignee mapping for the selected Linear profile/team
2. normalized email match
3. normalized display-name match
4. unresolved -> record conflict/review-needed and leave current assignee unchanged

### Conflicts
Create durable conflict records when:
- both sides changed an origin-owned field since the last checkpoint
- assignee mapping is ambiguous
- dependency/sub-issue target cannot be resolved safely
- comment append target cannot be deduped confidently

Conflict records should include:
- ticket id
- field/category (`title`, `body`, `status`, `project`, `assignee`, `dependency`, `comment`)
- local value summary
- remote value summary
- authority expectation
- detected at timestamp
- status (`open`, `resolved_hack`, `resolved_linear`, `ignored`)

### Webhook flow
- Railway broker verifies and stores Linear webhook deliveries.
- Local CLI/macOS can fetch pending deliveries for the selected profile/project/team.
- Applying a delivery runs the same sync engine used by manual sync.
- Manual remains the default UX; autosync can later become a per-project subscription that simply auto-applies pending deliveries.

## CLI / MCP / macOS Surfaces
### CLI
Add commands for:
- pending webhook event list/apply
- assignee mapping list/set/remove
- conflict list/show/resolve
- ticket comment append/list if needed for parity

### MCP
Expose the new manual tools through MCP:
- list/apply pending Linear deliveries
- list/resolve sync conflicts
- manage assignee mappings

### macOS
Add:
- ticket detail comments section
- ticket detail sync review/conflicts section
- tickets filter for `Needs review`
- settings section for assignee mappings and broker ownership diagnostics
- project-level pending webhook/apply controls

## Testing
- TDD for every new sync primitive.
- ticket store tests for new event materialization
- broker tests for new DB-backed webhook queue semantics
- CLI tests for conflict/mapping/apply commands
- macOS model tests for conflict/review state derivation

## Non-Goals
- No SQLite migration
- No comment edit/delete sync
- No fully automatic background daemon sync on day one
- No full RBAC or billing/quota enforcement in this phase
