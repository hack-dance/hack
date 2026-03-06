import AppKit
import MarkdownUI
import SwiftUI

import HackDesktopModels

struct TicketsView: View {
  @Environment(DashboardModel.self) private var model
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.openURL) private var openURL

  let project: ProjectSummary

  @State private var tickets: [TicketSummary] = []
  @State private var selectedTicketId: String? = nil
  @State private var ticketDetail: TicketDetailResponse? = nil
  @State private var isLoading = false
  @State private var isDetailLoading = false
  @State private var errorMessage: String? = nil
  @State private var detailErrorMessage: String? = nil
  @State private var showCreateSheet = false
  @State private var selectedFilter: TicketFilter = .all
  @State private var selectedOriginFilter: TicketOriginFilter = .both
  @State private var hasLoadedOnce = false
  @State private var isPropertiesExpanded = false
  @State private var isHistoryExpanded = false
  @State private var searchText = ""
  @State private var loadNotice: String? = nil
  @State private var hoveredTicketId: String? = nil
  @State private var linearRouteProfile = ""
  @State private var linearRouteProjectId = ""
  @State private var linearRouteProjectName = ""
  @State private var linearRouteTeamId = ""
  @State private var linearAdditionalProjects: [LinearProjectBindingTarget] = []
  @State private var linearAutosyncRouteKeys: Set<String> = []
  @State private var linearRouteStatus: LinearStatusResponse? = nil
  @State private var pendingBulkSyncAction: TicketBulkSyncAction? = nil
  @State private var activeSyncAction: TicketSyncAction? = nil
  @State private var resolvingConflictIds: Set<String> = []
  @State private var postingCommentTicketIds: Set<String> = []
  @State private var postingReviewNoteTicketIds: Set<String> = []
  @State private var ticketDetailCache: [String: TicketDetailResponse] = [:]
  @State private var reviewComposerDrafts: [String: String] = [:]
  @FocusState private var ticketsListFocused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      header

      if let errorMessage {
        ticketsErrorCard(message: errorMessage)
      } else {
        content
      }
    }
    .padding(.horizontal, 24)
    .padding(.top, 12)
    .padding(.bottom, 24)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .task {
      await refreshLinearRouting()
      loadCachedTickets()
      await refreshTickets()
      ticketsListFocused = true
    }
    .task(id: selectedTicketId) {
      await loadTicketDetail()
    }
    .onChange(of: model.lastUpdated) { _, _ in
      Task { await refreshLinearRouting() }
    }
    .onChange(of: selectedFilter) { _, _ in
      updateSelectionAfterRefresh()
    }
    .onChange(of: selectedOriginFilter) { _, _ in
      updateSelectionAfterRefresh()
    }
    .onReceive(
      NotificationCenter.default.publisher(for: .hackTicketReviewQueueRequested)
    ) { notification in
      guard
        let userInfo = notification.userInfo,
        let requestedProjectId = userInfo[TicketReviewQueueRequest.projectIdKey] as? String,
        requestedProjectId == project.id
      else {
        return
      }
      activateReviewQueue()
    }
    .sheet(isPresented: $showCreateSheet) {
      TicketCreateSheet(
        projectName: project.name,
        onCreate: { input in
          Task {
            await createTicket(input)
          }
        }
      )
    }
    .confirmationDialog(
      pendingBulkSyncAction?.dialogTitle ?? "Confirm Linear sync",
      isPresented: bulkSyncConfirmationPresented,
      titleVisibility: .visible
    ) {
      if let pendingBulkSyncAction {
        Button(pendingBulkSyncAction.confirmLabel) {
          Task { await performBulkSync(pendingBulkSyncAction) }
        }
      }
      Button("Cancel", role: .cancel) {
        pendingBulkSyncAction = nil
      }
    } message: {
      if let pendingBulkSyncAction {
        Text(pendingBulkSyncAction.message)
      }
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .center, spacing: 12) {
        statusFilterMenu
        originFilterMenu
        searchField
        Spacer(minLength: 12)
        if let activeSyncAction {
          HStack(spacing: 8) {
            ProgressView()
              .controlSize(.small)
            Text(activeSyncAction.progressLabel)
              .font(.system(size: 12, weight: .medium, design: .monospaced))
              .foregroundStyle(.secondary)
          }
        }
        if reviewQueueCount > 0 {
          reviewQueueButton
        }
        newTicketButton
      }

      HStack(alignment: .center, spacing: 10) {
        linearSyncStatusRow
        Spacer(minLength: 12)

        Button {
          requestBulkSyncConfirmation(.pullLinear)
        } label: {
          Label("Pull", systemImage: "arrow.down.left")
        }
        .adaptiveToolbarButtonProminent()
        .disabled(!canSyncProjectFromLinear || isAnySyncInFlight)

        Button {
          requestBulkSyncConfirmation(.pushHack)
        } label: {
          Label("Push", systemImage: "arrow.up.right")
        }
        .adaptiveToolbarButton()
        .disabled(!canSyncProjectToLinear || isAnySyncInFlight)

        if hasAnyLinearAutosyncRoutes {
          Button {
            Task { await runProjectLinearAutosync() }
          } label: {
            Label("Run autosync", systemImage: "bolt.badge.clock")
          }
          .adaptiveToolbarButton()
          .disabled(linearRouteStatus?.tokenResolved != true || isAnySyncInFlight)
        }

        Button("Routing") {
          openProjectRouting()
        }
        .adaptiveToolbarButton()

        Menu {
          Button("Refresh") {
            Task { await refreshTickets() }
          }
          Button("Sync ticket ref store") {
            Task { await syncTickets() }
          }
          if let selectedTicket {
            Divider()
            Button("Push selected ticket to Linear") {
              Task { await syncSelectedTicketToLinear(selectedTicket) }
            }
            .disabled(linearRouteStatus?.tokenResolved != true || isAnySyncInFlight)
            Button("Refresh selected ticket from Linear") {
              Task { await syncSelectedTicketFromLinear(selectedTicket) }
            }
            .disabled(selectedTicket.externalKey?.isEmpty != false || isAnySyncInFlight)
            if let externalURL = selectedTicket.externalUrl,
               let url = URL(string: externalURL) {
              Button("Open linked Linear issue") {
                openURL(url)
              }
            }
          }
          Divider()
          Button("Open Linear settings") {
            NotificationCenter.default.post(
              name: .hackSettingsRequested,
              object: nil,
              userInfo: ["pane": "linear"]
            )
          }
          Button("Open project routing") {
            openProjectRouting()
          }
        } label: {
          Image(systemName: "ellipsis.circle")
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(.secondary)
        }
        .buttonStyle(PressableIconButtonStyle())
      }

      loadNoticeCallout
    }
  }

  private var hasSelection: Bool {
    selectedTicketId != nil
  }

  private var selectedTicket: TicketSummary? {
    guard let selectedTicketId else {
      return nil
    }
    return tickets.first(where: { $0.ticketId == selectedTicketId })
  }

  private var reviewQueueEntries: [TicketReviewQueueEntry] {
    tickets.compactMap { ticket in
      TicketReviewQueueEntry(
        ticket: ticket,
        detail: ticketDetailCache[ticket.ticketId],
        reviewNoteCount: reviewNotes(for: ticket).count
      )
    }
    .sorted { lhs, rhs in
      if lhs.openConflictCount != rhs.openConflictCount {
        return lhs.openConflictCount > rhs.openConflictCount
      }
      return lhs.updatedAt > rhs.updatedAt
    }
  }

  private var filteredReviewQueueEntries: [TicketReviewQueueEntry] {
    let visibleTicketIds = Set(filteredTickets.map(\.ticketId))
    return reviewQueueEntries.filter { visibleTicketIds.contains($0.ticketId) }
  }

  private var reviewQueueCount: Int {
    reviewQueueEntries.count
  }

  private var reviewQueueLabel: String {
    reviewQueueCount == 1 ? "1 review" : "\(reviewQueueCount) reviews"
  }

  private var nextReviewQueueEntry: TicketReviewQueueEntry? {
    let remaining = filteredReviewQueueEntries.filter {
      $0.ticketId != selectedTicketId
    }
    return remaining.first
  }

  private var canSyncProjectFromLinear: Bool {
    linearRouteStatus?.tokenResolved == true && hasAnyLinearProjectRouting
  }

  private var canSyncProjectToLinear: Bool {
    linearRouteStatus?.tokenResolved == true
  }

  private var isAnySyncInFlight: Bool {
    activeSyncAction != nil
  }

  private var bulkSyncConfirmationPresented: Binding<Bool> {
    Binding(
      get: { pendingBulkSyncAction != nil },
      set: { isPresented in
        if !isPresented {
          pendingBulkSyncAction = nil
        }
      }
    )
  }

  @ViewBuilder
  private var loadNoticeCallout: some View {
    if let loadNotice {
      InlineCallout(
        tone: loadNoticeTone,
        title: loadNoticeTitle,
        message: loadNotice,
        actions: loadNoticeActions
      )
    }
  }

  private var hasAnyLinearProjectRouting: Bool {
    if !linearRouteProjectId.isEmpty {
      return true
    }
    return !linearAdditionalProjects.isEmpty
  }

  private var hasAnyLinearAutosyncRoutes: Bool {
    !linearAutosyncRouteKeys.isEmpty
  }

  private var linearSyncStatusRow: some View {
    HStack(spacing: 8) {
      Image(systemName: linearRouteStatus?.tokenResolved == true ? "point.3.connected.trianglepath.dotted" : "exclamationmark.triangle.fill")
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(linearRouteStatus?.tokenResolved == true ? Color.secondary : Color.orange)

      Text(linearSyncStatusSummary)
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(.secondary)
        .lineLimit(1)

      if hasAnyLinearAutosyncRoutes {
        StatusPill(
          text: "\(linearAutosyncRouteKeys.count) autosync",
          tone: .good
        )
      }

      if reviewQueueCount > 0 {
        StatusPill(
          text: reviewQueueCount == 1 ? "1 review" : "\(reviewQueueCount) reviews",
          tone: .warn
        )
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 9)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .fill(colorScheme == .dark ? Color.white.opacity(0.06) : Color.white.opacity(0.86))
        .overlay(
          RoundedRectangle(cornerRadius: 14, style: .continuous)
            .stroke(
              linearRouteStatus?.tokenResolved == true && hasAnyLinearProjectRouting
                ? Color.black.opacity(colorScheme == .dark ? 0.0 : 0.06)
                : Color.orange.opacity(colorScheme == .dark ? 0.32 : 0.22),
              lineWidth: 1
            )
        )
    )
  }

  private var linearSyncStatusSummary: String {
    if linearRouteStatus?.tokenResolved != true {
      return "Connect Linear to route this repo's tickets."
    }
    if !hasAnyLinearProjectRouting {
      return "Choose a default Linear project for this repo."
    }
    if linearAdditionalProjects.isEmpty {
      let defaultLabel = linearRouteProjectName.isEmpty ? linearRouteProjectId : linearRouteProjectName
      return "\(linearProfileDisplayName) · \(defaultLabel)"
    }
    let defaultLabel = linearRouteProjectName.isEmpty ? linearRouteProjectId : linearRouteProjectName
    return "\(linearProfileDisplayName) · \(defaultLabel) + \(linearAdditionalProjects.count)"
  }

  private var linearProfileDisplayName: String {
    if !linearRouteProfile.isEmpty {
      return linearRouteProfile
    }
    return "Inherited profile"
  }

  private var allLinearRouteTargets: [LinearProjectBindingTarget] {
    var targets: [LinearProjectBindingTarget] = []
    if !linearRouteProjectId.isEmpty {
      targets.append(
        LinearProjectBindingTarget(
          profileId: linearRouteProfile.isEmpty ? nil : linearRouteProfile,
          projectId: linearRouteProjectId,
          projectName: linearRouteProjectName.isEmpty ? nil : linearRouteProjectName,
          teamId: linearRouteTeamId.isEmpty ? nil : linearRouteTeamId
        )
      )
    }
    targets.append(contentsOf: linearAdditionalProjects.map(normalizedLinearRouteTarget(_:)))
    return targets
  }

  private func normalizedLinearRouteTarget(_ target: LinearProjectBindingTarget) -> LinearProjectBindingTarget {
    if let profileId = target.profileId?.trimmingCharacters(in: .whitespacesAndNewlines),
       !profileId.isEmpty {
      return target
    }
    return LinearProjectBindingTarget(
      profileId: linearRouteProfile.isEmpty ? nil : linearRouteProfile,
      projectId: target.projectId,
      projectName: target.projectName,
      teamId: target.teamId
    )
  }

  private func linearRouteKey(for target: LinearProjectBindingTarget) -> String {
    let normalized = normalizedLinearRouteTarget(target)
    let profileId = normalized.profileId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "*"
    let teamId = normalized.teamId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "*"
    return [profileId, normalized.projectId, teamId].joined(separator: "::")
  }

  private var loadNoticeTone: StatusTone {
    guard let loadNotice else { return .neutral }
    let normalized = loadNotice.lowercased()
    if normalized.contains("failed")
      || normalized.contains("not linked")
      || normalized.contains("timed out")
    {
      return .warn
    }
    return .good
  }

  private var loadNoticeTitle: String {
    guard let loadNotice else { return "Ticket status" }
    let normalized = loadNotice.lowercased()
    if normalized.contains("timed out") {
      return "Using cached tickets"
    }
    if normalized.contains("failed") {
      return "Linear sync needs attention"
    }
    if normalized.contains("not linked") {
      return "Linear link required"
    }
    if normalized.hasPrefix("pulled") {
      return "Linear pull complete"
    }
    if normalized.hasPrefix("pushed") {
      return "Hack push complete"
    }
    if normalized.hasPrefix("synced") {
      return "Ticket pushed to Linear"
    }
    if normalized.hasPrefix("refreshed") {
      return "Ticket refreshed from Linear"
    }
    return "Ticket status"
  }

  private var loadNoticeActions: [InlineCalloutAction] {
    guard let loadNotice else { return [] }
    let normalized = loadNotice.lowercased()
    if normalized.contains("timed out") {
      return [
        InlineCalloutAction(label: "Refresh", systemImage: "arrow.clockwise") {
          Task { await refreshTickets() }
        }
      ]
    }
    if normalized.contains("failed") {
      if linearRouteStatus?.tokenResolved != true {
        return [
          InlineCalloutAction(label: "Linear settings", systemImage: "link.badge.plus") {
            openLinearSettings()
          }
        ]
      }
      if !hasAnyLinearProjectRouting {
        return [
          InlineCalloutAction(label: "Project routing", systemImage: "slider.horizontal.3") {
            openProjectRouting()
          }
        ]
      }
    }
    if normalized.contains("not linked") && linearRouteStatus?.tokenResolved == true {
      return [
        InlineCalloutAction(label: "Push selected ticket", systemImage: "arrow.up.right") {
          guard let selectedTicket else { return }
          Task { await syncSelectedTicketToLinear(selectedTicket) }
        }
      ]
    }
    return []
  }

  private var reviewQueueButton: some View {
    Button {
      activateReviewQueue()
    } label: {
      ticketHeaderBadge(
        title: reviewQueueLabel,
        systemImage: "bubble.left.and.exclamationmark.bubble.right",
        tone: selectedFilter == .reviewQueue ? .orange : .secondary
      )
    }
    .buttonStyle(.plain)
  }

  private var statusFilterMenu: some View {
    Menu {
      ForEach(TicketFilter.allCases, id: \.self) { filter in
        Button {
          selectedFilter = filter
        } label: {
          if selectedFilter == filter {
            Label("\(filter.label) (\(ticketCount(for: filter)))", systemImage: "checkmark")
          } else {
            Text("\(filter.label) (\(ticketCount(for: filter)))")
          }
        }
      }
    } label: {
      HStack(spacing: 8) {
        Image(systemName: "line.3.horizontal.decrease.circle")
          .font(.system(size: 13, weight: .semibold))
        Text(selectedFilter.label)
          .font(.system(size: 13, weight: .semibold))
        Text("\(ticketCount(for: selectedFilter))")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(.secondary)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background {
        headerControlCapsuleBackground
      }
    }
    .menuStyle(.borderlessButton)
  }

  private var originFilterMenu: some View {
    Menu {
      ForEach(TicketOriginFilter.allCases, id: \.self) { filter in
        Button {
          selectedOriginFilter = filter
        } label: {
          if selectedOriginFilter == filter {
            Label("\(filter.label) (\(filter.count(in: tickets)))", systemImage: "checkmark")
          } else {
            Text("\(filter.label) (\(filter.count(in: tickets)))")
          }
        }
      }
    } label: {
      HStack(spacing: 8) {
        Image(systemName: "tray.full")
          .font(.system(size: 13, weight: .semibold))
        Text(selectedOriginFilter.label)
          .font(.system(size: 13, weight: .semibold))
        Text("\(selectedOriginFilter.count(in: tickets))")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(.secondary)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background {
        headerControlCapsuleBackground
      }
    }
    .menuStyle(.borderlessButton)
  }

  private var searchField: some View {
    HStack(spacing: 8) {
      Image(systemName: "magnifyingglass")
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(.secondary)
      TextField("Search title or ID", text: $searchText)
        .textFieldStyle(.plain)
        .font(.system(size: 14, weight: .medium))
        .frame(minWidth: 180, maxWidth: 320)
      if !searchText.isEmpty {
        Button {
          searchText = ""
        } label: {
          Image(systemName: "xmark.circle.fill")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .background {
      headerControlFieldBackground
    }
  }

  private var content: some View {
    HStack(alignment: .top, spacing: 16) {
      ticketsListCard
        .frame(
          minWidth: 320,
          maxWidth: hasSelection ? 430 : .infinity,
          maxHeight: .infinity,
          alignment: .topLeading
        )
      if hasSelection {
        ticketDetailCard
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      }
    }
    .frame(maxHeight: .infinity, alignment: .top)
    .onMoveCommand(perform: moveSelection)
    .animation(.easeInOut(duration: 0.2), value: hasSelection)
  }

  private var ticketsListCard: some View {
    ticketPanel(contentPadding: 0) {
      VStack(alignment: .leading, spacing: 0) {
        if selectedFilter == .reviewQueue {
          reviewQueueListHeader
        } else {
          standardTicketsListHeader
        }
        Divider()
          .opacity(0.22)
        ScrollView {
          if isLoading && !hasLoadedOnce {
            skeletonList
          } else if selectedFilter == .reviewQueue && filteredReviewQueueEntries.isEmpty {
            reviewQueueEmptyView
          } else if filteredTickets.isEmpty {
            emptyTicketsView
          } else if selectedFilter == .all {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
              ForEach(TicketStatus.allCases, id: \.self) { status in
                ticketSection(status: status)
              }
            }
          } else if selectedFilter == .reviewQueue {
            LazyVStack(alignment: .leading, spacing: 0) {
              ForEach(filteredReviewQueueEntries) { entry in
                reviewQueueRow(entry)
              }
            }
          } else {
            LazyVStack(alignment: .leading, spacing: 0) {
              ForEach(filteredTickets) { ticket in
                ticketRow(ticket)
              }
            }
          }
        }
        .frame(maxHeight: .infinity, alignment: .topLeading)
      }
    }
    .focusable()
    .focused($ticketsListFocused)
    .focusEffectDisabled()
  }

  private var standardTicketsListHeader: some View {
    HStack(spacing: 8) {
      Text("\(filteredTickets.count) issue\(filteredTickets.count == 1 ? "" : "s")")
        .font(.system(size: 14, weight: .semibold))
      Spacer()
      if !filteredTickets.isEmpty {
        Text("Use ↑ ↓ to navigate")
          .font(.system(size: 12, weight: .medium))
          .foregroundStyle(.secondary)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
  }

  private var reviewQueueListHeader: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        Text(
          "\(filteredReviewQueueEntries.count) review item\(filteredReviewQueueEntries.count == 1 ? "" : "s")"
        )
        .font(.system(size: 14, weight: .semibold))
        Spacer()
        Text("Use ↑ ↓ to triage")
          .font(.system(size: 12, weight: .medium))
          .foregroundStyle(.secondary)
      }
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
          ticketMetaPill(
            "\(filteredReviewQueueEntries.reduce(0) { $0 + $1.openConflictCount }) open conflict\(filteredReviewQueueEntries.reduce(0) { $0 + $1.openConflictCount } == 1 ? "" : "s")",
            tone: filteredReviewQueueEntries.reduce(0) { $0 + $1.openConflictCount } > 0 ? .orange : .secondary
          )
          ticketMetaPill(
            "\(filteredReviewQueueEntries.reduce(0) { $0 + $1.commentCount }) comment\(filteredReviewQueueEntries.reduce(0) { $0 + $1.commentCount } == 1 ? "" : "s")",
            tone: .secondary
          )
          ticketMetaPill(
            "\(filteredReviewQueueEntries.reduce(0) { $0 + $1.reviewNoteCount }) review note\(filteredReviewQueueEntries.reduce(0) { $0 + $1.reviewNoteCount } == 1 ? "" : "s")",
            tone: .secondary
          )
        }
      }
      HStack(spacing: 8) {
        if let nextReviewQueueEntry {
          Button {
            selectedTicketId = nextReviewQueueEntry.ticketId
            ticketsListFocused = true
          } label: {
            Label("Next item", systemImage: "arrow.right.circle")
          }
          .adaptiveToolbarButton()
        }
        Button("All tickets") {
          selectedFilter = .all
          ticketsListFocused = true
        }
        .adaptiveToolbarButton()
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
  }

  private var ticketDetailCard: some View {
    ticketDetailPanel {
      if let detailErrorMessage {
        ScrollView {
          ticketsErrorCard(message: detailErrorMessage)
            .padding(16)
        }
      } else if isDetailLoading {
        ProgressView()
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
          .padding(16)
      } else if let detail = ticketDetail {
        VStack(spacing: 0) {
          ScrollView {
            ticketDetailView(detail)
              .padding(.horizontal, 16)
              .padding(.top, 16)
              .padding(.bottom, 20)
          }
          .layoutPriority(1)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

          Divider()
            .opacity(0.22)

          ticketDetailFooter(detail)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(ticketDetailFooterFillColor)
        }
      } else {
        Text("Select a ticket to see details.")
          .font(.mono(.subheadline))
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
          .padding(16)
      }
    }
  }

  private var emptyTicketsView: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("No tickets found.")
        .font(.system(size: 15, weight: .semibold))
      Text("Adjust filters, pull from Linear, or create a new ticket.")
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(.secondary)
      HStack(spacing: 8) {
        Button("New ticket") {
          showCreateSheet = true
        }
        .adaptiveToolbarButton()

        Button("Pull Linear") {
          requestBulkSyncConfirmation(.pullLinear)
        }
        .adaptiveToolbarButtonProminent()
        .disabled(!canSyncProjectFromLinear || isAnySyncInFlight)

        Button("Routing") {
          openProjectRouting()
        }
        .adaptiveToolbarButton()

        if linearRouteStatus?.tokenResolved != true {
          Button("Linear settings") {
            openLinearSettings()
          }
          .adaptiveToolbarButton()
        }
      }
    }
    .padding(.horizontal, 14)
    .padding(.top, 8)
  }

  private var reviewQueueEmptyView: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(reviewQueueCount == 0 ? "No tickets need sync review." : "No review items match the current filters.")
        .font(.system(size: 15, weight: .semibold))
      Text(
        reviewQueueCount == 0
          ? "When conflicts, mergeable-field ambiguity, or follow-up notes land, they will appear here for triage."
          : "Clear the search text, widen the origin filter, or switch back to the full ticket board."
      )
      .font(.system(size: 13, weight: .medium))
      .foregroundStyle(.secondary)
      HStack(spacing: 8) {
        Button("All tickets") {
          selectedFilter = .all
        }
        .adaptiveToolbarButton()
        Button("Refresh") {
          Task { await refreshTickets() }
        }
        .adaptiveToolbarButton()
      }
    }
    .padding(.horizontal, 14)
    .padding(.top, 8)
  }

  private func ticketRow(_ ticket: TicketSummary) -> some View {
    Button {
      if selectedTicketId == ticket.ticketId {
        selectedTicketId = nil
        ticketDetail = nil
        detailErrorMessage = nil
      } else {
        selectedTicketId = ticket.ticketId
      }
      ticketsListFocused = true
    } label: {
      HStack(alignment: .top, spacing: 10) {
        Circle()
          .fill(ticket.status.color)
          .frame(width: 8, height: 8)
          .padding(.top, 8)
        VStack(alignment: .leading, spacing: 6) {
          HStack(spacing: 8) {
            Text(ticket.ticketId)
              .font(.system(size: 12, weight: .medium, design: .monospaced))
              .foregroundStyle(.secondary)
            ticketStatusBadge(ticket.status)
            Spacer()
            Text(humanReadableListDate(ticket.updatedAt))
              .font(.system(size: 12, weight: .medium))
              .foregroundStyle(.secondary)
          }
          Text(ticket.title)
            .font(.system(size: 15, weight: .semibold))
            .lineLimit(2)
            .multilineTextAlignment(.leading)
          ticketRowMetadata(ticket)
        }
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(selectionBackground(for: ticket.ticketId))
      .overlay(alignment: .bottom) {
        Rectangle()
          .fill(selectionBorder(for: ticket.ticketId))
          .frame(height: 1)
      }
    }
    .buttonStyle(.plain)
    .contentShape(Rectangle())
    .onHover { hovering in
      hoveredTicketId = hovering ? ticket.ticketId : nil
    }
    .animation(.easeInOut(duration: 0.12), value: hoveredTicketId)
  }

  private func reviewQueueRow(_ entry: TicketReviewQueueEntry) -> some View {
    let ticket = tickets.first(where: { $0.ticketId == entry.ticketId })
    return Button {
      if selectedTicketId == entry.ticketId {
        selectedTicketId = nil
        ticketDetail = nil
        detailErrorMessage = nil
      } else {
        selectedTicketId = entry.ticketId
      }
      ticketsListFocused = true
    } label: {
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .top, spacing: 8) {
          Image(systemName: entry.openConflictCount > 0 ? "exclamationmark.triangle.fill" : "arrow.triangle.branch")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(entry.openConflictCount > 0 ? .orange : .secondary)
            .padding(.top, 2)
          VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
              Text(entry.ticketId)
                .font(.system(size: 12, weight: .medium, design: .monospaced))
                .foregroundStyle(.secondary)
              ticketMetaPill(
                entry.badgeLabel,
                tone: entry.openConflictCount > 0 ? .orange : .secondary
              )
              if let ticket {
                ticketMetaPill(
                  ticketAuthorityBadgeLabel(for: ticket),
                  tone: ticketAuthorityBadgeColor(for: ticket)
                )
                ticketMetaPill(
                  ticket.owner,
                  tone: ticket.owner == "linear" ? .orange : .secondary
                )
              }
              Spacer(minLength: 8)
              Text(humanReadableListDate(entry.updatedAt))
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
            }
            Text(entry.title)
              .font(.system(size: 15, weight: .semibold))
              .multilineTextAlignment(.leading)
              .lineLimit(2)
            Text(entry.summary)
              .font(.system(size: 13, weight: .medium))
              .foregroundStyle(.secondary)
              .multilineTextAlignment(.leading)
              .lineLimit(3)
            ScrollView(.horizontal, showsIndicators: false) {
              HStack(spacing: 6) {
                ticketMetaPill(
                  "\(entry.openConflictCount) open",
                  tone: entry.openConflictCount > 0 ? .orange : .secondary
                )
                ticketMetaPill(
                  "\(entry.commentCount) comment\(entry.commentCount == 1 ? "" : "s")",
                  tone: .secondary
                )
                if entry.reviewNoteCount > 0 {
                  ticketMetaPill(
                    "\(entry.reviewNoteCount) review note\(entry.reviewNoteCount == 1 ? "" : "s")",
                    tone: .secondary
                  )
                }
                if let checkpointSummary = ticketDetailCache[entry.ticketId]?.linearSyncReviewState.checkpointSummary {
                  ticketMetaPill(checkpointSummary, tone: .secondary)
                }
              }
            }
          }
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(selectionBackground(for: entry.ticketId))
      .overlay(alignment: .bottom) {
        Rectangle()
          .fill(selectionBorder(for: entry.ticketId))
          .frame(height: 1)
      }
    }
    .buttonStyle(.plain)
    .contentShape(Rectangle())
    .onHover { hovering in
      hoveredTicketId = hovering ? entry.ticketId : nil
    }
    .animation(.easeInOut(duration: 0.12), value: hoveredTicketId)
  }

  private func ticketRowMetadata(_ ticket: TicketSummary) -> some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 6) {
        ticketMetaPill(ticket.owner, tone: ticket.owner == "linear" ? .orange : .secondary)
        ticketMetaPill(ticket.source, tone: ticket.source == "linear" ? .orange : .secondary)
        if let assignee = ticket.assignee?.trimmingCharacters(in: .whitespacesAndNewlines), !assignee.isEmpty {
          ticketMetaPill("Assignee \(assignee)", tone: .secondary)
        }
        ticketMetaPill(ticketAuthorityBadgeLabel(for: ticket), tone: ticketAuthorityBadgeColor(for: ticket))
        if ticket.linearSyncUXState.reviewHint != nil {
          ticketMetaPill("Review sync", tone: .orange)
        }
        if let externalKey = ticket.externalKey, !externalKey.isEmpty {
          ticketMetaPill(externalKey, tone: .accentColor)
        }
      }
      .padding(.top, 2)
    }
  }

  private func ticketDetailView(_ detail: TicketDetailResponse) -> some View {
    VStack(alignment: .leading, spacing: 20) {
      HStack(alignment: .top, spacing: 12) {
        VStack(alignment: .leading, spacing: 6) {
          Text(detail.ticket.title)
            .font(.system(size: 29, weight: .bold, design: .rounded))
          HStack(spacing: 10) {
            Text(detail.ticket.ticketId)
              .font(.system(size: 13, weight: .medium, design: .monospaced))
              .foregroundStyle(.secondary)
            Text("Updated \(humanReadableDetailDate(detail.ticket.updatedAt))")
              .font(.system(size: 13, weight: .medium))
              .foregroundStyle(.secondary)
          }
          ticketDetailMetadata(detail.ticket)
        }
        Spacer()
        statusMenu(ticket: detail.ticket)
      }

      if let body = detail.ticket.body, !body.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          Text("Body")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(.secondary)
          markdownBody(body)
        }
      }

      ticketSyncGuidanceCallout(detail)
      ticketSyncSnapshotStrip(detail)
      ticketCommentsSection(detail)
      ticketReviewNotesSection(detail)
      ticketSyncCheckpointSection(detail)
      ticketConflictSection(detail)
    }
  }

  private func ticketDetailMetadata(_ ticket: TicketSummary) -> some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ticketMetaPill(ticket.owner, tone: ticket.owner == "linear" ? .orange : .secondary)
        ticketMetaPill(ticket.source, tone: ticket.source == "linear" ? .orange : .secondary)
        if let assignee = ticket.assignee?.trimmingCharacters(in: .whitespacesAndNewlines), !assignee.isEmpty {
          ticketMetaPill("Assignee \(assignee)", tone: .secondary)
        }
        ticketMetaPill(ticketAuthorityBadgeLabel(for: ticket), tone: ticketAuthorityBadgeColor(for: ticket))
        if ticket.linearSyncUXState.reviewHint != nil {
          ticketMetaPill("Review sync", tone: .orange)
        }
        if let externalSystem = ticket.externalSystem, !externalSystem.isEmpty {
          ticketMetaPill(externalSystem, tone: .accentColor)
        }
        if let externalKey = ticket.externalKey, !externalKey.isEmpty {
          ticketMetaPill(externalKey, tone: .accentColor)
        }
        if let projectName = ticket.externalProjectName, !projectName.isEmpty {
          ticketMetaPill(projectName, tone: .secondary)
        }
        if !ticket.tags.isEmpty {
          ForEach(ticket.tags, id: \.self) { tag in
            ticketMetaPill(tag, tone: .secondary)
          }
        }
      }
    }
  }

  private func ticketSyncGuidanceCallout(_ detail: TicketDetailResponse) -> some View {
    let guidance = ticketSyncGuidance(for: detail)
    return InlineCallout(
      tone: guidance.tone,
      title: guidance.title,
      message: guidance.message,
      actions: ticketSyncGuidanceActions(for: detail)
    )
  }

  @ViewBuilder
  private func ticketSyncSnapshotStrip(_ detail: TicketDetailResponse) -> some View {
    let review = detail.linearSyncReviewState
    if detail.comments.isEmpty && detail.syncCheckpoints.isEmpty && detail.conflicts.isEmpty {
      EmptyView()
    } else {
      VStack(alignment: .leading, spacing: 8) {
        Text("Sync snapshot")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(.secondary)
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            ticketMetaPill(review.badgeLabel, tone: reviewToneColor(review.severity))
            ticketMetaPill("\(review.commentCount) comment\(review.commentCount == 1 ? "" : "s")", tone: .secondary)
            ticketMetaPill("\(review.openConflictCount) open", tone: review.openConflictCount > 0 ? .orange : .secondary)
            ticketMetaPill("\(review.resolvedConflictCount) resolved", tone: review.resolvedConflictCount > 0 ? .green : .secondary)
            if reviewNotes(for: detail.ticket).count > 0 {
              let noteCount = reviewNotes(for: detail.ticket).count
              ticketMetaPill("\(noteCount) review note\(noteCount == 1 ? "" : "s")", tone: .secondary)
            }
            if let checkpointSummary = review.checkpointSummary {
              ticketMetaPill(checkpointSummary, tone: .secondary)
            }
          }
        }
      }
    }
  }

  @ViewBuilder
  private func ticketCommentsSection(_ detail: TicketDetailResponse) -> some View {
    if !detail.comments.isEmpty {
      VStack(alignment: .leading, spacing: 10) {
        HStack(spacing: 8) {
          Text("Comments")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(.secondary)
          ticketMetaPill("Append-only FIFO", tone: .secondary)
        }
        VStack(alignment: .leading, spacing: 10) {
          ForEach(detail.comments) { comment in
            VStack(alignment: .leading, spacing: 8) {
              HStack(spacing: 8) {
                ticketMetaPill(comment.source, tone: comment.source == "linear" ? .orange : .secondary)
                ticketMetaPill(comment.actor, tone: .secondary)
                Text(humanReadableDetailDate(comment.createdAt))
                  .font(.system(size: 12, weight: .medium))
                  .foregroundStyle(.secondary)
                Spacer()
                if let externalUrl = comment.externalUrl,
                   let url = URL(string: externalUrl) {
                  Button {
                    openURL(url)
                  } label: {
                    Label("Open", systemImage: "link")
                  }
                  .adaptiveToolbarButton()
                }
                Button {
                  appendQuotedCommentToReviewDraft(comment, ticket: detail.ticket)
                } label: {
                  Label("Quote", systemImage: "text.quote")
                }
                .adaptiveToolbarButton()
              }
              markdownBody(comment.body)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
              RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(colorScheme == .dark ? Color.white.opacity(0.03) : Color.black.opacity(0.025))
            )
            .overlay(
              RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.primary.opacity(0.08), lineWidth: 1)
            )
          }
        }
      }
    }
  }

  @ViewBuilder
  private func ticketReviewNotesSection(_ detail: TicketDetailResponse) -> some View {
    let savedNotes = reviewNotes(for: detail.ticket)
    let isRelevant = detail.ticket.linearSyncUXState.isLinkedToLinear || detail.linearSyncReviewState.needsReview || !savedNotes.isEmpty
    if isRelevant {
      VStack(alignment: .leading, spacing: 10) {
        HStack(spacing: 8) {
          Text("Review notes")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(.secondary)
          ticketMetaPill("Shared in ticket history", tone: .secondary)
          if !savedNotes.isEmpty {
            ticketMetaPill("\(savedNotes.count) saved", tone: .secondary)
          }
        }

        InlineCallout(
          tone: detail.linearSyncReviewState.needsReview ? .warn : .neutral,
          title: "Compose a review comment",
          message: "Draft follow-up from conflicts and comment history here. Save it as a repo-shared review note or append it to the ticket as an immutable Hack comment that sync can push to Linear later.",
          actions: [
            InlineCalloutAction(label: "Use review summary", systemImage: "sparkles") {
              applyReviewDraftTemplate(for: detail)
            },
            InlineCalloutAction(label: "Copy draft", systemImage: "doc.on.doc") {
              copyReviewDraft(for: detail.ticket)
            },
          ]
        )

        if !savedNotes.isEmpty {
          VStack(alignment: .leading, spacing: 8) {
            ForEach(savedNotes.sorted(by: { $0.createdAt > $1.createdAt })) { note in
              VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                  ticketMetaPill("Review note", tone: .secondary)
                  ticketMetaPill(note.actor, tone: .secondary)
                  if let context = note.context, !context.isEmpty {
                    ticketMetaPill(context, tone: .secondary)
                  }
                  Text(humanReadableDetailDate(note.createdAt))
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
                  Spacer()
                  Button {
                    copyToPasteboard(note.markdown)
                    loadNotice = "Copied saved review note."
                  } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                  }
                  .adaptiveToolbarButton()
                }
                markdownBody(note.markdown)
              }
              .padding(12)
              .frame(maxWidth: .infinity, alignment: .leading)
              .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                  .fill(colorScheme == .dark ? Color.white.opacity(0.03) : Color.black.opacity(0.025))
              )
              .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                  .stroke(Color.primary.opacity(0.08), lineWidth: 1)
              )
            }
          }
        }

        VStack(alignment: .leading, spacing: 8) {
          Text("Draft")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(.secondary)
          ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .fill(colorScheme == .dark ? Color.white.opacity(0.03) : Color.black.opacity(0.025))
            TextEditor(text: reviewDraftBinding(for: detail.ticket))
              .font(.system(size: 13, weight: .medium, design: .monospaced))
              .scrollContentBackground(.hidden)
              .padding(.horizontal, 8)
              .padding(.vertical, 6)
              .frame(minHeight: 128)
            if reviewDraft(for: detail.ticket).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
              Text("Draft a shared review note, quote an imported comment, or stage a conflict summary.")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 14)
                .padding(.vertical, 14)
                .allowsHitTesting(false)
            }
          }
          .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .stroke(Color.primary.opacity(0.08), lineWidth: 1)
          )

          HStack(spacing: 8) {
            Button {
              applyReviewDraftTemplate(for: detail)
            } label: {
              Label("Insert summary", systemImage: "text.append")
            }
            .adaptiveToolbarButton()

            if let latestComment = detail.comments.last {
              Button {
                appendQuotedCommentToReviewDraft(latestComment, ticket: detail.ticket)
              } label: {
                Label("Quote latest", systemImage: "text.quote")
              }
              .adaptiveToolbarButton()
            }

            Button {
              Task { await postReviewDraftAsReviewNote(for: detail.ticket) }
            } label: {
              Label("Save review note", systemImage: "tray.and.arrow.down")
            }
            .adaptiveToolbarButtonProminent()
            .disabled(
              reviewDraft(for: detail.ticket).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                postingReviewNoteTicketIds.contains(detail.ticket.ticketId)
            )

            Button {
              Task { await postReviewDraftAsTicketComment(for: detail.ticket) }
            } label: {
              Label("Post ticket comment", systemImage: "plus.bubble")
            }
            .adaptiveToolbarButton()
            .disabled(
              reviewDraft(for: detail.ticket).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                postingCommentTicketIds.contains(detail.ticket.ticketId)
            )

            Button("Clear") {
              clearReviewDraft(for: detail.ticket)
            }
            .adaptiveToolbarButton()
            .disabled(reviewDraft(for: detail.ticket).isEmpty)

            if postingReviewNoteTicketIds.contains(detail.ticket.ticketId) ||
              postingCommentTicketIds.contains(detail.ticket.ticketId)
            {
              ProgressView()
                .controlSize(.small)
            }
          }
        }
      }
    }
  }

  @ViewBuilder
  private func ticketSyncCheckpointSection(_ detail: TicketDetailResponse) -> some View {
    if !detail.syncCheckpoints.isEmpty {
      VStack(alignment: .leading, spacing: 10) {
        Text("Sync checkpoints")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(.secondary)
        VStack(alignment: .leading, spacing: 8) {
          ForEach(detail.syncCheckpoints.sorted(by: { $0.createdAt > $1.createdAt })) { checkpoint in
            VStack(alignment: .leading, spacing: 6) {
              HStack(spacing: 8) {
                ticketMetaPill(checkpoint.provider.capitalized, tone: .accentColor)
                if let direction = checkpoint.direction, !direction.isEmpty {
                  ticketMetaPill(direction, tone: .secondary)
                }
                if let profileId = checkpoint.profileId, !profileId.isEmpty {
                  ticketMetaPill("Profile \(profileId)", tone: .secondary)
                }
                Spacer()
                Text(humanReadableDetailDate(checkpoint.createdAt))
                  .font(.system(size: 12, weight: .medium))
                  .foregroundStyle(.secondary)
              }
              if let remoteCursor = checkpoint.remoteCursor, !remoteCursor.isEmpty {
                Text(remoteCursor)
                  .font(.system(size: 12, weight: .medium, design: .monospaced))
                  .foregroundStyle(.secondary)
              }
              if let remoteUpdatedAt = checkpoint.remoteUpdatedAt, !remoteUpdatedAt.isEmpty {
                Text("Remote updated \(humanReadableDetailDate(remoteUpdatedAt))")
                  .font(.system(size: 12, weight: .medium))
                  .foregroundStyle(.secondary)
              }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
              RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(colorScheme == .dark ? Color.white.opacity(0.03) : Color.black.opacity(0.025))
            )
            .overlay(
              RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color.primary.opacity(0.08), lineWidth: 1)
            )
          }
        }
      }
    }
  }

  @ViewBuilder
  private func ticketConflictSection(_ detail: TicketDetailResponse) -> some View {
    if !detail.conflicts.isEmpty {
      VStack(alignment: .leading, spacing: 10) {
        HStack(spacing: 8) {
          Text("Conflicts")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(.secondary)
          if detail.openSyncConflicts.count > 0 {
            ticketMetaPill("\(detail.openSyncConflicts.count) open", tone: .orange)
          }
          if detail.resolvedSyncConflicts.count > 0 {
            ticketMetaPill("\(detail.resolvedSyncConflicts.count) resolved", tone: .green)
          }
        }
        VStack(alignment: .leading, spacing: 8) {
          ForEach(detail.conflicts.sorted(by: { $0.updatedAt > $1.updatedAt })) { conflict in
            VStack(alignment: .leading, spacing: 8) {
              HStack(spacing: 8) {
                ticketMetaPill(conflict.field, tone: conflict.status == .open ? .orange : .green)
                ticketMetaPill(conflict.status == .open ? "Open" : "Resolved", tone: conflict.status == .open ? .orange : .green)
                if let authority = conflict.authority, !authority.isEmpty {
                  ticketMetaPill(authority, tone: .secondary)
                }
                Spacer()
                Text(humanReadableDetailDate(conflict.updatedAt))
                  .font(.system(size: 12, weight: .medium))
                  .foregroundStyle(.secondary)
              }
              if let summary = conflict.summary, !summary.isEmpty {
                Text(summary)
                  .font(.system(size: 13, weight: .medium))
              }
              VStack(alignment: .leading, spacing: 6) {
                ticketConflictValueRow(label: "Local", value: conflict.localValue?.displayText)
                ticketConflictValueRow(label: "Remote", value: conflict.remoteValue?.displayText)
                if let resolution = conflict.resolution?.rawValue {
                  ticketConflictValueRow(label: "Resolution", value: resolution.replacingOccurrences(of: "_", with: " "))
                }
                if let resolutionSummary = conflict.resolutionSummary, !resolutionSummary.isEmpty {
                  ticketConflictValueRow(label: "Notes", value: resolutionSummary)
                }
              }
              if conflict.status == .open {
                ticketConflictActions(conflict)
              }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
              RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(conflict.status == .open ? Color.orange.opacity(colorScheme == .dark ? 0.08 : 0.06) : Color.green.opacity(colorScheme == .dark ? 0.08 : 0.06))
            )
            .overlay(
              RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(conflict.status == .open ? Color.orange.opacity(0.18) : Color.green.opacity(0.18), lineWidth: 1)
            )
          }
        }
      }
    }
  }

  @ViewBuilder
  private func ticketConflictActions(_ conflict: TicketSyncConflict) -> some View {
    let isResolving = resolvingConflictIds.contains(conflict.conflictId)
    HStack(spacing: 8) {
      Button {
        stageConflictReviewDraft(conflict)
      } label: {
        Label("Draft note", systemImage: "square.and.pencil")
      }
      .adaptiveToolbarButton()
      .disabled(isResolving)

      Button {
        Task {
          await resolveTicketConflict(
            conflict,
            resolution: .acceptLocal
          )
        }
      } label: {
        Label("Keep Hack", systemImage: "arrow.uturn.backward.circle")
      }
      .adaptiveToolbarButtonProminent()
      .disabled(isResolving)

      Button {
        Task {
          await resolveTicketConflict(
            conflict,
            resolution: .acceptRemote
          )
        }
      } label: {
        Label("Keep Linear", systemImage: "arrow.uturn.forward.circle")
      }
      .adaptiveToolbarButton()
      .disabled(isResolving)

      Menu {
        Button("Mark merged") {
          Task {
            await resolveTicketConflict(
              conflict,
              resolution: .merged,
              summary: "Marked merged from the macOS review UI."
            )
          }
        }
        Button("Ignore for now") {
          Task {
            await resolveTicketConflict(
              conflict,
              resolution: .ignore,
              summary: "Ignored from the macOS review UI."
            )
          }
        }
      } label: {
        Label("More", systemImage: "ellipsis.circle")
      }
      .adaptiveToolbarButton()
      .disabled(isResolving)

      if isResolving {
        ProgressView()
          .controlSize(.small)
      }
    }
  }

  private func ticketSyncGuidanceActions(for ticket: TicketSummary) -> [InlineCalloutAction] {
    let syncState = ticket.linearSyncUXState
    if syncState.reviewHint != nil {
      return [
        InlineCalloutAction(label: "Project routing", systemImage: "slider.horizontal.3") {
          openProjectRouting()
        }
      ]
    }

    if !syncState.isLinkedToLinear {
      if linearRouteStatus?.tokenResolved == true {
        return [
          InlineCalloutAction(label: "Push Hack changes", systemImage: "arrow.up.right") {
            Task { await syncSelectedTicketToLinear(ticket) }
          }
        ]
      }
      return [
        InlineCalloutAction(label: "Linear settings", systemImage: "link.badge.plus") {
          openLinearSettings()
        },
        InlineCalloutAction(label: "Project routing", systemImage: "slider.horizontal.3") {
          openProjectRouting()
        },
      ]
    }

    switch syncState.authority {
    case .linear:
      if let externalKey = ticket.externalKey, !externalKey.isEmpty {
        return [
          InlineCalloutAction(label: "Pull Linear changes", systemImage: "arrow.down.left") {
            Task { await syncSelectedTicketFromLinear(ticket) }
          }
        ]
      }
      return []
    case .hack:
      if linearRouteStatus?.tokenResolved == true {
        return [
          InlineCalloutAction(label: "Push Hack changes", systemImage: "arrow.up.right") {
            Task { await syncSelectedTicketToLinear(ticket) }
          }
        ]
      }
      return [
        InlineCalloutAction(label: "Linear settings", systemImage: "link.badge.plus") {
          openLinearSettings()
        },
      ]
    }
  }

  private func ticketSyncGuidanceActions(for detail: TicketDetailResponse) -> [InlineCalloutAction] {
    if detail.linearSyncReviewState.needsReview {
      var actions = [
        InlineCalloutAction(label: "Project routing", systemImage: "slider.horizontal.3") {
          openProjectRouting()
        }
      ]
      if let externalURL = detail.ticket.externalUrl,
         let url = URL(string: externalURL) {
        actions.append(
          InlineCalloutAction(label: "Open linked issue", systemImage: "link") {
            openURL(url)
          }
        )
      }
      return actions
    }
    return ticketSyncGuidanceActions(for: detail.ticket)
  }

  private func ticketAuthorityBadgeLabel(for ticket: TicketSummary) -> String {
    if ticket.linearSyncUXState.reviewHint != nil {
      return "Review authority"
    }
    switch ticket.linearSyncUXState.authority {
    case .hack:
      return "Hack authority"
    case .linear:
      return "Linear authority"
    }
  }

  private func ticketAuthorityBadgeColor(for ticket: TicketSummary) -> Color {
    if ticket.linearSyncUXState.reviewHint != nil {
      return .orange
    }
    switch ticket.linearSyncUXState.authority {
    case .hack:
      return .secondary
    case .linear:
      return .orange
    }
  }

  private func ticketSyncGuidance(for ticket: TicketSummary) -> TicketSyncGuidance {
    let syncState = ticket.linearSyncUXState
    if let reviewHint = syncState.reviewHint {
      return TicketSyncGuidance(
        title: "Review authority before syncing",
        message: "\(syncState.shortGuidance) \(reviewHint)",
        tone: .warn
      )
    }

    if !syncState.isLinkedToLinear {
      return TicketSyncGuidance(
        title: "Local ticket",
        message: syncState.shortGuidance,
        tone: .neutral
      )
    }

    switch syncState.authority {
    case .hack:
      return TicketSyncGuidance(
        title: "Hack owns authoritative edits",
        message: "\(syncState.shortGuidance) Push when you want to publish local changes outward.",
        tone: .neutral
      )
    case .linear:
      return TicketSyncGuidance(
        title: "Linear owns authoritative edits",
        message: "\(syncState.shortGuidance) Pull when you want the local ticket to match the linked Linear issue.",
        tone: .neutral
      )
    }
  }

  private func ticketSyncGuidance(for detail: TicketDetailResponse) -> TicketSyncGuidance {
    let review = detail.linearSyncReviewState
    return TicketSyncGuidance(
      title: review.title,
      message: review.message,
      tone: review.severity == .conflict || review.severity == .review ? .warn : .neutral
    )
  }

  private func ticketDetailFooter(_ detail: TicketDetailResponse) -> some View {
    let prefersPullPrimary =
      detail.ticket.linearSyncUXState.authority == .linear &&
      detail.linearSyncReviewState.needsReview == false &&
      detail.ticket.externalKey?.isEmpty == false

    return VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        if let nextReviewQueueEntry {
          Button {
            selectedFilter = .reviewQueue
            selectedTicketId = nextReviewQueueEntry.ticketId
          } label: {
            Label("Next review", systemImage: "arrow.right.circle")
          }
          .adaptiveToolbarButton()
        }

        if prefersPullPrimary {
          Button {
            Task { await syncSelectedTicketToLinear(detail.ticket) }
          } label: {
            Label("Push Hack changes", systemImage: "arrow.up.right")
          }
          .adaptiveToolbarButton()
          .disabled(linearRouteStatus?.tokenResolved != true || isAnySyncInFlight)

          Button {
            Task { await syncSelectedTicketFromLinear(detail.ticket) }
          } label: {
            Label("Pull Linear changes", systemImage: "arrow.down.left")
          }
          .adaptiveToolbarButtonProminent()
          .disabled(detail.ticket.externalKey?.isEmpty != false || isAnySyncInFlight)
        } else {
          Button {
            Task { await syncSelectedTicketToLinear(detail.ticket) }
          } label: {
            Label("Push Hack changes", systemImage: "arrow.up.right")
          }
          .adaptiveToolbarButtonProminent()
          .disabled(linearRouteStatus?.tokenResolved != true || isAnySyncInFlight)

          Button {
            Task { await syncSelectedTicketFromLinear(detail.ticket) }
          } label: {
            Label("Pull Linear changes", systemImage: "arrow.down.left")
          }
          .adaptiveToolbarButton()
          .disabled(detail.ticket.externalKey?.isEmpty != false || isAnySyncInFlight)
        }

        if let externalURL = detail.ticket.externalUrl,
           let url = URL(string: externalURL) {
          Button {
            openURL(url)
          } label: {
            Label("Open issue", systemImage: "link")
          }
          .adaptiveToolbarButton()
        }

        Spacer()
      }

      bottomPinnedDisclosure(title: "History", isExpanded: $isHistoryExpanded) {
        if detail.events.isEmpty {
          Text("No history events for this ticket.")
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(.secondary)
        } else {
          VStack(alignment: .leading, spacing: 8) {
            ForEach(detail.events) { event in
              HStack(spacing: 8) {
                Text(event.type.replacingOccurrences(of: ".", with: " "))
                  .textCase(nil)
                  .multilineTextAlignment(.leading)
                  .lineLimit(1)
                  .truncationMode(.tail)
                  .font(.system(size: 13, weight: .medium))
                  .foregroundStyle(.primary)
                Spacer()
                Text(humanReadableDetailDate(event.tsIso))
                  .font(.system(size: 12, weight: .medium))
                  .foregroundStyle(.secondary)
              }
            }
          }
        }
      }

      Divider()
        .opacity(0.25)

      bottomPinnedDisclosure(title: "Properties", isExpanded: $isPropertiesExpanded) {
        VStack(alignment: .leading, spacing: 14) {
          inspectorGroup(title: "Dates", rows: inspectorDateRows(for: detail.ticket))
          inspectorGroup(title: "Links", rows: inspectorLinkRows(for: detail.ticket))
          inspectorGroup(title: "Dependencies", rows: inspectorDependencyRows(for: detail.ticket))
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  @ViewBuilder
  private func bottomPinnedDisclosure<Content: View>(
    title: String,
    isExpanded: Binding<Bool>,
    @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      if isExpanded.wrappedValue {
        content()
          .transition(.opacity.combined(with: .move(edge: .bottom)))
      }
      Button {
        withAnimation(.easeInOut(duration: 0.16)) {
          isExpanded.wrappedValue.toggle()
        }
      } label: {
        HStack(spacing: 6) {
          Image(systemName: isExpanded.wrappedValue ? "chevron.down" : "chevron.right")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(.secondary)
          Text(title)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(.secondary)
          Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
    }
  }

  private func markdownBody(_ markdown: String) -> some View {
    Markdown(markdown)
      .markdownTheme(.gitHub)
      .markdownTextStyle {
        FontFamilyVariant(.monospaced)
        FontSize(.em(0.95))
      }
      .markdownCodeSyntaxHighlighter(TicketMarkdownCodeSyntaxHighlighter(colorScheme: colorScheme))
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.vertical, 2)
      .textSelection(.enabled)
  }

  private func statusMenu(ticket: TicketSummary) -> some View {
    Menu {
      ForEach(TicketStatus.allCases, id: \.self) { status in
        Button(status.label) {
          Task {
            await updateStatus(ticketId: ticket.ticketId, status: status)
          }
        }
      }
    } label: {
      HStack(spacing: 6) {
        Circle()
          .fill(ticket.status.color)
          .frame(width: 8, height: 8)
        Text(ticket.status.label)
          .font(.system(size: 12, weight: .semibold))
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .background(
        Capsule(style: .continuous)
          .fill(ticketBadgeFill(for: ticket.status))
      )
      .overlay(
        Capsule(style: .continuous)
          .stroke(ticketBadgeStroke(for: ticket.status), lineWidth: 1)
      )
    }
    .menuStyle(.borderlessButton)
    .help("Change status")
  }

  private func ticketsErrorCard(message: String) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Image(systemName: "exclamationmark.triangle.fill")
          .foregroundStyle(.orange)
        Text("Tickets unavailable")
          .font(.mono(.subheadline, weight: .medium))
      }
      Text(message)
        .font(.mono(.caption))
        .foregroundStyle(.secondary)
      if message.localizedCaseInsensitiveContains("invalid json") {
        Text("Run `hack tickets setup` in this repo, then refresh.")
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
      }
      if message.localizedCaseInsensitiveContains("extension") {
        Text("Enable tickets in this project, then refresh.")
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
      }
      HStack(spacing: 10) {
        Button("Retry") {
          Task { await refreshTickets() }
        }
        .adaptiveToolbarButton()

        if message.localizedCaseInsensitiveContains("invalid json")
          || message.localizedCaseInsensitiveContains("extension")
        {
          Button("Run setup") {
            Task {
              _ = await model.setupTickets(for: project)
              await refreshTickets()
            }
          }
          .adaptiveToolbarButton()
        }
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(.thinMaterial)
    )
  }

  private var skeletonList: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(0..<6, id: \.self) { _ in
        VStack(alignment: .leading, spacing: 6) {
          RoundedRectangle(cornerRadius: 6, style: .continuous)
            .fill(Color.secondary.opacity(0.2))
            .frame(height: 12)
          RoundedRectangle(cornerRadius: 6, style: .continuous)
            .fill(Color.secondary.opacity(0.2))
            .frame(width: 120, height: 10)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
      }
    }
    .redacted(reason: .placeholder)
  }

  private func selectionBackground(for ticketId: String) -> Color {
    if ticketId == selectedTicketId {
      return Color.accentColor.opacity(0.2)
    }
    if ticketId == hoveredTicketId {
      return colorScheme == .dark ? Color.white.opacity(0.06) : Color.black.opacity(0.04)
    }
    return .clear
  }

  private func selectionBorder(for ticketId: String) -> Color {
    if ticketId == selectedTicketId {
      return Color.accentColor.opacity(0.35)
    }
    if ticketId == hoveredTicketId {
      return Color.primary.opacity(0.16)
    }
    return Color.primary.opacity(0.08)
  }

  private func refreshTickets() async {
    isLoading = true
    errorMessage = nil
    loadNotice = nil
    let result = await loadTicketsWithTimeout(seconds: 4)
    switch result {
    case let .success(fetched):
      tickets = fetched
      updateSelectionAfterRefresh()
      hasLoadedOnce = true
      persistCachedTickets()
    case .timedOut:
      if hasLoadedOnce {
        loadNotice = "Showing cached tickets. Refresh timed out."
      } else {
        errorMessage = "Timed out loading tickets. Try Sync, or open a shell and run `hack x tickets list --json` (note the `x`)."
      }
    case let .failure(message):
      errorMessage = message
    }
    isLoading = false
  }

  private func loadTicketDetail() async {
    guard let selectedTicketId else {
      ticketDetail = nil
      detailErrorMessage = nil
      isDetailLoading = false
      return
    }
    isDetailLoading = true
    detailErrorMessage = nil
    isHistoryExpanded = false
    isPropertiesExpanded = false
    do {
      let detail = try await model.showTicket(for: project, ticketId: selectedTicketId)
      ticketDetail = detail
      ticketDetailCache[selectedTicketId] = detail
    } catch {
      detailErrorMessage = error.localizedDescription
    }
    isDetailLoading = false
  }

  private func updateSelectionAfterRefresh() {
    let filtered = filteredTickets
    if let selectedTicketId,
       !filtered.contains(where: { $0.ticketId == selectedTicketId }) {
      self.selectedTicketId = nil
      ticketDetail = nil
      detailErrorMessage = nil
    }
  }

  private func createTicket(_ input: TicketCreateInput) async {
    guard !input.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    let created = await model.createTicket(
      for: project,
      title: input.title.trimmingCharacters(in: .whitespacesAndNewlines),
      body: input.body.trimmingCharacters(in: .whitespacesAndNewlines),
      dependsOn: parseTicketRefs(input.dependsOn),
      blocks: parseTicketRefs(input.blocks)
    )
    if let created {
      showCreateSheet = false
      await refreshTickets()
      selectedTicketId = created.ticketId
    }
  }

  private func updateStatus(ticketId: String, status: TicketStatus) async {
    _ = await model.setTicketStatus(for: project, ticketId: ticketId, status: status)
    await refreshTickets()
  }

  private func syncTickets() async {
    _ = await model.syncTickets(for: project)
    await refreshTickets()
  }

  private func requestBulkSyncConfirmation(_ action: TicketBulkSyncAction) {
    pendingBulkSyncAction = action
  }

  private func performBulkSync(_ action: TicketBulkSyncAction) async {
    pendingBulkSyncAction = nil
    switch action {
    case .pullLinear:
      await syncProjectFromLinear()
    case .pushHack:
      await syncProjectToLinear()
    }
  }

  private func runSyncAction(
    _ action: TicketSyncAction,
    operation: () async -> Void
  ) async {
    activeSyncAction = action
    defer { activeSyncAction = nil }
    await operation()
  }

  private func refreshLinearRouting() async {
    async let binding = model.inspectLinearProjectBinding(for: project)
    async let defaultProfile = model.getGlobalConfig(
      key: "controlPlane.extensions[\"dance.hack.linear\"].config.defaultProfile"
    )

    let resolvedBinding = await binding
    let resolvedProjectProfile = (resolvedBinding?.profileId ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let resolvedDefaultProfile = (await defaultProfile ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    linearRouteProfile = resolvedProjectProfile.isEmpty ? resolvedDefaultProfile : resolvedProjectProfile
    linearRouteProjectId = (resolvedBinding?.projectId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    linearRouteProjectName = (resolvedBinding?.projectName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    linearRouteTeamId = (resolvedBinding?.teamId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    linearAdditionalProjects = resolvedBinding?.additionalProjects ?? []
    linearRouteStatus = await model.inspectLinearStatus(
      profileId: linearRouteProfile.isEmpty ? nil : linearRouteProfile
    )
    linearAutosyncRouteKeys = await loadLinearAutosyncRouteKeys(targets: allLinearRouteTargets)
  }

  private func loadLinearAutosyncRouteKeys(
    targets: [LinearProjectBindingTarget]
  ) async -> Set<String> {
    var nextKeys: Set<String> = []
    for target in targets {
      let normalizedTarget = normalizedLinearRouteTarget(target)
      guard let profileId = normalizedTarget.profileId, !profileId.isEmpty else {
        continue
      }
      guard let subscriptions = await model.listLinearAutosyncSubscriptions(
        profileId: profileId,
        projectId: normalizedTarget.projectId,
        teamId: normalizedTarget.teamId
      ) else {
        continue
      }
      if subscriptions.subscriptions.contains(where: {
        $0.projectId == normalizedTarget.projectId &&
          $0.teamId == normalizedTarget.teamId &&
          $0.mode == "auto_apply" &&
          $0.status == "active"
      }) {
        nextKeys.insert(linearRouteKey(for: normalizedTarget))
      }
    }
    return nextKeys
  }

  private func syncProjectFromLinear() async {
    await runSyncAction(.pullProjectFromLinear) {
      loadNotice = nil
      let result = await model.syncLinearProject(
        for: project,
        from: "linear",
        ownerMode: nil,
        projectId: nil,
        teamId: nil,
        limit: nil,
        syncLabels: nil
      )
      guard let result, result.ok else {
        loadNotice = model.errorMessage ?? "Linear sync failed."
        return
      }
      let routedProjects = result.projectIds?.count ?? (linearAdditionalProjects.isEmpty ? 1 : linearAdditionalProjects.count + 1)
      loadNotice = "Pulled \(result.processed) item\(result.processed == 1 ? "" : "s") from \(routedProjects) routed Linear project\(routedProjects == 1 ? "" : "s")."
      await refreshTickets()
    }
  }

  private func runProjectLinearAutosync() async {
    await runSyncAction(.runProjectAutosync) {
      loadNotice = nil
      let result = await model.runLinearAutosync(for: project)
      guard let result, result.ok else {
        loadNotice = model.errorMessage ?? "Linear autosync failed."
        return
      }
      loadNotice =
        "Processed \(result.processedDeliveries) pending delivery\(result.processedDeliveries == 1 ? "" : "ies") across \(result.subscribedRoutes) subscribed route\(result.subscribedRoutes == 1 ? "" : "s") • applied \(result.appliedDeliveries) • failed \(result.failedDeliveries)."
      await refreshTickets()
    }
  }

  private func syncProjectToLinear() async {
    await runSyncAction(.pushProjectToLinear) {
      loadNotice = nil
      let result = await model.syncLinearProject(
        for: project,
        from: "hack",
        ownerMode: "hack",
        projectId: nil,
        teamId: nil,
        limit: nil,
        syncLabels: nil
      )
      guard let result, result.ok else {
        loadNotice = model.errorMessage ?? "Linear sync failed."
        return
      }
      loadNotice = "Pushed \(result.processed) Hack ticket\(result.processed == 1 ? "" : "s") to Linear."
      await refreshTickets()
    }
  }

  private func syncSelectedTicketToLinear(_ ticket: TicketSummary) async {
    await runSyncAction(.pushTicketToLinear(ticket.ticketId)) {
      loadNotice = nil
      let result = await model.syncLinearIssue(
        for: project,
        from: "hack",
        issueIdentifier: nil,
        ticketId: ticket.ticketId,
        projectId: nil,
        teamId: nil,
        syncLabels: nil
      )
      guard let result, result.ok else {
        loadNotice = model.errorMessage ?? "Ticket sync failed."
        return
      }
      loadNotice = "Synced \(result.ticketId) to \(result.issueIdentifier)."
      await refreshTickets()
    }
  }

  private func syncSelectedTicketFromLinear(_ ticket: TicketSummary) async {
    guard let issueIdentifier = ticket.externalKey, !issueIdentifier.isEmpty else {
      loadNotice = "This ticket is not linked to a Linear issue yet."
      return
    }
    await runSyncAction(.pullTicketFromLinear(ticket.ticketId)) {
      loadNotice = nil
      let result = await model.syncLinearIssue(
        for: project,
        from: "linear",
        issueIdentifier: issueIdentifier,
        ticketId: nil,
        projectId: nil,
        teamId: nil,
        syncLabels: nil
      )
      guard let result, result.ok else {
        loadNotice = model.errorMessage ?? "Ticket refresh failed."
        return
      }
      loadNotice = "Refreshed \(result.ticketId) from \(result.issueIdentifier)."
      await refreshTickets()
    }
  }

  private func resolveTicketConflict(
    _ conflict: TicketSyncConflict,
    resolution: TicketSyncConflictResolution,
    summary: String? = nil
  ) async {
    guard !resolvingConflictIds.contains(conflict.conflictId) else {
      return
    }
    resolvingConflictIds.insert(conflict.conflictId)
    defer { resolvingConflictIds.remove(conflict.conflictId) }

    let result = await model.resolveTicketConflict(
      for: project,
      ticketId: conflict.ticketId,
      conflictId: conflict.conflictId,
      resolution: resolution,
      summary: summary
    )
    guard result?.ok == true else {
      loadNotice = model.errorMessage ?? "Failed to resolve ticket conflict."
      return
    }

    loadNotice = "Resolved \(conflict.field) conflict by \(ticketConflictResolutionLabel(resolution))."
    await refreshTickets()
    await loadTicketDetail()
  }

  private func ticketConflictResolutionLabel(
    _ resolution: TicketSyncConflictResolution
  ) -> String {
    switch resolution {
    case .acceptLocal:
      return "keeping Hack"
    case .acceptRemote:
      return "keeping Linear"
    case .merged:
      return "marking it merged"
    case .ignore:
      return "ignoring it"
    }
  }

  private func activateReviewQueue() {
    selectedFilter = .reviewQueue
    if selectedTicketId == nil || !filteredTickets.contains(where: { $0.ticketId == selectedTicketId }) {
      selectedTicketId = reviewQueueEntries.first?.ticketId
    }
    ticketsListFocused = true
  }

  private func reviewNotes(for ticket: TicketSummary) -> [TicketReviewNote] {
    if let detail = ticketDetail, detail.ticket.ticketId == ticket.ticketId {
      return detail.reviewNotes
    }
    return ticketDetailCache[ticket.ticketId]?.reviewNotes ?? []
  }

  private func reviewDraft(for ticket: TicketSummary) -> String {
    reviewComposerDrafts[ticket.ticketId] ?? ""
  }

  private func reviewDraftBinding(for ticket: TicketSummary) -> Binding<String> {
    let key = ticket.ticketId
    return Binding(
      get: { reviewComposerDrafts[key] ?? "" },
      set: { newValue in
        reviewComposerDrafts[key] = newValue
      }
    )
  }

  private func applyReviewDraftTemplate(for detail: TicketDetailResponse) {
    reviewComposerDrafts[detail.ticket.ticketId] = TicketReviewComposer.draft(for: detail)
  }

  private func appendQuotedCommentToReviewDraft(_ comment: TicketComment, ticket: TicketSummary) {
    let quote = TicketReviewComposer.quote(comment: comment)
    appendToReviewDraft(quote, ticket: ticket)
  }

  private func stageConflictReviewDraft(_ conflict: TicketSyncConflict) {
    guard let detail = ticketDetail, detail.ticket.ticketId == conflict.ticketId else {
      return
    }
    let draft = TicketReviewComposer.draft(for: detail, highlightedConflict: conflict)
    reviewComposerDrafts[detail.ticket.ticketId] = draft
  }

  private func appendToReviewDraft(_ text: String, ticket: TicketSummary) {
    let key = ticket.ticketId
    let existing = reviewComposerDrafts[key]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      return
    }
    if existing.isEmpty {
      reviewComposerDrafts[key] = trimmed
    } else {
      reviewComposerDrafts[key] = "\(existing)\n\n\(trimmed)"
    }
  }

  private func postReviewDraftAsReviewNote(for ticket: TicketSummary) async {
    let key = ticket.ticketId
    let trimmed = (reviewComposerDrafts[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      loadNotice = "Draft a review note before saving it."
      return
    }
    guard !postingReviewNoteTicketIds.contains(ticket.ticketId) else {
      return
    }

    postingReviewNoteTicketIds.insert(ticket.ticketId)
    defer { postingReviewNoteTicketIds.remove(ticket.ticketId) }

    let response = await model.appendTicketReviewNote(
      for: project,
      ticketId: ticket.ticketId,
      body: trimmed
    )
    guard response != nil else {
      loadNotice = model.errorMessage ?? "Failed to save review note."
      return
    }

    reviewComposerDrafts[key] = ""
    loadNotice = "Saved a shared review note to \(ticket.ticketId)."
    await refreshTickets()
    await loadTicketDetail()
  }

  private func postReviewDraftAsTicketComment(for ticket: TicketSummary) async {
    let key = ticket.ticketId
    let trimmed = (reviewComposerDrafts[key] ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      loadNotice = "Draft a review comment before posting it."
      return
    }
    guard !postingCommentTicketIds.contains(ticket.ticketId) else {
      return
    }

    postingCommentTicketIds.insert(ticket.ticketId)
    defer { postingCommentTicketIds.remove(ticket.ticketId) }

    let response = await model.appendTicketComment(
      for: project,
      ticketId: ticket.ticketId,
      body: trimmed,
      source: "hack"
    )
    guard response != nil else {
      loadNotice = model.errorMessage ?? "Failed to append ticket comment."
      return
    }

    reviewComposerDrafts[key] = ""
    loadNotice = "Posted an immutable Hack comment to \(ticket.ticketId)."
    await refreshTickets()
    await loadTicketDetail()
  }

  private func clearReviewDraft(for ticket: TicketSummary) {
    reviewComposerDrafts[ticket.ticketId] = ""
  }

  private func copyReviewDraft(for ticket: TicketSummary) {
    let trimmed = reviewDraft(for: ticket).trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      loadNotice = "Draft a review comment before copying it."
      return
    }
    copyToPasteboard(trimmed)
    loadNotice = "Copied review draft."
  }

  private func copyToPasteboard(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
  }

  private func parseTicketRefs(_ text: String) -> [String] {
    let parts = text
      .split { $0 == "," || $0 == " " || $0 == "\n" || $0 == "\t" }
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
    return Array(Set(parts)).sorted()
  }

  private func ticketCount(for filter: TicketFilter) -> Int {
    switch filter {
    case .reviewQueue:
      return reviewQueueCount
    default:
      return filter.count(in: tickets)
    }
  }

  private var filteredTickets: [TicketSummary] {
    let originFiltered = tickets.filter { selectedOriginFilter.matches(ticket: $0) }
    let base: [TicketSummary]
    switch selectedFilter {
    case .all:
      base = originFiltered
    case .open:
      base = originFiltered.filter { $0.status == .open }
    case .inProgress:
      base = originFiltered.filter { $0.status == .inProgress }
    case .blocked:
      base = originFiltered.filter { $0.status == .blocked }
    case .done:
      base = originFiltered.filter { $0.status == .done }
    case .reviewQueue:
      let visibleTicketsById = Dictionary(
        uniqueKeysWithValues: originFiltered.map { ($0.ticketId, $0) }
      )
      base = reviewQueueEntries.compactMap { visibleTicketsById[$0.ticketId] }
    }

    let trimmed = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return base }
    return base.filter {
      $0.title.localizedStandardContains(trimmed) || $0.ticketId.localizedStandardContains(trimmed)
    }
  }

  @ViewBuilder
  private func ticketSection(status: TicketStatus) -> some View {
    let items = filteredTickets.filter { $0.status == status }
    if !items.isEmpty {
      Section(content: {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(items) { ticket in
            ticketRow(ticket)
          }
        }
      }, header: {
        HStack(spacing: 8) {
          Circle()
            .fill(status.color)
            .frame(width: 8, height: 8)
          Text(status.label)
            .font(.system(size: 13, weight: .semibold))
          Text("\(items.count)")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
          ZStack {
            Rectangle()
              .fill(.ultraThinMaterial)
            Rectangle()
              .fill(status.color.opacity(colorScheme == .dark ? 0.18 : 0.08))
          }
        )
        .overlay(alignment: .bottom) {
          Rectangle()
            .fill(Color.primary.opacity(0.12))
            .frame(height: 1)
        }
        .zIndex(1)
      })
      .textCase(nil)
    }
  }

  private func inspectorGroup(title: String, rows: [DetailRowItem]) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title)
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(.secondary)
      DetailRows(rows: rows, labelWidth: 88)
    }
  }

  private func inspectorDateRows(for ticket: TicketSummary) -> [DetailRowItem] {
    [
      DetailRowItem(label: "Created", value: humanReadableDetailDate(ticket.createdAt)),
      DetailRowItem(label: "Updated", value: humanReadableDetailDate(ticket.updatedAt))
    ]
  }

  private func inspectorLinkRows(for ticket: TicketSummary) -> [DetailRowItem] {
    [
      DetailRowItem(label: "ID", value: ticket.ticketId),
      DetailRowItem(label: "Status", value: ticket.status.label),
      DetailRowItem(label: "Owner", value: ticket.owner),
      DetailRowItem(label: "Source", value: ticket.source),
      DetailRowItem(label: "Assignee", value: ticket.assignee ?? "—"),
      DetailRowItem(label: "Tags", value: ticket.tags.joined(separator: ", ").nilIfEmpty ?? "—"),
      DetailRowItem(label: "Remote", value: ticket.externalSystem ?? "—"),
      DetailRowItem(label: "Issue key", value: ticket.externalKey ?? "—"),
      DetailRowItem(label: "Issue id", value: ticket.externalId ?? "—"),
      DetailRowItem(label: "Linear URL", value: ticket.externalUrl ?? "—"),
      DetailRowItem(label: "Project", value: ticket.externalProjectName ?? ticket.externalProjectId ?? "—"),
      DetailRowItem(label: "Team", value: ticket.externalTeamId ?? "—")
    ]
  }

  private func inspectorDependencyRows(for ticket: TicketSummary) -> [DetailRowItem] {
    [
      DetailRowItem(label: "Depends", value: ticket.dependsOn.joined(separator: ", ").nilIfEmpty ?? "—"),
      DetailRowItem(label: "Blocks", value: ticket.blocks.joined(separator: ", ").nilIfEmpty ?? "—")
    ]
  }

  private func moveSelection(_ direction: MoveCommandDirection) {
    let visibleTickets = filteredTickets
    guard !visibleTickets.isEmpty else { return }
    let nextTicket: TicketSummary?
    switch direction {
    case .up:
      if let selectedTicketId,
         let index = visibleTickets.firstIndex(where: { $0.ticketId == selectedTicketId }) {
        nextTicket = visibleTickets[max(0, index - 1)]
      } else {
        nextTicket = visibleTickets.last
      }
    case .down:
      if let selectedTicketId,
         let index = visibleTickets.firstIndex(where: { $0.ticketId == selectedTicketId }) {
        nextTicket = visibleTickets[min(visibleTickets.count - 1, index + 1)]
      } else {
        nextTicket = visibleTickets.first
      }
    default:
      return
    }
    selectedTicketId = nextTicket?.ticketId
  }

  private func cacheKey() -> String {
    "tickets.cache.\(project.id)"
  }

  private func loadCachedTickets() {
    let key = cacheKey()
    guard let data = UserDefaults.standard.data(forKey: key) else { return }
    let decoder = JSONDecoder()
    if let payload = try? decoder.decode(TicketCachePayload.self, from: data) {
      tickets = payload.tickets
      hasLoadedOnce = true
      updateSelectionAfterRefresh()
    }
  }

  private func persistCachedTickets() {
    let payload = TicketCachePayload(updatedAt: Date(), tickets: tickets)
    let encoder = JSONEncoder()
    guard let data = try? encoder.encode(payload) else { return }
    UserDefaults.standard.set(data, forKey: cacheKey())
  }

  private enum TicketLoadResult {
    case success([TicketSummary])
    case timedOut
    case failure(String)
  }

  private func loadTicketsWithTimeout(seconds: Double) async -> TicketLoadResult {
    await withTaskGroup(of: TicketLoadResult.self) { group in
      group.addTask {
        do {
          let fetched = try await model.listTickets(for: project)
          return .success(fetched)
        } catch {
          return .failure(error.localizedDescription)
        }
      }
      group.addTask {
        try? await Task.sleep(for: .seconds(seconds))
        return .timedOut
      }

      guard let result = await group.next() else {
        return .failure("No response")
      }
      group.cancelAll()
      return result
    }
  }

  private func ticketStatusBadge(_ status: TicketStatus) -> some View {
    Text(status.label)
      .font(.system(size: 11, weight: .semibold))
      .foregroundStyle(status.color)
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
      .background(
        Capsule(style: .continuous)
          .fill(ticketBadgeFill(for: status))
      )
      .overlay(
        Capsule(style: .continuous)
          .stroke(ticketBadgeStroke(for: status), lineWidth: 1)
      )
  }

  private func ticketMetaPill(_ text: String, tone: Color) -> some View {
    Text(text)
      .font(.system(size: 11, weight: .semibold))
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
      .background(
        Capsule(style: .continuous)
          .fill(tone.opacity(colorScheme == .dark ? 0.18 : 0.1))
      )
      .overlay(
        Capsule(style: .continuous)
          .stroke(tone.opacity(colorScheme == .dark ? 0.34 : 0.2), lineWidth: 1)
      )
      .foregroundStyle(tone)
  }

  @ViewBuilder
  private func ticketConflictValueRow(label: String, value: String?) -> some View {
    if let value, !value.isEmpty {
      VStack(alignment: .leading, spacing: 4) {
        Text(label)
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(.secondary)
        Text(value)
          .font(.system(size: 12, weight: .medium, design: .monospaced))
          .foregroundStyle(.primary)
          .textSelection(.enabled)
      }
    }
  }

  private func reviewToneColor(_ severity: TicketSyncReviewSeverity) -> Color {
    switch severity {
    case .clear:
      return .green
    case .review:
      return .orange
    case .conflict:
      return .orange
    }
  }

  private func ticketHeaderBadge(
    title: String,
    systemImage: String,
    tone: Color
  ) -> some View {
    HStack(spacing: 6) {
      Image(systemName: systemImage)
        .font(.system(size: 11, weight: .semibold))
      Text(title)
        .font(.system(size: 12, weight: .semibold))
        .lineLimit(1)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 7)
    .background {
      Capsule(style: .continuous)
        .fill(tone.opacity(colorScheme == .dark ? 0.16 : 0.08))
        .overlay(
          Capsule(style: .continuous)
            .stroke(tone.opacity(colorScheme == .dark ? 0.28 : 0.18), lineWidth: 1)
        )
    }
      .foregroundStyle(tone)
  }

  private func openProjectRouting() {
    model.selectedItem = .project(project.id)
    NotificationCenter.default.post(
      name: .hackProjectRoutingRequested,
      object: nil,
      userInfo: [
        ProjectRoutingRequest.projectIdKey: project.id
      ]
    )
  }

  private func openLinearSettings() {
    NotificationCenter.default.post(
      name: .hackSettingsRequested,
      object: nil,
      userInfo: [SettingsNavigationRequest.paneKey: SettingsSidebarItem.linear.rawValue]
    )
  }

  private func ticketPanel<Content: View>(
    contentPadding: CGFloat = 14,
    @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      content()
    }
    .padding(contentPadding)
    .background(
      ZStack {
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .fill(panelBaseFillColor)
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .fill(.thinMaterial)
          .opacity(colorScheme == .dark ? 0.42 : 0.64)
      }
    )
    .overlay(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .stroke(panelStrokeColor, lineWidth: 1)
    )
    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
  }

  private func ticketDetailPanel<Content: View>(
    @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      content()
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .fill(ticketDetailPanelFillColor)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .stroke(ticketDetailPanelStrokeColor, lineWidth: 1)
    )
    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
  }

  private var newTicketButton: some View {
    Button {
      showCreateSheet = true
    } label: {
      HStack(spacing: 6) {
        Image(systemName: "plus")
          .font(.system(size: 12, weight: .bold))
        Text("New")
          .font(.system(size: 13, weight: .semibold))
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 7)
      .foregroundStyle(.white)
      .background(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .fill(newButtonFillColor)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .stroke(newButtonStrokeColor, lineWidth: 1)
      )
      .shadow(color: .black.opacity(colorScheme == .dark ? 0.35 : 0.14), radius: 6, y: 2)
    }
    .buttonStyle(.plain)
  }

  private var headerControlFillColor: Color {
    colorScheme == .dark ? Color.white.opacity(0.08) : Color.white.opacity(0.76)
  }

  private var headerControlStrokeColor: Color {
    colorScheme == .dark ? Color.white.opacity(0.14) : Color.black.opacity(0.08)
  }

  @ViewBuilder
  private var headerControlCapsuleBackground: some View {
    if colorScheme == .dark {
      Capsule(style: .continuous)
        .fill(.regularMaterial)
        .overlay(
          Capsule(style: .continuous)
            .stroke(headerControlStrokeColor, lineWidth: 1)
        )
    } else {
      Capsule(style: .continuous)
        .fill(headerControlFillColor)
        .overlay(
          Capsule(style: .continuous)
            .stroke(headerControlStrokeColor, lineWidth: 1)
        )
    }
  }

  @ViewBuilder
  private var headerControlFieldBackground: some View {
    if colorScheme == .dark {
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(.regularMaterial)
        .overlay(
          RoundedRectangle(cornerRadius: 10, style: .continuous)
            .stroke(headerControlStrokeColor, lineWidth: 1)
        )
    } else {
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(headerControlFillColor)
        .overlay(
          RoundedRectangle(cornerRadius: 10, style: .continuous)
            .stroke(headerControlStrokeColor, lineWidth: 1)
        )
    }
  }

  private var panelBaseFillColor: Color {
    colorScheme == .dark ? Color.black.opacity(0.46) : Color.white.opacity(0.72)
  }

  private var panelStrokeColor: Color {
    colorScheme == .dark ? Color.white.opacity(0.14) : Color.white.opacity(0.82)
  }

  private var ticketDetailPanelFillColor: Color {
    colorScheme == .dark ? Color.black.opacity(0.66) : Color.white
  }

  private var ticketDetailPanelStrokeColor: Color {
    colorScheme == .dark ? Color.white.opacity(0.12) : Color.black.opacity(0.08)
  }

  private var ticketDetailFooterFillColor: Color {
    colorScheme == .dark ? Color.black.opacity(0.18) : Color.white
  }

  private var newButtonFillColor: Color {
    colorScheme == .dark ? Color.accentColor.opacity(0.94) : Color.accentColor
  }

  private var newButtonStrokeColor: Color {
    colorScheme == .dark ? Color.white.opacity(0.16) : Color.black.opacity(0.08)
  }

  private func ticketBadgeFill(for status: TicketStatus) -> Color {
    if colorScheme == .dark {
      return status.color.opacity(0.28)
    }
    return status.color.opacity(0.14)
  }

  private func ticketBadgeStroke(for status: TicketStatus) -> Color {
    if colorScheme == .dark {
      return status.color.opacity(0.42)
    }
    return status.color.opacity(0.24)
  }

  private func humanReadableListDate(_ isoString: String) -> String {
    guard let date = parseDate(isoString) else {
      return isoString
    }
    return TicketDateFormatter.listFormatter.string(from: date)
  }

  private func humanReadableDetailDate(_ isoString: String) -> String {
    guard let date = parseDate(isoString) else {
      return isoString
    }
    return TicketDateFormatter.detailFormatter.string(from: date)
  }

  private func parseDate(_ value: String) -> Date? {
    if let date = TicketDateFormatter.isoWithFractional.date(from: value) {
      return date
    }
    return TicketDateFormatter.isoBasic.date(from: value)
  }
}

