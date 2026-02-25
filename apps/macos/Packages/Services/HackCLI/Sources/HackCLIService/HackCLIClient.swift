import Foundation

import HackDesktopModels

public enum HackCLIError: LocalizedError, Equatable {
  case commandFailed(exitCode: Int, stderr: String)
  case emptyOutput
  case invalidJson
  case network(String)

  public var errorDescription: String? {
    switch self {
    case let .commandFailed(exitCode, stderr):
      return "hack exited with code \(exitCode): \(stderr)"
    case .emptyOutput:
      return "hack returned empty output"
    case .invalidJson:
      return "hack returned invalid JSON"
    case let .network(message):
      return message
    }
  }
}

public enum GitSystemIdentityScope: String, Hashable {
  case global
  case project
}

public struct GitSystemIdentity: Hashable {
  public let scope: GitSystemIdentityScope
  public let gitName: String?
  public let gitEmail: String?
  public let githubLogin: String?
  public let githubName: String?
  public let githubId: String?

  public init(
    scope: GitSystemIdentityScope,
    gitName: String?,
    gitEmail: String?,
    githubLogin: String?,
    githubName: String?,
    githubId: String?
  ) {
    self.scope = scope
    self.gitName = gitName
    self.gitEmail = gitEmail
    self.githubLogin = githubLogin
    self.githubName = githubName
    self.githubId = githubId
  }
}

