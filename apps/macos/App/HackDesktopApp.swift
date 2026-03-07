import Foundation
import SwiftUI

import DashboardFeature
import HackCLIService

#if os(macOS)
import AppKit
#endif

#if RELEASE
import Sparkle
#endif

@main
struct HackDesktopApp: App {
  @State private var model = DashboardModel(client: HackCLIClient())
  @State private var didSyncBundledCLI = false
  @State private var updateCheckTask: Task<Void, Never>? = nil
  @AppStorage("hackDesktop.preferences.theme") private var appearanceThemeRaw = "system"
  @AppStorage("hackDesktop.update.available") private var updateAvailable = false
  @AppStorage("hackDesktop.update.latestVersion") private var latestKnownReleaseVersion = ""
  @AppStorage("hackDesktop.update.lastCheckedAt") private var updateLastCheckedAt = ""

#if RELEASE
  private let updaterController = SPUStandardUpdaterController(
    startingUpdater: true,
    updaterDelegate: nil,
    userDriverDelegate: nil
  )
#endif

  var body: some Scene {
    WindowGroup {
      DashboardView()
        .preferredColorScheme(preferredColorScheme)
        .environment(model)
        .onOpenURL { url in
          handleIncomingDeepLink(url: url)
        }
        .onReceive(NotificationCenter.default.publisher(for: .hackCheckForUpdatesRequested)) { _ in
          performCheckForUpdates()
        }
        .task {
          await startUpdateMonitoringIfNeeded()
        }
#if RELEASE
        .task {
          await syncBundledCLIIfNeeded()
        }
#endif
    }
    .defaultSize(width: 1100, height: 720)
    .commands {
      DashboardCommands(checkForUpdates: performCheckForUpdates)
    }

    MenuBarExtra("Hack", systemImage: "square.stack.3d.up") {
      MenuBarView(checkForUpdates: performCheckForUpdates)
        .environment(model)
    }
    .menuBarExtraStyle(.menu)
  }

  private var checkForUpdatesAction: () -> Void {
#if RELEASE
    return { updaterController.checkForUpdates(nil) }
#else
    return {
      guard let url = URL(string: "https://github.com/hack-dance/hack/releases/latest") else {
        return
      }
      NSWorkspace.shared.open(url)
    }
#endif
  }

  private var preferredColorScheme: ColorScheme? {
    switch appearanceThemeRaw {
    case "light":
      return .light
    case "dark":
      return .dark
    default:
      return nil
    }
  }

