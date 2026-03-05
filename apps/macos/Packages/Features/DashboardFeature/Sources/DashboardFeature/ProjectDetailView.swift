import AppKit
import SwiftUI

import HackCLIService
import HackDesktopModels

private enum RemoteExecutionMode: String, CaseIterable, Identifiable {
  case local = "local"
  case localEditRemoteRun = "local_edit_remote_run"
  case remoteDevcontainer = "remote_devcontainer"

  var id: String { rawValue }

  var title: String {
    switch self {
    case .local:
      return "Local"
    case .localEditRemoteRun:
      return "Local edit + remote run"
    case .remoteDevcontainer:
      return "Remote devcontainer"
    }
  }

  var summary: String {
    switch self {
    case .local:
      return "Run and edit on this Mac."
    case .localEditRemoteRun:
      return "Edit locally, run lifecycle on remote node."
    case .remoteDevcontainer:
      return "Use a remote devcontainer workspace."
    }
  }

  static func fromConfig(_ raw: String?) -> RemoteExecutionMode? {
    guard let raw else {
      return nil
    }
    return RemoteExecutionMode(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines))
  }
}

private enum ProjectSidebarItem: String, CaseIterable, Identifiable {
  case remoteExecution
  case services
  case lifecycle
  case branches
  case sessions
  case tickets

  var id: String { rawValue }

  var title: String {
    switch self {
    case .remoteExecution:
      return "Project routing"
    case .services:
      return "Services"
    case .lifecycle:
      return "Lifecycle"
    case .branches:
      return "Branches"
    case .sessions:
      return "Sessions"
    case .tickets:
      return "Tickets"
    }
  }

  var icon: String {
    switch self {
    case .remoteExecution:
      return "point.3.connected.trianglepath.dotted"
    case .services:
      return "shippingbox"
    case .lifecycle:
      return "bolt.horizontal"
    case .branches:
      return "arrow.triangle.branch"
    case .sessions:
      return "rectangle.3.group.bubble.left"
    case .tickets:
      return "ticket"
    }
  }
}

private enum ProjectLinearSyncAction: String, Identifiable {
  case pullFromLinear
  case pushHackToLinear

  var id: String { rawValue }

  var title: String {
    switch self {
    case .pullFromLinear:
      return "Pull from Linear?"
    case .pushHackToLinear:
      return "Push Hack tickets?"
    }
  }

  var buttonLabel: String {
    switch self {
    case .pullFromLinear:
      return "Pull Linear"
    case .pushHackToLinear:
      return "Push Hack"
    }
  }

  var message: String {
    switch self {
    case .pullFromLinear:
      return "Linear-origin tickets stay authoritative for title, body, status, and project binding. Comments remain append-only. Assignees, labels, and dependencies merge best-effort when mappings are clear."
    case .pushHackToLinear:
      return "Hack-origin tickets stay authoritative for title, body, status, and project binding. Comments remain append-only. Assignees, labels, and dependencies merge best-effort when mappings are clear."
    }
  }