public actor HackCLIClient {
  private static let authServerCandidates = [
    "https://auth.hack.broker",
    "https://auth.hack.gy",
    "https://auth.hack",
    "http://127.0.0.1:7790",
  ]

  private static let authRequestTimeoutSeconds: TimeInterval = 10

  private struct GitHubOAuthStartEnvelope: Decodable {
    let ok: Bool
    let flow: GitHubOAuthStartEnvelopeFlow
  }

  private struct GitHubOAuthStartEnvelopeFlow: Decodable {
    let flowId: String
    let profileId: String
    let setDefault: Bool
    let requireInstallation: Bool?
    let authorizeUrl: String
    let deviceCode: String
    let pollUrl: String
    let appInstallUrl: String?
    let appId: String?
    let appSlug: String?
    let expiresAt: String
  }

  private struct GitHubOAuthStatusEnvelope: Decodable {
    let ok: Bool
    let status: GitHubOAuthStatusEnvelopeStatus
  }

  private struct GitHubOAuthStatusEnvelopeStatus: Decodable {
    let id: String
    let status: String
    let profileId: String
    let setDefault: Bool
    let createdAt: String
    let expiresAt: String
    let completedAt: String?
    let claimedAt: String?
    let accountLogin: String?
    let accountName: String?
    let accountId: String?
    let installationId: String?
    let installationIds: [String]?
    let appInstallUrl: String?
    let appId: String?
    let appSlug: String?
    let token: String?
    let tokenExpiresAt: String?
    let error: String?
  }

  public init() {}

  public func fetchProjects(includeGlobal: Bool) async throws -> ProjectListResponse {
    var args = ["projects", "--json"]
    if includeGlobal {
      args.append("--include-global")
    }

    let result = try await run(args)
    return try decodeLenient(ProjectListResponse.self, from: result.stdout)
  }

  public func daemonStatus() async throws -> DaemonStatus {
    let result = try await run(["daemon", "status", "--json"], allowNonZeroExit: true)
    return try decodeJsonOrThrow(DaemonStatus.self, result: result)
  }

  public func fetchGlobalStatus() async throws -> GlobalStatusResponse {
    let result = try await run(["global", "status", "--json"], allowNonZeroExit: true)
    return try decodeJsonOrThrow(GlobalStatusResponse.self, result: result)
  }

  public func globalUp() async throws {
    _ = try await run(["global", "up"])
  }

  public func globalDown() async throws {
    _ = try await run(["global", "down"])
  }

  public func startDaemon() async throws {
    _ = try await run(["daemon", "start"])
  }

  public func stopDaemon() async throws {
    _ = try await run(["daemon", "stop"])
  }

  public func restartDaemon() async throws {
    _ = try await run(["daemon", "restart"])
  }

  public func clearDaemon() async throws {
    _ = try await run(["daemon", "clear"])
  }

  public func startProject(path: String, target: String = "auto") async throws {
    _ = try await run(["up", "--path", path, "--detach", "--target", target])
  }

  public func stopProject(path: String, target: String = "auto") async throws {
    _ = try await run(["down", "--path", path, "--target", target])
  }

  public func startBranch(path: String, branch: String) async throws {
    _ = try await run(["up", "--path", path, "--branch", branch, "--detach"])
  }

  public func stopBranch(path: String, branch: String) async throws {
    _ = try await run(["down", "--path", path, "--branch", branch])
  }

  public func addBranch(path: String, name: String, note: String?) async throws {
    var args = ["branch", "add", name, "--path", path]
    if let note, !note.isEmpty {
      args.append(contentsOf: ["--note", note])
    }
    _ = try await run(args)
  }

  public func removeBranch(path: String, name: String) async throws {
    _ = try await run(["branch", "remove", name, "--path", path])
  }

  public func stopSession(name: String) async throws {
    _ = try await run(["session", "stop", name])
  }

  public func startSession(projectName: String, detached: Bool = true) async throws {
    var args = ["session", "start", projectName]
    if detached {
      args.append("--detach")
    }
    _ = try await run(args)
  }

  public func setGlobalConfig(key: String, value: String) async throws {
    _ = try await run(["config", "set", key, value, "--global"])
  }

  public func getGlobalConfigValue(key: String) async throws -> String? {
    let result = try await run(
      ["config", "get", key, "--global"],
      allowNonZeroExit: true
    )
    guard result.exitCode == 0 else {
      return nil
    }
    let value = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? nil : value
  }

  public func setProjectConfig(
    key: String,
    value: String,
    projectPath: String
  ) async throws {
    _ = try await run(["config", "set", key, value], cwd: projectPath)
  }

  public func getProjectConfigValue(
    key: String,
    projectPath: String
  ) async throws -> String? {
    let result = try await run(
      ["config", "get", key],
      allowNonZeroExit: true,
      cwd: projectPath
    )
    guard result.exitCode == 0 else {
      return nil
    }
    let value = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? nil : value
  }

  public func listGatewayTokens() async throws -> GatewayTokenListResponse {
    let result = try await run(["x", "gateway", "token-list", "--json"], allowNonZeroExit: true)
    return try decodeJsonOrThrow(GatewayTokenListResponse.self, result: result)
  }

  public func createGatewayToken(
    scope: GatewayTokenScope,
    label: String?
  ) async throws -> GatewayTokenCreateResponse {
    var args = ["x", "gateway", "token-create", "--scope", scope.rawValue, "--json"]
    if let label, !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      args.append(contentsOf: ["--label", label])
    }
    let result = try await run(args, allowNonZeroExit: true)
    return try decodeJsonOrThrow(GatewayTokenCreateResponse.self, result: result)
  }

  public func revokeGatewayToken(id: String) async throws -> GatewayTokenRevokeResponse {
    let result = try await run(["x", "gateway", "token-revoke", id, "--json"], allowNonZeroExit: true)
    return try decodeJsonOrThrow(GatewayTokenRevokeResponse.self, result: result)
  }

  public func startCloudflareTunnel() async throws {
    _ = try await run(["x", "cloudflare", "tunnel-start"])
  }

  public func stopCloudflareTunnel() async throws {
    _ = try await run(["x", "cloudflare", "tunnel-stop"])
  }

  public func inspectTailscale() async throws -> TailscaleInspectResponse {
    do {
      let result = try await run(["x", "tailscale", "inspect", "--json"], allowNonZeroExit: true)
      return try decodeJsonOrThrow(TailscaleInspectResponse.self, result: result)
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      // If hack inspect cannot return machine JSON (stale CLI, disabled extension gate, etc),
      // fall back to direct `tailscale status --json` so settings still reflect host reality.
      return try await inspectTailscaleDirect()
    }
  }

  public func inspectTailscaleOAuthStatus(
    validate: Bool = false
  ) async throws -> TailscaleOAuthStatusResponse {
    var args = ["x", "tailscale", "oauth-status", "--json"]
    if validate {
      args.append("--validate")
    }
    let result = try await run(args, allowNonZeroExit: true)
    if let fallback = unsupportedTailscaleOAuthStatusResponse(result: result) {
      return fallback
    }
    return try decodeJsonOrThrow(TailscaleOAuthStatusResponse.self, result: result)
  }

  public func connectTailscaleOAuth(
    request: TailscaleOAuthConnectRequest
  ) async throws -> TailscaleOAuthStatusResponse {
    var args = [
      "x",
      "tailscale",
      "oauth-connect",
      "--json",
      "--client-id",
      request.clientId,
      "--client-secret-stdin",
    ]
    if let value = normalized(request.authRef) {
      args.append(contentsOf: ["--auth-ref", value])
    }
    if let value = normalized(request.tailnet) {
      args.append(contentsOf: ["--tailnet", value])
    }
    if let value = request.keyExpirySeconds {
      args.append(contentsOf: ["--key-expiry-seconds", String(value)])
    }

    let result = try await run(
      args,
      allowNonZeroExit: true,
      stdin: "\(request.clientSecret)\n"
    )
    return try decodeJsonOrThrow(TailscaleOAuthStatusResponse.self, result: result)
  }

  public func disconnectTailscaleOAuth(
    authRef: String? = nil
  ) async throws -> TailscaleOAuthStatusResponse {
    var args = ["x", "tailscale", "oauth-disconnect", "--json"]
    if let value = normalized(authRef) {
      args.append(contentsOf: ["--auth-ref", value])
    }
    let result = try await run(args, allowNonZeroExit: true)
    return try decodeJsonOrThrow(TailscaleOAuthStatusResponse.self, result: result)
  }

  public func inspectRailway() async throws -> RailwayInspectResponse {
    let environment = HackCLILocator.buildEnvironment()
    guard let binaryPath = HackCLILocator.resolveExecutable(named: "railway", in: environment) else {
      return RailwayInspectResponse(
        installed: false,
        binaryPath: nil,
        version: nil,
        authenticated: false,
        whoami: nil,
        error: "railway not found in PATH"
      )
    }

    let versionResult = try await runExecutable(
      executablePath: binaryPath,
      args: ["--version"],
      allowNonZeroExit: true,
      cwd: nil
    )
    let version = firstNonEmptyLine(versionResult.stdout)
      ?? firstNonEmptyLine(versionResult.stderr)

    let whoamiResult = try await runExecutable(
      executablePath: binaryPath,
      args: ["whoami"],
      allowNonZeroExit: true,
      cwd: nil
    )
    if whoamiResult.exitCode == 0 {
      return RailwayInspectResponse(
        installed: true,
        binaryPath: binaryPath,
        version: version,
        authenticated: true,
        whoami: firstNonEmptyLine(whoamiResult.stdout),
        error: nil
      )
    }

    let whoamiError = firstNonEmptyLine(whoamiResult.stderr)
      ?? firstNonEmptyLine(whoamiResult.stdout)
      ?? "railway whoami failed"
    return RailwayInspectResponse(
      installed: true,
      binaryPath: binaryPath,
      version: version,
      authenticated: false,
      whoami: nil,
      error: whoamiError
    )
  }

  public func inspectGitHubProfiles() async throws -> GitHubProfilesResponse {
    let result = try await run(
      ["x", "github", "profiles", "--json"],
      allowNonZeroExit: true
    )
    return try decodeJsonOrThrow(GitHubProfilesResponse.self, result: result)
  }

  public func inspectGitHubStatus(profileId: String? = nil) async throws -> GitHubStatusResponse {
    var args = ["x", "github", "status", "--json"]
    if let profileId, !profileId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      args.append(contentsOf: ["--profile", profileId])
    }
    let result = try await run(args, allowNonZeroExit: true)
    return try decodeJsonOrThrow(GitHubStatusResponse.self, result: result)
  }

  /// Resolves the effective system Git identity (global or repo-effective) and optional GitHub CLI account.
  ///
  /// This is read-only host identity state and is intentionally separate from remote OAuth/App profile routing.
  public func inspectSystemGitIdentity(projectPath: String? = nil) async throws -> GitSystemIdentity {
    let normalizedPath = normalized(projectPath)
    let scope: GitSystemIdentityScope = normalizedPath == nil ? .global : .project
    let gitName = try await readGitConfigValue(
      key: "user.name",
      scope: scope,
      projectPath: normalizedPath
    )
    let gitEmail = try await readGitConfigValue(
      key: "user.email",
      scope: scope,
      projectPath: normalizedPath
    )
    let githubIdentity = try await inspectGitHubCLIIdentity()
    return GitSystemIdentity(
      scope: scope,
      gitName: gitName,
      gitEmail: gitEmail,
      githubLogin: githubIdentity?.login,
      githubName: githubIdentity?.name,
      githubId: githubIdentity?.id
    )
  }

  /// Starts cloud GitHub OAuth with the dedicated auth broker surface.
  ///
  /// This flow is intentionally separate from local gateway/daemon bearer-token auth.
  public func startGitHubOAuthFlow(
    profileId: String,
    setDefault: Bool
  ) async throws -> GitHubOAuthFlowStartResponse {
    var lastError: String? = nil
    for candidate in resolveAuthServerCandidates() {
      guard
        let startURL = buildAuthURL(
          base: candidate,
          path: "/v1/auth/github/start",
          queryItems: [
            URLQueryItem(name: "profile", value: profileId),
            URLQueryItem(name: "setDefault", value: setDefault ? "1" : "0"),
            URLQueryItem(name: "set_default", value: setDefault ? "1" : "0"),
            URLQueryItem(name: "requireInstallation", value: "1"),
          ]
        )
      else {
        continue
      }
      do {
        let body = try await fetchAuthBody(url: startURL)
        if let direct = tryDecodeLenient(GitHubOAuthFlowStartResponse.self, from: body) {
          return direct
        }
        if let wrapped = tryDecodeLenient(GitHubOAuthStartEnvelope.self, from: body), wrapped.ok {
          guard
            let statusURL = buildAuthURLWithQuery(
              urlString: wrapped.flow.pollUrl,
              queryItems: [
                URLQueryItem(name: "deviceCode", value: wrapped.flow.deviceCode),
                URLQueryItem(name: "claim", value: "1"),
                URLQueryItem(name: "requireInstallation", value: "1"),
              ]
            )?.absoluteString
          else {
            throw HackCLIError.network("Auth flow returned an invalid status URL.")
          }
          return GitHubOAuthFlowStartResponse(
            ok: true,
            flowId: wrapped.flow.flowId,
            profileId: wrapped.flow.profileId,
            setDefault: wrapped.flow.setDefault,
            authorizeUrl: wrapped.flow.authorizeUrl,
            statusUrl: statusURL,
            appInstallUrl: wrapped.flow.appInstallUrl,
            appId: wrapped.flow.appId,
            appSlug: wrapped.flow.appSlug,
            expiresAt: wrapped.flow.expiresAt
          )
        }
        throw HackCLIError.network("Auth server returned invalid JSON.")
      } catch {
        lastError = error.localizedDescription
      }
    }

    throw HackCLIError.network(
      lastError
        ?? "Unable to reach any configured auth broker endpoint. Check network/broker status and retry."
    )
  }

  /// Polls cloud OAuth flow state and imports claimed tokens into local keychain-backed profiles.
  ///
  /// This does not read or mutate gateway token auth used for daemon/gateway transport.
  public func fetchGitHubOAuthFlowStatus(
    statusURL: String
  ) async throws -> GitHubOAuthFlowStatusResponse {
    guard let url = URL(string: statusURL) else {
      throw HackCLIError.network("Invalid auth flow status URL.")
    }
    let body = try await fetchAuthBody(url: url)
    if let direct = tryDecodeLenient(GitHubOAuthFlowStatusResponse.self, from: body) {
      return direct
    }
    if let wrapped = tryDecodeLenient(GitHubOAuthStatusEnvelope.self, from: body), wrapped.ok {
      if let token = normalized(wrapped.status.token) {
        let installationId = normalized(wrapped.status.installationId)
          ?? wrapped.status.installationIds?.first
        do {
          try await persistGitHubTokenFromBrokerFlow(
            profileId: wrapped.status.profileId,
            token: token,
            setDefault: wrapped.status.setDefault,
            appId: normalized(wrapped.status.appId),
            installationId: installationId
          )
        } catch {
          throw HackCLIError.network(
            "GitHub OAuth callback succeeded, but Hack could not save the token locally (\(error.localizedDescription)). Retry Add account and allow keychain access."
          )
        }
      } else if wrapped.status.status == "claimed" {
        let profileId = wrapped.status.profileId
        let localStatus = try await inspectGitHubStatus(profileId: profileId)
        if !localStatus.tokenResolved {
          return brokerClaimedWithoutLocalTokenStatus(wrapped.status)
        }
      }
      return normalizeBrokerFlowStatus(wrapped.status)
    }
    throw HackCLIError.network("Auth server returned invalid JSON.")
  }

  public func bootstrapRailwayNode(
    request: RailwayBootstrapRequest
  ) async throws -> RailwayBootstrapResponse {
    var args = [
      "node",
      "provider",
      "railway",
      "bootstrap",
      "--json",
    ]

    if let value = normalized(request.railwayProject) {
      args.append(contentsOf: ["--railway-project", value])
    }

    if let value = normalized(request.railwayService) {
      args.append(contentsOf: ["--railway-service", value])
    }
    if let value = normalized(request.railwayEnvironment) {
      args.append(contentsOf: ["--railway-environment", value])
    }
    if let value = normalized(request.railwayWorkspace) {
      args.append(contentsOf: ["--railway-workspace", value])
    }
    if request.createService {
      args.append("--create-service")
    }
    if let value = normalized(request.railwayImage) {
      args.append(contentsOf: ["--railway-image", value])
    }
    if let value = normalized(request.railwayBin) {
      args.append(contentsOf: ["--railway-bin", value])
    }
    if let value = normalized(request.nodeName) {
      args.append(contentsOf: ["--name", value])
    }
    if let value = normalized(request.endpoint) {
      args.append(contentsOf: ["--endpoint", value])
    }
    if !request.labels.isEmpty {
      args.append(contentsOf: ["--labels", request.labels.joined(separator: ",")])
    }
    if request.defaultNode {
      args.append("--default")
    }
    if let value = request.domainPort {
      args.append(contentsOf: ["--domain-port", String(value)])
    }
    if let value = request.initRetries {
      args.append(contentsOf: ["--init-retries", String(value)])
    }
    if request.privateNetworking {
      args.append("--railway-private")
    }
    if let value = normalized(request.tailscaleAuthKey) {
      args.append(contentsOf: ["--tailscale-auth-key", value])
    }
    if let value = normalized(request.tailscaleHostname) {
      args.append(contentsOf: ["--tailscale-hostname", value])
    }
    if !request.tailscaleTags.isEmpty {
      args.append(contentsOf: ["--tailscale-tags", request.tailscaleTags.joined(separator: ",")])
    }

    let result = try await run(args, allowNonZeroExit: true)
    return try decodeJsonOrThrow(RailwayBootstrapResponse.self, result: result)
  }

  public func listNodes() async throws -> NodeRegistryListResponse {
    let result = try await run(["node", "list", "--json"], allowNonZeroExit: true)
    return try decodeJsonOrThrow(NodeRegistryListResponse.self, result: result)
  }

  public func probeNodes(nodeId: String? = nil) async throws -> NodeStatusResponse {
    var args = ["node", "status", "--json"]
    if let nodeId, !nodeId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      args.append(contentsOf: ["--node", nodeId])
    }
    let result = try await run(args, allowNonZeroExit: true)
    return try decodeJsonOrThrow(NodeStatusResponse.self, result: result)
  }

  public func useNode(id: String) async throws -> NodeUseResponse {
    let result = try await run(["node", "use", id, "--json"], allowNonZeroExit: true)
    return try decodeJsonOrThrow(NodeUseResponse.self, result: result)
  }

  public func removeNode(id: String) async throws -> NodeRemoveResponse {
    let result = try await run(["node", "remove", id, "--json"], allowNonZeroExit: true)
    return try decodeJsonOrThrow(NodeRemoveResponse.self, result: result)
  }

  public func cancelNodePairSession(sessionId: String) async throws -> NodePairCancelResponse {
    let result = try await run(
      ["node", "pair", "cancel", "--session", sessionId, "--json"],
      allowNonZeroExit: true
    )
    return try decodeJsonOrThrow(NodePairCancelResponse.self, result: result)
  }

  public func listNodePairSessions(status: String = "pending") async throws -> NodePairListResponse {
    let trimmed = status.trimmingCharacters(in: .whitespacesAndNewlines)
    var args = ["node", "pair", "list", "--json"]
    if !trimmed.isEmpty {
      args.append(contentsOf: ["--status", trimmed])
    }
    let result = try await run(args, allowNonZeroExit: true)
    return try decodeJsonOrThrow(NodePairListResponse.self, result: result)
  }

  public func fulfillNodePairSession(
    sessionId: String,
    code: String,
    defaultNode: Bool,
    sshPort: Int?
  ) async throws -> NodePairFulfillResponse {
    var args = [
      "node",
      "pair",
      "fulfill",
      "--session",
      sessionId,
      "--code",
      code,
      "--json",
    ]
    if defaultNode {
      args.append("--default")
    }
    if let sshPort {
      args.append(contentsOf: ["--ssh-port", String(sshPort)])
    }
    let result = try await run(args, allowNonZeroExit: true)
    return try decodeJsonOrThrow(NodePairFulfillResponse.self, result: result)
  }

  public func listTickets(path: String) async throws -> TicketsListResponse {
    let result = try await run(["x", "tickets", "list", "--json"], cwd: path)
    return try decodeLenient(TicketsListResponse.self, from: result.stdout)
  }

  public func showTicket(path: String, ticketId: String) async throws -> TicketDetailResponse {
    let result = try await run(["x", "tickets", "show", ticketId, "--json"], cwd: path)
    return try decodeLenient(TicketDetailResponse.self, from: result.stdout)
  }

  public func createTicket(
    path: String,
    title: String,
    body: String?,
    dependsOn: [String],
    blocks: [String]
  ) async throws -> TicketCreateResponse {
    var args = ["x", "tickets", "create", "--title", title, "--json"]
    if let body, !body.isEmpty {
      args.append(contentsOf: ["--body", body])
    }
    if !dependsOn.isEmpty {
      args.append(contentsOf: ["--depends-on", dependsOn.joined(separator: ",")])
    }
    if !blocks.isEmpty {
      args.append(contentsOf: ["--blocks", blocks.joined(separator: ",")])
    }
    let result = try await run(args, cwd: path)
    return try decodeLenient(TicketCreateResponse.self, from: result.stdout)
  }

  public func updateTicket(
    path: String,
    ticketId: String,
    title: String?,
    body: String?,
    dependsOn: [String]?,
    blocks: [String]?,
    clearDependsOn: Bool,
    clearBlocks: Bool
  ) async throws -> TicketUpdateResponse {
    var args = ["x", "tickets", "update", ticketId, "--json"]
    if let title {
      args.append(contentsOf: ["--title", title])
    }
    if let body {
      args.append(contentsOf: ["--body", body])
    }
    if let dependsOn, !dependsOn.isEmpty {
      args.append(contentsOf: ["--depends-on", dependsOn.joined(separator: ",")])
    }
    if let blocks, !blocks.isEmpty {
      args.append(contentsOf: ["--blocks", blocks.joined(separator: ",")])
    }
    if clearDependsOn {
      args.append("--clear-depends-on")
    }
    if clearBlocks {
      args.append("--clear-blocks")
    }
    let result = try await run(args, cwd: path)
    return try decodeLenient(TicketUpdateResponse.self, from: result.stdout)
  }

  public func setTicketStatus(
    path: String,
    ticketId: String,
    status: TicketStatus
  ) async throws -> TicketStatusResponse {
    let result = try await run(["x", "tickets", "status", ticketId, status.rawValue, "--json"], cwd: path)
    return try decodeLenient(TicketStatusResponse.self, from: result.stdout)
  }

  public func syncTickets(path: String) async throws -> TicketsSyncResponse {
    let result = try await run(["x", "tickets", "sync", "--json"], cwd: path)
    return try decodeLenient(TicketsSyncResponse.self, from: result.stdout)
  }

  public func setupTickets(path: String) async throws {
    _ = try await run(["x", "tickets", "setup"], allowNonZeroExit: true, cwd: path)
  }

  private func decode<T: Decodable>(_ type: T.Type, from text: String) throws -> T {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty {
      throw HackCLIError.emptyOutput
    }

    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase

    guard let data = trimmed.data(using: .utf8) else {
      throw HackCLIError.invalidJson
    }
    do {
      return try decoder.decode(T.self, from: data)
    } catch {
      throw HackCLIError.invalidJson
    }
  }

  private func decodeLenient<T: Decodable>(_ type: T.Type, from text: String) throws -> T {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty {
      throw HackCLIError.emptyOutput
    }

    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase

    if let data = trimmed.data(using: .utf8), let decoded = try? decoder.decode(T.self, from: data) {
      return decoded
    }

    for snippet in extractJsonSnippets(from: trimmed) {
      if let data = snippet.data(using: .utf8),
         let decoded = try? decoder.decode(T.self, from: data) {
        return decoded
      }
    }

    throw HackCLIError.invalidJson
  }

  private func extractJsonSnippets(from text: String) -> [String] {
    var snippets: [String] = []
    var seen: Set<String> = []
    for index in text.indices {
      let char = text[index]
      guard char == "{" || char == "[" else {
        continue
      }
      guard let snippet = extractBalancedJson(from: text, startAt: index) else {
        continue
      }
      if seen.insert(snippet).inserted {
        snippets.append(snippet)
      }
    }
    return snippets
  }

  private func extractBalancedJson(from text: String, startAt startIndex: String.Index) -> String? {
    let startChar = text[startIndex]
    guard startChar == "{" || startChar == "[" else {
      return nil
    }

    var stack: [Character] = [startChar == "{" ? "}" : "]"]
    var insideString = false
    var escaped = false
    var index = text.index(after: startIndex)

    while index < text.endIndex {
      let char = text[index]

      if insideString {
        if escaped {
          escaped = false
        } else if char == "\\" {
          escaped = true
        } else if char == "\"" {
          insideString = false
        }
      } else {
        switch char {
        case "\"":
          insideString = true
        case "{":
          stack.append("}")
        case "[":
          stack.append("]")
        case "}", "]":
          guard let expected = stack.last, char == expected else {
            return nil
          }
          _ = stack.removeLast()
          if stack.isEmpty {
            return String(text[startIndex...index])
          }
        default:
          break
        }
      }

      index = text.index(after: index)
    }

    return nil
  }

  private func run(
    _ args: [String],
    allowNonZeroExit: Bool = false,
    cwd: String? = nil,
    stdin: String? = nil
  ) async throws -> CLIResult {
    try Task.checkCancellation()

    let process = Process()
    let environment = HackCLILocator.buildEnvironment()
    process.environment = environment
    if let cwd, !cwd.isEmpty {
      process.currentDirectoryURL = URL(fileURLWithPath: cwd)
    }

    if let hackPath = HackCLILocator.resolveHackExecutable(in: environment) {
      process.executableURL = URL(fileURLWithPath: hackPath)
      process.arguments = args
    } else {
      process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
      process.arguments = ["hack"] + args
    }

    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    let stdinPipe = stdin == nil ? nil : Pipe()
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe
    if let stdinPipe {
      process.standardInput = stdinPipe
    }

    return try await withTaskCancellationHandler(operation: {
      do {
        try process.run()
      } catch {
        stdoutPipe.fileHandleForReading.closeFile()
        stderrPipe.fileHandleForReading.closeFile()
        stdinPipe?.fileHandleForReading.closeFile()
        stdinPipe?.fileHandleForWriting.closeFile()
        throw HackCLIError.commandFailed(exitCode: 127, stderr: error.localizedDescription)
      }

      if let stdin, let stdinPipe {
        if let stdinData = stdin.data(using: .utf8) {
          stdinPipe.fileHandleForWriting.write(stdinData)
        }
        stdinPipe.fileHandleForWriting.closeFile()
      }

      async let stdoutData = stdoutPipe.fileHandleForReading.readToEnd()
      async let stderrData = stderrPipe.fileHandleForReading.readToEnd()
      let exitCode = await Task.detached(priority: nil) {
        process.waitUntilExit()
        return Int(process.terminationStatus)
      }.value

      let stdoutBytes: Data?
      let stderrBytes: Data?

      do {
        stdoutBytes = try await stdoutData
      } catch {
        stdoutBytes = nil
      }

      do {
        stderrBytes = try await stderrData
      } catch {
        stderrBytes = nil
      }

      try Task.checkCancellation()

      let stdout = String(decoding: stdoutBytes ?? Data(), as: UTF8.self)
      let stderr = String(decoding: stderrBytes ?? Data(), as: UTF8.self)

      if exitCode != 0 && !allowNonZeroExit {
        throw HackCLIError.commandFailed(
          exitCode: exitCode,
          stderr: stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        )
      }

      return CLIResult(stdout: stdout, stderr: stderr, exitCode: exitCode)
    }, onCancel: {
      if process.isRunning {
        process.terminate()
      }
      stdoutPipe.fileHandleForReading.closeFile()
      stderrPipe.fileHandleForReading.closeFile()
      stdinPipe?.fileHandleForReading.closeFile()
      stdinPipe?.fileHandleForWriting.closeFile()
    })
  }

  private func decodeJsonOrThrow<T: Decodable>(_ type: T.Type, result: CLIResult) throws -> T {
    let trimmedStdout = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedStderr = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)

    // When callers allow non-zero exit, we still want a useful error (stderr) instead of "empty output".
    if trimmedStdout.isEmpty {
      throw HackCLIError.commandFailed(exitCode: result.exitCode, stderr: trimmedStderr)
    }

    do {
      return try decode(type, from: trimmedStdout)
    } catch {
      if let decoded = try? decodeLenient(type, from: trimmedStdout) {
        return decoded
      }
      // If hack printed logs or other output, surface stderr as the actionable hint.
      if !trimmedStderr.isEmpty {
        throw HackCLIError.commandFailed(exitCode: result.exitCode, stderr: trimmedStderr)
      }
      if result.exitCode != 0 {
        throw HackCLIError.commandFailed(
          exitCode: result.exitCode,
          stderr: "command failed without JSON payload"
        )
      }
      throw error
    }
  }

  private func buildAuthURL(
    base: String,
    path: String,
    queryItems: [URLQueryItem]
  ) -> URL? {
    guard var components = URLComponents(string: base) else {
      return nil
    }
    components.path = path
    components.queryItems = queryItems
    return components.url
  }

  private func buildAuthURLWithQuery(
    urlString: String,
    queryItems: [URLQueryItem]
  ) -> URL? {
    guard var components = URLComponents(string: urlString) else {
      return nil
    }
    var merged = components.queryItems ?? []
    merged.append(contentsOf: queryItems)
    components.queryItems = merged
    return components.url
  }

  private func tryDecodeLenient<T: Decodable>(
    _ type: T.Type,
    from text: String
  ) -> T? {
    try? decodeLenient(type, from: text)
  }

  private func normalizeBrokerFlowStatus(
    _ wrapped: GitHubOAuthStatusEnvelopeStatus
  ) -> GitHubOAuthFlowStatusResponse {
    let installationId = normalized(wrapped.installationId)
      ?? wrapped.installationIds?.first
    let normalizedStatus: String
    switch wrapped.status {
    case "claimed":
      normalizedStatus = "complete"
    default:
      normalizedStatus = wrapped.status
    }
    return GitHubOAuthFlowStatusResponse(
      id: wrapped.id,
      status: normalizedStatus,
      profileId: wrapped.profileId,
      setDefault: wrapped.setDefault,
      createdAt: wrapped.createdAt,
      expiresAt: wrapped.expiresAt,
      completedAt: wrapped.completedAt ?? wrapped.claimedAt,
      accountLogin: wrapped.accountLogin,
      accountName: wrapped.accountName,
      accountId: wrapped.accountId,
      installationId: installationId,
      installationIds: wrapped.installationIds,
      appInstallUrl: wrapped.appInstallUrl,
      appId: wrapped.appId,
      appSlug: wrapped.appSlug,
      error: wrapped.error
    )
  }

  private func brokerClaimedWithoutLocalTokenStatus(
    _ wrapped: GitHubOAuthStatusEnvelopeStatus
  ) -> GitHubOAuthFlowStatusResponse {
    let installationId = normalized(wrapped.installationId)
      ?? wrapped.installationIds?.first
    return GitHubOAuthFlowStatusResponse(
      id: wrapped.id,
      status: "error",
      profileId: wrapped.profileId,
      setDefault: wrapped.setDefault,
      createdAt: wrapped.createdAt,
      expiresAt: wrapped.expiresAt,
      completedAt: wrapped.completedAt ?? wrapped.claimedAt,
      accountLogin: wrapped.accountLogin,
      accountName: wrapped.accountName,
      accountId: wrapped.accountId,
      installationId: installationId,
      installationIds: wrapped.installationIds,
      appInstallUrl: wrapped.appInstallUrl,
      appId: wrapped.appId,
      appSlug: wrapped.appSlug,
      error:
        "OAuth token was claimed remotely but is not available in local profile \(wrapped.profileId). Re-run Add account and allow keychain access."
    )
  }

  /// Persist a broker-issued GitHub token into local keychain-backed profile storage.
  private func persistGitHubTokenFromBrokerFlow(
    profileId: String,
    token: String,
    setDefault: Bool,
    appId: String?,
    installationId: String?
  ) async throws {
    if let appId, let installationId {
      var appArgs = [
        "x",
        "github",
        "connect",
        "--profile",
        profileId,
        "--app-id",
        appId,
        "--installation-id",
        installationId,
      ]
      if setDefault {
        appArgs.append("--set-default")
      }
      do {
        _ = try await run(appArgs)
        return
      } catch {
        // Fall back to direct token import when app private-key refresh is not available.
      }
    }

    var args = ["x", "github", "connect", "--profile", profileId, "--stdin"]
    if setDefault {
      args.append("--set-default")
    }
    _ = try await run(args, stdin: "\(token)\n")
  }

  private func fetchAuthBody(url: URL) async throws -> String {
    var request = URLRequest(url: url)
    request.timeoutInterval = Self.authRequestTimeoutSeconds
    request.httpMethod = "GET"
    request.setValue("application/json", forHTTPHeaderField: "Accept")

    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await URLSession.shared.data(for: request)
    } catch {
      throw HackCLIError.network(error.localizedDescription)
    }

    guard let httpResponse = response as? HTTPURLResponse else {
      throw HackCLIError.network("Auth server returned an unexpected response.")
    }

    let body = String(decoding: data, as: UTF8.self)
    if !(200...299).contains(httpResponse.statusCode) {
      if let decodedError = try? decode(AuthServerErrorPayload.self, from: body),
        let message = normalized(decodedError.error)
      {
        throw HackCLIError.network(message)
      }
      let fallback = firstNonEmptyLine(body) ?? HTTPURLResponse.localizedString(forStatusCode: httpResponse.statusCode)
      throw HackCLIError.network(fallback)
    }
    return body
  }

  private func unsupportedTailscaleOAuthStatusResponse(
    result: CLIResult
  ) -> TailscaleOAuthStatusResponse? {
    guard result.exitCode != 0 else {
      return nil
    }
    let stderr = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !stderr.isEmpty else {
      return nil
    }
    let normalized = stderr.lowercased()
    guard
      normalized.contains("unknown command"),
      normalized.contains("oauth-status"),
      normalized.contains("tailscale")
    else {
      return nil
    }
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
      error:
        "Installed hack CLI does not support tailscale OAuth commands yet. Run `hack update` (or reinstall from this repo) and reopen the desktop app."
    )
  }

  private func inspectTailscaleDirect() async throws -> TailscaleInspectResponse {
    let environment = HackCLILocator.buildEnvironment()
    guard let binaryPath = HackCLILocator.resolveExecutable(named: "tailscale", in: environment) else {
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
        error: "tailscale not found in PATH"
      )
    }

    let result = try await runExecutable(
      executablePath: binaryPath,
      args: ["status", "--json"],
      allowNonZeroExit: true,
      cwd: nil
    )
    if result.exitCode != 0 {
      let stderr = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
      return TailscaleInspectResponse(
        installed: true,
        binaryPath: binaryPath,
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
        error: stderr.isEmpty ? "tailscale status failed" : stderr
      )
    }

    let rawStatus = try decode(RawTailscaleStatus.self, from: result.stdout)
    let selfDevice = rawStatus.selfPeer.map {
      mapRawPeer(
        id: $0.id ?? "self",
        peer: $0,
        treatAsSelf: true
      )
    }

    let peers = rawStatus.peers
      .map { key, value in
        mapRawPeer(id: value.id ?? key, peer: value, treatAsSelf: false)
      }
      .sorted { lhs, rhs in
        if lhs.online != rhs.online {
          return lhs.online && !rhs.online
        }
        return lhs.hostname.localizedCaseInsensitiveCompare(rhs.hostname) == .orderedAscending
      }

    let exitNodes = peers.filter { $0.isExitNode || $0.isExitNodeOption }
    let currentExitNodeName = rawStatus.currentExitNodeId.flatMap { id in
      peers.first(where: { $0.id == id })?.hostname
    }

    return TailscaleInspectResponse(
      installed: true,
      binaryPath: binaryPath,
      connected: rawStatus.backendState == "Running",
      backendState: rawStatus.backendState,
      tailnetName: rawStatus.currentTailnet?.name,
      magicDnsSuffix: rawStatus.currentTailnet?.magicDnsSuffix,
      authUrl: rawStatus.authUrl,
      currentExitNodeId: rawStatus.currentExitNodeId,
      currentExitNodeName: currentExitNodeName,
      selfDevice: selfDevice.map {
        TailscaleInspectSelf(
          id: $0.id,
          hostname: $0.hostname,
          dnsName: $0.dnsName,
          tailscaleIp: $0.tailscaleIp,
          online: $0.online,
          os: $0.os,
          tags: $0.tags,
          isExitNode: $0.isExitNode
        )
      },
      peers: peers,
      onlinePeerCount: peers.filter(\.online).count,
      exitNodes: exitNodes,
      health: rawStatus.health,
      error: nil
    )
  }

  private func mapRawPeer(
    id: String,
    peer: RawTailscalePeer,
    treatAsSelf: Bool
  ) -> TailscaleInspectPeer {
    TailscaleInspectPeer(
      id: id,
      hostname: peer.hostName ?? id,
      dnsName: normalizeDNS(peer.dnsName),
      tailscaleIp: peer.tailscaleIPs.first,
      online: peer.online ?? false,
      os: peer.os,
      tags: peer.tags ?? [],
      isExitNode: peer.exitNode ?? false,
      isExitNodeOption: treatAsSelf ? false : (peer.exitNodeOption ?? false)
    )
  }

  private func normalizeDNS(_ value: String?) -> String? {
    guard let value, !value.isEmpty else { return nil }
    if value.hasSuffix(".") {
      return String(value.dropLast())
    }
    return value
  }

  private func firstNonEmptyLine(_ value: String) -> String? {
    for line in value.components(separatedBy: .newlines) {
      let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
      if !trimmed.isEmpty {
        return trimmed
      }
    }
    return nil
  }

  private func normalized(_ value: String?) -> String? {
    guard let value else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  private func resolveAuthServerCandidates() -> [String] {
    var candidates: [String] = []
    var seen = Set<String>()

    let envOverride = normalized(ProcessInfo.processInfo.environment["HACK_AUTH_BROKER_URL"])
    if let envOverride {
      let lowercased = envOverride.lowercased()
      if seen.insert(lowercased).inserted {
        candidates.append(envOverride)
      }
    }

    for candidate in Self.authServerCandidates {
      let lowercased = candidate.lowercased()
      if seen.insert(lowercased).inserted {
        candidates.append(candidate)
      }
    }
    return candidates
  }

  private func readGitConfigValue(
    key: String,
    scope: GitSystemIdentityScope,
    projectPath: String?
  ) async throws -> String? {
    var args = ["git", "config"]
    if scope == .global {
      args.append("--global")
    }
    args.append(contentsOf: ["--get", key])
    let result = try await runExecutable(
      executablePath: "/usr/bin/env",
      args: args,
      allowNonZeroExit: true,
      cwd: projectPath
    )
    guard result.exitCode == 0 else {
      return nil
    }
    return normalized(firstNonEmptyLine(result.stdout))
  }

  private func inspectGitHubCLIIdentity() async throws -> GitHubCLIIdentity? {
    let result = try await runExecutable(
      executablePath: "/usr/bin/env",
      args: ["gh", "api", "user"],
      allowNonZeroExit: true,
      cwd: nil
    )
    guard result.exitCode == 0 else {
      return nil
    }
    let trimmed = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      return nil
    }
    let jsonText = extractJsonSnippets(from: trimmed).first ?? trimmed
    guard let data = jsonText.data(using: String.Encoding.utf8) else {
      return nil
    }
    let decoded = try? JSONDecoder().decode(GitHubCLIIdentity.self, from: data)
    let login = normalized(decoded?.login)
    guard let login else {
      return nil
    }
    return GitHubCLIIdentity(
      login: login,
      name: normalized(decoded?.name),
      id: normalized(decoded?.id)
    )
  }

  private func runExecutable(
    executablePath: String,
    args: [String],
    allowNonZeroExit: Bool,
    cwd: String?
  ) async throws -> CLIResult {
    try Task.checkCancellation()

    let process = Process()
    process.environment = HackCLILocator.buildEnvironment()
    if let cwd, !cwd.isEmpty {
      process.currentDirectoryURL = URL(fileURLWithPath: cwd)
    }
    process.executableURL = URL(fileURLWithPath: executablePath)
    process.arguments = args

    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe

    return try await withTaskCancellationHandler(operation: {
      do {
        try process.run()
      } catch {
        stdoutPipe.fileHandleForReading.closeFile()
        stderrPipe.fileHandleForReading.closeFile()
        throw HackCLIError.commandFailed(exitCode: 127, stderr: error.localizedDescription)
      }

      async let stdoutData = stdoutPipe.fileHandleForReading.readToEnd()
      async let stderrData = stderrPipe.fileHandleForReading.readToEnd()
      let exitCode = await Task.detached(priority: nil) {
        process.waitUntilExit()
        return Int(process.terminationStatus)
      }.value

      let stdoutBytes: Data?
      let stderrBytes: Data?

      do {
        stdoutBytes = try await stdoutData
      } catch {
        stdoutBytes = nil
      }

      do {
        stderrBytes = try await stderrData
      } catch {
        stderrBytes = nil
      }

      try Task.checkCancellation()

      let stdout = String(decoding: stdoutBytes ?? Data(), as: UTF8.self)
      let stderr = String(decoding: stderrBytes ?? Data(), as: UTF8.self)
      if exitCode != 0 && !allowNonZeroExit {
        throw HackCLIError.commandFailed(
          exitCode: exitCode,
          stderr: stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        )
      }

      return CLIResult(stdout: stdout, stderr: stderr, exitCode: exitCode)
    }, onCancel: {
      if process.isRunning {
        process.terminate()
      }
      stdoutPipe.fileHandleForReading.closeFile()
      stderrPipe.fileHandleForReading.closeFile()
    })
  }
}

