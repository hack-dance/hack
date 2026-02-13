import AppKit
import SwiftUI

import HackDesktopModels


public struct DashboardView: View {
  @Environment(DashboardModel.self) private var model
  @Environment(\.colorScheme) private var colorScheme
  @State private var showCommandPalette = false
  @State private var showTerminalDrawer = false
  @State private var showSettingsOverlay = false
  @State private var selectedSettingsItem: SettingsSidebarItem = .runtime
  @State private var terminalDrawerHeight: CGFloat = 360
  @State private var terminalDrawerInitialHeight: CGFloat? = nil
  @State private var terminalDrawerModel = TerminalDrawerModel(globalShellProject: Self.makeGlobalShellProject())
  @State private var dismissedGlobalRecoveryOverlay = false

  public init() {}

  public var body: some View {
    @Bindable var model = model

    GeometryReader { proxy in
      ZStack {
        VSplitView {
          ZStack {
            mainSplitView
              .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

            if showSettingsOverlay {
              SettingsOverlayView(
                selection: $selectedSettingsItem,
                onClose: { showSettingsOverlay = false }
              )
              .environment(model)
              .transition(.opacity.combined(with: .scale(scale: 0.995)))
              .zIndex(20)
            }

            if shouldShowGlobalRecoveryOverlay {
              globalRecoveryOverlay
                .transition(.opacity)
                .zIndex(30)
            }
          }

          if showTerminalDrawer {
            terminalDrawer
              .frame(maxHeight: proxy.size.height * 0.92)
              .onPreferenceChange(TerminalDrawerView.heightPreferenceKey) { newHeight in
                // Let users drag the split divider all the way down to close.
                let closeThreshold: CGFloat = 84
                if newHeight > 0, newHeight < closeThreshold, showTerminalDrawer {
                  showTerminalDrawer = false
                  return
                }
                if newHeight > closeThreshold {
                  terminalDrawerHeight = newHeight
                }
              }
              .transition(.move(edge: .bottom).combined(with: .opacity))
          }
        }
        .background(alignment: .top) {
          topHeaderChrome
        }
      }
      // Attach toolbar at the window root. Nested toolbars inside split views can disappear
      // when additional container views are introduced (e.g. a bottom terminal panel).
      .toolbar {
        ToolbarItem(placement: .navigation) {
          ToolbarIconButton(
            systemImage: "square.grid.2x2",
            help: "Go to dashboard",
            accessibilityLabel: "Go to dashboard",
            symbolTint: titlebarNeutralIconTint,
            hoverSymbolTint: titlebarNeutralIconHoverTint,
            action: {
              showSettingsOverlay = false
              model.selectedItem = .home
            }
          )
        }
        ToolbarItem(placement: .principal) {
          GlobalStatusStrip(placement: .titlebar)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        ToolbarItemGroup(placement: .primaryAction) {
          ToolbarIconButton(
            systemImage: "gearshape",
            help: "Open settings",
            accessibilityLabel: "Open settings",
            symbolTint: titlebarNeutralIconTint,
            hoverSymbolTint: titlebarNeutralIconHoverTint,
            action: {
              openSettings(.runtime)
            }
          )
          ToolbarIconButton(
            systemImage: globalToggleIcon,
            hoverSystemImage: globalToggleHoverIcon,
            help: globalToggleHelp,
            accessibilityLabel: globalToggleAccessibilityLabel,
            symbolTint: globalToggleTint,
            hoverSymbolTint: globalToggleHoverTint,
            action: {
              guard !globalToggleIsBusy else { return }
              Task { await model.toggleGlobalInfrastructure() }
            }
          )
          ToolbarIconButton(
            systemImage: "terminal",
            help: "Toggle terminal",
            accessibilityLabel: "Toggle terminal",
            symbolTint: titlebarNeutralIconTint,
            hoverSymbolTint: titlebarNeutralIconHoverTint,
            action: {
              if showTerminalDrawer {
                showTerminalDrawer = false
              } else {
                terminalDrawerInitialHeight = terminalDrawerHeight
                showTerminalDrawer = true
              }
            }
          )
        }
      }
      .navigationTitle("")
      .toolbarTitleDisplayMode(.inline)
      .adaptiveWindowBackground()
      .tuneWindowToolbar()
      .task {
        model.start()
      }
      .onReceive(NotificationCenter.default.publisher(for: .hackCommandPaletteRequested)) { _ in
        showCommandPalette = true
      }
      .onReceive(NotificationCenter.default.publisher(for: .hackRefreshRequested)) { _ in
        Task { await model.refresh() }
      }
      .onReceive(NotificationCenter.default.publisher(for: .hackTerminalOpenRequested)) { notification in
        guard
          let userInfo = notification.userInfo,
          let projectId = userInfo[TerminalOpenRequest.projectIdKey] as? String,
          let kindRaw = userInfo[TerminalOpenRequest.kindKey] as? String,
          let kind = TerminalDrawerModel.Kind(rawValue: kindRaw)
        else {
          return
        }
        let branch = (userInfo[TerminalOpenRequest.branchKey] as? String)?
          .trimmingCharacters(in: .whitespacesAndNewlines)
        let initialCommand = (userInfo[TerminalOpenRequest.commandKey] as? String)?
          .trimmingCharacters(in: .whitespacesAndNewlines)
        let titleOverride = (userInfo[TerminalOpenRequest.titleKey] as? String)?
          .trimmingCharacters(in: .whitespacesAndNewlines)
        let project: ProjectSummary
        if let matchedProject = model.projects.first(where: { $0.id == projectId }) {
          project = matchedProject
        } else if projectId == globalShellProject.id {
          project = globalShellProject
        } else {
          return
        }

        if !showTerminalDrawer {
          terminalDrawerInitialHeight = terminalDrawerHeight
          showTerminalDrawer = true
        }
        terminalDrawerModel.openOrSelect(
          project: project,
          kind: kind,
          branch: branch,
          initialCommand: initialCommand,
          titleOverride: titleOverride
        )
      }
      .onReceive(NotificationCenter.default.publisher(for: .hackSettingsRequested)) { notification in
        if let userInfo = notification.userInfo,
           let rawPane = userInfo[SettingsNavigationRequest.paneKey] as? String,
           let pane = SettingsSidebarItem(rawValue: rawPane) {
          openSettings(pane)
        } else {
          openSettings(.runtime)
        }
      }
      .sheet(isPresented: $showCommandPalette) {
        CommandPaletteView()
          .environment(model)
      }
      .onChange(of: model.globalInfraDown) { _, isDown in
        if !isDown {
          dismissedGlobalRecoveryOverlay = false
        }
      }
      .animation(.easeInOut(duration: 0.18), value: showTerminalDrawer)
    }
  }

  private var mainSplitView: some View {
    detail
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .padding(.top, detailTopPadding)
      .adaptiveDetailBackground()
      .controlSize(.small)
  }

  private var detailTopPadding: CGFloat {
    if case .project = model.selectedItem {
      return 0
    }
    return 12
  }

  private var topHeaderChrome: some View {
    RoundedRectangle(cornerRadius: 14, style: .continuous)
      .fill(.ultraThinMaterial)
      .overlay {
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .fill(
            colorScheme == .dark
              ? Color.white.opacity(0.08)
              : Color.white.opacity(0.24)
          )
      }
      .overlay(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .stroke(
            colorScheme == .dark
              ? Color.white.opacity(0.24)
              : Color.white.opacity(0.62),
            lineWidth: 1
          )
      )
      .frame(height: 46)
      .padding(.top, 8)
      .padding(.horizontal, 12)
      .allowsHitTesting(false)
  }

  private var globalToggleIcon: String {
    if globalToggleIsBusy {
      return "hourglass"
    }
    return model.globalInfraRunning ? "bolt.fill" : "power.circle"
  }

  private var globalToggleHoverIcon: String? {
    if globalToggleIsBusy {
      return nil
    }
    return model.globalInfraRunning ? "power.circle.fill" : "bolt.fill"
  }

  private var globalToggleTint: NSColor {
    if globalToggleIsBusy {
      return .secondaryLabelColor
    }
    return model.globalInfraRunning ? NSColor.systemGreen : NSColor.systemRed
  }

  private var globalToggleHoverTint: NSColor? {
    if globalToggleIsBusy {
      return nil
    }
    return model.globalInfraRunning ? NSColor.systemRed : NSColor.systemGreen
  }

  private var globalToggleHelp: String {
    if let action = model.globalLifecycleAction {
      return action == .starting ? "Starting global services…" : "Stopping global services…"
    }
    if model.globalInfraRunning {
      return "Global services are running. Click to stop (`hack global down`)."
    }
    return "Global services are stopped. Click to start (`hack global up`)."
  }

  private var globalToggleAccessibilityLabel: String {
    if let action = model.globalLifecycleAction {
      return action == .starting ? "Starting global services" : "Stopping global services"
    }
    return model.globalInfraRunning ? "Stop global services" : "Start global services"
  }

  private var globalToggleIsBusy: Bool {
    model.globalLifecycleAction != nil
  }

  private var titlebarNeutralIconTint: NSColor {
    titlebarIconTint(lightOpacity: 0.72, darkOpacity: 0.90)
  }

  private var titlebarNeutralIconHoverTint: NSColor {
    titlebarIconTint(lightOpacity: 0.86, darkOpacity: 1.0)
  }

  private func titlebarIconTint(lightOpacity: CGFloat, darkOpacity: CGFloat) -> NSColor {
    NSColor(name: nil) { appearance in
      let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
      if isDark {
        return NSColor.white.withAlphaComponent(darkOpacity)
      }
      return NSColor.black.withAlphaComponent(lightOpacity)
    }
  }

  private var shouldShowGlobalRecoveryOverlay: Bool {
    if dismissedGlobalRecoveryOverlay {
      return false
    }
    if model.globalLifecycleAction == .starting {
      return true
    }
    return model.globalInfraDown
      && (model.daemonStatus?.resolvedLabel == .running || model.daemonStatus?.resolvedLabel == .starting)
  }

  private var globalRecoveryOverlay: some View {
    ZStack {
      Rectangle()
        .fill(Color.black.opacity(colorScheme == .dark ? 0.35 : 0.22))
        .ignoresSafeArea()

      VStack(alignment: .leading, spacing: 14) {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          Label("Global services are down", systemImage: "bolt.slash.fill")
            .font(.mono(.headline, weight: .semibold))
          Spacer()
          Button {
            dismissedGlobalRecoveryOverlay = true
          } label: {
            Image(systemName: "xmark")
              .font(.system(size: 10, weight: .bold))
              .frame(width: 20, height: 20)
          }
          .buttonStyle(PressableCircleButtonStyle())
          .help("Dismiss")
        }

        Text("Hackd is running, but Caddy/logging/gateway are not fully healthy. Restart global infra to recover local DNS/TLS routing.")
          .font(.mono(.caption))
          .foregroundStyle(.secondary)

        VStack(alignment: .leading, spacing: 8) {
          statusRow(
            title: "Daemon",
            healthy: model.daemonStatus?.resolvedLabel == .running,
            value: model.daemonStatus?.resolvedLabel.rawValue.capitalized ?? "Unknown"
          )
          statusRow(
            title: "Caddy",
            healthy: (model.globalStatus?.caddy?.ok ?? model.globalStatus?.summary.caddyOk) == true,
            value: (model.globalStatus?.caddy?.ok ?? model.globalStatus?.summary.caddyOk) == true ? "Running" : "Down"
          )
          statusRow(
            title: "Logging",
            healthy: (model.globalStatus?.logging?.ok ?? model.globalStatus?.summary.loggingOk) == true,
            value: (model.globalStatus?.logging?.ok ?? model.globalStatus?.summary.loggingOk) == true ? "Running" : "Down"
          )
          statusRow(
            title: "Networks",
            healthy: (model.globalStatus?.networks?.ok ?? model.globalStatus?.summary.networksOk) == true,
            value: (model.globalStatus?.networks?.ok ?? model.globalStatus?.summary.networksOk) == true ? "Healthy" : "Missing"
          )
        }
        .padding(10)
        .background(
          RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(colorScheme == .dark ? Color.white.opacity(0.05) : Color.black.opacity(0.03))
        )

        HStack(spacing: 8) {
          Button {
            Task { await model.globalUp() }
          } label: {
            HStack(spacing: 6) {
              if model.globalLifecycleAction == .starting {
                ProgressView()
                  .controlSize(.small)
              } else {
                Image(systemName: "arrow.triangle.2.circlepath")
              }
              Text(model.globalLifecycleAction == .starting ? "Restarting…" : "Restart global services")
                .lineLimit(1)
            }
          }
          .adaptiveToolbarButtonProminent()
          .disabled(model.globalLifecycleAction != nil)

          Button("Runtime details") {
            openSettings(.runtime)
            dismissedGlobalRecoveryOverlay = true
          }
          .adaptiveToolbarButton()
        }
      }
      .padding(16)
      .frame(maxWidth: 680)
      .background(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .fill(.thinMaterial)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .stroke(Color.primary.opacity(0.12), lineWidth: 1)
      )
      .shadow(color: Color.black.opacity(0.18), radius: 24, x: 0, y: 14)
      .padding(20)
    }
  }

