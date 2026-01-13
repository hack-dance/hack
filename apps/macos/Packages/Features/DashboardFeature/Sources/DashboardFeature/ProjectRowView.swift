import SwiftUI

import HackDesktopModels

struct ProjectRowView: View {
  let project: ProjectSummary

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        Text(project.name)
          .font(.headline)
        Spacer()
        StatusBadge(status: project.status)
      }
      if let devHost = project.devHost {
        Text(devHost)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .padding(.vertical, 4)
  }
}
