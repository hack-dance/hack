import Foundation

public enum ProjectStatus: String, Decodable {
  case running
  case stopped
  case missing
  case unregistered
  case unknown
}

public enum ProjectRuntimeStatus: String, Decodable {
  case running
  case stopped
  case missing
  case unknown
  case notConfigured = "not_configured"
}

public enum ProjectKind: String, Decodable {
  case registered
  case unregistered
}

public enum ProjectSessionBackend: String, Decodable {
  case tmux
  case zellij
}

public enum ProjectSessionSource: String, Decodable {
  case hack
  case external
}

public struct ProjectSummary: Decodable, Identifiable, Hashable {
  public let projectId: String?
  public let name: String
  public let devHost: String?
  public let repoRoot: String?
  public let projectDir: String?
  public let definedServices: [String]?
  public let extensionsEnabled: [String]?
  public let features: [String]?
  public let serviceHosts: [String: [String]]?
  public let runtimeConfigured: Bool?
  public let runtimeStatus: ProjectRuntimeStatus?
  public let runtime: RuntimeProject?
  public let branchRuntime: [BranchRuntime]?
  public let sessions: [ProjectSessionSummary]?
  public let lifecycle: ProjectLifecycleSummary?
  public let kind: ProjectKind
  public let status: ProjectStatus

  public var id: String { projectId ?? name }

  public init(
    projectId: String?,
    name: String,
    devHost: String?,
    repoRoot: String?,
    projectDir: String?,
    definedServices: [String]?,
    extensionsEnabled: [String]?,
    features: [String]?,
    serviceHosts: [String: [String]]?,
    runtimeConfigured: Bool?,
    runtimeStatus: ProjectRuntimeStatus?,
    runtime: RuntimeProject?,
    branchRuntime: [BranchRuntime]? = nil,
    sessions: [ProjectSessionSummary]? = nil,
    lifecycle: ProjectLifecycleSummary? = nil,
    kind: ProjectKind,
    status: ProjectStatus
  ) {
    self.projectId = projectId
    self.name = name
    self.devHost = devHost
    self.repoRoot = repoRoot
    self.projectDir = projectDir
    self.definedServices = definedServices
    self.extensionsEnabled = extensionsEnabled
    self.features = features
    self.serviceHosts = serviceHosts
    self.runtimeConfigured = runtimeConfigured
    self.runtimeStatus = runtimeStatus
    self.runtime = runtime
    self.branchRuntime = branchRuntime
    self.sessions = sessions
    self.lifecycle = lifecycle
    self.kind = kind
    self.status = status
  }
}

public struct ProjectLifecycleSummary: Decodable, Hashable {
  public let upBefore: [ProjectLifecycleCommandSummary]
  public let upAfter: [ProjectLifecycleCommandSummary]
  public let downBefore: [ProjectLifecycleCommandSummary]
  public let downAfter: [ProjectLifecycleCommandSummary]
  public let processes: [ProjectLifecycleProcessSummary]

  public init(
    upBefore: [ProjectLifecycleCommandSummary],
    upAfter: [ProjectLifecycleCommandSummary],
    downBefore: [ProjectLifecycleCommandSummary],
    downAfter: [ProjectLifecycleCommandSummary],
    processes: [ProjectLifecycleProcessSummary]
  ) {
    self.upBefore = upBefore
    self.upAfter = upAfter
    self.downBefore = downBefore
    self.downAfter = downAfter
    self.processes = processes
  }
}

public struct ProjectLifecycleCommandSummary: Decodable, Hashable, Identifiable {
  public let name: String?
  public let command: String
  public let cwd: String?
  public let service: String
  public let persistent: Bool?

  public var id: String {
    "\(service)::\(command)::\(cwd ?? "")"
  }

  public init(
    name: String?,
    command: String,
    cwd: String?,
    service: String,
    persistent: Bool? = nil
  ) {
    self.name = name
    self.command = command
    self.cwd = cwd
    self.service = service
    self.persistent = persistent
  }
}

