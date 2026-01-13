import SwiftUI

import HackDesktopModels

struct LogsView: View {
  let project: ProjectSummary

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Logs")
        .font(.title2)
        .bold()
      Text(project.name)
        .font(.headline)
      Text("Logs are not wired up yet. Use `hack logs --path \(project.projectDir ?? "<repo>")` in a terminal for now.")
        .font(.body)
        .foregroundStyle(.secondary)
      Spacer()
    }
    .padding(24)
    .frame(minWidth: 600, minHeight: 400)
  }
}
