import SwiftUI

import HackDesktopModels

struct ShellView: View {
  let project: ProjectSummary
  let embedded: Bool
  let onClose: (() -> Void)?
  let initialCommand: String?
  @State private var session: GhosttyTerminalSession

  init(
    project: ProjectSummary,
    embedded: Bool = false,
    onClose: (() -> Void)? = nil,
    initialCommand: String? = nil
  ) {
    self.project = project
    self.embedded = embedded
    self.onClose = onClose
    self.initialCommand = initialCommand
    let workingDirectory = project.repoRoot ?? project.projectDir ?? FileManager.default.homeDirectoryForCurrentUser.path
    _session = State(
      initialValue: GhosttyTerminalSession(
        project: project,
        mode: .shell(workingDirectory: URL(fileURLWithPath: workingDirectory)),
        initialCommand: initialCommand
      )
    )
  }

  var body: some View {
    @Bindable var session = session

    VStack(alignment: .leading, spacing: embedded ? 12 : 16) {
      if !embedded {
        header(session: session)
      } else {
        embeddedHeader(session: session)
      }
      if session.isAvailable {
        GhosttyTerminalView(session: session)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
          .terminalSurface()
      } else {
        unavailableView
      }
      Spacer(minLength: 0)
    }
    .padding(embedded ? .horizontal : .all, embedded ? 24 : 20)
    .padding(.bottom, embedded ? 24 : 0)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .onAppear { session.start() }
    .onDisappear { session.stop() }
  }

  private var unavailableView: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Image(systemName: "exclamationmark.triangle.fill")
          .foregroundStyle(.orange)
        Text("Terminal unavailable")
          .font(.mono(.subheadline, weight: .medium))
      }
      Text("Embedded terminal support requires the Ghostty VT library. In release builds it should be bundled; in local dev you may need to run `bun run macos:ghostty:setup`.")
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

  @ViewBuilder
  private func embeddedHeader(session: GhosttyTerminalSession) -> some View {
    HStack {
      Text(session.statusMessage)
        .font(.mono(.caption))
        .foregroundStyle(.secondary)
      Spacer()
    }
  }

  @ViewBuilder
  private func header(session: GhosttyTerminalSession) -> some View {
    HStack(alignment: .center) {
      VStack(alignment: .leading, spacing: 6) {
        Text("Shell")
          .font(.mono(.title2))
          .bold()
        Text(project.name)
          .font(.mono(.headline))
        Text(session.statusMessage)
          .font(.mono(.subheadline))
          .foregroundStyle(.secondary)
      }
      Spacer()
      if let onClose {
        Button("Close") {
          onClose()
        }
        .adaptiveToolbarButton()
      }
    }
  }
}