public struct ProjectLifecycleProcessSummary: Decodable, Hashable, Identifiable {
  public let name: String
  public let command: String
  public let cwd: String?
  public let service: String

  public var id: String {
    "\(service)::\(command)::\(cwd ?? "")"
  }

  public init(name: String, command: String, cwd: String?, service: String) {
    self.name = name
    self.command = command
    self.cwd = cwd
    self.service = service
  }
}

public struct BranchRuntime: Decodable, Hashable, Identifiable {
  public let branch: String
  public let runtime: RuntimeProject

  public var id: String { branch }

  public init(branch: String, runtime: RuntimeProject) {
    self.branch = branch
    self.runtime = runtime
  }
}

public struct ProjectSessionSummary: Decodable, Hashable, Identifiable {
  public let name: String
  public let backend: ProjectSessionBackend
  public let source: ProjectSessionSource
  public let attached: Bool
  public let path: String?
  public let windows: Int?
  public let createdAt: Int?

  public var id: String { "\(backend.rawValue):\(name)" }

  public init(
    name: String,
    backend: ProjectSessionBackend,
    source: ProjectSessionSource,
    attached: Bool,
    path: String?,
    windows: Int?,
    createdAt: Int?
  ) {
    self.name = name
    self.backend = backend
    self.source = source
    self.attached = attached
    self.path = path
    self.windows = windows
    self.createdAt = createdAt
  }
}

public struct RuntimeProject: Decodable, Hashable {
  public let project: String
  public let workingDir: String?
  public let services: [RuntimeService]

  public init(project: String, workingDir: String?, services: [RuntimeService]) {
    self.project = project
    self.workingDir = workingDir
    self.services = services
  }

  private enum CodingKeys: String, CodingKey {
    case project
    case workingDir = "working_dir"
    case services
  }
}

public struct RuntimeService: Decodable, Hashable {
  public let service: String
  public let containers: [RuntimeContainer]

  public init(service: String, containers: [RuntimeContainer]) {
    self.service = service
    self.containers = containers
  }
}

public struct RuntimeContainer: Decodable, Hashable {
  public let id: String
  public let state: String
  public let status: String
  public let name: String
  public let ports: String
  public let workingDir: String?
  public let image: String?
  public let labels: [String: String]?
  public let mounts: [RuntimeContainerMount]?
  public let networks: [RuntimeContainerNetwork]?

  public init(
    id: String,
    state: String,
    status: String,
    name: String,
    ports: String,
    workingDir: String?,
    image: String?,
    labels: [String: String]?,
    mounts: [RuntimeContainerMount]?,
    networks: [RuntimeContainerNetwork]?
  ) {
    self.id = id
    self.state = state
    self.status = status
    self.name = name
    self.ports = ports
    self.workingDir = workingDir
    self.image = image
    self.labels = labels
    self.mounts = mounts
    self.networks = networks
  }

  private enum CodingKeys: String, CodingKey {
    case id
    case state
    case status
    case name
    case ports
    case workingDir = "working_dir"
    case image
    case labels
    case mounts
    case networks
  }
}

public struct RuntimeContainerMount: Decodable, Hashable {
  public let type: String
  public let source: String
  public let destination: String
  public let mode: String
  public let rw: Bool?

  public init(type: String, source: String, destination: String, mode: String, rw: Bool?) {
    self.type = type
    self.source = source
    self.destination = destination
    self.mode = mode
    self.rw = rw
  }
}

public struct RuntimeContainerNetwork: Decodable, Hashable, Identifiable {
  public let name: String
  public let ipAddress: String?
  public let gateway: String?
  public let aliases: [String]?

  public var id: String { name }

  public init(name: String, ipAddress: String?, gateway: String?, aliases: [String]?) {
    self.name = name
    self.ipAddress = ipAddress
    self.gateway = gateway
    self.aliases = aliases
  }
}

