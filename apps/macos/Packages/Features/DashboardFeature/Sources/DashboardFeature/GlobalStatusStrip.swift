import AppKit
import SwiftUI

import HackDesktopModels

enum GlobalStatusPlacement {
  case content
  case titlebar
}

struct GlobalStatusStrip: View {
  @Environment(DashboardModel.self) private var model
  @Environment(\.colorScheme) private var colorScheme
  let placement: GlobalStatusPlacement

  init(placement: GlobalStatusPlacement = .content) {
    self.placement = placement
  }

  var body: some View {
    HStack(spacing: placement == .titlebar ? 10 : 10) {
      selectorPill
      if placement != .titlebar {
        Spacer()
      }
      statusCluster
      if let lastUpdatedText, placement == .titlebar {
        Text(lastUpdatedText)
          .font(.mono(.caption2))
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .truncationMode(.tail)
      }
      titlebarProjectActionControl
      if placement == .titlebar {
        Divider()
          .frame(height: 14)
          .opacity(0.25)
      }
      Menu {
        Button("Refresh") {
          Task { await model.refresh() }
        }

        if let project = selectedProject {
          Divider()

          Menu("Project") {
            if canStopProject(project) {
              Button("Stop") {
                Task { await model.stopProject(project) }
              }
            } else if canStartProject(project) {
              Button("Start") {
                Task { await model.startProject(project) }
              }
            }

            if let url = devUrl(for: project) {
              Button("Open in Browser") {
                NSWorkspace.shared.open(url)
              }
            }

            Divider()

            Button("View Logs") {
              openTerminal(project: project, kind: .logs)
            }
            Button("Open Shell") {
              openTerminal(project: project, kind: .shell)
            }

            if project.supportsTickets {
              Divider()
              Button("Open Tickets") {
                model.selectedItem = .project(project.id)
                model.selectedProjectTab = .tickets
              }
            }
          }
        }

        Divider()

        Menu("Daemon") {
          if canStopDaemon {
            Button("Stop hackd") {
              Task { await model.stopDaemon() }
            }
          } else if canStartDaemon {
            Button("Start hackd") {
              Task { await model.startDaemon() }
            }
          }
        }
      } label: {
        Image(systemName: "ellipsis")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(.primary.opacity(0.85))
          .frame(width: 22, height: 22)
          .background(
            Circle()
              .strokeBorder(
                colorScheme == .dark ? Color.white.opacity(0.14) : Color.black.opacity(0.10),
                lineWidth: 1
              )
              .background(Circle().fill(Color.clear))
          )
          .contentShape(Circle())
      }
      .menuStyle(.borderlessButton)
      .menuIndicator(.hidden)
      .buttonStyle(.plain)
    }
    .frame(minHeight: placement == .titlebar ? 30 : 0)
    .padding(.horizontal, placement == .titlebar ? 10 : 0)
    .padding(.vertical, placement == .titlebar ? 4 : 6)
    .background(titlebarPillBackground)
    .fixedSize(horizontal: placement == .titlebar, vertical: false)
    .animation(.easeInOut(duration: 0.18), value: stripLayoutSignature)
  }

  private var selectorPill: some View {
    Menu {
      Button("Home") {
        model.selectedItem = .home
      }
      Divider()
      Button("Settings: Runtime") {
        NotificationCenter.default.post(
          name: .hackSettingsRequested,
          object: nil,
          userInfo: [SettingsNavigationRequest.paneKey: SettingsSidebarItem.runtime.rawValue]
        )
      }
      Button("Settings: Gateway") {
        NotificationCenter.default.post(
          name: .hackSettingsRequested,
          object: nil,
          userInfo: [SettingsNavigationRequest.paneKey: SettingsSidebarItem.gateway.rawValue]
        )
      }
      Divider()
      ForEach(model.projects) { project in
        Button(project.name) {
          model.selectedItem = .project(project.id)
        }
      }
    } label: {
      HStack(spacing: 8) {
        Image(systemName: selectorIcon)
          .font(.mono(.caption, weight: .semibold))
        Text(selectorLabel)
          .font(.mono(.caption, weight: .semibold))
          .lineLimit(1)
          .truncationMode(.tail)
          .frame(maxWidth: placement == .titlebar ? 220 : .infinity, alignment: .leading)
        Image(systemName: "chevron.down")
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(.secondary)
          .offset(y: 0.5)
      }
      .padding(.horizontal, placement == .titlebar ? 4 : 12)
      .padding(.vertical, placement == .titlebar ? 2 : 6)
      .background(selectorBackground)
    }
    .menuStyle(.borderlessButton)
    .menuIndicator(.hidden)
  }

