import Foundation

extension Notification.Name {
  static let hackTerminalOpenRequested = Notification.Name("hack.terminal.open.requested")
}

enum TerminalOpenRequest {
  static let projectIdKey = "projectId"
  static let kindKey = "kind"
  static let branchKey = "branch"
  static let commandKey = "command"
  static let titleKey = "title"
  static let globalShellProjectId = "global-shell"
}

func openGlobalCommandInTerminalPanel(command: String, title: String) {
  let trimmedCommand = command.trimmingCharacters(in: .whitespacesAndNewlines)
  let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmedCommand.isEmpty else {
    return
  }

  NotificationCenter.default.post(
    name: .hackTerminalOpenRequested,
    object: nil,
    userInfo: [
      TerminalOpenRequest.projectIdKey: TerminalOpenRequest.globalShellProjectId,
      TerminalOpenRequest.kindKey: "shell",
      TerminalOpenRequest.commandKey: trimmedCommand,
      TerminalOpenRequest.titleKey: trimmedTitle.isEmpty ? "Hack" : "Hack - \(trimmedTitle)"
    ]
  )
}