private struct GitHubCLIIdentity: Decodable {
  let login: String?
  let name: String?
  let id: String?
}

private struct RawTailscaleStatus: Decodable {
  let backendState: String?
  let currentTailnet: RawTailscaleTailnet?
  let authUrl: String?
  let currentExitNodeId: String?
  let selfPeer: RawTailscalePeer?
  let peers: [String: RawTailscalePeer]
  let health: [String]

  enum CodingKeys: String, CodingKey {
    case backendState = "BackendState"
    case currentTailnet = "CurrentTailnet"
    case authUrl = "AuthURL"
    case currentExitNodeId = "ExitNodeID"
    case selfPeer = "Self"
    case peers = "Peer"
    case health = "Health"
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    backendState = try container.decodeIfPresent(String.self, forKey: .backendState)
    currentTailnet = try container.decodeIfPresent(RawTailscaleTailnet.self, forKey: .currentTailnet)
    authUrl = try container.decodeIfPresent(String.self, forKey: .authUrl)
    currentExitNodeId = try container.decodeIfPresent(String.self, forKey: .currentExitNodeId)
    selfPeer = try container.decodeIfPresent(RawTailscalePeer.self, forKey: .selfPeer)
    peers = try container.decodeIfPresent([String: RawTailscalePeer].self, forKey: .peers) ?? [:]
    health = try container.decodeIfPresent([String].self, forKey: .health) ?? []
  }
}

