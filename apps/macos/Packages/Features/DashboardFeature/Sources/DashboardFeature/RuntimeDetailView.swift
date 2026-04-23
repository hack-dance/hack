import SwiftUI

import HackDesktopModels

struct RuntimeDetailView: View {
  @Environment(DashboardModel.self) private var model
  @State private var showDaemonDetails = false
  @State private var showRuntimeDetails = false
  @AppStorage("hackDesktop.setupGuidance.runtime.dismissed") private var setupDismissed = false
  @State private var showSetupAssistant = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        header
        if shouldShowSetupGuidance {
          setupNudge
        }
        statusSummaryBar
        daemonCard
        runtimeCard
        globalServicesSection
      }
      .padding(16)
    }
    .sheet(isPresented: $showSetupAssistant) {
      SetupAssistantView(initialSection: .runtime)
        .environment(model)
    }
  }

  private var shouldShowSetupGuidance: Bool {
    if ProcessInfo.processInfo.environment["HACK_DESKTOP_FORCE_SETUP_GUIDANCE"] == "1" { return true }

    if setupDismissed { return false }

    // Fresh machines commonly need global install + CA trust. If we can't fetch global status, guide them.
    if model.globalStatus == nil { return true }
    return false
  }

  private var setupNudge: some View {
    SetupNudgeCard(
      title: "First-time setup",
      subtitle: "Looks like this machine isn't set up yet. Run the setup steps once (some will prompt for sudo).",
      primaryActionLabel: "Setup…",
      onPrimaryAction: { showSetupAssistant = true },
      onDismiss: { setupDismissed = true }
    )
  }

  private var statusSummaryBar: some View {
    HStack(spacing: 16) {
      statusIndicator(
        label: "Daemon",
        isOk: daemonIsRunning,
        icon: daemonIsRunning ? "bolt.horizontal.fill" : "bolt.horizontal"
      )
      statusIndicator(
        label: "Runtime",
        isOk: model.runtimeOverallOk == true,
        icon: model.runtimeOverallOk == true ? "checkmark.seal.fill" : "checkmark.seal"
      )
      statusIndicator(
        label: "Services",
        isOk: model.globalStatus?.summary.ok == true,
        icon: model.globalStatus?.summary.ok == true ? "network" : "network.slash"
      )
      Spacer()
    }
    .padding(.horizontal, 4)
  }

  private func statusIndicator(label: String, isOk: Bool, icon: String) -> some View {
    HStack(spacing: 4) {
      Image(systemName: icon)
        .foregroundStyle(isOk ? .green : .orange)
        .font(.mono(.caption))
      Text(label)
        .font(.mono(.caption))
        .foregroundStyle(.secondary)
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 4)
    .background(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(isOk ? Color.green.opacity(0.12) : Color.orange.opacity(0.12))
    )
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 8) {
      SectionHeader(
        breadcrumb: "System / Runtime",
        title: "Runtime",
        subtitle: "Local daemon, runtime health, and global services",
        status: { StatusPill(text: runtimeStatusText, tone: runtimeStatusTone) },
        actions: {
          Menu {
            Button("Refresh") {
              Task { await model.refresh() }
            }
            Button("Setup…") {
              showSetupAssistant = true
            }
            if canStopDaemon {
              Button(daemonActionTitle) {
                Task { await model.stopDaemon() }
              }
            } else if canStartDaemon {
              Button(daemonActionTitle) {
                Task { await model.startDaemon() }
              }
            }
            Button("Restart hackd") {
              Task { await model.restartDaemon() }
            }
            if canClearDaemon {
              Button("Clear state") {
                Task { await model.clearDaemon() }
              }
            }
          } label: {
            Image(systemName: "ellipsis.circle")
          }
          .buttonStyle(.plain)
        }
      )
      if let generatedAt = model.globalStatus?.generatedAt, !generatedAt.isEmpty {
        Text("Last updated: \(generatedAt)")
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
      }
    }
  }

  private var daemonCard: some View {
    GlassCard(title: "Daemon", systemImage: "bolt.horizontal.circle") {
      if canStartDaemon {
        daemonStoppedGuidance
        Divider()
      }
      HStack(spacing: 12) {
        Button {
          openDaemonLogsInTerminalPanel()
        } label: {
          Label("Open logs", systemImage: "text.alignleft")
        }
        .adaptiveToolbarButtonProminent()

        Button {
          Task { await model.refresh() }
        } label: {
          Label("Refresh status", systemImage: "arrow.clockwise")
        }
        .adaptiveToolbarButton()

        if canRestartDaemon {
          Button {
            Task { await model.restartDaemon() }
          } label: {
            Label("Restart", systemImage: "arrow.triangle.2.circlepath")
          }
          .adaptiveToolbarButton()
        }
        if canClearDaemon {
          Button {
            Task { await model.clearDaemon() }
          } label: {
            Label("Clear state", systemImage: "trash")
          }
          .adaptiveToolbarButton()
        }
      }
      Divider()
      DetailRows(rows: daemonPrimaryRows)
      DisclosureGroup(isExpanded: $showDaemonDetails) {
        DetailRows(rows: daemonDetailRows)
          .padding(.top, 8)
      } label: {
        Text("Details")
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
      }
      .padding(.top, 8)
    }
  }

  private var daemonStoppedGuidance: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Image(systemName: "info.circle.fill")
          .foregroundStyle(.blue)
        Text("Daemon not running")
          .font(.mono(.subheadline, weight: .medium))
      }
      Text("The hack daemon manages your local development environment. Start it to enable project monitoring and logs.")
        .font(.mono(.caption))
        .foregroundStyle(.secondary)
      Button {
        Task { await model.startDaemon() }
      } label: {
        Label("Start hackd", systemImage: "play.fill")
      }
      .adaptiveToolbarButtonProminent()
      .padding(.top, 4)
    }
    .padding(.vertical, 4)
  }

  private var runtimeCard: some View {
    GlassCard(title: "Runtime health", systemImage: "checkmark.seal") {
      HStack {
        StatusPill(text: runtimeStatusText, tone: runtimeStatusTone)
        Spacer()
      }
      if let error = model.runtimeError, !error.isEmpty, model.runtimeOk != true {
        Text(error)
          .font(.mono(.caption))
          .foregroundStyle(.red)
      }
      DetailRows(rows: runtimeRows)
    }
  }

  @ViewBuilder
  private var globalServicesSection: some View {
    if let status = model.globalStatus {
      globalSummaryCard(summary: status.summary, generatedAt: status.generatedAt)
      runtimeDiagnosticsCard
      if let caddy = status.caddy {
        composeCard(title: "Caddy", systemImage: "globe", group: caddy)
      }
      if let logging = status.logging {
        composeCard(title: "Logging", systemImage: "waveform.path.ecg", group: logging)
      }
      if let networks = status.networks {
        networksCard(networks)
      }
    } else {
      GlassCard(title: "Global services", systemImage: "network.slash") {
        VStack(alignment: .leading, spacing: 8) {
          HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
              .foregroundStyle(.orange)
            Text("Status unavailable")
              .font(.mono(.subheadline, weight: .medium))
          }
          Text("Global services status is provided by `hack global status`. If you haven't set up this machine yet, run `hack global install` (and then `hack global trust` on macOS).")
            .font(.mono(.caption))
            .foregroundStyle(.secondary)
          HStack(spacing: 10) {
            Button {
              TerminalIntegration.copyToClipboard("hack global install")
            } label: {
              Label("Copy install", systemImage: "doc.on.doc")
            }
            .adaptiveToolbarButton()

            Button {
              TerminalIntegration.openTerminalWithCommand("hack global install")
            } label: {
              Label("Open Terminal", systemImage: "terminal")
            }
            .adaptiveToolbarButtonProminent()

            Button {
              Task { await model.refresh() }
            } label: {
              Label("Refresh", systemImage: "arrow.clockwise")
            }
            .adaptiveToolbarButton()
          }
          .padding(.top, 4)
        }
      }
    }
  }

  private func globalSummaryCard(summary: GlobalStatusSummary, generatedAt: String?) -> some View {
    GlassCard(title: "Global summary", systemImage: "network") {
      DetailRows(rows: [
        DetailRowItem(label: "Overall", value: summary.ok ? "Healthy" : "Degraded"),
        DetailRowItem(label: "Caddy", value: summary.caddyOk ? "Healthy" : "Degraded"),
        DetailRowItem(label: "Logging", value: summary.loggingOk ? "Healthy" : "Degraded"),
        DetailRowItem(label: "Networks", value: summary.networksOk ? "Healthy" : "Degraded")
      ])
      if let generatedAt, !generatedAt.isEmpty {
        Text("Generated at \(generatedAt)")
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
      }
    }
  }

  private var runtimeDiagnosticsCard: some View {
    GlassCard(title: "Diagnostics", systemImage: "text.alignleft") {
      Text("Open live tails for daemon, ingress (Caddy/CoreDNS), and Docker network state.")
        .font(.mono(.caption))
        .foregroundStyle(.secondary)
      HStack(spacing: 10) {
        Button {
          openDaemonLogsInTerminalPanel()
        } label: {
          Label("Daemon logs", systemImage: "waveform.path.ecg")
        }
        .adaptiveToolbarButtonProminent()

        Button {
          openGlobalCommandInTerminalPanel(
            command: "hack global logs caddy --tail 200 --follow",
            title: "caddy logs"
          )
        } label: {
          Label("Caddy logs", systemImage: "globe")
        }
        .adaptiveToolbarButton()

        Button {
          openGlobalCommandInTerminalPanel(
            command: "docker compose -f \"$HOME/.hack/caddy/docker-compose.yml\" logs --tail 200 -f coredns",
            title: "coredns logs"
          )
        } label: {
          Label("CoreDNS logs", systemImage: "network")
        }
        .adaptiveToolbarButton()

        Button {
          openGlobalCommandInTerminalPanel(
            command: "docker network inspect hack-dev hack-logging 2>/dev/null || docker network ls",
            title: "network diagnostics"
          )
        } label: {
          Label("Network diagnostics", systemImage: "point.3.filled.connected.trianglepath.dotted")
        }
        .adaptiveToolbarButton()
        Spacer()
      }
    }
  }

  private func composeCard(title: String, systemImage: String, group: ComposeStatusGroup) -> some View {
    GlassCard(title: title, systemImage: systemImage) {
      HStack {
        StatusPill(text: group.ok ? "Healthy" : "Degraded", tone: group.ok ? .good : .warn)
        Spacer()
      }
      if let error = group.error, !error.isEmpty, !group.ok {
        Text(error)
          .font(.mono(.caption))
          .foregroundStyle(.red)
      }
      if !group.services.isEmpty {
        VStack(alignment: .leading, spacing: 10) {
          ForEach(group.services, id: \.name) { service in
            VStack(alignment: .leading, spacing: 2) {
              HStack {
                Text(service.name)
                  .font(.mono(.subheadline, weight: .medium))
                Spacer()
                Text(service.status)
                  .font(.mono(.caption))
                  .foregroundStyle(.secondary)
              }
              if !service.ports.isEmpty {
                Text(service.ports)
                  .font(.mono(.caption2))
                  .foregroundStyle(.secondary)
              }
            }
          }
        }
      } else {
        Text("No services reported")
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
      }
    }
  }

  private func networksCard(_ group: NetworkStatusGroup) -> some View {
    GlassCard(title: "Networks", systemImage: "point.3.filled.connected.trianglepath.dotted") {
      DetailRows(rows: [
        DetailRowItem(label: "Status", value: group.ok ? "Healthy" : "Degraded"),
        DetailRowItem(label: "Networks", value: "\(group.networks.count)"),
        DetailRowItem(label: "Missing", value: group.missing.isEmpty ? "None" : group.missing.joined(separator: ", "))
      ])
      if !group.networks.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          ForEach(group.networks, id: \.id) { network in
            HStack {
              Text(network.name)
                .font(.mono(.subheadline, weight: .medium))
              Spacer()
              Text(network.driver)
                .font(.mono(.caption))
                .foregroundStyle(.secondary)
            }
          }
        }
      }
    }
  }

  private var daemonRows: [DetailRowItem] {
    [
      DetailRowItem(label: "Status", value: daemonStatusText),
      DetailRowItem(label: "API ok", value: yesNo(model.daemonStatus?.apiOk)),
      DetailRowItem(label: "Process running", value: yesNo(model.daemonStatus?.processRunning)),
      DetailRowItem(label: "Stale", value: yesNo(model.daemonStatus?.stale)),
      DetailRowItem(label: "Stale reason", value: staleReasonText),
      DetailRowItem(label: "PID", value: model.daemonStatus?.pid.map(String.init) ?? "—"),
      DetailRowItem(label: "Socket", value: model.daemonStatus?.socketPath ?? "—"),
      DetailRowItem(label: "Socket exists", value: yesNo(model.daemonStatus?.socketExists)),
      DetailRowItem(label: "Log", value: model.daemonStatus?.logPath ?? "—"),
      DetailRowItem(label: "Log exists", value: yesNo(model.daemonStatus?.logExists)),
      DetailRowItem(label: "Last refresh", value: lastUpdatedText)
    ]
  }

  private var daemonPrimaryRows: [DetailRowItem] {
    [
      DetailRowItem(label: "Status", value: daemonStatusText),
      DetailRowItem(label: "API", value: yesNo(model.daemonStatus?.apiOk)),
      DetailRowItem(label: "Process", value: yesNo(model.daemonStatus?.processRunning)),
      DetailRowItem(label: "Last refresh", value: lastUpdatedText)
    ]
  }

  private var daemonDetailRows: [DetailRowItem] {
    var rows: [DetailRowItem] = []
    if model.daemonStatus?.stale == true {
      rows.append(DetailRowItem(label: "Stale", value: "Yes"))
      rows.append(DetailRowItem(label: "Stale reason", value: staleReasonText))
    }
    if let pid = model.daemonStatus?.pid {
      rows.append(DetailRowItem(label: "PID", value: String(pid)))
    }
    if let socket = model.daemonStatus?.socketPath {
      rows.append(DetailRowItem(label: "Socket", value: socket))
      rows.append(DetailRowItem(label: "Socket exists", value: yesNo(model.daemonStatus?.socketExists)))
    }
    if let log = model.daemonStatus?.logPath {
      rows.append(DetailRowItem(label: "Log", value: log))
      rows.append(DetailRowItem(label: "Log exists", value: yesNo(model.daemonStatus?.logExists)))
    }
    return rows
  }

  private var runtimeRows: [DetailRowItem] {
    [
      DetailRowItem(label: "Checked at", value: model.runtimeCheckedAt ?? "—"),
      DetailRowItem(label: "Last ok at", value: model.runtimeLastOkAt ?? "—"),
      DetailRowItem(label: "Reset at", value: model.runtimeResetAt ?? "—"),
      DetailRowItem(label: "Reset count", value: model.runtimeResetCount.map(String.init) ?? "—")
    ]
  }

  private var daemonLogTailCommand: String {
    "tail -n 200 -F \"$HOME/.hack/daemon/hackd.log\""
  }

  private func openDaemonLogsInTerminalPanel() {
    openGlobalCommandInTerminalPanel(command: daemonLogTailCommand, title: "daemon logs")
  }

  private var daemonActionTitle: String {
    canStopDaemon ? "Stop hackd" : "Start hackd"
  }

  private var daemonStatusText: String {
    guard let label = model.daemonStatus?.resolvedLabel else { return "Unknown" }
    switch label {
    case .running:
      return "Running"
    case .starting:
      return "Starting"
    case .stale:
      return "Stale"
    case .stopped:
      return "Stopped"
    }
  }

  private var canStartDaemon: Bool {
    !(daemonIsRunning || daemonIsStarting)
  }

  private var canStopDaemon: Bool {
    daemonIsRunning || daemonIsStarting
  }

  private var canRestartDaemon: Bool {
    daemonIsRunning || daemonIsStarting
  }

  private var canClearDaemon: Bool {
    model.daemonStatus?.stale == true
  }

  private var daemonIsRunning: Bool {
    model.daemonStatus?.resolvedLabel == .running
  }

  private var daemonIsStarting: Bool {
    model.daemonStatus?.resolvedLabel == .starting
  }

  private var runtimeStatusText: String {
    switch model.runtimeHealthState {
    case .healthy:
      return "Healthy"
    case .down:
      return "Down"
    case .degraded:
      return "Degraded"
    case .unknown:
      return "Unknown"
    }
  }

  private var runtimeStatusTone: StatusTone {
    switch model.runtimeHealthState {
    case .healthy:
      return .good
    case .down, .degraded:
      return .warn
    case .unknown:
      return .neutral
    }
  }

  private var lastUpdatedText: String {
    guard let date = model.lastUpdated else { return "—" }
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .short
    return formatter.localizedString(for: date, relativeTo: Date())
  }

  private var staleReasonText: String {
    guard let reason = model.daemonStatus?.staleReason else { return "—" }
    switch reason {
    case .pidNotRunning:
      return "PID not running"
    case .socketOnly:
      return "Socket only"
    }
  }

  private func yesNo(_ value: Bool?) -> String {
    guard let value else { return "—" }
    return value ? "Yes" : "No"
  }

}

#if DEBUG
import HackCLIService

#Preview("Runtime (Setup Guidance)") {
  let model = DashboardModel(client: HackCLIClient())
  return RuntimeDetailView()
    .environment(model)
}
#endif
