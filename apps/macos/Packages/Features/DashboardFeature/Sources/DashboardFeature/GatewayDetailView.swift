import SwiftUI

import HackDesktopModels

struct GatewayDetailView: View {
  @Environment(DashboardModel.self) private var model
  @Environment(\.openURL) private var openURL

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          header
          overviewCard
          exposuresCard
          tokensCard
          warningsCard
        }
        .padding(24)
      }
      .navigationDestination(for: GatewayExposure.self) { exposure in
        GatewayExposureDetailView(exposure: exposure)
      }
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .center, spacing: 12) {
        Label("Gateway", systemImage: "arrow.triangle.branch")
          .font(.title2.weight(.semibold))
        StatusPill(text: gatewayStatusText, tone: gatewayStatusTone)
        Spacer()
        if let configUrl {
          Button("Open Config") {
            openURL(configUrl)
          }
          .adaptiveToolbarButton()
        }
      }
      Text("Remote gateway configuration and exposures")
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }
  }

  private var overviewCard: some View {
    GlassCard(title: "Overview", systemImage: "network") {
      DetailRows(rows: overviewRows)
    }
  }

  private var exposuresCard: some View {
    GlassCard(title: "Exposures", systemImage: "point.3.filled.connected.trianglepath.dotted") {
      if exposures.isEmpty {
        Text("No gateway exposures configured")
          .font(.caption)
          .foregroundStyle(.secondary)
      } else {
        VStack(alignment: .leading, spacing: 12) {
          ForEach(Array(exposures.enumerated()), id: \.element.id) { index, exposure in
            NavigationLink(value: exposure) {
              exposureRow(exposure)
            }
            .buttonStyle(.plain)
            if index < exposures.count - 1 {
              Divider()
            }
          }
        }
      }
    }
  }

  private var tokensCard: some View {
    let rows = tokenRows
    return Group {
      if rows.isEmpty {
        EmptyView()
      } else {
        GlassCard(title: "Tokens", systemImage: "key") {
          DetailRows(rows: rows)
        }
      }
    }
  }

  private var warningsCard: some View {
    let warnings = gatewayWarnings
    return Group {
      if warnings.isEmpty {
        EmptyView()
      } else {
        GlassCard(title: "Warnings", systemImage: "exclamationmark.triangle") {
          VStack(alignment: .leading, spacing: 4) {
            ForEach(warnings, id: \.self) { warning in
              Text("• \(warning)")
                .font(.caption)
                .foregroundStyle(.secondary)
            }
          }
        }
      }
    }
  }

  private var gateway: GatewayStatus? {
    model.globalStatus?.gateway
  }

  private var exposures: [GatewayExposure] {
    model.gatewayExposures
  }

  private var gatewaySummaryState: GatewaySummaryState? {
    model.gatewaySummaryState
  }

  private var gatewayStatusText: String {
    gatewaySummaryState?.label ?? "Unknown"
  }

  private var gatewayStatusTone: StatusTone {
    gatewaySummaryState?.tone ?? .neutral
  }

  private var overviewRows: [DetailRowItem] {
    let configured = gateway?.gatewayEnabled ?? model.globalStatus?.summary.gatewayEnabled
    return [
      DetailRowItem(label: "Status", value: gatewaySummaryState?.label ?? "—"),
      DetailRowItem(label: "Configured", value: yesNo(configured)),
      DetailRowItem(label: "Gateway URL", value: gateway?.gatewayUrl ?? "—"),
      DetailRowItem(label: "Bind", value: gateway?.gatewayBind ?? "—"),
      DetailRowItem(label: "Port", value: gateway?.gatewayPort.map(String.init) ?? "—"),
      DetailRowItem(label: "Allow writes", value: yesNo(gateway?.allowWrites)),
      DetailRowItem(label: "Projects enabled", value: gateway?.gatewayProjectsEnabled.map(String.init) ?? "—"),
      DetailRowItem(label: "Projects", value: gateway?.gatewayProjects ?? "—"),
      DetailRowItem(label: "Config path", value: gateway?.configPath ?? "—")
    ]
  }

  private var tokenRows: [DetailRowItem] {
    var rows: [DetailRowItem] = []
    if let tokensActive = gateway?.tokensActive {
      rows.append(DetailRowItem(label: "Active", value: String(tokensActive)))
    }
    if let tokensRead = gateway?.tokensRead {
      rows.append(DetailRowItem(label: "Read", value: String(tokensRead)))
    }
    if let tokensWrite = gateway?.tokensWrite {
      rows.append(DetailRowItem(label: "Write", value: String(tokensWrite)))
    }
    if let tokensRevoked = gateway?.tokensRevoked {
      rows.append(DetailRowItem(label: "Revoked", value: String(tokensRevoked)))
    }
    return rows
  }

  private var gatewayWarnings: [String] {
    gateway?.warnings ?? []
  }

  private var configUrl: URL? {
    guard let path = gateway?.configPath, !path.isEmpty else { return nil }
    return URL(fileURLWithPath: path)
  }

  private func yesNo(_ value: Bool?) -> String {
    guard let value else { return "—" }
    return value ? "Yes" : "No"
  }

  private func exposureIcon(_ exposure: GatewayExposure) -> String {
    switch exposure.id {
    case "lan":
      return "wifi"
    case "tailscale":
      return "link"
    case "cloudflare":
      return "cloud"
    default:
      return "network"
    }
  }

  private func exposureRow(_ exposure: GatewayExposure) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 8) {
        Label(exposure.label, systemImage: exposureIcon(exposure))
          .font(.subheadline.weight(.medium))
        Spacer()
        if let dependencyLabel = exposure.dependencyStatusLabel,
           let dependencyColor = exposure.dependencyStatusColor {
          BadgePill(label: dependencyLabel, tint: dependencyColor)
        }
        StatusPill(text: exposure.statusLabel, tone: exposure.statusTone)
        Image(systemName: "chevron.right")
          .font(.caption)
          .foregroundStyle(.tertiary)
      }
      if let detail = exposure.detail, !detail.isEmpty {
        Text(detail)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      if let url = exposure.url, !url.isEmpty {
        Text(url)
          .font(.caption2)
          .foregroundStyle(.secondary)
      }
    }
    .padding(.vertical, 4)
  }
}
