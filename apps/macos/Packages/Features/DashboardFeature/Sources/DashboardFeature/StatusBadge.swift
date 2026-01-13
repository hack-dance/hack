import SwiftUI

import HackDesktopModels

struct StatusBadge: View {
  let status: ProjectStatus

  var body: some View {
    Text(statusLabel)
      .font(.caption)
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
      .background(color.opacity(0.18))
      .foregroundStyle(color)
      .clipShape(Capsule())
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

  private var color: Color {
    switch status {
    case .running:
      .green
    case .stopped:
      .orange
    case .missing:
      .red
    case .unregistered:
      .gray
    case .unknown:
      .yellow
    }
  }
}