private struct TicketCachePayload: Codable {
  let updatedAt: Date
  let tickets: [TicketSummary]
}

private enum TicketFilter: String, CaseIterable {
  case all
  case open
  case inProgress = "in_progress"
  case blocked
  case done
  case reviewQueue = "review_queue"

  var label: String {
    switch self {
    case .all:
      return "All"
    case .open:
      return "Open"
    case .inProgress:
      return "In progress"
    case .blocked:
      return "Blocked"
    case .done:
      return "Done"
    case .reviewQueue:
      return "Review queue"
    }
  }

  func count(in tickets: [TicketSummary]) -> Int {
    switch self {
    case .all:
      return tickets.count
    case .open:
      return tickets.filter { $0.status == .open }.count
    case .inProgress:
      return tickets.filter { $0.status == .inProgress }.count
    case .blocked:
      return tickets.filter { $0.status == .blocked }.count
    case .done:
      return tickets.filter { $0.status == .done }.count
    case .reviewQueue:
      return tickets.filter { $0.linearSyncUXState.reviewHint != nil }.count
    }
  }
}

private enum TicketOriginFilter: String, CaseIterable {
  case both
  case hack
  case linear

  var label: String {
    switch self {
    case .both:
      return "All origins"
    case .hack:
      return "Hack only"
    case .linear:
      return "Linear only"
    }
  }

