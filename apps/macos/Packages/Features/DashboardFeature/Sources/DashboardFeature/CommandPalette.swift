import AppKit
import SwiftUI

extension Notification.Name {
  public static let hackCommandPaletteRequested = Notification.Name("hack.commandPalette.requested")
  public static let hackRefreshRequested = Notification.Name("hack.refresh.requested")
}

struct CommandPaletteAction: Identifiable {
  let id = UUID()
  let title: String
  let subtitle: String?
  let handler: () -> Void
}

struct CommandPaletteView: View {
  @Environment(DashboardModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var query = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      TextField("Type a command…", text: $query)
        .textFieldStyle(.roundedBorder)
      List(filteredActions) { action in
        Button {
          action.handler()
          dismiss()
        } label: {
          VStack(alignment: .leading, spacing: 4) {
            Text(action.title)
              .font(.mono(.subheadline, weight: .semibold))
            if let subtitle = action.subtitle {
              Text(subtitle)
                .font(.mono(.caption))
                .foregroundStyle(.secondary)
            }
          }
        }
        .buttonStyle(.plain)
      }
      .listStyle(.plain)
    }
    .padding(16)
    .frame(minWidth: 520, idealWidth: 640, minHeight: 360)
  }

  private var filteredActions: [CommandPaletteAction] {
    let all = buildActions()
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return all }
    let lower = trimmed.lowercased()
    return all.filter {
      $0.title.lowercased().contains(lower) || ($0.subtitle?.lowercased().contains(lower) ?? false)
    }
  }

  private func buildActions() -> [CommandPaletteAction] {
    var actions: [CommandPaletteAction] = []

    actions.append(
      CommandPaletteAction(title: "Refresh", subtitle: "Reload status and projects") {
        Task { await model.refresh() }
      }
    )

    actions.append(
      CommandPaletteAction(title: "Go to Runtime", subtitle: "System status") {
        model.selectedItem = .runtime
      }
    )
    actions.append(
      CommandPaletteAction(title: "Go to Gateway", subtitle: "Gateway configuration") {
        model.selectedItem = .gateway
      }
    )

    for project in model.projects {
      actions.append(
        CommandPaletteAction(title: "Open Project: \(project.name)", subtitle: project.devHost ?? project.projectDir) {
          model.selectedItem = .project(project.id)
        }
      )
    }

    if let project = model.selectedProject {
      actions.append(
        CommandPaletteAction(title: "Project: Overview", subtitle: project.name) {
          model.selectedProjectTab = .overview
        }
      )
      if project.isRuntimeConfigured {
        actions.append(
          CommandPaletteAction(title: "Project: Logs", subtitle: project.name) {
            model.selectedProjectTab = .logs
          }
        )
        actions.append(
          CommandPaletteAction(title: "Project: Shell", subtitle: project.name) {
            model.selectedProjectTab = .shell
          }
        )
      }
      if project.supportsTickets {
        actions.append(
          CommandPaletteAction(title: "Project: Tickets", subtitle: project.name) {
            model.selectedProjectTab = .tickets
          }
        )
      }

      actions.append(
        CommandPaletteAction(title: "Project: Refresh", subtitle: project.name) {
          Task { await model.refresh() }
        }
      )
      if project.isRuntimeConfigured {
        actions.append(
          CommandPaletteAction(title: "Project: Start", subtitle: project.name) {
            Task { await model.startProject(project) }
          }
        )
        actions.append(
          CommandPaletteAction(title: "Project: Stop", subtitle: project.name) {
            Task { await model.stopProject(project) }
          }
        )
      }
      if let host = project.devHost, let url = URL(string: host.contains("://") ? host : "https://\(host)") {
        actions.append(
          CommandPaletteAction(title: "Project: Open URL", subtitle: url.absoluteString) {
            NSWorkspace.shared.open(url)
          }
        )
      }
      if project.supportsTickets {
        actions.append(
          CommandPaletteAction(title: "Tickets: Sync", subtitle: project.name) {
            Task { _ = await model.syncTickets(for: project) }
          }
        )
        actions.append(
          CommandPaletteAction(title: "Tickets: Setup", subtitle: project.name) {
            Task { _ = await model.setupTickets(for: project) }
          }
        )
      }
    }

    return actions
  }
}
