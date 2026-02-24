import Foundation

enum CodingAgentIntegration {
  enum AgentApp: String, CaseIterable, Identifiable {
    case codex
    case cursor
    case gemini
    case opencode

    var id: String { rawValue }

    var displayName: String {
      switch self {
      case .codex:
        return "Codex"
      case .cursor:
        return "Cursor"
      case .gemini:
        return "Gemini CLI"
      case .opencode:
        return "OpenCode"
      }
    }

    var executableCandidates: [String] {
      switch self {
      case .codex:
        return ["codex"]
      case .cursor:
        return ["cursor-agent", "cursor"]
      case .gemini:
        return ["gemini", "gemini-cli"]
      case .opencode:
        return ["opencode"]
      }
    }
  }

  static func installedAgents() -> [AgentApp] {
    AgentApp.allCases.filter { resolvedBinaryPath(for: $0, overridePath: nil) != nil }
  }

  static func resolvedBinaryPath(for agent: AgentApp, overridePath: String?) -> String? {
    let normalizedOverride = overridePath?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let normalizedOverride, !normalizedOverride.isEmpty {
      return normalizedOverride
    }
    let fileManager = FileManager.default
    let envPath = ProcessInfo.processInfo.environment["PATH"] ?? ""
    for entry in envPath.split(separator: ":") {
      for candidate in agent.executableCandidates {
        let path = "\(entry)/\(candidate)"
        if fileManager.isExecutableFile(atPath: path) {
          return path
        }
      }
    }

    let fallbackDirectories = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    for directory in fallbackDirectories {
      for candidate in agent.executableCandidates {
        let path = "\(directory)/\(candidate)"
        if fileManager.isExecutableFile(atPath: path) {
          return path
        }
      }
    }

    return nil
  }

  static func launchCommand(
    projectPath: String,
    agent: AgentApp,
    binaryOverridePath: String?
  ) -> String {
    let quotedPath = shellQuote(projectPath)
    let resolvedBinary = resolvedBinaryPath(for: agent, overridePath: binaryOverridePath)
    let fallbackBinary = agent.executableCandidates.first ?? agent.rawValue
    let quotedBinary = shellQuote(resolvedBinary ?? fallbackBinary)
    return "cd \(quotedPath) && \(quotedBinary)"
  }

  private static func shellQuote(_ value: String) -> String {
    if value.isEmpty {
      return "''"
    }
    return "'\(value.replacingOccurrences(of: "'", with: "'\"'\"'"))'"
  }
}
