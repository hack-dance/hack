import AppKit
import SwiftUI

import HackCLIService
import HackDesktopModels

private enum ProjectSidebarItem: String, CaseIterable, Identifiable {
  case services
  case lifecycle
  case branches
  case sessions

  var id: String { rawValue }

  var title: String {
    switch self {
    case .services:
      return "Services"
    case .lifecycle:
      return "Lifecycle"
    case .branches:
      return "Branches"
    case .sessions:
      return "Sessions"
    }
  }

  var icon: String {
    switch self {
    case .services:
      return "shippingbox"
    case .lifecycle:
      return "bolt.horizontal"
    case .branches:
      return "arrow.triangle.branch"
    case .sessions:
      return "rectangle.3.group.bubble.left"
    }
  }
}

struct ProjectDetailView: View {
  @Environment(DashboardModel.self) private var model
  @Environment(\.openURL) private var openURL
  @Environment(\.colorScheme) private var colorScheme
  @AppStorage("hackDesktop.preferences.defaultTerminal") private var preferredExternalTerminalRaw = TerminalIntegration.ExternalTerminalApp.terminal.rawValue
  @AppStorage("hackDesktop.sessions.preferredExternalTerminal") private var legacyPreferredExternalTerminalRaw = TerminalIntegration.ExternalTerminalApp.terminal.rawValue
  @AppStorage("hackDesktop.preferences.defaultIDE") private var preferredEditorRaw = EditorIntegration.EditorApp.cursor.rawValue
  @AppStorage("hackDesktop.preferences.defaultCodingAgent") private var preferredCodingAgentRaw = CodingAgentIntegration.AgentApp.codex.rawValue
  @AppStorage("hackDesktop.preferences.defaultCodingAgentBinaryPath") private var preferredCodingAgentBinaryPathRaw = ""

  let project: ProjectSummary
  @State private var showOverviewSidebar = true
  @State private var selectedSidebarItem: ProjectSidebarItem = .services
  @State private var selectedService: String? = nil
  @State private var hoveredService: String? = nil
  @State private var hoveredSidebarItem: ProjectSidebarItem? = nil
  @State private var showInfoPanel = false
  @State private var expandedBranches: Set<String> = []
  @State private var showAddBranchSheet = false
  @State private var newBranchName = ""
  @State private var newBranchNote = ""

