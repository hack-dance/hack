# Linear Autosync Tickets Design

## Context

Hack Desktop now has the core Linear integration working: OAuth/app install, project binding, webhook ingress, manual sync, and project-level binding UI. The remaining problem is product shape. The tickets surface still behaves like an operator console with explicit `Pull` and `Push` actions, extra sync chrome, and too much decorative framing. The project settings surface still exposes concepts like `routing` and optional extra-project controls more prominently than the common case requires.

The desired end state is closer to Linear's interaction model: tickets are the working surface, sync is mostly automatic, and manual repair paths exist but are secondary.

## Goals

- Make Linear sync autosync-first rather than manual-first in the main desktop workflow.
- Remove primary `Pull` / `Push` actions from the main Tickets header.
- Keep Hack-origin ticket creation in Linear opt-in per project.
- Let Linear-origin tickets auto-ingest into Hack for the bound project.
- Ensure dual-homed tickets continue syncing back to their source side according to existing field-ownership rules.
- Simplify `Project settings -> Ticket sync` to only the common configuration:
  - bound Linear project
  - inbound autosync from Linear
  - optional Hack-to-Linear auto-create toggle
- Make the tickets surface denser, calmer, more monospaced, and visually closer to Linear.
- Remove redundant status/source/authority badges from the main list.

## Non-Goals

- No new ticket ownership model.
- No new conflict-resolution semantics.
- No migration away from git-backed tickets.
- No removal of manual sync/repair commands from the CLI.
- No redesign of the entire desktop shell outside the tickets/detail/project-settings surfaces touched here.

## Sync Model

### Default behavior

For a project with a bound Linear project:

- `Sync from Linear`: enabled by default
  - inbound Linear updates arrive via webhook-backed autosync where possible
  - periodic reconcile remains as a fallback/backstop
- `Create Hack tickets in Linear`: disabled by default
  - Hack-origin tickets stay local unless explicitly enabled per project

### Linear-origin tickets

- Auto-ingest into Hack for the bound project.
- After ingestion, edits from Hack still sync back to Linear according to current field ownership and append-only comment rules.
- External updates should reach the app without requiring the user to manually press `Pull`.

### Hack-origin tickets

- Stay local by default.
- If `Create Hack tickets in Linear` is enabled for the project, new Hack-origin tickets auto-create in Linear.
- Once created remotely, they become dual-homed and continue syncing in both directions according to the existing source/authority rules.

### Manual repair

Manual sync remains available, but not as the main desktop control.

It should move to a smaller recovery surface such as:
- Tickets overflow menu
- project advanced settings
- CLI-only repair flows

## UI Model

### Tickets surface

The tickets page should behave like a working list, not a dashboard card.

#### Layout
- Use the full content width in the context pane.
- Remove the outer rounded-card treatment around the ticket list.
- Keep row dividers, group headers, and split-pane structure.
- Use monospaced typography through the tickets workspace where practical:
  - headers
  - filters
  - ids
  - metadata
  - detail sidebar/meta blocks

#### Header controls
Keep only:
- status filter
- source filter
- search
- primary Linear project selector / summary
- `New`
- small overflow menu

Remove primary `Pull` and `Push` buttons from the main Tickets header.

#### Sync strip
Replace the current operational sync strip with a quiet status/config strip:
- bound Linear project
- inbound sync state
- whether Hack-to-Linear auto-create is enabled
- subtle health indicator if sync is unhealthy

This strip should be informational and lightly configurable, not action-heavy.

#### Ticket rows
Borrow Linear's row structure:
- left: status icon, ticket id, title
- optional inline hierarchy hint for parent/sub-issue relationship
- right: only relevant metadata when present (assignee, project, updated date, etc.)

Remove from the main list rows:
- grouped status badges inside each row
- duplicate `hack` badges
- `Hack authority` pills as persistent default chrome

Authority/source can still appear in detail metadata or only when it matters.

### Ticket detail

Move closer to Linear's issue detail structure:
- calmer title/meta top band
- activity/comments/review notes in a single chronological stream
- tighter grouped metadata
- fewer decorative pills and callouts

Review/conflict state should remain visible, but only when relevant.

### Project settings

Rename the mental model from `routing` to `Ticket sync`.

Common-case controls only:
- `Linear project`
- `Sync from Linear` toggle
- `Create Hack tickets in Linear` toggle

Do not show additional project linking controls by default.
Keep advanced or rare multi-project scope out of the common settings path unless the repo already uses it.

## Data / State Impact

### Desktop state

- Tickets view should stop doing full dashboard refreshes after each sync mutation.
- Project settings should not live-reload off generic dashboard refresh ticks.
- Autosync state should be refreshed explicitly where needed, not by page-wide churn.
- Ticket list caching should remain bounded and stale-safe.

### Backend / sync behavior

- Webhook ingress is already live on the Railway-backed auth broker.
- The remaining behavior work is about auto-applying inbound sync to local state and reducing visible reliance on manual pull/push.
- Periodic reconcile should remain available as a silent fallback.

## Risks

- Hiding manual sync too aggressively can make repair harder if autosync state is unclear.
- Making Hack-to-Linear creation automatic once enabled must avoid surprising users with project-wide noise.
- Density changes must preserve scannability and keyboard navigation.
- Linear-style simplification should not erase Hack-specific review/conflict affordances.

## Validation

- Verify webhook-backed sync path remains live and configured on the broker.
- Verify bound project autosync works without `Pull` / `Push` in the main tickets flow.
- Verify Hack-origin auto-create stays off by default and only activates when enabled.
- Verify ticket list remains responsive during sync.
- Verify project settings no longer expose unnecessary modal/routing chrome.
- Verify the desktop build and targeted sync tests pass.
