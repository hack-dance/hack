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

    MenuBarExtra("Hack", systemImage: "square.stack.3d.up") {
      MenuBarView()
        .environment(model)
    }
    .menuBarExtraStyle(.menu)
  }
}
