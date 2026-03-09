# Linear Sync UX Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Linear sync behavior understandable in the macOS app by surfacing authority, merge rules, review-needed states, and clearer action feedback.

**Architecture:** Keep the existing git-backed ticket substrate and broker/CLI sync commands. Add a small client-side sync UX model in `HackDesktopModels`, then apply it consistently across Tickets, Project Routing, and Linear Settings using existing `InlineCallout`, badge, and progress patterns.

**Tech Stack:** SwiftUI, Swift Package Manager, HackDesktopModels, DashboardFeature, HackCLIService

---

### Task 1: Add sync UX model helpers

**Files:**
- Modify: `apps/macos/Packages/Shared/Models/Sources/HackDesktopModels/Models.swift`
- Test: `apps/macos/Packages/Shared/Models/Tests/HackDesktopModelsTests/LinearSyncUXModelTests.swift`

**Step 1: Write the failing test**
- Add tests for derived authority, mergeable state, and review-needed messaging from `TicketSummary`.

**Step 2: Run test to verify it fails**
Run: `swift test --package-path apps/macos --filter LinearSyncUXModelTests`
Expected: FAIL because the sync UX helpers do not exist yet.

**Step 3: Write minimal implementation**
- Add lightweight sync UX helper types/functions to `Models.swift`.
- Keep them pure and derived from existing ticket metadata.

**Step 4: Run test to verify it passes**
Run: `swift test --package-path apps/macos --filter LinearSyncUXModelTests`
Expected: PASS

### Task 2: Upgrade Tickets tab sync affordances

**Files:**
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/TicketsView.swift`

**Step 1: Write the failing test**
- Covered indirectly by model tests; use compile/build as the verification gate for this view-only task.

**Step 2: Implement minimal UX changes**
- Replace raw `loadNotice` text with structured inline callout treatment.
- Add a sync policy callout near pull/push actions.
- Show per-ticket authority/review hints from the new model helpers.
- Add lightweight action confirmation for sync directions.

**Step 3: Run build to verify it compiles**
Run: `swift build --package-path apps/macos`
Expected: PASS

### Task 3: Upgrade project routing Linear UX

**Files:**
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/ProjectDetailView.swift`

**Step 1: Implement minimal UX changes**
- Add project-level sync contract callout.
- Improve bound-project status/result messages.
- Make pull/push actions explain authority and merge behavior.

**Step 2: Run build to verify it compiles**
Run: `swift build --package-path apps/macos`
Expected: PASS

### Task 4: Upgrade Linear settings guidance

**Files:**
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/SettingsOverlayView.swift`

**Step 1: Implement minimal UX changes**
- Add a concise global sync policy summary.
- Clarify what sync toggles affect and what remains append-only/review-needed.
- Improve auth/disconnect messaging where it intersects sync routing.

**Step 2: Run build to verify it compiles**
Run: `swift build --package-path apps/macos`
Expected: PASS

### Task 5: Final verification

**Files:**
- Verify only

**Step 1: Run focused model tests**
Run: `swift test --package-path apps/macos --filter LinearSyncUXModelTests`
Expected: PASS

**Step 2: Run macOS package build**
Run: `swift build --package-path apps/macos`
Expected: PASS

**Step 3: Run repo verification gates**
Run: `bun run build && bun run typecheck && bun run test && bun run check && hack ps`
Expected: PASS
