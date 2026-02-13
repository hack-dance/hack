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
}
