import Foundation
import SwiftUI

import HackDesktopModels

struct NodeTopologySettingsView: View {
  private static let localTopologyNodeId = "__local_controller__"

  @Environment(DashboardModel.self) private var model
  @AppStorage("hackDesktop.topology.isControllerHost") private var isControllerHost = true
  @AppStorage("hackDesktop.preferences.defaultTerminal") private var preferredTerminalRaw =
    TerminalIntegration.ExternalTerminalApp.terminal.rawValue
  @AppStorage("hackDesktop.sessions.preferredExternalTerminal")
  private var legacyPreferredTerminalRaw = TerminalIntegration.ExternalTerminalApp.terminal.rawValue
  @State private var registry: NodeRegistryListResponse? = nil
  @State private var probeByNodeId: [String: NodeStatusProbe] = [:]
  @State private var tailscale: TailscaleInspectResponse? = nil
  @State private var isLoading = false
  @State private var pendingRemoval: NodeRegistryRecord? = nil
  @State private var pairingSessions: [NodePairingSession] = []
  @State private var pairingCodeBySessionId: [String: String] = [:]
  @State private var pairingSshPortOverride = ""
  @State private var pairingDefault = true
  @State private var pairingBusySessionId: String? = nil
  @State private var lastTopologyRefreshAt: Date? = nil
  @State private var nodeMutationInFlight: String? = nil
  @State private var topologyRefreshTask: Task<Void, Never>? = nil
  @State private var selectedTopologyNodeId = Self.localTopologyNodeId
  @State private var topologyExpanded = false
  @State private var controllerLayoutProfile = "local:default"
  @State private var topologyLayoutOverrides: [String: CGPoint] = [:]
  @State private var compactTopologyCanvasSize: CGSize = .zero
  @State private var expandedTopologyCanvasSize: CGSize = .zero
  @AppStorage("hackDesktop.topology.layoutByController.v1")
  private var topologyLayoutByControllerRaw = ""