  var body: some View {
    @Bindable var model = model
    VStack(alignment: .leading, spacing: 0) {
      projectPageHeader
      projectSplitLayout
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
    .onAppear {
      ensureSelectedTab()
      syncSidebarSelectionFromTab()
      ensureSidebarSelection()
      selectedService = nil
    }
    .onChange(of: project.id) { _, _ in
      ensureSelectedTab()
      syncSidebarSelectionFromTab()
      ensureSidebarSelection()
      selectedService = nil
    }
    .onChange(of: model.selectedProjectTab) { _, _ in
      ensureSelectedTab()
      syncSidebarSelectionFromTab()
      ensureSidebarSelection()
    }
    .onChange(of: lifecycleSummary.hasEntries) { _, _ in
      ensureSidebarSelection()
    }
    .onChange(of: project.supportsTickets) { _, _ in
      ensureSidebarSelection()
    }
    .onChange(of: project.kind) { _, _ in
      ensureSidebarSelection()
    }
    .onReceive(NotificationCenter.default.publisher(for: .hackProjectNavigationRequested)) { notification in
      guard
        let userInfo = notification.userInfo,
        let requestedProjectId = userInfo[ProjectNavigationRequest.projectIdKey] as? String,
        requestedProjectId == project.id
      else {
        return
      }
      if let requestedTab = userInfo[ProjectNavigationRequest.tabKey] as? String,
         let tab = ProjectTab(rawValue: requestedTab) {
        model.selectedProjectTab = tab
      }
      if let requestedSidebar = userInfo[ProjectNavigationRequest.sidebarKey] as? String,
         let item = ProjectSidebarItem(rawValue: requestedSidebar) {
        selectedSidebarItem = item
      }
      ensureSidebarSelection()
    }
    .sheet(isPresented: $showAddBranchSheet) {
      addBranchSheet
    }
  }

  private var projectPageHeader: some View {
    VStack(alignment: .leading, spacing: 12) {
      headerBreadcrumb

      HStack(alignment: .top, spacing: 12) {
        VStack(alignment: .leading, spacing: 6) {
          HStack(spacing: 8) {
            Image(systemName: project.isRuntimeConfigured ? "cube.transparent" : "puzzlepiece")
              .font(.mono(.subheadline, weight: .semibold))
              .foregroundStyle(.secondary)
            Text(project.name)
              .font(.mono(.headline, weight: .semibold))
              .lineLimit(1)
              .truncationMode(.tail)
            RuntimeStatusBadge(status: runtimeStatus, runtimeHealthy: runtimeHealthy)
          }
          if let host = projectHost {
            Button {
              openServiceHost(host)
            } label: {
              Label(host, systemImage: "lock.shield")
                .font(.mono(.caption))
                .lineLimit(1)
                .truncationMode(.middle)
            }
            .buttonStyle(.plain)
            .linkHover()
          }
        }
        Spacer(minLength: 8)
        projectHeaderActionsMenu
      }
    }
    .padding(.horizontal, 24)
    .padding(.top, 12)
    .padding(.bottom, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(projectHeaderShape.fill(projectHeaderBackground))
    .overlay(alignment: .bottom) {
      Rectangle()
        .fill(projectHeaderStrokeColor)
        .frame(height: 1)
    }
    .clipShape(projectHeaderShape)
  }

  private var headerBreadcrumb: some View {
    HStack(spacing: 6) {
      Text(project.name)
        .font(.mono(.caption, weight: .semibold))
        .foregroundStyle(.primary)
      Image(systemName: "chevron.right")
        .font(.mono(.caption2, weight: .semibold))
        .foregroundStyle(.secondary)
      Text(sidebarBreadcrumbLabel)
        .font(.mono(.caption, weight: .medium))
        .foregroundStyle(.secondary)
    }
    .lineLimit(1)
    .truncationMode(.tail)
  }

  private var projectHeaderActionsMenu: some View {
    Menu {
      if isProjectLifecycleBusy {
        Label(projectLifecycleLabel, systemImage: "hourglass")
          .foregroundStyle(.secondary)
      } else {
        if canStart {
          Button {
            Task { await model.startProject(project) }
          } label: {
            Label("Start", systemImage: "play.fill")
          }
        }
        if canStop {
          Button {
            Task { await model.stopProject(project) }
          } label: {
            Label("Stop", systemImage: "stop.fill")
          }
        }
      }

      if let path = projectOpenPath {
        Divider()

        Menu("Open in IDE") {
          Button {
            openProjectInEditor(preferredEditor)
          } label: {
            Label("Open in \(preferredEditor.displayName)", systemImage: "checkmark.circle.fill")
          }

          Divider()

          ForEach(availableEditors, id: \.rawValue) { editor in
            Button {
              preferredEditorRaw = editor.rawValue
              openProjectInEditor(editor)
            } label: {
              Label(
                editor.displayName,
                systemImage: editor == preferredEditor ? "checkmark.circle.fill" : "circle"
              )
            }
          }
        }

        Menu("Open in Agent") {
          Button {
            openProjectInCodingAgent(preferredCodingAgent, projectPath: path)
          } label: {
            Label(
              "Open in \(preferredCodingAgent.displayName)",
              systemImage: "checkmark.circle.fill"
            )
          }

          Divider()

          ForEach(availableCodingAgents, id: \.rawValue) { agent in
            Button {
              preferredCodingAgentRaw = agent.rawValue
              openProjectInCodingAgent(agent, projectPath: path)
            } label: {
              Label(
                agent.displayName,
                systemImage: agent == preferredCodingAgent ? "checkmark.circle.fill" : "circle"
              )
            }
          }

          Divider()

          Button("Print init prompt") {
            openTerminal(
              kind: .shell,
              command: "hack agent init --path \(shellQuote(path)) --client print",
              title: "\(project.name) init prompt"
            )
          }
        }

        Button("Reveal in Finder") {
          NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: path)
        }
      }

      if !sessionEntries.isEmpty {
        Divider()

        Menu("Open session") {
          if sessionEntries.count == 1, let session = sessionEntries.first {
            sessionOpenMenuItems(for: session)
          } else {
            ForEach(sessionEntries, id: \.id) { session in
              Menu(session.name) {
                sessionOpenMenuItems(for: session)
              }
            }
          }
        }

        Button("Open sessions view") {
          selectSidebarItem(.sessions)
        }
      }
    } label: {
      Image(systemName: overflowActionsSymbolName)
        .font(.mono(.subheadline, weight: .semibold))
        .frame(width: 24, height: 24)
    }
    .buttonStyle(PressableCircleButtonStyle())
    .help("Project actions")
    .accessibilityLabel("Project actions")
  }

  /// Returns a conservative overflow glyph available across supported macOS symbol sets.
  private var overflowActionsSymbolName: String {
    return "ellipsis"
  }

  private var projectSplitLayout: some View {
    HStack(spacing: 0) {
      projectNavigationSidebar
      Divider()
        .opacity(0.2)
      tabContent
        .id(effectiveTab)
        .transition(.opacity.combined(with: .move(edge: .trailing)))
        .animation(.easeInOut(duration: 0.2), value: effectiveTab)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(
          Rectangle()
            .fill(projectDetailFillColor)
            .overlay(
              Rectangle()
                .fill(projectDetailTintColor)
            )
        )
    }
  }

  private var projectNavigationSidebar: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        sectionedSidebarNavigation
        Divider()
          .opacity(0.2)
        sidebarTerminalActions
        Divider()
          .opacity(0.2)
        sidebarProjectActions
      }
      .padding(.vertical, 12)
      .padding(.horizontal, 10)
    }
    .frame(minWidth: 220, idealWidth: 240, maxWidth: 260, maxHeight: .infinity, alignment: .topLeading)
    .background(
      Rectangle()
        .fill(projectSidebarFillColor)
        .overlay(
          Rectangle()
            .fill(projectSidebarTintColor)
        )
    )
  }

  private var sectionedSidebarNavigation: some View {
    VStack(alignment: .leading, spacing: 16) {
      sidebarSectionHeader("Project")
      VStack(alignment: .leading, spacing: 6) {
        ForEach(overviewSidebarItems, id: \.id) { item in
          sidebarNavigationButton(item)
        }
      }

      if !workflowSidebarItems.isEmpty {
        sidebarSectionHeader("Workflows")
        VStack(alignment: .leading, spacing: 6) {
          ForEach(workflowSidebarItems, id: \.id) { item in
            sidebarNavigationButton(item)
          }
        }
      }
    }
  }

  private var sidebarTerminalActions: some View {
    VStack(alignment: .leading, spacing: 8) {
      sidebarSectionHeader("Terminal")
      sidebarActionButton(
        title: "Logs drawer",
        icon: "text.alignleft"
      ) {
        openTerminal(kind: .logs)
      }
      sidebarActionButton(
        title: "Shell drawer",
        icon: "terminal"
      ) {
        openTerminal(kind: .shell)
      }
    }
  }

  @ViewBuilder
  private var sidebarProjectActions: some View {
    VStack(alignment: .leading, spacing: 8) {
      sidebarSectionHeader("Lifecycle")
      if isProjectLifecycleBusy {
        HStack(spacing: 8) {
          ProgressView()
            .controlSize(.small)
          Text(projectLifecycleLabel)
            .font(.mono(.caption, weight: .semibold))
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
      } else {
        if canStart {
          sidebarActionButton(title: "Start project", icon: "play.fill") {
            Task { await model.startProject(project) }
          }
        }
        if canStop {
          sidebarActionButton(title: "Stop project", icon: "stop.fill") {
            Task { await model.stopProject(project) }
          }
        }
      }
    }
  }

  private func sidebarSectionHeader(_ title: String) -> some View {
    Text(title)
      .font(.system(size: 11, weight: .semibold))
      .foregroundStyle(.secondary)
      .textCase(.uppercase)
  }

  private func sidebarNavigationButton(_ item: ProjectSidebarItem) -> some View {
    let selected = item == selectedSidebarItem
    return Button {
      selectSidebarItem(item)
    } label: {
      HStack(spacing: 8) {
        Image(systemName: item.icon)
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(selected ? Color.accentColor : Color.secondary)
          .frame(width: 14, alignment: .center)
        Text(item.title)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(selected ? .primary : .secondary)
        Spacer(minLength: 6)
        if let count = sidebarItemCountLabel(item) {
          Text(count)
            .font(.system(size: 11, weight: .semibold, design: .monospaced))
            .foregroundStyle(selected ? .primary : .tertiary)
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: 9, style: .continuous)
          .fill(selected ? Color.accentColor.opacity(0.14) : hoveredSidebarItem == item ? Color.primary.opacity(colorScheme == .dark ? 0.06 : 0.04) : .clear)
      )
    }
    .buttonStyle(.plain)
    .onHover { hovering in
      hoveredSidebarItem = hovering ? item : nil
    }
  }

  private func sidebarActionButton(
    title: String,
    icon: String,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      HStack(spacing: 8) {
        Image(systemName: icon)
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(.secondary)
          .frame(width: 14, alignment: .center)
        Text(title)
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(.secondary)
        Spacer(minLength: 6)
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .buttonStyle(.plain)
  }

  @ViewBuilder
  private var tabContent: some View {
    switch effectiveTab {
    case .overview:
      projectOverviewContent
    case .branches:
      branchesContent
    case .sessions:
      sessionsContent
    case .logs:
      terminalMovedCard(kind: .logs)
    case .shell:
      terminalMovedCard(kind: .shell)
    }
  }

  @ViewBuilder
  private var projectOverviewContent: some View {
    switch selectedSidebarItem {
    case .services:
      servicesContent
    case .lifecycle:
      lifecycleContent
    case .branches, .sessions:
      servicesContent
    }
  }

  private func terminalMovedCard(kind: TerminalDrawerModel.Kind) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      ContentUnavailableView(
        kind == .logs ? "Logs moved to Terminal Drawer" : "Shell moved to Terminal Drawer",
        systemImage: kind == .logs ? "text.alignleft" : "terminal"
      )
      Button(kind == .logs ? "Open Logs" : "Open Shell") {
        openTerminal(kind: kind)
      }
      .adaptiveToolbarButton()
    }
    .padding(24)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  private var servicesContent: some View {
    ProjectServicesView(
      showOverviewSidebar: showOverviewSidebar,
      hasSelection: selectedService != nil
    ) {
      servicesSection
    } detailPanel: {
      serviceDetailPanel
    }
  }

  private var lifecycleContent: some View {
    ProjectLifecycleView(hasEntries: lifecycleSummary.hasEntries) {
      lifecycleSection
    }
  }

  private var runtimeNotConfiguredCard: some View {
    GlassCard {
      VStack(alignment: .leading, spacing: 12) {
        HStack(spacing: 10) {
          Image(systemName: "info.circle.fill")
            .foregroundStyle(.blue)
            .font(.mono(.title3))
          Text("Runtime not configured")
            .font(.mono(.headline))
        }
        Text("This project uses extensions but doesn't have a runtime configuration. Runtime features like start/stop, logs, and shell access require a hack.json or docker-compose setup.")
          .font(.mono(.subheadline))
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        if let features = project.featureSummary {
          HStack(spacing: 6) {
            Text("Available:")
              .font(.mono(.caption))
              .foregroundStyle(.secondary)
            Text(features)
              .font(.mono(.caption, weight: .medium))
              .foregroundStyle(.primary)
          }
          .padding(.top, 4)
        }
      }
    }
  }

  private var servicesSection: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 10) {
        Image(systemName: "shippingbox")
          .foregroundStyle(.secondary)
        Text("Services")
          .font(.mono(.headline, weight: .semibold))
        Spacer()
      }
      .padding(.horizontal, 24)
      .padding(.top, 18)
      .padding(.bottom, 14)
      .overlay(alignment: .bottom) {
        Rectangle()
          .fill(Color.white.opacity(0.08))
          .frame(height: 1)
      }
      let services = serviceEntries
      if !services.isEmpty {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(services) { service in
            serviceRow(service)
          }
        }
      } else {
        Text("No services registered.")
          .font(.mono(.subheadline))
          .foregroundStyle(.secondary)
          .padding(.horizontal, 24)
          .padding(.vertical, 18)
      }
    }
  }

  /// Renders one service row with contiguous list styling and subtle selected/hover states.
  private func serviceRow(_ entry: ServiceListEntry) -> some View {
    let service = entry.name
    let status = entry.status
    let isHovered = hoveredService == service
    let isSelected = selectedService == service

    return VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 10) {
        Circle()
          .fill(status.color)
          .frame(width: 9, height: 9)

        Text(service)
          .font(.mono(.subheadline, weight: .semibold))
          .foregroundStyle(.primary)

        Spacer(minLength: 12)

        if let urlLabel = status.urlLabel {
          Button {
            openServiceHost(urlLabel)
          } label: {
            Text(urlLabel)
              .font(.mono(.caption))
          }
          .buttonStyle(.plain)
          .linkHover()
        }

        Text(status.label)
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
      }

      if let detail = status.detail {
        Text(detail)
          .font(.mono(.caption))
          .foregroundStyle(.tertiary)
          .lineLimit(2)
      }
    }
    .padding(.horizontal, 24)
    .padding(.vertical, 11)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      Rectangle()
        .fill(isSelected ? Color.accentColor.opacity(0.16) : isHovered ? Color.white.opacity(0.045) : .clear)
    )
    .overlay(alignment: .bottom) {
      Rectangle()
        .fill(Color.white.opacity(0.07))
        .frame(height: 1)
    }
    .contentShape(Rectangle())
    .onTapGesture {
      withAnimation(.easeInOut(duration: 0.16)) {
        selectedService = service
        showOverviewSidebar = true
      }
    }
    .onHover { hovering in
      hoveredService = hovering ? service : nil
    }
  }

  private var branchesContent: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 20) {
        branchesSection
      }
      .padding(20)
      .frame(maxWidth: .infinity, alignment: .topLeading)
    }
  }

  private var sessionsContent: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 20) {
        sessionsSection
      }
      .padding(20)
      .frame(maxWidth: .infinity, alignment: .topLeading)
    }
  }

  private var branchesSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        Image(systemName: "arrow.triangle.branch")
          .foregroundStyle(.secondary)
        Text("Branch Instances")
          .font(.mono(.headline, weight: .semibold))
        Spacer()
        Button {
          showAddBranchSheet = true
        } label: {
          Label("New branch", systemImage: "plus")
            .font(.mono(.caption))
        }
        .buttonStyle(PressableIconButtonStyle())
      }
      .overlay(alignment: .bottom) {
        Rectangle()
          .fill(Color.white.opacity(0.08))
          .frame(height: 1)
          .offset(y: 8)
      }

      if branchEntries.isEmpty {
        Text("No branch instances found.")
          .font(.mono(.subheadline))
          .foregroundStyle(.secondary)
      } else {
        LazyVStack(alignment: .leading, spacing: 10) {
          ForEach(branchEntries, id: \.branch) { entry in
            branchRow(entry)
            Divider()
              .opacity(0.2)
          }
        }
      }
    }
  }

  private var sessionsSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        Image(systemName: "rectangle.3.group.bubble.left")
          .foregroundStyle(.secondary)
        Text("Sessions")
          .font(.mono(.headline, weight: .semibold))
        Spacer()
        Button {
          Task { await model.startSession(for: project) }
        } label: {
          Label("Start session", systemImage: "plus")
            .font(.mono(.caption))
        }
        .buttonStyle(PressableIconButtonStyle())
      }
      .overlay(alignment: .bottom) {
        Rectangle()
          .fill(Color.white.opacity(0.08))
          .frame(height: 1)
          .offset(y: 8)
      }

      if sessionEntries.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          Text("No active sessions found for this project.")
            .font(.mono(.subheadline))
            .foregroundStyle(.secondary)
          Text("Run `hack session start \(project.name)` in a terminal to create one.")
            .font(.mono(.caption))
            .foregroundStyle(.tertiary)
        }
      } else {
        LazyVStack(alignment: .leading, spacing: 10) {
          ForEach(sessionEntries, id: \.id) { session in
            sessionRow(session)
            Divider()
              .opacity(0.2)
          }
        }
      }
    }
  }

  private var addBranchSheet: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Create Branch Instance")
        .font(.mono(.headline, weight: .semibold))

      TextField("Branch name (e.g. fix-seat-geometry)", text: $newBranchName)
        .textFieldStyle(.roundedBorder)

      TextField("Optional note", text: $newBranchNote)
        .textFieldStyle(.roundedBorder)

      HStack {
        Spacer()
        Button("Cancel") {
          resetBranchDraft()
          showAddBranchSheet = false
        }
        Button("Create & Start") {
          let branch = newBranchName.trimmingCharacters(in: .whitespacesAndNewlines)
          guard !branch.isEmpty else { return }
          let note = newBranchNote.trimmingCharacters(in: .whitespacesAndNewlines)
          Task {
            let didAdd = await model.addBranch(
              for: project,
              name: branch,
              note: note.isEmpty ? nil : note
            )
            if didAdd {
              await model.startBranch(for: project, branch: branch)
            }
          }
          resetBranchDraft()
          showAddBranchSheet = false
        }
        .keyboardShortcut(.defaultAction)
        .disabled(newBranchName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    .padding(18)
    .frame(minWidth: 420)
  }

  private func resetBranchDraft() {
    newBranchName = ""
    newBranchNote = ""
  }

  private var branchEntries: [BranchRuntime] {
    (project.branchRuntime ?? []).sorted { $0.branch.localizedCaseInsensitiveCompare($1.branch) == .orderedAscending }
  }

  private var sessionEntries: [ProjectSessionSummary] {
    (project.sessions ?? []).sorted { lhs, rhs in
      if lhs.source != rhs.source {
        return lhs.source == .hack
      }
      return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
    }
  }

  private var runningServiceCount: Int {
    serviceEntries.reduce(into: 0) { count, entry in
      let state = entry.status.runState
      if state == .running || state == .partial {
        count += 1
      }
    }
  }

  private var projectHost: String? {
    let host = project.devHost?.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let host, !host.isEmpty else { return nil }
    return host
  }

  private func branchRow(_ entry: BranchRuntime) -> some View {
    let status = branchStatus(for: entry.runtime)
    return VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 10) {
        Button {
          toggleBranchExpansion(entry.branch)
        } label: {
          Image(systemName: expandedBranches.contains(entry.branch) ? "chevron.down" : "chevron.right")
            .font(.mono(.caption, weight: .semibold))
            .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)

        Text(entry.branch)
          .font(.mono(.subheadline, weight: .semibold))

        Spacer()
        Text(status.label)
          .font(.mono(.caption))
          .foregroundStyle(status.color)
      }

      HStack(spacing: 10) {
        Text("\(status.runningServices)/\(status.totalServices) services running")
          .font(.mono(.caption2))
          .foregroundStyle(.secondary)
        if let branchHost = branchHost(for: entry.branch) {
          Button {
            openServiceHost(branchHost)
          } label: {
            Text(branchHost)
              .font(.mono(.caption2))
          }
          .buttonStyle(.plain)
          .linkHover()
        }
        Spacer()
      }

      HStack(spacing: 8) {
        if status.runningServices > 0 {
          Button("Stop") {
            Task { await model.stopBranch(for: project, branch: entry.branch) }
          }
          .buttonStyle(PressableIconButtonStyle())
        } else {
          Button("Start") {
            Task { await model.startBranch(for: project, branch: entry.branch) }
          }
          .buttonStyle(PressableIconButtonStyle())
        }

        Button("Logs") {
          model.showLogs(for: project, branch: entry.branch)
        }
        .buttonStyle(PressableIconButtonStyle())

        Button("Remove Alias") {
          Task { await model.removeBranch(for: project, name: entry.branch) }
        }
        .buttonStyle(PressableIconButtonStyle())
      }

      if expandedBranches.contains(entry.branch) {
        VStack(alignment: .leading, spacing: 6) {
          ForEach(entry.runtime.services.sorted(by: { $0.service < $1.service }), id: \.service) { service in
            let running = service.containers.filter { $0.state.lowercased() == "running" }.count
            Text("\(service.service): \(running)/\(service.containers.count) running")
              .font(.mono(.caption2))
              .foregroundStyle(.tertiary)
          }
        }
        .padding(.top, 2)
      }
    }
    .padding(.vertical, 8)
    .padding(.horizontal, 4)
  }

  private func sessionRow(_ session: ProjectSessionSummary) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 10) {
        Text(session.name)
          .font(.mono(.subheadline, weight: .semibold))
        Spacer()
        BadgePill(label: session.backend.rawValue, tint: .secondary)
        BadgePill(label: session.source == .hack ? "hack" : "external", tint: .secondary)
        BadgePill(label: session.attached ? "attached" : "detached", tint: session.attached ? .green : .orange)
      }

      HStack(spacing: 10) {
        if let path = session.path, !path.isEmpty {
          Text(path)
            .font(.mono(.caption2))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
        } else {
          Text("Path unavailable")
            .font(.mono(.caption2))
            .foregroundStyle(.tertiary)
        }
        Spacer()
        if let windows = session.windows {
          Text("\(windows) window\(windows == 1 ? "" : "s")")
            .font(.mono(.caption2))
            .foregroundStyle(.secondary)
        }
      }

      HStack(spacing: 8) {
        Button("Attach (Drawer)") {
          openTerminal(
            kind: .shell,
            command: attachCommand(for: session),
            title: "\(session.name) (attached)"
          )
        }
        .buttonStyle(PressableIconButtonStyle())

        Menu {
          ForEach(installedExternalTerminalApps, id: \.self) { terminalApp in
            Button {
              preferredExternalTerminalRaw = terminalApp.rawValue
              legacyPreferredExternalTerminalRaw = terminalApp.rawValue
              openSession(session, terminalApp: terminalApp)
            } label: {
              Label(
                "Open in \(terminalApp.displayName)",
                systemImage: terminalApp == preferredExternalTerminal ? "checkmark.circle.fill" : "circle"
              )
            }
          }
        } label: {
          Label("Open In", systemImage: "arrow.up.right.square")
        }
        .buttonStyle(PressableIconButtonStyle())

        Button("Stop") {
          Task { await model.stopSession(name: session.name) }
        }
        .buttonStyle(PressableIconButtonStyle())
      }
    }
    .padding(.vertical, 8)
    .padding(.horizontal, 4)
  }

  private func toggleBranchExpansion(_ branch: String) {
    if expandedBranches.contains(branch) {
      expandedBranches.remove(branch)
    } else {
      expandedBranches.insert(branch)
    }
  }

  private func branchHost(for branch: String) -> String? {
    guard let host = project.devHost, !host.isEmpty else { return nil }
    return "\(branch).\(host)"
  }

  private func branchStatus(for runtime: RuntimeProject) -> (
    label: String,
    color: Color,
    runningServices: Int,
    totalServices: Int
  ) {
    let totalServices = runtime.services.count
    let runningServices = runtime.services.reduce(into: 0) { count, service in
      if service.containers.contains(where: { $0.state.lowercased() == "running" }) {
        count += 1
      }
    }

    if totalServices == 0 {
      return ("No services", .secondary, runningServices, totalServices)
    }
    if runningServices == 0 {
      return ("Stopped", .orange, runningServices, totalServices)
    }
    if runningServices == totalServices {
      return ("Running", .green, runningServices, totalServices)
    }
    return ("Partial", .orange, runningServices, totalServices)
  }

  private var featuresList: [String] {
    project.features ?? project.extensionsEnabled ?? []
  }


  private struct LifecycleSummaryCounts {
    let startupHookCount: Int
    let shutdownHookCount: Int
    let processCount: Int
    let persistentHookCount: Int

    var persistentCount: Int {
      persistentHookCount + processCount
    }

    var hasEntries: Bool {
      startupHookCount > 0 || shutdownHookCount > 0 || processCount > 0
    }
  }

  private var lifecycleSummary: LifecycleSummaryCounts {
    let lifecycle = project.lifecycle
    let persistentHooks = lifecycleHooks.filter { $0.command.persistent == true }
    return LifecycleSummaryCounts(
      startupHookCount: (lifecycle?.upBefore.count ?? 0) + (lifecycle?.upAfter.count ?? 0),
      shutdownHookCount: (lifecycle?.downBefore.count ?? 0) + (lifecycle?.downAfter.count ?? 0),
      processCount: lifecycle?.processes.count ?? 0,
      persistentHookCount: persistentHooks.count
    )
  }

  private var lifecycleHooks: [(phase: String, command: ProjectLifecycleCommandSummary)] {
    guard let lifecycle = project.lifecycle else { return [] }
    return [
      lifecycle.upBefore.map { (phase: "up.before", command: $0) },
      lifecycle.upAfter.map { (phase: "up.after", command: $0) },
      lifecycle.downBefore.map { (phase: "down.before", command: $0) },
      lifecycle.downAfter.map { (phase: "down.after", command: $0) }
    ].flatMap { $0 }
  }

  private var lifecycleSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        Image(systemName: "bolt.horizontal")
          .foregroundStyle(.secondary)
        Text("Startup & Lifecycle")
          .font(.mono(.headline, weight: .semibold))
        Spacer()
        Button("All lifecycle logs") {
          openLifecycleLogs(service: nil, title: "lifecycle logs")
        }
        .buttonStyle(PressableIconButtonStyle())
      }
      .overlay(alignment: .bottom) {
        Rectangle()
          .fill(Color.white.opacity(0.08))
          .frame(height: 1)
          .offset(y: 8)
      }

      HStack(spacing: 8) {
        BadgePill(label: "\(lifecycleSummary.startupHookCount) startup hooks", tint: .secondary)
        BadgePill(label: "\(lifecycleSummary.shutdownHookCount) shutdown hooks", tint: .secondary)
        BadgePill(label: "\(lifecycleSummary.persistentCount) persistent", tint: .secondary)
      }

      if let lifecycle = project.lifecycle, !lifecycle.processes.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          sectionHeader("Persistent processes")
          ForEach(Array(lifecycle.processes.enumerated()), id: \.offset) { _, process in
            lifecycleProcessRow(process)
            Divider()
              .opacity(0.2)
          }
        }
      }

      if !lifecycleHooks.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          sectionHeader("Hooks")
          ForEach(Array(lifecycleHooks.enumerated()), id: \.offset) { _, entry in
            lifecycleHookRow(phase: entry.phase, command: entry.command)
            Divider()
              .opacity(0.2)
          }
        }
      }
    }
  }

  private func lifecycleProcessRow(_ process: ProjectLifecycleProcessSummary) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 8) {
        Text(process.name)
          .font(.mono(.caption, weight: .semibold))
        BadgePill(label: "persistent", tint: .green)
        BadgePill(label: process.service, tint: .secondary)
        Spacer()
        Button("Tail logs") {
          openLifecycleLogs(service: process.service, title: "\(process.name) logs")
        }
        .buttonStyle(PressableIconButtonStyle())
      }
      Text(process.command)
        .font(.mono(.caption2))
        .foregroundStyle(.secondary)
        .textSelection(.enabled)
      if let cwd = process.cwd, !cwd.isEmpty {
        Text("cwd: \(cwd)")
          .font(.mono(.caption2))
          .foregroundStyle(.tertiary)
          .textSelection(.enabled)
      }
    }
    .padding(.vertical, 4)
  }

  private func lifecycleHookRow(
    phase: String,
    command: ProjectLifecycleCommandSummary
  ) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 8) {
        Text(command.name ?? command.service)
          .font(.mono(.caption, weight: .semibold))
        BadgePill(label: phase, tint: .secondary)
        if command.persistent == true {
          BadgePill(label: "persistent", tint: .green)
        }
        Spacer()
        Button("Show output") {
          openLifecycleLogs(service: command.service, title: "\(command.service) output")
        }
        .buttonStyle(PressableIconButtonStyle())
      }
      Text(command.command)
        .font(.mono(.caption2))
        .foregroundStyle(.secondary)
        .textSelection(.enabled)
      if let cwd = command.cwd, !cwd.isEmpty {
        Text("cwd: \(cwd)")
          .font(.mono(.caption2))
          .foregroundStyle(.tertiary)
          .textSelection(.enabled)
      }
    }
    .padding(.vertical, 4)
  }

  private var infoSection: some View {
    VStack(alignment: .leading, spacing: 16) {
      if !overviewRows.isEmpty {
        sectionHeader("Meta")
        DetailRows(rows: overviewRows)
      }
      if !pathRows.isEmpty {
        sectionHeader("Paths")
        DetailRows(rows: pathRows)
      }
      if !featuresList.isEmpty {
        sectionHeader("Features")
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), spacing: 8)], alignment: .leading, spacing: 8) {
          ForEach(featuresList, id: \.self) { feature in
            BadgePill(label: feature, tint: .secondary)
          }
        }
      }
    }
  }

  private func sectionHeader(_ title: String) -> some View {
    Text(title)
      .instrumentLabel()
  }

  private var serviceDetailPanel: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack {
        Text("Service details")
          .font(.mono(.title3, weight: .semibold))
        Spacer()
        Button("Show all") {
          withAnimation(.easeInOut(duration: 0.2)) {
            self.selectedService = nil
          }
        }
        .font(.mono(.caption))
        .buttonStyle(PressableIconButtonStyle())
      }
      if let selectedService {
        serviceDetailCard(for: selectedService)
      }
    }
    .padding(.horizontal, 20)
    .padding(.vertical, 18)
  }

  private var overviewRows: [DetailRowItem] {
    var rows: [DetailRowItem] = []
    if let devHost = project.devHost {
      rows.append(DetailRowItem(label: "Dev host", value: devHost))
    }
    if let featureSummary = project.featureSummary {
      rows.append(DetailRowItem(label: "Features", value: featureSummary))
    }
    if project.isRuntimeConfigured {
      rows.append(DetailRowItem(label: "Runtime", value: runtimeStatusValue))
      rows.append(DetailRowItem(label: "Kind", value: project.kind.rawValue))
      rows.append(DetailRowItem(label: "Status", value: project.status.rawValue))
    } else {
      rows.append(DetailRowItem(label: "Runtime", value: "Not configured"))
      rows.append(DetailRowItem(label: "Kind", value: project.kind.rawValue))
    }
    return rows
  }

  private var pathRows: [DetailRowItem] {
    var rows: [DetailRowItem] = []
    if let repoRoot = project.repoRoot {
      rows.append(DetailRowItem(label: "Repo root", value: repoRoot))
    }
    if let projectDir = project.projectDir, projectDir != project.repoRoot {
      rows.append(DetailRowItem(label: "Project dir", value: projectDir))
    }
    return rows
  }

  private var canStart: Bool {
    project.isRuntimeConfigured
      && !isProjectLifecycleBusy
      && (project.status == .stopped || project.status == .unknown || project.status == .unregistered)
  }

  private var canStop: Bool {
    project.isRuntimeConfigured && !isProjectLifecycleBusy && project.status == .running
  }

  private var projectLifecycleAction: ProjectLifecycleAction? {
    model.projectLifecycleActions[project.id]
  }

  private var isProjectLifecycleBusy: Bool {
    projectLifecycleAction != nil
  }

  private var projectLifecycleLabel: String {
    switch projectLifecycleAction {
    case .starting:
      return "Starting…"
    case .stopping:
      return "Stopping…"
    case .none:
      return "Working…"
    }
  }

  private var runtimeStatus: ProjectRuntimeStatus {
    project.runtimeStatus ?? fallbackRuntimeStatus
  }

  private var runtimeHealthy: Bool? {
    model.runtimeOverallOk
  }

  private var runtimeStatusValue: String {
    let base = project.runtimeStatusLabel
    if runtimeHealthy == false, runtimeStatus == .running {
      return "\(base) (degraded)"
    }
    return base
  }

  private enum ServiceRunState {
    case running
    case partial
    case stopped
    case notRunning
  }

  private struct ServiceStatus {
    let runState: ServiceRunState
    let label: String
    let color: Color
    let detail: String?
    let urlLabel: String?
  }

  private struct ServiceListEntry: Identifiable {
    let id: String
    let name: String
    let status: ServiceStatus

    init(name: String, status: ServiceStatus) {
      self.id = name
      self.name = name
      self.status = status
    }
  }

  private var runtimeServicesByName: [String: RuntimeService] {
    guard let runtime = project.runtime else { return [:] }
    return Dictionary(uniqueKeysWithValues: runtime.services.map { ($0.service, $0) })
  }

  private var serviceHostsByName: [String: [String]] {
    project.serviceHosts ?? [:]
  }

  private var serviceEntries: [ServiceListEntry] {
    PerformanceTrace.measure("ProjectDetailView.serviceEntries", thresholdMs: 4) {
      let defined = project.definedServices ?? []
      let runtime = runtimeServicesByName.keys
      let hosts = serviceHostsByName.keys
      let names = Array(Set(defined).union(runtime).union(hosts))

      var statusByName: [String: ServiceStatus] = [:]
      statusByName.reserveCapacity(names.count)
      for name in names {
        statusByName[name] = serviceStatus(for: name)
      }

      let sortedNames = names.sorted { lhs, rhs in
        guard let lhsStatus = statusByName[lhs], let rhsStatus = statusByName[rhs] else {
          return lhs.localizedCaseInsensitiveCompare(rhs) == .orderedAscending
        }
        let lhsRank = serviceSortRank(lhsStatus.runState)
        let rhsRank = serviceSortRank(rhsStatus.runState)
        if lhsRank == rhsRank {
          return lhs.localizedCaseInsensitiveCompare(rhs) == .orderedAscending
        }
        return lhsRank < rhsRank
      }

      return sortedNames.compactMap { name in
        guard let status = statusByName[name] else { return nil }
        return ServiceListEntry(name: name, status: status)
      }
    }
  }

  private func serviceSortRank(_ state: ServiceRunState) -> Int {
    switch state {
    case .running:
      return 0
    case .partial:
      return 1
    case .stopped:
      return 2
    case .notRunning:
      return 3
    }
  }

  private func serviceStatus(for service: String) -> ServiceStatus {
    guard let runtime = runtimeServicesByName[service] else {
      return ServiceStatus(
        runState: .notRunning,
        label: "Not running",
        color: .secondary,
        detail: nil,
        urlLabel: serviceHostLabel(for: service)
      )
    }
    let total = runtime.containers.count
    let running = runtime.containers.filter { $0.state.lowercased() == "running" }.count
    let ports = runtime.containers.first(where: { !$0.ports.isEmpty })?.ports
    let detail = ports?.isEmpty == false ? ports : nil
    if total == 0 {
      return ServiceStatus(
        runState: .notRunning,
        label: "Not running",
        color: .secondary,
        detail: detail,
        urlLabel: serviceHostLabel(for: service)
      )
    }
    if running == total {
      return ServiceStatus(
        runState: .running,
        label: "Running",
        color: .green,
        detail: detail,
        urlLabel: serviceHostLabel(for: service)
      )
    }
    if running > 0 {
      return ServiceStatus(
        runState: .partial,
        label: "\(running)/\(total) running",
        color: .orange,
        detail: detail,
        urlLabel: serviceHostLabel(for: service)
      )
    }
    return ServiceStatus(
      runState: .stopped,
      label: "Stopped",
      color: .orange,
      detail: detail,
      urlLabel: serviceHostLabel(for: service)
    )
  }

  private func serviceHostLabel(for service: String) -> String? {
    if let hosts = serviceHostsByName[service], let first = hosts.first {
      if hosts.count > 1 {
        return "\(first) +\(hosts.count - 1)"
      }
      return first
    }
    guard let host = project.devHost, !host.isEmpty else { return nil }
    return "\(service).\(host)"
  }

  private func serviceDetailCard(for service: String) -> some View {
    let runtime = runtimeServicesByName[service]
    let containers = runtime?.containers ?? []
    let status = serviceStatus(for: service)

    return VStack(alignment: .leading, spacing: 14) {
      VStack(alignment: .leading, spacing: 8) {
        Text(service)
          .font(.mono(.headline, weight: .semibold))

        HStack(spacing: 8) {
          BadgePill(label: status.label, tint: status.color)
          BadgePill(
            label: "\(containers.count) container\(containers.count == 1 ? "" : "s")",
            tint: .secondary
          )
          Spacer()
        }
      }

      HStack(spacing: 8) {
        Spacer()
        Button {
          openLifecycleLogs(service: service, title: "\(service) logs")
        } label: {
          Label("Tail logs", systemImage: "text.alignleft")
        }
        .buttonStyle(PressableIconButtonStyle())
      }

      if let hostLabel = serviceHostLabel(for: service) {
        Button {
          openServiceHost(hostLabel)
        } label: {
          Label(hostLabel, systemImage: "link")
            .font(.mono(.caption))
        }
        .buttonStyle(.plain)
        .linkHover()
      }
      if let hosts = serviceHostsByName[service], hosts.count > 1 {
        VStack(alignment: .leading, spacing: 4) {
          ForEach(hosts, id: \.self) { host in
            Button {
              openServiceHost(host)
            } label: {
              Label(host, systemImage: "link")
                .font(.mono(.caption))
            }
            .buttonStyle(.plain)
            .linkHover()
          }
        }
      }
      if runtime != nil {
        Divider()
          .opacity(0.12)

        Text("Overview")
          .instrumentLabel()

        let runningCount = containers.filter { $0.state.lowercased() == "running" }.count
        DetailRows(rows: [
          DetailRowItem(label: "Containers", value: "\(containers.count)"),
          DetailRowItem(label: "Running", value: "\(runningCount)")
        ])

        Divider()
          .opacity(0.12)

        Text("Containers")
          .instrumentLabel()

        LazyVStack(alignment: .leading, spacing: 12) {
          ForEach(containers, id: \.id) { container in
            VStack(alignment: .leading, spacing: 10) {
              HStack(spacing: 8) {
                Text(container.name)
                  .font(.mono(.subheadline, weight: .semibold))
                Spacer()
                BadgePill(
                  label: container.state.lowercased() == "running" ? "Running" : container.state.capitalized,
                  tint: container.state.lowercased() == "running" ? .green : .orange
                )
              }

              DetailRows(
                rows: containerOverviewRows(container),
                labelWidth: 88
              )

              if let networks = container.networks, !networks.isEmpty {
                metadataDisclosureSection(
                  title: "Networks",
                  rows: networks.map(networkSummary)
                )
              }

              if let mounts = container.mounts, !mounts.isEmpty {
                metadataDisclosureSection(
                  title: "Mounts",
                  rows: mounts.map(mountSummary)
                )
              }

              if let labels = container.labels, !labels.isEmpty {
                metadataDisclosureSection(
                  title: "Labels",
                  rows: sortedLabels(labels).map { "\($0.key)=\($0.value)" }
                )
              }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(
              RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.white.opacity(0.03))
                .overlay(
                  RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(Color.white.opacity(0.07), lineWidth: 1)
                )
            )
          }
        }
      } else {
        Text("No running containers.")
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
      }
    }
  }

  /// Renders dense container metadata (labels, mounts, networks) as collapsible sections
  /// to improve scanability in the details sidebar.
  private func metadataDisclosureSection(
    title: String,
    rows: [String]
  ) -> some View {
    DisclosureGroup {
      VStack(alignment: .leading, spacing: 6) {
        ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
          Text(row)
            .font(.mono(.caption))
            .foregroundStyle(.secondary)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .padding(.top, 6)
    } label: {
      HStack(spacing: 8) {
        Text(title)
          .font(.mono(.caption, weight: .semibold))
          .foregroundStyle(.secondary)
        BadgePill(label: "\(rows.count)", tint: .secondary)
        Spacer()
      }
    }
    .tint(.secondary)
  }

  private func containerOverviewRows(_ container: RuntimeContainer) -> [DetailRowItem] {
    var rows = [
      DetailRowItem(label: "ID", value: shortContainerID(container.id)),
      DetailRowItem(label: "Status", value: container.status),
      DetailRowItem(label: "State", value: container.state)
    ]
    if let image = container.image, !image.isEmpty {
      rows.append(DetailRowItem(label: "Image", value: image))
    }
    if !container.ports.isEmpty {
      rows.append(DetailRowItem(label: "Ports", value: container.ports))
    }
    if let workingDir = container.workingDir, !workingDir.isEmpty {
      rows.append(DetailRowItem(label: "Workdir", value: workingDir))
    }
    return rows
  }

  private func shortContainerID(_ id: String) -> String {
    let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.count > 12 else { return trimmed }
    return String(trimmed.prefix(12))
  }

  private func networkSummary(_ network: RuntimeContainerNetwork) -> String {
    var parts: [String] = [network.name]
    if let ipAddress = network.ipAddress, !ipAddress.isEmpty {
      parts.append(ipAddress)
    }
    if let aliases = network.aliases, !aliases.isEmpty {
      parts.append("aliases: \(aliases.joined(separator: ", "))")
    }
    return parts.joined(separator: " | ")
  }

  private func mountSummary(_ mount: RuntimeContainerMount) -> String {
    var suffix = mount.mode
    if let rw = mount.rw {
      suffix = suffix.isEmpty ? (rw ? "rw" : "ro") : "\(suffix),\(rw ? "rw" : "ro")"
    }
    if suffix.isEmpty {
      return "\(mount.source) -> \(mount.destination)"
    }
    return "\(mount.source) -> \(mount.destination) [\(suffix)]"
  }

  private func sortedLabels(_ labels: [String: String]) -> [(key: String, value: String)] {
    labels
      .map { (key: $0.key, value: $0.value) }
      .sorted { $0.key.localizedCaseInsensitiveCompare($1.key) == .orderedAscending }
  }

  private func openServiceHost(_ host: String) {
    let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    let urlString = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
    if let url = URL(string: urlString) {
      openURL(url)
    }
  }

  private var fallbackRuntimeStatus: ProjectRuntimeStatus {
    switch project.status {
    case .running:
      return .running
    case .stopped:
      return .stopped
    case .missing:
      return .missing
    case .unknown:
      return .unknown
    case .unregistered:
      return .unknown
    }
  }

  private var availableTabs: [ProjectTab] {
    var tabs: [ProjectTab] = [.overview]
    if project.kind == .registered {
      tabs.append(.branches)
      tabs.append(.sessions)
    }
    return tabs
  }

  private var effectiveTab: ProjectTab {
    if availableTabs.contains(model.selectedProjectTab) {
      return model.selectedProjectTab
    }
    return .overview
  }

  private var overviewSidebarItems: [ProjectSidebarItem] {
    var items: [ProjectSidebarItem] = [.services]
    if lifecycleSummary.hasEntries {
      items.append(.lifecycle)
    }
    return items
  }

  private var workflowSidebarItems: [ProjectSidebarItem] {
    var items: [ProjectSidebarItem] = []
    if project.kind == .registered {
      items.append(.branches)
      items.append(.sessions)
    }
    return items
  }

  private var availableSidebarItems: [ProjectSidebarItem] {
    overviewSidebarItems + workflowSidebarItems
  }

  private var sidebarBreadcrumbLabel: String {
    selectedSidebarItem.title
  }

  private func sidebarItemCountLabel(_ item: ProjectSidebarItem) -> String? {
    switch item {
    case .services:
      return "\(serviceEntries.count)"
    case .lifecycle:
      return lifecycleSummary.hasEntries ? "\(lifecycleSummary.persistentCount)" : nil
    case .branches:
      return "\(branchEntries.count)"
    case .sessions:
      return "\(sessionEntries.count)"
    }
  }

  private func ensureSelectedTab() {
    if !availableTabs.contains(model.selectedProjectTab) {
      model.selectedProjectTab = .overview
    }
  }

  private func ensureSidebarSelection() {
    if !availableSidebarItems.contains(selectedSidebarItem) {
      selectedSidebarItem = .services
    }
  }

  private func syncSidebarSelectionFromTab() {
    switch model.selectedProjectTab {
    case .overview:
      if !overviewSidebarItems.contains(selectedSidebarItem) {
        selectedSidebarItem = .services
      }
    case .branches:
      selectedSidebarItem = .branches
    case .sessions:
      selectedSidebarItem = .sessions
    case .logs, .shell:
      if !overviewSidebarItems.contains(selectedSidebarItem) {
        selectedSidebarItem = .services
      }
    }
  }

  private func selectSidebarItem(_ item: ProjectSidebarItem) {
    selectedSidebarItem = item
    switch item {
    case .services:
      model.selectedProjectTab = .overview
    case .lifecycle:
      model.selectedProjectTab = .overview
    case .branches:
      model.selectedProjectTab = .branches
    case .sessions:
      model.selectedProjectTab = .sessions
    }
  }

  private var projectHeaderBackground: some ShapeStyle {
    if colorScheme == .dark {
      return AnyShapeStyle(.regularMaterial)
    }
    return AnyShapeStyle(Color.white.opacity(0.82))
  }

  private var projectHeaderShape: UnevenRoundedRectangle {
    UnevenRoundedRectangle(
      cornerRadii: .init(
        topLeading: 0,
        bottomLeading: 14,
        bottomTrailing: 14,
        topTrailing: 0
      ),
      style: .continuous
    )
  }

  private var projectHeaderStrokeColor: Color {
    colorScheme == .dark ? Color.white.opacity(0.14) : Color.black.opacity(0.08)
  }

  private var projectSidebarFillColor: Color {
    colorScheme == .dark ? Color.black.opacity(0.46) : Color.white.opacity(0.82)
  }

  private var projectSidebarTintColor: Color {
    colorScheme == .dark ? Color.white.opacity(0.025) : Color.white.opacity(0.24)
  }

  private var projectDetailFillColor: Color {
    colorScheme == .dark ? Color.black.opacity(0.34) : Color.white.opacity(0.74)
  }

  private var projectDetailTintColor: Color {
    colorScheme == .dark ? Color.white.opacity(0.025) : Color.white.opacity(0.22)
  }

  @ViewBuilder
  private func sessionOpenMenuItems(for session: ProjectSessionSummary) -> some View {
    ForEach(installedExternalTerminalApps, id: \.self) { terminalApp in
      Button {
        preferredExternalTerminalRaw = terminalApp.rawValue
        legacyPreferredExternalTerminalRaw = terminalApp.rawValue
        openSession(session, terminalApp: terminalApp)
      } label: {
        Label(
          "Open in \(terminalApp.displayName)",
          systemImage: terminalApp == preferredExternalTerminal ? "checkmark.circle.fill" : "circle"
        )
      }
    }
  }

  private func openTerminal(
    kind: TerminalDrawerModel.Kind,
    branch: String? = nil,
    command: String? = nil,
    title: String? = nil
  ) {
    let normalizedBranch = branch?.trimmingCharacters(in: .whitespacesAndNewlines)
    let resolvedBranch = (normalizedBranch?.isEmpty == false) ? normalizedBranch : nil
    let normalizedCommand = command?.trimmingCharacters(in: .whitespacesAndNewlines)
    let resolvedCommand = (normalizedCommand?.isEmpty == false) ? normalizedCommand : nil
    let normalizedTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines)
    let resolvedTitle = (normalizedTitle?.isEmpty == false) ? normalizedTitle : nil
    var userInfo: [String: String] = [
      TerminalOpenRequest.projectIdKey: project.id,
      TerminalOpenRequest.kindKey: kind.rawValue
    ]
    if let resolvedBranch {
      userInfo[TerminalOpenRequest.branchKey] = resolvedBranch
    }
    if let resolvedCommand {
      userInfo[TerminalOpenRequest.commandKey] = resolvedCommand
    }
    if let resolvedTitle {
      userInfo[TerminalOpenRequest.titleKey] = resolvedTitle
    }
    NotificationCenter.default.post(
      name: .hackTerminalOpenRequested,
      object: nil,
      userInfo: userInfo
    )
  }

  private var preferredExternalTerminal: TerminalIntegration.ExternalTerminalApp {
    if let explicit = TerminalIntegration.ExternalTerminalApp(rawValue: preferredExternalTerminalRaw) {
      return explicit
    }
    if let legacy = TerminalIntegration.ExternalTerminalApp(rawValue: legacyPreferredExternalTerminalRaw) {
      return legacy
    }
    return .terminal
  }

  private var installedExternalTerminalApps: [TerminalIntegration.ExternalTerminalApp] {
    let installed = TerminalIntegration.installedExternalTerminalApps()
    if installed.isEmpty {
      return [.terminal]
    }
    if installed.contains(preferredExternalTerminal) {
      return installed
    }
    return [preferredExternalTerminal] + installed
  }

  private var preferredEditor: EditorIntegration.EditorApp {
    if let explicit = EditorIntegration.EditorApp(rawValue: preferredEditorRaw) {
      return explicit
    }
    return .cursor
  }

  private var availableEditors: [EditorIntegration.EditorApp] {
    let installed = EditorIntegration.installedEditors()
    let fallback: [EditorIntegration.EditorApp] = [.cursor, .vscode, .zed, .neovim, .vim]
    var seen: Set<EditorIntegration.EditorApp> = []
    var ordered: [EditorIntegration.EditorApp] = []
    for editor in [preferredEditor] + installed + fallback where seen.insert(editor).inserted {
      ordered.append(editor)
    }
    return ordered
  }

  private var preferredCodingAgent: CodingAgentIntegration.AgentApp {
    if let explicit = CodingAgentIntegration.AgentApp(rawValue: preferredCodingAgentRaw) {
      return explicit
    }
    return .codex
  }

  private var availableCodingAgents: [CodingAgentIntegration.AgentApp] {
    let installed = CodingAgentIntegration.installedAgents()
    var seen: Set<CodingAgentIntegration.AgentApp> = []
    var ordered: [CodingAgentIntegration.AgentApp] = []
    for agent in [preferredCodingAgent] + installed + CodingAgentIntegration.AgentApp.allCases
      where seen.insert(agent).inserted {
      ordered.append(agent)
    }
    return ordered
  }

  private var projectOpenPath: String? {
    if let repoRoot = project.repoRoot, !repoRoot.isEmpty {
      return repoRoot
    }
    if let projectDir = project.projectDir, !projectDir.isEmpty {
      return projectDir
    }
    return nil
  }

  private func openLifecycleLogs(service: String?, title: String) {
    guard let projectPath = projectOpenPath else { return }
    var command = "hack logs --pretty --path \(shellQuote(projectPath))"
    let normalizedService = service?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !normalizedService.isEmpty {
      command += " \(shellQuote(normalizedService))"
    }
    openTerminal(kind: .shell, command: command, title: title)
  }

  private func openProjectInEditor(_ editor: EditorIntegration.EditorApp) {
    guard let path = projectOpenPath else { return }
    EditorIntegration.openProject(
      path: path,
      editor: editor,
      terminalApp: preferredExternalTerminal
    )
  }

  private func openProjectInCodingAgent(
    _ agent: CodingAgentIntegration.AgentApp,
    projectPath: String
  ) {
    let command = CodingAgentIntegration.launchCommand(
      projectPath: projectPath,
      agent: agent,
      binaryOverridePath: preferredCodingAgentBinaryPathRaw
    )
    openTerminal(
      kind: .shell,
      command: command,
      title: "\(agent.displayName) - \(project.name)"
    )
  }

  private func attachCommand(for session: ProjectSessionSummary) -> String {
    switch session.backend {
    case .tmux:
      return "env -u TMUX tmux attach -d -t \(shellQuote(session.name))"
    case .zellij:
      return "zellij attach \(shellQuote(session.name))"
    }
  }

  private func openSession(
    _ session: ProjectSessionSummary,
    terminalApp: TerminalIntegration.ExternalTerminalApp
  ) {
    if terminalApp == .hackDesktop {
      openTerminal(
        kind: .shell,
        command: attachCommand(for: session),
        title: "\(session.name) (attached)"
      )
      return
    }
    openSessionExternally(session, terminalApp: terminalApp)
  }

  private func openSessionExternally(
    _ session: ProjectSessionSummary,
    terminalApp: TerminalIntegration.ExternalTerminalApp
  ) {
    TerminalIntegration.openExternalTerminalWithCommand(
      attachCommand(for: session),
      app: terminalApp
    )
  }

  private func shellQuote(_ value: String) -> String {
    if value.isEmpty {
      return "''"
    }
    return "'\(value.replacingOccurrences(of: "'", with: "'\"'\"'"))'"
  }

}
