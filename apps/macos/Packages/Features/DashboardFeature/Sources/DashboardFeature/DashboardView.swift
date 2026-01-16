import AppKit
import SwiftUI

import HackDesktopModels


public struct DashboardView: View {
  @Environment(DashboardModel.self) private var model

  public init() {}

  public var body: some View {
    @Bindable var model = model

    NavigationSplitView {
      sidebar
    } detail: {
      detail
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .adaptiveDetailBackground()
    }
    .navigationSplitViewStyle(.balanced)
    .navigationSplitViewColumnWidth(min: 240, ideal: 320, max: 460)
    .navigationTitle("Hack Desktop")
    .adaptiveWindowBackground()
    .task {
      model.start()
    }
    .toolbar {
      ToolbarItemGroup(placement: .primaryAction) {
        Button("Refresh") {
          Task { await model.refresh() }
        }
        .adaptiveToolbarButton()
        if canStopDaemon {
          Button("Stop hackd") {
            Task { await model.stopDaemon() }
          }
          .adaptiveToolbarButton()
        } else if canStartDaemon {
          Button("Start hackd") {
            Task { await model.startDaemon() }
          }
          .adaptiveToolbarButtonProminent()
        }
      }
    }
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
              .font(.subheadline)
              .foregroundStyle(.secondary)
            Text("Run `hack init` in a project directory to register it.")
              .font(.caption)
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
          .font(.caption)
          .foregroundStyle(.red)
      }
      HStack {
        Text(runtimeLabel)
          .font(.caption)
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
