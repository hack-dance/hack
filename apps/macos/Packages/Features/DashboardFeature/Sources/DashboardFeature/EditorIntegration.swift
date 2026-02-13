import AppKit
import Foundation

enum EditorIntegration {
  enum EditorApp: String, CaseIterable, Identifiable {
    case cursor
    case vscode
    case zed
    case antigravity
    case intellij
    case neovim
    case vim

    var id: String { rawValue }

    var displayName: String {
      switch self {
      case .cursor:
        return "Cursor"
      case .vscode:
        return "VS Code"
      case .zed:
        return "Zed"
      case .antigravity:
        return "Antigravity"
      case .intellij:
        return "IntelliJ"
      case .neovim:
        return "Neovim"
      case .vim:
        return "Vim"
      }
    }

    fileprivate var launchKind: EditorLaunchKind {
      switch self {
      case .neovim, .vim:
        return .terminalCommand
      case .cursor, .vscode, .zed, .antigravity, .intellij:
        return .application
      }
    }

    fileprivate var bundleIdentifiers: [String] {
      switch self {
      case .cursor:
        return ["com.todesktop.230313mzl4w4u92"]
      case .vscode:
        return ["com.microsoft.VSCode", "com.microsoft.VSCodeInsiders"]
      case .zed:
        return ["dev.zed.Zed"]
      case .antigravity:
        return ["com.antigravity.editor"]
      case .intellij:
        return ["com.jetbrains.intellij", "com.jetbrains.intellij.ce"]
      case .neovim, .vim:
        return []
      }
    }

    fileprivate var fallbackPaths: [String] {
      switch self {
      case .cursor:
        return ["/Applications/Cursor.app"]
      case .vscode:
        return ["/Applications/Visual Studio Code.app", "/Applications/Visual Studio Code - Insiders.app"]
      case .zed:
        return ["/Applications/Zed.app"]
      case .antigravity:
        return ["/Applications/Antigravity.app"]
      case .intellij:
        return ["/Applications/IntelliJ IDEA.app", "/Applications/IntelliJ IDEA CE.app"]
      case .neovim, .vim:
        return []
      }
    }

    fileprivate var executableCandidates: [String] {
      switch self {
      case .neovim:
        return ["nvim"]
      case .vim:
        return ["vim"]
      case .cursor:
        return ["cursor"]
      case .vscode:
        return ["code"]
      case .zed:
        return ["zed"]
      case .antigravity:
        return ["antigravity"]
      case .intellij:
        return ["idea"]
      }
    }
  }

  static func installedEditors() -> [EditorApp] {
    EditorApp.allCases.filter { resolvedLocation(for: $0) != nil }
  }

  static func resolvedLocation(for editor: EditorApp) -> String? {
    switch editor.launchKind {
    case .application:
      return resolveEditorAppURL(for: editor)?.path
    case .terminalCommand:
      return resolveExecutable(for: editor)
    }
  }

  static func openProject(
    path: String,
    editor: EditorApp,
    terminalApp: TerminalIntegration.ExternalTerminalApp
  ) {
    let projectPath = path.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !projectPath.isEmpty else { return }

    switch editor.launchKind {
    case .application:
      guard let appURL = resolveEditorAppURL(for: editor) else { return }
      let projectURL = URL(fileURLWithPath: projectPath)
      let configuration = NSWorkspace.OpenConfiguration()
      NSWorkspace.shared.open(
        [projectURL],
        withApplicationAt: appURL,
        configuration: configuration
      ) { _, _ in }
    case .terminalCommand:
      guard let executable = resolveExecutable(for: editor) else { return }
      let command = "\(shellQuote(executable)) \(shellQuote(projectPath))"
      TerminalIntegration.openExternalTerminalWithCommand(command, app: terminalApp)
    }
  }

  private static func resolveEditorAppURL(for editor: EditorApp) -> URL? {
    let workspace = NSWorkspace.shared
    for bundleIdentifier in editor.bundleIdentifiers {
      if let url = workspace.urlForApplication(withBundleIdentifier: bundleIdentifier) {
        return url
      }
    }
    for path in editor.fallbackPaths where FileManager.default.fileExists(atPath: path) {
      return URL(fileURLWithPath: path)
    }
    return nil
  }

  private static func resolveExecutable(for editor: EditorApp) -> String? {
    for candidate in editor.executableCandidates {
      if let path = findExecutable(named: candidate) {
        return path
      }
    }
    return nil
  }

  private static func findExecutable(named command: String) -> String? {
    let fileManager = FileManager.default
    let envPath = ProcessInfo.processInfo.environment["PATH"] ?? ""
    for entry in envPath.split(separator: ":") {
      let candidate = "\(entry)/\(command)"
      if fileManager.isExecutableFile(atPath: candidate) {
        return candidate
      }
    }

    let fallbackDirectories = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    for directory in fallbackDirectories {
      let candidate = "\(directory)/\(command)"
      if fileManager.isExecutableFile(atPath: candidate) {
        return candidate
      }
    }

    return nil
  }

  private static func shellQuote(_ value: String) -> String {
    if value.isEmpty {
      return "''"
    }
    return "'\(value.replacingOccurrences(of: "'", with: "'\"'\"'"))'"
  }
}

private enum EditorLaunchKind {
  case application
  case terminalCommand
}
