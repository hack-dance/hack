import Foundation
import Observation

import HackCLIService
import HackDesktopModels

@Observable
@MainActor
public final class DashboardModel {
  public private(set) var projects: [ProjectSummary] = []
  public private(set) var daemonStatus: DaemonStatus? = nil
  public private(set) var runtimeOk: Bool? = nil
  public private(set) var runtimeError: String? = nil
  public private(set) var lastUpdated: Date? = nil
  public var selectedProjectId: String? = nil
  public var logsProject: ProjectSummary? = nil
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
    projects.first { $0.id == selectedProjectId }
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

    let errors = await [projectsTask, daemonTask].compactMap { $0 }
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
    logsProject = project
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
      if selectedProjectId == nil {
        selectedProjectId = projects.first?.id
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