  @ViewBuilder
  private var selectorBackground: some View {
    if placement == .titlebar {
      EmptyView()
    } else {
      selectorPillBackground
    }
  }

  @ViewBuilder
  private var titlebarPillBackground: some View {
    if placement == .titlebar {
      RoundedRectangle(cornerRadius: 999, style: .continuous)
        .fill(colorScheme == .dark ? AnyShapeStyle(.regularMaterial) : AnyShapeStyle(Color.white.opacity(0.78)))
        .overlay(
          RoundedRectangle(cornerRadius: 999, style: .continuous)
            .strokeBorder(
              colorScheme == .dark ? Color.white.opacity(0.10) : Color.black.opacity(0.08),
              lineWidth: 1
            )
        )
        .shadow(color: Color.black.opacity(0.10), radius: 18, x: 0, y: 10)
    } else {
      EmptyView()
    }
  }

  @ViewBuilder
  private var selectorPillBackground: some View {
    if colorScheme == .dark {
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(.regularMaterial)
        .overlay(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(Color.white.opacity(0.10), lineWidth: 1)
        )
    } else if #available(macOS 26, *) {
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(Color.white.opacity(0.90))
        .overlay(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(Color.black.opacity(0.10), lineWidth: 1)
        )
    } else {
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(.ultraThinMaterial)
        .overlay(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)
        )
    }
  }

  @ViewBuilder
  private var statusCluster: some View {
    switch model.selectedItem {
    case .home:
      HStack(spacing: 8) {
        StatusPill(text: runtimeLabel, tone: runtimeTone)
        StatusPill(text: gatewayLabel, tone: gatewayTone)
      }
    case .runtime:
      HStack(spacing: 8) {
        StatusPill(text: runtimeLabel, tone: runtimeTone)
        StatusPill(text: daemonLabel, tone: daemonTone)
      }
    case .gateway:
      StatusPill(text: gatewayLabel, tone: gatewayTone)
    case let .project(id):
      if let project = model.projects.first(where: { $0.id == id }) {
        if project.isRuntimeConfigured {
          projectRuntimeCluster(for: project)
        } else if project.status == .missing {
          StatusPill(text: "Project missing", tone: .warn)
        } else if project.isExtensionOnly {
          LabelBadge(label: project.featureLabel ?? "Extensions", color: .purple)
        } else {
          StatusPill(text: "Runtime not configured", tone: .neutral)
        }
      } else {
        StatusPill(text: "Project: unknown", tone: .neutral)
      }
    case .none:
      StatusPill(text: runtimeLabel, tone: runtimeTone)
    }
  }

  private func projectRuntimeCluster(for project: ProjectSummary) -> some View {
    HStack(spacing: 8) {
      Text(project.runtimeStatusLabel)
        .font(.mono(.caption))
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .truncationMode(.tail)
      RuntimeStatusDot(
        status: project.runtimeStatus ?? fallbackRuntimeStatus(for: project),
        runtimeHealthy: model.runtimeOverallOk
      )
    }
  }

  @ViewBuilder
  private var titlebarProjectActionControl: some View {
    if placement == .titlebar,
       let project = selectedProject,
       project.isRuntimeConfigured {
      projectActionControl(for: project)
    }
  }

  @ViewBuilder
  private func projectActionControl(for project: ProjectSummary) -> some View {
    if let action = model.projectLifecycleActions[project.id] {
      HStack(spacing: 4) {
        ProgressView()
          .controlSize(.small)
        Text(action == .starting ? "Starting…" : "Stopping…")
          .font(.mono(.caption2))
          .foregroundStyle(.secondary)
      }
      .padding(.horizontal, 6)
      .padding(.vertical, 3)
      .background(
        Capsule(style: .continuous)
          .fill(colorScheme == .dark ? Color.white.opacity(0.07) : Color.black.opacity(0.04))
      )
    } else if canStopProject(project) {
      Button {
        Task { await model.stopProject(project) }
      } label: {
        Image(systemName: "stop.fill")
          .font(.system(size: 10, weight: .semibold))
          .frame(width: 18, height: 18)
      }
      .buttonStyle(PressableCircleButtonStyle())
      .help("Stop project")
    } else if canStartProject(project) {
      Button {
        Task { await model.startProject(project) }
      } label: {
        Image(systemName: "play.fill")
          .font(.system(size: 10, weight: .semibold))
          .frame(width: 18, height: 18)
      }
      .buttonStyle(PressableCircleButtonStyle())
      .help("Start project")
    }
  }

  private var runtimeLabel: String {
    if model.runtimeOverallOk == true { return "Runtime: healthy" }
    if model.runtimeOverallOk == false { return "Runtime: degraded" }
    return "Runtime: unknown"
  }

  private var runtimeTone: StatusTone {
    if model.runtimeOverallOk == true { return .good }
    if model.runtimeOverallOk == false { return .warn }
    return .neutral
  }

  private var daemonLabel: String {
    guard let label = model.daemonStatus?.resolvedLabel else { return "Daemon: unknown" }
    return "Daemon: \(label.rawValue)"
  }

  private var daemonTone: StatusTone {
    guard let label = model.daemonStatus?.resolvedLabel else { return .neutral }
    switch label {
    case .running:
      return .good
    case .starting:
      return .warn
    case .stale, .stopped:
      return .warn
    }
  }

  private var gatewayLabel: String {
    if let label = model.gatewaySummaryState?.label, !label.isEmpty {
      return "Gateway: \(label)"
    }
    return "Gateway: unknown"
  }

  private var gatewayTone: StatusTone {
    model.gatewaySummaryState?.tone ?? .neutral
  }

  private var lastUpdatedText: String? {
    guard let date = model.lastUpdated else { return nil }
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .abbreviated
    let now = Date()
    if date > now {
      return "Updated just now"
    }
    let delta = now.timeIntervalSince(date)
    if delta < 5 {
      return "Updated just now"
    }
    return "Updated \(formatter.localizedString(for: date, relativeTo: now))"
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

  private var selectedProject: ProjectSummary? {
    guard case let .project(id) = model.selectedItem else { return nil }
    return model.projects.first(where: { $0.id == id })
  }

  private var stripLayoutSignature: String {
    let selectedKey: String = switch model.selectedItem {
    case .home:
      "home"
    case .runtime:
      "runtime"
    case .gateway:
      "gateway"
    case let .project(id):
      "project:\(id)"
    case .none:
      "none"
    }
    let projectAction = selectedProject.flatMap { project in
      model.projectLifecycleActions[project.id]
    }
    let actionKey: String = switch projectAction {
    case .starting:
      "starting"
    case .stopping:
      "stopping"
    case .none:
      "idle"
    }
    return "\(selectedKey)|\(selectorLabel)|\(actionKey)|\(lastUpdatedText ?? "")"
  }

  private func canStartProject(_ project: ProjectSummary) -> Bool {
    project.isRuntimeConfigured
      && (project.status == .stopped || project.status == .unknown || project.status == .unregistered)
  }

  private func canStopProject(_ project: ProjectSummary) -> Bool {
    project.isRuntimeConfigured && project.status == .running
  }

  private func devUrl(for project: ProjectSummary) -> URL? {
    guard let host = project.devHost?.trimmingCharacters(in: .whitespacesAndNewlines), !host.isEmpty else {
      return nil
    }
    if host.contains("://") {
      return URL(string: host)
    }
    return URL(string: "https://\(host)")
  }

  private func openTerminal(project: ProjectSummary, kind: TerminalDrawerModel.Kind) {
    NotificationCenter.default.post(
      name: .hackTerminalOpenRequested,
      object: nil,
      userInfo: [
        TerminalOpenRequest.projectIdKey: project.id,
        TerminalOpenRequest.kindKey: kind.rawValue
      ]
    )
  }

  private var selectorLabel: String {
    if case let .project(id) = model.selectedItem,
       let project = model.projects.first(where: { $0.id == id }) {
      return project.name
    }
    if model.selectedItem == .home {
      return "Dashboard"
    }
    if model.selectedItem == .gateway {
      return "Gateway"
    }
    return "System"
  }

  private var selectorIcon: String {
    switch model.selectedItem {
    case .home:
      return "square.grid.2x2"
    case .gateway:
      return "dot.radiowaves.left.and.right"
    case .runtime:
      return "gauge.with.dots.needle.50percent"
    case .project:
      return "cube.transparent"
    case .none:
      return "gauge.with.dots.needle.50percent"
    }
  }

  private func fallbackRuntimeStatus(for project: ProjectSummary) -> ProjectRuntimeStatus {
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
}
