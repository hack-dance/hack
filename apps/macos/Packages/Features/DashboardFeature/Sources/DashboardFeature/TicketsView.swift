import MarkdownUI
import SwiftUI

import HackDesktopModels

struct TicketsView: View {
  @Environment(DashboardModel.self) private var model
  @Environment(\.colorScheme) private var colorScheme

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
  @State private var hasLoadedOnce = false
  @State private var isPropertiesExpanded = false
  @State private var isHistoryExpanded = false
  @State private var searchText = ""
  @State private var loadNotice: String? = nil
  @State private var hoveredTicketId: String? = nil
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
    .fontDesign(.monospaced)
    .padding(.horizontal, 24)
    .padding(.top, 12)
    .padding(.bottom, 24)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .task {
      loadCachedTickets()
      await refreshTickets()
      ticketsListFocused = true
    }
    .task(id: selectedTicketId) {
      await loadTicketDetail()
    }
    .onChange(of: selectedFilter) { _, _ in
      updateSelectionAfterRefresh()
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
  }

  private var header: some View {
    HStack(alignment: .center, spacing: 12) {
      statusFilterMenu
      searchField
      Spacer(minLength: 12)
      if let loadNotice {
        Text(loadNotice)
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
      }
      newTicketButton
      Menu {
        Button("Refresh") {
          Task { await refreshTickets() }
        }
        Button("Sync") {
          Task { await syncTickets() }
        }
      } label: {
        Image(systemName: "ellipsis.circle")
          .font(.system(size: 16, weight: .semibold))
          .foregroundStyle(.primary.opacity(0.7))
      }
      .buttonStyle(PressableIconButtonStyle())
    }
  }

  private var hasSelection: Bool {
    selectedTicketId != nil
  }

  private var statusFilterMenu: some View {
    Menu {
      ForEach(TicketFilter.allCases, id: \.self) { filter in
        Button {
          selectedFilter = filter
        } label: {
          if selectedFilter == filter {
            Label("\(filter.label) (\(filter.count(in: tickets)))", systemImage: "checkmark")
          } else {
            Text("\(filter.label) (\(filter.count(in: tickets)))")
          }
        }
      }
    } label: {
      HStack(spacing: 8) {
        Image(systemName: "line.3.horizontal.decrease.circle")
          .font(.system(size: 13, weight: .semibold))
        Text(selectedFilter.label)
          .font(.system(size: 13, weight: .semibold))
        Text("\(selectedFilter.count(in: tickets))")
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
        Divider()
          .opacity(0.22)
        ScrollView {
          if isLoading && !hasLoadedOnce {
            skeletonList
          } else if filteredTickets.isEmpty {
            emptyTicketsView
          } else if selectedFilter == .all {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
              ForEach(TicketStatus.allCases, id: \.self) { status in
                ticketSection(status: status)
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
      Text("Try another filter or create a new ticket.")
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(.secondary)
      Button("New ticket") {
        showCreateSheet = true
      }
      .adaptiveToolbarButton()
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
    }
  }

  private func ticketDetailFooter(_ detail: TicketDetailResponse) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      DisclosureGroup(isExpanded: $isHistoryExpanded) {
        if detail.events.isEmpty {
          Text("No history events for this ticket.")
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(.secondary)
            .padding(.top, 6)
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
          .padding(.top, 6)
        }
      } label: {
        Text("History")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(.secondary)
      }

      Divider()
        .opacity(0.25)

      DisclosureGroup(isExpanded: $isPropertiesExpanded) {
        VStack(alignment: .leading, spacing: 14) {
          inspectorGroup(title: "Dates", rows: inspectorDateRows(for: detail.ticket))
          inspectorGroup(title: "Links", rows: inspectorLinkRows(for: detail.ticket))
          inspectorGroup(title: "Dependencies", rows: inspectorDependencyRows(for: detail.ticket))
        }
        .padding(.top, 6)
      } label: {
        Text("Properties")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(.secondary)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
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
      ticketDetail = try await model.showTicket(for: project, ticketId: selectedTicketId)
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

  private func parseTicketRefs(_ text: String) -> [String] {
    let parts = text
      .split { $0 == "," || $0 == " " || $0 == "\n" || $0 == "\t" }
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
    return Array(Set(parts)).sorted()
  }

  private var filteredTickets: [TicketSummary] {
    let base: [TicketSummary]
    switch selectedFilter {
    case .all:
      base = tickets
    case .open:
      base = tickets.filter { $0.status == .open }
    case .inProgress:
      base = tickets.filter { $0.status == .inProgress }
    case .blocked:
      base = tickets.filter { $0.status == .blocked }
    case .done:
      base = tickets.filter { $0.status == .done }
    }

    let trimmed = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return base }
    let lower = trimmed.lowercased()
    return base.filter {
      $0.title.lowercased().contains(lower) || $0.ticketId.lowercased().contains(lower)
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
      DetailRowItem(label: "Status", value: ticket.status.label)
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
    }
  }
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
