# Linear Desktop UX Cleanup Design

## Context

The current Hack Desktop Linear experience is functional but too loud. The tickets surface carries a large sync policy banner, project routing behaves like an operational dashboard instead of a configuration surface, and the project sidebar visually treats drawer utilities as if they were active navigation states. The result is a UI that feels busier and more confusing than the sync model actually is.

## Goals

- Make `Tickets` the primary operational surface for Linear sync and review.
- Convert `Project routing` into a focused configuration sheet.
- Remove oversized guidance chrome and replace it with compact inline status.
- Ensure the project sidebar highlights only the visible pane; drawers remain utilities.
- Tighten typography, spacing, and grouping so project pages feel calm and usable.

## Non-Goals

- No changes to sync authority rules, routing semantics, or broker behavior.
- No redesign of global settings in this pass.
- No new sync engine features.

## Interaction Model

### Tickets-first operation

`Tickets` becomes the place where day-to-day sync work happens:
- project-level pull, push, autosync, and review entry points live in the tickets header
- selected-ticket sync actions stay in the detail footer
- review and conflict guidance appears close to the selected ticket rather than in a page-wide banner

### Routing as setup, not operations

`Project routing` becomes a small focused sheet opened from `Tickets`.

The sheet has only three functional groups:
- Account
- Default Linear project
- Additional synced projects

Autosync remains configurable per route, but bulk operational buttons move out of routing.

### Sidebar rules

The project sidebar only reflects the currently visible content pane. Terminal and logs drawers are not navigation destinations and should not inherit active selection treatment when they are closed.

## UI Changes

### Tickets

- Replace the large Linear policy callout with a slim status row near the sync controls.
- The status row summarizes:
  - connection state
  - routed/default project summary
  - autosync enabled count
  - review-needed count when non-zero
- Keep operational actions compact and scope-aware:
  - `Pull`
  - `Push`
  - `Run autosync`
  - `Review`
  - `Routing`
- Keep the split-pane feel, but reduce visual noise in the detail pane:
  - warnings only for actual review/conflict state
  - calmer default linked-ticket presentation
  - fewer metadata pills
- Keep the empty state minimal: `New ticket`, `Pull`, `Routing`.

### Routing Sheet

- Present routing as a focused sheet/overlay from `Tickets`.
- Default project is visually primary.
- Additional projects are lightweight rows with remove/default actions.
- Autosync is shown as a secondary toggle on bound routes.
- No pull/push/autosync execution buttons in the routing sheet.
- If no account is connected, collapse to a short explanation plus `Connect Linear`.

### Project Detail

- Remove routing-heavy operational chrome from the project page.
- Keep only a compact entry point into routing from the project surface.
- Reduce stacked cards/banners and rely on inline footnotes or one warning callout only when required.

### Sidebar/Typography/Spacing

- Only visible panes get active treatment.
- Drawer actions render as utilities, not selected navigation.
- Reduce use of monospace as section-title chrome.
- Use tighter grouping for related controls and larger separation between unrelated sections.
- Avoid nested boxed surfaces when the parent container already provides structure.

## Data / State Impact

This pass should reuse existing state where possible:
- current route/account/project status from `TicketsView`
- existing project routing state from `ProjectDetailView`
- existing review counts, authority, and sync state from ticket models

No new persistence model is required.

## Risks

- Moving routing into a sheet can break existing project-page navigation affordances if the open/close state is not wired cleanly.
- Compacting status too aggressively can hide important review state; the replacement row must still surface actionable warnings.
- Sidebar cleanup must preserve keyboard/navigation behavior even as visual selection logic changes.

## Validation

- Build the macOS package successfully.
- Verify ticket-level sync actions remain reachable.
- Verify routing sheet still supports account binding, default project selection, additional projects, and autosync toggles.
- Verify sidebar active state only follows visible content panes.
- Perform a live visual sanity check against the running Hack Desktop app if feasible.
