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
  public let meta: ProjectMeta?
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
    meta: ProjectMeta?,
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
    self.meta = meta
    self.kind = kind
    self.status = status
  }
}

public enum HackEnvSource: String, Decodable, Hashable {
  case plainEnv = "plain_env"
  case keychain
}

public enum EnvResolvedFrom: String, Decodable, Hashable {
  case dotenv
  case process
  case keychain
}

public struct ProjectMeta: Decodable, Hashable {
  public let git: GitMeta
  public let hackBranches: HackBranchesMeta
  public let env: EnvMeta
  public let sessions: SessionsMeta
  public let composeBuild: ComposeBuildMeta
}

public struct GitMeta: Decodable, Hashable {
  public let isRepo: Bool
  public let head: String?
  public let branch: String?
  public let detached: Bool?
  public let dirty: Bool?
  public let localBranchCount: Int?
  public let worktrees: [GitWorktreeMeta]?
  public let error: String?
}

public struct GitWorktreeMeta: Decodable, Hashable {
  public let path: String
  public let head: String?
  public let branch: String?
  public let detached: Bool
}

public struct HackBranchesMeta: Decodable, Hashable {
  public let path: String
  public let parseError: String?
  public let branches: [HackBranchEntry]
}

public struct HackBranchEntry: Decodable, Hashable, Identifiable {
  public let name: String
  public let slug: String
  public let note: String?
  public let createdAt: String?
  public let lastUsedAt: String?

  public var id: String { slug }
}

public struct EnvMeta: Decodable, Hashable {
  public let contractPath: String
  public let contractExists: Bool
  public let contractParseError: String?
  public let vars: [EnvVarMeta]
  public let missingRequired: [String]
}

public struct EnvVarMeta: Decodable, Hashable, Identifiable {
  public let key: String
  public let required: Bool
  public let source: HackEnvSource
  public let services: [String]?
  public let description: String?
  public let resolvedFrom: EnvResolvedFrom?
  public let hasValue: Bool

  public var id: String { key }
}

public struct SessionsMeta: Decodable, Hashable {
  public let sessions: [MuxSessionSummary]
}

public struct MuxSessionSummary: Decodable, Hashable, Identifiable {
  public let backend: String
  public let name: String
  public let attached: Bool?
  public let path: String?
  public let windows: Int?
  public let createdAt: String?

  public var id: String { "\(backend):\(name)" }
}

public struct ComposeBuildMeta: Decodable, Hashable {
  public let services: [ComposeBuildServiceMeta]
}

public struct ComposeBuildServiceMeta: Decodable, Hashable, Identifiable {
  public let service: String
  public let build: Bool
  public let context: String?
  public let dockerfile: String?
  public let dockerfilePath: String?
  public let dockerfileExists: Bool?

  public var id: String { service }
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
  public let image: String?
  public let ip: String?
  public let mounts: [RuntimeMount]?
  public let labels: [String: String]?
  public let workingDir: String?

  public init(
    id: String,
    state: String,
    status: String,
    name: String,
    ports: String,
    image: String?,
    ip: String?,
    mounts: [RuntimeMount]?,
    labels: [String: String]?,
    workingDir: String?
  ) {
    self.id = id
    self.state = state
    self.status = status
    self.name = name
    self.ports = ports
    self.image = image
    self.ip = ip
    self.mounts = mounts
    self.labels = labels
    self.workingDir = workingDir
  }

  private enum CodingKeys: String, CodingKey {
    case id
    case state
    case status
    case name
    case ports
    case image
    case ip
    case mounts
    case labels
    case workingDir = "working_dir"
  }
}

public struct RuntimeMount: Decodable, Hashable {
  public let source: String?
  public let destination: String?

  public init(source: String?, destination: String?) {
    self.source = source
    self.destination = destination
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
    self.gatewayProjects = gatewayProjects
    self.exposures = exposures
    self.warnings = warnings
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
