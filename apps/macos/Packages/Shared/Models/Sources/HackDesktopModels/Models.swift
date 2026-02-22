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

public enum NodeRegistryStatus: String, Decodable {
  case healthy
  case stale
  case offline
  case unknown
}

public struct NodeRegistryRecord: Decodable, Identifiable, Hashable {
  public let id: String
  public let name: String
  public let labels: [String]
  public let capabilities: [String]
  public let endpoint: String
  public let authRef: String
  public let lastSeenAt: String?
  public let status: NodeRegistryStatus?
  public let version: String?
  public let platform: String?
  public let arch: String?
  public let createdAt: String?
  public let updatedAt: String?
  public let isDefault: Bool?

  public init(
    id: String,
    name: String,
    labels: [String],
    capabilities: [String],
    endpoint: String,
    authRef: String,
    lastSeenAt: String?,
    status: NodeRegistryStatus?,
    version: String?,
    platform: String?,
    arch: String?,
    createdAt: String?,
    updatedAt: String?,
    isDefault: Bool?
  ) {
    self.id = id
    self.name = name
    self.labels = labels
    self.capabilities = capabilities
    self.endpoint = endpoint
    self.authRef = authRef
    self.lastSeenAt = lastSeenAt
    self.status = status
    self.version = version
    self.platform = platform
    self.arch = arch
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.isDefault = isDefault
  }
}

public struct NodeRegistryListResponse: Decodable {
  public let defaultNodeId: String?
  public let nodes: [NodeRegistryRecord]

  public init(defaultNodeId: String?, nodes: [NodeRegistryRecord]) {
    self.defaultNodeId = defaultNodeId
    self.nodes = nodes
  }
}

public struct NodeRuntimeGatewayProject: Decodable, Identifiable, Hashable {
  public let projectId: String
  public let projectName: String

  public var id: String { projectId }

  public init(projectId: String, projectName: String) {
    self.projectId = projectId
    self.projectName = projectName
  }
}

public struct NodeRuntimeGateway: Decodable, Hashable {
  public let enabled: Bool?
  public let bind: String?
  public let port: Int?
  public let allowWrites: Bool?
  public let projects: [NodeRuntimeGatewayProject]?

  public init(
    enabled: Bool?,
    bind: String?,
    port: Int?,
    allowWrites: Bool?,
    projects: [NodeRuntimeGatewayProject]?
  ) {
    self.enabled = enabled
    self.bind = bind
    self.port = port
    self.allowWrites = allowWrites
    self.projects = projects
  }
}

public struct NodeRuntimeNodeInfo: Decodable, Hashable {
  public let name: String?
  public let platform: String?
  public let arch: String?
  public let bun: String?

  public init(name: String?, platform: String?, arch: String?, bun: String?) {
    self.name = name
    self.platform = platform
    self.arch = arch
    self.bun = bun
  }
}

public struct NodeRuntimeSupervisor: Decodable, Hashable {
  public let enabled: Bool?
  public let maxConcurrentJobs: Int?

  public init(enabled: Bool?, maxConcurrentJobs: Int?) {
    self.enabled = enabled
    self.maxConcurrentJobs = maxConcurrentJobs
  }
}

public struct NodeRuntimeDevcontainers: Decodable, Hashable {
  public let running: Int?

  public init(running: Int?) {
    self.running = running
  }
}

public struct NodeRuntimeStatusPayload: Decodable, Hashable {
  public let status: String?
  public let version: String?
  public let pid: Int?
  public let startedAt: String?
  public let uptimeMs: Int?
  public let node: NodeRuntimeNodeInfo?
  public let gateway: NodeRuntimeGateway?
  public let supervisor: NodeRuntimeSupervisor?
  public let devcontainers: NodeRuntimeDevcontainers?

  public init(
    status: String?,
    version: String?,
    pid: Int?,
    startedAt: String?,
    uptimeMs: Int?,
    node: NodeRuntimeNodeInfo?,
    gateway: NodeRuntimeGateway?,
    supervisor: NodeRuntimeSupervisor?,
    devcontainers: NodeRuntimeDevcontainers?
  ) {
    self.status = status
    self.version = version
    self.pid = pid
    self.startedAt = startedAt
    self.uptimeMs = uptimeMs
    self.node = node
    self.gateway = gateway
    self.supervisor = supervisor
    self.devcontainers = devcontainers
  }
}

public struct NodeStatusProbe: Decodable, Identifiable, Hashable {
  public let ok: Bool
  public let input: NodeRegistryRecord
  public let status: NodeRegistryStatus?
  public let node: NodeRegistryRecord?
  public let payload: NodeRuntimeStatusPayload?
  public let error: String?

