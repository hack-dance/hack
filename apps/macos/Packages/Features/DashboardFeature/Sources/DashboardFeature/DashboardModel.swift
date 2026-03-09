import Foundation
import Observation

import HackCLIService
import HackDesktopModels

public enum SidebarItem: Hashable, Identifiable {
  case home
  case runtime
  case gateway
  case project(String)

  public var id: String {
    switch self {
    case .home:
      return "home"
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
  case branches = "Branches"
  case sessions = "Sessions"
  case logs = "Logs"
  case shell = "Shell"
  case tickets = "Tickets"
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

public struct GitHubOAuthDeepLinkContext: Hashable {
  public let flowId: String
  public let profileId: String?
  public let status: String?
  public let installationId: String?

  public init(
    flowId: String,
    profileId: String?,
    status: String?,
    installationId: String?
  ) {
    self.flowId = flowId
    self.profileId = profileId
    self.status = status
    self.installationId = installationId
  }
}

public struct LinearOAuthDeepLinkContext: Hashable {
  public let flowId: String
  public let profileId: String?
  public let status: String?

  public init(flowId: String, profileId: String?, status: String?) {
    self.flowId = flowId
    self.profileId = profileId
    self.status = status
  }
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
  public private(set) var hackAccountState: HackAccountSettingsState? = nil
  public private(set) var isLoadingHackAccountState = false
  public var selectedItem: SidebarItem? = .home {
    didSet {
      handleSelectedItemChange(previous: oldValue, current: selectedItem)
    }
  }
  public var selectedProjectTab: ProjectTab = .overview
  public var errorMessage: String? = nil
  public var statusMessage: String? = nil
  public private(set) var githubOAuthDeepLinkContext: GitHubOAuthDeepLinkContext? = nil
  public private(set) var linearOAuthDeepLinkContext: LinearOAuthDeepLinkContext? = nil
  public var isRefreshing = false
  public private(set) var projectLifecycleActions: [String: ProjectLifecycleAction] = [:]
  public private(set) var globalLifecycleAction: GlobalLifecycleAction? = nil

  private let client: HackCLIClient
  // Tickets should not be blocked by global refresh/status calls.
  private let ticketsClient: HackCLIClient
  private var lastSelectedProjectId: String? = nil
  private var refreshTask: Task<Void, Never>? = nil
  private var statusClearTask: Task<Void, Never>? = nil
  private var lastHackAccountRefreshAt: Date? = nil

  private static let hackAccountRefreshTTL: TimeInterval = 20

  public init(client: HackCLIClient, ticketsClient: HackCLIClient = HackCLIClient()) {
    self.client = client
    self.ticketsClient = ticketsClient
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

  var gatewaySummaryState: GatewaySummaryState? {
    let gatewayEnabled = globalStatus?.gateway?.gatewayEnabled ?? globalStatus?.summary.gatewayEnabled
    if globalStatus?.gateway == nil && gatewayEnabled == nil && gatewayExposures.isEmpty {
      return nil
    }
    return GatewaySummaryState.resolve(
      exposures: gatewayExposures,
      gatewayEnabled: gatewayEnabled,
      globalInfraRunning: globalInfraRunningState
    )
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
    async let hackAccountTask: Void = refreshHackAccountState(
      force: false,
      updateErrorMessage: false
    )

    let errors = await [projectsTask, daemonTask, globalTask].compactMap { $0 }
    _ = await hackAccountTask
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

  public func showTickets(for project: ProjectSummary) {
    selectedItem = .project(project.id)
    selectedProjectTab = .tickets
  }

  public func listTickets(for project: ProjectSummary) async throws -> [TicketSummary] {
    guard let path = resolveProjectPath(project) else {
      throw HackCLIError.commandFailed(exitCode: 1, stderr: "Missing project path for \(project.name)")
    }
    let response = try await ticketsClient.listTickets(path: path)
    return response.tickets
  }

  public func showTicket(for project: ProjectSummary, ticketId: String) async throws -> TicketDetailResponse {
    guard let path = resolveProjectPath(project) else {
      throw HackCLIError.commandFailed(exitCode: 1, stderr: "Missing project path for \(project.name)")
    }
    return try await ticketsClient.showTicket(path: path, ticketId: ticketId)
  }

  public func createTicket(
    for project: ProjectSummary,
    title: String,
    body: String?,
    dependsOn: [String],
    blocks: [String]
  ) async -> TicketSummary? {
    guard let path = resolveProjectPath(project) else {
      errorMessage = "Missing project path for \(project.name)"
      return nil
    }
    let response = await runActionResult(
      message: "Creating ticket…",
      refreshDashboard: false
    ) {
      try await self.ticketsClient.createTicket(
        path: path,
        title: title,
        body: body,
        dependsOn: dependsOn,
        blocks: blocks
      )
    }
    return response?.ticket
  }

  public func setTicketStatus(
    for project: ProjectSummary,
    ticketId: String,
    status: TicketStatus
  ) async -> TicketStatusResponse? {
    guard let path = resolveProjectPath(project) else {
      errorMessage = "Missing project path for \(project.name)"
      return nil
    }
    return await runActionResult(
      message: "Updating ticket status…",
      refreshDashboard: false
    ) {
      try await self.ticketsClient.setTicketStatus(path: path, ticketId: ticketId, status: status)
    }
  }

  public func appendTicketComment(
    for project: ProjectSummary,
    ticketId: String,
    body: String,
    source: String? = nil,
    actor: String? = nil
  ) async -> TicketCommentAppendResponse? {
    guard let path = resolveProjectPath(project) else {
      errorMessage = "Missing project path for \(project.name)"
      return nil
    }
    return await runActionResult(
      message: "Appending ticket comment…",
      refreshDashboard: false
    ) {
      try await self.ticketsClient.appendTicketComment(
        path: path,
        ticketId: ticketId,
        body: body,
        source: source,
        actor: actor
      )
    }
  }

  public func appendTicketReviewNote(
    for project: ProjectSummary,
    ticketId: String,
    body: String,
    actor: String? = nil
  ) async -> TicketReviewNoteAppendResponse? {
    guard let path = resolveProjectPath(project) else {
      errorMessage = "Missing project path for \(project.name)"
      return nil
    }
    return await runActionResult(
      message: "Appending review note…",
      refreshDashboard: false
    ) {
      try await self.ticketsClient.appendTicketReviewNote(
        path: path,
        ticketId: ticketId,
        body: body,
        actor: actor
      )
    }
  }

  public func syncTickets(for project: ProjectSummary) async -> TicketsSyncResult? {
    guard let path = resolveProjectPath(project) else {
      errorMessage = "Missing project path for \(project.name)"
      return nil
    }
    let response = await runActionResult(
      message: "Syncing tickets…",
      refreshDashboard: false
    ) {
      try await self.ticketsClient.syncTickets(path: path)
    }
    return response?.sync
  }

  public func resolveTicketConflict(
    for project: ProjectSummary,
    ticketId: String,
    conflictId: String,
    resolution: TicketSyncConflictResolution,
    summary: String? = nil
  ) async -> TicketConflictResolutionResponse? {
    guard let path = resolveProjectPath(project) else {
      errorMessage = "Missing project path for \(project.name)"
      return nil
    }
    return await runActionResult(
      message: "Resolving sync conflict…",
      refreshDashboard: false
    ) {
      try await self.ticketsClient.resolveTicketConflict(
        path: path,
        ticketId: ticketId,
        conflictId: conflictId,
        resolution: resolution,
        summary: summary
      )
    }
  }

  public func setupTickets(for project: ProjectSummary) async -> Bool {
    guard let path = resolveProjectPath(project) else {
      errorMessage = "Missing project path for \(project.name)"
      return false
    }
    let result = await runActionResult(message: "Setting up tickets…") {
      try await self.ticketsClient.setupTickets(path: path)
      return true
    }
    return result ?? false
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

  public func fetchGatewayTokens() async -> [GatewayTokenRecord] {
    do {
      return try await client.listGatewayTokens().tokens
    } catch {
      errorMessage = error.localizedDescription
      return []
    }
  }

  public func createGatewayToken(
    scope: GatewayTokenScope,
    label: String?
  ) async -> GatewayTokenCreateResponse? {
    await runActionResult(message: "Creating gateway token…") {
      try await self.client.createGatewayToken(scope: scope, label: label)
    }
  }

  public func revokeGatewayToken(id: String) async -> Bool {
    let response: GatewayTokenRevokeResponse? = await runActionResult(message: "Revoking gateway token…") {
      try await self.client.revokeGatewayToken(id: id)
    }
    guard let response else {
      return false
    }
    return response.revoked
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

  public func inspectTailscale() async -> TailscaleInspectResponse? {
    do {
      return try await client.inspectTailscale()
    } catch {
      let message = error.localizedDescription
      errorMessage = message
      return TailscaleInspectResponse(
        installed: false,
        binaryPath: nil,
        connected: false,
        backendState: nil,
        tailnetName: nil,
        magicDnsSuffix: nil,
        authUrl: nil,
        currentExitNodeId: nil,
        currentExitNodeName: nil,
        selfDevice: nil,
        peers: [],
        onlinePeerCount: 0,
        exitNodes: [],
        health: [],
        error: message
      )
    }
  }

  public func inspectTailscaleOAuthStatus(
    validate: Bool = false
  ) async -> TailscaleOAuthStatusResponse? {
    do {
      return try await client.inspectTailscaleOAuthStatus(validate: validate)
    } catch {
      let message = error.localizedDescription
      errorMessage = message
      return TailscaleOAuthStatusResponse(
        configured: false,
        clientId: nil,
        authRef: nil,
        tailnet: nil,
        keyExpirySeconds: nil,
        validated: nil,
        checkedAt: nil,
        tokenExpiresAt: nil,
        deleted: nil,
        error: message
      )
    }
  }

  public func connectTailscaleOAuth(
    request: TailscaleOAuthConnectRequest
  ) async -> TailscaleOAuthStatusResponse? {
    await runActionResult(message: "Saving Tailscale OAuth credentials…") {
      try await self.client.connectTailscaleOAuth(request: request)
    }
  }

  public func disconnectTailscaleOAuth(
    authRef: String? = nil
  ) async -> TailscaleOAuthStatusResponse? {
    await runActionResult(message: "Clearing Tailscale OAuth credentials…") {
      try await self.client.disconnectTailscaleOAuth(authRef: authRef)
    }
  }

  public func inspectRailway() async -> RailwayInspectResponse? {
    do {
      return try await client.inspectRailway()
    } catch {
      let message = error.localizedDescription
      errorMessage = message
      return RailwayInspectResponse(
        installed: false,
        binaryPath: nil,
        version: nil,
        authenticated: false,
        whoami: nil,
        error: message
      )
    }
  }

  public func inspectGitHubProfiles() async -> GitHubProfilesResponse? {
    do {
      return try await client.inspectGitHubProfiles()
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  public func inspectGitHubStatus(profileId: String? = nil) async -> GitHubStatusResponse? {
    do {
      return try await client.inspectGitHubStatus(profileId: profileId)
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  public func inspectSystemGitIdentity(projectPath: String? = nil) async -> GitSystemIdentity? {
    do {
      return try await client.inspectSystemGitIdentity(projectPath: projectPath)
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  public func inspectHackAccountSettingsState(
    force: Bool = false,
    updateErrorMessage: Bool = true
  ) async -> HackAccountSettingsState? {
    await refreshHackAccountState(
      force: force,
      updateErrorMessage: updateErrorMessage
    )
    return hackAccountState
  }

  public func refreshHackAccountState(
    force: Bool = false,
    updateErrorMessage: Bool = false
  ) async {
    if !force,
      let lastHackAccountRefreshAt,
      let hackAccountState,
      Date().timeIntervalSince(lastHackAccountRefreshAt) < Self.hackAccountRefreshTTL
    {
      _ = hackAccountState
      return
    }

    guard !isLoadingHackAccountState else {
      return
    }

    isLoadingHackAccountState = true
    defer {
      isLoadingHackAccountState = false
    }

    do {
      hackAccountState = try await client.inspectHackAccountSettingsState()
      lastHackAccountRefreshAt = Date()
    } catch {
      if updateErrorMessage {
        errorMessage = error.localizedDescription
      }
    }
  }

  public func loginHackAccount() async -> HackAccountSettingsState? {
    let didLogin: Bool? = await runActionResult(message: "Signing in to Hack…") {
      try await self.client.loginHackAccount()
      return true
    }
    guard didLogin == true else {
      return nil
    }
    await refreshHackAccountState(force: true, updateErrorMessage: true)
    return hackAccountState
  }

  public func logoutHackAccount() async -> HackAccountSettingsState? {
    let didLogout: Bool? = await runActionResult(message: "Signing out of Hack…") {
      try await self.client.logoutHackAccount()
      return true
    }
    guard didLogout == true else {
      return nil
    }
    await refreshHackAccountState(force: true, updateErrorMessage: true)
    return hackAccountState
  }

  public func startGitHubOAuthFlow(
    profileId: String,
    setDefault: Bool
  ) async -> GitHubOAuthFlowStartResponse? {
    do {
      return try await client.startGitHubOAuthFlow(
        profileId: profileId,
        setDefault: setDefault
      )
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  public func fetchGitHubOAuthFlowStatus(
    statusURL: String
  ) async -> GitHubOAuthFlowStatusResponse? {
    do {
      return try await client.fetchGitHubOAuthFlowStatus(statusURL: statusURL)
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  public func inspectLinearProfiles() async -> LinearProfilesResponse? {
    do {
      return try await client.inspectLinearProfiles()
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  public func listLinearConnections(
    profileId: String? = nil,
    organizationId: String? = nil
  ) async -> LinearConnectionsResponse? {
    do {
      return try await client.listLinearConnections(
        profileId: profileId,
        organizationId: organizationId
      )
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  public func seedLinearLocalAccess(profileId: String) async -> LinearLocalAccessSeedResponse? {
    do {
      return try await client.seedLinearLocalAccess(profileId: profileId)
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  public func inspectLinearStatus(profileId: String? = nil) async -> LinearStatusResponse? {
    do {
      return try await client.inspectLinearStatus(profileId: profileId)
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  public func disconnectLinear(profileId: String) async -> Bool {
    do {
      try await client.disconnectLinear(profileId: profileId)
      return true
    } catch {
      errorMessage = error.localizedDescription
      return false
    }
  }

  public func listLinearProjects(profileId: String? = nil) async -> LinearProjectsResponse? {
    do {
      return try await client.listLinearProjects(profileId: profileId)
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  public func listLinearAssigneeMappings(
    profileId: String? = nil,
    teamId: String? = nil
  ) async -> LinearAssigneeMappingsResponse? {
    do {
      return try await client.listLinearAssigneeMappings(
        profileId: profileId,
        teamId: teamId
      )
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  public func setLinearAssigneeMapping(
    profileId: String? = nil,
    teamId: String? = nil,
    localAssignee: String,
    linearUserId: String? = nil,
    linearUserName: String? = nil,
    linearUserEmail: String? = nil
  ) async -> LinearAssigneeMappingMutationResponse? {
    return await runActionResult(message: "Saving Linear assignee mapping…") {
      try await self.client.setLinearAssigneeMapping(
        profileId: profileId,
        teamId: teamId,
        localAssignee: localAssignee,
        linearUserId: linearUserId,
        linearUserName: linearUserName,
        linearUserEmail: linearUserEmail
      )
    }
  }

  public func removeLinearAssigneeMapping(
    profileId: String? = nil,
    teamId: String? = nil,
    localAssignee: String
  ) async -> LinearAssigneeMappingRemovalResponse? {
    return await runActionResult(message: "Removing Linear assignee mapping…") {
      try await self.client.removeLinearAssigneeMapping(
        profileId: profileId,
        teamId: teamId,
        localAssignee: localAssignee
      )
    }
  }

  public func listLinearAutosyncSubscriptions(
    profileId: String? = nil,
    projectId: String? = nil,
    teamId: String? = nil
  ) async -> LinearAutosyncSubscriptionsResponse? {
    do {
      return try await client.listLinearAutosyncSubscriptions(
        profileId: profileId,
        projectId: projectId,
        teamId: teamId
      )
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  public func setLinearAutosyncSubscription(
    profileId: String? = nil,
    projectId: String? = nil,
    teamId: String? = nil,
    mode: String = "auto_apply",
    status: String = "active"
  ) async -> LinearAutosyncSubscriptionMutationResponse? {
    return await runActionResult(message: "Saving Linear autosync…") {
      try await self.client.setLinearAutosyncSubscription(
        profileId: profileId,
        projectId: projectId,
        teamId: teamId,
        mode: mode,
        status: status
      )
    }
  }

  public func removeLinearAutosyncSubscription(
    profileId: String? = nil,
    projectId: String? = nil,
    teamId: String? = nil
  ) async -> LinearAutosyncSubscriptionMutationResponse? {
    return await runActionResult(message: "Removing Linear autosync…") {
      try await self.client.removeLinearAutosyncSubscription(
        profileId: profileId,
        projectId: projectId,
        teamId: teamId
      )
    }
  }

  public func bindLinearProject(
    for project: ProjectSummary,
    profileId: String?,
    projectId: String?,
    projectName: String?,
    teamId: String?,
    clear: Bool
  ) async -> LinearProjectBindingResponse? {
    guard let path = resolveProjectPath(project) else {
      errorMessage = "Missing project path for \(project.name)"
      return nil
    }
    return await runActionResult(message: clear ? "Clearing Linear project binding…" : "Saving Linear project binding…") {
      try await self.client.bindLinearProject(
        path: path,
        profileId: profileId,
        projectId: projectId,
        projectName: projectName,
        teamId: teamId,
        clear: clear
      )
    }
  }

  public func inspectLinearProjectBinding(
    for project: ProjectSummary
  ) async -> LinearProjectBindingResponse? {
    guard let path = resolveProjectPath(project) else {
      errorMessage = "Missing project path for \(project.name)"
      return nil
    }
    do {
      return try await client.inspectLinearProjectBinding(path: path)
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  public func linkLinearProject(
    for project: ProjectSummary,
    profileId: String?,
    projectId: String,
    projectName: String?,
    teamId: String?
  ) async -> LinearProjectBindingResponse? {
    guard let path = resolveProjectPath(project) else {
      errorMessage = "Missing project path for \(project.name)"
      return nil
    }
    return await runActionResult(
      message: "Adding Linear project to sync scope…",
      refreshDashboard: false
    ) {
      try await self.client.linkLinearProject(
        path: path,
        profileId: profileId,
        projectId: projectId,
        projectName: projectName,
        teamId: teamId
      )
    }
  }

  public func unlinkLinearProject(
    for project: ProjectSummary,
    projectId: String
  ) async -> LinearProjectBindingResponse? {
    guard let path = resolveProjectPath(project) else {
      errorMessage = "Missing project path for \(project.name)"
      return nil
    }
    return await runActionResult(
      message: "Removing Linear project from sync scope…",
      refreshDashboard: false
    ) {
      try await self.client.unlinkLinearProject(path: path, projectId: projectId)
    }
  }

  public func syncLinearProject(
    for project: ProjectSummary,
    from direction: String,
    profileId: String? = nil,
    ownerMode: String? = nil,
    projectId: String? = nil,
    teamId: String? = nil,
    limit: Int? = nil,
    syncLabels: Bool? = nil
  ) async -> LinearProjectSyncResponse? {
    guard let path = resolveProjectPath(project) else {
      errorMessage = "Missing project path for \(project.name)"
      return nil
    }
    let message = direction == "linear"
      ? "Syncing Linear issues into tickets…"
      : "Syncing tickets into Linear…"
    return await runActionResult(message: message, refreshDashboard: false) {
      try await self.client.syncLinearProject(
        path: path,
        from: direction,
        profileId: profileId,
        ownerMode: ownerMode,
        projectId: projectId,
        teamId: teamId,
        limit: limit,
        syncLabels: syncLabels
      )
    }
  }

  public func runLinearAutosync(
    for project: ProjectSummary,
    profileId: String? = nil,
    projectId: String? = nil,
    teamId: String? = nil,
    limit: Int? = nil
  ) async -> LinearAutosyncRunResponse? {
    guard let path = resolveProjectPath(project) else {
      errorMessage = "Missing project path for \(project.name)"
      return nil
    }
    return await runActionResult(
      message: "Running Linear autosync…",
      refreshDashboard: false
    ) {
      try await self.client.runLinearAutosync(
        path: path,
        profileId: profileId,
        projectId: projectId,
        teamId: teamId,
        limit: limit
      )
    }
  }

  public func syncLinearIssue(
    for project: ProjectSummary,
    from direction: String,
    profileId: String? = nil,
    issueIdentifier: String? = nil,
    ticketId: String? = nil,
    projectId: String? = nil,
    teamId: String? = nil,
    syncLabels: Bool? = nil
  ) async -> LinearIssueSyncResponse? {
    guard let path = resolveProjectPath(project) else {
      errorMessage = "Missing project path for \(project.name)"
      return nil
    }
    let message = direction == "linear"
      ? "Refreshing ticket from Linear…"
      : "Syncing ticket to Linear…"
    return await runActionResult(message: message, refreshDashboard: false) {
      try await self.client.syncLinearIssue(
        path: path,
        from: direction,
        profileId: profileId,
        issueIdentifier: issueIdentifier,
        ticketId: ticketId,
        projectId: projectId,
        teamId: teamId,
        syncLabels: syncLabels
      )
    }
  }

  public func startLinearOAuthFlow(
    profileId: String,
    setDefault: Bool
  ) async -> LinearOAuthFlowStartResponse? {
    do {
      return try await client.startLinearOAuthFlow(
        profileId: profileId,
        setDefault: setDefault
      )
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  public func fetchLinearOAuthFlowStatus(
    statusURL: String
  ) async -> LinearOAuthFlowStatusResponse? {
    do {
      return try await client.fetchLinearOAuthFlowStatus(statusURL: statusURL)
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  public func bootstrapRailwayNode(
    request: RailwayBootstrapRequest
  ) async -> RailwayBootstrapResponse? {
    await runActionResult(message: "Bootstrapping Railway node…") {
      try await self.client.bootstrapRailwayNode(request: request)
    }
  }

  public func listNodes() async -> NodeRegistryListResponse? {
    do {
      return try await client.listNodes()
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  public func probeNodes(nodeId: String? = nil) async -> NodeStatusResponse? {
    do {
      return try await client.probeNodes(nodeId: nodeId)
    } catch {
      errorMessage = error.localizedDescription
      return nil
    }
  }

  public func useNode(id: String) async -> Bool {
    let response: NodeUseResponse? = await runActionResult(message: "Setting default node…") {
      try await self.client.useNode(id: id)
    }
    return response?.defaultNodeId == id
  }

  public func removeNode(id: String) async -> Bool {
    let response: NodeRemoveResponse? = await runActionResult(message: "Removing node…") {
      try await self.client.removeNode(id: id)
    }
    return response?.removed == true
  }

  public func cancelNodePairSession(sessionId: String) async -> Bool {
    let response: NodePairCancelResponse? = await runActionResult(message: "Cancelling pairing session…") {
      try await self.client.cancelNodePairSession(sessionId: sessionId)
    }
    return response?.cancelled == true
  }

  public func listNodePairSessions(status: String = "pending") async -> [NodePairingSession] {
    do {
      return try await client.listNodePairSessions(status: status).sessions
    } catch {
      errorMessage = error.localizedDescription
      return []
    }
  }

  public func fulfillNodePairSession(
    sessionId: String,
    code: String,
    defaultNode: Bool,
    sshPort: Int?
  ) async -> NodePairFulfillResponse? {
    await runActionResult(message: "Approving pairing request…") {
      try await self.client.fulfillNodePairSession(
        sessionId: sessionId,
        code: code,
        defaultNode: defaultNode,
        sshPort: sshPort
      )
    }
  }

  public func toggleGlobalInfrastructure() async {
    if globalInfraRunning {
      await globalDown()
    } else {
      await globalUp()
    }
  }

  @discardableResult
  public func ingestHackAuthDeepLink(url: URL) -> Bool {
    guard isHackAuthCompletionDeepLink(url: url) else {
      return false
    }
    errorMessage = nil
    statusMessage = "Hack auth callback received. Finalizing…"
    Task { @MainActor [weak self] in
      guard let self else { return }
      for attempt in 0..<6 {
        await self.refreshHackAccountState(force: true, updateErrorMessage: false)
        if let state = self.hackAccountState,
          state.authenticated || state.tokenStored
        {
          self.statusMessage = state.authenticated
            ? "Hack account connected."
            : "Hack auth session stored locally."
          return
        }
        if attempt < 5 {
          try? await Task.sleep(for: .seconds(1))
        }
      }
    }
    return true
  }

  @discardableResult
  public func ingestGitHubOAuthDeepLink(url: URL) -> Bool {
    guard let context = parseGitHubOAuthDeepLink(url: url) else {
      return false
    }
    githubOAuthDeepLinkContext = context
    if let profileId = context.profileId {
      statusMessage = "GitHub callback received for profile \(profileId). Finalizing…"
    } else {
      statusMessage = "GitHub callback received. Finalizing…"
    }
    return true
  }

  public func clearGitHubOAuthDeepLink(flowId: String? = nil) {
    guard let current = githubOAuthDeepLinkContext else {
      return
    }
    if let flowId, current.flowId != flowId {
      return
    }
    githubOAuthDeepLinkContext = nil
  }

  @discardableResult
  public func ingestLinearOAuthDeepLink(url: URL) -> Bool {
    guard let context = parseLinearOAuthDeepLink(url: url) else {
      return false
    }
    linearOAuthDeepLinkContext = context
    if let profileId = context.profileId {
      statusMessage = "Linear callback received for profile \(profileId). Finalizing…"
    } else {
      statusMessage = "Linear callback received. Finalizing…"
    }
    return true
  }

  public func clearLinearOAuthDeepLink(flowId: String? = nil) {
    guard let current = linearOAuthDeepLinkContext else {
      return
    }
    if let flowId, current.flowId != flowId {
      return
    }
    linearOAuthDeepLinkContext = nil
  }

  private func isHackAuthCompletionDeepLink(url: URL) -> Bool {
    guard isRegisteredHackDeepLinkScheme(url.scheme) else {
      return false
    }

    let host = url.host?.lowercased() ?? ""
    let path = normalizedPath(url.path)
    return (host == "auth" && path == "/complete")
      || (host == "complete" && path == "/")
      || (host == "complete" && path.isEmpty)
  }

  private func parseGitHubOAuthDeepLink(url: URL) -> GitHubOAuthDeepLinkContext? {
    guard isRegisteredHackDeepLinkScheme(url.scheme) else {
      return nil
    }

    let host = url.host?.lowercased() ?? ""
    let path = normalizedPath(url.path)
    let isGitHubCallbackRoute =
      (host == "auth" && path == "/github/callback")
      || (host == "github" && path == "/callback")
      || (host == "auth" && path == "/callback")
    guard isGitHubCallbackRoute else {
      return nil
    }

    guard
      let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      let items = components.queryItems
    else {
      return nil
    }

    let flowId =
      normalizedQueryValue(named: "flowId", items: items)
      ?? normalizedQueryValue(named: "flow_id", items: items)
    guard let flowId else {
      return nil
    }

    return GitHubOAuthDeepLinkContext(
      flowId: flowId,
      profileId: normalizedQueryValue(named: "profileId", items: items)
        ?? normalizedQueryValue(named: "profile", items: items),
      status: normalizedQueryValue(named: "status", items: items),
      installationId: normalizedQueryValue(named: "installationId", items: items)
        ?? normalizedQueryValue(named: "installation_id", items: items)
    )
  }

  private func parseLinearOAuthDeepLink(url: URL) -> LinearOAuthDeepLinkContext? {
    guard isRegisteredHackDeepLinkScheme(url.scheme) else {
      return nil
    }

    let host = url.host?.lowercased() ?? ""
    let path = normalizedPath(url.path)
    let isLinearCallbackRoute =
      (host == "auth" && path == "/linear/callback")
      || (host == "linear" && path == "/callback")
    guard isLinearCallbackRoute else {
      return nil
    }

    guard
      let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      let items = components.queryItems
    else {
      return nil
    }

    let flowId =
      normalizedQueryValue(named: "flowId", items: items)
      ?? normalizedQueryValue(named: "flow_id", items: items)
    guard let flowId else {
      return nil
    }

    return LinearOAuthDeepLinkContext(
      flowId: flowId,
      profileId: normalizedQueryValue(named: "profileId", items: items)
        ?? normalizedQueryValue(named: "profile", items: items),
      status: normalizedQueryValue(named: "status", items: items)
    )
  }

  private func isRegisteredHackDeepLinkScheme(_ scheme: String?) -> Bool {
    guard
      let normalizedScheme = scheme?
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased(),
      !normalizedScheme.isEmpty
    else {
      return false
    }
    return registeredHackDeepLinkSchemes.contains(normalizedScheme)
  }

  private var registeredHackDeepLinkSchemes: Set<String> {
    if
      let urlTypes = Bundle.main.object(forInfoDictionaryKey: "CFBundleURLTypes")
        as? [[String: Any]]
    {
      let schemes = urlTypes
        .flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }
        .compactMap {
          let trimmed = $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
          return trimmed.isEmpty ? nil : trimmed
        }
      if !schemes.isEmpty {
        return Set(schemes)
      }
    }
    return ["hack", "hack-dev"]
  }

  private func normalizedPath(_ path: String) -> String {
    let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.hasSuffix("/") && trimmed.count > 1 {
      return String(trimmed.dropLast())
    }
    return trimmed
  }

  private func normalizedQueryValue(
    named name: String,
    items: [URLQueryItem]
  ) -> String? {
    guard
      let raw = items.first(where: { $0.name == name })?.value?
        .trimmingCharacters(in: .whitespacesAndNewlines),
      !raw.isEmpty
    else {
      return nil
    }
    return raw
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