  @ViewBuilder
  private func statusRow(title: String, healthy: Bool, value: String) -> some View {
    HStack(spacing: 8) {
      Circle()
        .fill(healthy ? Color.green : Color.orange)
        .frame(width: 7, height: 7)
      Text(title)
        .font(.mono(.caption, weight: .semibold))
      Spacer()
      Text(value)
        .font(.mono(.caption))
        .foregroundStyle(.secondary)
    }
  }

  @ViewBuilder
  private var terminalDrawer: some View {
    let drawer = TerminalDrawerView(
      title: "Terminal",
      model: terminalDrawerModel,
      onClose: { showTerminalDrawer = false }
    )
    .frame(minHeight: 0)
    .onAppear {
      // Only apply an initial idealHeight once to avoid fighting the native split-view drag.
      DispatchQueue.main.async {
        terminalDrawerInitialHeight = nil
      }
    }

    if let initialHeight = terminalDrawerInitialHeight {
      drawer.frame(idealHeight: initialHeight)
    } else {
      drawer
    }
  }

  private var globalShellProject: ProjectSummary {
    Self.makeGlobalShellProject()
  }

  private static func makeGlobalShellProject() -> ProjectSummary {
    ProjectSummary(
      projectId: "global-shell",
      name: "Global Shell",
      devHost: nil,
      repoRoot: FileManager.default.homeDirectoryForCurrentUser.path,
      projectDir: nil,
      definedServices: nil,
      extensionsEnabled: nil,
      features: nil,
      serviceHosts: nil,
      runtimeConfigured: nil,
      runtimeStatus: nil,
      runtime: nil,
      kind: .unregistered,
      status: .unknown
    )
  }

