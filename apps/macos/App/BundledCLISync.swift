import Foundation

import HackCLIService

enum BundledCLISyncError: LocalizedError {
  case missingAppVersion
  case missingBundledCLI
  case copyFailed(String)
  case invalidVersion(String)

  var errorDescription: String? {
    switch self {
    case .missingAppVersion:
      return "Unable to read app version from Info.plist"
    case .missingBundledCLI:
      return "Bundled hack CLI is missing from the app resources"
    case let .copyFailed(message):
      return message
    case let .invalidVersion(value):
      return "Invalid version string: \(value)"
    }
  }
}

struct BundledCLISyncOutcome {
  let didInstallOrUpdate: Bool
  let message: String?
}

enum BundledCLISync {
  static func syncIfNeeded() throws -> BundledCLISyncOutcome {
    let fileManager = FileManager.default

    guard let appVersionRaw = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String else {
      throw BundledCLISyncError.missingAppVersion
    }

    let appVersion = try Version(rawValue: appVersionRaw)

    guard let resourcesUrl = Bundle.main.resourceURL else {
      throw BundledCLISyncError.missingBundledCLI
    }

    let bundledRoot = resourcesUrl.appendingPathComponent("BundledCLI", isDirectory: true)
    let bundledHack = bundledRoot.appendingPathComponent("hack", isDirectory: false)
    guard fileManager.isExecutableFile(atPath: bundledHack.path) else {
      return BundledCLISyncOutcome(didInstallOrUpdate: false, message: nil)
    }

    let installPaths = resolveInstallPaths()
    try ensureDir(url: installPaths.binDir)
    try ensureDir(url: installPaths.assetsDir)

    let installedVersion = readInstalledHackVersion(preferredPath: installPaths.binDir.appendingPathComponent("hack").path)
    let needsInstall: Bool

    if let installedVersion {
      needsInstall = installedVersion < appVersion
    } else {
      needsInstall = true
    }

    if !needsInstall {
      return BundledCLISyncOutcome(didInstallOrUpdate: false, message: nil)
    }

    try atomicReplaceExecutable(src: bundledHack, dest: installPaths.binDir.appendingPathComponent("hack"))

    let bundledAssets = bundledRoot.appendingPathComponent("assets", isDirectory: true)
    if fileManager.fileExists(atPath: bundledAssets.path) {
      try copyDirectoryContents(src: bundledAssets, dest: installPaths.assetsDir)
    }

    let bundledBinaries = bundledRoot.appendingPathComponent("binaries", isDirectory: true)
    if fileManager.fileExists(atPath: bundledBinaries.path) {
      let destBinaries = installPaths.assetsDir.appendingPathComponent("binaries", isDirectory: true)
      try ensureDir(url: destBinaries)
      try copyDirectoryContents(src: bundledBinaries, dest: destBinaries)
    }

    let label = installedVersion == nil ? "Installed" : "Updated"
    return BundledCLISyncOutcome(
      didInstallOrUpdate: true,
      message: "\(label) CLI to v\(appVersion.rawValue)"
    )
  }

