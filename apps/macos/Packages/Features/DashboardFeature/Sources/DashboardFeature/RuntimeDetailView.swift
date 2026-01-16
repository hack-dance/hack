import SwiftUI

import HackDesktopModels

struct RuntimeDetailView: View {
  @Environment(DashboardModel.self) private var model
  @Environment(\.openURL) private var openURL
  @State private var showDaemonDetails = false
  @State private var showRuntimeDetails = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        header
        statusSummaryBar
        daemonCard
        runtimeCard
        globalServicesSection
      }
      .padding(24)
    }
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
        .font(.caption)
      Text(label)
        .font(.caption)
        .foregroundStyle(.secondary)
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 4)
    .background(
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .fill(isOk ? Color.green.opacity(0.1) : Color.orange.opacity(0.1))
    )
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .center, spacing: 12) {
        Label("Runtime", systemImage: "gauge")
          .font(.title2.weight(.semibold))
        StatusPill(text: runtimeStatusText, tone: runtimeStatusTone)
        Spacer()
        if canStopDaemon {
          Button(daemonActionTitle) {
            Task { await model.stopDaemon() }
          }
          .adaptiveToolbarButton()
        } else if canStartDaemon {
          Button(daemonActionTitle) {
            Task { await model.startDaemon() }
          }
          .adaptiveToolbarButtonProminent()
        }
      }
      Text("Local daemon, runtime health, and global services")
        .font(.subheadline)
        .foregroundStyle(.secondary)
      if let generatedAt = model.globalStatus?.generatedAt, !generatedAt.isEmpty {
        Text("Last updated: \(generatedAt)")
          .font(.caption)
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
        Button("Open Logs") {
          if let logUrl = logUrl {
            openURL(logUrl)
          }
        }
        .disabled(logUrl == nil)
        Button("Refresh Status") {
          Task { await model.refresh() }
        }
        if canRestartDaemon {
          Button("Restart") {
            Task { await model.restartDaemon() }
          }
        }
        if canClearDaemon {
          Button("Clear State") {
            Task { await model.clearDaemon() }
          }
        }
      }
      Divider()
      DetailRows(rows: daemonPrimaryRows)
      DisclosureGroup(isExpanded: $showDaemonDetails) {
        DetailRows(rows: daemonDetailRows)
          .padding(.top, 8)
      } label: {
        Text("Details")
          .font(.caption)
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
          .font(.subheadline.weight(.medium))
      }
      Text("The hack daemon manages your local development environment. Start it to enable project monitoring, logs, and gateway access.")
        .font(.caption)
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
          .font(.caption)
          .foregroundStyle(.red)
      }
      DetailRows(rows: runtimeRows)
    }
  }

  @ViewBuilder
  private var globalServicesSection: some View {
    if let status = model.globalStatus {
      globalSummaryCard(summary: status.summary, generatedAt: status.generatedAt)
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
              .font(.subheadline.weight(.medium))
          }
          Text("Global services status requires the daemon to be running. These services include Caddy (reverse proxy), logging infrastructure, and Docker networks.")
            .font(.caption)
            .foregroundStyle(.secondary)
          if canStartDaemon {
            Button {
              Task { await model.startDaemon() }
            } label: {
              Label("Start hackd", systemImage: "play.fill")
            }
            .adaptiveToolbarButtonProminent()
            .padding(.top, 4)
          } else {
            Button {
              Task { await model.refresh() }
            } label: {
              Label("Refresh", systemImage: "arrow.clockwise")
            }
            .adaptiveToolbarButton()
            .padding(.top, 4)
          }
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
          .font(.caption)
          .foregroundStyle(.secondary)
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
          .font(.caption)
          .foregroundStyle(.red)
      }
      if !group.services.isEmpty {
        VStack(alignment: .leading, spacing: 10) {
          ForEach(group.services, id: \.name) { service in
            VStack(alignment: .leading, spacing: 2) {
              HStack {
                Text(service.name)
                  .font(.subheadline.weight(.medium))
                Spacer()
                Text(service.status)
                  .font(.caption)
                  .foregroundStyle(.secondary)
              }
              if !service.ports.isEmpty {
                Text(service.ports)
                  .font(.caption2)
                  .foregroundStyle(.secondary)
              }
            }
          }
        }
      } else {
        Text("No services reported")
          .font(.caption)
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
                .font(.subheadline.weight(.medium))
              Spacer()
              Text(network.driver)
                .font(.caption)
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

  private var logUrl: URL? {
    guard let logPath = model.daemonStatus?.logPath, !logPath.isEmpty else { return nil }
    return URL(fileURLWithPath: logPath)
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
    if model.runtimeOverallOk == true { return "Healthy" }
    if model.runtimeOverallOk == false { return "Degraded" }
    return "Unknown"
  }

  private var runtimeStatusTone: StatusTone {
    if model.runtimeOverallOk == true { return .good }
    if model.runtimeOverallOk == false { return .warn }
    return .neutral
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
