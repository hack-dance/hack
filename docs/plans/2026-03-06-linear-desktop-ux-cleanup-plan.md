# Linear Desktop UX Cleanup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Hack Desktop's Linear flow calmer and more usable by shifting operations into Tickets, shrinking routing into focused configuration, and fixing misleading sidebar active states.

**Architecture:** Reuse existing routing and sync state, but move the presentation boundary: Tickets becomes the operational split-pane, Project routing becomes a focused sheet opened from Tickets, and the project sidebar becomes strictly pane-selection UI. Keep logic changes narrow and avoid touching the sync engine or broker contract.

**Tech Stack:** SwiftUI, shared desktop models, HackCLI macOS client, existing Linear routing/sync commands.

---

### Task 1: Capture failing UX expectations in the macOS ticket surface

**Files:**
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/TicketsView.swift`
- Test/Verify: `apps/macos` Swift package build

**Step 1: Identify the current policy banner and operational header composition**

Inspect the current `linearSyncPolicyCallout`, header badges, empty state actions, and ticket detail footer.

**Step 2: Define the compact replacement surface**

Specify the exact row contents needed for a compact sync status row and confirm the existing state fields can drive it.

**Step 3: Build the compact status row and remove the large banner**

Implement a slim inline sync status row near the Tickets sync controls.

**Step 4: Verify the package still builds**

Run: `swift build --package-path apps/macos`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/TicketsView.swift
git commit -m "Refine desktop ticket sync chrome"
```

### Task 2: Move project routing to a focused sheet

**Files:**
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/TicketsView.swift`
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/ProjectDetailView.swift`
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/DashboardModel.swift`
- Modify: `apps/macos/Packages/Services/HackCLI/Sources/HackCLIService/HackCLIClient.swift`
- Modify: `apps/macos/Packages/Shared/Models/Sources/HackDesktopModels/Models.swift`

**Step 1: Write the failing integration expectation**

Define the desired interaction: `Tickets` opens a routing sheet that supports account binding, default project, additional projects, and autosync toggles without exposing bulk sync actions.

**Step 2: Extract or embed the focused routing sheet UI**

Create the focused routing presentation using existing project routing state and actions.

**Step 3: Remove operational sync controls from the project routing surface**

Delete pull/push/autosync execution controls from routing and keep only configuration controls.

**Step 4: Rebuild the macOS package**

Run: `swift build --package-path apps/macos`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/TicketsView.swift apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/ProjectDetailView.swift apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/DashboardModel.swift apps/macos/Packages/Services/HackCLI/Sources/HackCLIService/HackCLIClient.swift apps/macos/Packages/Shared/Models/Sources/HackDesktopModels/Models.swift
git commit -m "Move desktop Linear routing into a focused sheet"
```

### Task 3: Fix sidebar active-state behavior and project detail chrome

**Files:**
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/ProjectDetailView.swift`

**Step 1: Identify the drawer/visible-pane selection coupling**

Trace how `selectedSidebarItem`, drawer actions, and navigation requests interact.

**Step 2: Implement the minimal selection rule change**

Ensure only visible panes get active treatment and drawer utilities stay visually inactive unless actually open.

**Step 3: Tighten section spacing and typography in the project surface**

Reduce stacked callouts and simplify section labels where the view is currently overly dense.

**Step 4: Rebuild the macOS package**

Run: `swift build --package-path apps/macos`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/ProjectDetailView.swift
git commit -m "Clean up desktop project sidebar and routing layout"
```

### Task 4: Full verification and visual sanity check

**Files:**
- Verify: repo root gates

**Step 1: Run repo verification gates**

Run:
```bash
bun run build
bun run typecheck
bun run test
bun run check
hack ps
swift build --package-path apps/macos
```
Expected: PASS

**Step 2: Run a live desktop sanity check**

Use the running Hack Desktop app or a fresh launch to verify the compact Tickets surface, routing sheet, and sidebar active-state behavior.

**Step 3: Commit the final integrated cleanup**

```bash
git add docs/plans/2026-03-06-linear-desktop-ux-cleanup-design.md docs/plans/2026-03-06-linear-desktop-ux-cleanup-plan.md apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/TicketsView.swift apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/ProjectDetailView.swift apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/DashboardModel.swift apps/macos/Packages/Services/HackCLI/Sources/HackCLIService/HackCLIClient.swift apps/macos/Packages/Shared/Models/Sources/HackDesktopModels/Models.swift
git commit -m "Polish desktop Linear routing and ticket UX"
```
