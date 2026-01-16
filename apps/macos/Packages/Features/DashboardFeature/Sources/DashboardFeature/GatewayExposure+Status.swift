import SwiftUI

import HackDesktopModels

extension GatewayExposure {
  var resolvedState: State {
    state ?? (enabled ? .configured : .disabled)
  }

  var statusLabel: String {
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
}

enum GatewaySummaryState {
  case running
  case configured
  case disabled
  case unknown

  static func resolve(exposures: [GatewayExposure], gatewayEnabled: Bool?) -> GatewaySummaryState {
    if exposures.isEmpty {
      if gatewayEnabled == true { return .configured }
      if gatewayEnabled == false { return .disabled }
      return .unknown
    }

    if exposures.contains(where: { $0.resolvedState == .running }) {
      return .running
    }
    if exposures.contains(where: { [.configured, .needsConfig, .blocked].contains($0.resolvedState) }) {
      return .configured
    }
    if exposures.allSatisfy({ $0.resolvedState == .disabled }) {
      if gatewayEnabled == true { return .configured }
      if gatewayEnabled == false { return .disabled }
    }

    return .unknown
  }

  var label: String {
    switch self {
    case .running:
      return "Enabled"
    case .configured:
      return "Configured"
    case .disabled:
      return "Disabled"
    case .unknown:
      return "Unknown"
    }
  }

  var tone: StatusTone {
    switch self {
    case .running:
      return .good
    case .configured:
      return .warn
    case .disabled, .unknown:
      return .neutral
    }
  }

  var statusDotColor: Color? {
    switch self {
    case .running:
      return .green
    case .configured:
      return .orange
    case .disabled, .unknown:
      return nil
    }
  }
}
