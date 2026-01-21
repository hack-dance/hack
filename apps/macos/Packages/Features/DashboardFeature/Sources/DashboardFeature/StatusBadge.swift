import SwiftUI

import HackDesktopModels

struct StatusBadge: View {
  let status: ProjectStatus

  var body: some View {
    BadgePill(label: statusLabel, tint: tint)
  }

  private var statusLabel: String {
    switch status {
    case .running:
      "Running"
    case .stopped:
      "Stopped"
    case .missing:
      "Missing"
    case .unregistered:
      "Unregistered"
    case .unknown:
      "Unknown"
    }
  }

  private var tint: Color {
    switch status {
    case .running:
      .green
    case .stopped:
      .orange
    case .missing:
      .red
    case .unregistered:
      .secondary
    case .unknown:
      .secondary
    }
  }
}

struct RuntimeStatusBadge: View {
  let status: ProjectRuntimeStatus
  var runtimeHealthy: Bool? = nil

  var body: some View {
    BadgePill(label: statusLabel, tint: tint)
  }

  private var statusLabel: String {
    switch status {
    case .running:
      "Running"
    case .stopped:
      "Stopped"
    case .missing:
      "Missing"
    case .unknown:
      "Unknown"
    case .notConfigured:
      "Not configured"
    }
  }

  private var tint: Color {
    if isDegradedRunning {
      return .orange
    }
    return switch status {
    case .running:
      .green
    case .stopped:
      .orange
    case .missing:
      .red
    case .unknown:
      .secondary
    case .notConfigured:
      .secondary
    }
  }

  private var isDegradedRunning: Bool {
    status == .running && runtimeHealthy == false
  }
}

struct StatusDot: View {
  let status: ProjectStatus

  var body: some View {
    statusDotView(tint: tint, label: statusLabel)
  }

  private var statusLabel: String {
    switch status {
    case .running:
      "Running"
    case .stopped:
      "Stopped"
    case .missing:
      "Missing"
    case .unregistered:
      "Unregistered"
    case .unknown:
      "Unknown"
    }
  }

  private var tint: Color {
    switch status {
    case .running:
      .green
    case .stopped:
      .orange
    case .missing:
      .red
    case .unregistered:
      .secondary
    case .unknown:
      .secondary
    }
  }
}

struct RuntimeStatusDot: View {
  let status: ProjectRuntimeStatus
  var runtimeHealthy: Bool? = nil

  var body: some View {
    statusDotView(tint: tint, label: statusLabel)
  }

  private var statusLabel: String {
    switch status {
    case .running:
      "Running"
    case .stopped:
      "Stopped"
    case .missing:
      "Missing"
    case .unknown:
      "Unknown"
    case .notConfigured:
      "Not configured"
    }
  }

  private var tint: Color {
    if isDegradedRunning {
      return .orange
    }
    return switch status {
    case .running:
      .green
    case .stopped:
      .orange
    case .missing:
      .red
    case .unknown:
      .secondary
    case .notConfigured:
      .secondary
    }
  }

  private var isDegradedRunning: Bool {
    status == .running && runtimeHealthy == false
  }
}

@ViewBuilder
private func statusDotView(tint: Color, label: String) -> some View {
  if #available(macOS 26, *) {
    Circle()
      .fill(tint)
      .frame(width: 10, height: 10)
      .glassEffect(.regular.tint(tint.opacity(0.3)))
      .accessibilityLabel(label)
  } else {
    Circle()
      .fill(tint.opacity(0.7))
      .frame(width: 8, height: 8)
      .overlay(
        Circle()
          .stroke(tint.opacity(0.4), lineWidth: 1)
      )
      .accessibilityLabel(label)
  }
}
