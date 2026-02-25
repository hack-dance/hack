import Foundation
import Darwin

public enum HackCLILocator {
  public static func buildEnvironment() -> [String: String] {
    var env = ProcessInfo.processInfo.environment
    let home = resolveCanonicalHome(env: env)
    env["HOME"] = home
    if !home.isEmpty {
      env["HACK_GLOBAL_CONFIG_PATH"] = resolveCanonicalGlobalConfigPath(
        currentValue: env["HACK_GLOBAL_CONFIG_PATH"],
        home: home
      )
    }
    var homeBinPaths: [String] = []
    if !home.isEmpty {
      homeBinPaths = [
        "\(home)/.hack/bin",
        "\(home)/.local/bin",
        "\(home)/.bun/bin",
        "\(home)/.cargo/bin",
        "\(home)/.local/share/mise/shims",
        "\(home)/.asdf/shims",
        "\(home)/.volta/bin"
      ]
      if let miseBunBin = resolveLatestMiseBunBin(home: home) {
        homeBinPaths.append(miseBunBin)
      }
    }
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

  /// Resolve a stable user home path for CLI subprocesses.
  ///
  /// GUI app launches can sometimes inherit a containerized HOME value; when that happens,
  /// commands that read global hack state (`~/.hack/registry/*`) appear empty.
  /// We prefer the real account home from passwd, then Foundation as fallback.
  private static func resolveCanonicalHome(env: [String: String]) -> String {
    let envHome = env["HOME"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !envHome.isEmpty, !isContainerizedHome(envHome) {
      return envHome
    }

    if let passwdEntry = getpwuid(getuid()), let pwDir = passwdEntry.pointee.pw_dir {
      let passwdHome = String(cString: pwDir).trimmingCharacters(in: .whitespacesAndNewlines)
      if !passwdHome.isEmpty {
        return passwdHome
      }
    }

    let foundationHome = FileManager.default.homeDirectoryForCurrentUser.path
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if !foundationHome.isEmpty {
      return foundationHome
    }

    return envHome
  }

  private static func isContainerizedHome(_ path: String) -> Bool {
    path.contains("/Library/Containers/")
  }

  /// Ensure desktop subprocesses resolve global state from a stable config path.
  ///
  /// The desktop app should always use the user's canonical global profile under
  /// `~/.hack`, even when a shell-exported `HACK_GLOBAL_CONFIG_PATH` points at a
  /// project-local `.hack` file. Allowing arbitrary overrides here causes topology
  /// and pairing views to read/write the wrong node registry.
  private static func resolveCanonicalGlobalConfigPath(
    currentValue: String?,
    home: String
  ) -> String {
    let fallback = "\(home)/.hack/hack.config.json"
    let trimmed = currentValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !trimmed.isEmpty else {
      return fallback
    }
    let expanded = NSString(string: trimmed).expandingTildeInPath
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !expanded.isEmpty, !isContainerizedHome(expanded) else {
      return fallback
    }
    let normalizedExpanded = NSString(string: expanded).standardizingPath
    let normalizedHomeHackPrefix = NSString(string: "\(home)/.hack/").standardizingPath
    guard normalizedExpanded.hasPrefix(normalizedHomeHackPrefix) else {
      return fallback
    }
    guard FileManager.default.fileExists(atPath: normalizedExpanded) else {
      return fallback
    }
    return normalizedExpanded
  }

  public static func resolveHackExecutable(in env: [String: String]) -> String? {
    let fileManager = FileManager.default
    if let override = env["HACK_CLI_PATH"], fileManager.isExecutableFile(atPath: override) {
      return normalizeHackCandidate(override, env: env) ?? override
    }

    guard let pathValue = env["PATH"] else { return nil }
    for entry in pathValue.split(separator: ":") {
      let candidate = String(entry) + "/hack"
      guard fileManager.isExecutableFile(atPath: candidate) else {
        continue
      }
      if let resolved = normalizeHackCandidate(candidate, env: env) {
        return resolved
      }
    }
    return nil
  }

  private static func normalizeHackCandidate(_ candidate: String, env: [String: String]) -> String? {
    if bunIsRequiredByWrapper(candidate),
       resolveExecutable(named: "bun", in: env) == nil {
      if let fallback = resolveWrapperDistBinary(candidate), FileManager.default.isExecutableFile(atPath: fallback) {
        return fallback
      }
      return nil
    }
    return candidate
  }

  private static func bunIsRequiredByWrapper(_ path: String) -> Bool {
    guard let content = try? String(contentsOfFile: path, encoding: .utf8) else {
      return false
    }
    return content.contains("exec bun ")
  }

  private static func resolveWrapperDistBinary(_ path: String) -> String? {
    guard let content = try? String(contentsOfFile: path, encoding: .utf8) else {
      return nil
    }

    let pattern = #"exec\s+bun\s+"([^"]+/index\.ts)""#
    guard let regex = try? NSRegularExpression(pattern: pattern) else {
      return nil
    }
    let range = NSRange(content.startIndex..<content.endIndex, in: content)
    guard let match = regex.firstMatch(in: content, options: [], range: range),
          match.numberOfRanges > 1,
          let indexRange = Range(match.range(at: 1), in: content) else {
      return nil
    }
    let indexPath = String(content[indexRange])
    guard indexPath.hasSuffix("/index.ts") else {
      return nil
    }
    return String(indexPath.dropLast("/index.ts".count)) + "/dist/hack"
  }

  public static func resolveExecutable(named name: String, in env: [String: String]) -> String? {
    guard let pathValue = env["PATH"] else { return nil }
    let fileManager = FileManager.default
    for entry in pathValue.split(separator: ":") {
      let candidate = String(entry) + "/\(name)"
      if fileManager.isExecutableFile(atPath: candidate) {
        return candidate
      }
    }
    return nil
  }

  private static func resolveLatestMiseBunBin(home: String) -> String? {
    let root = "\(home)/.local/share/mise/installs/bun"
    let fileManager = FileManager.default
    guard let entries = try? fileManager.contentsOfDirectory(atPath: root) else {
      return nil
    }
    let versions = entries.sorted { lhs, rhs in
      lhs.localizedStandardCompare(rhs) == .orderedDescending
    }
    for version in versions {
      let candidate = "\(root)/\(version)/bin"
      if fileManager.isExecutableFile(atPath: "\(candidate)/bun") {
        return candidate
      }
    }
    return nil
  }
}
