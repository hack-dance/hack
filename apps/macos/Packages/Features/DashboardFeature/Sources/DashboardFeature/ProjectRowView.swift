import SwiftUI

import HackDesktopModels

struct ProjectRowView: View {
  let project: ProjectSummary
  let runtimeHealthy: Bool?

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        Image(systemName: project.isRuntimeConfigured ? "cube.transparent" : "puzzlepiece")
          .foregroundStyle(.secondary)
          .font(.subheadline)
        Text(project.name)
          .font(.subheadline.weight(.semibold))
          .lineLimit(1)
          .frame(maxWidth: .infinity, alignment: .leading)
          .layoutPriority(1)
        Spacer()
        if project.isRuntimeConfigured, let dotStatus = sidebarStatus {
          RuntimeStatusDot(status: dotStatus, runtimeHealthy: runtimeHealthy)
        }
      }
      if let devHost = project.devHost {
        Text(devHost)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      } else if let featureSummary = project.featureSummary {
        Text(featureSummary)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
    }
    .padding(.vertical, 4)
  }

  private var sidebarStatus: ProjectRuntimeStatus? {
    guard project.isRuntimeConfigured else { return nil }
    let runtimeStatus = project.runtimeStatus ?? fallbackRuntimeStatus
    switch runtimeStatus {
    case .running, .missing, .unknown:
      return runtimeStatus
    case .stopped, .notConfigured:
      return nil
    }
  }

  private var fallbackRuntimeStatus: ProjectRuntimeStatus {
    switch project.status {
    case .running:
      return .running
    case .stopped:
      return .stopped
    case .missing:
      return .missing
    case .unknown:
      return .unknown
    case .unregistered:
      return .unknown
    }
  }
}
