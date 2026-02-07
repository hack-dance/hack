import Foundation

public enum HackCLILocator {
  public static func buildEnvironment() -> [String: String] {
    var env = ProcessInfo.processInfo.environment
    let home = (env["HOME"] ?? NSHomeDirectory()).trimmingCharacters(in: .whitespacesAndNewlines)

    // NOTE: GUI-launched apps often have a minimal PATH that doesn't include user-installed tools.
    // We try to start with the existing PATH, but fall back to `path_helper` when PATH is missing/empty.
    let existing = env["PATH"]?.split(separator: ":").map(String.init) ?? []
    let base = existing.isEmpty ? resolvePathHelperPaths() : existing

    var extras: [String] = []
    if !home.isEmpty {
      extras.append(contentsOf: [
        "\(home)/.hack/bin",
        "\(home)/.local/bin",
        "\(home)/.bun/bin",
        "\(home)/.cargo/bin",
        "\(home)/.asdf/shims",
        "\(home)/.volta/bin",
        "\(home)/.nix-profile/bin",
        "\(home)/.local/share/mise/shims"
      ])
    }

    if let bunInstall = env["BUN_INSTALL"]?.trimmingCharacters(in: .whitespacesAndNewlines),
       !bunInstall.isEmpty {
      extras.append("\(bunInstall)/bin")
    }

    let defaults = [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      "/run/current-system/sw/bin"
    ]

    // De-dupe while preserving order.
    var seen = Set<String>()
    func push(_ path: String) {
      let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty else { return }
      guard !seen.contains(trimmed) else { return }
      seen.insert(trimmed)
      extrasMerged.append(trimmed)
    }

    var extrasMerged: [String] = []
    for p in base { push(p) }
    for p in extras { push(p) }
    for p in defaults { push(p) }

    env["PATH"] = extrasMerged.joined(separator: ":")
    return env
  }

  public static func resolveHackExecutable(in env: [String: String]) -> String? {
    let fileManager = FileManager.default
    if let override = env["HACK_CLI_PATH"], fileManager.isExecutableFile(atPath: override) {
      return override
    }

    guard let pathValue = env["PATH"] else { return nil }
    for entry in pathValue.split(separator: ":") {
      let candidate = String(entry) + "/hack"
      if fileManager.isExecutableFile(atPath: candidate) {
        return candidate
      }
    }
    return nil
  }

  private static func resolvePathHelperPaths() -> [String] {
    let url = URL(fileURLWithPath: "/usr/libexec/path_helper")
    guard FileManager.default.isExecutableFile(atPath: url.path) else { return [] }

    let process = Process()
    process.executableURL = url
    process.arguments = ["-s"]

    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = Pipe()

    do {
      try process.run()
      process.waitUntilExit()
    } catch {
      return []
    }

    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    guard let text = String(data: data, encoding: .utf8) else { return [] }

    // `path_helper -s` prints shell code like:
    // PATH="..."; export PATH;
    guard let range = text.range(of: "PATH=\"") else { return [] }
    let after = text[range.upperBound...]
    guard let end = after.firstIndex(of: "\"") else { return [] }
    let pathValue = String(after[..<end])
    return pathValue.split(separator: ":").map(String.init)
  }
}