  func matches(ticket: TicketSummary) -> Bool {
    let owner = ticket.owner.lowercased()
    let source = ticket.source.lowercased()
    let externalSystem = ticket.externalSystem?.lowercased() ?? ""
    switch self {
    case .both:
      return true
    case .hack:
      return owner == "hack" || source == "hack"
    case .linear:
      return owner == "linear" || source == "linear" || externalSystem == "linear"
    }
  }

  func count(in tickets: [TicketSummary]) -> Int {
    tickets.filter { matches(ticket: $0) }.count
  }
}

private enum TicketBulkSyncAction: String, Identifiable {
  case pullLinear
  case pushHack

  var id: String { rawValue }

  var dialogTitle: String {
    switch self {
    case .pullLinear:
      return "Pull Linear issues into tickets?"
    case .pushHack:
      return "Push Hack tickets to Linear?"
    }
  }

  var confirmLabel: String {
    switch self {
    case .pullLinear:
      return "Pull from Linear"
    case .pushHack:
      return "Push to Linear"
    }
  }

  var message: String {
    switch self {
    case .pullLinear:
      return "Use this when Linear is the source of truth for the project. Linear-owned tickets will refresh local authoritative fields, while comments remain append-only."
    case .pushHack:
      return "Use this when Hack owns the local ticket set for this project. Hack-owned tickets will publish outward, while assignees, labels, and dependencies merge best effort."
    }
  }
}

