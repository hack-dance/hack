import AppKit
import SwiftUI

import HackDesktopModels

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
  @AppStorage("hackDesktop.preferences.defaultCodingAgent") private var preferredCodingAgentRaw = CodingAgentIntegration.AgentApp.codex.rawValue
  @AppStorage("hackDesktop.preferences.defaultCodingAgentBinaryPath") private var preferredCodingAgentBinaryPathRaw = ""
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
      CommandPaletteAction(title: "Go to Dashboard", subtitle: "Home overview") {
        model.selectedItem = .home
      }
    )

    actions.append(
      CommandPaletteAction(title: "Go to Runtime Settings", subtitle: "System status + daemon") {
        NotificationCenter.default.post(
          name: .hackSettingsRequested,
          object: nil,
          userInfo: [SettingsNavigationRequest.paneKey: SettingsSidebarItem.runtime.rawValue]
        )
      }
    )
    actions.append(
      CommandPaletteAction(title: "Go to Topology Settings", subtitle: "Node + gateway network topology") {
        NotificationCenter.default.post(
          name: .hackSettingsRequested,
          object: nil,
          userInfo: [SettingsNavigationRequest.paneKey: SettingsSidebarItem.topology.rawValue]
        )
      }
    )
    actions.append(
      CommandPaletteAction(title: "Go to Gateway Settings", subtitle: "Gateway configuration") {
        NotificationCenter.default.post(
          name: .hackSettingsRequested,
          object: nil,
          userInfo: [SettingsNavigationRequest.paneKey: SettingsSidebarItem.gateway.rawValue]
        )
      }
    )
    actions.append(
      CommandPaletteAction(title: "Go to Railway Settings", subtitle: "Railway provider + bootstrap controls") {
        NotificationCenter.default.post(
          name: .hackSettingsRequested,
          object: nil,
          userInfo: [SettingsNavigationRequest.paneKey: SettingsSidebarItem.railway.rawValue]
        )
      }
    )
    actions.append(
      CommandPaletteAction(title: "Go to Permissions Settings", subtitle: "Automation + local network access") {
        NotificationCenter.default.post(
          name: .hackSettingsRequested,
          object: nil,
          userInfo: [SettingsNavigationRequest.paneKey: SettingsSidebarItem.permissions.rawValue]
        )
      }
    )
    actions.append(
      CommandPaletteAction(
        title: model.globalInfraRunning ? "Global: Stop services" : "Global: Start services",
        subtitle: model.globalInfraRunning ? "Runs `hack global down`" : "Runs `hack global up`"
      ) {
        Task { await model.toggleGlobalInfrastructure() }
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
      if let projectPath = projectAgentPath(project) {
        actions.append(
          CommandPaletteAction(
            title: "Project: Open in \(preferredCodingAgent.displayName)",
            subtitle: "Starts your preferred coding agent"
          ) {
            openPreferredCodingAgent(for: project, path: projectPath)
          }
        )
      }
      actions.append(
        CommandPaletteAction(title: "Project: Overview", subtitle: project.name) {
          model.selectedProjectTab = .overview
        }
      )
      if project.isRuntimeConfigured {
        actions.append(
          CommandPaletteAction(title: "Project: Logs", subtitle: project.name) {
            NotificationCenter.default.post(
              name: .hackTerminalOpenRequested,
              object: nil,
              userInfo: [
                TerminalOpenRequest.projectIdKey: project.id,
                TerminalOpenRequest.kindKey: TerminalDrawerModel.Kind.logs.rawValue
              ]
            )
          }
        )
        actions.append(
          CommandPaletteAction(title: "Project: Shell", subtitle: project.name) {
            NotificationCenter.default.post(
              name: .hackTerminalOpenRequested,
              object: nil,
              userInfo: [
                TerminalOpenRequest.projectIdKey: project.id,
                TerminalOpenRequest.kindKey: TerminalDrawerModel.Kind.shell.rawValue
              ]
            )
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

  private var preferredCodingAgent: CodingAgentIntegration.AgentApp {
    if let explicit = CodingAgentIntegration.AgentApp(rawValue: preferredCodingAgentRaw) {
      return explicit
    }
    return .codex
  }

  private func projectAgentPath(_ project: ProjectSummary) -> String? {
    if let repoRoot = project.repoRoot, !repoRoot.isEmpty {
      return repoRoot
    }
    if let projectDir = project.projectDir, !projectDir.isEmpty {
      return projectDir
    }
    return nil
  }

  private func openPreferredCodingAgent(for project: ProjectSummary, path: String) {
    let command = CodingAgentIntegration.launchCommand(
      projectPath: path,
      agent: preferredCodingAgent,
      binaryOverridePath: preferredCodingAgentBinaryPathRaw
    )
    NotificationCenter.default.post(
      name: .hackTerminalOpenRequested,
      object: nil,
      userInfo: [
        TerminalOpenRequest.projectIdKey: project.id,
        TerminalOpenRequest.kindKey: TerminalDrawerModel.Kind.shell.rawValue,
        TerminalOpenRequest.commandKey: command,
        TerminalOpenRequest.titleKey: "\(preferredCodingAgent.displayName) - \(project.name)"
      ]
    )
  }
}