  private var sidebar: some View {
    @Bindable var model = model

    let hiddenProjectIds = Set(
      model.projects
        .filter { isLikelyEphemeralWorktreeRegistration(project: $0, allProjects: model.projects) }
        .map(\.id)
    )
    let visibleProjects = model.projects.filter { !hiddenProjectIds.contains($0.id) }
    let extensionProjects = visibleProjects.filter { $0.isExtensionOnly }
    let runtimeProjects = visibleProjects.filter { !$0.isExtensionOnly }
    return List(selection: $model.selectedItem) {
      Section("Projects") {
        if runtimeProjects.isEmpty {
          VStack(alignment: .leading, spacing: 4) {
            Text("No projects registered")
              .font(.mono(.subheadline))
              .foregroundStyle(.secondary)
            Text("Run `hack init` in a project directory to register it.")
              .font(.mono(.caption))
              .foregroundStyle(.tertiary)
          }
          .padding(.vertical, 4)
        } else {
          ForEach(runtimeProjects) { project in
            ProjectRowView(project: project, runtimeHealthy: model.runtimeOverallOk)
              .tag(SidebarItem.project(project.id))
              .contextMenu { projectContextMenu(for: project) }
          }
        }
      }
      if !extensionProjects.isEmpty {
        Section("Extensions") {
          ForEach(extensionProjects) { project in
            ProjectRowView(project: project, runtimeHealthy: model.runtimeOverallOk)
              .tag(SidebarItem.project(project.id))
              .contextMenu { projectContextMenu(for: project) }
          }
        }
      }
    }
    .listStyle(.sidebar)
    .listRowSeparator(.hidden)
    .adaptiveSidebarBackground()
    .safeAreaInset(edge: .bottom) {
      footer
    }
  }