  var direction: String {
    switch self {
    case .pullFromLinear:
      return "linear"
    case .pushHackToLinear:
      return "hack"
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
  @State private var executionMode: RemoteExecutionMode = .local
  @State private var executionTargetNodeId = ""
  @State private var executionDefaultNodeId = ""
  @State private var executionTargetNodes: [NodeRegistryRecord] = []
  @State private var executionTargetLoading = false
  @State private var executionTargetSaving = false
  @State private var executionTargetMessage = ""
  @State private var githubProjectProfile = ""
  @State private var githubDefaultProfile = ""
  @State private var githubProfileOptions: [String] = []
  @State private var githubProfilesById: [String: GitHubProfileSummary] = [:]
  @State private var githubProfileStatusById: [String: GitHubStatusResponse] = [:]
  @State private var githubResolvedProfile = ""
  @State private var githubResolvedStatus: GitHubStatusResponse? = nil
  @State private var githubProfileMessage = ""
  @State private var linearProjectProfile = ""
  @State private var linearDefaultProfile = ""
  @State private var linearProfileOptions: [String] = []
  @State private var linearProfilesById: [String: LinearProfileSummary] = [:]
  @State private var linearProfileStatusById: [String: LinearStatusResponse] = [:]
  @State private var linearResolvedProfile = ""
  @State private var linearResolvedStatus: LinearStatusResponse? = nil
  @State private var linearBoundProjectId = ""
  @State private var linearBoundProjectName = ""
  @State private var linearBoundTeamId = ""
  @State private var linearProjectOptions: [LinearProjectSummary] = []
  @State private var selectedLinearProjectId = ""
  @State private var linearProjectMessage = ""
  @State private var pendingLinearSyncAction: ProjectLinearSyncAction? = nil
  @State private var projectSystemGitIdentity: GitSystemIdentity? = nil
  @State private var executionTargetReloadTask: Task<Void, Never>? = nil

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
      queueExecutionTargetReload()
    }
    .onChange(of: project.id) { _, _ in
      ensureSelectedTab()
      syncSidebarSelectionFromTab()
      ensureSidebarSelection()
      selectedService = nil
      queueExecutionTargetReload()
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
    .onDisappear {
      executionTargetReloadTask?.cancel()
      executionTargetReloadTask = nil
    }
    .sheet(isPresented: $showAddBranchSheet) {
      addBranchSheet
    }
    .alert(item: $pendingLinearSyncAction) { action in
      Alert(
        title: Text(action.title),
        message: Text(action.message),
        primaryButton: .default(Text(action.buttonLabel)) {
          Task { await syncBoundLinearProject(from: action.direction) }
        },
        secondaryButton: .cancel()
      )
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
      .font(.mono(.caption, weight: .semibold))
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
          .font(.mono(.caption, weight: .semibold))
          .foregroundStyle(selected ? Color.accentColor : Color.secondary)
          .frame(width: 14, alignment: .center)
        Text(item.title)
          .font(.mono(.subheadline, weight: .medium))
          .foregroundStyle(selected ? .primary : .secondary)
        Spacer(minLength: 6)
        if let count = sidebarItemCountLabel(item) {
          Text(count)
            .font(.mono(.caption2, weight: .semibold))
            .foregroundStyle(selected ? .primary : .tertiary)
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: 9, style: .continuous)
          .fill(selected ? Color.accentColor.opacity(0.18) : hoveredSidebarItem == item ? Color.white.opacity(0.06) : .clear)
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
          .font(.mono(.caption, weight: .semibold))
          .foregroundStyle(.secondary)
          .frame(width: 14, alignment: .center)
        Text(title)
          .font(.mono(.subheadline, weight: .medium))
          .foregroundStyle(.secondary)
        Spacer(minLength: 6)
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: 9, style: .continuous)
          .fill(Color.white.opacity(0.04))
      )
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
    case .tickets:
      TicketsView(project: project)
    }
  }

  @ViewBuilder
  private var projectOverviewContent: some View {
    switch selectedSidebarItem {
    case .remoteExecution:
      remoteExecutionContent
    case .services:
      servicesContent
    case .lifecycle:
      lifecycleContent
    case .branches, .sessions, .tickets:
      remoteExecutionContent
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

  private var remoteExecutionContent: some View {
    ProjectRemoteExecutionView(
      showsRuntimeNotConfigured: !project.isRuntimeConfigured,
      showsInfoPanel: showInfoPanel
    ) {
      runtimeNotConfiguredCard
    } sectionContent: {
      remoteExecutionSection
    } infoPanel: {
      infoSection
    }
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

  private var remoteExecutionSection: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 10) {
        Image(systemName: "point.3.connected.trianglepath.dotted")
          .foregroundStyle(.secondary)
        Text("Project routing")
          .font(.mono(.headline, weight: .semibold))
        Spacer()
        if executionTargetLoading || executionTargetSaving {
          ProgressView()
            .controlSize(.small)
        }
        Button {
          NotificationCenter.default.post(
            name: .hackSettingsRequested,
            object: nil,
            userInfo: ["pane": "github"]
          )
        } label: {
          Label("GitHub", systemImage: "person.crop.circle.badge.checkmark")
        }
        .buttonStyle(PressableIconButtonStyle())
        Button {
          NotificationCenter.default.post(
            name: .hackSettingsRequested,
            object: nil,
            userInfo: ["pane": "linear"]
          )
        } label: {
          Label("Linear", systemImage: "point.3.connected.trianglepath.dotted")
        }
        .buttonStyle(PressableIconButtonStyle())
      }

      Text("Choose runtime placement, remote Git identity, and the default Linear account/project used for ticket sync in this repo.")
        .font(.mono(.caption))
        .foregroundStyle(.secondary)

      InlineCallout(
        tone: linearRoutingContractTone,
        title: "Linear sync contract",
        message: linearRoutingContractMessage,
        actions: linearRoutingContractActions
      )

      VStack(alignment: .leading, spacing: 12) {
        HStack(alignment: .center, spacing: 12) {
          Text("Execution mode")
            .font(.mono(.subheadline, weight: .semibold))
            .frame(width: 120, alignment: .leading)

          Picker("Execution mode", selection: $executionMode) {
            ForEach(RemoteExecutionMode.allCases) { mode in
              Text(mode.title).tag(mode)
            }
          }
          .pickerStyle(.menu)
          .frame(maxWidth: 360, alignment: .leading)
          .onChange(of: executionMode) { _, _ in
            guard !executionTargetLoading else {
              return
            }
            Task { await persistExecutionModeSelection() }
          }

          Spacer()
          Text(executionMode.summary)
            .font(.mono(.caption2))
            .foregroundStyle(.tertiary)
        }

        HStack(alignment: .center, spacing: 12) {
          Text("Default node")
            .font(.mono(.subheadline, weight: .semibold))
            .frame(width: 120, alignment: .leading)

          Picker("Default node", selection: $executionTargetNodeId) {
            Text("Local").tag("")
            ForEach(executionTargetNodes, id: \.id) { node in
              Text(node.name).tag(node.id)
            }
          }
          .pickerStyle(.menu)
          .frame(maxWidth: 360, alignment: .leading)
          .onChange(of: executionTargetNodeId) { _, _ in
            guard !executionTargetLoading else {
              return
            }
            Task { await persistSimpleDefaultNodeSelection() }
          }
          .disabled(executionMode == .local)

          Spacer()
          Text(selectedNodeSummary)
            .font(.mono(.caption2))
            .foregroundStyle(.tertiary)
        }

        HStack(alignment: .center, spacing: 12) {
          Text("Git creds")
            .font(.mono(.subheadline, weight: .semibold))
            .frame(width: 120, alignment: .leading)

          Picker("Git creds", selection: $githubProjectProfile) {
            Text("Local").tag("")
            ForEach(githubProfileOptions, id: \.self) { profile in
              Text(githubProfileLabel(profileId: profile)).tag(profile)
            }
          }
          .pickerStyle(.menu)
          .frame(maxWidth: 360, alignment: .leading)
          .onChange(of: githubProjectProfile) { _, _ in
            guard !executionTargetLoading else {
              return
            }
            Task { await persistGitCredentialsSelection() }
          }

          Spacer()
          Text(selectedGitSummary)
            .font(.mono(.caption2))
            .foregroundStyle(.tertiary)
        }

        HStack(alignment: .center, spacing: 12) {
          Text("Linear acct")
            .font(.mono(.subheadline, weight: .semibold))
            .frame(width: 120, alignment: .leading)

          Picker("Linear account", selection: $linearProjectProfile) {
            Text("Inherited").tag("")
            ForEach(linearProfileOptions, id: \.self) { profile in
              Text(linearProfileLabel(profileId: profile)).tag(profile)
            }
          }
          .pickerStyle(.menu)
          .frame(maxWidth: 360, alignment: .leading)
          .onChange(of: linearProjectProfile) { _, _ in
            guard !executionTargetLoading else {
              return
            }
            Task { await persistLinearProfileOverride() }
          }

          Spacer()
          Text(selectedLinearProfileSummary)
            .font(.mono(.caption2))
            .foregroundStyle(.tertiary)
        }

        HStack(alignment: .center, spacing: 12) {
          Text("Linear proj")
            .font(.mono(.subheadline, weight: .semibold))
            .frame(width: 120, alignment: .leading)

          Picker("Linear project", selection: $selectedLinearProjectId) {
            Text("Unbound").tag("")
            ForEach(linearProjectOptions) { linearProject in
              Text(linearProjectMenuLabel(linearProject)).tag(linearProject.id)
            }
          }
          .pickerStyle(.menu)
          .frame(maxWidth: 360, alignment: .leading)
          .disabled(linearProjectOptions.isEmpty)
          .onChange(of: selectedLinearProjectId) { _, newValue in
            guard !executionTargetLoading else {
              return
            }
            guard newValue != linearBoundProjectId else {
              return
            }
            Task { await persistLinearProjectBindingSelection() }
          }

          if !linearBoundProjectId.isEmpty {
            Button("Clear") {
              Task { await clearLinearProjectBinding() }
            }
            .adaptiveToolbarButton()
          }

          Spacer()
          Text(selectedLinearProjectSummary)
            .font(.mono(.caption2))
            .foregroundStyle(.tertiary)
        }

        HStack(alignment: .center, spacing: 12) {
          Text("Ticket sync")
            .font(.mono(.subheadline, weight: .semibold))
            .frame(width: 120, alignment: .leading)

          HStack(spacing: 8) {
            Button {
              pendingLinearSyncAction = .pullFromLinear
            } label: {
              Label("Pull Linear", systemImage: "arrow.down.left")
            }
            .adaptiveToolbarButtonProminent()
            .disabled(!canSyncFromLinear)

            Button {
              pendingLinearSyncAction = .pushHackToLinear
            } label: {
              Label("Push Hack", systemImage: "arrow.up.right")
            }
            .adaptiveToolbarButton()
            .disabled(!canSyncToLinear)
          }

          Spacer()
          Text(ticketSyncSummary)
            .font(.mono(.caption2))
            .foregroundStyle(.tertiary)
        }
      }

      if let projectSystemGitIdentity {
        let systemAccountLabel = projectSystemGitIdentity.githubLogin.map { "@\($0)" } ?? "unavailable"
        Text("Local system Git: \(systemAccountLabel)\(projectSystemGitIdentity.gitEmail.map { " • \($0)" } ?? "")")
          .font(.mono(.caption2))
          .foregroundStyle(.secondary)
      }

      if let accountName = linearResolvedAccountName, !accountName.isEmpty {
        let teamSuffix = linearBoundTeamId.isEmpty ? "" : " • team \(linearBoundTeamId)"
        Text("Linear route: \(accountName)\(linearBoundProjectName.isEmpty ? "" : " • \(linearBoundProjectName)")\(teamSuffix)")
          .font(.mono(.caption2))
          .foregroundStyle(.secondary)
      }

      if !remoteConfigMessage.isEmpty {
        InlineCallout(
          tone: remoteConfigTone,
          title: remoteConfigTone == .warn ? "Routing issue" : "Routing updated",
          message: remoteConfigMessage,
          actions: remoteConfigActions
        )
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

  private var selectedNodeSummary: String {
    if executionMode == .local {
      return "Local"
    }
    let selectedNodeId = executionTargetNodeId.trimmingCharacters(in: .whitespacesAndNewlines)
    if !selectedNodeId.isEmpty {
      if let node = executionTargetNodes.first(where: { $0.id == selectedNodeId }) {
        return node.name
      }
      return selectedNodeId
    }

    let inheritedDefaultNodeId = executionDefaultNodeId.trimmingCharacters(in: .whitespacesAndNewlines)
    if inheritedDefaultNodeId.isEmpty {
      return "Inherited (no global default)"
    }
    if let defaultNode = executionTargetNodes.first(where: { $0.id == inheritedDefaultNodeId }) {
      return "Inherited (\(defaultNode.name))"
    }
    return "Inherited (\(inheritedDefaultNodeId))"
  }

  private var selectedGitSummary: String {
    let selectedProfileId = githubProjectProfile.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !selectedProfileId.isEmpty else {
      return "Local"
    }
    return githubProfileLabel(profileId: selectedProfileId)
  }

  private var selectedLinearProfileSummary: String {
    let selectedProfileId = linearProjectProfile.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !selectedProfileId.isEmpty else {
      if linearDefaultProfile.isEmpty {
        return "Inherited"
      }
      return linearProfileLabel(profileId: linearDefaultProfile)
    }
    return linearProfileLabel(profileId: selectedProfileId)
  }

  private var selectedLinearProjectSummary: String {
    let selectedProjectId = linearBoundProjectId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !selectedProjectId.isEmpty else {
      return "Unbound"
    }
    if let linearProject = linearProjectOptions.first(where: { $0.id == selectedProjectId }) {
      return linearProjectMenuLabel(linearProject)
    }
    if !linearBoundProjectName.isEmpty {
      return linearBoundProjectName
    }
    return selectedProjectId
  }

  private var linearResolvedAccountName: String? {
    let trimmed = linearResolvedProfile.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      return nil
    }
    return linearAccountLabel(profileId: trimmed)
  }

  private var canSyncFromLinear: Bool {
    !resolvedLinearProjectId.isEmpty && linearResolvedStatus?.tokenResolved == true
  }

  private var canSyncToLinear: Bool {
    linearResolvedStatus?.tokenResolved == true
  }

  private var resolvedLinearProjectId: String {
    let selected = selectedLinearProjectId.trimmingCharacters(in: .whitespacesAndNewlines)
    if !selected.isEmpty {
      return selected
    }
    return linearBoundProjectId.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var ticketSyncSummary: String {
    if linearResolvedStatus?.tokenResolved != true {
      return "Connect Linear first"
    }
    let projectId = resolvedLinearProjectId
    if projectId.isEmpty {
      return "Pick a Linear project"
    }
    if linearBoundProjectName.isEmpty {
      return "\(projectId) • origin decides authority"
    }
    return "\(linearBoundProjectName) • origin decides authority"
  }

  private var remoteConfigMessage: String {
    if !executionTargetMessage.isEmpty {
      return executionTargetMessage
    }
    if !githubProfileMessage.isEmpty {
      return githubProfileMessage
    }
    if !linearProjectMessage.isEmpty {
      return linearProjectMessage
    }
    return ""
  }

  private var remoteConfigTone: StatusTone {
    if remoteConfigMessage.hasPrefix("Failed") {
      return .warn
    }
    return .good
  }

  private var remoteConfigActions: [InlineCalloutAction] {
    if remoteConfigTone == .warn {
      return [
        InlineCalloutAction(
          label: "Linear settings",
          systemImage: "point.3.connected.trianglepath.dotted"
        ) {
          NotificationCenter.default.post(
            name: .hackSettingsRequested,
            object: nil,
            userInfo: ["pane": "linear"]
          )
        }
      ]
    }
    return [
      InlineCalloutAction(label: "Open tickets", systemImage: "ticket") {
        NotificationCenter.default.post(
          name: .hackProjectNavigationRequested,
          object: nil,
          userInfo: [
            ProjectNavigationRequest.projectIdKey: project.id,
            ProjectNavigationRequest.tabKey: ProjectTab.tickets.rawValue,
            ProjectNavigationRequest.sidebarKey: ProjectSidebarItem.tickets.rawValue,
          ]
        )
      }
    ]
  }

  private var linearRoutingContractTone: StatusTone {
    if linearResolvedStatus?.tokenResolved != true || resolvedLinearProjectId.isEmpty {
      return .warn
    }
    return .neutral
  }

  private var linearRoutingContractMessage: String {
    let routeSummary: String
    if let accountName = linearResolvedAccountName, !accountName.isEmpty {
      if linearBoundProjectName.isEmpty {
        routeSummary = "Current route uses \(accountName)."
      } else {
        routeSummary = "Current route uses \(accountName) and \(linearBoundProjectName)."
      }
    } else {
      routeSummary = "Linear is not fully routed for this project yet."
    }
    return "\(routeSummary) Origin decides authority for title, body, status, and project binding. Comments copy append-only. Assignees, labels, and dependencies merge best-effort and should be reviewed when mappings are ambiguous."
  }

  private var linearRoutingContractActions: [InlineCalloutAction] {
    var actions: [InlineCalloutAction] = [
      InlineCalloutAction(label: "Linear settings", systemImage: "point.3.connected.trianglepath.dotted") {
        NotificationCenter.default.post(
          name: .hackSettingsRequested,
          object: nil,
          userInfo: ["pane": "linear"]
        )
      }
    ]
    if project.supportsTickets {
      actions.append(
        InlineCalloutAction(label: "Open tickets", systemImage: "ticket") {
          NotificationCenter.default.post(
            name: .hackProjectNavigationRequested,
            object: nil,
            userInfo: [
              ProjectNavigationRequest.projectIdKey: project.id,
              ProjectNavigationRequest.tabKey: ProjectTab.tickets.rawValue,
              ProjectNavigationRequest.sidebarKey: ProjectSidebarItem.tickets.rawValue,
            ]
          )
        }
      )
    }
    return actions
  }

  private func githubAccountLogin(profileId: String) -> String? {
    let trimmed = profileId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      return nil
    }
    let summaryLogin = githubProfilesById[trimmed]?.accountLogin?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if let summaryLogin, !summaryLogin.isEmpty {
      return summaryLogin
    }
    let statusLogin = githubProfileStatusById[trimmed]?.accountLogin?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if let statusLogin, !statusLogin.isEmpty {
      return statusLogin
    }
    return nil
  }

  private func githubAccountName(profileId: String) -> String? {
    let trimmed = profileId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      return nil
    }
    let summaryName = githubProfilesById[trimmed]?.accountName?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if let summaryName, !summaryName.isEmpty {
      return summaryName
    }
    let statusName = githubProfileStatusById[trimmed]?.accountName?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if let statusName, !statusName.isEmpty {
      return statusName
    }
    return nil
  }

  private func githubProfileLabel(profileId: String) -> String {
    let trimmed = profileId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      return "Inherited"
    }
    guard let account = githubAccountLogin(profileId: trimmed) else {
      return trimmed
    }
    return "@\(account) (\(trimmed))"
  }

  private func linearAccountName(profileId: String) -> String? {
    let trimmed = profileId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      return nil
    }
    let summaryName = linearProfilesById[trimmed]?.accountName?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if let summaryName, !summaryName.isEmpty {
      return summaryName
    }
    let statusName = linearProfileStatusById[trimmed]?.accountName?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if let statusName, !statusName.isEmpty {
      return statusName
    }
    return nil
  }

  private func linearAccountEmail(profileId: String) -> String? {
    let trimmed = profileId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      return nil
    }
    let summaryEmail = linearProfilesById[trimmed]?.accountEmail?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if let summaryEmail, !summaryEmail.isEmpty {
      return summaryEmail
    }
    let statusEmail = linearProfileStatusById[trimmed]?.accountEmail?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if let statusEmail, !statusEmail.isEmpty {
      return statusEmail
    }
    return nil
  }

  private func linearAccountLabel(profileId: String) -> String? {
    linearAccountName(profileId: profileId) ?? linearAccountEmail(profileId: profileId)
  }

  private func linearProfileLabel(profileId: String) -> String {
    let trimmed = profileId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      return "Inherited"
    }
    guard let label = linearAccountLabel(profileId: trimmed) else {
      return trimmed
    }
    return "\(label) (\(trimmed))"
  }

  private func linearProjectMenuLabel(_ project: LinearProjectSummary) -> String {
    if let teamKey = project.teamKey, !teamKey.isEmpty {
      return "\(project.name) (\(teamKey))"
    }
    if let teamName = project.teamName, !teamName.isEmpty {
      return "\(project.name) (\(teamName))"
    }
    return project.name
  }

  /**
   Reload project-level remote execution defaults and Git credential routing.
   */
  private func reloadExecutionTargetState() async {
    if Task.isCancelled {
      return
    }
    executionTargetLoading = true
    defer { executionTargetLoading = false }
    let identityProjectPath = project.repoRoot ?? project.projectDir

    async let nodeList = model.listNodes()
    async let executionModeRaw = model.getProjectConfig(
      for: project,
      key: "controlPlane.execution.mode"
    )
    async let executionNodeId = model.getProjectConfig(
      for: project,
      key: "controlPlane.execution.nodeId"
    )
    async let projectNodeId = model.getProjectConfig(
      for: project,
      key: "controlPlane.nodeId"
    )
    async let projectGitHubProfile = model.getProjectConfig(
      for: project,
      key: "controlPlane.routing.overrides.github.profile"
    )
    async let projectLinearProfile = model.getProjectConfig(
      for: project,
      key: "controlPlane.routing.overrides.linear.profile"
    )
    async let projectLinearProjectId = model.getProjectConfig(
      for: project,
      key: "controlPlane.routing.overrides.linear.projectId"
    )
    async let projectLinearProjectName = model.getProjectConfig(
      for: project,
      key: "controlPlane.routing.overrides.linear.projectName"
    )
    async let projectLinearTeamId = model.getProjectConfig(
      for: project,
      key: "controlPlane.routing.overrides.linear.teamId"
    )
    async let defaultGitHubProfile = model.getGlobalConfig(
      key: "controlPlane.extensions[\"dance.hack.github\"].config.defaultProfile"
    )
    async let defaultLinearProfile = model.getGlobalConfig(
      key: "controlPlane.extensions[\"dance.hack.linear\"].config.defaultProfile"
    )
    async let githubProfiles = model.inspectGitHubProfiles()
    async let linearProfiles = model.inspectLinearProfiles()
    async let systemGitIdentity = model.inspectSystemGitIdentity(
      projectPath: identityProjectPath
    )

    let resolvedNodeList = await nodeList
    let resolvedExecutionModeRaw = await executionModeRaw
    let resolvedExecutionNodeId = await executionNodeId
    let resolvedProjectNodeId = await projectNodeId
    let resolvedProjectGitHubProfile = await projectGitHubProfile
    let resolvedProjectLinearProfile = await projectLinearProfile
    let resolvedProjectLinearProjectId = await projectLinearProjectId
    let resolvedProjectLinearProjectName = await projectLinearProjectName
    let resolvedProjectLinearTeamId = await projectLinearTeamId
    let resolvedDefaultGitHubProfile = await defaultGitHubProfile
    let resolvedDefaultLinearProfile = await defaultLinearProfile
    let resolvedGitHubProfiles = await githubProfiles
    let resolvedLinearProfiles = await linearProfiles
    let resolvedSystemGitIdentity = await systemGitIdentity

    if Task.isCancelled {
      return
    }

    executionTargetNodes = resolvedNodeList?.nodes ?? []
    executionDefaultNodeId = (resolvedNodeList?.defaultNodeId ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let executionNodeIdValue = (resolvedExecutionNodeId ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let projectNodeIdValue = (resolvedProjectNodeId ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    executionTargetNodeId = !executionNodeIdValue.isEmpty
      ? executionNodeIdValue
      : projectNodeIdValue
    githubProjectProfile = (resolvedProjectGitHubProfile ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let fallbackDefaultGitHubProfile = (resolvedDefaultGitHubProfile ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    githubDefaultProfile = resolvedGitHubProfiles?.defaultProfile ?? fallbackDefaultGitHubProfile
    githubProfilesById = mapGitHubProfilesById(response: resolvedGitHubProfiles)
    githubProfileOptions = (resolvedGitHubProfiles?.profiles ?? [])
      .map(\.id)
      .sorted { lhs, rhs in
        lhs.localizedCaseInsensitiveCompare(rhs) == .orderedAscending
      }
    var profileStatusById: [String: GitHubStatusResponse] = [:]
    for profileId in githubProfileOptions {
      if let status = await model.inspectGitHubStatus(profileId: profileId) {
        profileStatusById[profileId] = status
      }
    }
    githubProfileStatusById = profileStatusById
    let resolvedGitHubProfile = githubProjectProfile.isEmpty
      ? githubDefaultProfile
      : githubProjectProfile
    githubResolvedProfile = resolvedGitHubProfile
    projectSystemGitIdentity = resolvedSystemGitIdentity
    if let preloadedStatus = profileStatusById[resolvedGitHubProfile] {
      githubResolvedStatus = preloadedStatus
    } else {
      githubResolvedStatus = await model.inspectGitHubStatus(
        profileId: resolvedGitHubProfile.isEmpty ? nil : resolvedGitHubProfile
      )
    }

    linearProjectProfile = (resolvedProjectLinearProfile ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    linearBoundProjectId = (resolvedProjectLinearProjectId ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    linearBoundProjectName = (resolvedProjectLinearProjectName ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    linearBoundTeamId = (resolvedProjectLinearTeamId ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let fallbackDefaultLinearProfile = (resolvedDefaultLinearProfile ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    linearDefaultProfile = resolvedLinearProfiles?.defaultProfile ?? fallbackDefaultLinearProfile
    linearProfilesById = mapLinearProfilesById(response: resolvedLinearProfiles)
    linearProfileOptions = (resolvedLinearProfiles?.profiles ?? [])
      .map(\.id)
      .sorted { lhs, rhs in
        lhs.localizedCaseInsensitiveCompare(rhs) == .orderedAscending
      }
    var linearStatusesById: [String: LinearStatusResponse] = [:]
    for profileId in linearProfileOptions {
      if let status = await model.inspectLinearStatus(profileId: profileId) {
        linearStatusesById[profileId] = status
      }
    }
    linearProfileStatusById = linearStatusesById
    let resolvedLinearProfile = linearProjectProfile.isEmpty
      ? linearDefaultProfile
      : linearProjectProfile
    linearResolvedProfile = resolvedLinearProfile
    if let preloadedStatus = linearStatusesById[resolvedLinearProfile] {
      linearResolvedStatus = preloadedStatus
    } else {
      linearResolvedStatus = await model.inspectLinearStatus(
        profileId: resolvedLinearProfile.isEmpty ? nil : resolvedLinearProfile
      )
    }
    if linearResolvedStatus?.tokenResolved == true {
      let projectCatalog = await model.listLinearProjects(
        profileId: resolvedLinearProfile.isEmpty ? nil : resolvedLinearProfile
      )
      linearProjectOptions = (projectCatalog?.projects ?? []).sorted { lhs, rhs in
        lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
      }
    } else {
      linearProjectOptions = []
    }
    selectedLinearProjectId = linearBoundProjectId
    executionMode = RemoteExecutionMode.fromConfig(resolvedExecutionModeRaw)
      ?? (executionTargetNodeId.isEmpty ? .local : .localEditRemoteRun)
    executionTargetMessage = ""
    githubProfileMessage = ""
    linearProjectMessage = ""
  }

  private func queueExecutionTargetReload() {
    executionTargetReloadTask?.cancel()
    executionTargetReloadTask = Task {
      await reloadExecutionTargetState()
    }
  }

  /**
   Persist project execution mode, including local-mode safety resets.
   */
  private func persistExecutionModeSelection() async {
    executionTargetSaving = true
    defer { executionTargetSaving = false }

    let modeValue = executionMode.rawValue
    let didSaveMode = await model.setProjectConfig(
      for: project,
      key: "controlPlane.execution.mode",
      value: modeValue
    )
    if !didSaveMode {
      executionTargetMessage = "Failed to save execution mode."
      return
    }

    if executionMode == .local {
      let clearWrites: [(String, String)] = [
        ("controlPlane.execution.nodeId", ""),
        ("controlPlane.nodeId", ""),
      ]
      for (key, value) in clearWrites {
        let didSave = await model.setProjectConfig(
          for: project,
          key: key,
          value: value
        )
        if !didSave {
          executionTargetMessage = "Failed to reset project node for local mode."
          return
        }
      }
      executionTargetNodeId = ""
    }

    executionTargetMessage = "Execution mode set to \(executionMode.title)."
    githubProfileMessage = ""
    await model.refresh()
    queueExecutionTargetReload()
  }

  /**
   Save simplified default-node selection.
   *
   Selecting "Local" clears project node affinity and falls back to global node selection.
   */
  private func persistSimpleDefaultNodeSelection() async {
    executionTargetSaving = true
    defer { executionTargetSaving = false }

    let selectedNodeId = executionTargetNodeId.trimmingCharacters(in: .whitespacesAndNewlines)
    let writes: [(String, String)] = [
      ("controlPlane.execution.nodeId", selectedNodeId),
      ("controlPlane.nodeId", selectedNodeId),
      ("controlPlane.routing.provider", ""),
      ("controlPlane.routing.profile", ""),
    ]

    for (key, value) in writes {
      let didSave = await model.setProjectConfig(
        for: project,
        key: key,
        value: value
      )
      if !didSave {
        executionTargetMessage = "Failed to save default node."
        return
      }
    }

    if executionMode == .localEditRemoteRun || executionMode == .remoteDevcontainer,
      selectedNodeId.isEmpty,
      executionDefaultNodeId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    {
      executionTargetMessage = "No global default node found. Choose a node or run `hack node use <id>`."
      githubProfileMessage = ""
      return
    }

    if selectedNodeId.isEmpty {
      executionTargetMessage = "Default node set to inherited."
    } else if let node = executionTargetNodes.first(where: { $0.id == selectedNodeId }) {
      executionTargetMessage = "Default node set to \(node.name)."
    } else {
      executionTargetMessage = "Default node updated."
    }
    githubProfileMessage = ""
    await model.refresh()
    queueExecutionTargetReload()
  }

  private func persistGitCredentialsSelection() async {
    await persistGitHubProfileOverride()
  }

  private func mapGitHubProfilesById(response: GitHubProfilesResponse?) -> [String: GitHubProfileSummary] {
    guard let response else {
      return [:]
    }
    return response.profiles.reduce(into: [:]) { partialResult, profile in
      partialResult[profile.id] = profile
    }
  }

  private func mapLinearProfilesById(response: LinearProfilesResponse?) -> [String: LinearProfileSummary] {
    guard let response else {
      return [:]
    }
    return response.profiles.reduce(into: [:]) { partialResult, profile in
      partialResult[profile.id] = profile
    }
  }

  private func persistGitHubProfileOverride() async {
    executionTargetSaving = true
    defer { executionTargetSaving = false }

    let trimmed = githubProjectProfile
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let didSave = await model.setProjectConfig(
      for: project,
      key: "controlPlane.routing.overrides.github.profile",
      value: trimmed
    )
    if !didSave {
      githubProfileMessage = "Failed to save Git creds."
      return
    }
    githubProfileMessage = trimmed.isEmpty
      ? "Git creds set to Local."
      : "Git creds set to \(githubProfileLabel(profileId: trimmed))."
    executionTargetMessage = ""
    await model.refresh()
    queueExecutionTargetReload()
  }

  private func persistLinearProfileOverride() async {
    executionTargetSaving = true
    defer { executionTargetSaving = false }

    let trimmed = linearProjectProfile.trimmingCharacters(in: .whitespacesAndNewlines)
    let didEnable = await model.setProjectConfig(
      for: project,
      key: "controlPlane.extensions[\"dance.hack.linear\"].enabled",
      value: "true"
    )
    if !didEnable {
      linearProjectMessage = "Failed to enable Linear for this project."
      return
    }
    let didSave = await model.setProjectConfig(
      for: project,
      key: "controlPlane.routing.overrides.linear.profile",
      value: trimmed
    )
    if !didSave {
      linearProjectMessage = "Failed to save Linear account routing."
      return
    }
    linearProjectMessage = trimmed.isEmpty
      ? "Linear account set to inherited."
      : "Linear account set to \(linearProfileLabel(profileId: trimmed))."
    executionTargetMessage = ""
    githubProfileMessage = ""
    await model.refresh()
    queueExecutionTargetReload()
  }

  private func persistLinearProjectBindingSelection() async {
    let selectedProjectId = selectedLinearProjectId
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if selectedProjectId.isEmpty {
      await clearLinearProjectBinding()
      return
    }

    guard let linearProject = linearProjectOptions.first(where: { $0.id == selectedProjectId }) else {
      linearProjectMessage = "Choose a valid Linear project before saving."
      return
    }

    let profileOverride = linearProjectProfile.trimmingCharacters(in: .whitespacesAndNewlines)
    let response = await model.bindLinearProject(
      for: project,
      profileId: profileOverride.isEmpty ? nil : profileOverride,
      projectId: linearProject.id,
      projectName: linearProject.name,
      teamId: linearProject.teamId,
      clear: false
    )
    guard response?.ok == true else {
      linearProjectMessage = model.errorMessage ?? "Failed to save Linear project binding."
      return
    }

    linearProjectMessage = "Linear project bound to \(linearProjectMenuLabel(linearProject))."
    executionTargetMessage = ""
    githubProfileMessage = ""
    await model.refresh()
    queueExecutionTargetReload()
  }

  private func clearLinearProjectBinding() async {
    let profileOverride = linearProjectProfile.trimmingCharacters(in: .whitespacesAndNewlines)
    let response = await model.bindLinearProject(
      for: project,
      profileId: profileOverride.isEmpty ? nil : profileOverride,
      projectId: nil,
      projectName: nil,
      teamId: nil,
      clear: true
    )
    guard response?.ok == true else {
      linearProjectMessage = model.errorMessage ?? "Failed to clear Linear project binding."
      return
    }

    selectedLinearProjectId = ""
    linearProjectMessage = "Cleared project-level Linear binding."
    executionTargetMessage = ""
    githubProfileMessage = ""
    await model.refresh()
    queueExecutionTargetReload()
  }

  private func syncBoundLinearProject(from direction: String) async {
    let explicitProjectId = resolvedLinearProjectId
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let explicitTeamId = linearBoundTeamId
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let ownerMode = direction == "hack" ? "hack" : nil
    let result = await model.syncLinearProject(
      for: project,
      from: direction,
      ownerMode: ownerMode,
      projectId: explicitProjectId.isEmpty ? nil : explicitProjectId,
      teamId: explicitTeamId.isEmpty ? nil : explicitTeamId,
      limit: nil,
      syncLabels: nil
    )
    guard let result, result.ok else {
      linearProjectMessage = model.errorMessage ?? "Ticket sync failed."
      return
    }

    if direction == "linear" {
      linearProjectMessage =
        "Pulled \(result.processed) item\(result.processed == 1 ? "" : "s") • created \(result.created) • updated \(result.updated). Linear stays authoritative for Linear-origin title, body, status, and project binding."
    } else {
      linearProjectMessage =
        "Pushed \(result.processed) Hack ticket\(result.processed == 1 ? "" : "s") • created \(result.created) • updated \(result.updated). Hack stays authoritative for Hack-origin title, body, status, and project binding."
    }
    executionTargetMessage = ""
    githubProfileMessage = ""
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
    if project.supportsTickets {
      tabs.append(.tickets)
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
    var items: [ProjectSidebarItem] = [.services, .remoteExecution]
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
    if project.supportsTickets {
      items.append(.tickets)
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
    case .remoteExecution:
      return nil
    case .services:
      return "\(serviceEntries.count)"
    case .lifecycle:
      return lifecycleSummary.hasEntries ? "\(lifecycleSummary.persistentCount)" : nil
    case .branches:
      return "\(branchEntries.count)"
    case .sessions:
      return "\(sessionEntries.count)"
    case .tickets:
      return project.supportsTickets ? "On" : nil
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
    case .tickets:
      selectedSidebarItem = .tickets
    case .logs, .shell:
      if !overviewSidebarItems.contains(selectedSidebarItem) {
        selectedSidebarItem = .services
      }
    }
  }

  private func selectSidebarItem(_ item: ProjectSidebarItem) {
    selectedSidebarItem = item
    switch item {
    case .remoteExecution:
      model.selectedProjectTab = .overview
    case .services:
      model.selectedProjectTab = .overview
    case .lifecycle:
      model.selectedProjectTab = .overview
    case .branches:
      model.selectedProjectTab = .branches
    case .sessions:
      model.selectedProjectTab = .sessions
    case .tickets:
      model.selectedProjectTab = .tickets
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