  private let topologyRefreshThrottleSeconds: TimeInterval = 30

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 20) {
        SettingsSectionHeader(
          breadcrumb: "Settings / System / Topology",
          title: "Node + Gateway Topology",
          subtitle: "Controller/node role, default routing, and authorized remote nodes"
        )

        localRoleCard
        networkTopologyCard

        if isControllerHost {
          pairingRequestsCard
        } else {
          nodeModeGuidanceCard
        }

        authorizedNodesCard
        trustModelCard
      }
      .padding(16)
    }
    .task {
      queueTopologyRefresh(force: true)
    }
    .onChange(of: model.lastUpdated) { _, _ in
      queueTopologyRefresh(force: false)
    }
    .onDisappear {
      topologyRefreshTask?.cancel()
      topologyRefreshTask = nil
    }
    .sheet(isPresented: $topologyExpanded) {
      topologyExpandedSheet
    }
    .alert(
      "Remove node?",
      isPresented: Binding(
        get: { pendingRemoval != nil },
        set: { isPresented in
          if !isPresented {
            pendingRemoval = nil
          }
        }
      ),
      presenting: pendingRemoval
    ) { node in
      Button("Cancel", role: .cancel) {}
      Button("Remove", role: .destructive) {
        Task {
          beginNodeMutation(nodeId: node.id)
          defer { endNodeMutation(nodeId: node.id) }
          let removed = await model.removeNode(id: node.id)
          if removed {
            removeNodeFromLocalState(nodeId: node.id)
          }
          pendingRemoval = nil
          await refreshTopology(force: true)
        }
      }
    } message: { node in
      Text("This removes \(node.name) from the controller registry and deletes its stored auth token reference.")
    }
  }

  private var localRoleCard: some View {
    GlassCard(title: "Local role", systemImage: "point.3.connected.trianglepath.dotted") {
      HStack(alignment: .center, spacing: 8) {
        StatusPill(text: localRoleLabel, tone: localRoleTone)
        if isControllerHost {
          if let defaultNode {
            StatusPill(
              text: endpointMatchesLocalDevice(defaultNode.endpoint)
                ? "This device is default node"
                : "Remote default node",
              tone: endpointMatchesLocalDevice(defaultNode.endpoint) ? .good : .neutral
            )
          } else {
            StatusPill(text: "No default node selected", tone: .warn)
          }
          if !pairingSessions.isEmpty {
            StatusPill(
              text: "\(pairingSessions.count) pending request\(pairingSessions.count == 1 ? "" : "s")",
              tone: .warn
            )
          }
        } else {
          StatusPill(text: "Controller mode disabled", tone: .neutral)
        }
        Spacer()
        if isControllerHost {
          Button {
            openRailwaySettings()
          } label: {
            Label("Add remote node", systemImage: "plus.circle")
          }
          .adaptiveToolbarButton()
        }
        Button {
          Task { await refreshTopology(force: true) }
        } label: {
          Label("Refresh topology", systemImage: "arrow.clockwise")
        }
        .adaptiveToolbarButtonProminent()
        .disabled(isLoading)
      }

      Toggle("This Mac is the controller host", isOn: $isControllerHost)
        .font(.mono(.subheadline))
        .onChange(of: isControllerHost) { _, isEnabled in
          if !isEnabled {
            pairingSessions = []
            pairingCodeBySessionId = [:]
          }
          queueTopologyRefresh(force: true)
        }

      Text(
        isControllerHost
          ? "Host mode enables pairing inbox approval, default node assignment, and node registry writes from this device."
          : "Node mode keeps this device as a runtime-only participant. Pairing approval happens on a host controller device."
      )
      .font(.mono(.caption2))
      .foregroundStyle(.secondary)

      if let defaultNode {
        Text("Default node: \(defaultNode.name) (\(defaultNode.id))")
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
          .textSelection(.enabled)
      } else {
        Text("Default node: none. Use “Set default” on a registered node.")
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
      }
      Text("Default node is the fallback execution target when dispatch/project routing does not pin a node.")
        .font(.mono(.caption2))
        .foregroundStyle(.tertiary)
      Text("Controller host and default node are separate roles; host controls trust + routing, default picks fallback execution target.")
        .font(.mono(.caption2))
        .foregroundStyle(.tertiary)

      Text("Controller registry: \(sortedNodes.count) node\(sortedNodes.count == 1 ? "" : "s") authorized")
        .font(.mono(.caption2))
        .foregroundStyle(.tertiary)
    }
  }

  private var networkTopologyCard: some View {
    GlassCard(title: "Hack network topology", systemImage: "network") {
      VStack(alignment: .leading, spacing: 12) {
        HStack(spacing: 8) {
          StatusPill(
            text: "\(topologyGraphNodes.count) node\(topologyGraphNodes.count == 1 ? "" : "s")",
            tone: topologyGraphNodes.count > 1 ? .good : .warn
          )
          StatusPill(
            text: "\(topologyGraphEdges.count) edge\(topologyGraphEdges.count == 1 ? "" : "s")",
            tone: topologyGraphEdges.isEmpty ? .warn : .neutral
          )
          if isControllerHost {
            Menu {
              Button("Add via Railway") {
                openRailwaySettings()
              }
              Button("Open Tailscale") {
                openTailscaleSettings()
              }
              Button("Open Extensions") {
                openExtensionsSettings()
              }
            } label: {
              Label("Add node", systemImage: "plus.circle")
            }
            .adaptiveToolbarButton()
          }
          Spacer()
          Button {
            topologyExpanded = true
          } label: {
            Label("Expand", systemImage: "arrow.up.left.and.arrow.down.right")
          }
          .adaptiveToolbarButton()
          Button {
            autoTidyTopologyLayout()
          } label: {
            Label("Auto tidy", systemImage: "wand.and.stars")
          }
          .adaptiveToolbarButton()
          Button {
            resetTopologyLayout()
          } label: {
            Label("Reset layout", systemImage: "arrow.counterclockwise")
          }
          .adaptiveToolbarButton()
        }

        TopologyGraphCanvas(
          nodes: topologyGraphNodes,
          edges: topologyGraphEdges,
          layoutOverrides: topologyLayoutOverrides,
          selectedNodeId: $selectedTopologyNodeId,
          minHeight: 300,
          onNodeMoved: handleTopologyNodeMoved,
          onSizeChanged: handleCompactTopologyCanvasSizeChanged
        )
        .overlay(alignment: .topTrailing) {
          if isControllerHost {
            Button {
              openRailwaySettings()
            } label: {
              Image(systemName: "plus")
                .font(.system(size: 12, weight: .semibold))
                .frame(width: 26, height: 26)
            }
            .buttonStyle(.plain)
            .background(
              Circle()
                .fill(Color.blue.opacity(0.92))
            )
            .foregroundStyle(Color.white)
            .padding(8)
            .help("Add a new remote node")
          }
        }

        topologyLegend
        Text("Drag nodes to arrange map layout. Use Auto tidy to re-space crowded graphs. Positions are saved per controller profile.")
          .font(.mono(.caption2))
          .foregroundStyle(.tertiary)
        Text("Layout profile: \(controllerLayoutProfile)")
          .font(.mono(.caption2))
          .foregroundStyle(.tertiary)
          .textSelection(.enabled)

        if let selectedNode = selectedTopologyNode {
          topologyNodeDetails(selectedNode)
        } else {
          Text("Select a node in the graph to inspect endpoint, role, and runtime details.")
            .font(.mono(.caption2))
            .foregroundStyle(.tertiary)
        }
      }
    }
  }

  private var topologyExpandedSheet: some View {
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        Label("Hack topology map", systemImage: "network")
          .font(.mono(.subheadline, weight: .semibold))
        Spacer()
        if isControllerHost {
          Menu {
            Button("Add via Railway") {
              topologyExpanded = false
              openRailwaySettings()
            }
            Button("Open Tailscale") {
              topologyExpanded = false
              openTailscaleSettings()
            }
            Button("Open Extensions") {
              topologyExpanded = false
              openExtensionsSettings()
            }
          } label: {
            Label("Add node", systemImage: "plus.circle")
          }
          .adaptiveToolbarButton()
        }
        Button {
          autoTidyTopologyLayout()
        } label: {
          Label("Auto tidy", systemImage: "wand.and.stars")
        }
        .adaptiveToolbarButton()
        Button {
          resetTopologyLayout()
        } label: {
          Label("Reset layout", systemImage: "arrow.counterclockwise")
        }
        .adaptiveToolbarButton()
        Button("Done") {
          topologyExpanded = false
        }
        .adaptiveToolbarButtonProminent()
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)

      Divider()
        .opacity(0.2)

      VStack(alignment: .leading, spacing: 12) {
        TopologyGraphCanvas(
          nodes: topologyGraphNodes,
          edges: topologyGraphEdges,
          layoutOverrides: topologyLayoutOverrides,
          selectedNodeId: $selectedTopologyNodeId,
          minHeight: 520,
          onNodeMoved: handleTopologyNodeMoved,
          onSizeChanged: handleExpandedTopologyCanvasSizeChanged
        )

        topologyLegend
        Text("Layout profile: \(controllerLayoutProfile)")
          .font(.mono(.caption2))
          .foregroundStyle(.tertiary)
          .textSelection(.enabled)

        if let selectedNode = selectedTopologyNode {
          topologyNodeDetails(selectedNode)
        }
      }
      .padding(16)
    }
    .frame(minWidth: 980, minHeight: 760)
    .background(Color.black.opacity(0.04))
  }

  private var pairingRequestsCard: some View {
    GlassCard(title: "Pairing requests", systemImage: "person.badge.key.fill") {
      VStack(alignment: .leading, spacing: 10) {
        Text("Approve pending node pairing requests from this gateway host.")
          .font(.mono(.caption))
          .foregroundStyle(.secondary)

        HStack(spacing: 8) {
          Toggle("Set approved node as default node", isOn: $pairingDefault)
            .font(.mono(.caption))
          TextField("SSH port override (optional)", text: $pairingSshPortOverride)
            .textFieldStyle(.roundedBorder)
            .frame(maxWidth: 240)
          Button {
            Task { await refreshTopology(force: true) }
          } label: {
            Label("Refresh requests", systemImage: "arrow.clockwise")
          }
          .adaptiveToolbarButton()
          .disabled(isLoading)
          Spacer()
        }

        if !pairingSshPortOverride.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, parsedPairingSshPortOverride == nil {
          Text("SSH port override must be an integer in range 1-65535.")
            .font(.mono(.caption2))
            .foregroundStyle(.orange)
        }

        if pairingSessions.isEmpty {
          Text("No pending pairing requests.")
            .font(.mono(.caption2))
            .foregroundStyle(.tertiary)
        } else {
          LazyVStack(alignment: .leading, spacing: 10) {
            ForEach(pairingSessions, id: \.id) { session in
              pairingRequestRow(session: session)
              if session.id != pairingSessions.last?.id {
                Divider()
                  .opacity(0.2)
              }
            }
          }
        }
      }
    }
  }

  private func pairingRequestRow(session: NodePairingSession) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Text(session.source)
          .font(.mono(.subheadline, weight: .semibold))
        StatusPill(text: session.status.capitalized, tone: .warn)
        Spacer()
        Text("expires: \(session.expiresAt)")
          .font(.mono(.caption2))
          .foregroundStyle(.secondary)
          .textSelection(.enabled)
      }

      Text(session.endpoint)
        .font(.mono(.caption))
        .foregroundStyle(.secondary)
        .textSelection(.enabled)
      Text(session.id)
        .font(.mono(.caption2))
        .foregroundStyle(.tertiary)
        .textSelection(.enabled)

      TextField(
        "Enter one-time code from requester",
        text: Binding(
          get: { pairingCodeBySessionId[session.id] ?? "" },
          set: { pairingCodeBySessionId[session.id] = $0 }
        )
      )
      .textFieldStyle(.roundedBorder)

      HStack(spacing: 8) {
        Button {
          Task { await approvePairing(session: session) }
        } label: {
          Label("Approve + register", systemImage: "checkmark.seal")
        }
        .adaptiveToolbarButtonProminent()
        .disabled(!canApprovePairing(session: session))

        Button {
          Task { await cancelPairing(session: session) }
        } label: {
          Label("Reject", systemImage: "xmark.circle")
        }
        .adaptiveToolbarButton()
        .disabled(pairingBusySessionId != nil)

        if let oneLiner = buildFulfillOneLiner(session: session) {
          Button {
            TerminalIntegration.copyToClipboard(oneLiner)
          } label: {
            Label("Copy command", systemImage: "doc.on.doc")
          }
          .adaptiveToolbarButton()

          Button {
            TerminalIntegration.openExternalTerminalWithCommand(oneLiner, app: preferredTerminal)
          } label: {
            Label("Run in \(preferredTerminal.displayName)", systemImage: "terminal")
          }
          .adaptiveToolbarButton()
        }
        Spacer()
      }
    }
  }

  private var nodeModeGuidanceCard: some View {
    GlassCard(title: "Node mode workflow", systemImage: "server.rack") {
      VStack(alignment: .leading, spacing: 8) {
        Text("This machine is configured as a node-only runtime. Pairing approval happens on the controller host.")
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
        Text("1) Prepare gateway on this node: hack gateway setup")
          .font(.mono(.caption2))
          .textSelection(.enabled)
        Text("2) Open controller host Settings → Topology to review pending pairing requests.")
          .font(.mono(.caption2))
          .foregroundStyle(.secondary)
        Text("3) Fallback from controller CLI: hack node pair --source <user@host> --endpoint <url> --default")
          .font(.mono(.caption2))
          .textSelection(.enabled)
      }
    }
  }

  private var authorizedNodesCard: some View {
    GlassCard(title: "Authorized nodes", systemImage: "server.rack") {
      if !isControllerHost {
        Text("Controller host mode is disabled. Registry changes are hidden until host mode is re-enabled.")
          .font(.mono(.caption2))
          .foregroundStyle(.secondary)
      }

      if sortedNodes.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          Text("No nodes registered yet.")
            .font(.mono(.caption))
            .foregroundStyle(.secondary)
          if isControllerHost {
            Text("Pairing requests will appear above when sessions are pending.")
              .font(.mono(.caption2))
              .foregroundStyle(.tertiary)
          } else {
            Text("Enable host mode on the controller machine to pair and register new nodes.")
              .font(.mono(.caption2))
              .foregroundStyle(.tertiary)
          }
        }
      } else {
        LazyVStack(alignment: .leading, spacing: 10) {
          ForEach(sortedNodes) { node in
            nodeRow(node)
            if node.id != sortedNodes.last?.id {
              Divider()
                .opacity(0.2)
            }
          }
        }
      }
    }
  }

  private var trustModelCard: some View {
    GlassCard(title: "Pairing + trust model", systemImage: "key.fill") {
      VStack(alignment: .leading, spacing: 8) {
        Text("1) Request appears in controller pairing inbox with source + endpoint.")
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
        Text("2) Host enters one-time code and approves from request row.")
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
        Text("3) Node returns attested bundle; host completes registration and stores token in secret backend.")
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
        Text("4) Dispatch probes node via gateway bearer auth before remote execution.")
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
        Text("5) Tailscale is a transport boundary, not an implicit trust grant.")
          .font(.mono(.caption))
          .foregroundStyle(.secondary)

        Divider()
          .opacity(0.2)

        StatusPill(
          text: tailnetStatusLabel.text,
          tone: tailnetStatusLabel.tone
        )

        Text("Nodes are trusted only after explicit pairing/session verification and valid gateway token checks.")
          .font(.mono(.caption2))
          .foregroundStyle(.tertiary)
      }
    }
  }

  private var sortedNodes: [NodeRegistryRecord] {
    let nodes = registry?.nodes ?? []
    return nodes.sorted { left, right in
      let leftIsDefault = left.id == registry?.defaultNodeId
      let rightIsDefault = right.id == registry?.defaultNodeId
      if leftIsDefault != rightIsDefault {
        return leftIsDefault
      }
      return left.name.localizedCaseInsensitiveCompare(right.name) == .orderedAscending
    }
  }

  private var defaultNode: NodeRegistryRecord? {
    guard let defaultNodeId = registry?.defaultNodeId else {
      return nil
    }
    return sortedNodes.first(where: { $0.id == defaultNodeId })
  }

  private var endpointMatchesLocalDefault: Bool {
    guard let defaultNode else {
      return false
    }
    return endpointMatchesLocalDevice(defaultNode.endpoint)
  }

  private var tailnetStatusLabel: (text: String, tone: StatusTone) {
    guard let tailscale else {
      return ("Tailnet status unavailable", .neutral)
    }
    if tailscale.connected {
      return ("Tailnet connected", .good)
    }
    if let error = tailscale.error, !error.isEmpty {
      return ("Tailnet status unavailable", .neutral)
    }
    return ("Tailnet not connected", .warn)
  }

  private var topologyGraphNodes: [TopologyGraphNodeModel] {
    var nodes = [TopologyGraphNodeModel](
      [
        TopologyGraphNodeModel(
          id: Self.localTopologyNodeId,
          title: "This Mac",
          subtitle: localRoleLabel,
          role: isControllerHost ? "Controller host" : "Node runtime",
          endpoint: nil,
          statusText: isControllerHost ? "Host online" : "Node mode",
          statusTone: endpointMatchesLocalDefault ? .good : .neutral,
          connectionTypeText: "Local",
          labels: [],
          platform: "macOS",
          arch: nil,
          version: nil,
          lastSeenAt: nil,
          isLocal: true,
          isDefault: false
        ),
      ]
    )
    for node in sortedNodes {
      let probe = probeByNodeId[node.id]
      let type = connectionType(for: node.endpoint)
      let statusText: String
      let statusTone: StatusTone
      if let probe {
        statusText = probe.ok ? "Connected" : "Disconnected"
        statusTone = probe.ok ? .good : .warn
      } else {
        statusText = "Unknown"
        statusTone = .neutral
      }
      let role = node.id == registry?.defaultNodeId ? "Default execution node" : "Authorized node"
      nodes.append(
        TopologyGraphNodeModel(
          id: node.id,
          title: node.name,
          subtitle: node.endpoint,
          role: role,
          endpoint: node.endpoint,
          statusText: statusText,
          statusTone: statusTone,
          connectionTypeText: type.label,
          labels: node.labels,
          platform: node.platform,
          arch: node.arch,
          version: node.version,
          lastSeenAt: node.lastSeenAt,
          isLocal: false,
          isDefault: node.id == registry?.defaultNodeId
        )
      )
    }
    return nodes
  }

  private var topologyGraphEdges: [TopologyGraphEdgeModel] {
    var edges: [TopologyGraphEdgeModel] = []
    let remoteNodes = sortedNodes
    let nonDefaultNodes = remoteNodes.filter { $0.id != registry?.defaultNodeId }

    for node in remoteNodes {
      let isDefault = node.id == registry?.defaultNodeId
      let type = connectionType(for: node.endpoint)
      let isHealthy = probeByNodeId[node.id]?.ok ?? false
      let lane: Int
      let labelPosition: CGFloat
      if isDefault {
        lane = -1
        labelPosition = 0.34
      } else if let nonDefaultIndex = nonDefaultNodes.firstIndex(where: { $0.id == node.id }) {
        lane = alternatingLane(for: nonDefaultIndex, base: 3)
        labelPosition = lane > 0 ? 0.64 : 0.36
      } else {
        lane = 3
        labelPosition = 0.6
      }
      edges.append(
        TopologyGraphEdgeModel(
          id: "host-\(node.id)",
          sourceId: Self.localTopologyNodeId,
          targetId: node.id,
          label: edgeLabel(connectionType: type, isHealthy: isHealthy),
          tone: isHealthy ? .good : .warn,
          dashed: !isDefault,
          lane: lane,
          labelPosition: labelPosition
        )
      )
    }
    return edges
  }

  private func edgeLabel(connectionType: TopologyConnectionType, isHealthy: Bool) -> String {
    if isHealthy {
      return connectionType.label
    }
    return "\(connectionType.label) · degraded"
  }

  private func alternatingLane(for index: Int, base: Int) -> Int {
    let magnitude = base + (index / 2)
    return index.isMultiple(of: 2) ? magnitude : -magnitude
  }

  private var selectedTopologyNode: TopologyGraphNodeModel? {
    let fallback = topologyGraphNodes.first(where: { $0.id == Self.localTopologyNodeId })
    let selected = topologyGraphNodes.first(where: { $0.id == selectedTopologyNodeId })
    return selected ?? fallback
  }

  private var topologyLegend: some View {
    HStack(spacing: 12) {
      topologyLegendItem(color: .green, text: "Healthy")
      topologyLegendItem(color: .orange, text: "Degraded")
      topologyLegendItem(color: .blue, text: "Tailscale link")
      Spacer()
    }
  }

  private func topologyLegendItem(color: Color, text: String) -> some View {
    HStack(spacing: 6) {
      Circle()
        .fill(color)
        .frame(width: 7, height: 7)
      Text(text)
        .font(.mono(.caption2))
        .foregroundStyle(.secondary)
    }
  }

  private func topologyNodeDetails(_ node: TopologyGraphNodeModel) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Text(node.title)
          .font(.mono(.subheadline, weight: .semibold))
        StatusPill(text: node.statusText, tone: node.statusTone)
        if node.isDefault {
          StatusPill(text: "Default execution", tone: .good)
        }
        Spacer()
      }
      Text(node.role)
        .font(.mono(.caption))
        .foregroundStyle(.secondary)
      if let endpoint = node.endpoint {
        Text(endpoint)
          .font(.mono(.caption2))
          .foregroundStyle(.secondary)
          .textSelection(.enabled)
      }
      HStack(spacing: 8) {
        StatusPill(text: node.connectionTypeText, tone: connectionTone(for: node.connectionTypeText))
        if let platform = node.platform, !platform.isEmpty {
          StatusPill(text: platform, tone: .neutral)
        }
        if let arch = node.arch, !arch.isEmpty {
          StatusPill(text: arch, tone: .neutral)
        }
        if let version = node.version, !version.isEmpty {
          StatusPill(text: version, tone: .neutral)
        }
      }
      if !node.labels.isEmpty {
        Text("labels: \(node.labels.joined(separator: ", "))")
          .font(.mono(.caption2))
          .foregroundStyle(.tertiary)
      }
      if let seen = node.lastSeenAt, !seen.isEmpty {
        Text("last seen: \(seen)")
          .font(.mono(.caption2))
          .foregroundStyle(.tertiary)
      }
    }
    .padding(10)
    .background(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(Color.secondary.opacity(0.1))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .stroke(Color.secondary.opacity(0.2), lineWidth: 1)
    )
  }

  private var localRoleLabel: String {
    if !isControllerHost {
      return endpointMatchesLocalDefault ? "Node (default)" : "Node"
    }
    if sortedNodes.isEmpty {
      return "Host only"
    }
    if endpointMatchesLocalDefault {
      return "Host + Node"
    }
    return "Controller"
  }

  private var localRoleTone: StatusTone {
    if !isControllerHost {
      return endpointMatchesLocalDefault ? .good : .neutral
    }
    if sortedNodes.isEmpty {
      return .warn
    }
    return endpointMatchesLocalDefault ? .good : .neutral
  }

  private var parsedPairingSshPortOverride: Int? {
    let trimmed = pairingSshPortOverride.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, let value = Int(trimmed), (1...65_535).contains(value) else {
      return nil
    }
    return value
  }

  private var preferredTerminal: TerminalIntegration.ExternalTerminalApp {
    if let explicit = TerminalIntegration.ExternalTerminalApp(rawValue: preferredTerminalRaw) {
      return explicit
    }
    if let legacy = TerminalIntegration.ExternalTerminalApp(rawValue: legacyPreferredTerminalRaw) {
      return legacy
    }
    return .terminal
  }

  private func pairingCode(sessionId: String) -> String {
    (pairingCodeBySessionId[sessionId] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func canApprovePairing(session: NodePairingSession) -> Bool {
    let code = pairingCode(sessionId: session.id)
    if pairingBusySessionId != nil {
      return false
    }
    if code.isEmpty {
      return false
    }
    if !pairingSshPortOverride.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, parsedPairingSshPortOverride == nil {
      return false
    }
    return true
  }

  private func approvePairing(session: NodePairingSession) async {
    guard canApprovePairing(session: session) else {
      return
    }
    pairingBusySessionId = session.id
    defer { pairingBusySessionId = nil }

    let response = await model.fulfillNodePairSession(
      sessionId: session.id,
      code: pairingCode(sessionId: session.id),
      defaultNode: pairingDefault,
      sshPort: parsedPairingSshPortOverride
    )
    if response != nil {
      pairingCodeBySessionId[session.id] = nil
      await refreshTopology(force: true)
    }
  }

  private func cancelPairing(session: NodePairingSession) async {
    guard pairingBusySessionId == nil else {
      return
    }
    pairingBusySessionId = session.id
    defer { pairingBusySessionId = nil }
    let cancelled = await model.cancelNodePairSession(sessionId: session.id)
    if cancelled {
      pairingCodeBySessionId[session.id] = nil
      await refreshTopology(force: true)
    }
  }

  private func buildFulfillOneLiner(session: NodePairingSession) -> String? {
    let code = pairingCode(sessionId: session.id)
    guard !code.isEmpty else {
      return nil
    }
    let pairingName = derivePairingName(source: session.source)
    let remote = renderShellCommand(
      args: [
        "hack",
        "node",
        "pair",
        "approve",
        "--session",
        session.id,
        "--code",
        code,
        "--endpoint",
        session.endpoint,
        "--name",
        pairingName,
        "--json",
      ]
    )
    var completeArgs = [
      "hack",
      "node",
      "pair",
      "complete",
      "--session",
      session.id,
      "--bundle",
      "-",
    ]
    if pairingDefault {
      completeArgs.append("--default")
    }
    let complete = renderShellCommand(args: completeArgs)
    let sshPrefix =
      if let port = parsedPairingSshPortOverride {
        "ssh -p \(port)"
      } else {
        "ssh"
      }
    return "\(sshPrefix) \(session.source) \(remote) | \(complete)"
  }

  private func renderShellCommand(args: [String]) -> String {
    args.map(shellQuote).joined(separator: " ")
  }

  private func derivePairingName(source: String) -> String {
    let trimmed = source.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      return Host.current().localizedName ?? "node"
    }
    let hostPart = trimmed.split(separator: "@").last.map(String.init) ?? trimmed
    if let range = hostPart.range(of: ":", options: .backwards) {
      let withoutPort = String(hostPart[..<range.lowerBound])
      return withoutPort.isEmpty ? hostPart : withoutPort
    }
    return hostPart
  }

  /// Refresh node topology snapshots while throttling passive model-driven updates.
  private func refreshTopology(force: Bool = false) async {
    if Task.isCancelled {
      return
    }
    guard !isLoading else {
      return
    }
    if !force,
      let lastRefresh = lastTopologyRefreshAt
    {
      let elapsed = Date().timeIntervalSince(lastRefresh)
      if elapsed < topologyRefreshThrottleSeconds {
        return
      }
    }
    isLoading = true
    defer {
      isLoading = false
      lastTopologyRefreshAt = Date()
    }

    async let nodeList = model.listNodes()
    async let nodeStatus = model.probeNodes()
    async let tailscaleStatus = model.inspectTailscale()
    async let controllerSourceProject = model.getGlobalConfig(
      key: "controlPlane.gateway.sourceProjectId"
    )

    let list = await nodeList
    let status = await nodeStatus
    let tailscaleResult = await tailscaleStatus
    let controllerSourceProjectId = await controllerSourceProject
    if Task.isCancelled {
      return
    }
    let pendingSessions: [NodePairingSession]
    if isControllerHost {
      pendingSessions = await model.listNodePairSessions(status: "pending")
    } else {
      pendingSessions = []
    }
    if Task.isCancelled {
      return
    }

    let previousRegistry = registry
    var resolvedList = list
    if resolvedList == nil || resolvedList?.nodes.isEmpty == true {
      for attempt in 1...2 {
        try? await Task.sleep(nanoseconds: UInt64(200_000_000 * attempt))
        if Task.isCancelled {
          return
        }
        if let retry = await model.listNodes() {
          resolvedList = retry
          if !retry.nodes.isEmpty {
            break
          }
        }
      }
    }
    if let currentList = resolvedList,
       currentList.nodes.isEmpty,
       let previousRegistry,
       !previousRegistry.nodes.isEmpty {
      // Preserve known-good registry state when the latest probe is empty.
      // This avoids transient flicker to an empty topology canvas.
      resolvedList = previousRegistry
    }
    if Task.isCancelled {
      return
    }
    if let resolvedList {
      registry = resolvedList
    }
    var resolvedTailscale = tailscaleResult
    if resolvedTailscale == nil || resolvedTailscale?.error != nil {
      if let retry = await model.inspectTailscale() {
        resolvedTailscale = retry
      }
    } else if let currentTailscale = resolvedTailscale,
      tailscale?.connected == true,
      !currentTailscale.connected {
      if let retry = await model.inspectTailscale(), retry.connected {
        resolvedTailscale = retry
      }
    }
    let effectiveTailscale = resolvedTailscale ?? tailscale
    if let resolvedTailscale {
      if resolvedTailscale.error == nil || tailscale == nil {
        tailscale = resolvedTailscale
      }
    }
    let nextLayoutProfile = resolveControllerLayoutProfile(
      sourceProjectId: controllerSourceProjectId,
      tailscale: effectiveTailscale
    )
    if nextLayoutProfile != controllerLayoutProfile {
      controllerLayoutProfile = nextLayoutProfile
      topologyLayoutOverrides = loadTopologyLayoutOverrides(profile: nextLayoutProfile)
    }
    pairingSessions = pendingSessions
    pairingCodeBySessionId = pairingCodeBySessionId.filter { key, _ in
      pendingSessions.contains(where: { $0.id == key })
    }
    if let status {
      probeByNodeId = Dictionary(
        uniqueKeysWithValues: status.nodes.map { ($0.input.id, $0) }
      )
    }
    let knownNodeIds = Set((registry?.nodes ?? []).map(\.id))
    topologyLayoutOverrides = topologyLayoutOverrides.filter { key, _ in
      key == Self.localTopologyNodeId || knownNodeIds.contains(key)
    }
    persistTopologyLayoutOverridesIfNeeded()
    if selectedTopologyNodeId != Self.localTopologyNodeId, !knownNodeIds.contains(selectedTopologyNodeId) {
      selectedTopologyNodeId = Self.localTopologyNodeId
    }
  }

  private func queueTopologyRefresh(force: Bool) {
    topologyRefreshTask?.cancel()
    topologyRefreshTask = Task {
      await refreshTopology(force: force)
    }
  }

  private func nodeRow(_ node: NodeRegistryRecord) -> some View {
    HStack(alignment: .top, spacing: 10) {
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 8) {
          Text(node.name)
            .font(.mono(.subheadline, weight: .semibold))
          if node.id == registry?.defaultNodeId {
            StatusPill(text: "Default", tone: .good)
          }
          if let probe = probeByNodeId[node.id] {
            StatusPill(text: probe.ok ? "Connected" : "Disconnected", tone: probe.ok ? .good : .warn)
          } else {
            StatusPill(text: "Unknown", tone: .neutral)
          }
          StatusPill(text: "Authorized", tone: .neutral)
        }
        Text(node.endpoint)
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
          .textSelection(.enabled)
        Text(node.id)
          .font(.mono(.caption2))
          .foregroundStyle(.tertiary)
          .textSelection(.enabled)
        if !node.labels.isEmpty {
          Text("Labels: \(node.labels.joined(separator: ", "))")
            .font(.mono(.caption2))
            .foregroundStyle(.secondary)
        }
      }

      Spacer()

      if isControllerHost {
        VStack(alignment: .trailing, spacing: 6) {
          if node.id != registry?.defaultNodeId {
            Button {
              Task {
                beginNodeMutation(nodeId: node.id)
                defer { endNodeMutation(nodeId: node.id) }
                _ = await model.useNode(id: node.id)
                await refreshTopology(force: true)
              }
            } label: {
              Label("Set default", systemImage: "star")
            }
            .adaptiveToolbarButton()
            .disabled(isNodeMutationInFlight(nodeId: node.id))
          }

          Button(role: .destructive) {
            pendingRemoval = node
          } label: {
            Label("Remove", systemImage: "trash")
          }
          .adaptiveToolbarButton()
          .disabled(isNodeMutationInFlight(nodeId: node.id))
        }
      }
    }
  }

  private func endpointMatchesLocalDevice(_ endpoint: String) -> Bool {
    guard let url = URL(string: endpoint), let host = url.host?.lowercased() else {
      return false
    }
    if localEndpointHosts.contains(host) {
      return true
    }
    if let deviceIP = tailscale?.selfDevice?.tailscaleIp?.lowercased(), host == deviceIP {
      return true
    }
    if let dnsName = tailscale?.selfDevice?.dnsName?.lowercased(), host == dnsName {
      return true
    }
    return false
  }

  private var localEndpointHosts: Set<String> {
    var hosts: Set<String> = ["127.0.0.1", "localhost", "::1"]
    if let localName = Host.current().localizedName?.lowercased(), !localName.isEmpty {
      hosts.insert(localName)
      hosts.insert("\(localName).local")
    }
    return hosts
  }

  private func connectionType(for endpoint: String) -> TopologyConnectionType {
    guard
      let url = URL(string: endpoint),
      let scheme = url.scheme?.lowercased(),
      let rawHost = url.host?.lowercased()
    else {
      return .custom
    }
    let host = normalizedHost(rawHost)
    if localEndpointHosts.contains(host) {
      return .loopback
    }
    if knownTailnetHosts.contains(host) || host.hasSuffix(".ts.net") {
      return .tailscale
    }
    if scheme == "https" {
      return .https
    }
    if scheme == "http" {
      return .http
    }
    return .custom
  }

  private var knownTailnetHosts: Set<String> {
    var hosts: Set<String> = []
    if let selfDevice = tailscale?.selfDevice {
      if let ip = selfDevice.tailscaleIp {
        hosts.insert(normalizedHost(ip))
      }
      if let dnsName = selfDevice.dnsName {
        hosts.insert(normalizedHost(dnsName))
      }
    }
    for peer in tailscale?.peers ?? [] {
      if let ip = peer.tailscaleIp {
        hosts.insert(normalizedHost(ip))
      }
      if let dnsName = peer.dnsName {
        hosts.insert(normalizedHost(dnsName))
      }
    }
    return hosts
  }

  private func normalizedHost(_ host: String) -> String {
    var value = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    while value.hasSuffix(".") {
      value.removeLast()
    }
    return value
  }

  private func connectionTone(for connection: String) -> StatusTone {
    switch connection.lowercased() {
    case "tailscale", "loopback":
      return .good
    case "https", "http":
      return .neutral
    default:
      return .warn
    }
  }

  private func handleTopologyNodeMoved(nodeId: String, position: CGPoint, commit: Bool) {
    guard topologyGraphNodes.contains(where: { $0.id == nodeId }) else {
      return
    }
    topologyLayoutOverrides[nodeId] = position
    if commit {
      persistTopologyLayoutOverridesIfNeeded()
    }
  }

  private func handleCompactTopologyCanvasSizeChanged(_ size: CGSize) {
    if hasMeaningfulCanvasSizeChange(current: compactTopologyCanvasSize, next: size) {
      compactTopologyCanvasSize = size
    }
  }

  private func handleExpandedTopologyCanvasSizeChanged(_ size: CGSize) {
    if hasMeaningfulCanvasSizeChange(current: expandedTopologyCanvasSize, next: size) {
      expandedTopologyCanvasSize = size
    }
  }

  private func hasMeaningfulCanvasSizeChange(current: CGSize, next: CGSize) -> Bool {
    abs(current.width - next.width) > 1 || abs(current.height - next.height) > 1
  }

  private func autoTidyTopologyLayout() {
    let canvasSize =
      if topologyExpanded, expandedTopologyCanvasSize.width > 10, expandedTopologyCanvasSize.height > 10 {
        expandedTopologyCanvasSize
      } else if compactTopologyCanvasSize.width > 10, compactTopologyCanvasSize.height > 10 {
        compactTopologyCanvasSize
      } else {
        CGSize(
          width: topologyExpanded ? 980 : 860,
          height: topologyExpanded ? 520 : 300
        )
      }
    topologyLayoutOverrides = TopologyGraphLayout.autoTidyOverrides(
      nodes: topologyGraphNodes,
      size: canvasSize
    )
    persistTopologyLayoutOverridesIfNeeded()
  }

  private func resetTopologyLayout() {
    topologyLayoutOverrides = [:]
    persistTopologyLayoutOverridesIfNeeded()
  }

  private func resolveControllerLayoutProfile(
    sourceProjectId: String?,
    tailscale: TailscaleInspectResponse?
  ) -> String {
    let source = (sourceProjectId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if !source.isEmpty {
      return "source:\(source.lowercased())"
    }
    if let dnsName = tailscale?.selfDevice?.dnsName, !dnsName.isEmpty {
      return "tailnet:\(normalizedHost(dnsName))"
    }
    if let hostName = Host.current().localizedName?.trimmingCharacters(in: .whitespacesAndNewlines),
      !hostName.isEmpty
    {
      return "local:\(hostName.lowercased())"
    }
    return "local:default"
  }

  private func loadTopologyLayoutOverrides(profile: String) -> [String: CGPoint] {
    let store = decodeTopologyLayoutStore(raw: topologyLayoutByControllerRaw)
    let entries = store.profiles[profile] ?? [:]
    var points: [String: CGPoint] = [:]
    for (nodeId, point) in entries {
      points[nodeId] = CGPoint(x: point.x, y: point.y)
    }
    return points
  }

  private func persistTopologyLayoutOverridesIfNeeded() {
    guard !controllerLayoutProfile.isEmpty else {
      return
    }
    var store = decodeTopologyLayoutStore(raw: topologyLayoutByControllerRaw)
    let encodedPoints = topologyLayoutOverrides.reduce(into: [String: TopologyLayoutPoint]()) {
      partialResult,
      entry in
      partialResult[entry.key] = TopologyLayoutPoint(
        x: entry.value.x,
        y: entry.value.y
      )
    }
    if encodedPoints.isEmpty {
      store.profiles.removeValue(forKey: controllerLayoutProfile)
    } else {
      store.profiles[controllerLayoutProfile] = encodedPoints
    }

    if let encoded = encodeTopologyLayoutStore(store), encoded != topologyLayoutByControllerRaw {
      topologyLayoutByControllerRaw = encoded
    }
  }

  private func decodeTopologyLayoutStore(raw: String) -> TopologyLayoutStore {
    guard !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      let data = raw.data(using: .utf8),
      let decoded = try? JSONDecoder().decode(TopologyLayoutStore.self, from: data)
    else {
      return TopologyLayoutStore(version: 1, profiles: [:])
    }
    return decoded
  }

  private func encodeTopologyLayoutStore(_ store: TopologyLayoutStore) -> String? {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    guard let data = try? encoder.encode(store) else {
      return nil
    }
    return String(data: data, encoding: .utf8)
  }

  private func shellQuote(_ value: String) -> String {
    let escaped = value.replacingOccurrences(of: "'", with: "'\"'\"'")
    return "'\(escaped)'"
  }

  private func openRailwaySettings() {
    NotificationCenter.default.post(
      name: .hackSettingsRequested,
      object: nil,
      userInfo: [SettingsNavigationRequest.paneKey: SettingsSidebarItem.railway.rawValue]
    )
  }

  private func openTailscaleSettings() {
    NotificationCenter.default.post(
      name: .hackSettingsRequested,
      object: nil,
      userInfo: [SettingsNavigationRequest.paneKey: SettingsSidebarItem.tailscale.rawValue]
    )
  }

  private func openExtensionsSettings() {
    NotificationCenter.default.post(
      name: .hackSettingsRequested,
      object: nil,
      userInfo: [SettingsNavigationRequest.paneKey: SettingsSidebarItem.extensions.rawValue]
    )
  }

  /// Track a single row-level mutation to avoid duplicate remove/use actions.
  private func beginNodeMutation(nodeId: String) {
    nodeMutationInFlight = nodeId
  }

  private func endNodeMutation(nodeId: String) {
    if nodeMutationInFlight == nodeId {
      nodeMutationInFlight = nil
    }
  }

  private func isNodeMutationInFlight(nodeId: String) -> Bool {
    nodeMutationInFlight == nodeId
  }

  /// Optimistically remove a node from local state so stale rows disappear instantly.
  private func removeNodeFromLocalState(nodeId: String) {
    guard let current = registry else {
      return
    }
    let nextNodes = current.nodes.filter { $0.id != nodeId }
    let nextDefault = current.defaultNodeId == nodeId ? nil : current.defaultNodeId
    registry = NodeRegistryListResponse(defaultNodeId: nextDefault, nodes: nextNodes)
    probeByNodeId[nodeId] = nil
    if selectedTopologyNodeId == nodeId {
      selectedTopologyNodeId = Self.localTopologyNodeId
    }
  }
}