  private func isLikelyEphemeralWorktreeRegistration(
    project: ProjectSummary,
    allProjects: [ProjectSummary]
  ) -> Bool {
    guard project.status == .missing else { return false }
    guard project.runtime == nil else { return false }
    guard project.runtimeConfigured != true else { return false }
    guard (project.features ?? []).isEmpty else { return false }
    guard (project.extensionsEnabled ?? []).isEmpty else { return false }
    guard let repoRoot = project.repoRoot?.lowercased() else { return false }
    let looksLikeWorktree =
      repoRoot.contains("/.codex/worktrees/") || repoRoot.contains("/.git/worktrees/")
    guard looksLikeWorktree else { return false }

    return allProjects.contains { candidate in
      guard candidate.id != project.id else { return false }
      guard candidate.isRuntimeConfigured else { return false }
      return project.name.hasPrefix("\(candidate.name)-")
    }
  }

  private var detail: some View {
    Group {
      switch model.selectedItem {
      case .home:
        HomeDashboardView()
      case .runtime:
        settingsRedirectView(
          title: "Runtime moved to Settings",
          subtitle: "Open Settings to view runtime health, daemon controls, and global services.",
          pane: .runtime
        )
      case .gateway:
        settingsRedirectView(
          title: "Gateway moved to Settings",
          subtitle: "Open Settings to manage gateway status, exposures, and gateway configuration.",
          pane: .gateway
        )
      case let .project(id):
        if let project = model.projects.first(where: { $0.id == id }) {
          ProjectDetailView(project: project)
        } else {
          ContentUnavailableView("Project missing", systemImage: "exclamationmark.triangle")
        }
      case .none:
        ContentUnavailableView("Select a sidebar item", systemImage: "square.stack")
      }
    }
  }

