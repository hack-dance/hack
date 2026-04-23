import Foundation
import Observation

import HackCLIService
import HackDesktopModels

public enum SidebarItem: Hashable, Identifiable {
  case home
  case runtime
  case project(String)

  public var id: String {
    switch self {
    case .home:
      return "home"
    case .runtime:
      return "runtime"
    case let .project(id):
      return "project:\(id)"
    }
  }
}

public enum ProjectTab: String, CaseIterable {
  case overview = "Overview"
  case branches = "Branches"
  case sessions = "Sessions"
  case logs = "Logs"
  case shell = "Shell"
}

public enum ProjectLifecycleAction {
  case starting
  case stopping
}

public enum GlobalLifecycleAction {
  case starting
  case stopping
}

public enum RuntimeHealthState {
  case healthy
  case degraded
  case down
  case unknown
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
  public var selectedItem: SidebarItem? = .home {
    didSet {
      handleSelectedItemChange(previous: oldValue, current: selectedItem)
    }
  }
  public var selectedProjectTab: ProjectTab = .overview
  public var errorMessage: String? = nil
  public var statusMessage: String? = nil
  public var isRefreshing = false
  public private(set) var projectLifecycleActions: [String: ProjectLifecycleAction] = [:]
  public private(set) var globalLifecycleAction: GlobalLifecycleAction? = nil

  private let client: HackCLIClient
  private var lastSelectedProjectId: String? = nil
  private var refreshTask: Task<Void, Never>? = nil
  private var statusClearTask: Task<Void, Never>? = nil

  public init(client: HackCLIClient) {
    self.client = client
  }

  public var selectedProject: ProjectSummary? {
    guard case let .project(id) = selectedItem else { return nil }
    return projects.first { $0.id == id }
  }

  public var runtimeOverallOk: Bool? {
    if runtimeOk == false { return false }
    if let summaryOk = globalStatus?.summary.ok { return summaryOk }
    return runtimeOk
  }

  public var runtimeHealthState: RuntimeHealthState {
    if runtimeOverallOk == true { return .healthy }
    if globalInfraDown { return .down }
    if runtimeOverallOk == false { return .degraded }
    return .unknown
  }

  public var globalInfraRunning: Bool {
    globalInfraRunningState == true
  }

  public var globalInfraDown: Bool {
    globalInfraRunningState == false
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
    projectLifecycleActions[project.id] = .starting
    defer { projectLifecycleActions.removeValue(forKey: project.id) }
    await runAction(message: "Starting \(project.name)…") {
      try await self.client.startProject(path: path)
    }
  }

  public func stopProject(_ project: ProjectSummary) async {
    guard let path = resolveProjectPath(project) else {
      errorMessage = "Missing project path for \(project.name)"
      return
    }
    projectLifecycleActions[project.id] = .stopping
    defer { projectLifecycleActions.removeValue(forKey: project.id) }
    await runAction(message: "Stopping \(project.name)…") {
      try await self.client.stopProject(path: path)
    }
  }

  public func showLogs(for project: ProjectSummary, branch: String? = nil) {
    selectedItem = .project(project.id)
    if selectedProjectTab == .logs {
      selectedProjectTab = .overview
    }
    let normalizedBranch = branch?.trimmingCharacters(in: .whitespacesAndNewlines)
    let resolvedBranch = (normalizedBranch?.isEmpty == false) ? normalizedBranch : nil
    var userInfo: [String: String] = [
      TerminalOpenRequest.projectIdKey: project.id,
      TerminalOpenRequest.kindKey: TerminalDrawerModel.Kind.logs.rawValue
    ]
    if let resolvedBranch {
      userInfo[TerminalOpenRequest.branchKey] = resolvedBranch
    }
    NotificationCenter.default.post(
      name: .hackTerminalOpenRequested,
      object: nil,
      userInfo: userInfo
    )
  }

