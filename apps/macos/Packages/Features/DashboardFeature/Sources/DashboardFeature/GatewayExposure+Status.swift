import SwiftUI

import HackDesktopModels

extension GatewayExposure {
  var resolvedState: State {
    state ?? (enabled ? .configured : .disabled)
  }

  var statusLabel: String {
    if isLanLoopbackLocalOnly {
      return "Local only"
    }
    switch resolvedState {
    case .running:
      return "Running"
    case .configured:
      return "Configured"
    case .needsConfig:
      return "Needs setup"
    case .blocked:
      return "Blocked"
    case .disabled:
      return "Disabled"
    case .unknown:
      return "Unknown"
    }
  }

  var statusTone: StatusTone {
    if isLanLoopbackLocalOnly {
      return .good
    }
    switch resolvedState {
    case .running:
      return .good
    case .configured, .needsConfig, .blocked:
      return .warn
    case .disabled, .unknown:
      return .neutral
    }
  }

  var statusColor: Color {
    if isLanLoopbackLocalOnly {
      return .green
    }
    switch resolvedState {
    case .running:
      return .green
    case .configured, .needsConfig, .blocked:
      return .orange
    case .disabled, .unknown:
      return .secondary
    }
  }

  var dependencyStatusLabel: String? {
    switch dependencyStatus {
    case .builtIn:
      return "Built-in"
    case .installed:
      guard let dependencyName else { return nil }
      return "\(dependencyName) ok"
    case .missing:
      guard let dependencyName else { return nil }
      return "\(dependencyName) missing"
    case .unknown:
      guard let dependencyName else { return nil }
      return "\(dependencyName) unknown"
    case .none:
      return nil
    }
  }

  var dependencyStatusTone: StatusTone? {
    switch dependencyStatus {
    case .builtIn:
      return .neutral
    case .installed:
      return .good
    case .missing:
      return .warn
    case .unknown:
      return .neutral
    case .none:
      return nil
    }
  }

  var dependencyStatusColor: Color? {
    guard let dependencyStatusTone else { return nil }
    switch dependencyStatusTone {
    case .good:
      return .green
    case .warn:
      return .orange
    case .neutral:
      return .secondary
    }
  }

  var isVisibleInSidebar: Bool {
    resolvedState != .disabled
  }

  private enum DependencyStatus {
    case builtIn
    case installed
    case missing
    case unknown
  }

  private var dependencyStatus: DependencyStatus? {
    let normalizedDetail = (detail ?? "").lowercased()
    if normalizedDetail.contains("extension disabled") {
      return nil
    }

    switch id {
    case "lan":
      return .builtIn
    case "tailscale":
      if normalizedDetail.contains("not installed") {
        return .missing
      }
      if normalizedDetail.contains("status failed") {
        return .unknown
      }
      return .installed
    case "cloudflare":
      if normalizedDetail.contains("cloudflared not installed") {
        return .missing
      }
      if resolvedState == .needsConfig && normalizedDetail.contains("missing hostname") {
        return .unknown
      }
      return .installed
    default:
      return nil
    }
  }

  private var dependencyName: String? {
    switch id {
    case "tailscale":
      return "tailscale"
    case "cloudflare":
      return "cloudflared"
    default:
      return nil
    }
  }

  fileprivate var isLanLoopbackLocalOnly: Bool {
    id == "lan"
      && resolvedState == .blocked
      && (detail ?? "").lowercased().contains("loopback")
  }
}

enum GatewaySummaryState {
  case localOnly
  case lan
  case tailscale
  case cloudflare
  case mixed
  case needsSetup
  case disabled
  case down
  case unknown

  static func resolve(
    exposures: [GatewayExposure],
    gatewayEnabled: Bool?,
    globalInfraRunning: Bool?
  ) -> GatewaySummaryState {
    if gatewayEnabled == false {
      return .disabled
    }

    if globalInfraRunning == false {
      return .down
    }

    if exposures.isEmpty {
      if gatewayEnabled == true { return .needsSetup }
      return .unknown
    }

    let runningExposureIds = Set(
      exposures
        .filter { $0.resolvedState == .running }
        .map(\.id)
    )
    if runningExposureIds.contains("cloudflare") {
      return .cloudflare
    }
    if runningExposureIds.contains("tailscale") {
      return .tailscale
    }
    if runningExposureIds.contains("lan") {
      return .lan
    }
    if !runningExposureIds.isEmpty {
      return .mixed
    }

    if exposures.contains(where: \.isLanLoopbackLocalOnly) {
      return .localOnly
    }

    if exposures.contains(where: { [.configured, .needsConfig, .blocked].contains($0.resolvedState) }) {
      return .needsSetup
    }

    if exposures.allSatisfy({ $0.resolvedState == .disabled }) {
      return .disabled
    }

    return .unknown
  }

  var label: String {
    switch self {
    case .localOnly:
      return "Local-only"
    case .lan:
      return "LAN"
    case .tailscale:
      return "Tailscale"
    case .cloudflare:
      return "Cloudflare"
    case .mixed:
      return "Multi"
    case .needsSetup:
      return "Needs setup"
    case .disabled:
      return "Disabled"
    case .down:
      return "Down"
    case .unknown:
      return "Unknown"
    }
  }

  var tone: StatusTone {
    switch self {
    case .localOnly, .lan, .tailscale, .cloudflare, .mixed:
      return .good
    case .needsSetup, .disabled, .down:
      return .warn
    case .unknown:
      return .neutral
    }
  }

  var statusDotColor: Color? {
    switch self {
    case .localOnly, .lan, .tailscale, .cloudflare, .mixed:
      return .green
    case .needsSetup, .disabled, .down:
      return .orange
    case .unknown:
      return nil
    }
  }
}
