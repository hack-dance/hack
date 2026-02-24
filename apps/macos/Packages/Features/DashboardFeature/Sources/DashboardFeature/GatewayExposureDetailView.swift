import SwiftUI

import HackDesktopModels

struct GatewayExposureDetailView: View {
  @Environment(DashboardModel.self) private var model
  @Environment(\.openURL) private var openURL

  let exposure: GatewayExposure

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        header
        lanLoopbackCallout
        overviewCard
        gatewayCard
      }
      .padding(24)
    }
  }

  @ViewBuilder
  private var lanLoopbackCallout: some View {
    if exposure.id == "lan",
       exposure.resolvedState == .blocked,
       (exposure.detail ?? "").lowercased().contains("loopback") {
      InlineCallout(
        tone: .neutral,
        title: "LAN access is local-only (127.0.0.1)",
        message: "This is the default. The gateway can still be running locally. If you want other devices on your LAN to reach the gateway, bind to 0.0.0.0 and restart hackd.",
        actions: [
          InlineCalloutAction(label: "Copy command", systemImage: "doc.on.doc") {
            TerminalIntegration.copyToClipboard("""
            hack config set --global controlPlane.gateway.bind 0.0.0.0
            hack daemon restart
            """)
          },
          InlineCalloutAction(label: "Enable LAN access", systemImage: "terminal") {
            TerminalIntegration.openTerminalWithCommand("""
            hack config set --global controlPlane.gateway.bind 0.0.0.0
            hack daemon restart
            """)
          }
        ]
      )
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .center, spacing: 12) {
        Label(exposure.label, systemImage: iconName)
          .font(.mono(.title2, weight: .semibold))
        StatusPill(text: exposure.statusLabel, tone: exposure.statusTone)
        Spacer()
        if let url = exposureUrl {
          Button("Open URL") {
            openURL(url)
          }
          .adaptiveToolbarButton()
        }
      }
      if let detail = exposure.detail, !detail.isEmpty {
        Text(detail)
          .font(.mono(.subheadline))
          .foregroundStyle(.secondary)
      }
    }
  }

  private var overviewCard: some View {
    GlassCard(title: "Overview", systemImage: "rectangle.stack") {
      DetailRows(rows: [
        DetailRowItem(label: "Status", value: exposure.statusLabel),
        DetailRowItem(label: "Dependency", value: exposure.dependencyStatusLabel ?? "—"),
        DetailRowItem(label: "URL", value: exposure.url ?? "—"),
        DetailRowItem(label: "Detail", value: exposure.detail ?? "—")
      ])
    }
  }

  private var gatewayCard: some View {
    let rows = gatewayRows
    return Group {
      if rows.isEmpty {
        EmptyView()
      } else {
        GlassCard(title: "Gateway", systemImage: "arrow.triangle.branch") {
          DetailRows(rows: rows)
        }
      }
    }
  }

  private var gatewayRows: [DetailRowItem] {
    guard let gateway = model.globalStatus?.gateway else { return [] }
    return [
      DetailRowItem(label: "Gateway URL", value: gateway.gatewayUrl ?? "—"),
      DetailRowItem(label: "Bind", value: gateway.gatewayBind ?? "—"),
      DetailRowItem(label: "Port", value: gateway.gatewayPort.map(String.init) ?? "—"),
      DetailRowItem(label: "Config path", value: gateway.configPath ?? "—")
    ]
  }

  private var exposureUrl: URL? {
    guard let url = exposure.url, !url.isEmpty else { return nil }
    return URL(string: url)
  }

  private var iconName: String {
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
}