  public func showShell(for project: ProjectSummary) {
    selectedItem = .project(project.id)
    if selectedProjectTab == .shell {
      selectedProjectTab = .overview
    }
    NotificationCenter.default.post(
      name: .hackTerminalOpenRequested,
      object: nil,
      userInfo: [
        TerminalOpenRequest.projectIdKey: project.id,
        TerminalOpenRequest.kindKey: TerminalDrawerModel.Kind.shell.rawValue
      ]
    )
  }

  public func startBranch(for project: ProjectSummary, branch: String) async {
    guard let path = resolveProjectPath(project) else {
      errorMessage = "Missing project path for \(project.name)"
      return
    }
    await runAction(message: "Starting \(project.name) [\(branch)]…") {
      try await self.client.startBranch(path: path, branch: branch)
    }
  }

  public func stopBranch(for project: ProjectSummary, branch: String) async {
    guard let path = resolveProjectPath(project) else {
      errorMessage = "Missing project path for \(project.name)"
      return
    }
    await runAction(message: "Stopping \(project.name) [\(branch)]…") {
      try await self.client.stopBranch(path: path, branch: branch)
    }
  }

  public func addBranch(for project: ProjectSummary, name: String, note: String?) async -> Bool {
    guard let path = resolveProjectPath(project) else {
      errorMessage = "Missing project path for \(project.name)"
      return false
    }
    let result: Bool? = await runActionResult(message: "Adding branch \(name)…") {
      try await self.client.addBranch(path: path, name: name, note: note)
      return true
    }
    return result ?? false
  }

  public func removeBranch(for project: ProjectSummary, name: String) async {
    guard let path = resolveProjectPath(project) else {
      errorMessage = "Missing project path for \(project.name)"
      return
    }
    await runAction(message: "Removing branch \(name)…") {
      try await self.client.removeBranch(path: path, name: name)
    }
  }

  public func stopSession(name: String) async {
    await runAction(message: "Stopping session \(name)…") {
      try await self.client.stopSession(name: name)
    }
  }

  public func startSession(for project: ProjectSummary) async {
    await runAction(message: "Starting session for \(project.name)…") {
      try await self.client.startSession(projectName: project.name, detached: true)
    }
  }

  @discardableResult
  public func setGlobalConfig(key: String, value: String) async -> Bool {
    let result: Bool? = await runActionResult(message: "Updating \(key)…") {
      try await self.client.setGlobalConfig(key: key, value: value)
      return true
    }
    return result ?? false
  }

  @discardableResult
  public func setProjectConfig(
    for project: ProjectSummary,
    key: String,
    value: String
  ) async -> Bool {
    guard let path = resolveProjectPath(project) else {
      errorMessage = "Missing project path for \(project.name)"
      return false
    }
    let result: Bool? = await runActionResult(message: "Updating \(key)…") {
      try await self.client.setProjectConfig(key: key, value: value, projectPath: path)
      return true
    }
    return result ?? false
  }

