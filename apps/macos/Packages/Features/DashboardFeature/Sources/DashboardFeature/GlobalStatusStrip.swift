import SwiftUI

import HackDesktopModels

enum GlobalStatusPlacement {
  case content
  case titlebar
}

struct GlobalStatusStrip: View {
  @Environment(DashboardModel.self) private var model
  let placement: GlobalStatusPlacement

  init(placement: GlobalStatusPlacement = .content) {
    self.placement = placement
  }

  var body: some View {
    HStack(spacing: placement == .titlebar ? 8 : 10) {
      selectorPill
      Spacer()
      statusCluster
      if let lastUpdatedText, placement == .titlebar {
        Text(lastUpdatedText)
          .font(.mono(.caption2))
          .foregroundStyle(.secondary)
      }
      Divider()
        .frame(height: 14)
        .opacity(0.3)
      Menu {
        Button("Refresh") {
          Task { await model.refresh() }
        }
        Divider()
        if canStopDaemon {
          Button("Stop hackd") {
            Task { await model.stopDaemon() }
          }
        } else if canStartDaemon {
          Button("Start hackd") {
            Task { await model.startDaemon() }
          }
        }
      } label: {
        Image(systemName: "ellipsis")
          .font(.mono(.title3))
      }
      .menuStyle(.borderlessButton)
      .buttonStyle(PressableCircleButtonStyle())
      .padding(.leading, 2)
    }
    .padding(.vertical, placement == .titlebar ? 2 : 6)
    .padding(.leading, placement == .titlebar ? 10 : 0)
    .padding(.trailing, placement == .titlebar ? 8 : 0)
  }

  private var selectorPill: some View {
    Menu {
      Button("System: Runtime") {
        model.selectedItem = .runtime
      }
      Button("System: Gateway") {
        model.selectedItem = .gateway
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
        Image(systemName: "chevron.down")
          .font(.mono(.caption2, weight: .semibold))
          .foregroundStyle(.secondary)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 6)
      .background(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(.ultraThinMaterial)
          .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .stroke(Color.white.opacity(0.08), lineWidth: 1)
          )
      )
    }
    .menuStyle(.borderlessButton)
  }

  @ViewBuilder
  private var statusCluster: some View {
    switch model.selectedItem {
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
          HStack(spacing: 6) {
            Text(project.runtimeStatusLabel)
              .font(.mono(.caption))
              .foregroundStyle(.secondary)
            RuntimeStatusDot(
              status: project.runtimeStatus ?? fallbackRuntimeStatus(for: project),
              runtimeHealthy: model.runtimeOverallOk
            )
          }
        } else {
          LabelBadge(label: project.featureLabel ?? "Extensions", color: .purple)
        }
      } else {
        StatusPill(text: "Project: unknown", tone: .neutral)
      }
    case .none:
      StatusPill(text: runtimeLabel, tone: runtimeTone)
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

  private var selectorLabel: String {
    if case let .project(id) = model.selectedItem,
       let project = model.projects.first(where: { $0.id == id }) {
      return project.name
    }
    if model.selectedItem == .gateway {
      return "Gateway"
    }
    return "System"
  }

  private var selectorIcon: String {
    switch model.selectedItem {
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
