import Foundation

import HackDesktopModels

public enum HackCLIError: LocalizedError, Equatable {
  case commandFailed(exitCode: Int, stderr: String)
  case emptyOutput
  case invalidJson

  public var errorDescription: String? {
    switch self {
    case let .commandFailed(exitCode, stderr):
      return "hack exited with code \(exitCode): \(stderr)"
    case .emptyOutput:
      return "hack returned empty output"
    case .invalidJson:
      return "hack returned invalid JSON"
    }
  }
}

public actor HackCLIClient {
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

  public func startProject(path: String) async throws {
    _ = try await run(["up", "--path", path, "--detach"])
  }

  public func stopProject(path: String) async throws {
    _ = try await run(["down", "--path", path])
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
    cwd: String? = nil
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
      // If hack printed logs or other output, surface stderr as the actionable hint.
      if !trimmedStderr.isEmpty {
        throw HackCLIError.commandFailed(exitCode: result.exitCode, stderr: trimmedStderr)
      }
      throw error
    }
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
