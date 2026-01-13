import SwiftUI

import HackDesktopModels

public struct DashboardView: View {
  @Environment(DashboardModel.self) private var model

  public init() {}

  public var body: some View {
    @Bindable var model = model

    NavigationSplitView {
      sidebar
    } detail: {
      detail
    }
    .navigationTitle("Hack Desktop")
    .sheet(item: $model.logsProject) { project in
      LogsView(project: project)
    }
    .task {
      model.start()
    }
    .toolbar {
      ToolbarItemGroup(placement: .primaryAction) {
        Button("Refresh") {
          Task { await model.refresh() }
        }
        if model.daemonStatus?.running == true {
          Button("Stop hackd") {
            Task { await model.stopDaemon() }
          }
        } else {
          Button("Start hackd") {
            Task { await model.startDaemon() }
          }
        }
      }
    }
  }

  private var sidebar: some View {
    @Bindable var model = model

    return List(selection: $model.selectedItem) {
      Section("System") {
        HackdRowView(running: model.daemonStatus?.running)
          .tag(SidebarItem.hackd)
      }
      Section("Projects") {
        ForEach(model.projects) { project in
          ProjectRowView(project: project)
            .tag(SidebarItem.project(project.id))
        }
      }
    }
    .listStyle(.sidebar)
    .safeAreaInset(edge: .bottom) {
      footer
    }
  }

  private var detail: some View {
    Group {
      switch model.selectedItem {
      case .hackd:
        HackdDetailView()
      case let .project(id):
        if let project = model.projects.first(where: { $0.id == id }) {
          ProjectDetailView(project: project)
        } else {
          ContentUnavailableView("Project missing", systemImage: "exclamationmark.triangle")
        }
      case .none:
        ContentUnavailableView("Select a sidebar item", systemImage: "square.stack")
      }
    }
  }

  private var footer: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let errorMessage = model.errorMessage {
        Text(errorMessage)
          .font(.caption)
          .foregroundStyle(.red)
      }
      HStack {
        Text(runtimeLabel)
          .font(.caption)
          .foregroundStyle(.secondary)
        Spacer()
        if let statusMessage = model.statusMessage {
          Text(statusMessage)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .background(.ultraThinMaterial)
  }

  private var runtimeLabel: String {
    if model.runtimeOk == true {
      return "Runtime: ok"
    }
    if let error = model.runtimeError, !error.isEmpty {
      return "Runtime: \(error)"
    }
    return "Runtime: unknown"
  }
}
