import AppKit
import Foundation

enum TerminalIntegration {
  enum ExternalTerminalApp: String, CaseIterable, Identifiable {
    case hackDesktop = "hack-desktop"
    case terminal = "terminal"
    case iTerm = "iterm"
    case ghostty = "ghostty"
    case warp = "warp"
    case alacritty = "alacritty"
    case wezTerm = "wezterm"
    case kitty = "kitty"

    var id: String { rawValue }

    var displayName: String {
      switch self {
      case .hackDesktop:
        return "Hack Desktop"
      case .terminal:
        return "Terminal"
      case .iTerm:
        return "iTerm"
      case .ghostty:
        return "Ghostty"
      case .warp:
        return "Warp"
      case .alacritty:
        return "Alacritty"
      case .wezTerm:
        return "WezTerm"
      case .kitty:
        return "Kitty"
      }
    }

    var bundleIdentifiers: [String] {
      switch self {
      case .hackDesktop:
        return []
      case .terminal:
        return ["com.apple.Terminal"]
      case .iTerm:
        return ["com.googlecode.iterm2"]
      case .ghostty:
        return ["com.mitchellh.ghostty"]
      case .warp:
        return ["dev.warp.Warp-Stable", "dev.warp.Warp"]
      case .alacritty:
        return ["org.alacritty"]
      case .wezTerm:
        return ["com.github.wez.wezterm"]
      case .kitty:
        return ["net.kovidgoyal.kitty"]
      }
    }

    var fallbackPaths: [String] {
      switch self {
      case .hackDesktop:
        return []
      case .terminal:
        return ["/System/Applications/Utilities/Terminal.app"]
      case .iTerm:
        return ["/Applications/iTerm.app"]
      case .ghostty:
        return ["/Applications/Ghostty.app"]
      case .warp:
        return ["/Applications/Warp.app"]
      case .alacritty:
        return ["/Applications/Alacritty.app"]
      case .wezTerm:
        return ["/Applications/WezTerm.app"]
      case .kitty:
        return ["/Applications/kitty.app"]
      }
    }
  }

  static func installedExternalTerminalApps() -> [ExternalTerminalApp] {
    ExternalTerminalApp.allCases
      .filter { $0 != .hackDesktop }
      .filter { app in
        resolveAppURL(for: app) != nil
      }
  }

  static func resolvedExternalTerminalPath(for app: ExternalTerminalApp) -> String? {
    resolveAppURL(for: app)?.path
  }

  static func copyToClipboard(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
  }

  static func openTerminalWithCommand(_ command: String) {
    openExternalTerminalWithCommand(command, app: .terminal)
  }

  /// Triggers the macOS Automation permission flow for controlling Terminal via AppleScript.
  /// Returns true when the script executed successfully.
  static func requestTerminalAutomationPermission() -> Bool {
    openAppleTerminal("echo \"Hack Desktop terminal automation access confirmed.\"")
  }

  static func openExternalTerminalWithCommand(_ command: String, app: ExternalTerminalApp) {
    switch app {
    case .hackDesktop:
      return
    case .terminal:
      if openAppleTerminal(command) {
        return
      }
    case .iTerm:
      if openITerm(command) {
        return
      }
    case .ghostty, .warp, .alacritty, .wezTerm, .kitty:
      break
    }

    copyToClipboard(command)
    if let appURL = resolveAppURL(for: app) {
      NSWorkspace.shared.openApplication(at: appURL, configuration: NSWorkspace.OpenConfiguration())
      return
    }

    // Final fallback: open Apple's Terminal and keep the command on clipboard.
    if let fallbackURL = resolveAppURL(for: .terminal) {
      NSWorkspace.shared.openApplication(at: fallbackURL, configuration: NSWorkspace.OpenConfiguration())
    }
  }

  private static func openAppleTerminal(_ command: String) -> Bool {
    // Prefer an AppleScript "do script" so the user sees an actual command they can edit and re-run.
    // This will prompt for Automation permission (Terminal) the first time.
    let escaped = command
      .replacingOccurrences(of: "\\", with: "\\\\")
      .replacingOccurrences(of: "\"", with: "\\\"")
      .replacingOccurrences(of: "\n", with: "\\n")

    let script = """
    tell application "Terminal"
      activate
      do script "\(escaped)"
    end tell
    """

    var errorDict: NSDictionary?
    if let appleScript = NSAppleScript(source: script) {
      _ = appleScript.executeAndReturnError(&errorDict)
      if errorDict == nil {
        return true
      }
    }

    return false
  }

  private static func openITerm(_ command: String) -> Bool {
    let escaped = command
      .replacingOccurrences(of: "\\", with: "\\\\")
      .replacingOccurrences(of: "\"", with: "\\\"")
      .replacingOccurrences(of: "\n", with: "\\n")

    let script = """
    tell application "iTerm2"
      activate
      if (count of windows) = 0 then
        create window with default profile command "\(escaped)"
      else
        tell current window
          create tab with default profile
          tell current session to write text "\(escaped)"
        end tell
      end if
    end tell
    """

    var errorDict: NSDictionary?
    if let appleScript = NSAppleScript(source: script) {
      _ = appleScript.executeAndReturnError(&errorDict)
      return errorDict == nil
    }
    return false
  }

  private static func resolveAppURL(for app: ExternalTerminalApp) -> URL? {
    let workspace = NSWorkspace.shared
    for bundleIdentifier in app.bundleIdentifiers {
      if let url = workspace.urlForApplication(withBundleIdentifier: bundleIdentifier) {
        return url
      }
    }
    for path in app.fallbackPaths where FileManager.default.fileExists(atPath: path) {
      return URL(fileURLWithPath: path)
    }
    return nil
  }
}
