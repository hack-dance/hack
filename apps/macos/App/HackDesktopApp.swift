import SwiftUI

import DashboardFeature
import HackCLIService

@main
struct HackDesktopApp: App {
  @State private var model = DashboardModel(client: HackCLIClient())

  var body: some Scene {
    WindowGroup {
      DashboardView()
        .environment(model)
    }
    .defaultSize(width: 1100, height: 720)
    .commands {
      DashboardCommands()
    }

    MenuBarExtra("Hack", systemImage: "square.stack.3d.up") {
      MenuBarView()
        .environment(model)
    }
    .menuBarExtraStyle(.menu)
  }
}

private struct DashboardCommands: Commands {
  var body: some Commands {
    CommandGroup(after: .appInfo) {
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