  private static func resolveInstallPaths() -> (binDir: URL, assetsDir: URL) {
    let env = ProcessInfo.processInfo.environment
    let home = FileManager.default.homeDirectoryForCurrentUser

    let binDir = (env["HACK_INSTALL_BIN"]?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { raw in
      raw.isEmpty ? nil : URL(fileURLWithPath: raw)
    } ?? home.appendingPathComponent(".hack/bin", isDirectory: true)

    let assetsDir = (env["HACK_INSTALL_ASSETS"]?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { raw in
      raw.isEmpty ? nil : URL(fileURLWithPath: raw)
    } ?? home.appendingPathComponent(".hack/assets", isDirectory: true)

    return (binDir: binDir, assetsDir: assetsDir)
  }

  private static func ensureDir(url: URL) throws {
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  }

  private static func readInstalledHackVersion(preferredPath: String) -> Version? {
    let fileManager = FileManager.default
    let env = HackCLILocator.buildEnvironment()

    let hackPath: String? = {
      if fileManager.isExecutableFile(atPath: preferredPath) {
        return preferredPath
      }
      return HackCLILocator.resolveHackExecutable(in: env)
    }()

    guard let hackPath else { return nil }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: hackPath)
    process.arguments = ["version"]
    process.environment = env

    let stdout = Pipe()
    process.standardOutput = stdout
    process.standardError = Pipe()

    do {
      try process.run()
    } catch {
      return nil
    }

    process.waitUntilExit()
    guard process.terminationStatus == 0 else { return nil }

    let data = stdout.fileHandleForReading.readDataToEndOfFile()
    guard let text = String(data: data, encoding: .utf8) else { return nil }
    return Version.parseFromHackVersionOutput(text)
  }

  private static func atomicReplaceExecutable(src: URL, dest: URL) throws {
    let fileManager = FileManager.default
    let tmp = dest
      .deletingLastPathComponent()
      .appendingPathComponent("\(dest.lastPathComponent).tmp.\(UUID().uuidString)")

    if fileManager.fileExists(atPath: tmp.path) {
      try? fileManager.removeItem(at: tmp)
    }

    do {
      try fileManager.copyItem(at: src, to: tmp)
      try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tmp.path)
    } catch {
      try? fileManager.removeItem(at: tmp)
      throw BundledCLISyncError.copyFailed("Failed to stage CLI binary: \(error.localizedDescription)")
    }

    if fileManager.fileExists(atPath: dest.path) {
      do {
        _ = try fileManager.replaceItemAt(dest, withItemAt: tmp, backupItemName: nil, options: .usingNewMetadataOnly)
      } catch {
        try? fileManager.removeItem(at: tmp)
        throw BundledCLISyncError.copyFailed("Failed to replace CLI binary: \(error.localizedDescription)")
      }
    } else {
      do {
        try fileManager.moveItem(at: tmp, to: dest)
      } catch {
        try? fileManager.removeItem(at: tmp)
        throw BundledCLISyncError.copyFailed("Failed to install CLI binary: \(error.localizedDescription)")
      }
    }
  }

  private static func copyDirectoryContents(src: URL, dest: URL) throws {
    let fileManager = FileManager.default
    let entries = try fileManager.contentsOfDirectory(at: src, includingPropertiesForKeys: [.isDirectoryKey])

    for entry in entries {
      if entry.lastPathComponent.hasPrefix(".") {
        continue
      }

      let destEntry = dest.appendingPathComponent(entry.lastPathComponent, isDirectory: false)
      let isDir = (try entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false

      if isDir {
        try ensureDir(url: destEntry)
        try copyDirectoryContents(src: entry, dest: destEntry)
        continue
      }

      if fileManager.fileExists(atPath: destEntry.path) {
        try? fileManager.removeItem(at: destEntry)
      }

      do {
        try fileManager.copyItem(at: entry, to: destEntry)
      } catch {
        throw BundledCLISyncError.copyFailed("Failed to copy \(entry.lastPathComponent): \(error.localizedDescription)")
      }
    }
  }
}

private struct Version: Comparable {
  let rawValue: String
  let major: Int
  let minor: Int
  let patch: Int

  init(rawValue: String) throws {
    let normalized = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
      .trimmingCharacters(in: CharacterSet(charactersIn: "v"))
      .split(separator: "-")
      .first
      .map(String.init) ?? ""

    let parts = normalized.split(separator: ".").map(String.init)
    guard parts.count >= 3 else {
      throw BundledCLISyncError.invalidVersion(rawValue)
    }

    guard let major = Int(parts[0] ?? ""),
          let minor = Int(parts[1] ?? ""),
          let patch = Int(parts[2] ?? "") else {
      throw BundledCLISyncError.invalidVersion(rawValue)
    }

    self.rawValue = normalized
    self.major = major
    self.minor = minor
    self.patch = patch
  }

  static func parseFromHackVersionOutput(_ text: String) -> Version? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let range = trimmed.range(of: "v", options: .backwards) else { return nil }
    let candidate = String(trimmed[range.upperBound...])
    return try? Version(rawValue: candidate)
  }

  static func < (lhs: Version, rhs: Version) -> Bool {
    if lhs.major != rhs.major { return lhs.major < rhs.major }
    if lhs.minor != rhs.minor { return lhs.minor < rhs.minor }
    return lhs.patch < rhs.patch
  }
}