  public var id: String { input.id }

  public init(
    ok: Bool,
    input: NodeRegistryRecord,
    status: NodeRegistryStatus?,
    node: NodeRegistryRecord?,
    payload: NodeRuntimeStatusPayload?,
    error: String?
  ) {
    self.ok = ok
    self.input = input
    self.status = status
    self.node = node
    self.payload = payload
    self.error = error
  }
}

public struct NodeStatusResponse: Decodable {
  public let nodes: [NodeStatusProbe]

  public init(nodes: [NodeStatusProbe]) {
    self.nodes = nodes
  }
}

public struct NodeUseResponse: Decodable {
  public let defaultNodeId: String?

  public init(defaultNodeId: String?) {
    self.defaultNodeId = defaultNodeId
  }
}

public struct NodeRemoveResponse: Decodable {
  public let removed: Bool
  public let nodeId: String

  public init(removed: Bool, nodeId: String) {
    self.removed = removed
    self.nodeId = nodeId
  }
}

public struct NodePairingSession: Decodable, Hashable {
  public let id: String
  public let source: String
  public let endpoint: String
  public let codeHash: String
  public let createdAt: String
  public let expiresAt: String
  public let status: String
  public let updatedAt: String
  public let approvedAt: String?
  public let consumedAt: String?

  public init(
    id: String,
    source: String,
    endpoint: String,
    codeHash: String,
    createdAt: String,
    expiresAt: String,
    status: String,
    updatedAt: String,
    approvedAt: String?,
    consumedAt: String?
  ) {
    self.id = id
    self.source = source
    self.endpoint = endpoint
    self.codeHash = codeHash
    self.createdAt = createdAt
    self.expiresAt = expiresAt
    self.status = status
    self.updatedAt = updatedAt
    self.approvedAt = approvedAt
    self.consumedAt = consumedAt
  }
}

public struct NodePairCancelResponse: Decodable, Hashable {
  public let cancelled: Bool
  public let sessionId: String

  public init(cancelled: Bool, sessionId: String) {
    self.cancelled = cancelled
    self.sessionId = sessionId
  }
}

public struct NodePairListResponse: Decodable, Hashable {
  public let sessions: [NodePairingSession]
  public let status: String?

  public init(sessions: [NodePairingSession], status: String?) {
    self.sessions = sessions
    self.status = status
  }
}

public struct NodePairFulfillPairing: Decodable, Hashable {
  public let sessionId: String
  public let consumedAt: String?

  public init(sessionId: String, consumedAt: String?) {
    self.sessionId = sessionId
    self.consumedAt = consumedAt
  }
}

public struct NodePairFulfillProbe: Decodable, Hashable {
  public let ok: Bool
  public let status: NodeRegistryStatus?
  public let error: String?

  public init(ok: Bool, status: NodeRegistryStatus?, error: String?) {
    self.ok = ok
    self.status = status
    self.error = error
  }
}

public struct NodePairFulfillResponse: Decodable, Hashable {
  public let node: NodeRegistryRecord
  public let created: Bool
  public let pairing: NodePairFulfillPairing
  public let probe: NodePairFulfillProbe

  public init(
    node: NodeRegistryRecord,
    created: Bool,
    pairing: NodePairFulfillPairing,
    probe: NodePairFulfillProbe
  ) {
    self.node = node
    self.created = created
    self.pairing = pairing
    self.probe = probe
  }
}

public struct RailwayInspectResponse: Decodable, Hashable {
  public let installed: Bool
  public let binaryPath: String?
  public let version: String?
  public let authenticated: Bool
  public let whoami: String?
  public let error: String?

  public init(
    installed: Bool,
    binaryPath: String?,
    version: String?,
    authenticated: Bool,
    whoami: String?,
    error: String?
  ) {
    self.installed = installed
    self.binaryPath = binaryPath
    self.version = version
    self.authenticated = authenticated
    self.whoami = whoami
    self.error = error
  }
}

public struct RailwayBootstrapRequest: Hashable {
  public let railwayProject: String
  public let railwayService: String?
  public let railwayEnvironment: String?
  public let railwayWorkspace: String?
  public let createService: Bool
  public let railwayImage: String?
  public let railwayBin: String?
  public let nodeName: String?
  public let endpoint: String?
  public let labels: [String]
  public let defaultNode: Bool
  public let domainPort: Int?
  public let initRetries: Int?
  public let privateNetworking: Bool
  public let tailscaleAuthKey: String?
  public let tailscaleHostname: String?
  public let tailscaleTags: [String]

