import AppKit
import SwiftUI

import HackDesktopModels

public struct MenuBarView: View {
  @Environment(DashboardModel.self) private var model
  @Environment(\.openURL) private var openURL

  public init() {}

  public var body: some View {
    // System Status
    systemStatusSection

    Divider()

    // Projects
    projectsSection

    Divider()

    // Footer
    Button("Refresh") {
      Task { await model.refresh() }
    }
    .keyboardShortcut("r", modifiers: .command)

    Button("Open Hack Desktop") {
      activateApp()
    }
    .keyboardShortcut("o", modifiers: .command)

    Divider()

    Button("Quit") {
      NSApp.terminate(nil)
    }
    .keyboardShortcut("q", modifiers: .command)
  }

  // MARK: - System Status

  @ViewBuilder
  private var systemStatusSection: some View {
    let runtimeIcon = runtimeStatusIcon
    let gatewayIcon = gatewayStatusIcon
    let daemonIcon = daemonStatusIcon

    Button {
      // No action - informational
    } label: {
      Label("Runtime: \(runtimeStatusText)", systemImage: runtimeIcon)
    }
    .disabled(true)

    Button {
      // No action - informational
    } label: {
      Label("Gateway: \(gatewayStatusText)", systemImage: gatewayIcon)
    }
    .disabled(true)

    // hackd submenu
    Menu {
      if canStartDaemon {
        Button("Start hackd") {
          Task { await model.startDaemon() }
        }
      }
      if canStopDaemon {
        Button("Stop hackd") {
          Task { await model.stopDaemon() }
        }
      }
      if canRestartDaemon {
        Button("Restart hackd") {
          Task { await model.restartDaemon() }
        }
      }
      if canClearDaemon {
        Divider()
        Button("Clear Stale State") {
          Task { await model.clearDaemon() }
        }
      }
    } label: {
      Label("hackd: \(daemonStatusText)", systemImage: daemonIcon)
    }
  }

  // MARK: - Projects

  @ViewBuilder
  private var projectsSection: some View {
    let projects = Array(runningProjects.prefix(8))

    if projects.isEmpty {
      Button {
        // No action
      } label: {
        Label("No running projects", systemImage: "tray")
      }
      .disabled(true)
    } else {
      ForEach(projects) { project in
        projectMenu(for: project)
      }

      if runningProjects.count > 8 {
        Button {
          activateApp()
        } label: {
          Label("+ \(runningProjects.count - 8) more...", systemImage: "ellipsis")
        }
      }
    }
  }

  @ViewBuilder
  private func projectMenu(for project: ProjectSummary) -> some View {
    let icon = projectIcon(for: project)

    Menu {
      if project.status == .running {
        Button("Stop") {
          Task { await model.stopProject(project) }
        }
      } else {
        Button("Start") {
          Task { await model.startProject(project) }
        }
      }

      if let url = devUrl(for: project) {
        Divider()
        Button("Open in Browser") {
          openURL(url)
        }
      }

      Divider()

      Button("View Logs") {
        activateApp()
        model.showLogs(for: project)
      }

      Button("Open Shell") {
        activateApp()
        model.showShell(for: project)
      }

      if let path = project.repoRoot ?? project.projectDir {
        Divider()
        Button("Show in Finder") {
          NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: path)
        }
      }
    } label: {
      Label(projectLabel(for: project), systemImage: icon)
    }
  }

  // MARK: - Status Helpers

  private var runtimeStatusText: String {
    if model.runtimeOverallOk == true { return "Healthy" }
    if model.runtimeOverallOk == false { return "Degraded" }
    return "Unknown"
  }

  private var runtimeStatusIcon: String {
    if model.runtimeOverallOk == true { return "checkmark.circle.fill" }
    if model.runtimeOverallOk == false { return "exclamationmark.triangle.fill" }
    return "questionmark.circle"
  }

  private var gatewayStatusText: String {
    model.gatewaySummaryState?.label ?? "Unknown"
  }

  private var gatewayStatusIcon: String {
    guard let state = model.gatewaySummaryState else { return "questionmark.circle" }
    switch state {
    case .running: return "checkmark.circle.fill"
    case .configured: return "gear.circle"
    case .disabled: return "minus.circle"
    case .unknown: return "questionmark.circle"
    }
  }

  private var daemonStatusText: String {
    switch model.daemonStatus?.resolvedLabel {
    case .running: return "Running"
    case .starting: return "Starting"
    case .stale: return "Stale"
    case .stopped: return "Stopped"
    case .none: return "Unknown"
    }
  }

  private var daemonStatusIcon: String {
    switch model.daemonStatus?.resolvedLabel {
    case .running: return "checkmark.circle.fill"
    case .starting: return "clock.fill"
    case .stale: return "exclamationmark.triangle.fill"
    case .stopped: return "stop.circle"
    case .none: return "questionmark.circle"
    }
  }

  private var canStartDaemon: Bool {
    let label = model.daemonStatus?.resolvedLabel
    return label != .running && label != .starting
  }

  private var canStopDaemon: Bool {
    let label = model.daemonStatus?.resolvedLabel
    return label == .running || label == .starting
  }

  private var canRestartDaemon: Bool {
    model.daemonStatus?.resolvedLabel == .running
  }

  private var canClearDaemon: Bool {
    model.daemonStatus?.stale == true
  }

  // MARK: - Project Helpers

  private func projectLabel(for project: ProjectSummary) -> String {
    if let host = project.devHost {
      return "\(project.name) — \(host)"
    }
    return project.name
  }

  private func projectIcon(for project: ProjectSummary) -> String {
    guard project.isRuntimeConfigured else { return "puzzlepiece" }

    let status = project.runtimeStatus ?? fallbackStatus(for: project)
    if status == .running && model.runtimeOverallOk == false {
      return "exclamationmark.circle.fill"
    }

    switch status {
    case .running: return "circle.fill"
    case .stopped: return "circle"
    case .missing: return "xmark.circle.fill"
    case .unknown: return "questionmark.circle"
    case .notConfigured: return "circle"
    }
  }

  private func fallbackStatus(for project: ProjectSummary) -> ProjectRuntimeStatus {
    switch project.status {
    case .running: return .running
    case .stopped: return .stopped
    case .missing: return .missing
    case .unknown, .unregistered: return .unknown
    }
  }

  private var menuProjects: [ProjectSummary] {
    model.projects.sorted { left, right in
      let leftRank = projectRank(left)
      let rightRank = projectRank(right)
      if leftRank != rightRank { return leftRank < rightRank }
      return left.name.localizedCaseInsensitiveCompare(right.name) == .orderedAscending
    }
  }

  private func projectRank(_ project: ProjectSummary) -> Int {
    if project.status == .running { return 0 }
    if project.isRuntimeConfigured { return 1 }
    if project.isExtensionOnly { return 2 }
    return 3
  }

  private var runtimeProjects: [ProjectSummary] {
    menuProjects.filter { $0.isRuntimeConfigured }
  }

  private var runningProjects: [ProjectSummary] {
    runtimeProjects.filter { $0.status == .running }
  }

  private func devUrl(for project: ProjectSummary) -> URL? {
    guard let host = project.devHost, !host.isEmpty else { return nil }
    if host.contains("://") { return URL(string: host) }
    return URL(string: "https://\(host)")
  }

  private func activateApp() {
    NSApp.activate(ignoringOtherApps: true)
    if let window = NSApp.windows.first(where: { $0.canBecomeMain }) {
      window.makeKeyAndOrderFront(nil)
    }
  }
}