private enum TopologyConnectionType {
  case loopback
  case tailscale
  case https
  case http
  case custom

  var label: String {
    switch self {
    case .loopback:
      return "Loopback"
    case .tailscale:
      return "Tailscale"
    case .https:
      return "HTTPS"
    case .http:
      return "HTTP"
    case .custom:
      return "Custom"
    }
  }
}

private struct TopologyGraphNodeModel: Identifiable {
  let id: String
  let title: String
  let subtitle: String
  let role: String
  let endpoint: String?
  let statusText: String
  let statusTone: StatusTone
  let connectionTypeText: String
  let labels: [String]
  let platform: String?
  let arch: String?
  let version: String?
  let lastSeenAt: String?
  let isLocal: Bool
  let isDefault: Bool
}

private struct TopologyGraphEdgeModel: Identifiable {
  let id: String
  let sourceId: String
  let targetId: String
  let label: String
  let tone: StatusTone
  let dashed: Bool
  let lane: Int
  let labelPosition: CGFloat
}

private struct TopologyLayoutStore: Codable {
  let version: Int
  var profiles: [String: [String: TopologyLayoutPoint]]
}

private struct TopologyLayoutPoint: Codable {
  let x: CGFloat
  let y: CGFloat
}

private struct TopologyGraphCanvas: View {
  let nodes: [TopologyGraphNodeModel]
  let edges: [TopologyGraphEdgeModel]
  let layoutOverrides: [String: CGPoint]
  @Binding var selectedNodeId: String
  @State private var dragStartPositions: [String: CGPoint] = [:]
  @State private var draggingNodeId: String? = nil
  @State private var dragLivePositions: [String: CGPoint] = [:]
  let minHeight: CGFloat
  let onNodeMoved: (_ nodeId: String, _ position: CGPoint, _ commit: Bool) -> Void
  let onSizeChanged: (_ size: CGSize) -> Void

