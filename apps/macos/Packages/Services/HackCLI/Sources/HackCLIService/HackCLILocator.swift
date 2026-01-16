import Foundation

public enum HackCLILocator {
  public static func buildEnvironment() -> [String: String] {
    var env = ProcessInfo.processInfo.environment
    let home = (env["HOME"] ?? NSHomeDirectory()).trimmingCharacters(in: .whitespacesAndNewlines)
    let homeBinPaths = home.isEmpty
      ? []
      : [
          "\(home)/.hack/bin",
          "\(home)/.local/bin",
          "\(home)/.bun/bin",
          "\(home)/.cargo/bin"
        ]
    let defaultPaths = [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin"
    ]
    let existing = env["PATH"]?.split(separator: ":").map(String.init) ?? []
    let merged = existing
      + homeBinPaths.filter { !existing.contains($0) }
      + defaultPaths.filter { !existing.contains($0) }
    env["PATH"] = merged.joined(separator: ":")
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
}
