import SwiftUI

import DashboardFeature
import HackCLIService

#if RELEASE
import Sparkle
#endif

@main
struct HackDesktopApp: App {
  @State private var model = DashboardModel(client: HackCLIClient())
  @State private var didSyncBundledCLI = false

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
        .environment(model)
#if RELEASE
        .task {
          await syncBundledCLIIfNeeded()
        }
#endif
    }
    .defaultSize(width: 1100, height: 720)
    .commands {
      DashboardCommands(checkForUpdates: checkForUpdatesAction)
    }

    MenuBarExtra("Hack", systemImage: "square.stack.3d.up") {
      MenuBarView()
        .environment(model)
    }
    .menuBarExtraStyle(.menu)
  }

  private var checkForUpdatesAction: (() -> Void)? {
#if RELEASE
    return { updaterController.checkForUpdates(nil) }
#else
    return nil
#endif
  }

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
  let checkForUpdates: (() -> Void)?

  var body: some Commands {
    CommandGroup(after: .appInfo) {
      if let checkForUpdates {
        Button("Check for Updates…") {
          checkForUpdates()
        }
      }

      Button("Refresh") {
        NotificationCenter.default.post(name: .hackRefreshRequested, object: nil)
      }
      .keyboardShortcut("r", modifiers: .command)

      Button("Command Palette") {
        NotificationCenter.default.post(name: .hackCommandPaletteRequested, object: nil)
      }
      .keyboardShortcut("k", modifiers: .command)
    }
  }
}