  private func settingsRedirectView(
    title: String,
    subtitle: String,
    pane: SettingsSidebarItem
  ) -> some View {
    VStack(alignment: .center, spacing: 10) {
      Text(title)
        .font(.mono(.headline, weight: .semibold))
      Text(subtitle)
        .font(.mono(.caption))
        .foregroundStyle(.secondary)
      Button {
        openSettings(pane)
      } label: {
        Label("Open Settings", systemImage: "gearshape")
      }
      .adaptiveToolbarButtonProminent()
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
  }

  private func openSettings(_ pane: SettingsSidebarItem) {
    selectedSettingsItem = pane
    showSettingsOverlay = true
  }

  private var footer: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let errorMessage = model.errorMessage {
        Text(errorMessage)
          .font(.mono(.caption))
          .foregroundStyle(.red)
      }
      HStack {
        Text(runtimeLabel)
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
        Spacer()
        if let statusMessage = model.statusMessage {
          BadgePill(label: statusMessage, tint: .secondary)
        }
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .adaptiveFooterBackground()
  }

  private var runtimeLabel: String {
    switch model.runtimeHealthState {
    case .healthy:
      return "Runtime: ok"
    case .down:
      return "Runtime: down"
    case .degraded:
      if model.runtimeOk == false, let error = model.runtimeError, !error.isEmpty {
        return "Runtime: \(error)"
      }
      return "Runtime: degraded"
    case .unknown:
      return "Runtime: unknown"
    }
  }

  private var daemonIsRunning: Bool {
    model.daemonStatus?.resolvedLabel == .running
  }

  private var daemonIsStarting: Bool {
    model.daemonStatus?.resolvedLabel == .starting
  }

  private var canStartDaemon: Bool {
    !(daemonIsRunning || daemonIsStarting)
  }

  private var canStopDaemon: Bool {
    daemonIsRunning || daemonIsStarting
  }

  @ViewBuilder
  private var runtimeContextMenu: some View {
    if canStopDaemon {
      Button {
        Task { await model.stopDaemon() }
      } label: {
        Label("Stop hackd", systemImage: "stop.fill")
      }
    } else {
      Button {
        Task { await model.startDaemon() }
      } label: {
        Label("Start hackd", systemImage: "play.fill")
      }
    }

    Button {
      Task { await model.restartDaemon() }
    } label: {
      Label("Restart hackd", systemImage: "arrow.clockwise")
    }
    .disabled(!daemonIsRunning)

    Divider()

    Button {
      Task { await model.refresh() }
    } label: {
      Label("Refresh", systemImage: "arrow.triangle.2.circlepath")
    }
  }

  @ViewBuilder
  private var gatewayContextMenu: some View {
    Button {
      Task { await model.refresh() }
    } label: {
      Label("Refresh", systemImage: "arrow.triangle.2.circlepath")
    }

    if let configPath = gatewayConfigPath {
      Divider()

      Button {
        NSWorkspace.shared.selectFile(configPath, inFileViewerRootedAtPath: "")
      } label: {
        Label("Show Config in Finder", systemImage: "folder")
      }
    }
  }

  private var gatewayConfigPath: String? {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let configPath = home.appendingPathComponent(".hack/gateway.yml").path
    return FileManager.default.fileExists(atPath: configPath) ? configPath : nil
  }

  @ViewBuilder
  private func projectContextMenu(for project: ProjectSummary) -> some View {
    let isRunning = project.runtimeStatus == .running || project.status == .running

    if isRunning {
      Button {
        Task { await model.stopProject(project) }
      } label: {
        Label("Stop", systemImage: "stop.fill")
      }
    } else {
      Button {
        Task { await model.startProject(project) }
      } label: {
        Label("Start", systemImage: "play.fill")
      }
    }

    Divider()

    Button {
      model.showLogs(for: project)
    } label: {
      Label("View Logs", systemImage: "text.alignleft")
    }

    Button {
      model.showShell(for: project)
    } label: {
      Label("Open Shell", systemImage: "terminal")
    }

    if project.supportsTickets {
      Button {
        model.showTickets(for: project)
      } label: {
        Label("Open Tickets", systemImage: "ticket")
      }
    }

    if let devHost = project.devHost, let url = URL(string: "https://\(devHost)") {
      Divider()

      Button {
        NSWorkspace.shared.open(url)
      } label: {
        Label("Open in Browser", systemImage: "safari")
      }

      Button {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url.absoluteString, forType: .string)
      } label: {
        Label("Copy URL", systemImage: "doc.on.doc")
      }
    }

    if let path = project.repoRoot ?? project.projectDir {
      Divider()

      Button {
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: path)
      } label: {
        Label("Show in Finder", systemImage: "folder")
      }

      Button {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(path, forType: .string)
      } label: {
        Label("Copy Path", systemImage: "doc.on.doc")
      }
    }
  }
}