public struct ProjectListResponse: Decodable {
  public let generatedAt: String?
  public let filter: String?
  public let includeGlobal: Bool?
  public let includeUnregistered: Bool?
  public let runtimeOk: Bool?
  public let runtimeError: String?
  public let runtimeCheckedAt: String?
  public let runtimeLastOkAt: String?
  public let runtimeResetAt: String?
  public let runtimeResetCount: Int?
  public let projects: [ProjectSummary]

  public init(
    generatedAt: String?,
    filter: String?,
    includeGlobal: Bool?,
    includeUnregistered: Bool?,
    runtimeOk: Bool?,
    runtimeError: String?,
    runtimeCheckedAt: String?,
    runtimeLastOkAt: String?,
    runtimeResetAt: String?,
    runtimeResetCount: Int?,
    projects: [ProjectSummary]
  ) {
    self.generatedAt = generatedAt
    self.filter = filter
    self.includeGlobal = includeGlobal
    self.includeUnregistered = includeUnregistered
    self.runtimeOk = runtimeOk
    self.runtimeError = runtimeError
    self.runtimeCheckedAt = runtimeCheckedAt
    self.runtimeLastOkAt = runtimeLastOkAt
    self.runtimeResetAt = runtimeResetAt
    self.runtimeResetCount = runtimeResetCount
    self.projects = projects
  }
}

public enum DaemonStatusLabel: String, Decodable {
  case running
  case starting
  case stale
  case stopped
}

public enum DaemonStaleReason: String, Decodable {
  case pidNotRunning = "pid_not_running"
  case socketOnly = "socket_only"
}

public struct DaemonStatus: Decodable, Hashable {
  public let status: DaemonStatusLabel?
  public let running: Bool
  public let apiOk: Bool?
  public let processRunning: Bool?
  public let stale: Bool?
  public let staleReason: DaemonStaleReason?
  public let pid: Int?
  public let socketPath: String?
  public let socketExists: Bool?
  public let logPath: String?
  public let logExists: Bool?

  public init(
    status: DaemonStatusLabel?,
    running: Bool,
    apiOk: Bool?,
    processRunning: Bool?,
    stale: Bool?,
    staleReason: DaemonStaleReason?,
    pid: Int?,
    socketPath: String?,
    socketExists: Bool?,
    logPath: String?,
    logExists: Bool?
  ) {
    self.status = status
    self.running = running
    self.apiOk = apiOk
    self.processRunning = processRunning
    self.stale = stale
    self.staleReason = staleReason
    self.pid = pid
    self.socketPath = socketPath
    self.socketExists = socketExists
    self.logPath = logPath
    self.logExists = logExists
  }
}

public struct GlobalStatusResponse: Decodable {
  public let generatedAt: String?
  public let caddy: ComposeStatusGroup?
  public let logging: ComposeStatusGroup?
  public let networks: NetworkStatusGroup?
  public let gateway: GatewayStatus?
  public let summary: GlobalStatusSummary

  public init(
    generatedAt: String?,
    caddy: ComposeStatusGroup?,
    logging: ComposeStatusGroup?,
    networks: NetworkStatusGroup?,
    gateway: GatewayStatus?,
    summary: GlobalStatusSummary
  ) {
    self.generatedAt = generatedAt
    self.caddy = caddy
    self.logging = logging
    self.networks = networks
    self.gateway = gateway
    self.summary = summary
  }
}

public struct GlobalStatusSummary: Decodable {
  public let ok: Bool
  public let caddyOk: Bool
  public let loggingOk: Bool
  public let networksOk: Bool
  public let gatewayEnabled: Bool?

  public init(
    ok: Bool,
    caddyOk: Bool,
    loggingOk: Bool,
    networksOk: Bool,
    gatewayEnabled: Bool?
  ) {
    self.ok = ok
    self.caddyOk = caddyOk
    self.loggingOk = loggingOk
    self.networksOk = networksOk
    self.gatewayEnabled = gatewayEnabled
  }
}

