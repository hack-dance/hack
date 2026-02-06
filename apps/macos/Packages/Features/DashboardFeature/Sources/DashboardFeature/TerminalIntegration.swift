import AppKit
import Foundation

enum TerminalIntegration {
  static func copyToClipboard(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
  }

  static func openTerminalWithCommand(_ command: String) {
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
        return
      }
    }

    // Fallback: open Terminal and copy command to clipboard.
    copyToClipboard(command)
    NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app"), configuration: NSWorkspace.OpenConfiguration())
  }
}