  var body: some View {
    GeometryReader { geometry in
      let effectiveOverrides = layoutOverrides.merging(dragLivePositions) { _, live in
        live
      }
      let layout = TopologyGraphLayout.compute(
        nodes: nodes,
        size: geometry.size,
        layoutOverrides: effectiveOverrides
      )

      ZStack {
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .fill(Color.secondary.opacity(0.06))
          .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
              .stroke(Color.secondary.opacity(0.15), lineWidth: 1)
          )

        ForEach(edges) { edge in
          if let source = layout.positions[edge.sourceId], let target = layout.positions[edge.targetId] {
            TopologyGraphEdgeView(from: source, to: target, edge: edge)
              .allowsHitTesting(false)
          }
        }

        ForEach(nodes) { node in
          if let position = layout.positions[node.id] {
            topologyNodeInteraction(
              node: node,
              position: position,
              canvasSize: geometry.size
            )
          }
        }
      }
      .onAppear {
        onSizeChanged(geometry.size)
      }
      .onChange(of: geometry.size) { _, size in
        onSizeChanged(size)
      }
    }
    .frame(minHeight: minHeight)
  }

  private func clampPosition(_ point: CGPoint, canvasSize: CGSize) -> CGPoint {
    let minX: CGFloat = 112
    let maxX = max(minX, canvasSize.width - 112)
    let minY: CGFloat = 58
    let maxY = max(minY, canvasSize.height - 58)
    return CGPoint(
      x: min(max(point.x, minX), maxX),
      y: min(max(point.y, minY), maxY)
    )
  }

  /**
   Renders a selectable/draggable node with explicit hit testing.
   This keeps every bubble interactive even when graph chrome or overlapping
   nodes are present.
   */
  @ViewBuilder
  private func topologyNodeInteraction(
    node: TopologyGraphNodeModel,
    position: CGPoint,
    canvasSize: CGSize
  ) -> some View {
    ZStack {
      TopologyGraphNodeBubble(node: node, isSelected: selectedNodeId == node.id)
        .allowsHitTesting(false)

      Rectangle()
        .fill(Color.clear)
        .contentShape(Rectangle())
        .onTapGesture {
          selectedNodeId = node.id
        }
        .highPriorityGesture(
          DragGesture(minimumDistance: 2)
            .onChanged { value in
              if selectedNodeId != node.id {
                selectedNodeId = node.id
              }
              if draggingNodeId != node.id {
                draggingNodeId = node.id
              }
              let dragStart = dragStartPositions[node.id] ?? position
              if dragStartPositions[node.id] == nil {
                dragStartPositions[node.id] = position
              }
              let next = CGPoint(
                x: dragStart.x + value.translation.width,
                y: dragStart.y + value.translation.height
              )
              let clamped = clampPosition(next, canvasSize: canvasSize)
              setDragLivePosition(nodeId: node.id, position: clamped)
            }
            .onEnded { value in
              let dragStart = dragStartPositions[node.id] ?? position
              let next = CGPoint(
                x: dragStart.x + value.translation.width,
                y: dragStart.y + value.translation.height
              )
              let clamped = dragLivePositions[node.id]
                ?? clampPosition(next, canvasSize: canvasSize)
              onNodeMoved(
                node.id,
                clamped,
                true
              )
              dragStartPositions[node.id] = nil
              draggingNodeId = nil
              dragLivePositions.removeValue(forKey: node.id)
            }
        )
    }
    .frame(width: 208, height: 98, alignment: .center)
    .position(position)
    .allowsHitTesting(true)
    .zIndex(nodeZIndex(nodeId: node.id))
  }

  /**
   Applies transient drag positions without animation to avoid visual stutter.
   */
  private func setDragLivePosition(nodeId: String, position: CGPoint) {
    if let current = dragLivePositions[nodeId],
      abs(current.x - position.x) < 0.25,
      abs(current.y - position.y) < 0.25
    {
      return
    }
    var transaction = Transaction()
    transaction.disablesAnimations = true
    withTransaction(transaction) {
      dragLivePositions[nodeId] = position
    }
  }

  private func nodeZIndex(nodeId: String) -> Double {
    if draggingNodeId == nodeId {
      return 4
    }
    if selectedNodeId == nodeId {
      return 3
    }
    return 2
  }
}

