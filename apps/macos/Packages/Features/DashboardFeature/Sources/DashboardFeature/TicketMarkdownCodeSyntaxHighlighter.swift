import Highlightr
import MarkdownUI
import SwiftUI

struct TicketMarkdownCodeSyntaxHighlighter: CodeSyntaxHighlighter {
  private let highlightr: Highlightr?
  private let supportedLanguages: Set<String>
  private let languageAliases: [String: String] = [
    "c#": "cs",
    "c++": "cpp",
    "docker": "dockerfile",
    "js": "javascript",
    "jsx": "javascript",
    "md": "markdown",
    "obj-c": "objectivec",
    "objc": "objectivec",
    "py": "python",
    "rb": "ruby",
    "rs": "rust",
    "sh": "bash",
    "shell": "bash",
    "ts": "typescript",
    "tsx": "typescript",
    "yml": "yaml",
    "zsh": "bash"
  ]

  init(colorScheme: ColorScheme) {
    let engine = Highlightr()
    if let engine {
      let preferredThemes = colorScheme == .dark
        ? ["atom-one-dark", "github-dark", "monokai-sublime"]
        : ["atom-one-light", "github", "xcode"]
      for theme in preferredThemes {
        if engine.setTheme(to: theme) {
          break
        }
      }
    }
    self.highlightr = engine
    self.supportedLanguages = Set(engine?.supportedLanguages().map { $0.lowercased() } ?? [])
  }

  func highlightCode(_ code: String, language: String?) -> Text {
    guard let highlightr else {
      return Text(verbatim: code)
    }
    let resolvedLanguage = resolveLanguage(language)
    if let highlighted = highlightr.highlight(code, as: resolvedLanguage) {
      return Text(AttributedString(highlighted))
    }
    if let autoDetected = highlightr.highlight(code, as: nil) {
      return Text(AttributedString(autoDetected))
    }
    return Text(verbatim: code)
  }

  private func resolveLanguage(_ language: String?) -> String? {
    guard let language else { return nil }
    let normalized = language
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased()
      .replacingOccurrences(of: "language-", with: "")
    guard !normalized.isEmpty else { return nil }
    let mapped = languageAliases[normalized] ?? normalized
    return supportedLanguages.contains(mapped) ? mapped : nil
  }
}