  public func getProjectConfig(
    for project: ProjectSummary,
    key: String
  ) async -> String? {
    guard let path = resolveProjectPath(project) else {
      errorMessage = "Missing project path for \(project.name)"
      return nil
    }
    do {
      return try await client.getProjectConfigValue(key: key, projectPath: path)
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  public func getGlobalConfig(key: String) async -> String? {
    do {
      return try await client.getGlobalConfigValue(key: key)
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  public func startCloudflareTunnel() async -> Bool {
    let result: Bool? = await runActionResult(message: "Starting cloudflared tunnel…") {
      try await self.client.startCloudflareTunnel()
      return true
    }
    return result ?? false
  }

  public func stopCloudflareTunnel() async -> Bool {
    let result: Bool? = await runActionResult(message: "Stopping cloudflared tunnel…") {
      try await self.client.stopCloudflareTunnel()
      return true
    }
    return result ?? false
  }

  public func toggleGlobalInfrastructure() async {
    if globalInfraRunning {
      await globalDown()
    } else {
      await globalUp()
    }
  }


  public func globalUp() async {
    globalLifecycleAction = .starting
    defer { globalLifecycleAction = nil }
    await runGlobalCommand(
      message: "Starting global services…",
      fallbackCommand: "hack global up"
    ) {
      try await self.client.globalUp()
    }
  }

  public func globalDown() async {
    globalLifecycleAction = .stopping
    defer { globalLifecycleAction = nil }
    await runGlobalCommand(
      message: "Stopping global services…",
      fallbackCommand: "hack global down"
    ) {
      try await self.client.globalDown()
    }
  }

  private func resolveProjectPath(_ project: ProjectSummary) -> String? {
    project.repoRoot ?? project.projectDir
  }

  private func handleSelectedItemChange(previous: SidebarItem?, current: SidebarItem?) {
    guard let currentProjectId = projectId(from: current) else {
      return
    }

    let previousProjectId = projectId(from: previous) ?? lastSelectedProjectId
    if previousProjectId != currentProjectId {
      selectedProjectTab = .overview
    }
    lastSelectedProjectId = currentProjectId
  }

  private func projectId(from item: SidebarItem?) -> String? {
    guard case let .project(id) = item else {
      return nil
    }
    return id
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
        selectedItem = .home
      }
      if case let .project(id) = selectedItem, !projects.contains(where: { $0.id == id }) {
        selectedItem = .home
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
      daemonStatus = nil
      return error.localizedDescription
    }
  }

  private func fetchGlobalStatus() async -> String? {
    do {
      globalStatus = try await client.fetchGlobalStatus()
      return nil
    } catch {
      globalStatus = nil
      return error.localizedDescription
    }
  }

  private var globalInfraRunningState: Bool? {
    guard let status = globalStatus else { return nil }
    let caddyOk = status.caddy?.ok ?? status.summary.caddyOk
    let loggingOk = status.logging?.ok ?? status.summary.loggingOk
    let networksOk = status.networks?.ok ?? status.summary.networksOk
    return caddyOk && loggingOk && networksOk
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

  private func runActionResult<T>(
    message: String,
    refreshDashboard: Bool = true,
    action: @escaping () async throws -> T
  ) async -> T? {
    statusMessage = message
    statusClearTask?.cancel()

    do {
      let result = try await action()
      statusMessage = "Done"
      if refreshDashboard {
        await refresh()
      }
      statusClearTask = Task { [weak self] in
        try? await Task.sleep(for: .seconds(2))
        self?.statusMessage = nil
      }
      return result
    } catch {
      statusMessage = nil
      errorMessage = error.localizedDescription
      return nil
    }
  }

  private func runGlobalCommand(
    message: String,
    fallbackCommand: String,
    action: @escaping () async throws -> Void
  ) async {
    statusMessage = message
    statusClearTask?.cancel()

    do {
      try await action()
      statusMessage = "Done"
      await refresh()
      scheduleStatusClear()
    } catch let error {
      await refresh()
      if shouldFallbackToTerminal(for: error) {
        TerminalIntegration.openTerminalWithCommand(fallbackCommand)
        statusMessage = "Opened Terminal for \(fallbackCommand)"
        scheduleStatusClear()
        return
      }
      statusMessage = nil
      errorMessage = error.localizedDescription
    }
  }

  private func shouldFallbackToTerminal(for error: Error) -> Bool {
    let message = error.localizedDescription.lowercased()
    return message.contains("sudo")
      || message.contains("permission denied")
      || message.contains("operation not permitted")
      || message.contains("not permitted")
      || message.contains("no tty")
      || message.contains("password")
  }

  private func scheduleStatusClear() {
    statusClearTask = Task { [weak self] in
      try? await Task.sleep(for: .seconds(2))
      self?.statusMessage = nil
    }
  }
}