  public init(
    railwayProject: String,
    railwayService: String?,
    railwayEnvironment: String?,
    railwayWorkspace: String?,
    createService: Bool,
    railwayImage: String?,
    railwayBin: String?,
    nodeName: String?,
    endpoint: String?,
    labels: [String],
    defaultNode: Bool,
    domainPort: Int?,
    initRetries: Int?,
    privateNetworking: Bool,
    tailscaleAuthKey: String?,
    tailscaleHostname: String?,
    tailscaleTags: [String]
  ) {
    self.railwayProject = railwayProject
    self.railwayService = railwayService
    self.railwayEnvironment = railwayEnvironment
    self.railwayWorkspace = railwayWorkspace
    self.createService = createService
    self.railwayImage = railwayImage
    self.railwayBin = railwayBin
    self.nodeName = nodeName
    self.endpoint = endpoint
    self.labels = labels
    self.defaultNode = defaultNode
    self.domainPort = domainPort
    self.initRetries = initRetries
    self.privateNetworking = privateNetworking
    self.tailscaleAuthKey = tailscaleAuthKey
    self.tailscaleHostname = tailscaleHostname
    self.tailscaleTags = tailscaleTags
  }
}

public struct RailwayBootstrapProviderMetadata: Decodable, Hashable {
  public let project: String?
  public let service: String?
  public let environment: String?
  public let network: String?
  public let tailscaleAuth: String?
  public let workspace: String?
  public let createService: Bool?
  public let domainPort: Int?
  public let initAttempts: Int?

  public init(
    project: String?,
    service: String?,
    environment: String?,
    network: String?,
    tailscaleAuth: String?,
    workspace: String?,
    createService: Bool?,
    domainPort: Int?,
    initAttempts: Int?
  ) {
    self.project = project
    self.service = service
    self.environment = environment
    self.network = network
    self.tailscaleAuth = tailscaleAuth
    self.workspace = workspace
    self.createService = createService
    self.domainPort = domainPort
    self.initAttempts = initAttempts
  }
}

public struct RailwayBootstrapProbe: Decodable, Hashable {
  public let ok: Bool
  public let status: NodeRegistryStatus?
  public let error: String?

  public init(ok: Bool, status: NodeRegistryStatus?, error: String?) {
    self.ok = ok
    self.status = status
    self.error = error
  }
}

public struct RailwayBootstrapResponse: Decodable, Hashable {
  public let provider: String
  public let railway: RailwayBootstrapProviderMetadata
  public let node: NodeRegistryRecord
  public let endpoint: String
  public let created: Bool
  public let probe: RailwayBootstrapProbe

  public init(
    provider: String,
    railway: RailwayBootstrapProviderMetadata,
    node: NodeRegistryRecord,
    endpoint: String,
    created: Bool,
    probe: RailwayBootstrapProbe
  ) {
    self.provider = provider
    self.railway = railway
    self.node = node
    self.endpoint = endpoint
    self.created = created
    self.probe = probe
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

public struct TailscaleOAuthStatusResponse: Decodable, Hashable {
  public let configured: Bool
  public let clientId: String?
  public let authRef: String?
  public let tailnet: String?
  public let keyExpirySeconds: Int?
  public let validated: Bool?
  public let checkedAt: String?
  public let tokenExpiresAt: String?
  public let deleted: Bool?
  public let error: String?

  public init(
    configured: Bool,
    clientId: String?,
    authRef: String?,
    tailnet: String?,
    keyExpirySeconds: Int?,
    validated: Bool?,
    checkedAt: String?,
    tokenExpiresAt: String?,
    deleted: Bool?,
    error: String?
  ) {
    self.configured = configured
    self.clientId = clientId
    self.authRef = authRef
    self.tailnet = tailnet
    self.keyExpirySeconds = keyExpirySeconds
    self.validated = validated
    self.checkedAt = checkedAt
    self.tokenExpiresAt = tokenExpiresAt
    self.deleted = deleted
    self.error = error
  }
}

public struct TailscaleOAuthConnectRequest: Hashable {
  public let clientId: String
  public let clientSecret: String
  public let authRef: String?
  public let tailnet: String?
  public let keyExpirySeconds: Int?

  public init(
    clientId: String,
    clientSecret: String,
    authRef: String?,
    tailnet: String?,
    keyExpirySeconds: Int?
  ) {
    self.clientId = clientId
    self.clientSecret = clientSecret
    self.authRef = authRef
    self.tailnet = tailnet
    self.keyExpirySeconds = keyExpirySeconds
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