public struct ComposeStatusGroup: Decodable {
  public let ok: Bool
  public let error: String?
  public let services: [ComposeServiceStatus]

  public init(ok: Bool, error: String?, services: [ComposeServiceStatus]) {
    self.ok = ok
    self.error = error
    self.services = services
  }
}

public struct ComposeServiceStatus: Decodable, Hashable {
  public let service: String
  public let name: String
  public let status: String
  public let ports: String

  public init(service: String, name: String, status: String, ports: String) {
    self.service = service
    self.name = name
    self.status = status
    self.ports = ports
  }
}

public struct NetworkStatusGroup: Decodable {
  public let ok: Bool
  public let missing: [String]
  public let networks: [NetworkStatus]

  public init(ok: Bool, missing: [String], networks: [NetworkStatus]) {
    self.ok = ok
    self.missing = missing
    self.networks = networks
  }
}

public struct NetworkStatus: Decodable, Hashable {
  public let name: String
  public let id: String
  public let driver: String
  public let scope: String

  public init(name: String, id: String, driver: String, scope: String) {
    self.name = name
    self.id = id
    self.driver = driver
    self.scope = scope
  }
}

public struct GatewayStatus: Decodable {
  public let configPath: String?
  public let gatewayUrl: String?
  public let gatewayBind: String?
  public let gatewayPort: Int?
  public let allowWrites: Bool?
  public let gatewayEnabled: Bool?
  public let gatewayProjectsEnabled: Int?
  public let tokensActive: Int?
  public let tokensRevoked: Int?
  public let tokensWrite: Int?
  public let tokensRead: Int?
  public let tokens: [GatewayTokenRecord]?
  public let gatewayProjects: String?
  public let exposures: [GatewayExposure]?
  public let warnings: [String]?

  public init(
    configPath: String?,
    gatewayUrl: String?,
    gatewayBind: String?,
    gatewayPort: Int?,
    allowWrites: Bool?,
    gatewayEnabled: Bool?,
    gatewayProjectsEnabled: Int?,
    tokensActive: Int?,
    tokensRevoked: Int?,
    tokensWrite: Int?,
    tokensRead: Int?,
    tokens: [GatewayTokenRecord]?,
    gatewayProjects: String?,
    exposures: [GatewayExposure]?,
    warnings: [String]?
  ) {
    self.configPath = configPath
    self.gatewayUrl = gatewayUrl
    self.gatewayBind = gatewayBind
    self.gatewayPort = gatewayPort
    self.allowWrites = allowWrites
    self.gatewayEnabled = gatewayEnabled
    self.gatewayProjectsEnabled = gatewayProjectsEnabled
    self.tokensActive = tokensActive
    self.tokensRevoked = tokensRevoked
    self.tokensWrite = tokensWrite
    self.tokensRead = tokensRead
    self.tokens = tokens
    self.gatewayProjects = gatewayProjects
    self.exposures = exposures
    self.warnings = warnings
  }
}

public enum GatewayTokenScope: String, Decodable {
  case read
  case write
}

public struct GatewayTokenRecord: Decodable, Identifiable, Hashable {
  public let id: String
  public let scope: GatewayTokenScope
  public let label: String?
  public let createdAt: String
  public let lastUsedAt: String?
  public let revokedAt: String?

  public init(
    id: String,
    scope: GatewayTokenScope,
    label: String?,
    createdAt: String,
    lastUsedAt: String?,
    revokedAt: String?
  ) {
    self.id = id
    self.scope = scope
    self.label = label
    self.createdAt = createdAt
    self.lastUsedAt = lastUsedAt
    self.revokedAt = revokedAt
  }
}

public struct GatewayTokenListResponse: Decodable {
  public let tokens: [GatewayTokenRecord]

  public init(tokens: [GatewayTokenRecord]) {
    self.tokens = tokens
  }
}

public struct GatewayTokenCreateResponse: Decodable {
  public let token: String
  public let record: GatewayTokenRecord