private enum TicketSyncAction: Equatable {
  case pullProjectFromLinear
  case runProjectAutosync
  case pushProjectToLinear
  case pushTicketToLinear(String)
  case pullTicketFromLinear(String)

  var progressLabel: String {
    switch self {
    case .pullProjectFromLinear:
      return "Pulling Linear project…"
    case .runProjectAutosync:
      return "Running Linear autosync…"
    case .pushProjectToLinear:
      return "Pushing Hack tickets…"
    case let .pushTicketToLinear(ticketId):
      return "Pushing \(ticketId)…"
    case let .pullTicketFromLinear(ticketId):
      return "Refreshing \(ticketId)…"
    }
  }
}

private struct TicketSyncGuidance {
  let title: String
  let message: String
  let tone: StatusTone
}

private enum TicketDateFormatter {
  static let isoWithFractional: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()

  static let isoBasic: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter
  }()

  static let listFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateStyle = .medium
    formatter.timeStyle = .none
    formatter.doesRelativeDateFormatting = true
    return formatter
  }()

  static let detailFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateStyle = .medium
    formatter.timeStyle = .short
    formatter.doesRelativeDateFormatting = true
    return formatter
  }()
}

private struct TicketCreateInput {
  let title: String
  let body: String
  let dependsOn: String
  let blocks: String
}

