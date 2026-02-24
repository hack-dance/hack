import SwiftUI

import HackDesktopModels

struct RuntimeRowView: View {
  let isHealthy: Bool?
  @State private var isHovered = false

  var body: some View {
    HStack(spacing: 8) {
      Label("Runtime", systemImage: "gauge")
        .font(.mono(.subheadline, weight: .medium))
      Spacer()
      if let statusColor {
        StatusDotView(color: statusColor)
      }
    }
    .padding(.vertical, 4)
    .padding(.horizontal, 6)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .fill(isHovered ? Color.white.opacity(0.06) : .clear)
    )
    .contentShape(Rectangle())
    .onHover { hovering in
      isHovered = hovering
    }
    .animation(.easeInOut(duration: 0.12), value: isHovered)
  }

  private var statusColor: Color? {
    guard let isHealthy else { return nil }
    return isHealthy ? .green : .orange
  }
}

struct GatewayRowView: View {
  let state: GatewaySummaryState?
  @State private var isHovered = false

  var body: some View {
    HStack(spacing: 8) {
      Label("Gateway", systemImage: "arrow.triangle.branch")
        .font(.mono(.subheadline, weight: .medium))
      Spacer()
      if let statusColor {
        StatusDotView(color: statusColor)
      }
    }
    .padding(.vertical, 4)
    .padding(.horizontal, 6)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .fill(isHovered ? Color.white.opacity(0.06) : .clear)
    )
    .contentShape(Rectangle())
    .onHover { hovering in
      isHovered = hovering
    }
    .animation(.easeInOut(duration: 0.12), value: isHovered)
  }

  private var statusColor: Color? {
    state?.statusDotColor
  }
}

struct GatewayExposureRowView: View {
  let exposure: GatewayExposure
  @State private var isHovered = false

  var body: some View {
    HStack(spacing: 8) {
      Label(exposure.label, systemImage: iconName)
        .font(.mono(.subheadline))
      Spacer()
      StatusDotView(color: exposure.statusColor)
    }
    .padding(.vertical, 2)
    .padding(.horizontal, 6)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .fill(isHovered ? Color.white.opacity(0.06) : .clear)
    )
    .contentShape(Rectangle())
    .onHover { hovering in
      isHovered = hovering
    }
    .animation(.easeInOut(duration: 0.12), value: isHovered)
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
