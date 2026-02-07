import Foundation

extension Notification.Name {
  static let hackTerminalOpenRequested = Notification.Name("hack.terminal.open.requested")
}

enum TerminalOpenRequest {
  static let projectIdKey = "projectId"
  static let kindKey = "kind"
}