private struct TopologyGraphLayout {
  private static let bubbleWidth: CGFloat = 190
  private static let bubbleHeight: CGFloat = 76
  private static let horizontalSpacing: CGFloat = 48
  private static let verticalSpacing: CGFloat = 34

  let positions: [String: CGPoint]

  static func compute(
    nodes: [TopologyGraphNodeModel],
    size: CGSize,
    layoutOverrides: [String: CGPoint]
  ) -> TopologyGraphLayout {
    guard size.width > 10, size.height > 10 else {
      return TopologyGraphLayout(positions: [:])
    }

    var positions: [String: CGPoint] = [:]
    let remoteNodes = nodes.filter { !$0.isLocal }
    if let localNode = nodes.first(where: \.isLocal) {
      positions[localNode.id] = CGPoint(
        x: max(115, size.width * 0.18),
        y: size.height * 0.5
      )
    }

    guard !remoteNodes.isEmpty else {
      return TopologyGraphLayout(positions: positions)
    }

    let anchorNode = remoteNodes.first(where: \.isDefault) ?? remoteNodes[0]
    positions[anchorNode.id] = CGPoint(
      x: max(260, size.width * 0.46),
      y: max(92, size.height * 0.35)
    )

    let secondaryNodes = remoteNodes.filter { $0.id != anchorNode.id }
    guard !secondaryNodes.isEmpty else {
      return TopologyGraphLayout(positions: positions)
    }

    let center = CGPoint(x: size.width * 0.76, y: size.height * 0.54)
    let radiusX = max(120, min(size.width * 0.2, 260))
    let radiusY = max(95, min(size.height * 0.25, 185))
    let angleStep = (2 * Double.pi) / Double(max(secondaryNodes.count, 1))
    let baseAngle = -Double.pi / 2

    for (index, node) in secondaryNodes.enumerated() {
      let angle = baseAngle + (Double(index) * angleStep)
      let rawX = center.x + (cos(angle) * radiusX)
      let rawY = center.y + (sin(angle) * radiusY)
      let clampedX = min(max(rawX, 120), size.width - 120)
      let clampedY = min(max(rawY, 64), size.height - 64)
      positions[node.id] = CGPoint(x: clampedX, y: clampedY)
    }

    for (nodeId, overridePoint) in layoutOverrides where positions[nodeId] != nil {
      positions[nodeId] = CGPoint(
        x: min(max(overridePoint.x, 112), max(112, size.width - 112)),
        y: min(max(overridePoint.y, 58), max(58, size.height - 58))
      )
    }

    return TopologyGraphLayout(positions: positions)
  }

