import Foundation
import Observation

import HackCLIService
import HackDesktopModels

public enum SidebarItem: Hashable, Identifiable {
  case runtime
  case gateway
  case project(String)

  public var id: String {
    switch self {
    case .runtime:
      return "runtime"
    case .gateway:
      return "gateway"
    case let .project(id):
      return "project:\(id)"
    }
  }
}

public enum ProjectTab: String, CaseIterable {
  case overview = "Overview"
  case logs = "Logs"
  case shell = "Shell"
}

@Observable
@MainActor
public final class DashboardModel {
  public private(set) var projects: [ProjectSummary] = []
  public private(set) var daemonStatus: DaemonStatus? = nil
  public private(set) var globalStatus: GlobalStatusResponse? = nil
  public private(set) var runtimeOk: Bool? = nil
  public private(set) var runtimeError: String? = nil
  public private(set) var runtimeCheckedAt: String? = nil
  public private(set) var runtimeLastOkAt: String? = nil
  public private(set) var runtimeResetAt: String? = nil
  public private(set) var runtimeResetCount: Int? = nil
  public private(set) var lastUpdated: Date? = nil
  public var selectedItem: SidebarItem? = .runtime
  public var selectedProjectTab: ProjectTab = .overview
  public var errorMessage: String? = nil
  public var statusMessage: String? = nil
  public var isRefreshing = false

  private let client: HackCLIClient
  private var refreshTask: Task<Void, Never>? = nil
  private var statusClearTask: Task<Void, Never>? = nil

  public init(client: HackCLIClient) {
    self.client = client
  }

  public var selectedProject: ProjectSummary? {
    guard case let .project(id) = selectedItem else { return nil }
    return projects.first { $0.id == id }
  }

  public var gatewayExposures: [GatewayExposure] {
    globalStatus?.gateway?.exposures ?? []
  }

  public var runtimeOverallOk: Bool? {
    if runtimeOk == false { return false }
    if let summaryOk = globalStatus?.summary.ok { return summaryOk }
    return runtimeOk
  }

  var gatewaySummaryState: GatewaySummaryState? {
    let gatewayEnabled = globalStatus?.gateway?.gatewayEnabled ?? globalStatus?.summary.gatewayEnabled
    if globalStatus?.gateway == nil && gatewayEnabled == nil && gatewayExposures.isEmpty {
      return nil
    }
    return GatewaySummaryState.resolve(exposures: gatewayExposures, gatewayEnabled: gatewayEnabled)
  }

  public func start() {
    guard refreshTask == nil else { return }
    refreshTask = Task { [weak self] in
      guard let self else { return }
      await refresh()
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(12))
        await refresh()
      }
    }
  }

  public func refresh() async {
    isRefreshing = true
    errorMessage = nil
    defer {
      isRefreshing = false
      lastUpdated = Date()
    }

    async let projectsTask = fetchProjects()
    async let daemonTask = fetchDaemonStatus()
    async let globalTask = fetchGlobalStatus()

    let errors = await [projectsTask, daemonTask, globalTask].compactMap { $0 }
    if !errors.isEmpty {
      errorMessage = errors.joined(separator: "\n")
    }
  }

  public func startDaemon() async {
    await runAction(message: "Starting hackd…") {
      try await self.client.startDaemon()
    }
  }

  public func stopDaemon() async {
    await runAction(message: "Stopping hackd…") {
      try await self.client.stopDaemon()
    }
  }

  public func restartDaemon() async {
    await runAction(message: "Restarting hackd…") {
      try await self.client.restartDaemon()
    }
  }

  public func clearDaemon() async {
    await runAction(message: "Clearing hackd state…") {
      try await self.client.clearDaemon()
    }
  }

  public func startProject(_ project: ProjectSummary) async {
    guard let path = resolveProjectPath(project) else {
      errorMessage = "Missing project path for \(project.name)"
      return
    }
    await runAction(message: "Starting \(project.name)…") {
      try await self.client.startProject(path: path)
    }
  }

  public func stopProject(_ project: ProjectSummary) async {
    guard let path = resolveProjectPath(project) else {
      errorMessage = "Missing project path for \(project.name)"
      return
    }
    await runAction(message: "Stopping \(project.name)…") {
      try await self.client.stopProject(path: path)
    }
  }

  public func showLogs(for project: ProjectSummary) {
    selectedItem = .project(project.id)
    selectedProjectTab = .logs
  }

  public func showShell(for project: ProjectSummary) {
    selectedItem = .project(project.id)
    selectedProjectTab = .shell
  }

  private func resolveProjectPath(_ project: ProjectSummary) -> String? {
    project.repoRoot ?? project.projectDir
  }

  private func fetchProjects() async -> String? {
    do {
      let response = try await client.fetchProjects(includeGlobal: true)
      projects = response.projects.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
      runtimeOk = response.runtimeOk
      runtimeError = response.runtimeError
      runtimeCheckedAt = response.runtimeCheckedAt
      runtimeLastOkAt = response.runtimeLastOkAt
      runtimeResetAt = response.runtimeResetAt
      runtimeResetCount = response.runtimeResetCount
      if selectedItem == nil {
        selectedItem = .runtime
      }
      if case let .project(id) = selectedItem, !projects.contains(where: { $0.id == id }) {
        selectedItem = projects.first.map { .project($0.id) } ?? .runtime
      }
      return nil
    } catch {
      return error.localizedDescription
    }
  }

  private func fetchDaemonStatus() async -> String? {
    do {
      daemonStatus = try await client.daemonStatus()
      return nil
    } catch {
      return error.localizedDescription
    }
  }

  private func fetchGlobalStatus() async -> String? {
    do {
      globalStatus = try await client.fetchGlobalStatus()
      return nil
    } catch {
      return error.localizedDescription
    }
  }

  private func runAction(message: String, action: @escaping () async throws -> Void) async {
    statusMessage = message
    statusClearTask?.cancel()

    do {
      try await action()
      statusMessage = "Done"
    } catch {
      statusMessage = nil
      errorMessage = error.localizedDescription
      return
    }

    await refresh()

    statusClearTask = Task { [weak self] in
      try? await Task.sleep(for: .seconds(2))
      self?.statusMessage = nil
    }
  }
}