  public init(token: String, record: GatewayTokenRecord) {
    self.token = token
    self.record = record
  }
}

public struct GatewayTokenRevokeResponse: Decodable {
  public let id: String
  public let revoked: Bool

  public init(id: String, revoked: Bool) {
    self.id = id
    self.revoked = revoked
  }
}

public struct TailscaleInspectResponse: Decodable {
  public let installed: Bool
  public let binaryPath: String?
  public let connected: Bool
  public let backendState: String?
  public let tailnetName: String?
  public let magicDnsSuffix: String?
  public let authUrl: String?
  public let currentExitNodeId: String?
  public let currentExitNodeName: String?
  public let selfDevice: TailscaleInspectSelf?
  public let peers: [TailscaleInspectPeer]
  public let onlinePeerCount: Int
  public let exitNodes: [TailscaleInspectPeer]
  public let health: [String]
  public let error: String?

  public init(
    installed: Bool,
    binaryPath: String?,
    connected: Bool,
    backendState: String?,
    tailnetName: String?,
    magicDnsSuffix: String?,
    authUrl: String?,
    currentExitNodeId: String?,
    currentExitNodeName: String?,
    selfDevice: TailscaleInspectSelf?,
    peers: [TailscaleInspectPeer],
    onlinePeerCount: Int,
    exitNodes: [TailscaleInspectPeer],
    health: [String],
    error: String?
  ) {
    self.installed = installed
    self.binaryPath = binaryPath
    self.connected = connected
    self.backendState = backendState
    self.tailnetName = tailnetName
    self.magicDnsSuffix = magicDnsSuffix
    self.authUrl = authUrl
    self.currentExitNodeId = currentExitNodeId
    self.currentExitNodeName = currentExitNodeName
    self.selfDevice = selfDevice
    self.peers = peers
    self.onlinePeerCount = onlinePeerCount
    self.exitNodes = exitNodes
    self.health = health
    self.error = error
  }

  private enum CodingKeys: String, CodingKey {
    case installed
    case binaryPath
    case connected
    case backendState
    case tailnetName
    case magicDnsSuffix
    case authUrl
    case currentExitNodeId
    case currentExitNodeName
    case selfDevice = "self"
    case peers
    case onlinePeerCount
    case exitNodes
    case health
    case error
  }
}

public struct TailscaleInspectSelf: Decodable, Hashable, Identifiable {
  public let id: String
  public let hostname: String
  public let dnsName: String?
  public let tailscaleIp: String?
  public let online: Bool
  public let os: String?
  public let tags: [String]
  public let isExitNode: Bool

  public init(
    id: String,
    hostname: String,
    dnsName: String?,
    tailscaleIp: String?,
    online: Bool,
    os: String?,
    tags: [String],
    isExitNode: Bool
  ) {
    self.id = id
    self.hostname = hostname
    self.dnsName = dnsName
    self.tailscaleIp = tailscaleIp
    self.online = online
    self.os = os
    self.tags = tags
    self.isExitNode = isExitNode
  }
}

public struct TailscaleInspectPeer: Decodable, Hashable, Identifiable {
  public let id: String
  public let hostname: String
  public let dnsName: String?
  public let tailscaleIp: String?
  public let online: Bool
  public let os: String?
  public let tags: [String]
  public let isExitNode: Bool
  public let isExitNodeOption: Bool

  public init(
    id: String,
    hostname: String,
    dnsName: String?,
    tailscaleIp: String?,
    online: Bool,
    os: String?,
    tags: [String],
    isExitNode: Bool,
    isExitNodeOption: Bool
  ) {
    self.id = id
    self.hostname = hostname
    self.dnsName = dnsName
    self.tailscaleIp = tailscaleIp
    self.online = online
    self.os = os
    self.tags = tags
    self.isExitNode = isExitNode
    self.isExitNodeOption = isExitNodeOption
  }
}

public struct GatewayExposure: Decodable, Identifiable, Hashable {
  public enum State: String, Decodable {
    case disabled
    case needsConfig = "needs_config"
    case configured
    case running
    case blocked
    case unknown
  }