private struct TicketCreateSheet: View {
  let projectName: String
  let onCreate: (TicketCreateInput) -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var title = ""
  @State private var ticketBody = ""
  @State private var dependsOn = ""
  @State private var blocks = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("New ticket")
        .font(.mono(.title3, weight: .semibold))
      Text(projectName)
        .font(.mono(.subheadline))
        .foregroundStyle(.secondary)
      VStack(alignment: .leading, spacing: 12) {
        TextField("Title", text: $title)
          .textFieldStyle(.roundedBorder)
        TextField("Depends on (comma-separated)", text: $dependsOn)
          .textFieldStyle(.roundedBorder)
        TextField("Blocks (comma-separated)", text: $blocks)
          .textFieldStyle(.roundedBorder)
        VStack(alignment: .leading, spacing: 6) {
          Text("Body")
            .font(.mono(.caption))
            .foregroundStyle(.secondary)
          TextEditor(text: $ticketBody)
            .frame(minHeight: 160)
            .overlay(
              RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Color.secondary.opacity(0.2), lineWidth: 1)
            )
        }
      }
      HStack {
        Button("Cancel") {
          dismiss()
        }
        .adaptiveToolbarButton()
        Spacer()
        Button("Create") {
          onCreate(
            TicketCreateInput(
              title: title,
              body: ticketBody,
              dependsOn: dependsOn,
              blocks: blocks
            )
          )
        }
        .adaptiveToolbarButtonProminent()
        .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    .padding(24)
    .frame(minWidth: 420, idealWidth: 520)
  }
}

private extension TicketStatus {
  var label: String {
    switch self {
    case .open:
      return "Open"
    case .inProgress:
      return "In progress"
    case .blocked:
      return "Blocked"
    case .done:
      return "Done"
    }
  }

  var tone: StatusTone {
    switch self {
    case .open:
      return .neutral
    case .inProgress:
      return .good
    case .blocked:
      return .warn
    case .done:
      return .good
    }
  }

  var color: Color {
    switch self {
    case .open:
      return .blue
    case .inProgress:
      return .indigo
    case .blocked:
      return .orange
    case .done:
      return .green
    }
  }
}

extension TicketStatus: CaseIterable {
  public static var allCases: [TicketStatus] {
    [.open, .inProgress, .blocked, .done]
  }
}

private extension String {
  var nilIfEmpty: String? {
    let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}