private struct RawTailscaleTailnet: Decodable {
  let name: String?
  let magicDnsSuffix: String?

  enum CodingKeys: String, CodingKey {
    case name = "Name"
    case magicDnsSuffix = "MagicDNSSuffix"
  }
}

private struct RawTailscalePeer: Decodable {
  let id: String?
  let hostName: String?
  let dnsName: String?
  let tailscaleIPs: [String]
  let online: Bool?
  let os: String?
  let tags: [String]?
  let exitNode: Bool?
  let exitNodeOption: Bool?

  enum CodingKeys: String, CodingKey {
    case id = "ID"
    case hostName = "HostName"
    case dnsName = "DNSName"
    case tailscaleIPs = "TailscaleIPs"
    case online = "Online"
    case os = "OS"
    case tags = "Tags"
    case exitNode = "ExitNode"
    case exitNodeOption = "ExitNodeOption"
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decodeIfPresent(String.self, forKey: .id)
    hostName = try container.decodeIfPresent(String.self, forKey: .hostName)
    dnsName = try container.decodeIfPresent(String.self, forKey: .dnsName)
    tailscaleIPs = try container.decodeIfPresent([String].self, forKey: .tailscaleIPs) ?? []
    online = try container.decodeIfPresent(Bool.self, forKey: .online)
    os = try container.decodeIfPresent(String.self, forKey: .os)
    tags = try container.decodeIfPresent([String].self, forKey: .tags)
    exitNode = try container.decodeIfPresent(Bool.self, forKey: .exitNode)
    exitNodeOption = try container.decodeIfPresent(Bool.self, forKey: .exitNodeOption)
  }
}

private struct CLIResult {
  let stdout: String
  let stderr: String
  let exitCode: Int
}

private struct AuthServerErrorPayload: Decodable {
  let error: String?
}
