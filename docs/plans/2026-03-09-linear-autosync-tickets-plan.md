# Linear Autosync Tickets Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Hack Desktop tickets autosync-first for Linear, remove primary manual sync controls from the main UI, and simplify the ticket/workflow surface to feel denser and closer to Linear.

**Architecture:** Keep the existing Linear sync engine, webhook ingress, and field-ownership rules. Shift the product boundary instead: default to inbound autosync, keep outbound Hack-to-Linear creation opt-in per project, move manual repair flows out of the primary tickets header, and simplify desktop state management so sync no longer causes visible churn.

**Tech Stack:** SwiftUI, Hack Desktop shared models, HackCLI macOS client, existing Linear CLI commands, auth-broker webhook/autosync plumbing, Bun tests.

---

### Task 1: Encode the autosync-first project sync policy

**Files:**
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/ProjectDetailView.swift`
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/DashboardModel.swift`
- Modify: `apps/macos/Packages/Services/HackCLI/Sources/HackCLIService/HackCLIClient.swift`
- Modify: `apps/macos/Packages/Shared/Models/Sources/HackDesktopModels/Models.swift`
- Test: `apps/macos` Swift package build

**Step 1: Define the common-case project sync fields**

Reduce the project settings `Ticket sync` surface to the fields that should remain visible by default:
- bound Linear project
- inbound autosync enabled/disabled
- Hack-to-Linear auto-create enabled/disabled

**Step 2: Remove primary multi-project routing from the default surface**

Keep additional project controls out of the common settings path unless the repo already has them configured.

**Step 3: Wire the project toggles to the existing sync model**

Use the current CLI/model plumbing or extend it minimally so the UI can persist the autosync-first settings without reintroducing modal routing behavior.

**Step 4: Build the macOS package**

Run: `swift build --package-path apps/macos`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/ProjectDetailView.swift apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/DashboardModel.swift apps/macos/Packages/Services/HackCLI/Sources/HackCLIService/HackCLIClient.swift apps/macos/Packages/Shared/Models/Sources/HackDesktopModels/Models.swift
git commit -m "Simplify project ticket sync defaults"
```

### Task 2: Remove primary Pull/Push controls from the tickets header

**Files:**
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/TicketsView.swift`
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/DashboardModel.swift`

**Step 1: Replace manual sync chrome with a compact sync status strip**

The Tickets header should show:
- bound Linear project
- inbound sync state
- outbound auto-create state
- health only when needed

**Step 2: Move manual repair actions to overflow**

Retain manual recovery paths such as reconcile/repair, but remove `Pull` and `Push` from the primary header.

**Step 3: Ensure sync actions no longer depend on full dashboard refresh**

Keep the responsiveness work intact while removing the visible manual action model.

**Step 4: Build the macOS package**

Run: `swift build --package-path apps/macos`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/TicketsView.swift apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/DashboardModel.swift
git commit -m "Make desktop tickets autosync-first"
```

### Task 3: Densify the tickets list and remove redundant badges

**Files:**
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/TicketsView.swift`

**Step 1: Remove outer card framing around the ticket list**

Keep section headers and row dividers, but remove the enclosing rounded-box treatment in the tickets content area.

**Step 2: Tighten row density and switch ticket workspace typography toward monospace**

Apply denser spacing and monospaced treatment where appropriate for the tickets list and related metadata.

**Step 3: Remove redundant per-row badges**

Drop row-level grouped status badges and duplicate source/authority pills that do not add useful information in the grouped list view.

**Step 4: Keep row structure closer to Linear**

Use a left-heavy structure: status icon, id, title, inline hierarchy hint; only show right-side metadata when present.

**Step 5: Build the macOS package**

Run: `swift build --package-path apps/macos`
Expected: PASS

**Step 6: Commit**

```bash
git add apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/TicketsView.swift
git commit -m "Densify desktop ticket list"
```

### Task 4: Reshape the ticket detail pane closer to Linear

**Files:**
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/TicketsView.swift`
- Modify: any supporting detail subviews already used by the tickets detail path

**Step 1: Simplify the title/meta band**

Reduce decorative badges and restructure the top of the detail pane around title, hierarchy, and compact metadata.

**Step 2: Keep activity/comments/review notes in one chronological flow**

Do not split the detail pane into multiple competing content blocks unless required for functionality.

**Step 3: Keep Hack-specific review/conflict state visible but secondary**

Only show stronger callouts when the issue actually needs intervention.

**Step 4: Build the macOS package**

Run: `swift build --package-path apps/macos`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/TicketsView.swift
git commit -m "Refine desktop ticket detail layout"
```

### Task 5: Ensure autosync behavior is the default desktop path

**Files:**
- Modify: `src/control-plane/extensions/linear/commands.ts`
- Modify: `src/mcp/server.ts` if desktop-exposed sync behavior needs plumbing
- Modify: any auth-broker autosync route files only if behavior changes are required there
- Test: `tests/linear-commands.test.ts`, relevant autosync tests

**Step 1: Confirm the current desktop-visible sync path matches the approved contract**

Ensure:
- inbound Linear sync is default for bound projects
- Hack-to-Linear auto-create is opt-in
- dual-homed tickets still sync back to their source side

**Step 2: Add or update any missing config/state needed for those defaults**

Keep this minimal and avoid reopening the sync model.

**Step 3: Run targeted tests**

Run: `bun test tests/linear-commands.test.ts tests/linear-client.test.ts tests/tickets-extension.test.ts tests/tickets-git-channel.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/control-plane/extensions/linear/commands.ts src/mcp/server.ts tests/linear-commands.test.ts tests/linear-client.test.ts tests/tickets-extension.test.ts tests/tickets-git-channel.test.ts
git commit -m "Default Linear desktop sync to autosync behavior"
```

### Task 6: Full verification and live sanity check

**Files:**
- Verify repo gates and desktop build
- Modify docs if implementation details changed materially from design

**Step 1: Run verification gates**

Run:
```bash
bun run build
bun run typecheck
bun run test
bun run check
hack ps
swift build --package-path apps/macos
xcodebuild -project apps/macos/HackDesktop.xcodeproj -scheme HackDesktop -configuration Debug -derivedDataPath /tmp/hackdesktop-derived-linear-autosync build
```
Expected: PASS

**Step 2: Perform live desktop sanity check**

Verify:
- no primary `Pull` / `Push`
- compact sync strip
- denser ticket rows
- bound Linear project visible
- ticket detail still usable
- project `Ticket sync` settings reflect the autosync-first defaults

**Step 3: Commit final integrated changes**

```bash
git add docs/plans/2026-03-09-linear-autosync-tickets-design.md docs/plans/2026-03-09-linear-autosync-tickets-plan.md apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/TicketsView.swift apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/ProjectDetailView.swift apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/DashboardModel.swift apps/macos/Packages/Services/HackCLI/Sources/HackCLIService/HackCLIClient.swift apps/macos/Packages/Shared/Models/Sources/HackDesktopModels/Models.swift src/control-plane/extensions/linear/commands.ts src/mcp/server.ts tests/linear-commands.test.ts tests/linear-client.test.ts tests/tickets-extension.test.ts tests/tickets-git-channel.test.ts
git commit -m "Finish autosync-first desktop tickets flow"
```