  /**
   Produces a deterministic, non-overlapping override map for crowded graphs.
   Layout keeps the local/controller node on the left, default node near center-left,
   and packs secondary nodes into a right-side grid.
   */
  static func autoTidyOverrides(
    nodes: [TopologyGraphNodeModel],
    size: CGSize
  ) -> [String: CGPoint] {
    guard size.width > 10, size.height > 10 else {
      return [:]
    }

    var positions = TopologyGraphLayout.compute(
      nodes: nodes,
      size: size,
      layoutOverrides: [:]
    ).positions
    let remoteNodes = nodes.filter { !$0.isLocal }
    guard !remoteNodes.isEmpty else {
      return positions
    }

    let anchorNode = remoteNodes.first(where: \.isDefault) ?? remoteNodes[0]
    positions[anchorNode.id] = CGPoint(
      x: clampX(value: max(260, size.width * 0.43), size: size),
      y: clampY(value: max(92, size.height * 0.34), size: size)
    )

    let secondaries = remoteNodes.filter { $0.id != anchorNode.id }
    if secondaries.isEmpty {
      return positions
    }

    let rowPitch = bubbleHeight + verticalSpacing
    let columnPitch = bubbleWidth + horizontalSpacing
    let usableTop: CGFloat = 78
    let usableBottom = max(usableTop + bubbleHeight, size.height - 78)
    let usableHeight = max(bubbleHeight, usableBottom - usableTop)
    let maxRows = max(1, Int(floor(usableHeight / rowPitch)))
    let columns = Int(ceil(Double(secondaries.count) / Double(maxRows)))
    let rightLimit = max(120, size.width - 120)
    let startX = max(340, rightLimit - (CGFloat(max(columns - 1, 0)) * columnPitch))

    let rowsUsed = min(maxRows, secondaries.count)
    let gridHeight = CGFloat(max(rowsUsed - 1, 0)) * rowPitch
    let centeredTop = max(usableTop, (size.height - gridHeight) / 2)

    for (index, node) in secondaries.enumerated() {
      let row = index % maxRows
      let column = index / maxRows
      let rawX = startX + (CGFloat(column) * columnPitch)
      let rawY = centeredTop + (CGFloat(row) * rowPitch)
      positions[node.id] = CGPoint(
        x: clampX(value: rawX, size: size),
        y: clampY(value: rawY, size: size)
      )
    }

    return positions
  }

