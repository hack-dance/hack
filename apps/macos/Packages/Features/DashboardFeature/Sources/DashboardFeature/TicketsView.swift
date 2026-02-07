import SwiftUI

import HackDesktopModels

struct TicketsView: View {
  @Environment(DashboardModel.self) private var model

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
  @State private var expandedSections: Set<TicketStatus> = Set(TicketStatus.allCases)
  @State private var searchText = ""
  @State private var loadNotice: String? = nil
  @State private var hoveredTicketId: String? = nil
  @State private var hoveredSection: TicketStatus? = nil

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
    .padding(.bottom, 24)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .task {
      loadCachedTickets()
      await refreshTickets()
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
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .center, spacing: 12) {
        Text("Tickets")
          .font(.mono(.headline, weight: .semibold))
        BadgePill(label: "\(filteredTickets.count)", tint: .secondary)
        filterRow
        Spacer()
        if let loadNotice {
          Text(loadNotice)
            .font(.mono(.caption2))
            .foregroundStyle(.secondary)
        }
        Button("New") {
          showCreateSheet = true
        }
        .adaptiveToolbarButtonProminent()
        Menu {
          Button("Refresh") {
            Task { await refreshTickets() }
          }
          Button("Sync") {
            Task { await syncTickets() }
          }
        } label: {
          Image(systemName: "ellipsis")
            .font(.mono(.title3))
        }
        .buttonStyle(.plain)
      }
    }
  }

  private var hasSelection: Bool {
    selectedTicketId != nil
  }

  private var filterRow: some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: 6) {
        ForEach(TicketFilter.allCases, id: \.self) { filter in
          filterPill(filter)
        }
        TextField("Search", text: $searchText)
          .textFieldStyle(.roundedBorder)
          .controlSize(.small)
          .frame(maxWidth: 200)
      }
      HStack(spacing: 8) {
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
          HStack(spacing: 6) {
            Text("Filter")
              .font(.mono(.caption, weight: .semibold))
            Text(selectedFilter.label)
              .font(.mono(.caption2))
              .foregroundStyle(.secondary)
            Image(systemName: "chevron.down")
              .font(.mono(.caption2))
              .foregroundStyle(.secondary)
          }
          .padding(.horizontal, 10)
          .padding(.vertical, 6)
          .background(
            Capsule(style: .continuous)
              .fill(Color.secondary.opacity(0.1))
          )
        }
        .menuStyle(.borderlessButton)

        TextField("Search", text: $searchText)
          .textFieldStyle(.roundedBorder)
          .controlSize(.small)
          .frame(maxWidth: 180)
      }
    }
  }

  private var content: some View {
    HStack(alignment: .top, spacing: 16) {
      ticketsListCard
        .frame(
          minWidth: 280,
          maxWidth: hasSelection ? 360 : .infinity,
          maxHeight: .infinity,
          alignment: .topLeading
        )
      if hasSelection {
        ticketDetailCard
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        ticketInspectorColumn
          .frame(minWidth: 220, idealWidth: 260, maxWidth: 320, maxHeight: .infinity, alignment: .topLeading)
      }
    }
    .frame(maxHeight: .infinity, alignment: .top)
    .animation(.easeInOut(duration: 0.2), value: hasSelection)
  }

  private var ticketsListCard: some View {
    GlassCard(title: "Tickets", systemImage: "tray") {
      ScrollView {
        if isLoading && !hasLoadedOnce {
          skeletonList
        } else if filteredTickets.isEmpty {
          emptyTicketsView
        } else if selectedFilter == .all {
          LazyVStack(alignment: .leading, spacing: 10) {
            ForEach(TicketStatus.allCases, id: \.self) { status in
              ticketSection(status: status)
            }
          }
        } else {
          LazyVStack(alignment: .leading, spacing: 8) {
            ForEach(filteredTickets) { ticket in
              ticketRow(ticket)
            }
          }
        }
      }
      .frame(maxHeight: .infinity, alignment: .topLeading)
    }
  }

  private var ticketDetailCard: some View {
    GlassCard(title: "Detail", systemImage: "doc.text") {
      ScrollView {
        if let detailErrorMessage {
          ticketsErrorCard(message: detailErrorMessage)
        } else if isDetailLoading {
          ProgressView()
            .frame(maxWidth: .infinity, alignment: .leading)
        } else if let detail = ticketDetail {
          ticketDetailView(detail)
        } else {
          Text("Select a ticket to see details.")
            .font(.mono(.subheadline))
            .foregroundStyle(.secondary)
        }
      }
      .frame(maxHeight: .infinity, alignment: .topLeading)
    }
  }

  private var ticketInspectorCard: some View {
    GlassCard(title: "Properties", systemImage: "slider.horizontal.3") {
      if let detail = ticketDetail {
        ScrollView {
          VStack(alignment: .leading, spacing: 14) {
            statusMenu(ticket: detail.ticket)
            inspectorGroup(title: "Dates", rows: inspectorDateRows(for: detail.ticket))
            inspectorGroup(title: "Links", rows: inspectorLinkRows(for: detail.ticket))
            inspectorGroup(title: "Dependencies", rows: inspectorDependencyRows(for: detail.ticket))
          }
        }
      } else {
        Text("Select a ticket.")
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
      }
    }
  }

  private var ticketInspectorColumn: some View {
    VStack(spacing: 0) {
      ticketInspectorCard
    }
    .padding(.top, 2)
    .padding(.horizontal, 2)
    .background(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .fill(.ultraThinMaterial)
    )
    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
  }

  private var emptyTicketsView: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("No tickets found.")
        .font(.mono(.subheadline, weight: .medium))
      Text("Try another filter or create a new ticket.")
        .font(.mono(.caption))
        .foregroundStyle(.secondary)
      Button("New ticket") {
        showCreateSheet = true
      }
      .adaptiveToolbarButton()
    }
  }

  private func ticketRow(_ ticket: TicketSummary) -> some View {
    Button {
      selectedTicketId = ticket.ticketId
    } label: {
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 8) {
          Circle()
            .fill(ticket.status.color)
            .frame(width: 8, height: 8)
          Text(ticket.title)
            .font(.mono(.subheadline, weight: .semibold))
            .lineLimit(1)
          Spacer()
          Menu {
            Button("Open details") {
              selectedTicketId = ticket.ticketId
            }
            Divider()
            ForEach(TicketStatus.allCases, id: \.self) { status in
              Button(status.label) {
                Task {
                  await updateStatus(ticketId: ticket.ticketId, status: status)
                }
              }
            }
          } label: {
            HStack(spacing: 6) {
              Text(ticket.status.label)
                .font(.mono(.caption))
              Image(systemName: "chevron.down")
                .font(.mono(.caption2))
            }
            .foregroundStyle(.secondary)
          }
          .menuStyle(.borderlessButton)
        }
        HStack(spacing: 8) {
          Text(ticket.ticketId)
            .font(.mono(.caption2))
            .foregroundStyle(.secondary)
          Spacer()
          Text(ticket.updatedAt)
            .font(.mono(.caption2))
            .foregroundStyle(.secondary)
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .background(selectionBackground(for: ticket.ticketId))
      .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
    .buttonStyle(.plain)
    .contentShape(Rectangle())
    .onHover { hovering in
      hoveredTicketId = hovering ? ticket.ticketId : nil
    }
    .animation(.easeInOut(duration: 0.12), value: hoveredTicketId)
  }

  private func ticketDetailView(_ detail: TicketDetailResponse) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(alignment: .top, spacing: 12) {
        VStack(alignment: .leading, spacing: 6) {
          Text(detail.ticket.title)
            .font(.mono(.headline))
          Text(detail.ticket.ticketId)
            .font(.mono(.caption))
            .foregroundStyle(.secondary)
        }
        Spacer()
      }

      if let body = detail.ticket.body, !body.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          Text("Body")
            .font(.mono(.caption, weight: .semibold))
            .foregroundStyle(.secondary)
          Text(body)
            .font(.mono(.subheadline))
            .textSelection(.enabled)
        }
      }

      if !detail.events.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          Text("History")
            .font(.mono(.caption, weight: .semibold))
            .foregroundStyle(.secondary)
          ForEach(detail.events) { event in
            HStack(spacing: 8) {
              Text(event.type)
                .font(.mono(.caption))
              Spacer()
              Text(event.tsIso)
                .font(.mono(.caption2))
                .foregroundStyle(.secondary)
            }
          }
        }
      }
    }
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
          .font(.mono(.caption, weight: .semibold))
        Image(systemName: "chevron.down")
          .font(.mono(.caption2))
      }
    }
    .menuStyle(.borderlessButton)
    .help("Change status")
  }

  private func inspectorRows(for ticket: TicketSummary) -> [DetailRowItem] {
    [
      DetailRowItem(label: "Status", value: ticket.status.label),
      DetailRowItem(label: "Created", value: ticket.createdAt),
      DetailRowItem(label: "Updated", value: ticket.updatedAt),
      DetailRowItem(label: "Depends on", value: ticket.dependsOn.joined(separator: ", ").nilIfEmpty ?? "—"),
      DetailRowItem(label: "Blocks", value: ticket.blocks.joined(separator: ", ").nilIfEmpty ?? "—")
    ]
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
      return Color.accentColor.opacity(0.15)
    }
    if ticketId == hoveredTicketId {
      return Color.white.opacity(0.06)
    }
    return Color.clear
  }

  private func refreshTickets() async {
    isLoading = true
    errorMessage = nil
    loadNotice = nil
    do {
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
    } catch {
      errorMessage = error.localizedDescription
    }
    isLoading = false
  }

  private func loadTicketDetail() async {
    guard let selectedTicketId else {
      ticketDetail = nil
      return
    }
    isDetailLoading = true
    detailErrorMessage = nil
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
      self.selectedTicketId = filtered.first?.ticketId
    } else if selectedTicketId == nil {
      selectedTicketId = filtered.first?.ticketId
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
      let isHovered = hoveredSection == status
      DisclosureGroup(
        isExpanded: Binding(
          get: { expandedSections.contains(status) },
          set: { isExpanded in
            if isExpanded {
              expandedSections.insert(status)
            } else {
              expandedSections.remove(status)
            }
          }
        )
      ) {
        VStack(alignment: .leading, spacing: 8) {
          ForEach(items) { ticket in
            ticketRow(ticket)
          }
        }
        .padding(.top, 6)
      } label: {
        HStack(spacing: 8) {
          Circle()
            .fill(status.color)
            .frame(width: 8, height: 8)
          Text(status.label)
            .font(.mono(.caption, weight: .semibold))
          Text("\(items.count)")
            .font(.mono(.caption2))
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(isHovered ? Color.white.opacity(0.06) : .clear)
        )
        .contentShape(Rectangle())
        .onHover { hovering in
          hoveredSection = hovering ? status : nil
        }
        .animation(.easeInOut(duration: 0.12), value: isHovered)
      }
      .disclosureGroupStyle(.automatic)
    }
  }

  private func inspectorGroup(title: String, rows: [DetailRowItem]) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title)
        .font(.mono(.caption, weight: .semibold))
        .foregroundStyle(.secondary)
      DetailRows(rows: rows, labelWidth: 70)
    }
  }

  private func inspectorDateRows(for ticket: TicketSummary) -> [DetailRowItem] {
    [
      DetailRowItem(label: "Created", value: ticket.createdAt),
      DetailRowItem(label: "Updated", value: ticket.updatedAt)
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

  private func filterPill(_ filter: TicketFilter) -> some View {
    let isSelected = selectedFilter == filter
    return FilterPillButton(
      label: filter.label,
      count: filter.count(in: tickets),
      isSelected: isSelected,
      onTap: { selectedFilter = filter }
    )
  }
}

private struct FilterPillButton: View {
  let label: String
  let count: Int
  let isSelected: Bool
  let onTap: () -> Void

  @State private var isHovered = false

  var body: some View {
    Button {
      onTap()
    } label: {
      HStack(spacing: 6) {
        Text(label)
          .font(.mono(.caption, weight: .semibold))
        Text("\(count)")
          .font(.mono(.caption2))
          .foregroundStyle(.secondary)
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .background(
        Capsule(style: .continuous)
          .fill(isSelected ? Color.accentColor.opacity(0.15) : isHovered ? Color.white.opacity(0.06) : Color.secondary.opacity(0.1))
      )
    }
    .buttonStyle(.plain)
    .onHover { hovering in
      isHovered = hovering
    }
    .animation(.easeInOut(duration: 0.12), value: isHovered)
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
      return .secondary
    case .inProgress:
      return .blue
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
