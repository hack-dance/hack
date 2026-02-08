import SwiftUI

import HackDesktopModels

struct SessionAttachView: View {
  let project: ProjectSummary
  let session: MuxSessionSummary
  @Environment(\.dismiss) private var dismiss
  @State private var terminal: GhosttyTerminalSession

  init(project: ProjectSummary, session: MuxSessionSummary) {
    self.project = project
    self.session = session

    let workingDirectory: URL?
    if let path = session.path, !path.isEmpty {
      workingDirectory = URL(fileURLWithPath: path)
    } else if let path = project.repoRoot ?? project.projectDir {
      workingDirectory = URL(fileURLWithPath: path)
    } else {
      workingDirectory = nil
    }

    _terminal = State(
      initialValue: GhosttyTerminalSession(
        project: project,
        mode: .sessionAttach(sessionName: session.name, workingDirectory: workingDirectory)
      )
    )
  }

  var body: some View {
    @Bindable var terminal = terminal

    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .center, spacing: 12) {
        VStack(alignment: .leading, spacing: 4) {
          Text("Session")
            .font(.mono(.headline, weight: .semibold))
          Text(session.name)
            .font(.mono(.caption))
            .foregroundStyle(.secondary)
        }
        Spacer()
        Button("Close") {
          dismiss()
        }
        .adaptiveToolbarButton()
      }

      Text(terminal.statusMessage)
        .font(.mono(.caption))
        .foregroundStyle(.secondary)

      if terminal.isAvailable {
        GhosttyTerminalView(session: terminal)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
          .terminalSurface()
      } else {
        VStack(alignment: .leading, spacing: 8) {
          HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
              .foregroundStyle(.orange)
            Text("Terminal unavailable")
              .font(.mono(.subheadline, weight: .medium))
          }
          Text("Run `bun run macos:ghostty:setup` to build the Ghostty VT library.")
            .font(.mono(.caption))
            .foregroundStyle(.secondary)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(.ultraThinMaterial)
        )
      }
    }
    .padding(20)
    .frame(minWidth: 820, minHeight: 520)
    .onAppear { terminal.start() }
    .onDisappear { terminal.stop() }
  }
}

