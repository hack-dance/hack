import SwiftUI

import HackDesktopModels

struct HomeDashboardView: View {
  @Environment(DashboardModel.self) private var model

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        healthCard
        projectsCard
      }
      .padding(16)
    }
  }

  private var healthCard: some View {
    GlassCard(title: "System health", systemImage: "waveform.path.ecg") {
      VStack(alignment: .leading, spacing: 12) {
        HStack(spacing: 10) {
          HealthMetricChip(title: "Runtime", value: runtimeState.label, tone: runtimeState.tone)
          HealthMetricChip(title: "Daemon", value: daemonState.label, tone: daemonState.tone)
          HealthMetricChip(title: "Gateway", value: gatewayState.label, tone: gatewayState.tone)
          HealthMetricChip(title: "Global", value: globalState.label, tone: globalState.tone)
          Spacer(minLength: 0)
        }
        Text("\(model.projects.count) project\(model.projects.count == 1 ? "" : "s") registered")
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
      }
    }
  }

  private var projectsCard: some View {
    GlassCard(title: "Projects", systemImage: "shippingbox") {
      VStack(alignment: .leading, spacing: 0) {
        projectGroupSection(
          title: "Running",
          count: runningProjects.count,
          projects: runningProjects,
          emptyMessage: "No running projects."
        )
        Divider()
          .opacity(0.24)
          .padding(.vertical, 8)
        projectGroupSection(
          title: "Not running",
          count: stoppedProjects.count,
          projects: stoppedProjects,
          emptyMessage: "No stopped projects."
        )
      }
    }
  }

  @ViewBuilder
  private func projectGroupSection(
    title: String,
    count: Int,
    projects: [ProjectSummary],
    emptyMessage: String
  ) -> some View {
    HStack(alignment: .center, spacing: 8) {
      Text(title)
        .font(.mono(.caption, weight: .semibold))
        .foregroundStyle(.secondary)
      Text("\(count)")
        .font(.mono(.caption))
        .foregroundStyle(.secondary)
      Spacer()
    }
    .padding(.horizontal, 2)
    .padding(.bottom, 8)

    if projects.isEmpty {
      Text(emptyMessage)
        .font(.mono(.caption))
        .foregroundStyle(.secondary)
        .padding(.bottom, 8)
    } else {
      ForEach(Array(projects.enumerated()), id: \.element.id) { index, project in
        ProjectListRow(project: project) {
          model.selectedItem = .project(project.id)
        }
        if index != projects.count - 1 {
          Divider()
            .opacity(0.2)
        }
      }
    }
  }

  private var runningProjects: [ProjectSummary] {
    model.projects.filter { isProjectRunning($0) }
  }

  private var stoppedProjects: [ProjectSummary] {
    model.projects.filter { !isProjectRunning($0) }
  }

  private func isProjectRunning(_ project: ProjectSummary) -> Bool {
    project.status == .running || project.runtimeStatus == .running
  }

  private var runtimeState: (label: String, tone: HealthMetricChip.Tone) {
    switch model.runtimeHealthState {
    case .healthy:
      return ("Healthy", .good)
    case .down:
      return ("Down", .warn)
    case .degraded:
      return ("Degraded", .warn)
    case .unknown:
      return ("Unknown", .neutral)
    }
  }

  private var daemonState: (label: String, tone: HealthMetricChip.Tone) {
    switch model.daemonStatus?.resolvedLabel {
    case .running:
      return ("Running", .good)
    case .starting:
      return ("Starting", .warn)
    case .stale:
      return ("Stale", .warn)
    case .stopped:
      return ("Stopped", .warn)
    case nil:
      return ("Unknown", .neutral)
    }
  }

  private var gatewayState: (label: String, tone: HealthMetricChip.Tone) {
    if let state = model.gatewaySummaryState {
      switch state.tone {
      case .good:
        return (state.label, .good)
      case .warn:
        return (state.label, .warn)
      case .neutral:
        return (state.label, .neutral)
      }
    }
    return ("Unknown", .neutral)
  }

  private var globalState: (label: String, tone: HealthMetricChip.Tone) {
    if model.globalInfraRunning {
      return ("Running", .good)
    }
    if model.globalInfraDown {
      return ("Down", .warn)
    }
    return ("Unknown", .neutral)
  }
}

private struct ProjectListRow: View {
  let project: ProjectSummary
  let action: () -> Void
  @State private var isHovered = false

  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) {
        Circle()
          .fill(statusColor)
          .frame(width: 7, height: 7)

        VStack(alignment: .leading, spacing: 3) {
          Text(project.name)
            .font(.mono(.subheadline, weight: .semibold))
          if let host = project.devHost, !host.isEmpty {
            Text(host)
              .font(.mono(.caption2))
              .foregroundStyle(.secondary)
          }
        }
        Spacer()
        Text(statusText)
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
      }
      .padding(.horizontal, 2)
      .padding(.vertical, 9)
      .contentShape(Rectangle())
      .background(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(isHovered ? Color.primary.opacity(0.06) : .clear)
      )
    }
    .buttonStyle(.plain)
    .onHover { hovering in
      isHovered = hovering
    }
  }

  private var statusColor: Color {
    if project.status == .running || project.runtimeStatus == .running { return .green }
    if project.status == .missing { return .orange }
    return .secondary
  }

  private var statusText: String {
    if project.status == .running || project.runtimeStatus == .running { return "Running" }
    if project.status == .missing { return "Missing" }
    return "Stopped"
  }
}

private struct HealthMetricChip: View {
  enum Tone {
    case good
    case warn
    case neutral
  }

  let title: String
  let value: String
  let tone: Tone

  var body: some View {
    HStack(spacing: 6) {
      Circle()
        .fill(indicatorColor)
        .frame(width: 7, height: 7)
      Text(title)
        .font(.mono(.caption))
        .foregroundStyle(.secondary)
      Text(value)
        .font(.mono(.caption, weight: .semibold))
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 6)
    .background(
      Capsule(style: .continuous)
        .fill(.thinMaterial)
    )
    .overlay(
      Capsule(style: .continuous)
        .stroke(Color.primary.opacity(0.12), lineWidth: 1)
    )
  }

  private var indicatorColor: Color {
    switch tone {
    case .good:
      return .green
    case .warn:
      return .orange
    case .neutral:
      return .secondary
    }
  }
}
