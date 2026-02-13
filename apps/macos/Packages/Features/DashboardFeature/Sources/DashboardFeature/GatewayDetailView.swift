import SwiftUI

import HackDesktopModels

struct GatewayDetailView: View {
  @Environment(DashboardModel.self) private var model
  @Environment(\.openURL) private var openURL
  @AppStorage("hackDesktop.setupGuidance.gateway.dismissed") private var setupDismissed = false
  @State private var showSetupAssistant = false
  @State private var gatewayTokens: [GatewayTokenRecord] = []
  @State private var isLoadingTokens = false
  @State private var latestIssuedToken: String? = nil
  @State private var issuingTokenScope: GatewayTokenScope = .read
  @State private var newTokenLabel = ""

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          header
          if shouldShowSetupGuidance {
            setupNudge
          }
          overviewCard
          exposuresCard
          tokensCard
          warningsCard
        }
        .padding(16)
      }
      .navigationDestination(for: GatewayExposure.self) { exposure in
        GatewayExposureDetailView(exposure: exposure)
      }
      .sheet(isPresented: $showSetupAssistant) {
        SetupAssistantView(initialSection: .gateway)
          .environment(model)
      }
      .task {
        await refreshGatewayTokens()
      }
      .onChange(of: model.lastUpdated) { _, _ in
        Task {
          await refreshGatewayTokens()
        }
      }
    }
  }

  private var shouldShowSetupGuidance: Bool {
    if ProcessInfo.processInfo.environment["HACK_DESKTOP_FORCE_SETUP_GUIDANCE"] == "1" { return true }
    if setupDismissed { return false }

    // If gateway/global status isn't available yet (fresh machine), show quick-start guidance here too.
    if model.globalStatus == nil { return true }
    if model.gatewaySummaryState == nil { return true }
    return false
  }

  private var setupNudge: some View {
    SetupNudgeCard(
      title: "Gateway setup",
      subtitle: "On a fresh machine, install global services and run the gateway setup once.",
      primaryActionLabel: "Setup…",
      onPrimaryAction: { showSetupAssistant = true },
      onDismiss: { setupDismissed = true }
    )
    .opacity(setupDismissed ? 0 : 1)
    .animation(.easeInOut(duration: 0.15), value: setupDismissed)
    .allowsHitTesting(!setupDismissed)
  }

  private var header: some View {
    SectionHeader(
      breadcrumb: "System / Gateway",
      title: "Gateway",
      subtitle: "Remote gateway configuration and exposures",
      status: { StatusPill(text: gatewayStatusText, tone: gatewayStatusTone) },
      actions: {
        Menu {
          Button("Refresh") {
            Task { await model.refresh() }
          }
          Button("Setup…") {
            showSetupAssistant = true
          }
          if let configUrl {
            Button("Open Config") {
              openURL(configUrl)
            }
          }
        } label: {
          Image(systemName: "ellipsis.circle")
        }
        .buttonStyle(.plain)
      }
    )
  }

  private var overviewCard: some View {
    GlassCard(title: "Overview", systemImage: "network") {
      DetailRows(rows: overviewRows)
    }
  }

  private var exposuresCard: some View {
    GlassCard(title: "Exposures", systemImage: "point.3.filled.connected.trianglepath.dotted") {
      lanCalloutSection
      if exposures.isEmpty {
        Text("No gateway exposures configured")
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
      } else {
        VStack(alignment: .leading, spacing: 12) {
          ForEach(Array(exposures.enumerated()), id: \.element.id) { index, exposure in
            if let destination = settingsItem(for: exposure) {
              Button {
                openSettings(destination)
              } label: {
                exposureRow(exposure: exposure, showChevron: true)
              }
              .buttonStyle(.plain)
            } else {
              NavigationLink(value: exposure) {
                exposureRow(exposure: exposure, showChevron: true)
              }
              .buttonStyle(.plain)
            }
            if index < exposures.count - 1 {
              Divider()
            }
          }
        }
      }
    }
  }

  @ViewBuilder
  private var lanCalloutSection: some View {
    if let lan = exposures.first(where: { $0.id == "lan" }),
       lan.resolvedState == .blocked,
       (lan.detail ?? "").lowercased().contains("loopback") {
      InlineCallout(
        tone: .neutral,
        title: "LAN access is local-only (127.0.0.1)",
        message: "This is the default. The gateway is reachable from this machine only. If you want other devices on your LAN to reach it, bind to 0.0.0.0 and restart hackd.",
        actions: [
          InlineCalloutAction(label: "Copy command", systemImage: "doc.on.doc") {
            TerminalIntegration.copyToClipboard("""
            hack config set --global controlPlane.gateway.bind 0.0.0.0
            hack daemon restart
            """)
          },
          InlineCalloutAction(label: "Enable LAN access", systemImage: "terminal") {
            TerminalIntegration.openTerminalWithCommand("""
            hack config set --global controlPlane.gateway.bind 0.0.0.0
            hack daemon restart
            """)
          }
        ]
      )
      Divider()
        .opacity(0.35)
    }
  }

  private var tokensCard: some View {
    GlassCard(title: "Tokens", systemImage: "key") {
      VStack(alignment: .leading, spacing: 12) {
        if let latestIssuedToken {
          InlineCallout(
            tone: .good,
            title: "New token issued",
            message: "Store this token now. It will not be shown again.",
            actions: [
              InlineCalloutAction(label: "Copy token", systemImage: "doc.on.doc") {
                TerminalIntegration.copyToClipboard(latestIssuedToken)
              }
            ]
          )
        }

        HStack(spacing: 10) {
          Picker("Scope", selection: $issuingTokenScope) {
            Text("Read").tag(GatewayTokenScope.read)
            Text("Write").tag(GatewayTokenScope.write)
          }
          .pickerStyle(.segmented)
          .frame(width: 180)

          TextField("Optional label", text: $newTokenLabel)
            .textFieldStyle(.roundedBorder)
            .font(.mono(.caption))

          Button {
            Task { await createGatewayToken() }
          } label: {
            Label("Create token", systemImage: "plus")
          }
          .adaptiveToolbarButtonProminent()

          Button {
            Task { await refreshGatewayTokens() }
          } label: {
            Label("Reload", systemImage: "arrow.clockwise")
          }
          .adaptiveToolbarButton()

          Spacer()
        }

        if isLoadingTokens {
          HStack(spacing: 8) {
            ProgressView()
              .controlSize(.small)
            Text("Loading tokens…")
              .font(.mono(.caption))
              .foregroundStyle(.secondary)
          }
        }

        tokenSummaryRow

        if sortedTokens.isEmpty {
          Text("No tokens found.")
            .font(.mono(.caption))
            .foregroundStyle(.secondary)
        } else {
          tokenTableHeader
          ForEach(sortedTokens) { token in
            tokenTableRow(token)
            Divider()
              .opacity(0.18)
          }
        }
      }
    }
  }

  private var warningsCard: some View {
    let warnings = gatewayWarnings
    return Group {
      if warnings.isEmpty {
        EmptyView()
      } else {
        GlassCard(title: "Warnings", systemImage: "exclamationmark.triangle") {
          VStack(alignment: .leading, spacing: 4) {
            ForEach(warnings, id: \.self) { warning in
              Text("• \(warning)")
                .font(.mono(.caption))
                .foregroundStyle(.secondary)
            }
          }
        }
      }
    }
  }

  private var gateway: GatewayStatus? {
    model.globalStatus?.gateway
  }

  private var exposures: [GatewayExposure] {
    model.gatewayExposures
  }

  private var gatewaySummaryState: GatewaySummaryState? {
    model.gatewaySummaryState
  }

  private var gatewayStatusText: String {
    gatewaySummaryState?.label ?? "Unknown"
  }

  private var gatewayStatusTone: StatusTone {
    gatewaySummaryState?.tone ?? .neutral
  }

  private var overviewRows: [DetailRowItem] {
    let configured = gateway?.gatewayEnabled ?? model.globalStatus?.summary.gatewayEnabled
    return [
      DetailRowItem(label: "Status", value: gatewaySummaryState?.label ?? "—"),
      DetailRowItem(label: "Configured", value: yesNo(configured)),
      DetailRowItem(label: "Gateway URL", value: gateway?.gatewayUrl ?? "—"),
      DetailRowItem(label: "Bind", value: gateway?.gatewayBind ?? "—"),
      DetailRowItem(label: "Port", value: gateway?.gatewayPort.map(String.init) ?? "—"),
      DetailRowItem(label: "Allow writes", value: yesNo(gateway?.allowWrites)),
      DetailRowItem(label: "Projects enabled", value: gateway?.gatewayProjectsEnabled.map(String.init) ?? "—"),
      DetailRowItem(label: "Projects", value: gateway?.gatewayProjects ?? "—"),
      DetailRowItem(label: "Config path", value: gateway?.configPath ?? "—")
    ]
  }

  private var sortedTokens: [GatewayTokenRecord] {
    gatewayTokens.sorted { lhs, rhs in
      if lhs.revokedAt == nil, rhs.revokedAt != nil {
        return true
      }
      if lhs.revokedAt != nil, rhs.revokedAt == nil {
        return false
      }
      return lhs.createdAt > rhs.createdAt
    }
  }

  private var gatewayWarnings: [String] {
    gateway?.warnings ?? []
  }

  private var configUrl: URL? {
    guard let path = gateway?.configPath, !path.isEmpty else { return nil }
    return URL(fileURLWithPath: path)
  }

  private func yesNo(_ value: Bool?) -> String {
    guard let value else { return "—" }
    return value ? "Yes" : "No"
  }

  private func exposureIcon(_ exposure: GatewayExposure) -> String {
    switch exposure.id {
    case "lan":
      return "wifi"
    case "tailscale":
      return "link"
    case "cloudflare":
      return "cloud"
    default:
      return "network"
    }
  }

  private func exposureRow(exposure: GatewayExposure, showChevron: Bool) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 8) {
        Label(exposure.label, systemImage: exposureIcon(exposure))
          .font(.mono(.subheadline, weight: .medium))
        Spacer()
        if let dependencyLabel = exposure.dependencyStatusLabel,
           let dependencyColor = exposure.dependencyStatusColor {
          BadgePill(label: dependencyLabel, tint: dependencyColor)
        }
        StatusPill(text: exposure.statusLabel, tone: exposure.statusTone)
        if showChevron {
          Image(systemName: "chevron.right")
            .font(.mono(.caption))
            .foregroundStyle(.tertiary)
        }
      }
      if let detail = exposure.detail, !detail.isEmpty {
        Text(detail)
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
      }
      if let url = exposure.url, !url.isEmpty {
        Text(url)
          .font(.mono(.caption2))
          .foregroundStyle(.secondary)
      }
    }
    .padding(.vertical, 4)
  }

  @ViewBuilder
  private var tokenSummaryRow: some View {
    HStack(spacing: 8) {
      tokenSummaryBadge(label: "Active", value: gateway?.tokensActive ?? activeTokenCount)
      tokenSummaryBadge(label: "Read", value: gateway?.tokensRead ?? readTokenCount)
      tokenSummaryBadge(label: "Write", value: gateway?.tokensWrite ?? writeTokenCount)
      tokenSummaryBadge(label: "Revoked", value: gateway?.tokensRevoked ?? revokedTokenCount)
      Spacer()
    }
  }

  private var tokenTableHeader: some View {
    HStack(spacing: 10) {
      Text("ID")
        .frame(minWidth: 160, alignment: .leading)
      Text("Scope")
        .frame(width: 54, alignment: .leading)
      Text("Label")
        .frame(minWidth: 120, alignment: .leading)
      Text("Created")
        .frame(width: 160, alignment: .leading)
      Text("Last used")
        .frame(width: 120, alignment: .leading)
      Text("State")
        .frame(width: 76, alignment: .leading)
      Spacer(minLength: 0)
      Text("Actions")
        .frame(width: 128, alignment: .trailing)
    }
    .font(.mono(.caption2, weight: .semibold))
    .foregroundStyle(.secondary)
  }

  private func tokenTableRow(_ token: GatewayTokenRecord) -> some View {
    HStack(spacing: 10) {
      Text(token.id)
        .font(.mono(.caption2))
        .lineLimit(1)
        .truncationMode(.middle)
        .frame(minWidth: 160, alignment: .leading)
      Text(token.scope.rawValue)
        .font(.mono(.caption2))
        .frame(width: 54, alignment: .leading)
      Text(token.label ?? "—")
        .font(.mono(.caption2))
        .lineLimit(1)
        .truncationMode(.tail)
        .frame(minWidth: 120, alignment: .leading)
      Text(formatTimestamp(token.createdAt))
        .font(.mono(.caption2))
        .frame(width: 160, alignment: .leading)
      Text(formatRelativeTimestamp(token.lastUsedAt))
        .font(.mono(.caption2))
        .frame(width: 120, alignment: .leading)
      Text(token.revokedAt == nil ? "Active" : "Revoked")
        .font(.mono(.caption2))
        .foregroundStyle(token.revokedAt == nil ? Color.green : Color.orange)
        .frame(width: 76, alignment: .leading)
      Spacer(minLength: 0)
      HStack(spacing: 8) {
        Button("Copy ID") {
          TerminalIntegration.copyToClipboard(token.id)
        }
        .adaptiveToolbarButton()
        if token.revokedAt == nil {
          Button("Revoke") {
            Task { await revokeToken(token) }
          }
          .adaptiveToolbarButton()
        }
      }
      .frame(width: 128, alignment: .trailing)
    }
  }

  private func tokenSummaryBadge(label: String, value: Int) -> some View {
    HStack(spacing: 6) {
      Text(label)
        .font(.mono(.caption2))
      Text(String(value))
        .font(.mono(.caption2, weight: .semibold))
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 5)
    .background(
      Capsule(style: .continuous)
        .fill(.thinMaterial)
    )
    .overlay(
      Capsule(style: .continuous)
        .stroke(Color.primary.opacity(0.14), lineWidth: 1)
    )
  }

  private var activeTokenCount: Int {
    gatewayTokens.filter { $0.revokedAt == nil }.count
  }

  private var revokedTokenCount: Int {
    gatewayTokens.filter { $0.revokedAt != nil }.count
  }

  private var readTokenCount: Int {
    gatewayTokens.filter { $0.revokedAt == nil && $0.scope == .read }.count
  }

  private var writeTokenCount: Int {
    gatewayTokens.filter { $0.revokedAt == nil && $0.scope == .write }.count
  }

  private func refreshGatewayTokens() async {
    isLoadingTokens = true
    defer { isLoadingTokens = false }
    gatewayTokens = await model.fetchGatewayTokens()
  }

  private func createGatewayToken() async {
    let trimmedLabel = newTokenLabel.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let issued = await model.createGatewayToken(
      scope: issuingTokenScope,
      label: trimmedLabel.isEmpty ? nil : trimmedLabel
    ) else {
      return
    }
    newTokenLabel = ""
    latestIssuedToken = issued.token
    await refreshGatewayTokens()
  }

  private func revokeToken(_ token: GatewayTokenRecord) async {
    let revoked = await model.revokeGatewayToken(id: token.id)
    guard revoked else { return }
    await refreshGatewayTokens()
  }

  private func formatTimestamp(_ value: String?) -> String {
    guard let value, let date = ISO8601DateFormatter().date(from: value) else {
      return value ?? "—"
    }
    let formatter = DateFormatter()
    formatter.dateStyle = .medium
    formatter.timeStyle = .short
    return formatter.string(from: date)
  }

  private func formatRelativeTimestamp(_ value: String?) -> String {
    guard let value, let date = ISO8601DateFormatter().date(from: value) else {
      return "—"
    }
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .short
    return formatter.localizedString(for: date, relativeTo: Date())
  }

  private func settingsItem(for exposure: GatewayExposure) -> SettingsSidebarItem? {
    switch exposure.id {
    case "cloudflare":
      return .cloudflare
    case "tailscale":
      return .tailscale
    default:
      return nil
    }
  }

  private func openSettings(_ item: SettingsSidebarItem) {
    NotificationCenter.default.post(
      name: .hackSettingsRequested,
      object: nil,
      userInfo: [SettingsNavigationRequest.paneKey: item.rawValue]
    )
  }
}

#if DEBUG
import HackCLIService

#Preview("Gateway (Setup Guidance)") {
  let model = DashboardModel(client: HackCLIClient())
  return GatewayDetailView()
    .environment(model)
}
#endif