  public let id: String
  public let label: String
  public let enabled: Bool
  public let state: State?
  public let detail: String?
  public let url: String?

  public init(
    id: String,
    label: String,
    enabled: Bool,
    state: State?,
    detail: String?,
    url: String?
  ) {
    self.id = id
    self.label = label
    self.enabled = enabled
    self.state = state
    self.detail = detail
    self.url = url
  }
}

public enum TicketStatus: String, Decodable {
  case open
  case inProgress = "in_progress"
  case blocked
  case done
}
extension TicketStatus: Encodable {}

public struct TicketSummary: Decodable, Encodable, Identifiable, Hashable {
  public let ticketId: String
  public let title: String
  public let body: String?
  public let status: TicketStatus
  public let createdAt: String
  public let updatedAt: String
  public let dependsOn: [String]
  public let blocks: [String]
  public let projectId: String?
  public let projectName: String?

  public var id: String { ticketId }

  public init(
    ticketId: String,
    title: String,
    body: String?,
    status: TicketStatus,
    createdAt: String,
    updatedAt: String,
    dependsOn: [String],
    blocks: [String],
    projectId: String?,
    projectName: String?
  ) {
    self.ticketId = ticketId
    self.title = title
    self.body = body
    self.status = status
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.dependsOn = dependsOn
    self.blocks = blocks
    self.projectId = projectId
    self.projectName = projectName
  }
}

public struct TicketEvent: Decodable, Identifiable, Hashable {
  public let eventId: String
  public let ts: Int
  public let tsIso: String
  public let actor: String
  public let projectId: String?
  public let projectName: String?
  public let ticketId: String
  public let type: String

  public var id: String { eventId }

  public init(
    eventId: String,
    ts: Int,
    tsIso: String,
    actor: String,
    projectId: String?,
    projectName: String?,
    ticketId: String,
    type: String
  ) {
    self.eventId = eventId
    self.ts = ts
    self.tsIso = tsIso
    self.actor = actor
    self.projectId = projectId
    self.projectName = projectName
    self.ticketId = ticketId
    self.type = type
  }
}

public struct TicketsListResponse: Decodable {
  public let tickets: [TicketSummary]

  public init(tickets: [TicketSummary]) {
    self.tickets = tickets
  }
}

public struct TicketDetailResponse: Decodable {
  public let ticket: TicketSummary
  public let events: [TicketEvent]

  public init(ticket: TicketSummary, events: [TicketEvent]) {
    self.ticket = ticket
    self.events = events
  }
}

public struct TicketCreateResponse: Decodable {
  public let ticket: TicketSummary

  public init(ticket: TicketSummary) {
    self.ticket = ticket
  }
}

public struct TicketUpdateResponse: Decodable {
  public let ok: Bool
  public let ticketId: String

  public init(ok: Bool, ticketId: String) {
    self.ok = ok
    self.ticketId = ticketId
  }
}

public struct TicketStatusResponse: Decodable {
  public let ok: Bool
  public let ticketId: String
  public let status: TicketStatus

  public init(ok: Bool, ticketId: String, status: TicketStatus) {
    self.ok = ok
    self.ticketId = ticketId
    self.status = status
  }
}

public struct TicketsSyncResponse: Decodable {
  public let sync: TicketsSyncResult

  public init(sync: TicketsSyncResult) {
    self.sync = sync
  }
}

public struct TicketsSyncResult: Decodable {
  public let ok: Bool
  public let branch: String?
  public let remote: String?
  public let didCommit: Bool?
  public let didPush: Bool?
  public let error: String?

  public init(
    ok: Bool,
    branch: String?,
    remote: String?,
    didCommit: Bool?,
    didPush: Bool?,
    error: String?
  ) {
    self.ok = ok
    self.branch = branch
    self.remote = remote
    self.didCommit = didCommit
    self.didPush = didPush
    self.error = error
  }
}
