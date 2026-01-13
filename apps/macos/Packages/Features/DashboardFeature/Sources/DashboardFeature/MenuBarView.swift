import AppKit
import SwiftUI

import HackDesktopModels

public struct MenuBarView: View {
  @Environment(DashboardModel.self) private var model

  public init() {}

  public var body: some View {
    @Bindable var model = model

    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text("Hack Desktop")
          .font(.headline)
        Spacer()
        Button("Refresh") {
          Task { await model.refresh() }
        }
        .buttonStyle(.borderless)
      }

      daemonStatusLine

      Divider()

      ForEach(model.projects.prefix(6)) { project in
        VStack(alignment: .leading, spacing: 6) {
          HStack {
            Text(project.name)
              .font(.subheadline)
            Spacer()
            StatusBadge(status: project.status)
          }
          HStack(spacing: 8) {
            Button("Start") { Task { await model.startProject(project) } }
              .disabled(project.status == .running)
            Button("Stop") { Task { await model.stopProject(project) } }
              .disabled(project.status != .running)
            Button("Logs") { model.showLogs(for: project) }
          }
          .font(.caption)
        }
      }

      if model.projects.count > 6 {
        Text("+ \(model.projects.count - 6) more")
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      Divider()

      HStack {
        Button("Open Hack Desktop") {
          activateApp()
        }
        Spacer()
        Button("Quit") {
          NSApp.terminate(nil)
        }
      }
    }
    .padding(12)
    .frame(width: 320)
    .task {
      model.start()
    }
  }

  private var daemonStatusLine: some View {
    HStack(spacing: 8) {
      Circle()
        .fill(model.daemonStatus?.running == true ? Color.green : Color.red)
        .frame(width: 8, height: 8)
      Text(model.daemonStatus?.running == true ? "hackd running" : "hackd stopped")
        .font(.caption)
        .foregroundStyle(.secondary)
      Spacer()
      if model.daemonStatus?.running == true {
        Button("Stop") { Task { await model.stopDaemon() } }
      } else {
        Button("Start") { Task { await model.startDaemon() } }
      }
    }
  }

  private func activateApp() {
    NSApp.activate(ignoringOtherApps: true)
    NSApp.windows.first?.makeKeyAndOrderFront(nil)
  }
}