  @MainActor
  private func startUpdateMonitoringIfNeeded() async {
    guard updateCheckTask == nil else { return }

    updateCheckTask = Task {
      await refreshUpdateAvailability()
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(3600))
        await refreshUpdateAvailability()
      }
    }
  }

  private func performCheckForUpdates() {
    checkForUpdatesAction()
    Task {
      await refreshUpdateAvailability()
    }
  }

  @MainActor
  private func handleIncomingDeepLink(url: URL) {
    let handledHackAuth = model.ingestHackAuthDeepLink(url: url)
    let handledGitHub = model.ingestGitHubOAuthDeepLink(url: url)
    let handledLinear = model.ingestLinearOAuthDeepLink(url: url)
    guard handledHackAuth || handledGitHub || handledLinear else { return }

#if os(macOS)
    NSApp.activate(ignoringOtherApps: true)
#endif
    NotificationCenter.default.post(
      name: .hackSettingsRequested,
      object: nil,
      userInfo: [
        "pane": handledHackAuth ? "account" : (handledLinear ? "linear" : "github"),
      ]
    )
  }

  private func refreshUpdateAvailability() async {
    let currentVersion = Self.normalizedReleaseVersion(appVersion)
    do {
      let latestVersion = try await fetchLatestReleaseVersion()
      let normalizedLatest = Self.normalizedReleaseVersion(latestVersion)
      let isUpdateAvailable = Self.isVersion(normalizedLatest, newerThan: currentVersion)
      await MainActor.run {
        latestKnownReleaseVersion = normalizedLatest
        updateAvailable = isUpdateAvailable
        updateLastCheckedAt = Self.updateTimestampFormatter.string(from: Date())
      }
    } catch {
      await MainActor.run {
        updateLastCheckedAt = Self.updateTimestampFormatter.string(from: Date())
      }
    }
  }

  private var appVersion: String {
    Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
  }

  private func fetchLatestReleaseVersion() async throws -> String {
    guard let url = URL(string: "https://api.github.com/repos/hack-dance/hack/releases/latest") else {
      throw UpdateCheckError.invalidURL
    }
    var request = URLRequest(url: url)
    request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
    request.setValue("HackDesktop", forHTTPHeaderField: "User-Agent")
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
      throw UpdateCheckError.badResponse
    }
    let payload = try JSONDecoder().decode(LatestReleaseResponse.self, from: data)
    return payload.tagName
  }

  nonisolated private static func normalizedReleaseVersion(_ version: String) -> String {
    let trimmed = version.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.hasPrefix("v") || trimmed.hasPrefix("V") {
      return String(trimmed.dropFirst())
    }
    return trimmed
  }

  nonisolated private static func isVersion(_ lhs: String, newerThan rhs: String) -> Bool {
    let left = SemanticVersion(lhs)
    let right = SemanticVersion(rhs)
    if let left, let right {
      return left > right
    }
    return lhs != rhs
  }

  private enum UpdateCheckError: Error {
    case invalidURL
    case badResponse
  }

  private struct LatestReleaseResponse: Decodable {
    let tagName: String

    enum CodingKeys: String, CodingKey {
      case tagName = "tag_name"
    }
  }

  private struct SemanticVersion: Comparable {
    let major: Int
    let minor: Int
    let patch: Int

    init?(_ rawValue: String) {
      let normalized = HackDesktopApp.normalizedReleaseVersion(rawValue)
      guard !normalized.isEmpty else { return nil }
      let coreVersion = normalized.split(separator: "-", maxSplits: 1).first.map(String.init) ?? normalized
      let components = coreVersion.split(separator: ".")
      if components.isEmpty {
        return nil
      }

      func component(at index: Int) -> Int? {
        if index >= components.count {
          return 0
        }
        return Int(components[index])
      }

      guard
        let major = component(at: 0),
        let minor = component(at: 1),
        let patch = component(at: 2)
      else {
        return nil
      }

      self.major = major
      self.minor = minor
      self.patch = patch
    }

    static func < (lhs: SemanticVersion, rhs: SemanticVersion) -> Bool {
      if lhs.major != rhs.major {
        return lhs.major < rhs.major
      }
      if lhs.minor != rhs.minor {
        return lhs.minor < rhs.minor
      }
      return lhs.patch < rhs.patch
    }
  }

  private static let updateTimestampFormatter = ISO8601DateFormatter()

  @MainActor
  private func syncBundledCLIIfNeeded() async {
    if didSyncBundledCLI {
      return
    }
    didSyncBundledCLI = true

    let result: Result<BundledCLISyncOutcome, Error> = await Task.detached {
      do {
        return .success(try BundledCLISync.syncIfNeeded())
      } catch {
        return .failure(error)
      }
    }.value

    switch result {
    case let .success(outcome):
      guard outcome.didInstallOrUpdate, let message = outcome.message else { return }
      model.statusMessage = message
      Task { @MainActor [weak model] in
        try? await Task.sleep(for: .seconds(3))
        model?.statusMessage = nil
      }
    case let .failure(error):
      if model.errorMessage == nil {
        model.errorMessage = error.localizedDescription
      }
    }
  }
}

private struct DashboardCommands: Commands {
  let checkForUpdates: () -> Void

  var body: some Commands {
    CommandGroup(after: .appInfo) {
      Button("Check for Updates…") {
        checkForUpdates()
      }

      Button("Refresh") {
        NotificationCenter.default.post(name: .hackRefreshRequested, object: nil)
      }
      .keyboardShortcut("r", modifiers: .command)

      Button("Command Palette") {
        NotificationCenter.default.post(name: .hackCommandPaletteRequested, object: nil)
      }
      .keyboardShortcut("k", modifiers: .command)

      Button("Toggle Sidebar") {
#if os(macOS)
        NSApp.sendAction(#selector(NSSplitViewController.toggleSidebar(_:)), to: nil, from: nil)
#endif
      }
      .keyboardShortcut("b", modifiers: .command)
    }
  }
}
