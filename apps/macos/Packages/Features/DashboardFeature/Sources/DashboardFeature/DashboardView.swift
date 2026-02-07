import AppKit
import SwiftUI

import HackDesktopModels

public struct DashboardView: View {
  @Environment(DashboardModel.self) private var model
  @State private var showCommandPalette = false
  @State private var showTerminalDrawer = false
  @State private var terminalDrawerHeight: CGFloat = 360
  @State private var terminalDrawerInitialHeight: CGFloat? = nil
  @State private var terminalDrawerModel = TerminalDrawerModel(globalShellProject: Self.makeGlobalShellProject())

  public init() {}

  public var body: some View {
    @Bindable var model = model

    GeometryReader { proxy in
      VSplitView {
        mainSplitView
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

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
      // Attach toolbar at the window root. Nested toolbars inside split views can disappear
      // when additional container views are introduced (e.g. a bottom terminal panel).
      .toolbar {
        ToolbarItem(placement: .principal) {
          GlobalStatusStrip(placement: .titlebar)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        ToolbarItem(placement: .primaryAction) {
          ToolbarIconButton(
            systemImage: "terminal",
            help: "Toggle terminal",
            accessibilityLabel: "Toggle terminal",
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
        guard let project = model.projects.first(where: { $0.id == projectId }) else { return }

        if !showTerminalDrawer {
          terminalDrawerInitialHeight = terminalDrawerHeight
          showTerminalDrawer = true
        }
        terminalDrawerModel.openOrSelect(project: project, kind: kind)
      }
      .sheet(isPresented: $showCommandPalette) {
        CommandPaletteView()
          .environment(model)
      }
      .animation(.easeInOut(duration: 0.18), value: showTerminalDrawer)
    }
  }

  private var mainSplitView: some View {
    NavigationSplitView {
      sidebar
    } detail: {
      detail
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .adaptiveDetailBackground()
    }
    .navigationSplitViewStyle(.balanced)
    .navigationSplitViewColumnWidth(min: 240, ideal: 320, max: 460)
    .controlSize(.small)
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
      meta: nil,
      kind: .unregistered,
      status: .unknown
    )
  }

  private var sidebar: some View {
    @Bindable var model = model

    let extensionProjects = model.projects.filter { $0.isExtensionOnly }
    let runtimeProjects = model.projects.filter { !$0.isExtensionOnly }
    return List(selection: $model.selectedItem) {
      Section("System") {
        RuntimeRowView(isHealthy: model.runtimeOverallOk)
          .tag(SidebarItem.runtime)
          .contextMenu { runtimeContextMenu }
        GatewayRowView(state: model.gatewaySummaryState)
          .tag(SidebarItem.gateway)
          .contextMenu { gatewayContextMenu }
      }
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

  private var detail: some View {
    Group {
      switch model.selectedItem {
      case .runtime:
        RuntimeDetailView()
      case .gateway:
        GatewayDetailView()
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
    if model.runtimeOverallOk == true {
      return "Runtime: ok"
    }
    if model.runtimeOk == false, let error = model.runtimeError, !error.isEmpty {
      return "Runtime: \(error)"
    }
    if model.runtimeOverallOk == false {
      return "Runtime: degraded"
    }
    return "Runtime: unknown"
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

