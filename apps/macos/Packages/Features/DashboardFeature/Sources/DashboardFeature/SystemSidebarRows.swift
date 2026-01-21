import SwiftUI

import HackDesktopModels

struct RuntimeRowView: View {
  let isHealthy: Bool?

  var body: some View {
    HStack(spacing: 8) {
      Label("Runtime", systemImage: "gauge")
        .font(.subheadline.weight(.medium))
      Spacer()
      if let statusColor {
        StatusDotView(color: statusColor)
      }
    }
    .padding(.vertical, 4)
  }

  private var statusColor: Color? {
    guard let isHealthy else { return nil }
    return isHealthy ? .green : .orange
  }
}

struct GatewayRowView: View {
  let state: GatewaySummaryState?

  var body: some View {
    HStack(spacing: 8) {
      Label("Gateway", systemImage: "arrow.triangle.branch")
        .font(.subheadline.weight(.medium))
      Spacer()
      if let statusColor {
        StatusDotView(color: statusColor)
      }
    }
    .padding(.vertical, 4)
  }

  private var statusColor: Color? {
    state?.statusDotColor
  }
}

struct GatewayExposureRowView: View {
  let exposure: GatewayExposure

  var body: some View {
    HStack(spacing: 8) {
      Label(exposure.label, systemImage: iconName)
        .font(.subheadline)
      Spacer()
      StatusDotView(color: exposure.statusColor)
    }
    .padding(.vertical, 2)
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

private struct StatusDotView: View {
  let color: Color

  var body: some View {
    Circle()
      .fill(color.opacity(0.7))
      .frame(width: 8, height: 8)
      .overlay(
        Circle()
          .stroke(color.opacity(0.4), lineWidth: 1)
      )
  }
}
