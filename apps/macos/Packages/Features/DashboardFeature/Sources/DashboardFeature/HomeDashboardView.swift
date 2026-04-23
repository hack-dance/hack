import SwiftUI

import HackDesktopModels

struct HomeDashboardView: View {
  @Environment(DashboardModel.self) private var model
  @AppStorage("hackDesktop.preferences.defaultTerminal") private var preferredExternalTerminalRaw =
    TerminalIntegration.ExternalTerminalApp.terminal.rawValue
  @AppStorage("hackDesktop.sessions.preferredExternalTerminal") private var legacyPreferredExternalTerminalRaw =
    TerminalIntegration.ExternalTerminalApp.terminal.rawValue
  @State private var showDetachedSessions = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        healthCard
        sessionsCard
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
          emptyMessage: "No running projects.",
          topSpacing: 0
        )
        projectGroupSection(
          title: "Not running",
          count: stoppedProjects.count,
          projects: stoppedProjects,
          emptyMessage: "No stopped projects.",
          topSpacing: runningProjects.isEmpty ? 0 : 12
        )
      }
    }
  }

  private var sessionsCard: some View {
    GlassCard(title: "Sessions", systemImage: "rectangle.3.group.bubble.left") {
      VStack(alignment: .leading, spacing: 10) {
        HStack(spacing: 8) {
          Text("\(activeSessions.count) active")
            .font(.mono(.caption))
            .foregroundStyle(.secondary)
          Text("(\(attachedSessions.count) attached, \(detachedSessions.count) detached)")
            .font(.mono(.caption))
            .foregroundStyle(.secondary)
          Spacer(minLength: 0)
        }

        if activeSessions.isEmpty {
          Text("No active hack sessions.")
            .font(.mono(.caption))
            .foregroundStyle(.secondary)
            .padding(.leading, 8)
        } else {
          VStack(alignment: .leading, spacing: 0) {
            if !attachedSessions.isEmpty {
              sessionGroupSection(
                title: "Attached",
                count: attachedSessions.count,
                entries: attachedSessions,
                topSpacing: 0
              )
            }
            if attachedSessions.isEmpty && !detachedSessions.isEmpty && !showDetachedSessions {
              Text("No attached sessions.")
                .font(.mono(.caption))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
            }
            if !detachedSessions.isEmpty {
              HStack(spacing: 8) {
                Button {
                  withAnimation(.easeInOut(duration: 0.16)) {
                    showDetachedSessions.toggle()
                  }
                } label: {
                  Label(
                    showDetachedSessions ? "Hide detached sessions" : "Show detached sessions",
                    systemImage: showDetachedSessions ? "eye.slash" : "eye"
                  )
                  .labelStyle(.titleAndIcon)
                }
                .buttonStyle(PressableIconButtonStyle())

                BadgePill(label: "\(detachedSessions.count) detached", tint: .secondary)
                Spacer()
              }
              .padding(.horizontal, 8)

              if showDetachedSessions {
                sessionGroupSection(
                  title: "Detached",
                  count: detachedSessions.count,
                  entries: detachedSessions,
                  topSpacing: attachedSessions.isEmpty ? 0 : 12
                )
              }
            }
          }
        }
      }
    }
  }

  @ViewBuilder
  private func projectGroupSection(
    title: String,
    count: Int,
    projects: [ProjectSummary],
    emptyMessage: String,
    topSpacing: CGFloat
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
    .padding(.top, topSpacing)
    .padding(.horizontal, 8)
    .padding(.bottom, 3)

    if projects.isEmpty {
      Text(emptyMessage)
        .font(.mono(.caption))
        .foregroundStyle(.secondary)
        .padding(.leading, 14)
        .padding(.bottom, 2)
    } else {
      VStack(spacing: 0) {
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
      .padding(.leading, 14)
    }
  }

  @ViewBuilder
  private func sessionGroupSection(
    title: String,
    count: Int,
    entries: [DashboardSessionEntry],
    topSpacing: CGFloat
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
    .padding(.top, topSpacing)
    .padding(.horizontal, 8)
    .padding(.bottom, 2)

    VStack(spacing: 0) {
      ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
        sessionRow(entry)
        if index != entries.count - 1 {
          Divider()
            .opacity(0.2)
        }
      }
    }
    .padding(.leading, 14)
  }

  @ViewBuilder
  private func sessionRow(_ entry: DashboardSessionEntry) -> some View {
    HStack(alignment: .center, spacing: 10) {
      VStack(alignment: .leading, spacing: 5) {
        HStack(spacing: 6) {
          Text(entry.session.name)
            .font(.mono(.subheadline, weight: .semibold))
          BadgePill(label: entry.session.backend.rawValue, tint: .secondary)
          BadgePill(label: entry.session.source == .hack ? "hack" : "external", tint: .secondary)
          BadgePill(label: entry.session.attached ? "attached" : "detached", tint: entry.session.attached ? .green : .orange)
        }

        HStack(spacing: 6) {
          if let project = entry.project {
            Text(project.name)
              .font(.mono(.caption))
              .foregroundStyle(.secondary)
            if let host = project.devHost, !host.isEmpty {
              Text(host)
                .font(.mono(.caption2))
                .foregroundStyle(.tertiary)
            }
          } else {
            Text("No linked project")
              .font(.mono(.caption))
              .foregroundStyle(.secondary)
          }
        }
      }

      Spacer(minLength: 8)

      HStack(spacing: 6) {
        if let project = entry.project {
          Button {
            model.selectedItem = .project(project.id)
            model.selectedProjectTab = .sessions
          } label: {
            Label("Project", systemImage: "shippingbox")
              .labelStyle(.titleAndIcon)
          }
          .adaptiveToolbarButton()
        }

        Menu {
          sessionAttachMenuItems(for: entry)
        } label: {
          Label("Attach", systemImage: "terminal")
            .labelStyle(.titleAndIcon)
        }
        .adaptiveToolbarButtonProminent()

        Button("Stop") {
          Task { await model.stopSession(name: entry.session.name) }
        }
        .adaptiveToolbarButton()
      }
      .controlSize(.small)
    }
    .padding(.leading, 8)
    .padding(.vertical, 5)
  }

  @ViewBuilder
  private func sessionAttachMenuItems(for entry: DashboardSessionEntry) -> some View {
    ForEach(availableSessionOpenTargets, id: \.self) { terminalApp in
      Button {
        attachSession(entry, terminalApp: terminalApp)
      } label: {
        Label(
          "Attach in \(terminalApp.displayName)",
          systemImage: terminalApp == preferredExternalTerminal ? "checkmark.circle.fill" : "circle"
        )
      }
    }
  }

  private func attachSession(
    _ entry: DashboardSessionEntry,
    terminalApp: TerminalIntegration.ExternalTerminalApp
  ) {
    preferredExternalTerminalRaw = terminalApp.rawValue
    legacyPreferredExternalTerminalRaw = terminalApp.rawValue

    let command = attachCommand(for: entry.session)
    if terminalApp == .hackDesktop {
      let projectId = entry.project?.id ?? "global-shell"
      NotificationCenter.default.post(
        name: .hackTerminalOpenRequested,
        object: nil,
        userInfo: [
          TerminalOpenRequest.projectIdKey: projectId,
          TerminalOpenRequest.kindKey: TerminalDrawerModel.Kind.shell.rawValue,
          TerminalOpenRequest.commandKey: command,
          TerminalOpenRequest.titleKey: "\(entry.session.name) (attached)"
        ]
      )
      return
    }

    TerminalIntegration.openExternalTerminalWithCommand(command, app: terminalApp)
  }

  private func attachCommand(for session: ProjectSessionSummary) -> String {
    switch session.backend {
    case .tmux:
      return "env -u TMUX tmux attach -d -t \(shellQuote(session.name))"
    case .zellij:
      return "zellij attach \(shellQuote(session.name))"
    }
  }

  private func shellQuote(_ value: String) -> String {
    if value.isEmpty {
      return "''"
    }
    return "'\(value.replacingOccurrences(of: "'", with: "'\"'\"'"))'"
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

  private var activeSessions: [DashboardSessionEntry] {
    var seen = Set<String>()
    var sessions: [DashboardSessionEntry] = []

    for project in model.projects {
      for session in project.sessions ?? [] {
        let key = "\(session.backend.rawValue):\(session.name)"
        guard seen.insert(key).inserted else { continue }
        sessions.append(DashboardSessionEntry(session: session, project: project))
      }
    }

    return sessions.sorted { lhs, rhs in
      if lhs.session.attached != rhs.session.attached {
        return lhs.session.attached && !rhs.session.attached
      }
      let lhsCreated = lhs.session.createdAt ?? 0
      let rhsCreated = rhs.session.createdAt ?? 0
      if lhsCreated != rhsCreated {
        return lhsCreated > rhsCreated
      }
      return lhs.session.name.localizedCaseInsensitiveCompare(rhs.session.name) == .orderedAscending
    }
  }

  private var attachedSessions: [DashboardSessionEntry] {
    activeSessions.filter { $0.session.attached }
  }

  private var detachedSessions: [DashboardSessionEntry] {
    activeSessions.filter { !$0.session.attached }
  }

  private var preferredExternalTerminal: TerminalIntegration.ExternalTerminalApp {
    if let explicit = TerminalIntegration.ExternalTerminalApp(rawValue: preferredExternalTerminalRaw) {
      return explicit
    }
    if let legacy = TerminalIntegration.ExternalTerminalApp(rawValue: legacyPreferredExternalTerminalRaw) {
      return legacy
    }
    return .hackDesktop
  }

  private var availableSessionOpenTargets: [TerminalIntegration.ExternalTerminalApp] {
    let installed = TerminalIntegration.installedExternalTerminalApps()
    var ordered: [TerminalIntegration.ExternalTerminalApp] = [.hackDesktop]
    if installed.isEmpty {
      ordered.append(.terminal)
    } else if installed.contains(preferredExternalTerminal) {
      ordered.append(contentsOf: installed)
    } else {
      ordered.append(preferredExternalTerminal)
      ordered.append(contentsOf: installed)
    }

    var seen = Set<TerminalIntegration.ExternalTerminalApp>()
    return ordered.filter { seen.insert($0).inserted }
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

private struct DashboardSessionEntry: Identifiable, Hashable {
  let session: ProjectSessionSummary
  let project: ProjectSummary?

  var id: String {
    "\(session.id)::\(project?.id ?? "unlinked")"
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
      .padding(.vertical, 7)
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