  private static func clampX(value: CGFloat, size: CGSize) -> CGFloat {
    min(max(value, 112), max(112, size.width - 112))
  }

  private static func clampY(value: CGFloat, size: CGSize) -> CGFloat {
    min(max(value, 58), max(58, size.height - 58))
  }
}

private struct TopologyGraphEdgeView: View {
  let from: CGPoint
  let to: CGPoint
  let edge: TopologyGraphEdgeModel

  var body: some View {
    let metrics = edgeMetrics(from: from, to: to)
    ZStack {
      Path { path in
        path.move(to: metrics.start)
        path.addQuadCurve(to: metrics.end, control: metrics.control)
      }
      .stroke(
        toneColor(edge.tone).opacity(edge.dashed ? 0.65 : 0.88),
        style: StrokeStyle(lineWidth: 1.8, lineCap: .round, dash: edge.dashed ? [8, 6] : [])
      )

      Path { path in
        path.move(to: metrics.end)
        path.addLine(to: metrics.arrowLeft)
        path.move(to: metrics.end)
        path.addLine(to: metrics.arrowRight)
      }
      .stroke(
        toneColor(edge.tone).opacity(0.88),
        style: StrokeStyle(lineWidth: 1.6, lineCap: .round)
      )

      Text(edge.label)
        .font(.mono(.caption2))
        .lineLimit(1)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(
          Capsule(style: .continuous)
            .fill(Color.black.opacity(0.42))
        )
        .overlay(
          Capsule(style: .continuous)
            .stroke(toneColor(edge.tone).opacity(0.25), lineWidth: 1)
        )
        .position(metrics.labelPoint)
    }
  }

  private func edgeMetrics(from: CGPoint, to: CGPoint) -> (
    start: CGPoint,
    control: CGPoint,
    end: CGPoint,
    labelPoint: CGPoint,
    arrowLeft: CGPoint,
    arrowRight: CGPoint
  ) {
    let dx = to.x - from.x
    let dy = to.y - from.y
    let length = max(sqrt((dx * dx) + (dy * dy)), 1)
    let ux = dx / length
    let uy = dy / length
    let nx = -uy
    let ny = ux

    let startOffset: CGFloat = 72
    let endOffset: CGFloat = 80
    let start = CGPoint(x: from.x + (ux * startOffset), y: from.y + (uy * startOffset * 0.55))
    let end = CGPoint(x: to.x - (ux * endOffset), y: to.y - (uy * endOffset * 0.55))
    let midpoint = CGPoint(x: (start.x + end.x) / 2, y: (start.y + end.y) / 2)
    let curveOffset = CGFloat(edge.lane) * 20
    let control = CGPoint(
      x: midpoint.x + (nx * curveOffset),
      y: midpoint.y + (ny * curveOffset)
    )

    let clampedT = min(max(edge.labelPosition, 0.18), 0.82)
    let curvePoint = quadraticPoint(start: start, control: control, end: end, t: clampedT)
    let labelDrift = max(14, abs(CGFloat(edge.lane)) * 5)
    let labelPoint = CGPoint(
      x: curvePoint.x + (nx * labelDrift),
      y: curvePoint.y + (ny * labelDrift)
    )

    let arrowT: CGFloat = 0.94
    let arrowBase = quadraticPoint(start: start, control: control, end: end, t: arrowT)
    let arrowNext = quadraticPoint(start: start, control: control, end: end, t: min(arrowT + 0.01, 1))
    let arrowVectorX = arrowNext.x - arrowBase.x
    let arrowVectorY = arrowNext.y - arrowBase.y
    let arrowLengthNorm = max(sqrt((arrowVectorX * arrowVectorX) + (arrowVectorY * arrowVectorY)), 1)
    let auX = arrowVectorX / arrowLengthNorm
    let auY = arrowVectorY / arrowLengthNorm
    let anX = -auY
    let anY = auX

    let arrowLength: CGFloat = 9
    let arrowWidth: CGFloat = 5
    let left = CGPoint(
      x: end.x - (auX * arrowLength) + (anX * arrowWidth),
      y: end.y - (auY * arrowLength) + (anY * arrowWidth)
    )
    let right = CGPoint(
      x: end.x - (auX * arrowLength) - (anX * arrowWidth),
      y: end.y - (auY * arrowLength) - (anY * arrowWidth)
    )
    return (start, control, end, labelPoint, left, right)
  }

  private func quadraticPoint(start: CGPoint, control: CGPoint, end: CGPoint, t: CGFloat) -> CGPoint {
    let oneMinusT = 1 - t
    let x = (oneMinusT * oneMinusT * start.x) + (2 * oneMinusT * t * control.x) + (t * t * end.x)
    let y = (oneMinusT * oneMinusT * start.y) + (2 * oneMinusT * t * control.y) + (t * t * end.y)
    return CGPoint(x: x, y: y)
  }
}

private struct TopologyGraphNodeBubble: View {
  let node: TopologyGraphNodeModel
  let isSelected: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack(spacing: 6) {
        Circle()
          .fill(toneColor(node.statusTone))
          .frame(width: 7, height: 7)
        Text(node.title)
          .font(.mono(.caption, weight: .semibold))
          .lineLimit(1)
        Spacer(minLength: 0)
        if node.isDefault {
          Image(systemName: "scope")
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(Color.green)
        }
      }

      Text(node.subtitle)
        .font(.mono(.caption2))
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .truncationMode(.middle)

      Text(node.role)
        .font(.mono(.caption2))
        .foregroundStyle(.tertiary)
        .lineLimit(1)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 9)
    .frame(width: 190, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(nodeFillColor)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .stroke(isSelected ? Color.blue.opacity(0.9) : Color.secondary.opacity(0.28), lineWidth: isSelected ? 2 : 1)
    )
    .shadow(color: Color.black.opacity(isSelected ? 0.25 : 0.12), radius: isSelected ? 8 : 3, y: isSelected ? 4 : 2)
  }

  private var nodeFillColor: Color {
    if node.isLocal {
      return Color.blue.opacity(0.13)
    }
    if node.isDefault {
      return Color.green.opacity(0.13)
    }
    return Color.secondary.opacity(0.1)
  }
}

private func toneColor(_ tone: StatusTone) -> Color {
  switch tone {
  case .good:
    return .green
  case .warn:
    return .orange
  case .neutral:
    return .secondary
  }
}
