import AppKit
import Darwin
import SwiftUI

import GhosttyTerminal
import HackCLIService
import HackDesktopModels

enum SettingsSidebarItem: String, Hashable, Identifiable {
  case account
  case preferences
  case updates
  case topology
  case runtime
  case gateway
  case global
  case supervisor
  case permissions
  case linear
  case github
  case cloudflare
  case railway
  case tailscale
  case certificates
  case logging

  var id: String { rawValue }

  var title: String {
    switch self {
    case .account:
      return "Account"
    case .preferences:
      return "Preferences"
    case .updates:
      return "Updates"
    case .topology:
      return "Topology"
    case .runtime:
      return "Runtime"
    case .gateway:
      return "Gateway"
    case .global:
      return "Global"
    case .supervisor:
      return "Supervisor"
    case .permissions:
      return "Permissions"
    case .linear:
      return "Linear"
    case .github:
      return "GitHub"
    case .cloudflare:
      return "Cloudflare"
    case .railway:
      return "Railway"
    case .tailscale:
      return "Tailscale"
    case .certificates:
      return "Certificates"
    case .logging:
      return "Logging"
    }
  }

  var icon: String {
    switch self {
    case .account:
      return "person.crop.circle"
    case .preferences:
      return "slider.horizontal.3"
    case .updates:
      return "arrow.triangle.2.circlepath"
    case .topology:
      return "point.3.connected.trianglepath.dotted"
    case .runtime:
      return "gauge.with.dots.needle.50percent"
    case .gateway:
      return "dot.radiowaves.left.and.right"
    case .global:
      return "slider.horizontal.3"
    case .supervisor:
      return "cpu"
    case .permissions:
      return "hand.raised.fill"
    case .linear:
      return "line.3.horizontal.decrease.circle"
    case .github:
      return "chevron.left.forwardslash.chevron.right"
    case .cloudflare:
      return "cloud"
    case .railway:
      return "tram.fill.tunnel"
    case .tailscale:
      return "network"
    case .certificates:
      return "checkmark.shield"
    case .logging:
      return "text.alignleft"
    }
  }
}

extension Notification.Name {
  public static let hackSettingsRequested = Notification.Name("hack.settings.requested")
  public static let hackCheckForUpdatesRequested = Notification.Name("hack.checkForUpdates.requested")
}

enum SettingsNavigationRequest {
  static let paneKey = "pane"
}

struct SettingsOverlayView: View {
  @Environment(DashboardModel.self) private var model
  @Environment(\.colorScheme) private var colorScheme
  @Binding var selection: SettingsSidebarItem
  let onClose: () -> Void

  var body: some View {
    VStack(spacing: 0) {
      topBar
      Divider()
        .opacity(0.2)
      HStack(spacing: 0) {
        settingsSidebar
        Divider()
          .opacity(0.2)
        settingsDetail
      }
    }
    .background(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .fill(overlayBaseFillColor)
        .overlay(
          RoundedRectangle(cornerRadius: 18, style: .continuous)
            .fill(.regularMaterial)
            .opacity(colorScheme == .dark ? 0.58 : 0.72)
        )
    )
    .overlay(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .stroke(overlayStrokeColor, lineWidth: 1)
    )
    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    .shadow(color: .black.opacity(colorScheme == .dark ? 0.4 : 0.08), radius: 20, y: 10)
    .padding(12)
    .onExitCommand {
      onClose()
    }
    .task {
      await model.refreshHackAccountState(force: false, updateErrorMessage: false)
    }
  }

  private var topBar: some View {
    HStack(spacing: 10) {
      Label("Settings", systemImage: "gearshape")
        .font(.mono(.subheadline, weight: .semibold))
      Spacer()
      Button {
        onClose()
      } label: {
        Image(systemName: "xmark")
          .font(.system(size: 12, weight: .semibold))
          .frame(width: 24, height: 24)
      }
      .buttonStyle(PressableCircleButtonStyle())
      .help("Close settings")
      .accessibilityLabel("Close settings")
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .background(
      Rectangle()
        .fill(.ultraThinMaterial)
        .overlay(
          Rectangle()
            .fill(topBarTintColor)
        )
    )
  }

  private var settingsSidebar: some View {
    List(selection: $selection) {
      Section("Account") {
        settingsRow(.account)
      }
      Section("Preferences") {
        settingsRow(.preferences)
        settingsRow(.updates)
      }
      Section("System") {
        settingsRow(.topology)
        settingsRow(.runtime)
        settingsRow(.gateway)
      }
      Section("Control Plane") {
        settingsRow(.global)
        settingsRow(.supervisor)
        settingsRow(.permissions)
        settingsRow(.logging)
        settingsRow(.certificates)
      }
      Section("Integrations") {
        settingsRow(.linear)
        settingsRow(.github)
        settingsRow(.cloudflare)
        settingsRow(.railway)
        settingsRow(.tailscale)
      }
    }
    .listStyle(.sidebar)
    .scrollContentBackground(.hidden)
    .background(
      Rectangle()
        .fill(sidebarFillColor)
        .overlay(
          Rectangle()
            .fill(.thinMaterial)
            .opacity(colorScheme == .dark ? 0.38 : 0.56)
        )
    )
    .frame(minWidth: 230, idealWidth: 250, maxWidth: 280)
  }

  private var settingsDetail: some View {
    Group {
      switch selection {
      case .account:
        AccountSettingsView()
      case .preferences:
        PreferencesSettingsView()
      case .updates:
        UpdatesSettingsView()
      case .topology:
        NodeTopologySettingsView()
      case .runtime:
        RuntimeDetailView()
      case .gateway:
        GatewayDetailView()
      case .global:
        GlobalSettingsView()
      case .supervisor:
        SupervisorSettingsView()
      case .permissions:
        PermissionsSettingsView()
      case .linear:
        LinearExtensionSettingsView()
      case .github:
        GitHubExtensionSettingsView()
      case .cloudflare:
        CloudflareExtensionSettingsView()
      case .railway:
        RailwayExtensionSettingsView()
      case .tailscale:
        TailscaleExtensionSettingsView()
      case .certificates:
        CertificatesSettingsView()
      case .logging:
        LoggingSettingsView()
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background(
      Rectangle()
        .fill(detailFillColor)
        .overlay(
          Rectangle()
            .fill(detailTintColor)
        )
    )
  }

  private func settingsRow(_ item: SettingsSidebarItem) -> some View {
    Label(item.title, systemImage: item.icon)
      .tag(item)
      .font(.mono(.subheadline))
  }

  private var overlayBaseFillColor: Color {
    colorScheme == .dark ? Color.black.opacity(0.72) : Color.white.opacity(0.86)
  }

  private var overlayStrokeColor: Color {
    colorScheme == .dark ? Color.white.opacity(0.16) : Color.white.opacity(0.72)
  }

  private var topBarTintColor: Color {
    colorScheme == .dark ? Color.white.opacity(0.03) : Color.white.opacity(0.18)
  }

  private var sidebarFillColor: Color {
    colorScheme == .dark ? Color.black.opacity(0.46) : Color.white.opacity(0.82)
  }

  private var detailFillColor: Color {
    colorScheme == .dark ? Color.black.opacity(0.34) : Color.white.opacity(0.74)
  }

  private var detailTintColor: Color {
    colorScheme == .dark ? Color.white.opacity(0.03) : Color.white.opacity(0.28)
  }
}

private struct UpdatesSettingsView: View {
  @AppStorage("SUEnableAutomaticChecks") private var automaticallyCheckForUpdates = true
  @AppStorage("hackDesktop.update.available") private var updateAvailable = false
  @AppStorage("hackDesktop.update.latestVersion") private var latestKnownReleaseVersion = ""
  @AppStorage("hackDesktop.update.lastCheckedAt") private var updateLastCheckedAt = ""

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        SettingsSectionHeader(
          breadcrumb: "Settings / Updates",
          title: "Updates",
          subtitle: "View app version details and manage software update checks"
        )

        GlassCard(title: "Current build", systemImage: "shippingbox") {
          VStack(alignment: .leading, spacing: 10) {
            metadataRow(title: "Version", value: appVersion)
            metadataRow(title: "Build", value: appBuild)
            metadataRow(title: "Status", value: updateAvailable ? "Update available" : "Up to date")
            if !latestKnownReleaseVersion.isEmpty {
              metadataRow(title: "Latest release", value: latestKnownReleaseVersion)
            }
            if !updateLastCheckedAt.isEmpty {
              metadataRow(title: "Last checked", value: formattedTimestamp(updateLastCheckedAt))
            }
            metadataRow(title: "Bundle ID", value: bundleIdentifier)
            if let appcast = appcastURL {
              metadataRow(title: "Appcast", value: appcast)
            }
          }
        }

        GlassCard(title: "Update behavior", systemImage: "arrow.clockwise.circle") {
          VStack(alignment: .leading, spacing: 12) {
            Toggle("Automatically check for updates", isOn: $automaticallyCheckForUpdates)
              .font(.mono(.subheadline))

            Text("Automatic checks apply to signed release builds that include Sparkle.")
              .font(.mono(.caption2))
              .foregroundStyle(.tertiary)

            HStack(spacing: 10) {
              Button {
                NotificationCenter.default.post(name: .hackCheckForUpdatesRequested, object: nil)
              } label: {
                Label("Check for updates now", systemImage: "arrow.triangle.2.circlepath")
              }
              .adaptiveToolbarButtonProminent()

              if let appcast = appcastURL, let url = URL(string: appcast) {
                Button {
                  NSWorkspace.shared.open(url)
                } label: {
                  Label("Open appcast", systemImage: "link")
                }
                .adaptiveToolbarButton()
              }

              Spacer()
            }
          }
        }
      }
      .padding(16)
    }
  }

  private var appVersion: String {
    Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
      ?? "Unknown"
  }

  private var appBuild: String {
    Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "Unknown"
  }

  private var bundleIdentifier: String {
    Bundle.main.bundleIdentifier ?? "Unknown"
  }

  private var appcastURL: String? {
    Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String
  }

  private func metadataRow(title: String, value: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title)
        .font(.mono(.caption))
        .foregroundStyle(.secondary)
      Text(value)
        .font(.mono(.caption, weight: .semibold))
        .textSelection(.enabled)
    }
  }

  private func formattedTimestamp(_ value: String) -> String {
    let formatter = ISO8601DateFormatter()
    guard let date = formatter.date(from: value) else {
      return value
    }
    return date.formatted(date: .abbreviated, time: .shortened)
  }
}

struct SettingsSectionHeader: View {
  let breadcrumb: String
  let title: String
  let subtitle: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(breadcrumb)
        .font(.mono(.caption2))
        .foregroundStyle(.secondary)
      Text(title)
        .font(.mono(.headline, weight: .semibold))
      if let subtitle, !subtitle.isEmpty {
        Text(subtitle)
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
      }
    }
  }
}

private struct AccountSettingsView: View {
  @Environment(DashboardModel.self) private var model

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        SettingsSectionHeader(
          breadcrumb: "Settings / Account",
          title: "Hack account",
          subtitle: nil
        )
        HackAccountSettingsCard(
          state: model.hackAccountState,
          isLoading: model.isLoadingHackAccountState
        )
      }
      .padding(24)
    }
  }
}

private struct HackAccountSettingsCard: View {
  @Environment(DashboardModel.self) private var model
  let state: HackAccountSettingsState?
  let isLoading: Bool
  @State private var isSubmitting = false

  var body: some View {
    GlassCard(title: "Status", systemImage: "person.crop.circle.badge.checkmark") {
      HStack(alignment: .center, spacing: 8) {
        StatusPill(text: primaryStatusText, tone: primaryStatusTone)
        Spacer()
        if let manageURL = resolvedManageURL, state?.authenticated == true {
          Button("Manage account") {
            openResolvedManageURL(manageURL)
          }
          .adaptiveToolbarButton()
        }
        if let state, state.authenticated {
          Button("Sign out") {
            Task { await handleSignOut() }
          }
          .adaptiveToolbarButton()
          .disabled(isBusy)
        } else {
          Button("Sign in to Hack") {
            Task { await handleSignIn() }
          }
          .adaptiveToolbarButtonProminent()
          .disabled(isBusy || state?.authEnabled == false)
        }
        if isBusy {
          ProgressView()
            .controlSize(.small)
        }
      }

      Text(summaryMessage)
        .font(.mono(.caption))
        .foregroundStyle(.secondary)

      if let state, state.authenticated {
        detailRow(title: "Hack user", value: state.userDisplayName ?? "Authenticated session")
        if let email = state.userEmail, !email.isEmpty {
          detailRow(title: "Email", value: email, selectable: true)
        }
        if let organizationName = state.organizationName, !organizationName.isEmpty {
          detailRow(title: "Organization", value: organizationName)
        }
        if let teamName = state.teamName, !teamName.isEmpty {
          detailRow(title: "Team", value: teamName)
        }
      } else if let sessionHint {
        Text(sessionHint)
          .font(.mono(.caption2))
          .foregroundStyle(.tertiary)
      }
    }
  }

  private var primaryStatusText: String {
    guard let state else {
      return "Status unavailable"
    }
    if !state.authEnabled {
      return "Unavailable"
    }
    if state.authenticated {
      return "Signed in"
    }
    if state.tokenStored && !state.validated {
      return "Session stale"
    }
    return "Sign in required"
  }

  private var primaryStatusTone: StatusTone {
    guard let state else {
      return .warn
    }
    if !state.authEnabled {
      return .warn
    }
    if state.authenticated {
      return .good
    }
    if state.tokenStored && !state.validated {
      return .warn
    }
    return .neutral
  }

  private var summaryMessage: String {
    if let state, state.authenticated {
      return "Shared provider connections and broker-backed features use this Hack account."
    }
    return "Sign in to use shared provider connections and other broker-backed features."
  }

  private var isBusy: Bool {
    isLoading || isSubmitting
  }

  private var resolvedManageURL: String? {
    guard let state, state.authenticated else {
      return nil
    }
    return state.accountURL ?? state.shellURL
  }

  private var sessionHint: String? {
    guard let state else {
      return "Hack Desktop has not loaded account state yet."
    }
    if state.tokenStored && !state.validated {
      return "A stored session could not be validated. Sign in again to refresh it."
    }
    if !state.authEnabled {
      return "Hack auth is not available on the broker yet, so shared remote features are unavailable from this Mac."
    }
    return "Local-only workflows still work without signing in."
  }

  private func handleSignIn() async {
    isSubmitting = true
    defer { isSubmitting = false }
    _ = await model.loginHackAccount()
  }

  private func handleSignOut() async {
    isSubmitting = true
    defer { isSubmitting = false }
    _ = await model.logoutHackAccount()
  }

  private func openResolvedManageURL(_ urlString: String) {
    guard let url = URL(string: urlString) else {
      return
    }
    NSWorkspace.shared.open(url)
  }

  private func detailRow(title: String, value: String, selectable: Bool = false) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title)
        .font(.mono(.caption))
        .foregroundStyle(.secondary)
      if selectable {
        Text(value)
          .font(.mono(.caption, weight: .semibold))
          .foregroundStyle(.primary)
          .textSelection(.enabled)
      } else {
        Text(value)
          .font(.mono(.caption, weight: .semibold))
          .foregroundStyle(.primary)
      }
    }
  }
}

private enum AppearanceThemeOption: String, CaseIterable, Identifiable {
  case system
  case light
  case dark

  var id: String { rawValue }

  var label: String {
    switch self {
    case .system:
      return "System"
    case .light:
      return "Light"
    case .dark:
      return "Dark"
    }
  }
}

private enum SessionProviderOption: String, CaseIterable, Identifiable {
  case tmux
  case zellij

  var id: String { rawValue }

  var label: String {
    rawValue.uppercased()
  }

  var executableCandidates: [String] {
    switch self {
    case .tmux:
      return ["tmux"]
    case .zellij:
      return ["zellij"]
    }
  }
}

private enum ContainerRuntimeOption: String, CaseIterable, Identifiable {
  case docker
  case orbstack
  case dockerDesktop = "docker-desktop"
  case colima
  case rancherDesktop = "rancher-desktop"
  case podman

  var id: String { rawValue }

  var label: String {
    switch self {
    case .docker:
      return "Docker CLI"
    case .orbstack:
      return "OrbStack"
    case .dockerDesktop:
      return "Docker Desktop"
    case .colima:
      return "Colima"
    case .rancherDesktop:
      return "Rancher Desktop"
    case .podman:
      return "Podman"
    }
  }

  var executableCandidates: [String] {
    switch self {
    case .docker, .orbstack, .dockerDesktop, .rancherDesktop:
      return ["docker"]
    case .colima:
      return ["colima"]
    case .podman:
      return ["podman"]
    }
  }

  var appBundleIdentifiers: [String] {
    switch self {
    case .orbstack:
      return ["dev.kdrag0n.OrbStack"]
    case .dockerDesktop:
      return ["com.docker.docker"]
    case .rancherDesktop:
      return ["io.rancherdesktop.app"]
    case .docker, .colima, .podman:
      return []
    }
  }

  var appFallbackPaths: [String] {
    switch self {
    case .orbstack:
      return ["/Applications/OrbStack.app"]
    case .dockerDesktop:
      return ["/Applications/Docker.app"]
    case .rancherDesktop:
      return ["/Applications/Rancher Desktop.app"]
    case .docker, .colima, .podman:
      return []
    }
  }
}

private struct PreferencesSettingsView: View {
  @Environment(DashboardModel.self) private var model

  @AppStorage("hackDesktop.preferences.theme") private var appearanceThemeRaw = AppearanceThemeOption.system.rawValue
  @AppStorage("hackDesktop.preferences.defaultTerminal") private var preferredTerminalRaw = TerminalIntegration.ExternalTerminalApp.terminal.rawValue
  @AppStorage("hackDesktop.sessions.preferredExternalTerminal") private var legacyPreferredTerminalRaw = TerminalIntegration.ExternalTerminalApp.terminal.rawValue
  @AppStorage("hackDesktop.preferences.defaultIDE") private var preferredEditorRaw = EditorIntegration.EditorApp.cursor.rawValue
  @AppStorage("hackDesktop.preferences.defaultCodingAgent") private var preferredCodingAgentRaw = CodingAgentIntegration.AgentApp.codex.rawValue
  @AppStorage("hackDesktop.preferences.defaultCodingAgentBinaryPath") private var preferredCodingAgentBinaryPathRaw = ""

  @State private var isLoadingConfig = false
  @State private var sessionProvider: SessionProviderOption = .tmux
  @State private var sessionBinaryPath = ""
  @State private var containerRuntime: ContainerRuntimeOption = .docker
  @State private var containerBinaryPath = ""
  @State private var codingAgentBinaryPath = ""

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        SettingsSectionHeader(
          breadcrumb: "Settings / Preferences",
          title: "Preferences",
          subtitle: "UI defaults for theme, terminal, editor, sessions, containers, and coding agents"
        )

        GlassCard(title: "Defaults", systemImage: "slider.horizontal.3") {
          VStack(alignment: .leading, spacing: 12) {
            preferencePicker(
              title: "Appearance",
              helper: "Choose whether the desktop UI follows system, light, or dark mode.",
              selectionLabel: appearanceTheme.label
            ) {
              Picker("Appearance", selection: $appearanceThemeRaw) {
                ForEach(AppearanceThemeOption.allCases) { option in
                  Text(option.label).tag(option.rawValue)
                }
              }
              .pickerStyle(.segmented)
            }

            preferencePicker(
              title: "Preferred terminal",
              helper: "Used for Open In terminal actions and session attach flows.",
              selectionLabel: preferredTerminal.displayName
            ) {
              Picker("Preferred terminal", selection: $preferredTerminalRaw) {
                ForEach(terminalOptions, id: \.rawValue) { app in
                  Text(app.displayName).tag(app.rawValue)
                }
              }
              .pickerStyle(.menu)
            }

            preferencePicker(
              title: "Preferred IDE",
              helper: "Used by Project header Open In actions.",
              selectionLabel: preferredEditor.displayName
            ) {
              Picker("Preferred IDE", selection: $preferredEditorRaw) {
                ForEach(editorOptions, id: \.rawValue) { app in
                  Text(app.displayName).tag(app.rawValue)
                }
              }
              .pickerStyle(.menu)
            }
          }
        }

        GlassCard(title: "Session multiplexer", systemImage: "rectangle.3.group.bubble.left") {
          VStack(alignment: .leading, spacing: 12) {
            preferencePicker(
              title: "Provider",
              helper: "Default backend when creating or attaching session workflows.",
              selectionLabel: sessionProvider.label
            ) {
              Picker("Session provider", selection: $sessionProvider) {
                ForEach(SessionProviderOption.allCases) { option in
                  Text(option.label).tag(option)
                }
              }
              .pickerStyle(.segmented)
            }
            pathEditor(
              title: "Binary path override",
              helper: "Leave empty to auto-detect from PATH.",
              text: $sessionBinaryPath,
              detectedPath: detectedSessionBinaryPath
            )
          }
        }

        GlassCard(title: "Container runtime", systemImage: "shippingbox") {
          VStack(alignment: .leading, spacing: 12) {
            preferencePicker(
              title: "Provider",
              helper: "Controls how the app and future CLI tooling interpret your container stack defaults.",
              selectionLabel: containerRuntime.label
            ) {
              Picker("Container runtime", selection: $containerRuntime) {
                ForEach(ContainerRuntimeOption.allCases) { option in
                  Text(option.label).tag(option)
                }
              }
              .pickerStyle(.menu)
            }
            pathEditor(
              title: "Binary path override",
              helper: "Leave empty to auto-detect from PATH.",
              text: $containerBinaryPath,
              detectedPath: detectedContainerBinaryPath
            )
            if let appPath = detectedContainerAppPath {
              Text("Detected app: \(appPath)")
                .font(.mono(.caption2))
                .foregroundStyle(.tertiary)
                .textSelection(.enabled)
            }
          }
        }

        GlassCard(title: "Coding agent", systemImage: "sparkles") {
          VStack(alignment: .leading, spacing: 12) {
            preferencePicker(
              title: "Default coding agent",
              helper: "Used when opening agent-assisted workflows from Desktop and future CLI integrations.",
              selectionLabel: preferredCodingAgent.displayName
            ) {
              Picker("Default coding agent", selection: $preferredCodingAgentRaw) {
                ForEach(codingAgentOptions) { option in
                  Text(option.displayName).tag(option.rawValue)
                }
              }
              .pickerStyle(.menu)
            }
            pathEditor(
              title: "Binary path override",
              helper: "Leave empty to auto-detect from PATH for the selected coding agent.",
              text: $codingAgentBinaryPath,
              detectedPath: detectedCodingAgentBinaryPath
            )
          }
        }

        HStack(spacing: 10) {
          Button {
            Task { await savePreferences() }
          } label: {
            Label("Save preferences", systemImage: "checkmark")
          }
          .adaptiveToolbarButtonProminent()

          Button {
            Task { await loadConfigFromDisk() }
          } label: {
            Label("Reload", systemImage: "arrow.clockwise")
          }
          .adaptiveToolbarButton()

          if isLoadingConfig {
            ProgressView()
              .controlSize(.small)
          }
          Spacer()
        }

        InlineCallout(
          tone: .neutral,
          title: "Preference scope",
          message: "These defaults are saved in global config and in desktop app storage so project actions and future CLI/runtime integrations can share a single preference source.",
          actions: []
        )
      }
      .padding(16)
    }
    .task {
      await loadConfigFromDisk()
    }
    .onChange(of: model.lastUpdated) { _, _ in
      Task { await loadConfigFromDisk() }
    }
  }

  private var appearanceTheme: AppearanceThemeOption {
    AppearanceThemeOption(rawValue: appearanceThemeRaw) ?? .system
  }

  private var preferredTerminal: TerminalIntegration.ExternalTerminalApp {
    if let explicit = TerminalIntegration.ExternalTerminalApp(rawValue: preferredTerminalRaw) {
      return explicit
    }
    return .terminal
  }

  private var preferredEditor: EditorIntegration.EditorApp {
    if let explicit = EditorIntegration.EditorApp(rawValue: preferredEditorRaw) {
      return explicit
    }
    return .cursor
  }

  private var preferredCodingAgent: CodingAgentIntegration.AgentApp {
    if let explicit = CodingAgentIntegration.AgentApp(rawValue: preferredCodingAgentRaw) {
      return explicit
    }
    return .codex
  }

  private var terminalOptions: [TerminalIntegration.ExternalTerminalApp] {
    let installed = TerminalIntegration.installedExternalTerminalApps()
    let fallback = [TerminalIntegration.ExternalTerminalApp.terminal]
    return dedupePreservingOrder([preferredTerminal] + installed + fallback)
  }

  private var editorOptions: [EditorIntegration.EditorApp] {
    let installed = EditorIntegration.installedEditors()
    let fallback = [EditorIntegration.EditorApp.cursor, .vscode, .zed, .neovim, .vim]
    return dedupePreservingOrder([preferredEditor] + installed + fallback)
  }

  private var codingAgentOptions: [CodingAgentIntegration.AgentApp] {
    let installed = CodingAgentIntegration.installedAgents()
    return dedupePreservingOrder(
      [preferredCodingAgent] + installed + CodingAgentIntegration.AgentApp.allCases
    )
  }

  private var detectedSessionBinaryPath: String? {
    if let manual = normalizedPath(sessionBinaryPath) {
      return manual
    }
    return resolveExecutablePath(candidates: sessionProvider.executableCandidates)
  }

  private var detectedContainerBinaryPath: String? {
    if let manual = normalizedPath(containerBinaryPath) {
      return manual
    }
    return resolveExecutablePath(candidates: containerRuntime.executableCandidates)
  }

  private var detectedContainerAppPath: String? {
    resolveInstalledApplicationPath(
      bundleIdentifiers: containerRuntime.appBundleIdentifiers,
      fallbackPaths: containerRuntime.appFallbackPaths
    )
  }

  private var detectedCodingAgentBinaryPath: String? {
    CodingAgentIntegration.resolvedBinaryPath(
      for: preferredCodingAgent,
      overridePath: normalizedPath(codingAgentBinaryPath)
    )
  }

  private func loadConfigFromDisk() async {
    isLoadingConfig = true
    defer { isLoadingConfig = false }

    let snapshot = GlobalConfigSnapshot.load()
    if let theme = snapshot.preferencesTheme, !theme.isEmpty {
      appearanceThemeRaw = theme
    }
    if let terminalApp = snapshot.preferencesTerminalApp, !terminalApp.isEmpty {
      preferredTerminalRaw = terminalApp
      legacyPreferredTerminalRaw = terminalApp
    } else {
      legacyPreferredTerminalRaw = preferredTerminalRaw
    }
    if let editorApp = snapshot.preferencesEditorApp, !editorApp.isEmpty {
      preferredEditorRaw = editorApp
    }
    if let codingAgentApp = snapshot.preferencesCodingAgentApp, !codingAgentApp.isEmpty {
      preferredCodingAgentRaw = codingAgentApp
    }
    if let providerRaw = snapshot.preferencesSessionProvider, let provider = SessionProviderOption(rawValue: providerRaw) {
      sessionProvider = provider
    }
    if let binary = snapshot.preferencesSessionBinaryPath {
      sessionBinaryPath = binary
    }
    if let containerRaw = snapshot.preferencesContainerProvider, let provider = ContainerRuntimeOption(rawValue: containerRaw) {
      containerRuntime = provider
    }
    if let binary = snapshot.preferencesContainerBinaryPath {
      containerBinaryPath = binary
    }
    if let binary = snapshot.preferencesCodingAgentBinaryPath {
      codingAgentBinaryPath = binary
      preferredCodingAgentBinaryPathRaw = binary
    } else if !preferredCodingAgentBinaryPathRaw.isEmpty {
      codingAgentBinaryPath = preferredCodingAgentBinaryPathRaw
    }
  }

  private func savePreferences() async {
    isLoadingConfig = true
    defer { isLoadingConfig = false }

    legacyPreferredTerminalRaw = preferredTerminalRaw
    preferredCodingAgentBinaryPathRaw = normalizedPath(codingAgentBinaryPath) ?? ""

    let didSaveTheme = await model.setGlobalConfig(
      key: "controlPlane.preferences.appearance.theme",
      value: appearanceThemeRaw
    )
    let didSaveTerminal = await model.setGlobalConfig(
      key: "controlPlane.preferences.terminal.defaultApp",
      value: preferredTerminalRaw
    )
    let didSaveEditor = await model.setGlobalConfig(
      key: "controlPlane.preferences.editor.defaultApp",
      value: preferredEditorRaw
    )
    let didSaveAgent = await model.setGlobalConfig(
      key: "controlPlane.preferences.agents.defaultApp",
      value: preferredCodingAgentRaw
    )
    let didSaveSessionProvider = await model.setGlobalConfig(
      key: "controlPlane.preferences.sessions.provider",
      value: sessionProvider.rawValue
    )
    let didSaveSessionBinaryPath = await model.setGlobalConfig(
      key: "controlPlane.preferences.sessions.binaryPath",
      value: normalizedPath(sessionBinaryPath) ?? ""
    )
    let didSaveContainerProvider = await model.setGlobalConfig(
      key: "controlPlane.preferences.containers.provider",
      value: containerRuntime.rawValue
    )
    let didSaveContainerBinaryPath = await model.setGlobalConfig(
      key: "controlPlane.preferences.containers.binaryPath",
      value: normalizedPath(containerBinaryPath) ?? ""
    )
    let didSaveAgentBinaryPath = await model.setGlobalConfig(
      key: "controlPlane.preferences.agents.binaryPath",
      value: preferredCodingAgentBinaryPathRaw
    )

    guard [
      didSaveTheme,
      didSaveTerminal,
      didSaveEditor,
      didSaveAgent,
      didSaveSessionProvider,
      didSaveSessionBinaryPath,
      didSaveContainerProvider,
      didSaveContainerBinaryPath,
      didSaveAgentBinaryPath
    ].allSatisfy({ $0 }) else {
      return
    }

    await model.refresh()
    await loadConfigFromDisk()
  }

  private func preferencePicker<Content: View>(
    title: String,
    helper: String,
    selectionLabel: String,
    @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 8) {
        Text(title)
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
        Text(selectionLabel)
          .font(.mono(.caption, weight: .semibold))
          .foregroundStyle(.primary)
      }
      content()
      Text(helper)
        .font(.mono(.caption2))
        .foregroundStyle(.tertiary)
    }
  }

  private func pathEditor(
    title: String,
    helper: String,
    text: Binding<String>,
    detectedPath: String?
  ) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title)
        .font(.mono(.caption))
        .foregroundStyle(.secondary)
      HStack(spacing: 8) {
        TextField("Optional custom path", text: text)
          .textFieldStyle(.roundedBorder)
          .font(.mono(.caption))
        Button("Browse") {
          if let path = openExecutablePanel() {
            text.wrappedValue = path
          }
        }
        .adaptiveToolbarButton()
      }
      Text("Detected: \(detectedPath ?? "Not found")")
        .font(.mono(.caption2))
        .foregroundStyle(detectedPath == nil ? Color.orange : Color.secondary)
        .textSelection(.enabled)
      Text(helper)
        .font(.mono(.caption2))
        .foregroundStyle(.tertiary)
    }
  }

  private func normalizedPath(_ value: String) -> String? {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  private func dedupePreservingOrder<T: Hashable>(_ values: [T]) -> [T] {
    var seen: Set<T> = []
    var ordered: [T] = []
    for value in values {
      if seen.insert(value).inserted {
        ordered.append(value)
      }
    }
    return ordered
  }
}

private struct GlobalSettingsView: View {
  @Environment(DashboardModel.self) private var model
  @State private var isLoadingConfig = false
  @State private var launchAtLoad = false
  @State private var gatewayBind = "127.0.0.1"

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        SettingsSectionHeader(
          breadcrumb: "Settings / Global",
          title: "Global Configuration",
          subtitle: "Machine-wide defaults for daemon startup and local gateway networking"
        )
        globalDefaultsCard
        InlineCallout(
          tone: .neutral,
          title: "Extension settings moved",
          message: "Cloudflare, Railway, and Tailscale settings now live on dedicated pages so each integration has focused setup and diagnostics.",
          actions: []
        )
        quickActionsCard
      }
      .padding(16)
    }
    .task {
      await loadConfigFromDisk()
    }
    .onChange(of: model.lastUpdated) { _, _ in
      Task { await loadConfigFromDisk() }
    }
  }

  private var globalDefaultsCard: some View {
    GlassCard(title: "Editable settings", systemImage: "slider.horizontal.3") {
      VStack(alignment: .leading, spacing: 12) {
        Text("These controls apply globally to this machine.")
          .font(.mono(.caption))
          .foregroundStyle(.secondary)

        Toggle("Launch daemon at login", isOn: $launchAtLoad)
          .font(.mono(.subheadline))

        Divider()
          .opacity(0.24)

        VStack(alignment: .leading, spacing: 8) {
          Text("Gateway bind")
            .font(.mono(.caption))
            .foregroundStyle(.secondary)
          Text("Local only keeps access on this Mac. LAN exposes gateway access to your local network.")
            .font(.mono(.caption2))
            .foregroundStyle(.tertiary)
          Picker("Gateway bind", selection: $gatewayBind) {
            Text("Local only (127.0.0.1)").tag("127.0.0.1")
            Text("LAN (0.0.0.0)").tag("0.0.0.0")
          }
          .pickerStyle(.segmented)
        }

        HStack(spacing: 10) {
          Button {
            Task {
              await applyGlobalSettings()
            }
          } label: {
            Label("Save settings", systemImage: "checkmark")
          }
          .adaptiveToolbarButtonProminent()

          Button {
            Task {
              await loadConfigFromDisk()
            }
          } label: {
            Label("Reload", systemImage: "arrow.clockwise")
          }
          .adaptiveToolbarButton()

          if isLoadingConfig {
            ProgressView()
              .controlSize(.small)
          }
          Spacer()
        }
      }
    }
  }

  private var quickActionsCard: some View {
    InlineCallout(
      tone: .neutral,
      title: "Global setup + trust",
      message: "Use these commands when setting up a machine or rotating local TLS trust.",
      actions: [
        InlineCalloutAction(label: "Copy install", systemImage: "doc.on.doc") {
          TerminalIntegration.copyToClipboard("hack global install")
        },
        InlineCalloutAction(label: "Run trust", systemImage: "terminal") {
          TerminalIntegration.openTerminalWithCommand("hack global trust")
        },
        InlineCalloutAction(label: "Restart daemon", systemImage: "arrow.clockwise") {
          TerminalIntegration.openTerminalWithCommand("hack daemon restart")
        }
      ]
    )
  }

  private func loadConfigFromDisk() async {
    isLoadingConfig = true
    defer { isLoadingConfig = false }

    let snapshot = GlobalConfigSnapshot.load()
    if let launchd = snapshot.daemonLaunchdRunAtLoad {
      launchAtLoad = launchd
    }
    if let bind = snapshot.gatewayBind, !bind.isEmpty {
      gatewayBind = bind
    } else if let fallbackBind = model.globalStatus?.gateway?.gatewayBind, !fallbackBind.isEmpty {
      gatewayBind = fallbackBind
    }
  }

  private func applyGlobalSettings() async {
    isLoadingConfig = true
    defer { isLoadingConfig = false }

    await model.setGlobalConfig(
      key: "controlPlane.daemon.launchd.runAtLoad",
      value: launchAtLoad ? "true" : "false"
    )
    await model.setGlobalConfig(
      key: "controlPlane.gateway.bind",
      value: gatewayBind
    )

    await model.refresh()
    await loadConfigFromDisk()
  }
}

private struct SupervisorSettingsView: View {
  @Environment(DashboardModel.self) private var model
  @State private var isLoadingConfig = false
  @State private var enabled = true
  @State private var maxConcurrentJobs = 4
  @State private var logsMaxMegabytes = 5

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        SettingsSectionHeader(
          breadcrumb: "Settings / Supervisor",
          title: "Supervisor",
          subtitle: "Global queue + worker controls for background control-plane jobs"
        )
        GlassCard(title: "Supervisor status", systemImage: "cpu") {
          HStack(spacing: 8) {
            StatusPill(text: enabled ? "Enabled" : "Disabled", tone: enabled ? .good : .warn)
            Spacer()
            if isLoadingConfig {
              ProgressView()
                .controlSize(.small)
            }
          }
          Text("Supervisor coordinates background jobs used by control-plane operations. Disable only for troubleshooting.")
            .font(.mono(.caption))
            .foregroundStyle(.secondary)
        }
        GlassCard(title: "Runtime controls", systemImage: "slider.horizontal.3") {
          VStack(alignment: .leading, spacing: 12) {
            Toggle("Enable supervisor globally", isOn: $enabled)
              .font(.mono(.subheadline))

            Divider()
              .opacity(0.2)

            VStack(alignment: .leading, spacing: 8) {
              HStack {
                Text("Max concurrent jobs")
                  .font(.mono(.caption))
                  .foregroundStyle(.secondary)
                Spacer()
                Text("\(maxConcurrentJobs)")
                  .font(.mono(.caption))
                  .foregroundStyle(.tertiary)
              }
              Stepper(value: $maxConcurrentJobs, in: 1...32) {
                Text("Worker slots")
                  .font(.mono(.subheadline))
              }
            }

            VStack(alignment: .leading, spacing: 8) {
              HStack {
                Text("Log retention budget")
                  .font(.mono(.caption))
                  .foregroundStyle(.secondary)
                Spacer()
                Text(logBudgetLabel)
                  .font(.mono(.caption))
                  .foregroundStyle(.tertiary)
              }
              Stepper(value: $logsMaxMegabytes, in: 1...100, step: 1) {
                Text("Max log cache (MB)")
                  .font(.mono(.subheadline))
              }
            }

            HStack(spacing: 10) {
              Button {
                Task { await saveSupervisorSettings() }
              } label: {
                Label("Save supervisor settings", systemImage: "checkmark")
              }
              .adaptiveToolbarButtonProminent()

              Button {
                Task { await loadConfigFromDisk() }
              } label: {
                Label("Reload", systemImage: "arrow.clockwise")
              }
              .adaptiveToolbarButton()

              Spacer()
            }
          }
        }
        InlineCallout(
          tone: .neutral,
          title: "Need more diagnostics?",
          message: "Open daemon logs when debugging queue stalls or job retries.",
          actions: [
            InlineCalloutAction(label: "Open daemon logs", systemImage: "terminal") {
              openGlobalCommandInTerminalPanel(
                command: "tail -n 200 -F \"$HOME/.hack/daemon/hackd.log\"",
                title: "daemon log tail"
              )
            },
            InlineCalloutAction(label: "Restart daemon", systemImage: "arrow.clockwise") {
              TerminalIntegration.openTerminalWithCommand("hack daemon restart")
            }
          ]
        )
      }
      .padding(16)
    }
    .task {
      await loadConfigFromDisk()
    }
    .onChange(of: model.lastUpdated) { _, _ in
      Task { await loadConfigFromDisk() }
    }
  }

  private var logBudgetLabel: String {
    "\(logsMaxMegabytes) MB (\(logsMaxBytesValue) bytes)"
  }

  private var logsMaxBytesValue: Int {
    max(1, logsMaxMegabytes) * 1_000_000
  }

  private func loadConfigFromDisk() async {
    isLoadingConfig = true
    defer { isLoadingConfig = false }

    let snapshot = GlobalConfigSnapshot.load()
    enabled = snapshot.supervisorEnabled ?? true
    maxConcurrentJobs = max(1, snapshot.supervisorMaxConcurrentJobs ?? 4)
    let rawBytes = max(1, snapshot.supervisorLogsMaxBytes ?? 5_000_000)
    logsMaxMegabytes = max(1, (rawBytes + 999_999) / 1_000_000)
  }

  private func saveSupervisorSettings() async {
    isLoadingConfig = true
    defer { isLoadingConfig = false }

    await model.setGlobalConfig(
      key: "controlPlane.supervisor.enabled",
      value: enabled ? "true" : "false"
    )
    await model.setGlobalConfig(
      key: "controlPlane.supervisor.maxConcurrentJobs",
      value: String(maxConcurrentJobs)
    )
    await model.setGlobalConfig(
      key: "controlPlane.supervisor.logsMaxBytes",
      value: String(logsMaxBytesValue)
    )

    await model.refresh()
    await loadConfigFromDisk()
  }
}

private struct CloudflareExtensionSettingsView: View {
  private enum FocusedField: Hashable {
    case hostname
    case sshHostname
  }

  @Environment(DashboardModel.self) private var model
  @State private var isLoadingConfig = false
  @State private var isSavingToggle = false
  @State private var isTunnelActionInFlight = false
  @State private var suppressEnabledToggleChange = false
  @State private var enabled = false
  @State private var hostname = ""
  @State private var sshHostname = ""
  @State private var tunnelIsRunning = false
  @State private var tunnelPid: Int? = nil
  @State private var loadedEnabled = false
  @State private var loadedHostname = ""
  @State private var loadedSSHHostname = ""
  @FocusState private var focusedField: FocusedField?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        SettingsSectionHeader(
          breadcrumb: "Settings / Cloudflare",
          title: "Cloudflare",
          subtitle: "Public tunnel exposure via cloudflared for HTTPS and SSH entrypoints"
        )
        GlassCard(title: "Extension status", systemImage: "cloud") {
          HStack(alignment: .center, spacing: 8) {
            StatusPill(text: enabled ? "Enabled" : "Disabled", tone: enabled ? .good : .neutral)
            StatusPill(
              text: tunnelIsRunning ? "Tunnel running" : "Tunnel stopped",
              tone: tunnelStatusTone
            )
            Spacer()
            Toggle("Enabled", isOn: $enabled)
              .labelsHidden()
              .toggleStyle(.switch)
              .onChange(of: enabled) { _, newValue in
                guard !suppressEnabledToggleChange else { return }
                Task {
                  await applyCloudflareEnabledToggle(newValue)
                }
              }
            if isLoadingConfig || isTunnelActionInFlight {
              ProgressView()
                .controlSize(.small)
            }
            if isSavingToggle {
              ProgressView()
                .controlSize(.small)
            }
          }
          if let configuredHost = normalizedHost(hostname) {
            Text("Hostname: \(configuredHost)")
              .font(.mono(.caption))
              .foregroundStyle(.secondary)
          } else {
            Text("Hostname not configured")
              .font(.mono(.caption))
              .foregroundStyle(.secondary)
          }
          if tunnelIsRunning, let tunnelPid {
            Text("Tunnel PID: \(tunnelPid)")
              .font(.mono(.caption2))
              .foregroundStyle(.secondary)
          } else {
            Text("Tunnel process is not running")
              .font(.mono(.caption2))
              .foregroundStyle(.tertiary)
          }
          if let detail = cloudflareExposure?.detail, !detail.isEmpty {
            Text(detail)
              .font(.mono(.caption))
              .foregroundStyle(.secondary)
          }
        }
        GlassCard(title: "Configuration", systemImage: "slider.horizontal.3") {
          VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
              HStack(spacing: 8) {
                Text("cloudflared binary")
                  .font(.mono(.caption))
                  .foregroundStyle(.secondary)
                StatusPill(
                  text: cloudflaredInstalled ? "Installed" : "Missing",
                  tone: cloudflaredInstalled ? .good : .warn
                )
              }
              Text(cloudflaredPathLabel)
                .font(.mono(.caption2))
                .foregroundStyle(cloudflaredInstalled ? .secondary : Color.orange)
                .textSelection(.enabled)
            }

            Divider()
              .opacity(0.2)

            VStack(alignment: .leading, spacing: 6) {
              Text("Primary hostname")
                .font(.mono(.caption))
                .foregroundStyle(.secondary)
              TextField("gateway.example.com", text: $hostname)
                .textFieldStyle(.roundedBorder)
                .font(.mono(.subheadline))
                .focused($focusedField, equals: .hostname)
              Text("Used for gateway HTTPS routes.")
                .font(.mono(.caption2))
                .foregroundStyle(.tertiary)
            }

            VStack(alignment: .leading, spacing: 6) {
              Text("SSH hostname (optional)")
                .font(.mono(.caption))
                .foregroundStyle(.secondary)
              TextField("ssh.example.com", text: $sshHostname)
                .textFieldStyle(.roundedBorder)
                .font(.mono(.subheadline))
                .focused($focusedField, equals: .sshHostname)
              Text("Used for SSH routing when remote workflows are enabled.")
                .font(.mono(.caption2))
                .foregroundStyle(.tertiary)
            }

            HStack(spacing: 10) {
              Button {
                Task { await saveCloudflareSettings() }
              } label: {
                Label("Save Cloudflare settings", systemImage: "checkmark")
              }
              .adaptiveToolbarButtonProminent()

              Button {
                Task { await loadConfigFromDisk() }
              } label: {
                Label("Reload", systemImage: "arrow.clockwise")
              }
              .adaptiveToolbarButton()

              Button {
                Task { await startCloudflareTunnel() }
              } label: {
                Label("Start tunnel", systemImage: "play.fill")
              }
              .adaptiveToolbarButton()
              .disabled(!enabled || !cloudflaredInstalled || tunnelIsRunning || isTunnelActionInFlight)

              Button {
                Task { await stopCloudflareTunnel() }
              } label: {
                Label("Stop tunnel", systemImage: "stop.fill")
              }
              .adaptiveToolbarButton()
              .disabled((!tunnelIsRunning && !isTunnelActionInFlight) || isLoadingConfig)

              Spacer()
            }
          }
        }
        InlineCallout(
          tone: .neutral,
          title: "Cloudflare requirements",
          message: "Install `cloudflared` locally and set hostnames before enabling. Missing hostname or binary will keep status at Needs setup.",
          actions: [
            InlineCalloutAction(label: "Open tunnel logs", systemImage: "terminal") {
              openGlobalCommandInTerminalPanel(
                command: "hack global status --json && hack global logs caddy --tail 200 --follow",
                title: "cloudflare diagnostics"
              )
            }
          ]
        )
      }
      .padding(16)
    }
    .task {
      await loadConfigFromDisk()
    }
    .onChange(of: model.lastUpdated) { _, _ in
      guard shouldReloadFromRefresh else { return }
      Task { await loadConfigFromDisk() }
    }
  }

  private var cloudflareExposure: GatewayExposure? {
    model.globalStatus?.gateway?.exposures?.first(where: { $0.id == "cloudflare" })
  }

  private var tunnelStatusTone: StatusTone {
    if tunnelIsRunning {
      return .good
    }
    if enabled {
      return .warn
    }
    return .neutral
  }

  private var cloudflaredPath: String? {
    resolveExecutablePath(candidates: ["cloudflared"])
  }

  private var cloudflaredInstalled: Bool {
    cloudflaredPath != nil
  }

  private var cloudflaredPathLabel: String {
    "cloudflared path: \(cloudflaredPath ?? "Not found in PATH")"
  }

  private func loadConfigFromDisk() async {
    isLoadingConfig = true
    defer { isLoadingConfig = false }

    let snapshot = GlobalConfigSnapshot.load()
    let nextEnabled = snapshot.cloudflareExtensionEnabled ?? false
    let nextHostname = snapshot.cloudflareHostname ?? ""
    let nextSSHHostname = snapshot.cloudflareSSHHostname ?? ""
    suppressEnabledToggleChange = true
    enabled = nextEnabled
    hostname = nextHostname
    sshHostname = nextSSHHostname
    suppressEnabledToggleChange = false
    loadedEnabled = nextEnabled
    loadedHostname = nextHostname
    loadedSSHHostname = nextSSHHostname
    refreshCloudflareTunnelState()
  }

  private func applyCloudflareEnabledToggle(_ isEnabled: Bool) async {
    isSavingToggle = true
    defer { isSavingToggle = false }

    let didUpdate = await model.setGlobalConfig(
      key: "controlPlane.extensions[\"dance.hack.cloudflare\"].enabled",
      value: isEnabled ? "true" : "false"
    )
    guard didUpdate else {
      await loadConfigFromDisk()
      return
    }
    if !isEnabled, tunnelIsRunning {
      isTunnelActionInFlight = true
      _ = await model.stopCloudflareTunnel()
      isTunnelActionInFlight = false
    }
    await loadConfigFromDisk()
  }

  private func saveCloudflareSettings() async {
    isLoadingConfig = true
    defer { isLoadingConfig = false }

    let didSaveEnabled = await model.setGlobalConfig(
      key: "controlPlane.extensions[\"dance.hack.cloudflare\"].enabled",
      value: enabled ? "true" : "false"
    )
    guard didSaveEnabled else {
      await loadConfigFromDisk()
      return
    }
    let didSaveHostname = await model.setGlobalConfig(
      key: "controlPlane.extensions[\"dance.hack.cloudflare\"].config.hostname",
      value: hostname.trimmingCharacters(in: .whitespacesAndNewlines)
    )
    guard didSaveHostname else {
      await loadConfigFromDisk()
      return
    }
    let didSaveSSHHostname = await model.setGlobalConfig(
      key: "controlPlane.extensions[\"dance.hack.cloudflare\"].config.sshHostname",
      value: sshHostname.trimmingCharacters(in: .whitespacesAndNewlines)
    )
    guard didSaveSSHHostname else {
      await loadConfigFromDisk()
      return
    }

    await loadConfigFromDisk()
  }

  private func startCloudflareTunnel() async {
    guard enabled, cloudflaredInstalled else { return }
    isTunnelActionInFlight = true
    defer { isTunnelActionInFlight = false }
    let started = await model.startCloudflareTunnel()
    guard started else {
      await loadConfigFromDisk()
      return
    }
    await model.refresh()
    await loadConfigFromDisk()
  }

  private func stopCloudflareTunnel() async {
    isTunnelActionInFlight = true
    defer { isTunnelActionInFlight = false }
    let stopped = await model.stopCloudflareTunnel()
    guard stopped else {
      await loadConfigFromDisk()
      return
    }
    await model.refresh()
    await loadConfigFromDisk()
  }

  private func refreshCloudflareTunnelState() {
    let pidPath = cloudflaredPidPath
    guard let pidRaw = try? String(contentsOfFile: pidPath, encoding: .utf8) else {
      tunnelPid = nil
      tunnelIsRunning = false
      return
    }
    let trimmed = pidRaw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let pid = Int(trimmed), pid > 0 else {
      tunnelPid = nil
      tunnelIsRunning = false
      return
    }
    tunnelPid = pid
    tunnelIsRunning = isProcessRunning(pid: pid)
    if !tunnelIsRunning {
      tunnelPid = nil
    }
  }

  private var cloudflaredPidPath: String {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".hack/cloudflare/cloudflared.pid")
      .path
  }

  private func isProcessRunning(pid: Int) -> Bool {
    guard pid > 0 else { return false }
    if kill(pid_t(pid), 0) == 0 {
      return true
    }
    return errno == EPERM
  }

  private func normalizedHost(_ value: String) -> String? {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  private var shouldReloadFromRefresh: Bool {
    if isLoadingConfig || isSavingToggle || isTunnelActionInFlight {
      return false
    }
    if focusedField != nil {
      return false
    }
    return !hasUnsavedChanges
  }

  private var hasUnsavedChanges: Bool {
    if enabled != loadedEnabled {
      return true
    }
    if normalizedValue(hostname) != normalizedValue(loadedHostname) {
      return true
    }
    if normalizedValue(sshHostname) != normalizedValue(loadedSSHHostname) {
      return true
    }
    return false
  }

  private func normalizedValue(_ value: String) -> String {
    value.trimmingCharacters(in: .whitespacesAndNewlines)
  }
}

/// Railway provider diagnostics and bootstrap workflow for remote node onboarding.
private struct RailwayExtensionSettingsView: View {
  @Environment(DashboardModel.self) private var model
  @State private var isLoadingConfig = false
  @State private var isSavingConfig = false
  @State private var isBootstrapping = false
  @State private var isLoadingDiagnostics = false
  @State private var suppressEnabledToggleChange = false
  @State private var showAdvancedOptions = false
  @State private var enabled = false
  @State private var tailscaleExtensionEnabled = false
  @State private var diagnostics: RailwayInspectResponse? = nil
  @State private var tailscaleDiagnostics: TailscaleInspectResponse? = nil
  @State private var lastDiagnosticsRefreshAt: Date? = nil
  @State private var bootstrapResult: RailwayBootstrapResponse? = nil
  @State private var railwayProject = ""
  @State private var railwayService = ""
  @State private var railwayEnvironment = "production"
  @State private var railwayWorkspace = ""
  @State private var nodeName = ""
  @State private var labelsCsv = "railway,linux,container"
  @State private var endpoint = ""
  @State private var createService = true
  @State private var railwayImage = "hackdance/hack:latest"
  @State private var railwayPrivate = true
  @State private var defaultNode = false
  @State private var privateAuthSourceLabel = "Missing auth source"
  @State private var privateBootstrapReady = false
  @State private var tailscaleHostname = ""
  @State private var tailscaleTagsCsv = ""

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 20) {
        SettingsSectionHeader(
          breadcrumb: "Settings / Railway",
          title: "Railway",
          subtitle: "Bootstrap remote nodes with minimal input; advanced options stay optional"
        )

        GlassCard(title: "Provider status", systemImage: "tram.fill.tunnel") {
          HStack(alignment: .center, spacing: 8) {
            StatusPill(text: enabled ? "Enabled" : "Disabled", tone: enabled ? .good : .neutral)
            StatusPill(
              text: railwayInstalled ? "Railway CLI installed" : "Railway CLI missing",
              tone: railwayInstalled ? .good : .warn
            )
            StatusPill(
              text: railwayAuthenticated ? "CLI authenticated" : "CLI not authenticated",
              tone: railwayAuthenticated ? .good : .warn
            )
            if railwayPrivate {
              StatusPill(
                text: tailscaleExtensionEnabled ? "Tailscale extension enabled" : "Tailscale extension disabled",
                tone: tailscaleExtensionEnabled ? .good : .warn
              )
              StatusPill(
                text: tailscaleControllerReady ? "Controller tailscale ready" : "Controller tailscale not ready",
                tone: tailscaleControllerReady ? .good : .warn
              )
              StatusPill(
                text: privateCredentialSourceLabel,
                tone: privateBootstrapReady ? .good : .warn
              )
            } else {
              StatusPill(text: "Public endpoint mode", tone: .neutral)
            }
            Spacer()
            Toggle("Enabled", isOn: $enabled)
              .labelsHidden()
              .toggleStyle(.switch)
              .onChange(of: enabled) { _, newValue in
                guard !suppressEnabledToggleChange else { return }
                Task { await applyRailwayEnabledToggle(newValue) }
              }
            if isLoadingConfig || isLoadingDiagnostics || isSavingConfig || isBootstrapping {
              ProgressView()
                .controlSize(.small)
            }
          }

          Text("railway path: \(railwayPathLabel)")
            .font(.mono(.caption2))
            .foregroundStyle(railwayInstalled ? .secondary : Color.orange)
            .textSelection(.enabled)
          if let version = diagnostics?.version, !version.isEmpty {
            Text("version: \(version)")
              .font(.mono(.caption2))
              .foregroundStyle(.secondary)
          }
          if let whoami = diagnostics?.whoami, !whoami.isEmpty {
            Text("whoami: \(whoami)")
              .font(.mono(.caption))
              .foregroundStyle(.secondary)
          }
          if let error = diagnostics?.error, !error.isEmpty {
            Text(error)
              .font(.mono(.caption))
              .foregroundStyle(Color.orange)
          }

          HStack(spacing: 10) {
            Button {
              openTailscaleSettings()
            } label: {
              Label("Open Tailscale", systemImage: "network")
            }
            .adaptiveToolbarButton()

            Button {
              openGlobalCommandInTerminalPanel(
                command: "railway whoami",
                title: "railway whoami"
              )
            } label: {
              Label("Open whoami", systemImage: "person.crop.circle")
            }
            .adaptiveToolbarButton()
            .disabled(!railwayInstalled)

            Button {
              openGlobalCommandInTerminalPanel(
                command: "railway login",
                title: "railway login"
              )
            } label: {
              Label("Run login", systemImage: "person.badge.key")
            }
            .adaptiveToolbarButton()
            .disabled(!railwayInstalled)

            Spacer()
          }
        }

        GlassCard(title: "Bootstrap configuration", systemImage: "gearshape.2") {
          VStack(alignment: .leading, spacing: 12) {
            Text("Project is optional. Leave it blank to use saved provider/global defaults.")
              .font(.mono(.caption))
              .foregroundStyle(.secondary)

            TextField("Railway project (optional)", text: $railwayProject)
              .textFieldStyle(.roundedBorder)

            HStack(spacing: 10) {
              TextField("Node display name", text: $nodeName)
                .textFieldStyle(.roundedBorder)
            }

            Text(serviceModeSummary)
              .font(.mono(.caption2))
              .foregroundStyle(.secondary)

            HStack(spacing: 10) {
              Toggle("Private tailscale mode", isOn: $railwayPrivate)
                .font(.mono(.caption))
              Toggle("Set as default after bootstrap", isOn: $defaultNode)
                .font(.mono(.caption))
              Spacer()
            }

            if railwayPrivate {
              Text("Private mode uses embedded tailscale on the remote node and reads auth from Tailscale settings.")
                .font(.mono(.caption2))
                .foregroundStyle(.secondary)

              if !privateBootstrapReady {
                Text("Private mode needs a TS auth key. Set it in Tailscale settings or pass --tailscale-auth-key.")
                  .font(.mono(.caption2))
                  .foregroundStyle(Color.orange)
              }
            }

            HStack(spacing: 10) {
              Button {
                Task { await saveRailwayDefaults() }
              } label: {
                Label("Save defaults", systemImage: "square.and.arrow.down")
              }
              .adaptiveToolbarButtonProminent()
              .disabled(isSavingConfig || isBootstrapping)

              if railwayInstalled && railwayAuthenticated && canBootstrapRailwayNode {
                Button {
                  Task { await bootstrapRailwayNode() }
                } label: {
                  Label("Bootstrap node now", systemImage: "play.fill")
                }
                .adaptiveToolbarButton()
                .disabled(isBootstrapping)
              }

              Button {
                openGlobalCommandInTerminalPanel(
                  command: "hack node provider railway bootstrap --help",
                  title: "hack railway bootstrap help"
                )
              } label: {
                Label("Open CLI help", systemImage: "questionmark.circle")
              }
              .adaptiveToolbarButton()

              Button {
                openTopologySettings()
              } label: {
                Label("Open topology", systemImage: "point.3.connected.trianglepath.dotted")
              }
              .adaptiveToolbarButton()

              Spacer()
            }

            DisclosureGroup("Advanced options", isExpanded: $showAdvancedOptions) {
              VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                  TextField("Existing service (optional)", text: $railwayService)
                    .textFieldStyle(.roundedBorder)
                  TextField("Environment", text: $railwayEnvironment)
                    .textFieldStyle(.roundedBorder)
                  TextField("Workspace", text: $railwayWorkspace)
                    .textFieldStyle(.roundedBorder)
                  TextField("Labels (comma-separated)", text: $labelsCsv)
                    .textFieldStyle(.roundedBorder)
                }

                HStack(spacing: 10) {
                  Toggle("Auto-create service when missing", isOn: $createService)
                    .font(.mono(.caption))
                  TextField("Endpoint override", text: $endpoint)
                    .textFieldStyle(.roundedBorder)
                  TextField("Runtime image", text: $railwayImage)
                    .textFieldStyle(.roundedBorder)
                    .disabled(!effectiveCreateService)
                }

                if railwayPrivate {
                  Divider()
                    .opacity(0.2)
                  Text("Tailscale runtime overrides")
                    .font(.mono(.caption2))
                    .foregroundStyle(.secondary)

                  HStack(spacing: 10) {
                    TextField("Tailscale tags", text: $tailscaleTagsCsv)
                      .textFieldStyle(.roundedBorder)
                    TextField("Hostname override", text: $tailscaleHostname)
                      .textFieldStyle(.roundedBorder)
                  }

                  Text("Auth key is managed in Settings → Extensions → Tailscale. CLI one-offs can still pass --tailscale-auth-key.")
                    .font(.mono(.caption2))
                    .foregroundStyle(.tertiary)
                }
              }
              .padding(.top, 8)
            }
          }
        }

        if let bootstrapResult {
          GlassCard(title: "Latest bootstrap result", systemImage: "checkmark.seal") {
            HStack(alignment: .center, spacing: 8) {
              StatusPill(
                text: bootstrapResult.created ? "Node registered" : "Node updated",
                tone: .good
              )
              StatusPill(
                text: bootstrapResult.probe.ok ? "Probe healthy" : "Probe failed",
                tone: bootstrapResult.probe.ok ? .good : .warn
              )
              if let network = bootstrapResult.railway.network, !network.isEmpty {
                StatusPill(text: network, tone: .neutral)
              }
              Spacer()
            }
            Text("Node: \(bootstrapResult.node.name) (\(bootstrapResult.node.id))")
              .font(.mono(.caption))
              .foregroundStyle(.secondary)
              .textSelection(.enabled)
            Text("Endpoint: \(bootstrapResult.endpoint)")
              .font(.mono(.caption))
              .foregroundStyle(.secondary)
              .textSelection(.enabled)
            if let error = bootstrapResult.probe.error, !error.isEmpty {
              Text(error)
                .font(.mono(.caption2))
                .foregroundStyle(Color.orange)
            }
          }
        }
      }
      .padding(16)
    }
    .task {
      await loadRailwayConfigFromDisk()
    }
  }

  private var railwayPath: String? {
    diagnostics?.binaryPath ?? resolveExecutablePath(candidates: ["railway"])
  }

  private var railwayPathLabel: String {
    railwayPath ?? "Not found in PATH"
  }

  private var railwayInstalled: Bool {
    diagnostics?.installed ?? (railwayPath != nil)
  }

  private var railwayAuthenticated: Bool {
    diagnostics?.authenticated == true
  }

  private var tailscaleControllerReady: Bool {
    tailscaleDiagnostics?.installed == true && tailscaleDiagnostics?.connected == true
  }

  private var effectiveCreateService: Bool {
    createService || normalizedOrNil(railwayService) == nil
  }

  private var serviceModeSummary: String {
    if let service = normalizedOrNil(railwayService), !effectiveCreateService {
      return "Service mode: use existing service '\(service)'."
    }
    if let service = normalizedOrNil(railwayService), effectiveCreateService {
      return "Service mode: ensure service '\(service)' exists (create if needed)."
    }
    return "Service mode: auto-create service name from node name."
  }

  private var privateCredentialSourceLabel: String {
    privateAuthSourceLabel
  }

  private var canBootstrapRailwayNode: Bool {
    if !railwayInstalled || !railwayAuthenticated {
      return false
    }
    if railwayPrivate, !privateBootstrapReady {
      return false
    }
    return true
  }

  private func loadRailwayConfigFromDisk() async {
    isLoadingConfig = true
    defer { isLoadingConfig = false }

    let snapshot = GlobalConfigSnapshot.load()
    suppressEnabledToggleChange = true
    enabled = snapshot.railwayExtensionEnabled ?? false
    suppressEnabledToggleChange = false
    tailscaleExtensionEnabled = snapshot.tailscaleExtensionEnabled ?? false
    railwayProject = snapshot.railwayProject ?? ""
    railwayService = snapshot.railwayService ?? ""
    railwayEnvironment = snapshot.railwayEnvironment ?? "production"
    railwayWorkspace = snapshot.railwayWorkspace ?? ""
    nodeName = snapshot.railwayNodeName ?? ""
    labelsCsv = snapshot.railwayLabelsCsv ?? "railway,linux,container"
    endpoint = snapshot.railwayEndpoint ?? ""
    createService = snapshot.railwayCreateService ?? true
    railwayImage = snapshot.railwayImage ?? "hackdance/hack:latest"
    railwayPrivate = snapshot.railwayPrivate ?? true
    tailscaleTagsCsv = snapshot.railwayTailscaleTagsCsv ?? ""
    applyPrivateAuthState(snapshot: snapshot)
    await refreshRailwayDiagnostics()
  }

  private func refreshRailwayDiagnostics() async {
    isLoadingDiagnostics = true
    defer { isLoadingDiagnostics = false }
    async let railwayStatus = model.inspectRailway()
    async let tailscaleStatus = model.inspectTailscale()
    diagnostics = await railwayStatus
    tailscaleDiagnostics = await tailscaleStatus
    lastDiagnosticsRefreshAt = Date()
  }

  private func applyRailwayEnabledToggle(_ isEnabled: Bool) async {
    isSavingConfig = true
    defer { isSavingConfig = false }

    let didUpdate = await model.setGlobalConfig(
      key: "controlPlane.extensions[\"dance.hack.railway\"].enabled",
      value: isEnabled ? "true" : "false"
    )
    guard didUpdate else {
      await loadRailwayConfigFromDisk()
      return
    }
    await loadRailwayConfigFromDisk()
  }

  private func saveRailwayDefaults() async {
    isSavingConfig = true
    defer { isSavingConfig = false }

    let writes: [(String, String)] = [
      ("controlPlane.extensions[\"dance.hack.railway\"].enabled", enabled ? "true" : "false"),
      ("controlPlane.extensions[\"dance.hack.railway\"].config.project", railwayProject),
      ("controlPlane.extensions[\"dance.hack.railway\"].config.service", railwayService),
      ("controlPlane.extensions[\"dance.hack.railway\"].config.environment", railwayEnvironment),
      ("controlPlane.extensions[\"dance.hack.railway\"].config.workspace", railwayWorkspace),
      ("controlPlane.extensions[\"dance.hack.railway\"].config.nodeName", nodeName),
      ("controlPlane.extensions[\"dance.hack.railway\"].config.labelsCsv", labelsCsv),
      ("controlPlane.extensions[\"dance.hack.railway\"].config.endpoint", endpoint),
      ("controlPlane.extensions[\"dance.hack.railway\"].config.createService", createService ? "true" : "false"),
      ("controlPlane.extensions[\"dance.hack.railway\"].config.image", railwayImage),
      ("controlPlane.extensions[\"dance.hack.railway\"].config.private", railwayPrivate ? "true" : "false"),
      ("controlPlane.extensions[\"dance.hack.railway\"].config.tailscaleTagsCsv", tailscaleTagsCsv),
    ]

    for (key, value) in writes {
      _ = await model.setGlobalConfig(key: key, value: value)
    }

    await loadRailwayConfigFromDisk()
  }

  /// Executes non-interactive Railway bootstrap and records the latest run output in-view.
  private func bootstrapRailwayNode() async {
    guard canBootstrapRailwayNode else {
      return
    }
    isBootstrapping = true
    defer { isBootstrapping = false }

    let request = RailwayBootstrapRequest(
      railwayProject: normalizedOrNil(railwayProject),
      railwayService: normalizedOrNil(railwayService),
      railwayEnvironment: normalizedOrNil(railwayEnvironment),
      railwayWorkspace: normalizedOrNil(railwayWorkspace),
      createService: effectiveCreateService,
      railwayImage: normalizedOrNil(railwayImage),
      railwayBin: nil,
      nodeName: normalizedOrNil(nodeName),
      endpoint: normalizedOrNil(endpoint),
      labels: parseCSV(labelsCsv),
      defaultNode: defaultNode,
      domainPort: nil,
      initRetries: nil,
      privateNetworking: railwayPrivate,
      tailscaleAuthKey: nil,
      tailscaleHostname: normalizedOrNil(tailscaleHostname),
      tailscaleTags: parseCSV(tailscaleTagsCsv)
    )
    bootstrapResult = await model.bootstrapRailwayNode(request: request)
    await refreshRailwayDiagnostics()
  }

  private func normalizedOrNil(_ value: String) -> String? {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  private func parseCSV(_ value: String) -> [String] {
    value
      .split(separator: ",")
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
  }

  /**
   Derives private bootstrap auth readiness from shared config with compatibility fallback.
   */
  private func applyPrivateAuthState(snapshot: GlobalConfigSnapshot) {
    let tailscaleConfigAuth = normalizedOrNil(snapshot.tailscaleAuthKey ?? "")
    let railwayCompatAuth = normalizedOrNil(snapshot.railwayTailscaleAuthKey ?? "")
    let envAuth = normalizedOrNil(
      ProcessInfo.processInfo.environment["HACK_TAILSCALE_AUTH_KEY"] ?? ""
    )
    if tailscaleConfigAuth != nil {
      privateBootstrapReady = true
      privateAuthSourceLabel = "Auth key configured"
      return
    }
    if railwayCompatAuth != nil {
      privateBootstrapReady = true
      privateAuthSourceLabel = "Auth key configured (compat)"
      return
    }
    if envAuth != nil {
      privateBootstrapReady = true
      privateAuthSourceLabel = "Auth key from env"
      return
    }
    privateBootstrapReady = false
    privateAuthSourceLabel = "Missing auth source"
  }

  private func openTailscaleSettings() {
    NotificationCenter.default.post(
      name: .hackSettingsRequested,
      object: nil,
      userInfo: [SettingsNavigationRequest.paneKey: SettingsSidebarItem.tailscale.rawValue]
    )
  }

  private func openTopologySettings() {
    NotificationCenter.default.post(
      name: .hackSettingsRequested,
      object: nil,
      userInfo: [SettingsNavigationRequest.paneKey: SettingsSidebarItem.topology.rawValue]
    )
  }
}

private struct TailscaleOAuthCredentialControl: View {
  enum Mode: Equatable {
    case compact
    case standard
  }

  private static let oauthCredentialsURL = "https://login.tailscale.com/admin/settings/oauth"
  private static let oauthDocsURL = "https://tailscale.com/kb/1215/oauth-clients"
  private static let defaultAuthRef = "tailscale.oauth.default"
  private static let defaultTailnet = "-"
  private static let defaultKeyExpirySeconds = 3600
  private static let clipboardPollTimeoutSeconds: TimeInterval = 120
  private static let clipboardPollIntervalNanoseconds: UInt64 = 750_000_000

  @Environment(DashboardModel.self) private var model
  let mode: Mode
  let onStatusChanged: ((TailscaleOAuthStatusResponse?) -> Void)?

  @State private var status: TailscaleOAuthStatusResponse? = nil
  @State private var isLoadingStatus = false
  @State private var isAuthenticating = false
  @State private var isDisconnecting = false
  @State private var authMessage = ""
  @State private var authMessageTone: StatusTone = .neutral
  @State private var authPollingTask: Task<Void, Never>? = nil

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .center, spacing: 8) {
        StatusPill(text: oauthStatusLabel, tone: oauthStatusTone)
        if let tokenExpires = tokenExpiresLabel {
          StatusPill(text: "token expires \(tokenExpires)", tone: .neutral)
        }
        Spacer()
        if isLoadingStatus || isAuthenticating || isDisconnecting {
          ProgressView()
            .controlSize(.small)
        }

        if mode == .standard {
          Button {
            Task { await refreshStatus(validate: true) }
          } label: {
            Label("Validate", systemImage: "checkmark.shield")
          }
          .adaptiveToolbarButton()
          .disabled(isLoadingStatus || isAuthenticating || isDisconnecting)
        }

        Button {
          toggleAuthenticationFlow()
        } label: {
          Label(
            isAuthenticating
              ? "Cancel auth"
              : (status?.configured == true ? "Renew in browser" : "Authenticate in browser"),
            systemImage: isAuthenticating ? "xmark.circle" : "safari"
          )
        }
        .adaptiveToolbarButtonProminent()
        .disabled(isLoadingStatus || isDisconnecting)

        if mode == .standard {
          Button {
            openOAuthCredentialsPage()
          } label: {
            Label("Open OAuth page", systemImage: "link")
          }
          .adaptiveToolbarButton()
          .disabled(isAuthenticating || isDisconnecting)
        }

        if status?.configured == true {
          Button(role: .destructive) {
            Task { await disconnect() }
          } label: {
            Label("Disconnect", systemImage: "trash")
          }
          .adaptiveToolbarButton()
          .disabled(isLoadingStatus || isAuthenticating || isDisconnecting)
        }
      }

      Text(
        "Authentication opens Tailscale in your browser. After creating an OAuth client, click copy in Tailscale and this control imports credentials from clipboard automatically."
      )
      .font(.mono(.caption2))
      .foregroundStyle(.secondary)

      if !authMessage.isEmpty {
        Text(authMessage)
          .font(.mono(.caption2))
          .foregroundStyle(colorForStatusTone(authMessageTone))
      }

      if let checkedAt = checkedAtLabel {
        Text("Last checked \(checkedAt)")
          .font(.mono(.caption2))
          .foregroundStyle(.secondary)
      }
      if let authRef = status?.authRef, !authRef.isEmpty {
        Text("Auth ref: \(authRef)")
          .font(.mono(.caption2))
          .foregroundStyle(.tertiary)
          .textSelection(.enabled)
      }
      if let error = status?.error, !error.isEmpty {
        Text(error)
          .font(.mono(.caption2))
          .foregroundStyle(Color.orange)
      }

      if mode == .standard {
        Button {
          openOAuthDocsPage()
        } label: {
          Label("Open OAuth docs", systemImage: "book")
        }
        .adaptiveToolbarButton()
        .disabled(isAuthenticating)
      }
    }
    .task {
      await refreshStatus(validate: false)
    }
    .onDisappear {
      cancelAuthenticationFlow(userInitiated: false)
    }
  }

  private var oauthStatusLabel: String {
    guard let status else {
      return "Checking OAuth state"
    }
    if status.configured {
      if status.validated == false {
        return "OAuth configured (validation failed)"
      }
      if status.validated == true {
        return "Tailscale authenticated"
      }
      return "OAuth configured"
    }
    return "OAuth not configured"
  }

  private var oauthStatusTone: StatusTone {
    guard let status else {
      return .neutral
    }
    if status.configured {
      return status.validated == false ? .warn : .good
    }
    return .warn
  }

  private var checkedAtLabel: String? {
    formatTimestamp(status?.checkedAt)
  }

  private var tokenExpiresLabel: String? {
    formatTimestamp(status?.tokenExpiresAt)
  }

  private func toggleAuthenticationFlow() {
    if isAuthenticating {
      cancelAuthenticationFlow(userInitiated: true)
      return
    }
    authPollingTask = Task {
      await authenticateViaBrowserFlow()
    }
  }

  private func cancelAuthenticationFlow(userInitiated: Bool) {
    authPollingTask?.cancel()
    authPollingTask = nil
    if userInitiated {
      authMessage = "Authentication canceled."
      authMessageTone = .neutral
    }
    isAuthenticating = false
  }

  private func refreshStatus(validate: Bool) async {
    isLoadingStatus = true
    defer { isLoadingStatus = false }
    let latest = await model.inspectTailscaleOAuthStatus(validate: validate)
    status = latest
    onStatusChanged?(latest)
  }

  /// Browser-first OAuth setup:
  /// 1) opens Tailscale credentials page
  /// 2) waits for copied credentials on clipboard
  /// 3) stores credentials through hack CLI keychain flow
  private func authenticateViaBrowserFlow() async {
    defer {
      authPollingTask = nil
      isAuthenticating = false
    }

    if let existingError = status?.error, existingError.contains("does not support tailscale OAuth") {
      authMessage = existingError
      authMessageTone = .warn
      return
    }

    isAuthenticating = true

    authMessage = "Opened Tailscale OAuth page. Create a credential and click copy in the browser."
    authMessageTone = .neutral
    let baselineClipboard = NSPasteboard.general.string(forType: .string)
    openOAuthCredentialsPage()

    guard let credentials = await waitForClipboardCredentials(previousClipboard: baselineClipboard)
    else {
      if Task.isCancelled {
        return
      }
      authMessage =
        "Could not detect OAuth credentials on clipboard. Copy client id + secret from Tailscale, then authenticate again."
      authMessageTone = .warn
      return
    }

    let request = TailscaleOAuthConnectRequest(
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      authRef: resolvedAuthRef,
      tailnet: resolvedTailnet,
      keyExpirySeconds: resolvedKeyExpirySeconds
    )
    let response = await model.connectTailscaleOAuth(request: request)
    status = response
    onStatusChanged?(response)
    if let responseError = response?.error, !responseError.isEmpty {
      authMessage = responseError
      authMessageTone = .warn
      return
    }

    authMessage = "Tailscale OAuth credentials imported successfully."
    authMessageTone = .good
    await refreshStatus(validate: true)
  }

  private func disconnect() async {
    isDisconnecting = true
    defer { isDisconnecting = false }
    let response = await model.disconnectTailscaleOAuth(authRef: status?.authRef)
    status = response
    onStatusChanged?(response)
    if response?.configured == false {
      authMessage = "Tailscale OAuth credentials were cleared."
      authMessageTone = .neutral
    }
  }

  private var resolvedAuthRef: String {
    let candidate = status?.authRef?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return candidate.isEmpty ? Self.defaultAuthRef : candidate
  }

  private var resolvedTailnet: String {
    let candidate = status?.tailnet?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return candidate.isEmpty ? Self.defaultTailnet : candidate
  }

  private var resolvedKeyExpirySeconds: Int {
    if let keyExpiry = status?.keyExpirySeconds, keyExpiry > 0 {
      return keyExpiry
    }
    return Self.defaultKeyExpirySeconds
  }

  private func waitForClipboardCredentials(
    previousClipboard: String?
  ) async -> OAuthClipboardCredentials? {
    let deadline = Date().addingTimeInterval(Self.clipboardPollTimeoutSeconds)
    while Date() < deadline {
      try? await Task.sleep(nanoseconds: Self.clipboardPollIntervalNanoseconds)
      if Task.isCancelled {
        return nil
      }
      if let detected = parseOAuthCredentialsFromClipboard(
        previousClipboard: previousClipboard
      ) {
        return detected
      }
    }

    return nil
  }

  private func parseOAuthCredentialsFromClipboard(
    previousClipboard: String?
  ) -> OAuthClipboardCredentials? {
    guard let clipboard = NSPasteboard.general.string(forType: .string) else {
      return nil
    }
    if let previousClipboard, clipboard == previousClipboard {
      return nil
    }
    return parseOAuthCredentials(text: clipboard)
  }

  private func parseOAuthCredentials(text: String) -> OAuthClipboardCredentials? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      return nil
    }

    if let object = tryParseJsonObject(from: trimmed),
      let credentials = findOAuthCredentials(in: object)
    {
      return credentials
    }

    return parseOAuthCredentialsFromKeyValueText(trimmed)
  }

  private func tryParseJsonObject(from text: String) -> Any? {
    guard let data = text.data(using: .utf8) else {
      return nil
    }
    return try? JSONSerialization.jsonObject(with: data)
  }

  private func findOAuthCredentials(in object: Any) -> OAuthClipboardCredentials? {
    if let dictionary = object as? [String: Any] {
      var clientId: String?
      var clientSecret: String?
      for (rawKey, rawValue) in dictionary {
        if let nested = findOAuthCredentials(in: rawValue) {
          return nested
        }
        guard let value = rawValue as? String else {
          continue
        }
        let key = normalizeCredentialKey(rawKey)
        if isClientIdKey(key) {
          clientId = normalizeCredentialValue(value)
          continue
        }
        if isClientSecretKey(key) {
          clientSecret = normalizeCredentialValue(value)
        }
      }
      if let clientId, let clientSecret {
        return OAuthClipboardCredentials(clientId: clientId, clientSecret: clientSecret)
      }
      return nil
    }

    if let array = object as? [Any] {
      for value in array {
        if let nested = findOAuthCredentials(in: value) {
          return nested
        }
      }
    }

    return nil
  }

  private func parseOAuthCredentialsFromKeyValueText(_ text: String) -> OAuthClipboardCredentials?
  {
    var clientId: String?
    var clientSecret: String?
    let lines = text.split(whereSeparator: \.isNewline).map(String.init)
    for line in lines {
      if let (rawKey, rawValue) = parseKeyValuePair(line: line) {
        let key = normalizeCredentialKey(rawKey)
        if isClientIdKey(key) {
          clientId = normalizeCredentialValue(rawValue)
          continue
        }
        if isClientSecretKey(key) {
          clientSecret = normalizeCredentialValue(rawValue)
        }
      }
    }
    if let clientId, let clientSecret {
      return OAuthClipboardCredentials(clientId: clientId, clientSecret: clientSecret)
    }

    let regexClientId = captureRegexValue(
      pattern: #"(?im)(?:oauth\s+)?client\s*id\s*[:=]\s*([^\s"']+)"#,
      text: text
    )
    let regexClientSecret = captureRegexValue(
      pattern: #"(?im)(?:oauth\s+)?client\s*secret\s*[:=]\s*([^\s"']+)"#,
      text: text
    )
    guard let regexClientId, let regexClientSecret else {
      return nil
    }
    return OAuthClipboardCredentials(clientId: regexClientId, clientSecret: regexClientSecret)
  }

  private func captureRegexValue(pattern: String, text: String) -> String? {
    guard let expression = try? NSRegularExpression(pattern: pattern) else {
      return nil
    }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    guard
      let match = expression.firstMatch(in: text, options: [], range: range),
      match.numberOfRanges > 1,
      let valueRange = Range(match.range(at: 1), in: text)
    else {
      return nil
    }
    return normalizeCredentialValue(String(text[valueRange]))
  }

  private func parseKeyValuePair(line: String) -> (String, String)? {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      return nil
    }
    for separator in ["=", ":"] {
      if let index = trimmed.firstIndex(of: Character(separator)) {
        let key = String(trimmed[..<index]).trimmingCharacters(in: .whitespacesAndNewlines)
        let value = String(trimmed[trimmed.index(after: index)...])
          .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty, !value.isEmpty else {
          return nil
        }
        return (key, value)
      }
    }
    return nil
  }

  private func normalizeCredentialKey(_ key: String) -> String {
    key
      .lowercased()
      .filter { $0.isLetter || $0.isNumber }
  }

  private func normalizeCredentialValue(_ value: String) -> String {
    value
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
  }

  private func isClientIdKey(_ key: String) -> Bool {
    [
      "clientid",
      "oauthclientid",
      "tailscaleoauthclientid",
      "tsapiclientid",
      "clientidentifier",
    ].contains(key)
  }

  private func isClientSecretKey(_ key: String) -> Bool {
    [
      "clientsecret",
      "oauthclientsecret",
      "tailscaleoauthclientsecret",
      "tsapiclientsecret",
      "secret",
    ].contains(key)
  }

  private func openOAuthCredentialsPage() {
    guard let url = URL(string: Self.oauthCredentialsURL) else {
      return
    }
    NSWorkspace.shared.open(url)
  }

  private func openOAuthDocsPage() {
    guard let url = URL(string: Self.oauthDocsURL) else {
      return
    }
    NSWorkspace.shared.open(url)
  }

  private func colorForStatusTone(_ tone: StatusTone) -> Color {
    switch tone {
    case .good:
      return .green
    case .warn:
      return .orange
    case .neutral:
      return .secondary
    }
  }

  private func formatTimestamp(_ value: String?) -> String? {
    guard let value, !value.isEmpty else {
      return nil
    }
    let formatter = ISO8601DateFormatter()
    guard let date = formatter.date(from: value) else {
      return value
    }
    return date.formatted(date: .abbreviated, time: .shortened)
  }

  private struct OAuthClipboardCredentials {
    let clientId: String
    let clientSecret: String
  }
}

private struct LinearExtensionSettingsView: View {
  @Environment(DashboardModel.self) private var model
  @Environment(\.colorScheme) private var colorScheme
  @State private var isLoadingConfig = false
  @State private var isSavingConfig = false
  @State private var isLoadingDiagnostics = false
  @State private var suppressEnabledToggleChange = false
  @State private var suppressSyncToggleChange = false
  @State private var enabled = false
  @State private var diagnostics: LinearProfilesResponse? = nil
  @State private var remoteConnections: LinearConnectionsResponse? = nil
  @State private var profileStatusById: [String: LinearStatusResponse] = [:]
  @State private var defaultProfile = ""
  @State private var syncLabels = false
  @State private var syncStatuses = true
  @State private var syncDependencies = true
  @State private var syncProjects = true
  @State private var isAuthenticating = false
  @State private var authPollingTask: Task<Void, Never>? = nil
  @State private var authFlowStatus: LinearOAuthFlowStatusResponse? = nil
  @State private var disconnectingLinearProfiles: Set<String> = []
  @State private var assigneeMappings: [LinearAssigneeMapping] = []
  @State private var assigneeMappingProfile = ""
  @State private var assigneeMappingTeamId = ""
  @State private var assigneeMappingLocalAssignee = ""
  @State private var assigneeMappingLinearUserId = ""
  @State private var assigneeMappingLinearUserName = ""
  @State private var assigneeMappingLinearUserEmail = ""
  @State private var isLoadingAssigneeMappings = false
  @State private var isSavingAssigneeMapping = false
  @State private var message = ""
  @State private var lastDiagnosticsRefreshAt: Date? = nil

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 20) {
        SettingsSectionHeader(
          breadcrumb: "Settings / Linear",
          title: "Linear",
          subtitle: nil
        )
        GlassCard(title: "Extension status", systemImage: "line.3.horizontal.decrease.circle") {
          HStack(alignment: .center, spacing: 8) {
            StatusPill(text: enabled ? "Enabled" : "Disabled", tone: enabled ? .good : .neutral)
            StatusPill(
              text: "\(remoteLinearConnections.count) remote account\(remoteLinearConnections.count == 1 ? "" : "s")",
              tone: remoteLinearConnections.isEmpty ? .neutral : .good
            )
            if !resolvedDefaultProfile.isEmpty {
              StatusPill(
                text: "Default profile: \(displayNameForRemoteProfileId(resolvedDefaultProfile))",
                tone: .neutral
              )
            }
            Spacer()
            Toggle("Enabled", isOn: $enabled)
              .labelsHidden()
              .toggleStyle(.switch)
              .onChange(of: enabled) { _, newValue in
                guard !suppressEnabledToggleChange else { return }
                Task {
                  await applyLinearEnabledToggle(newValue)
                }
              }
            if isLoadingConfig || isSavingConfig || isLoadingDiagnostics || isAuthenticating {
              ProgressView()
                .controlSize(.small)
            }
          }
        }

        GlassCard(title: "Accounts", systemImage: "point.3.connected.trianglepath.dotted") {
          HStack(alignment: .center, spacing: 10) {
            Spacer()
            if model.hackAccountState?.authenticated == true {
              Button {
                toggleLinearAuthFlow()
              } label: {
                Label(
                  isAuthenticating ? "Cancel connect" : "Connect account",
                  systemImage: isAuthenticating ? "xmark.circle" : "plus.circle"
                )
              }
              .adaptiveToolbarButtonProminent()
            } else {
              Button("Sign in to Hack") {
                Task { _ = await model.loginHackAccount() }
              }
              .adaptiveToolbarButtonProminent()
            }
          }

          if isAuthenticating {
            StatusPill(text: "Waiting for browser auth", tone: .good)
          } else if let authFlowStatus {
            switch authFlowStatus.status {
            case "complete":
              StatusPill(text: "Connected", tone: .good)
            case "error", "expired":
              StatusPill(text: "Connect failed", tone: .warn)
            default:
              StatusPill(text: "Connect pending", tone: .neutral)
            }
          }

          if model.hackAccountState?.authenticated == true {
            if remoteLinearConnections.isEmpty && localOnlyLinearProfiles.isEmpty {
              Text("No Hack-account Linear connections yet.")
                .font(.mono(.caption))
                .foregroundStyle(.secondary)
            }

            if !remoteLinearConnections.isEmpty {
              VStack(alignment: .leading, spacing: 10) {
                ForEach(remoteLinearConnections) { connection in
                  let profileId = connection.profileId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                  let localProfile = linearProfiles.first(where: { $0.id == profileId })
                  let accountLabel =
                    connection.accountName?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
                    ?? connection.accountEmail?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
                    ?? connection.accountId?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
                    ?? profileId
                  VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                      Text(accountLabel)
                        .font(.mono(.subheadline, weight: .semibold))
                      if !profileId.isEmpty {
                        StatusPill(text: "Profile \(profileId)", tone: .neutral)
                      }
                      if !profileId.isEmpty && resolvedDefaultProfile == profileId {
                        StatusPill(text: "Default profile", tone: .good)
                      }
                      StatusPill(
                        text: localProfile == nil ? "Needs local token on this Mac" : "Saved on this Mac",
                        tone: localProfile == nil ? .warn : .good
                      )
                      Spacer()
                      if !profileId.isEmpty && resolvedDefaultProfile != profileId {
                        Button {
                          Task { await saveLinearDefaultProfile(profileId) }
                        } label: {
                          Label("Set default", systemImage: "star")
                        }
                        .adaptiveToolbarButton()
                      }
                      Button {
                        Task {
                          await reconnectLinearProfile(
                            profileId.isEmpty ? nextLinearProfileId() : profileId,
                            setDefault: resolvedDefaultProfile == profileId
                          )
                        }
                      } label: {
                        Label(
                          localProfile == nil ? "Link this Mac" : "Reconnect",
                          systemImage: "arrow.clockwise.circle"
                        )
                      }
                      .adaptiveToolbarButtonProminent()
                      .disabled(
                        isAuthenticating ||
                          (!profileId.isEmpty && disconnectingLinearProfiles.contains(profileId))
                      )
                      if let localProfile {
                        Button(role: .destructive) {
                          Task { await disconnectLinearProfile(localProfile.id) }
                        } label: {
                          Label("Remove local token", systemImage: "trash")
                        }
                        .adaptiveToolbarButton()
                        .disabled(
                          isAuthenticating ||
                            disconnectingLinearProfiles.contains(localProfile.id)
                        )
                      }
                    }

                    if let email = connection.accountEmail?.trimmingCharacters(in: .whitespacesAndNewlines),
                      !email.isEmpty
                    {
                      Text(email)
                        .font(.mono(.caption2))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                    }
                    if let teamId = connection.teamId?.trimmingCharacters(in: .whitespacesAndNewlines),
                      !teamId.isEmpty
                    {
                      Text("Linear team \(teamId)")
                        .font(.mono(.caption2))
                        .foregroundStyle(.tertiary)
                    } else if let organizationId = connection.organizationId?.trimmingCharacters(in: .whitespacesAndNewlines),
                      !organizationId.isEmpty
                    {
                      Text("Linear organization \(organizationId)")
                        .font(.mono(.caption2))
                        .foregroundStyle(.tertiary)
                    }
                  }
                  if connection.id != remoteLinearConnections.last?.id {
                    Divider()
                      .opacity(0.2)
                  }
                }
              }
            }

            if !localOnlyLinearProfiles.isEmpty {
              VStack(alignment: .leading, spacing: 8) {
                Text("Local-only on this Mac")
                  .font(.mono(.caption))
                  .foregroundStyle(.secondary)
                ForEach(localOnlyLinearProfiles, id: \.id) { profile in
                  let profileStatus = profileStatusById[profile.id]
                  VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                      Text(linearAccountLabel(profile: profile, status: profileStatus) ?? profile.id)
                        .font(.mono(.subheadline, weight: .semibold))
                      StatusPill(text: "Profile \(profile.id)", tone: .neutral)
                      StatusPill(text: "Not linked to Hack account yet", tone: .warn)
                      Spacer()
                      Button {
                        Task {
                          await reconnectLinearProfile(
                            profile.id,
                            setDefault: profile.isDefault
                          )
                        }
                      } label: {
                        Label("Link account", systemImage: "plus.circle")
                      }
                      .adaptiveToolbarButtonProminent()
                      .disabled(
                        isAuthenticating ||
                          disconnectingLinearProfiles.contains(profile.id)
                      )
                    }
                    if let accountEmail = linearAccountEmail(profile: profile, status: profileStatus),
                      !accountEmail.isEmpty
                    {
                      Text(accountEmail)
                        .font(.mono(.caption2))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                    }
                  }
                }
              }
            }
          } else if linearProfiles.isEmpty {
            Text("Sign in to Hack to inspect remote Linear connections.")
              .font(.mono(.caption))
              .foregroundStyle(.secondary)
          } else {
            Text("This Mac still has \(linearProfiles.count) local Linear profile\(linearProfiles.count == 1 ? "" : "s"), but remote account-owned connections require Hack sign-in.")
              .font(.mono(.caption))
              .foregroundStyle(.secondary)
          }
        }

        GlassCard(title: "Sync fields", systemImage: "arrow.triangle.branch") {
          VStack(alignment: .leading, spacing: 12) {
            syncToggleRow(
              title: "Sync labels",
              help: "Translate Linear labels and Hack categories during manual sync.",
              isOn: $syncLabels
            ) { newValue in
              await saveLinearSyncToggle(
                key: "labels",
                value: newValue,
                successMessage: newValue ? "Linear label sync enabled." : "Linear label sync disabled."
              )
            }
            syncToggleRow(
              title: "Sync statuses",
              help: "Translate workflow state when both sides expose a matching status.",
              isOn: $syncStatuses
            ) { newValue in
              await saveLinearSyncToggle(
                key: "statuses",
                value: newValue,
                successMessage: newValue ? "Linear status sync enabled." : "Linear status sync disabled."
              )
            }
            syncToggleRow(
              title: "Sync dependencies",
              help: "Translate dependency and sub-issue style relationships when the counterpart ticket exists.",
              isOn: $syncDependencies
            ) { newValue in
              await saveLinearSyncToggle(
                key: "dependencies",
                value: newValue,
                successMessage: newValue ? "Linear dependency sync enabled." : "Linear dependency sync disabled."
              )
            }
            syncToggleRow(
              title: "Sync project mapping",
              help: "Allow Hack projects to read and write the paired Linear project binding.",
              isOn: $syncProjects
            ) { newValue in
              await saveLinearSyncToggle(
                key: "projects",
                value: newValue,
                successMessage: newValue ? "Linear project sync enabled." : "Linear project sync disabled."
              )
            }
            HStack(alignment: .center, spacing: 6) {
              Text("Review still stays manual")
                .font(.mono(.caption2))
                .foregroundStyle(.secondary)
              Image(systemName: "info.circle")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.tertiary)
                .help(linearSyncReviewSummary)
              Spacer()
            }
          }
        }

        GlassCard(title: "Assignee mapping", systemImage: "person.crop.rectangle.stack") {
          VStack(alignment: .leading, spacing: 12) {
            if linearProfiles.isEmpty {
              Text("Connect an account to add assignee mappings.")
                .font(.mono(.caption))
                .foregroundStyle(.secondary)
            } else {
              VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .center, spacing: 10) {
                  VStack(alignment: .leading, spacing: 6) {
                    Text("Profile")
                      .font(.mono(.caption))
                      .foregroundStyle(.secondary)
                    Picker("Profile", selection: $assigneeMappingProfile) {
                      ForEach(linearProfiles, id: \.id) { profile in
                        Text(displayNameForRemoteProfileId(profile.id))
                          .tag(profile.id)
                      }
                    }
                    .pickerStyle(.menu)
                  }

                  VStack(alignment: .leading, spacing: 6) {
                    Text("Team scope")
                      .font(.mono(.caption))
                      .foregroundStyle(.secondary)
                    TextField("Optional team id", text: $assigneeMappingTeamId)
                      .textFieldStyle(.roundedBorder)
                  }

                  Spacer()

                  if isLoadingAssigneeMappings || isSavingAssigneeMapping {
                    ProgressView()
                      .controlSize(.small)
                  }
                }

                VStack(alignment: .leading, spacing: 8) {
                  HStack(spacing: 8) {
                    Text("Saved mappings")
                      .font(.mono(.caption))
                      .foregroundStyle(.secondary)
                    StatusPill(
                      text: "\(assigneeMappings.count) mapping\(assigneeMappings.count == 1 ? "" : "s")",
                      tone: assigneeMappings.isEmpty ? .neutral : .good
                    )
                  }

                  if assigneeMappings.isEmpty {
                    Text("No explicit mappings for this profile/team scope yet.")
                      .font(.mono(.caption2))
                      .foregroundStyle(.tertiary)
                  } else {
                    VStack(alignment: .leading, spacing: 8) {
                      ForEach(assigneeMappings) { mapping in
                        VStack(alignment: .leading, spacing: 8) {
                          HStack(spacing: 8) {
                            Text(mapping.localAssignee)
                              .font(.mono(.subheadline, weight: .semibold))
                            if let teamId = mapping.teamId, !teamId.isEmpty {
                              StatusPill(text: "Team \(teamId)", tone: .neutral)
                            } else {
                              StatusPill(text: "All teams", tone: .neutral)
                            }
                            Spacer()
                            Button {
                              populateAssigneeMappingDraft(from: mapping)
                            } label: {
                              Label("Use", systemImage: "arrow.down.left.circle")
                            }
                            .adaptiveToolbarButton()
                            Button(role: .destructive) {
                              Task { await removeLinearAssigneeMapping(mapping) }
                            } label: {
                              Label("Remove", systemImage: "trash")
                            }
                            .adaptiveToolbarButton()
                            .disabled(isSavingAssigneeMapping)
                          }
                          Text(mappingDestinationLabel(mapping))
                            .font(.mono(.caption2))
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                          RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(colorScheme == .dark ? Color.white.opacity(0.03) : Color.black.opacity(0.025))
                        )
                        .overlay(
                          RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .stroke(Color.primary.opacity(0.08), lineWidth: 1)
                        )
                      }
                    }
                  }
                }

                Divider()
                  .opacity(0.2)

                VStack(alignment: .leading, spacing: 10) {
                  Text("Edit mapping")
                    .font(.mono(.caption))
                    .foregroundStyle(.secondary)

                  TextField("Local assignee (required)", text: $assigneeMappingLocalAssignee)
                    .textFieldStyle(.roundedBorder)
                  TextField("Linear user id", text: $assigneeMappingLinearUserId)
                    .textFieldStyle(.roundedBorder)
                  TextField("Linear user name", text: $assigneeMappingLinearUserName)
                    .textFieldStyle(.roundedBorder)
                  TextField("Linear user email", text: $assigneeMappingLinearUserEmail)
                    .textFieldStyle(.roundedBorder)

                  HStack(spacing: 8) {
                    Button {
                      Task { await saveLinearAssigneeMapping() }
                    } label: {
                      Label("Save mapping", systemImage: "tray.and.arrow.down")
                    }
                    .adaptiveToolbarButtonProminent()
                    .disabled(!canSaveAssigneeMapping || isSavingAssigneeMapping)

                    Button("Clear form") {
                      clearAssigneeMappingDraft()
                    }
                    .adaptiveToolbarButton()
                    .disabled(isSavingAssigneeMapping)
                  }
                }
              }
            }
          }
        }

        if !message.isEmpty {
          InlineCallout(
            tone: .neutral,
            title: "Linear settings",
            message: message,
            actions: []
          )
        }
      }
      .padding(16)
    }
    .task {
      await loadConfigFromDisk()
    }
    .onChange(of: assigneeMappingProfile) { _, _ in
      Task { await refreshLinearAssigneeMappings() }
    }
    .onDisappear {
      cancelLinearAuthFlow(userInitiated: false)
    }
  }

  private var resolvedDefaultProfile: String {
    let trimmed = defaultProfile.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmed.isEmpty {
      return trimmed
    }
    return diagnostics?.defaultProfile ?? ""
  }

  private func syncToggleRow(
    title: String,
    help: String,
    isOn: Binding<Bool>,
    save: @escaping @MainActor (Bool) async -> Void
  ) -> some View {
    HStack(alignment: .center, spacing: 10) {
      Toggle(title, isOn: isOn)
        .toggleStyle(.switch)
        .onChange(of: isOn.wrappedValue) { _, newValue in
          guard !suppressSyncToggleChange else { return }
          Task {
            await save(newValue)
          }
        }
      Image(systemName: "info.circle")
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(.tertiary)
        .help(help)
      Spacer()
    }
  }

  private var linearProfiles: [LinearProfileSummary] {
    (diagnostics?.profiles ?? []).sorted { lhs, rhs in
      lhs.id.localizedCaseInsensitiveCompare(rhs.id) == .orderedAscending
    }
  }

  private var remoteLinearConnections: [LinearRemoteConnection] {
    (remoteConnections?.connections ?? []).sorted { lhs, rhs in
      let left = lhs.updatedAt.trimmingCharacters(in: .whitespacesAndNewlines)
      let right = rhs.updatedAt.trimmingCharacters(in: .whitespacesAndNewlines)
      return left.localizedCompare(right) == .orderedDescending
    }
  }

  private var localOnlyLinearProfiles: [LinearProfileSummary] {
    linearProfiles.filter { profile in
      !remoteLinearConnections.contains(where: {
        $0.profileId?.caseInsensitiveCompare(profile.id) == .orderedSame
      })
    }
  }

  private func nextLinearProfileId() -> String {
    let existing = Set(
      linearProfiles.map { $0.id.lowercased() } +
        remoteLinearConnections.compactMap { $0.profileId?.lowercased() }
    )
    if !existing.contains("default") {
      return "default"
    }
    var index = 2
    while existing.contains("account-\(index)") {
      index += 1
    }
    return "account-\(index)"
  }

  private var defaultLinearProfileNeedsRepair: Bool {
    let defaultProfileId = resolvedDefaultProfile.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !defaultProfileId.isEmpty else {
      return false
    }
    guard linearProfiles.contains(where: { $0.id == defaultProfileId }) else {
      return false
    }
    guard let status = profileStatusById[defaultProfileId] else {
      return false
    }
    return !status.tokenResolved
  }

  private var linearSyncPolicySummary: String {
    "Authority follows ticket origin. Origin-owned fields such as title, body, status, and project binding stay authoritative on the side that created the ticket, while assignees, labels, dependencies, and sub-issue links are best-effort mergeable when enabled. Comments are append-only and synced in FIFO order rather than edited in place."
  }

  private var linearSyncReviewSummary: String {
    "These toggles only enable translation during manual sync. Hack still flags review-needed cases when both sides changed an origin-owned field, when assignees cannot be mapped cleanly, or when mergeable fields do not have a safe one-to-one counterpart."
  }

  private func loadConfigFromDisk() async {
    isLoadingConfig = true
    defer { isLoadingConfig = false }

    let snapshot = GlobalConfigSnapshot.load()
    suppressEnabledToggleChange = true
    enabled = snapshot.linearExtensionEnabled ?? false
    defaultProfile = snapshot.linearDefaultProfile ?? ""
    suppressSyncToggleChange = true
    syncLabels = snapshot.linearSyncLabels ?? false
    syncStatuses = snapshot.linearSyncStatuses ?? true
    syncDependencies = snapshot.linearSyncDependencies ?? true
    syncProjects = snapshot.linearSyncProjects ?? true
    suppressSyncToggleChange = false
    suppressEnabledToggleChange = false
    message = ""
    await refreshLinearDiagnostics()
  }

  private func refreshLinearDiagnostics() async {
    isLoadingDiagnostics = true
    defer { isLoadingDiagnostics = false }
    let hackAccountAuthenticated = model.hackAccountState?.authenticated == true
    async let localProfilesTask = model.inspectLinearProfiles()
    async let remoteConnectionsTask: LinearConnectionsResponse? = {
      guard hackAccountAuthenticated else {
        return nil
      }
      return await model.listLinearConnections()
    }()
    diagnostics = await localProfilesTask
    remoteConnections = await remoteConnectionsTask
    if let diagnostics {
      defaultProfile = diagnostics.defaultProfile
    }
    await refreshLinearProfileStatuses()
    refreshSelectedAssigneeMappingProfile()
    await refreshLinearAssigneeMappings()
    lastDiagnosticsRefreshAt = Date()
  }

  private func refreshLinearProfileStatuses() async {
    // Passive settings pages should not trigger keychain-backed token resolution.
    profileStatusById = [:]
  }

  private var normalizedAssigneeMappingProfile: String {
    assigneeMappingProfile.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var normalizedAssigneeMappingTeamId: String? {
    let trimmed = assigneeMappingTeamId.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  private var canSaveAssigneeMapping: Bool {
    guard !normalizedAssigneeMappingProfile.isEmpty else {
      return false
    }
    let localAssignee = assigneeMappingLocalAssignee.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !localAssignee.isEmpty else {
      return false
    }
    let linearUserId = assigneeMappingLinearUserId.trimmingCharacters(in: .whitespacesAndNewlines)
    let linearUserName = assigneeMappingLinearUserName.trimmingCharacters(in: .whitespacesAndNewlines)
    let linearUserEmail = assigneeMappingLinearUserEmail.trimmingCharacters(in: .whitespacesAndNewlines)
    return !linearUserId.isEmpty || !linearUserName.isEmpty || !linearUserEmail.isEmpty
  }

  private func refreshSelectedAssigneeMappingProfile() {
    let current = normalizedAssigneeMappingProfile
    if !current.isEmpty, linearProfiles.contains(where: { $0.id == current }) {
      return
    }
    let fallback = resolvedDefaultProfile.trimmingCharacters(in: .whitespacesAndNewlines)
    if !fallback.isEmpty, linearProfiles.contains(where: { $0.id == fallback }) {
      assigneeMappingProfile = fallback
      return
    }
    assigneeMappingProfile = linearProfiles.first?.id ?? ""
  }

  private func refreshLinearAssigneeMappings() async {
    refreshSelectedAssigneeMappingProfile()
    let profileId = normalizedAssigneeMappingProfile
    guard !profileId.isEmpty else {
      assigneeMappings = []
      return
    }
    isLoadingAssigneeMappings = true
    defer { isLoadingAssigneeMappings = false }
    let response = await model.listLinearAssigneeMappings(
      profileId: profileId,
      teamId: normalizedAssigneeMappingTeamId
    )
    if let response {
      assigneeMappings = response.mappings.sorted {
        $0.localAssignee.localizedCaseInsensitiveCompare($1.localAssignee) == .orderedAscending
      }
    } else {
      assigneeMappings = []
    }
  }

  private func clearAssigneeMappingDraft() {
    assigneeMappingLocalAssignee = ""
    assigneeMappingLinearUserId = ""
    assigneeMappingLinearUserName = ""
    assigneeMappingLinearUserEmail = ""
  }

  private func populateAssigneeMappingDraft(from mapping: LinearAssigneeMapping) {
    assigneeMappingProfile = mapping.profileId
    assigneeMappingTeamId = mapping.teamId ?? ""
    assigneeMappingLocalAssignee = mapping.localAssignee
    assigneeMappingLinearUserId = mapping.linearUserId ?? ""
    assigneeMappingLinearUserName = mapping.linearUserName ?? ""
    assigneeMappingLinearUserEmail = mapping.linearUserEmail ?? ""
  }

  private func mappingDestinationLabel(_ mapping: LinearAssigneeMapping) -> String {
    if let email = mapping.linearUserEmail, !email.isEmpty {
      return "\(mapping.linearUserName ?? mapping.linearUserId ?? "Linear user") • \(email)"
    }
    if let name = mapping.linearUserName, !name.isEmpty {
      return "\(name) • \(mapping.linearUserId ?? "no id")"
    }
    if let userId = mapping.linearUserId, !userId.isEmpty {
      return userId
    }
    return "Missing Linear user details"
  }

  private func saveLinearAssigneeMapping() async {
    guard canSaveAssigneeMapping else {
      message = "Fill in a local assignee and at least one Linear user field."
      return
    }
    isSavingAssigneeMapping = true
    defer { isSavingAssigneeMapping = false }

    let response = await model.setLinearAssigneeMapping(
      profileId: normalizedAssigneeMappingProfile,
      teamId: normalizedAssigneeMappingTeamId,
      localAssignee: assigneeMappingLocalAssignee.trimmingCharacters(in: .whitespacesAndNewlines),
      linearUserId: assigneeMappingLinearUserId.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
      linearUserName: assigneeMappingLinearUserName.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
      linearUserEmail: assigneeMappingLinearUserEmail.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    )
    guard let response else {
      message = model.errorMessage ?? "Failed to save Linear assignee mapping."
      return
    }
    message = response.replacedExisting
      ? "Updated the assignee mapping for \(response.mapping.localAssignee)."
      : "Saved a new assignee mapping for \(response.mapping.localAssignee)."
    await refreshLinearAssigneeMappings()
    clearAssigneeMappingDraft()
  }

  private func removeLinearAssigneeMapping(_ mapping: LinearAssigneeMapping) async {
    isSavingAssigneeMapping = true
    defer { isSavingAssigneeMapping = false }

    let response = await model.removeLinearAssigneeMapping(
      profileId: mapping.profileId,
      teamId: mapping.teamId,
      localAssignee: mapping.localAssignee
    )
    guard let response, response.removed else {
      message = model.errorMessage ?? "Failed to remove Linear assignee mapping."
      return
    }
    if assigneeMappingLocalAssignee.trimmingCharacters(in: .whitespacesAndNewlines)
      .caseInsensitiveCompare(mapping.localAssignee) == .orderedSame
    {
      clearAssigneeMappingDraft()
    }
    message = "Removed the assignee mapping for \(mapping.localAssignee)."
    await refreshLinearAssigneeMappings()
  }

  private func applyLinearEnabledToggle(_ newValue: Bool) async {
    isSavingConfig = true
    defer { isSavingConfig = false }
    let didUpdate = await model.setGlobalConfig(
      key: "controlPlane.extensions[\"dance.hack.linear\"].enabled",
      value: newValue ? "true" : "false"
    )
    if !didUpdate {
      await loadConfigFromDisk()
      message = "Failed to update extension enabled state."
      return
    }
    message = newValue ? "Linear extension enabled." : "Linear extension disabled."
    await model.refresh()
    await refreshLinearDiagnostics()
  }

  private func saveLinearSyncToggle(
    key: String,
    value: Bool,
    successMessage: String
  ) async {
    isSavingConfig = true
    defer { isSavingConfig = false }
    let didUpdate = await model.setGlobalConfig(
      key: "controlPlane.extensions[\"dance.hack.linear\"].config.sync.\(key)",
      value: value ? "true" : "false"
    )
    if !didUpdate {
      await loadConfigFromDisk()
      message = "Failed to update Linear sync policy."
      return
    }
    message = successMessage
    await model.refresh()
    await refreshLinearDiagnostics()
  }

  private func linearAccountLabel(
    profile: LinearProfileSummary,
    status: LinearStatusResponse?
  ) -> String? {
    let profileName = profile.accountName?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let profileName, !profileName.isEmpty {
      return profileName
    }
    let statusName = status?.accountName?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let statusName, !statusName.isEmpty {
      return statusName
    }
    let statusHandle = status?.accountEmail?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let statusHandle, !statusHandle.isEmpty {
      return statusHandle
    }
    let profileEmail = profile.accountEmail?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let profileEmail, !profileEmail.isEmpty {
      return profileEmail
    }
    return nil
  }

  private func linearAccountEmail(
    profile: LinearProfileSummary,
    status: LinearStatusResponse?
  ) -> String? {
    let profileEmail = profile.accountEmail?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let profileEmail, !profileEmail.isEmpty {
      return profileEmail
    }
    let statusEmail = status?.accountEmail?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let statusEmail, !statusEmail.isEmpty {
      return statusEmail
    }
    return nil
  }

  private func linearAccountId(
    profile: LinearProfileSummary,
    status: LinearStatusResponse?
  ) -> String? {
    let profileId = profile.accountId?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let profileId, !profileId.isEmpty {
      return profileId
    }
    let statusId = status?.accountId?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let statusId, !statusId.isEmpty {
      return statusId
    }
    return nil
  }

  private func displayNameForRemoteProfileId(_ profileId: String) -> String {
    let trimmed = profileId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      return "none"
    }
    guard let profile = linearProfiles.first(where: { $0.id == trimmed }) else {
      if let connection = remoteLinearConnections.first(where: {
        $0.profileId?.caseInsensitiveCompare(trimmed) == .orderedSame
      }) {
        return connection.accountName
          ?? connection.accountEmail
          ?? connection.accountId
          ?? trimmed
      }
      return trimmed
    }
    let status = profileStatusById[trimmed]
    guard let label = linearAccountLabel(profile: profile, status: status) else {
      return trimmed
    }
    return "\(label) (\(trimmed))"
  }

  private func saveLinearDefaultProfile(_ profileId: String) async {
    isSavingConfig = true
    defer { isSavingConfig = false }

    let trimmedDefault = profileId.trimmingCharacters(in: .whitespacesAndNewlines)
    let didSaveDefault = await model.setGlobalConfig(
      key: "controlPlane.extensions[\"dance.hack.linear\"].config.defaultProfile",
      value: trimmedDefault
    )
    if !didSaveDefault {
      message = "Failed to save Linear default profile."
      return
    }

    message = trimmedDefault.isEmpty
      ? "Linear default profile cleared. Projects now need an explicit Linear routing override before sync can fall back to a remote account."
      : "Linear default profile saved. Projects without their own override will now route through \(displayNameForRemoteProfileId(trimmedDefault))."
    defaultProfile = trimmedDefault
    await model.refresh()
    await refreshLinearDiagnostics()
  }

  private func reconnectLinearProfile(
    _ profileId: String,
    setDefault: Bool
  ) async {
    await connectLinearAccountViaBrowser(
      profileId: profileId,
      setDefault: setDefault
    )
  }

  private func disconnectLinearProfile(_ profileId: String) async {
    let trimmed = profileId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      return
    }
    disconnectingLinearProfiles.insert(trimmed)
    defer { disconnectingLinearProfiles.remove(trimmed) }

    let disconnected = await model.disconnectLinear(profileId: trimmed)
    if !disconnected {
      message = model.errorMessage ?? "Failed to disconnect the Linear provider account."
      return
    }

    if resolvedDefaultProfile == trimmed {
      message = "Disconnected token for \(displayNameForRemoteProfileId(trimmed)). The profile stays available for reconnect, but projects inheriting this default profile need a reconnect or a different default before the next sync."
    } else {
      message = "Disconnected token for \(displayNameForRemoteProfileId(trimmed)). The profile stays available for reconnect, and any project routed to it needs a reconnect or a different override before the next sync."
    }
    await model.refresh()
    await refreshLinearDiagnostics()
  }

  private func toggleLinearAuthFlow() {
    if isAuthenticating {
      cancelLinearAuthFlow(userInitiated: true)
      return
    }
    let repairDefaultProfileId = resolvedDefaultProfile.trimmingCharacters(in: .whitespacesAndNewlines)
    let generatedProfileId = defaultLinearProfileNeedsRepair && !repairDefaultProfileId.isEmpty
      ? repairDefaultProfileId
      : nextLinearProfileId()
    let setAsDefault =
      (linearProfiles.isEmpty && remoteLinearConnections.isEmpty) ||
      defaultLinearProfileNeedsRepair
    authPollingTask = Task {
      await connectLinearAccountViaBrowser(
        profileId: generatedProfileId,
        setDefault: setAsDefault
      )
    }
  }

  private func cancelLinearAuthFlow(userInitiated: Bool) {
    authPollingTask?.cancel()
    authPollingTask = nil
    isAuthenticating = false
    if userInitiated {
      message = "Linear authentication canceled."
    }
  }

  private func connectLinearAccountViaBrowser(
    profileId: String,
    setDefault: Bool
  ) async {
    defer {
      authPollingTask = nil
      isAuthenticating = false
    }

    let trimmed = profileId.trimmingCharacters(in: .whitespacesAndNewlines)
    let profile = trimmed.isEmpty ? "default" : trimmed
    isAuthenticating = true
    authFlowStatus = nil
    message = "Starting Linear browser auth for profile \(profile). When it completes, the profile can be used for default routing or project-specific sync."

    guard
      let started = await model.startLinearOAuthFlow(
        profileId: profile,
        setDefault: setDefault
      )
    else {
      let detail = model.errorMessage?.trimmingCharacters(
        in: .whitespacesAndNewlines
      )
      if let detail, !detail.isEmpty {
        message = detail
      } else {
        message =
          "Unable to start Linear auth. Confirm network access to the auth broker and retry."
      }
      return
    }

    if setDefault {
      defaultProfile = profile
    }

    guard let authorizeURL = URL(string: started.authorizeUrl) else {
      message = "Auth start returned an invalid authorize URL."
      return
    }

    NSWorkspace.shared.open(authorizeURL)
    message = "Browser opened. Approve access to finish connecting \(profile), then return here to use it for default or per-project routing."

    let formatter = ISO8601DateFormatter()
    let expiresAtDate = formatter.date(from: started.expiresAt)
    var pendingPollCount = 0

    while !Task.isCancelled {
      if let expiresAtDate, Date() >= expiresAtDate {
        message = "Authentication flow expired. Start a new connection."
        return
      }

      try? await Task.sleep(nanoseconds: 1_000_000_000)
      guard !Task.isCancelled else {
        return
      }

      guard
        let flowStatus = await model.fetchLinearOAuthFlowStatus(
          statusURL: started.statusUrl
        )
      else {
        let detail = model.errorMessage?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let detail, !detail.isEmpty {
          message = detail
          return
        }
        continue
      }

      authFlowStatus = flowStatus
      if flowStatus.status == "pending" {
        pendingPollCount += 1
        if pendingPollCount.isMultiple(of: 4),
          model.hackAccountState?.authenticated == true,
          let refreshedRemoteConnections = await model.listLinearConnections()
        {
          remoteConnections = refreshedRemoteConnections
        }
        if pendingPollCount == 8 {
          if remoteLinearConnections.contains(where: {
            $0.profileId?.caseInsensitiveCompare(profile) == .orderedSame
          }) {
            message =
              "Linear already appears connected on this Hack account for \(profile). If the browser opened a manage/install page instead of returning here, finish there or revoke the existing Linear app token, then retry linking this Mac."
          } else {
            message =
              "Still waiting for Linear to return to Hack. If the browser opened a manage/install page, finish there and then return here."
          }
        }
        if pendingPollCount >= 16 {
          if remoteLinearConnections.contains(where: {
            $0.profileId?.caseInsensitiveCompare(profile) == .orderedSame
          }) {
            message =
              "Linear is already linked on this Hack account for \(profile), but this Mac did not receive a fresh callback token. Close the browser and use Link this Mac if you need a local token cached here."
          } else {
            message =
              "Linear did not return a callback for \(profile). If Linear shows Hack already installed, revoke the existing Hack app authorization in Linear and reconnect once so Hack can persist it on this account."
          }
          await refreshLinearDiagnostics()
          authFlowStatus = nil
          return
        }
      }
      if await handleLinearOAuthFlowStatus(flowStatus) {
        return
      }
    }
  }

  private func handleLinearOAuthFlowStatus(
    _ flowStatus: LinearOAuthFlowStatusResponse
  ) async -> Bool {
    switch flowStatus.status {
    case "complete":
      let account = flowStatus.accountName
        ?? flowStatus.accountEmail
        ?? flowStatus.accountHandle
        ?? "Linear provider account"
      message = "Connected \(account) to profile \(flowStatus.profileId). You can now use it for default routing or bind projects to it directly."
      await model.refresh()
      await refreshLinearDiagnostics()
      return true
    case "error":
      message = flowStatus.error ?? "Linear authentication failed."
      return true
    case "expired":
      message = "Authentication flow expired. Start a new connection."
      return true
    default:
      return false
    }
  }
}

private extension String {
  var nilIfEmpty: String? {
    isEmpty ? nil : self
  }
}

private struct GitHubExtensionSettingsView: View {
  @Environment(DashboardModel.self) private var model
  @State private var isLoadingConfig = false
  @State private var isSavingConfig = false
  @State private var isLoadingDiagnostics = false
  @State private var suppressEnabledToggleChange = false
  @State private var enabled = false
  @State private var diagnostics: GitHubProfilesResponse? = nil
  @State private var profileStatusById: [String: GitHubStatusResponse] = [:]
  @State private var defaultProfile = ""
  @State private var isAuthenticating = false
  @State private var authPollingTask: Task<Void, Never>? = nil
  @State private var authFlowStatus: GitHubOAuthFlowStatusResponse? = nil
  @State private var activeAuthFlowId: String? = nil
  @State private var activeAuthStatusURL: String? = nil
  @State private var authInstallURL: String? = nil
  @State private var didAutoOpenInstallURL = false
  @State private var message = ""
  @State private var lastDiagnosticsRefreshAt: Date? = nil
  @State private var systemIdentity: GitSystemIdentity? = nil

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 20) {
        SettingsSectionHeader(
          breadcrumb: "Settings / GitHub",
          title: "GitHub",
          subtitle: nil
        )
        GlassCard(title: "Extension status", systemImage: "chevron.left.forwardslash.chevron.right") {
          HStack(alignment: .center, spacing: 8) {
            StatusPill(text: enabled ? "Enabled" : "Disabled", tone: enabled ? .good : .neutral)
            StatusPill(
              text: "\(githubProfiles.count) provider account\(githubProfiles.count == 1 ? "" : "s")",
              tone: (diagnostics?.profiles.isEmpty == false) ? .good : .neutral
            )
            if !resolvedDefaultProfile.isEmpty {
              StatusPill(
                text: "Default profile: \(displayNameForRemoteProfileId(resolvedDefaultProfile))",
                tone: .neutral
              )
            }
            Spacer()
            Toggle("Enabled", isOn: $enabled)
              .labelsHidden()
              .toggleStyle(.switch)
              .onChange(of: enabled) { _, newValue in
                guard !suppressEnabledToggleChange else { return }
                Task {
                  await applyGitHubEnabledToggle(newValue)
                }
              }
            if isLoadingConfig || isSavingConfig || isLoadingDiagnostics || isAuthenticating {
              ProgressView()
                .controlSize(.small)
            }
          }
        }

        GlassCard(title: "System Git identity", systemImage: "person.crop.circle.badge.checkmark") {
          HStack(spacing: 8) {
            StatusPill(text: "Read-only", tone: .neutral)
            StatusPill(text: "Inherited local Git", tone: .neutral)
            if let login = systemIdentity?.githubLogin, !login.isEmpty {
              StatusPill(text: "@\(login)", tone: .good)
            } else {
              StatusPill(text: "GitHub CLI account unknown", tone: .warn)
            }
          }

          if let systemIdentity {
            if let gitName = systemIdentity.gitName, !gitName.isEmpty {
              Text("git name: \(gitName)")
                .font(.mono(.caption2))
                .foregroundStyle(.secondary)
            }
            if let gitEmail = systemIdentity.gitEmail, !gitEmail.isEmpty {
              Text("git email: \(gitEmail)")
                .font(.mono(.caption2))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            }
            if let login = systemIdentity.githubLogin, !login.isEmpty {
              let accountNameSuffix = systemIdentity.githubName.map { " (\($0))" } ?? ""
              Text("github cli: @\(login)\(accountNameSuffix)")
                .font(.mono(.caption2))
                .foregroundStyle(.secondary)
            } else {
              Text("No GitHub CLI account detected for this machine.")
                .font(.mono(.caption2))
                .foregroundStyle(.secondary)
            }
          } else {
            Text("Unable to read local Git identity yet.")
              .font(.mono(.caption2))
              .foregroundStyle(.secondary)
          }
        }

        GlassCard(title: "Accounts", systemImage: "person.2.badge.gearshape") {
          HStack(alignment: .center, spacing: 10) {
            Spacer()
            if model.hackAccountState?.authenticated == true {
              Button {
                toggleGitHubAuthFlow()
              } label: {
                Label(
                  isAuthenticating ? "Cancel connect" : "Connect account",
                  systemImage: isAuthenticating ? "xmark.circle" : "plus.circle"
                )
              }
              .adaptiveToolbarButtonProminent()
            } else {
              Button("Sign in to Hack") {
                Task { _ = await model.loginHackAccount() }
              }
              .adaptiveToolbarButtonProminent()
            }
          }

          if isAuthenticating {
            StatusPill(text: "Waiting for browser callback", tone: .good)
          } else if let authFlowStatus {
            switch authFlowStatus.status {
            case "complete", "claimed":
              if requiresGitHubAppInstall(authFlowStatus) {
                StatusPill(text: "Install required", tone: .warn)
              } else {
                StatusPill(text: "Connected", tone: .good)
              }
            case "error", "expired":
              StatusPill(text: "Connect failed", tone: .warn)
            default:
              StatusPill(text: "Connect pending", tone: .neutral)
            }
          }

          if githubProfiles.isEmpty {
            Text("No accounts connected yet.")
              .font(.mono(.caption))
              .foregroundStyle(.secondary)
          } else {
            VStack(alignment: .leading, spacing: 10) {
              ForEach(githubProfiles, id: \.id) { profile in
                let profileStatus = profileStatusById[profile.id]
                let accountHandle = remoteAccountHandle(
                  profile: profile,
                  status: profileStatus
                )
                let accountName = remoteAccountName(
                  profile: profile,
                  status: profileStatus
                )
                VStack(alignment: .leading, spacing: 6) {
                  HStack(spacing: 8) {
                    Text(accountHandle.map { "@\($0)" } ?? profile.id)
                      .font(.mono(.subheadline, weight: .semibold))
                    if profile.isDefault {
                      StatusPill(text: "Default profile", tone: .good)
                    }
                    StatusPill(
                      text: profile.mode.lowercased() == "app" ? "Remote app" : "Remote OAuth",
                      tone: .neutral
                    )
                    if profile.installationId?.isEmpty == false {
                      StatusPill(text: "App installed", tone: .good)
                    } else if profile.mode.lowercased() == "app" {
                      StatusPill(text: "Install missing", tone: .warn)
                    }
                    Spacer()
                    if !profile.isDefault {
                      if !(profile.mode.lowercased() == "app" && profile.installationId?.isEmpty != false) {
                        Button {
                          Task { await saveGitHubDefaultProfile(profile.id) }
                        } label: {
                          Label("Set default", systemImage: "star")
                        }
                        .adaptiveToolbarButton()
                      }
                    }
                  }

                  if let accountHandle, !accountHandle.isEmpty {
                    let accountNameSuffix = accountName.map { " (\($0))" } ?? ""
                    Text("@\(accountHandle)\(accountNameSuffix)")
                      .font(.mono(.caption2))
                      .foregroundStyle(.secondary)
                  }
                  Text("Profile \(profile.id)")
                    .font(.mono(.caption2))
                    .foregroundStyle(.tertiary)
                  if let profileStatus,
                    let tokenExpiresAt = profileStatus.tokenExpiresAt,
                    !tokenExpiresAt.isEmpty
                  {
                    Text("Token expires \(tokenExpiresAt)")
                      .font(.mono(.caption2))
                      .foregroundStyle(.tertiary)
                  }
                  if let installation = profile.installationId, !installation.isEmpty {
                    Text("Installation \(installation)")
                      .font(.mono(.caption2))
                      .foregroundStyle(.tertiary)
                  }
                }
                if profile.id != githubProfiles.last?.id {
                  Divider()
                    .opacity(0.2)
                }
              }
            }
          }
        }

        if !message.isEmpty {
          InlineCallout(
            tone: .neutral,
            title: "GitHub settings",
            message: message,
            actions: []
          )
        }
      }
      .padding(16)
    }
    .task {
      await loadConfigFromDisk()
    }
    .onChange(of: model.githubOAuthDeepLinkContext) { _, deepLink in
      guard let deepLink else { return }
      Task {
        await handleGitHubOAuthDeepLink(deepLink)
      }
    }
    .onDisappear {
      cancelGitHubAuthFlow(userInitiated: false)
    }
  }

  private var resolvedDefaultProfile: String {
    let trimmed = defaultProfile.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmed.isEmpty {
      return trimmed
    }
    return diagnostics?.defaultProfile ?? ""
  }

  private var githubProfiles: [GitHubProfileSummary] {
    (diagnostics?.profiles ?? []).sorted { lhs, rhs in
      lhs.id.localizedCaseInsensitiveCompare(rhs.id) == .orderedAscending
    }
  }

  private func nextGitHubProfileId() -> String {
    let existing = Set(githubProfiles.map { $0.id.lowercased() })
    if !existing.contains("default") {
      return "default"
    }
    var index = 2
    while existing.contains("account-\(index)") {
      index += 1
    }
    return "account-\(index)"
  }

  private var defaultGitHubProfileNeedsRepair: Bool {
    let defaultProfileId = resolvedDefaultProfile.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !defaultProfileId.isEmpty else {
      return false
    }
    guard githubProfiles.contains(where: { $0.id == defaultProfileId }) else {
      return false
    }
    guard let status = profileStatusById[defaultProfileId] else {
      return false
    }
    return !status.tokenResolved
  }

  private func loadConfigFromDisk() async {
    isLoadingConfig = true
    defer { isLoadingConfig = false }

    let snapshot = GlobalConfigSnapshot.load()
    suppressEnabledToggleChange = true
    enabled = snapshot.githubExtensionEnabled ?? false
    defaultProfile = snapshot.githubDefaultProfile ?? ""
    suppressEnabledToggleChange = false
    message = ""
    await refreshGitHubDiagnostics()
  }

  private func refreshGitHubDiagnostics() async {
    isLoadingDiagnostics = true
    defer { isLoadingDiagnostics = false }
    diagnostics = await model.inspectGitHubProfiles()
    if let diagnostics {
      defaultProfile = diagnostics.defaultProfile
    }
    systemIdentity = await model.inspectSystemGitIdentity()
    await refreshGitHubProfileStatuses()
    lastDiagnosticsRefreshAt = Date()
  }

  private func refreshGitHubProfileStatuses() async {
    // Passive settings pages should not trigger keychain-backed token resolution.
    profileStatusById = [:]
  }

  private func applyGitHubEnabledToggle(_ newValue: Bool) async {
    isSavingConfig = true
    defer { isSavingConfig = false }
    let didUpdate = await model.setGlobalConfig(
      key: "controlPlane.extensions[\"dance.hack.github\"].enabled",
      value: newValue ? "true" : "false"
    )
    if !didUpdate {
      await loadConfigFromDisk()
      message = "Failed to update extension enabled state."
      return
    }
    message = newValue ? "GitHub extension enabled." : "GitHub extension disabled."
    await model.refresh()
    await refreshGitHubDiagnostics()
  }

  private func remoteAccountHandle(
    profile: GitHubProfileSummary,
    status: GitHubStatusResponse?
  ) -> String? {
    let profileHandle = profile.accountLogin?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let profileHandle, !profileHandle.isEmpty {
      return profileHandle
    }
    let statusHandle = status?.accountLogin?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let statusHandle, !statusHandle.isEmpty {
      return statusHandle
    }
    return nil
  }

  private func remoteAccountName(
    profile: GitHubProfileSummary,
    status: GitHubStatusResponse?
  ) -> String? {
    let profileName = profile.accountName?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let profileName, !profileName.isEmpty {
      return profileName
    }
    let statusName = status?.accountName?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let statusName, !statusName.isEmpty {
      return statusName
    }
    return nil
  }

  private func remoteAccountId(
    profile: GitHubProfileSummary,
    status: GitHubStatusResponse?
  ) -> String? {
    let profileId = profile.accountId?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let profileId, !profileId.isEmpty {
      return profileId
    }
    let statusId = status?.accountId?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let statusId, !statusId.isEmpty {
      return statusId
    }
    return nil
  }

  private func displayNameForRemoteProfileId(_ profileId: String) -> String {
    let trimmed = profileId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      return "none"
    }
    guard let profile = githubProfiles.first(where: { $0.id == trimmed }) else {
      return trimmed
    }
    let status = profileStatusById[trimmed]
    guard let handle = remoteAccountHandle(profile: profile, status: status) else {
      return trimmed
    }
    return "@\(handle) (\(trimmed))"
  }

  private func saveGitHubDefaultProfile(_ profileId: String) async {
    isSavingConfig = true
    defer { isSavingConfig = false }

    let trimmedDefault = profileId.trimmingCharacters(in: .whitespacesAndNewlines)
    let didSaveDefault = await model.setGlobalConfig(
      key: "controlPlane.extensions[\"dance.hack.github\"].config.defaultProfile",
      value: trimmedDefault
    )
    if !didSaveDefault {
      message = "Failed to save GitHub default profile."
      return
    }

    message = trimmedDefault.isEmpty
      ? "GitHub default profile cleared."
      : "GitHub default profile saved."
    defaultProfile = trimmedDefault
    await model.refresh()
    await refreshGitHubDiagnostics()
  }

  private func toggleGitHubAuthFlow() {
    if isAuthenticating {
      cancelGitHubAuthFlow(userInitiated: true)
      return
    }
    let repairDefaultProfileId = resolvedDefaultProfile.trimmingCharacters(in: .whitespacesAndNewlines)
    let generatedProfileId = defaultGitHubProfileNeedsRepair && !repairDefaultProfileId.isEmpty
      ? repairDefaultProfileId
      : nextGitHubProfileId()
    let setAsDefault = githubProfiles.isEmpty || defaultGitHubProfileNeedsRepair
    authPollingTask = Task {
      await connectGitHubAccountViaBrowser(
        profileId: generatedProfileId,
        setDefault: setAsDefault
      )
    }
  }

  private func cancelGitHubAuthFlow(userInitiated: Bool) {
    authPollingTask?.cancel()
    authPollingTask = nil
    isAuthenticating = false
    activeAuthFlowId = nil
    activeAuthStatusURL = nil
    if userInitiated {
      message = "GitHub authentication canceled."
    }
  }

  private func connectGitHubAccountViaBrowser(
    profileId: String,
    setDefault: Bool
  ) async {
    defer {
      authPollingTask = nil
      isAuthenticating = false
      activeAuthFlowId = nil
      activeAuthStatusURL = nil
    }

    let trimmed = profileId.trimmingCharacters(in: .whitespacesAndNewlines)
    let profile = trimmed.isEmpty ? "default" : trimmed
    isAuthenticating = true
    authFlowStatus = nil
    authInstallURL = nil
    didAutoOpenInstallURL = false
    message = "Starting GitHub browser auth for profile \(profile)…"

    guard
      let started = await model.startGitHubOAuthFlow(
        profileId: profile,
        setDefault: setDefault
      )
    else {
      let detail = model.errorMessage?.trimmingCharacters(
        in: .whitespacesAndNewlines
      )
      if let detail, !detail.isEmpty {
        message = detail
      } else {
        message =
          "Unable to start GitHub auth. Confirm daemon is running and auth routing is available."
      }
      return
    }

    if setDefault {
      defaultProfile = profile
    }
    activeAuthFlowId = started.flowId
    activeAuthStatusURL = started.statusUrl
    authInstallURL = started.appInstallUrl

    guard let authorizeURL = URL(string: started.authorizeUrl) else {
      message = "Auth start returned an invalid authorize URL."
      return
    }

    NSWorkspace.shared.open(authorizeURL)
    message = "Browser opened. Approve access to finish connecting \(profile)."

    let formatter = ISO8601DateFormatter()
    let expiresAtDate = formatter.date(from: started.expiresAt)

    while !Task.isCancelled {
      if let expiresAtDate, Date() >= expiresAtDate {
        message = "Authentication flow expired. Start a new connection."
        return
      }

      try? await Task.sleep(nanoseconds: 1_000_000_000)
      guard !Task.isCancelled else {
        return
      }

      guard
        let flowStatus = await model.fetchGitHubOAuthFlowStatus(
          statusURL: started.statusUrl
        )
      else {
        let detail = model.errorMessage?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let detail, !detail.isEmpty {
          message = detail
          return
        }
        continue
      }

      authFlowStatus = flowStatus
      if await handleGitHubOAuthFlowStatus(flowStatus) {
        return
      }
    }
  }

  private func handleGitHubOAuthDeepLink(_ deepLink: GitHubOAuthDeepLinkContext) async {
    defer {
      model.clearGitHubOAuthDeepLink(flowId: deepLink.flowId)
    }

    guard
      let activeAuthFlowId,
      let activeAuthStatusURL
    else {
      message = "GitHub callback received. Return to GitHub settings to finish setup."
      return
    }

    guard activeAuthFlowId == deepLink.flowId else {
      return
    }

    message = "Browser callback received. Finalizing GitHub connection…"
    guard let flowStatus = await model.fetchGitHubOAuthFlowStatus(statusURL: activeAuthStatusURL) else {
      let detail = model.errorMessage?.trimmingCharacters(in: .whitespacesAndNewlines)
      if let detail, !detail.isEmpty {
        message = detail
      }
      return
    }
    authFlowStatus = flowStatus
    _ = await handleGitHubOAuthFlowStatus(flowStatus)
  }

  private func handleGitHubOAuthFlowStatus(_ flowStatus: GitHubOAuthFlowStatusResponse) async -> Bool {
    switch flowStatus.status {
    case "complete", "claimed":
      if requiresGitHubAppInstall(flowStatus) {
        let installURL = flowStatus.appInstallUrl ?? authInstallURL
        if !didAutoOpenInstallURL, let installURL, let parsedURL = URL(string: installURL) {
          didAutoOpenInstallURL = true
          NSWorkspace.shared.open(parsedURL)
          message = "GitHub authorized. Finish app install/repo selection in browser, then return."
        } else {
          message = "GitHub authorized. Finish app install/repo selection, then Hack will complete connection."
        }
        return false
      }
      let account = flowStatus.accountLogin ?? "GitHub account"
      message = "Connected \(account) to profile \(flowStatus.profileId)."
      await model.refresh()
      await refreshGitHubDiagnostics()
      return true
    case "error":
      message = flowStatus.error ?? "GitHub authentication failed."
      return true
    case "expired":
      message = "Authentication flow expired. Start a new connection."
      return true
    default:
      return false
    }
  }

  private func requiresGitHubAppInstall(_ status: GitHubOAuthFlowStatusResponse) -> Bool {
    let installationId = status.installationId?.trimmingCharacters(in: .whitespacesAndNewlines)
    let installationIds = status.installationIds ?? []
    let hasInstallation = (installationId?.isEmpty == false) || !installationIds.isEmpty
    let appInstallURL = (status.appInstallUrl ?? authInstallURL)?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return !hasInstallation && appInstallURL?.isEmpty == false
  }
}

private struct TailscaleExtensionSettingsView: View {
  @Environment(DashboardModel.self) private var model
  @State private var isLoadingConfig = false
  @State private var isSavingToggle = false
  @State private var isSavingAuthKey = false
  @State private var isLoadingDiagnostics = false
  @State private var suppressEnabledToggleChange = false
  @State private var enabled = false
  @State private var diagnostics: TailscaleInspectResponse? = nil
  @State private var bootstrapAuthKey = ""
  @State private var showBootstrapAuthKey = false
  @State private var selectedExitNodeId = ""
  @State private var showTailnetExitNodes = true
  @State private var showTailnetTaggedDevices = true
  @State private var showTailnetAllDevices = false
  @State private var lastDiagnosticsRefreshAt: Date? = nil

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 20) {
        SettingsSectionHeader(
          breadcrumb: "Settings / Tailscale",
          title: "Tailscale",
          subtitle: "Tailnet-based secure access and remote routing for gateway projects"
        )
        GlassCard(title: "Extension status", systemImage: "network") {
          HStack(alignment: .center, spacing: 8) {
            StatusPill(text: enabled ? "Enabled" : "Disabled", tone: enabled ? .good : .neutral)
            StatusPill(
              text: tailscaleInstalled ? "tailscale installed" : "tailscale missing",
              tone: tailscaleInstalled ? .good : .warn
            )
            StatusPill(
              text: tailscaleConnected ? "Tailnet connected" : "Tailnet disconnected",
              tone: tailscaleConnected ? .good : .warn
            )
            if let backendState = diagnostics?.backendState, !backendState.isEmpty {
              StatusPill(
                text: "Backend \(backendState)",
                tone: tailscaleConnected ? .good : .neutral
              )
            }
            StatusPill(
              text: selfDeviceOnline ? "Host online" : "Host offline",
              tone: selfDeviceOnline ? .good : .warn
            )
            Spacer()
            Toggle("Enabled", isOn: $enabled)
              .labelsHidden()
              .toggleStyle(.switch)
              .onChange(of: enabled) { _, newValue in
                guard !suppressEnabledToggleChange else { return }
                Task {
                  await applyTailscaleEnabledToggle(newValue)
                }
              }
            if isLoadingConfig || isLoadingDiagnostics {
              ProgressView()
                .controlSize(.small)
            }
            if isSavingToggle {
              ProgressView()
                .controlSize(.small)
            }
          }
          Text("tailscale path: \(tailscalePathLabel)")
            .font(.mono(.caption2))
            .foregroundStyle(tailscaleInstalled ? .secondary : Color.orange)
            .textSelection(.enabled)
          if let tailnetLabel {
            Text("Tailnet: \(tailnetLabel)")
              .font(.mono(.caption))
              .foregroundStyle(.secondary)
          }
          if let selfDevice = diagnostics?.selfDevice {
            Text("This device: \(selfDevice.hostname)\(selfDevice.tailscaleIp.map { " (\($0))" } ?? "")")
              .font(.mono(.caption))
              .foregroundStyle(.secondary)
          }
          if let lastDiagnosticsRefreshAt {
            Text("Last checked \(lastDiagnosticsRefreshAt.formatted(date: .abbreviated, time: .shortened))")
              .font(.mono(.caption2))
              .foregroundStyle(.tertiary)
          }
          if let authUrl = diagnostics?.authUrl, !authUrl.isEmpty {
            Text("Login required: \(authUrl)")
              .font(.mono(.caption2))
              .foregroundStyle(.secondary)
              .textSelection(.enabled)
          }
          if let error = diagnostics?.error, !error.isEmpty {
            Text(error)
              .font(.mono(.caption))
              .foregroundStyle(Color.orange)
          } else if let detail = tailscaleExposure?.detail, !detail.isEmpty {
            Text(detail)
              .font(.mono(.caption))
              .foregroundStyle(.secondary)
          }
        }
        GlassCard(title: "Bootstrap auth key", systemImage: "key.fill") {
          VStack(alignment: .leading, spacing: 12) {
            Text("Use one reusable Tailscale auth key for private remote-node bootstrap flows (Railway and future providers).")
              .font(.mono(.caption))
              .foregroundStyle(.secondary)

            HStack(spacing: 8) {
              StatusPill(
                text: bootstrapAuthKeyConfigured ? "Auth key configured" : "Auth key missing",
                tone: bootstrapAuthKeyConfigured ? .good : .warn
              )
              if bootstrapAuthKeyConfigured {
                StatusPill(text: "Shared with Railway bootstrap", tone: .neutral)
              }
              Spacer()
            }

            HStack(spacing: 10) {
              Group {
                if showBootstrapAuthKey {
                  TextField("tskey-auth-...", text: $bootstrapAuthKey)
                } else {
                  SecureField("TS_AUTHKEY", text: $bootstrapAuthKey)
                }
              }
              .textFieldStyle(.roundedBorder)
              .font(.mono(.subheadline))

              Button {
                showBootstrapAuthKey.toggle()
              } label: {
                Label(showBootstrapAuthKey ? "Hide" : "Show", systemImage: showBootstrapAuthKey ? "eye.slash" : "eye")
              }
              .adaptiveToolbarButton()
            }

            Text(
              "Stored in global config at controlPlane.extensions[\"dance.hack.tailscale\"].config.authKey (mirrored to Railway compatibility key)."
            )
            .font(.mono(.caption2))
            .foregroundStyle(.tertiary)

            HStack(spacing: 10) {
              Button {
                Task { await saveBootstrapAuthKey() }
              } label: {
                Label("Save auth key", systemImage: "square.and.arrow.down")
              }
              .adaptiveToolbarButtonProminent()
              .disabled(isSavingAuthKey)

              Button {
                Task { await clearBootstrapAuthKey() }
              } label: {
                Label("Clear", systemImage: "trash")
              }
              .adaptiveToolbarButton()
              .disabled(isSavingAuthKey || !bootstrapAuthKeyConfigured)

              Button {
                openTailscaleAuthKeysPage()
              } label: {
                Label("Open auth key admin", systemImage: "link")
              }
              .adaptiveToolbarButton()

              Spacer()

              if isSavingAuthKey {
                ProgressView()
                  .controlSize(.small)
              }
            }
          }
        }
        GlassCard(title: "Tailnet controls", systemImage: "slider.horizontal.3") {
          VStack(alignment: .leading, spacing: 12) {
            Text("The extension controls gateway exposure behavior, while Tailscale runtime state is shown here regardless of extension enablement.")
              .font(.mono(.caption))
              .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 10) {
              Text("Quick actions")
                .font(.mono(.caption2))
                .foregroundStyle(.secondary)

              HStack(spacing: 10) {
                Button {
                  Task { await refreshTailscaleDiagnostics() }
                } label: {
                  Label("Refresh state", systemImage: "arrow.clockwise")
                }
                .adaptiveToolbarButtonProminent()

                Button {
                  if tailscaleConnected {
                    openGlobalCommandInTerminalPanel(
                      command: "tailscale down",
                      title: "tailscale down"
                    )
                  } else {
                    openGlobalCommandInTerminalPanel(
                      command: "tailscale up",
                      title: "tailscale up"
                    )
                  }
                } label: {
                  Label(
                    tailscaleConnected ? "Disconnect tailnet" : "Connect tailnet",
                    systemImage: tailscaleConnected ? "stop.fill" : "play.fill"
                  )
                }
                .adaptiveToolbarButton()
                .disabled(!tailscaleInstalled)

                Button {
                  openGlobalCommandInTerminalPanel(
                    command: "tailscale status",
                    title: "tailscale status"
                  )
                } label: {
                  Label("Open CLI status", systemImage: "terminal")
                }
                .adaptiveToolbarButton()

                Spacer()
              }

              HStack(spacing: 10) {
                Button {
                  openGlobalCommandInTerminalPanel(
                    command: "tailscale status --json",
                    title: "tailscale status --json"
                  )
                } label: {
                  Label("Open status JSON", systemImage: "doc.plaintext")
                }
                .adaptiveToolbarButton()
                Spacer()
              }
            }

            if !exitNodes.isEmpty {
              Divider()
                .opacity(0.2)

              VStack(alignment: .leading, spacing: 10) {
                Text("Exit-node routing")
                  .font(.mono(.caption2))
                  .foregroundStyle(.secondary)

                Picker("Exit node", selection: $selectedExitNodeId) {
                  Text("No exit node").tag("")
                  ForEach(exitNodes, id: \.id) { peer in
                    Text(peer.hostname).tag(peer.id)
                  }
                }
                .pickerStyle(.menu)
                .frame(minWidth: 260, maxWidth: 360, alignment: .leading)

                HStack(spacing: 10) {
                  Button {
                    applySelectedExitNode()
                  } label: {
                    Label("Use selected node", systemImage: "location.north.line.fill")
                  }
                  .adaptiveToolbarButton()
                  .disabled(!tailscaleInstalled || selectedExitNodeId.isEmpty)

                  Button {
                    clearSelectedExitNode()
                  } label: {
                    Label("Clear exit node", systemImage: "location.slash")
                  }
                  .adaptiveToolbarButton()
                  .disabled(!tailscaleInstalled || !hasCurrentExitNode)
                  Spacer()
                }
              }

              if let currentExitNodeName = diagnostics?.currentExitNodeName, !currentExitNodeName.isEmpty {
                Text("Current exit node: \(currentExitNodeName)")
                  .font(.mono(.caption2))
                  .foregroundStyle(.secondary)
              }
            }
          }
        }
        tailscaleNetworkCard
      }
      .padding(16)
    }
    .task {
      await loadConfigFromDisk()
    }
    .onChange(of: model.lastUpdated) { _, _ in
      Task { await loadConfigFromDisk() }
    }
  }

  private var tailscaleExposure: GatewayExposure? {
    model.globalStatus?.gateway?.exposures?.first(where: { $0.id == "tailscale" })
  }

  @ViewBuilder
  private var tailscaleNetworkCard: some View {
    GlassCard(title: "Tailnet state", systemImage: "point.3.connected.trianglepath.dotted") {
      if !tailscaleInstalled {
        Text("Install Tailscale to populate nodes, tags, and exit-node controls.")
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
      } else {
        if let diagnostics, let error = diagnostics.error, !error.isEmpty {
          Text(error)
            .font(.mono(.caption))
            .foregroundStyle(Color.orange)
        }

        if let selfDevice = diagnostics?.selfDevice {
          VStack(alignment: .leading, spacing: 4) {
            Text("This device")
              .font(.mono(.caption, weight: .semibold))
              .foregroundStyle(.secondary)
            Text(selfDevice.hostname)
              .font(.mono(.subheadline, weight: .semibold))
            if let ip = selfDevice.tailscaleIp {
              Text(ip)
                .font(.mono(.caption))
                .foregroundStyle(.secondary)
            }
            if let dnsName = selfDevice.dnsName, !dnsName.isEmpty {
              Text(dnsName)
                .font(.mono(.caption2))
                .foregroundStyle(.tertiary)
            }
            if !selfDevice.tags.isEmpty {
              Text("Tags: \(selfDevice.tags.joined(separator: ", "))")
                .font(.mono(.caption2))
                .foregroundStyle(.secondary)
            }
            if let os = selfDevice.os, !os.isEmpty {
              Text("OS: \(os)")
                .font(.mono(.caption2))
                .foregroundStyle(.tertiary)
            }
          }
        }

        if !healthMessages.isEmpty {
          Divider()
            .opacity(0.2)

          VStack(alignment: .leading, spacing: 6) {
            Text("Health checks")
              .font(.mono(.caption, weight: .semibold))
              .foregroundStyle(.secondary)
            ForEach(Array(healthMessages.enumerated()), id: \.offset) { _, message in
              Text("• \(message)")
                .font(.mono(.caption2))
                .foregroundStyle(Color.orange)
            }
          }
        }

        Divider()
          .opacity(0.2)

        DisclosureGroup("Exit nodes", isExpanded: $showTailnetExitNodes) {
          VStack(alignment: .leading, spacing: 6) {
            if let currentExitNodeName = diagnostics?.currentExitNodeName, !currentExitNodeName.isEmpty {
              Text("Current: \(currentExitNodeName)")
                .font(.mono(.caption))
                .foregroundStyle(.secondary)
            } else {
              Text("Current: none")
                .font(.mono(.caption))
                .foregroundStyle(.secondary)
            }

            let exitNodes = diagnostics?.exitNodes ?? []
            if exitNodes.isEmpty {
              Text("No exit-node capable peers detected.")
                .font(.mono(.caption2))
                .foregroundStyle(.tertiary)
            } else {
              ForEach(Array(exitNodes.prefix(6)), id: \.id) { peer in
                tailscalePeerRow(peer)
              }
            }
          }
          .padding(.top, 6)
        }
        .font(.mono(.caption, weight: .semibold))

        if !taggedPeers.isEmpty {
          Divider()
            .opacity(0.2)

          DisclosureGroup(
            "Tagged devices (\(taggedPeers.filter(\.online).count)/\(taggedPeers.count) online)",
            isExpanded: $showTailnetTaggedDevices
          ) {
            VStack(alignment: .leading, spacing: 6) {
              ForEach(Array(taggedPeers.prefix(12)), id: \.id) { peer in
                tailscalePeerRow(peer)
              }
            }
            .padding(.top, 6)
          }
          .font(.mono(.caption, weight: .semibold))
        }

        Divider()
          .opacity(0.2)

        DisclosureGroup(
          "Devices (\(diagnostics?.onlinePeerCount ?? 0)/\(diagnostics?.peers.count ?? 0) online)",
          isExpanded: $showTailnetAllDevices
        ) {
          VStack(alignment: .leading, spacing: 6) {
            if personalPeers.isEmpty {
              Text("No untagged devices reported by tailscale status.")
                .font(.mono(.caption2))
                .foregroundStyle(.tertiary)
            } else {
              ForEach(Array(personalPeers.prefix(12)), id: \.id) { peer in
                tailscalePeerRow(peer)
              }
            }
          }
          .padding(.top, 6)
        }
        .font(.mono(.caption, weight: .semibold))
      }
    }
  }

  private func tailscalePeerRow(_ peer: TailscaleInspectPeer) -> some View {
    HStack(alignment: .center, spacing: 8) {
      Circle()
        .fill(peer.online ? Color.green : Color.secondary.opacity(0.7))
        .frame(width: 6, height: 6)
      Text(peer.hostname)
        .font(.mono(.caption))
        .lineLimit(1)
        .truncationMode(.tail)
      if peer.isExitNodeOption || peer.isExitNode {
        StatusPill(text: "Exit node", tone: .neutral)
      }
      if !peer.tags.isEmpty {
        Text(peer.tags.joined(separator: ", "))
          .font(.mono(.caption2))
          .foregroundStyle(.tertiary)
          .lineLimit(1)
          .truncationMode(.tail)
      }
      Spacer(minLength: 0)
      if let ip = peer.tailscaleIp {
        Text(ip)
          .font(.mono(.caption2))
          .foregroundStyle(.secondary)
      }
    }
  }

  private var tailscaleConnected: Bool {
    diagnostics?.connected == true
  }

  private var selfDeviceOnline: Bool {
    diagnostics?.selfDevice?.online == true
  }

  private var tailnetLabel: String? {
    guard let tailnetName = diagnostics?.tailnetName, !tailnetName.isEmpty else {
      return nil
    }
    guard let suffix = diagnostics?.magicDnsSuffix, !suffix.isEmpty else {
      return tailnetName
    }
    return "\(tailnetName) (\(suffix))"
  }

  private var tailscalePath: String? {
    resolveExecutablePath(candidates: ["tailscale"])
  }

  private var tailscaleInstalled: Bool {
    diagnostics?.installed ?? (tailscalePath != nil)
  }

  private var tailscalePathLabel: String {
    diagnostics?.binaryPath ?? tailscalePath ?? "Not found in PATH"
  }

  private var exitNodes: [TailscaleInspectPeer] {
    diagnostics?.exitNodes ?? []
  }

  private var taggedPeers: [TailscaleInspectPeer] {
    let peers = diagnostics?.peers ?? []
    return peers.filter { !$0.tags.isEmpty }
  }

  private var personalPeers: [TailscaleInspectPeer] {
    let peers = diagnostics?.peers ?? []
    return peers.filter(\.tags.isEmpty)
  }

  private var healthMessages: [String] {
    diagnostics?.health ?? []
  }

  private var hasCurrentExitNode: Bool {
    guard let currentExitNodeId = diagnostics?.currentExitNodeId else { return false }
    return !currentExitNodeId.isEmpty
  }

  private var bootstrapAuthKeyConfigured: Bool {
    !bootstrapAuthKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private func loadConfigFromDisk() async {
    isLoadingConfig = true
    let snapshot = GlobalConfigSnapshot.load()
    suppressEnabledToggleChange = true
    enabled = snapshot.tailscaleExtensionEnabled ?? false
    suppressEnabledToggleChange = false
    bootstrapAuthKey = snapshot.tailscaleAuthKey ?? snapshot.railwayTailscaleAuthKey ?? ""
    isLoadingConfig = false
    await refreshTailscaleDiagnostics()
  }

  private func refreshTailscaleDiagnostics() async {
    isLoadingDiagnostics = true
    defer { isLoadingDiagnostics = false }
    diagnostics = await model.inspectTailscale()
    lastDiagnosticsRefreshAt = Date()
    syncExitNodeSelection()
  }

  private func applyTailscaleEnabledToggle(_ isEnabled: Bool) async {
    isSavingToggle = true
    defer { isSavingToggle = false }

    let didUpdate = await model.setGlobalConfig(
      key: "controlPlane.extensions[\"dance.hack.tailscale\"].enabled",
      value: isEnabled ? "true" : "false"
    )
    guard didUpdate else {
      await loadConfigFromDisk()
      return
    }
    await loadConfigFromDisk()
  }

  private func saveBootstrapAuthKey() async {
    isSavingAuthKey = true
    defer { isSavingAuthKey = false }

    let trimmed = bootstrapAuthKey.trimmingCharacters(in: .whitespacesAndNewlines)
    let didSaveTailscale = await model.setGlobalConfig(
      key: "controlPlane.extensions[\"dance.hack.tailscale\"].config.authKey",
      value: trimmed
    )
    guard didSaveTailscale else {
      await loadConfigFromDisk()
      return
    }

    // Keep Railway bootstrap compatibility while routing continues to read this key.
    let didSaveRailway = await model.setGlobalConfig(
      key: "controlPlane.extensions[\"dance.hack.railway\"].config.tailscaleAuthKey",
      value: trimmed
    )
    guard didSaveRailway else {
      await loadConfigFromDisk()
      return
    }

    await loadConfigFromDisk()
  }

  private func clearBootstrapAuthKey() async {
    bootstrapAuthKey = ""
    await saveBootstrapAuthKey()
  }

  private func syncExitNodeSelection() {
    guard let diagnostics else {
      selectedExitNodeId = ""
      return
    }
    if diagnostics.exitNodes.contains(where: { $0.id == selectedExitNodeId }) {
      return
    }
    selectedExitNodeId = diagnostics.currentExitNodeId ?? ""
  }

  private func applySelectedExitNode() {
    guard !selectedExitNodeId.isEmpty else { return }
    openGlobalCommandInTerminalPanel(
      command: "tailscale set --exit-node=\(shellQuote(selectedExitNodeId))",
      title: "tailscale set --exit-node"
    )
  }

  private func clearSelectedExitNode() {
    openGlobalCommandInTerminalPanel(
      command: "tailscale set --exit-node=",
      title: "tailscale clear exit node"
    )
  }

  private func shellQuote(_ value: String) -> String {
    let escaped = value.replacingOccurrences(of: "'", with: "'\\''")
    return "'\(escaped)'"
  }

  private func openTailscaleAuthKeysPage() {
    guard let url = URL(string: "https://login.tailscale.com/admin/settings/keys") else {
      return
    }
    NSWorkspace.shared.open(url)
  }
}

private struct PermissionsSettingsView: View {
  @AppStorage("hackDesktop.permissions.terminalAutomationChecked") private var automationChecked = false
  @AppStorage("hackDesktop.permissions.terminalAutomationGranted") private var storedAutomationGranted = false
  @State private var lastAutomationCheckAt: Date? = nil

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        SettingsSectionHeader(
          breadcrumb: "Settings / Permissions",
          title: "Permissions + Access",
          subtitle: "Required OS access for terminal automation, networking, and embedded terminal features"
        )

        GlassCard(title: "Permission matrix", systemImage: "hand.raised.fill") {
          VStack(alignment: .leading, spacing: 12) {
            permissionStatusRow(
              title: "Terminal automation",
              detail: automationStatusDetail,
              granted: automationGranted,
              actionLabel: automationGranted == true ? nil : "Request",
              action: automationGranted == true
                ? nil
                : {
                  let granted = TerminalIntegration.requestTerminalAutomationPermission()
                  storedAutomationGranted = granted
                  automationChecked = true
                  lastAutomationCheckAt = Date()
                }
            )
            permissionStatusRow(
              title: "Embedded terminal",
              detail: GhosttyVTRuntime.shared.isAvailable
                ? "Ghostty VT runtime is available."
                : "Ghostty VT runtime is unavailable on this system.",
              granted: GhosttyVTRuntime.shared.isAvailable
            )
            permissionStatusRow(
              title: "Filesystem access",
              detail: "Desktop app is running in developer tooling mode (sandbox disabled).",
              granted: true
            )
            permissionStatusRow(
              title: "Local network",
              detail: "Managed by macOS and prompted on first local-network access.",
              granted: nil
            )
          }
        }

        InlineCallout(
          tone: automationGranted == true ? .good : .warn,
          title: automationGranted == true ? "Permissions look good" : "Terminal automation still missing",
          message: automationGranted == true
            ? "Automation access is approved. macOS still prompts local-network permission when first needed."
            : "Grant Terminal automation so the app can execute setup and maintenance commands without manual copy/paste.",
          actions: [
            InlineCalloutAction(label: "Open Automation privacy", systemImage: "gearshape") {
              openSystemSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_Automation")
            },
            InlineCalloutAction(label: "Open Local Network privacy", systemImage: "network") {
              openSystemSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork")
            }
          ]
        )

        GlassCard(title: "What each permission does", systemImage: "questionmark.circle") {
          VStack(alignment: .leading, spacing: 8) {
            helperLine(
              title: "Terminal automation",
              body: "Needed for one-click setup flows that open/run commands in Terminal."
            )
            helperLine(
              title: "Embedded terminal",
              body: "Powers inline shells/log tails without leaving the desktop app."
            )
            helperLine(
              title: "Local network",
              body: "Required when exposing gateway to LAN or connecting to local service hostnames."
            )
          }
        }

        GlassCard(title: "Setup helpers", systemImage: "wand.and.stars") {
          VStack(alignment: .leading, spacing: 10) {
            Text("Use setup commands when permissions or trust state changes:")
              .font(.mono(.caption))
              .foregroundStyle(.secondary)
            HStack(spacing: 10) {
              Button("Run global install") {
                TerminalIntegration.openTerminalWithCommand("hack global install")
              }
              .adaptiveToolbarButton()
              Button("Run global trust") {
                TerminalIntegration.openTerminalWithCommand("hack global trust")
              }
              .adaptiveToolbarButton()
              Button("Restart daemon") {
                TerminalIntegration.openTerminalWithCommand("hack daemon restart")
              }
              .adaptiveToolbarButton()
              Spacer()
            }
          }
        }
      }
      .padding(16)
    }
  }

  private var automationGranted: Bool? {
    automationChecked ? storedAutomationGranted : nil
  }

  private var automationStatusDetail: String {
    let base = automationChecked
      ? (storedAutomationGranted ? "Granted." : "Denied or not granted.")
      : "Not checked yet."
    if let lastAutomationCheckAt {
      return "\(base) Last check \(relativeTimeString(from: lastAutomationCheckAt))."
    }
    return base
  }

  private func permissionStatusRow(
    title: String,
    detail: String,
    granted: Bool?,
    actionLabel: String? = nil,
    action: (() -> Void)? = nil
  ) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: permissionIcon(granted: granted))
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(permissionColor(granted: granted))
        .padding(.top, 1)
      VStack(alignment: .leading, spacing: 4) {
        Text(title)
          .font(.mono(.subheadline, weight: .semibold))
        Text(detail)
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
      }
      Spacer()
      if let actionLabel, let action {
        Button(actionLabel) {
          action()
        }
        .adaptiveToolbarButton()
      } else {
        Text(permissionLabel(granted: granted))
          .font(.mono(.caption2, weight: .semibold))
          .foregroundStyle(permissionColor(granted: granted))
      }
    }
  }

  private func permissionIcon(granted: Bool?) -> String {
    switch granted {
    case true:
      return "checkmark.circle.fill"
    case false:
      return "xmark.circle.fill"
    case .none:
      return "questionmark.circle.fill"
    }
  }

  private func permissionLabel(granted: Bool?) -> String {
    switch granted {
    case true:
      return "Approved"
    case false:
      return "Missing"
    case .none:
      return "System-managed"
    }
  }

  private func permissionColor(granted: Bool?) -> Color {
    switch granted {
    case true:
      return .green
    case false:
      return .orange
    case .none:
      return .secondary
    }
  }

  private func openSystemSettings(_ urlString: String) {
    guard let url = URL(string: urlString) else { return }
    NSWorkspace.shared.open(url)
  }

  private func relativeTimeString(from date: Date) -> String {
    RelativeDateTimeFormatter().localizedString(for: date, relativeTo: Date())
  }

  private func helperLine(title: String, body: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title)
        .font(.mono(.subheadline, weight: .semibold))
      Text(body)
        .font(.mono(.caption))
        .foregroundStyle(.secondary)
    }
  }
}

private struct CertificatesSettingsView: View {
  @Environment(\.openURL) private var openURL

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        SettingsSectionHeader(
          breadcrumb: "Settings / Certificates",
          title: "Certificates",
          subtitle: "Inspect local trust assets and run trust tooling"
        )
        GlassCard(title: "Certificate files", systemImage: "checkmark.shield") {
          DetailRows(rows: certificateRows, labelWidth: 170)
        }
        InlineCallout(
          tone: .neutral,
          title: "Certificate management",
          message: "Use `hack global trust` to install or refresh local trust chain. Generated cert files are kept under ~/.hack and mkcert paths.",
          actions: [
            InlineCalloutAction(label: "Run trust", systemImage: "terminal") {
              TerminalIntegration.openTerminalWithCommand("hack global trust")
            },
            InlineCalloutAction(label: "Open cert folder", systemImage: "folder") {
              openURL(URL(fileURLWithPath: certDirectoryPath))
            },
            InlineCalloutAction(label: "Copy trust command", systemImage: "doc.on.doc") {
              TerminalIntegration.copyToClipboard("hack global trust")
            }
          ]
        )
      }
      .padding(16)
    }
  }

  private var certDirectoryPath: String {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".hack/caddy/pki")
      .path
  }

  private var certificateRows: [DetailRowItem] {
    certificateFiles.map { cert in
      let exists = FileManager.default.fileExists(atPath: cert.path) ? "Yes" : "No"
      return DetailRowItem(label: cert.label, value: "\(cert.path)  (\(exists))")
    }
  }

  private var certificateFiles: [(label: String, path: String)] {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    return [
      ("Hack local CA", "\(home)/.hack/caddy/pki/caddy-local-authority.crt"),
      ("Hack local CA key", "\(home)/.hack/caddy/pki/caddy-local-authority.key"),
      ("mkcert root CA", "\(home)/Library/Application Support/mkcert/rootCA.pem"),
      ("mkcert root key", "\(home)/Library/Application Support/mkcert/rootCA-key.pem")
    ]
  }
}

private struct LoggingSettingsView: View {
  @Environment(DashboardModel.self) private var model
  @Environment(\.openURL) private var openURL

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        SettingsSectionHeader(
          breadcrumb: "Settings / Logging",
          title: "Logging + Global Services",
          subtitle: "Grafana + Loki stack, credentials, and Caddy/CoreDNS diagnostics"
        )
        InlineCallout(
          tone: .neutral,
          title: "Global logging architecture",
          message: "Global logging runs Loki + Alloy + Grafana. Logs from project containers are shipped into Loki and explored in Grafana.",
          actions: []
        )
        GlassCard(title: "Grafana + Loki access", systemImage: "waveform.path.ecg") {
          DetailRows(rows: grafanaRows)
          HStack(spacing: 10) {
            if let grafanaURL {
              Button("Open Grafana") {
                openURL(grafanaURL)
              }
              .adaptiveToolbarButtonProminent()
            }
            Button("Open Grafana logs") {
              openGlobalCommandInTerminalPanel(
                command: "hack global logs grafana --tail 200 --follow",
                title: "grafana logs"
              )
            }
            .adaptiveToolbarButton()
            Button("Open Loki logs") {
              openGlobalCommandInTerminalPanel(
                command: "hack global logs loki --tail 200 --follow",
                title: "loki logs"
              )
            }
            .adaptiveToolbarButton()
            Button("Copy LogQL example") {
              TerminalIntegration.copyToClipboard("{project=\"event-agent\"}")
            }
            .adaptiveToolbarButton()
            Spacer()
          }
          Text("Logging is part of global infrastructure and currently has no separate enable/disable toggle.")
            .font(.mono(.caption2))
            .foregroundStyle(.secondary)
        }
        GlassCard(title: "Grafana credentials", systemImage: "person.crop.circle.badge.key") {
          DetailRows(rows: credentialRows, labelWidth: 190)
          Text("Default template credentials are `admin` / `admin`. Override by editing the logging compose environment and restarting global services.")
            .font(.mono(.caption))
            .foregroundStyle(.secondary)
          HStack(spacing: 10) {
            Button("Reset Grafana admin password") {
              openGlobalCommandInTerminalPanel(
                command: """
                  read -r -s -p "New Grafana admin password: " GRAFANA_PASSWORD; echo
                  docker compose -f "$HOME/.hack/logging/docker-compose.yml" exec grafana grafana-cli admin reset-admin-password "$GRAFANA_PASSWORD"
                  """,
                title: "reset grafana password"
              )
            }
            .adaptiveToolbarButton()
            Button("Open logging compose") {
              openURL(URL(fileURLWithPath: loggingComposePath))
            }
            .adaptiveToolbarButton()
            Button("Copy logging compose path") {
              TerminalIntegration.copyToClipboard(loggingComposePath)
            }
            .adaptiveToolbarButton()
            Spacer()
          }
        }
        GlassCard(title: "Caddy + CoreDNS", systemImage: "network") {
          DetailRows(rows: caddyRows)
          Text("Advanced Caddy/CoreDNS settings can be edited in ~/.hack/caddy/docker-compose.yml and ~/.hack/caddy/Corefile.")
            .font(.mono(.caption))
            .foregroundStyle(.secondary)
          HStack(spacing: 10) {
            Button("Open Caddy logs") {
              openGlobalCommandInTerminalPanel(
                command: "hack global logs caddy --tail 200 --follow",
                title: "caddy logs"
              )
            }
            .adaptiveToolbarButton()
            Button("Open CoreDNS logs") {
              openGlobalCommandInTerminalPanel(
                command: "docker compose -f \"$HOME/.hack/caddy/docker-compose.yml\" logs --tail 200 -f coredns",
                title: "coredns logs"
              )
            }
            .adaptiveToolbarButton()
            Button("Open Caddy compose") {
              openURL(URL(fileURLWithPath: caddyComposePath))
            }
            .adaptiveToolbarButton()
            Spacer()
          }
        }
        GlassCard(title: "Global summary", systemImage: "waveform.path.ecg") {
          DetailRows(rows: summaryRows)
        }
        if let caddy = model.globalStatus?.caddy {
          composeGroupCard(title: "Caddy", group: caddy)
        }
        if let logging = model.globalStatus?.logging {
          composeGroupCard(title: "Logging", group: logging)
        }
        if let daemonLogPath = model.daemonStatus?.logPath, !daemonLogPath.isEmpty {
          GlassCard(title: "Daemon log", systemImage: "doc.text") {
            DetailRows(rows: [DetailRowItem(label: "Path", value: daemonLogPath)])
            HStack(spacing: 10) {
              Button("Open log file") {
                openURL(URL(fileURLWithPath: daemonLogPath))
              }
              .adaptiveToolbarButton()
              Button("Copy path") {
                TerminalIntegration.copyToClipboard(daemonLogPath)
              }
              .adaptiveToolbarButton()
            }
          }
        }
      }
      .padding(16)
    }
  }

  private var homeDirectoryPath: String {
    FileManager.default.homeDirectoryForCurrentUser.path
  }

  private var loggingComposePath: String {
    "\(homeDirectoryPath)/.hack/logging/docker-compose.yml"
  }

  private var caddyComposePath: String {
    "\(homeDirectoryPath)/.hack/caddy/docker-compose.yml"
  }

  private var grafanaURL: URL? {
    URL(string: "https://logs.hack")
  }

  private var grafanaRows: [DetailRowItem] {
    [
      DetailRowItem(label: "Grafana URL", value: "https://logs.hack"),
      DetailRowItem(label: "Loki URL", value: "https://loki.hack"),
      DetailRowItem(label: "Stack health", value: okUnknown(model.globalStatus?.summary.loggingOk)),
      DetailRowItem(label: "Generated", value: model.globalStatus?.generatedAt ?? "—")
    ]
  }

  private var credentialRows: [DetailRowItem] {
    [
      DetailRowItem(label: "Default username", value: "admin"),
      DetailRowItem(label: "Default password", value: "admin"),
      DetailRowItem(label: "Compose file", value: loggingComposePath)
    ]
  }

  private var caddyRows: [DetailRowItem] {
    let gatewayBind = model.globalStatus?.gateway?.gatewayBind ?? "127.0.0.1"
    let gatewayPort = model.globalStatus?.gateway?.gatewayPort.map(String.init) ?? "7788"
    let devNetwork = model.globalStatus?.networks?.networks.first(where: { $0.name == "hack-dev" })
    return [
      DetailRowItem(label: "Gateway bind", value: gatewayBind),
      DetailRowItem(label: "Gateway port", value: gatewayPort),
      DetailRowItem(label: "Caddy default IP", value: "172.30.0.2"),
      DetailRowItem(label: "CoreDNS default IP", value: "172.30.0.53"),
      DetailRowItem(label: "Ingress network", value: devNetwork?.name ?? "hack-dev"),
      DetailRowItem(label: "Ingress driver", value: devNetwork?.driver ?? "bridge"),
      DetailRowItem(label: "Caddy compose", value: caddyComposePath)
    ]
  }

  private var summaryRows: [DetailRowItem] {
    let summary = model.globalStatus?.summary
    return [
      DetailRowItem(label: "Overall", value: okUnknown(summary?.ok)),
      DetailRowItem(label: "Caddy", value: okUnknown(summary?.caddyOk)),
      DetailRowItem(label: "Logging", value: okUnknown(summary?.loggingOk)),
      DetailRowItem(label: "Networks", value: okUnknown(summary?.networksOk)),
      DetailRowItem(label: "Generated", value: model.globalStatus?.generatedAt ?? "—")
    ]
  }

  private func composeGroupCard(title: String, group: ComposeStatusGroup) -> some View {
    GlassCard(title: title, systemImage: "shippingbox") {
      if group.services.isEmpty {
        Text("No services reported.")
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
      } else {
        VStack(alignment: .leading, spacing: 10) {
          ForEach(group.services, id: \.name) { service in
            HStack(spacing: 10) {
              Text(service.name)
                .font(.mono(.subheadline, weight: .medium))
              Spacer()
              Text(service.status)
                .font(.mono(.caption))
                .foregroundStyle(.secondary)
            }
            if !service.ports.isEmpty {
              Text(service.ports)
                .font(.mono(.caption2))
                .foregroundStyle(.secondary)
            }
            Divider()
              .opacity(0.2)
          }
        }
      }
    }
  }

  private func okUnknown(_ value: Bool?) -> String {
    guard let value else { return "Unknown" }
    return value ? "Healthy" : "Degraded"
  }
}

private struct GlobalConfigSnapshot {
  let daemonLaunchdRunAtLoad: Bool?
  let linearExtensionEnabled: Bool?
  let githubExtensionEnabled: Bool?
  let cloudflareExtensionEnabled: Bool?
  let railwayExtensionEnabled: Bool?
  let tailscaleExtensionEnabled: Bool?
  let linearDefaultProfile: String?
  let linearSyncLabels: Bool?
  let linearSyncStatuses: Bool?
  let linearSyncDependencies: Bool?
  let linearSyncProjects: Bool?
  let githubDefaultProfile: String?
  let railwayProject: String?
  let railwayService: String?
  let railwayEnvironment: String?
  let railwayWorkspace: String?
  let railwayNodeName: String?
  let railwayLabelsCsv: String?
  let railwayEndpoint: String?
  let railwayCreateService: Bool?
  let railwayImage: String?
  let railwayPrivate: Bool?
  let railwayTailscaleAuthKey: String?
  let railwayTailscaleTagsCsv: String?
  let tailscaleAuthKey: String?
  let gatewayBind: String?
  let cloudflareHostname: String?
  let cloudflareSSHHostname: String?
  let supervisorEnabled: Bool?
  let supervisorMaxConcurrentJobs: Int?
  let supervisorLogsMaxBytes: Int?
  let preferencesTheme: String?
  let preferencesTerminalApp: String?
  let preferencesEditorApp: String?
  let preferencesCodingAgentApp: String?
  let preferencesSessionProvider: String?
  let preferencesSessionBinaryPath: String?
  let preferencesContainerProvider: String?
  let preferencesContainerBinaryPath: String?
  let preferencesCodingAgentBinaryPath: String?

  static func load() -> Self {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let environment = ProcessInfo.processInfo.environment
    let overridePath = (environment["HACK_GLOBAL_CONFIG_PATH"] ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let configPath: String
    if overridePath.isEmpty {
      configPath = home.appendingPathComponent(".hack/hack.config.json").path
    } else {
      configPath = NSString(string: overridePath).expandingTildeInPath
    }
    guard
      let data = FileManager.default.contents(atPath: configPath),
      let object = try? JSONSerialization.jsonObject(with: data),
      let root = object as? [String: Any]
    else {
      return .empty
    }

    let controlPlane = dictionary(root, key: "controlPlane")
    let daemon = dictionary(controlPlane, key: "daemon")
    let launchd = dictionary(daemon, key: "launchd")
    let supervisor = dictionary(controlPlane, key: "supervisor")
    let gateway = dictionary(controlPlane, key: "gateway")
    let preferences = dictionary(controlPlane, key: "preferences")
    let appearancePreferences = dictionary(preferences, key: "appearance")
    let terminalPreferences = dictionary(preferences, key: "terminal")
    let editorPreferences = dictionary(preferences, key: "editor")
    let agentPreferences = dictionary(preferences, key: "agents")
    let sessionPreferences = dictionary(preferences, key: "sessions")
    let containerPreferences = dictionary(preferences, key: "containers")
    let extensions = dictionary(controlPlane, key: "extensions")
    let linearExt = dictionary(extensions, key: "dance.hack.linear")
    let githubExt = dictionary(extensions, key: "dance.hack.github")
    let cloudflareExt = dictionary(extensions, key: "dance.hack.cloudflare")
    let railwayExt = dictionary(extensions, key: "dance.hack.railway")
    let tailscaleExt = dictionary(extensions, key: "dance.hack.tailscale")
    let linearConfig = dictionary(linearExt, key: "config")
    let linearSync = dictionary(linearConfig, key: "sync")
    let githubConfig = dictionary(githubExt, key: "config")
    let cloudflareConfig = dictionary(cloudflareExt, key: "config")
    let railwayConfig = dictionary(railwayExt, key: "config")
    let tailscaleConfig = dictionary(tailscaleExt, key: "config")

    return Self(
      daemonLaunchdRunAtLoad: launchd["runAtLoad"] as? Bool,
      linearExtensionEnabled: linearExt["enabled"] as? Bool,
      githubExtensionEnabled: githubExt["enabled"] as? Bool,
      cloudflareExtensionEnabled: cloudflareExt["enabled"] as? Bool,
      railwayExtensionEnabled: railwayExt["enabled"] as? Bool,
      tailscaleExtensionEnabled: tailscaleExt["enabled"] as? Bool,
      linearDefaultProfile: linearConfig["defaultProfile"] as? String,
      linearSyncLabels: linearSync["labels"] as? Bool,
      linearSyncStatuses: linearSync["statuses"] as? Bool,
      linearSyncDependencies: linearSync["dependencies"] as? Bool,
      linearSyncProjects: linearSync["projects"] as? Bool,
      githubDefaultProfile: githubConfig["defaultProfile"] as? String,
      railwayProject: railwayConfig["project"] as? String,
      railwayService: railwayConfig["service"] as? String,
      railwayEnvironment: railwayConfig["environment"] as? String,
      railwayWorkspace: railwayConfig["workspace"] as? String,
      railwayNodeName: railwayConfig["nodeName"] as? String,
      railwayLabelsCsv: railwayConfig["labelsCsv"] as? String,
      railwayEndpoint: railwayConfig["endpoint"] as? String,
      railwayCreateService: railwayConfig["createService"] as? Bool,
      railwayImage: railwayConfig["image"] as? String,
      railwayPrivate: railwayConfig["private"] as? Bool,
      railwayTailscaleAuthKey: railwayConfig["tailscaleAuthKey"] as? String,
      railwayTailscaleTagsCsv: railwayConfig["tailscaleTagsCsv"] as? String,
      tailscaleAuthKey: tailscaleConfig["authKey"] as? String,
      gatewayBind: gateway["bind"] as? String,
      cloudflareHostname: cloudflareConfig["hostname"] as? String,
      cloudflareSSHHostname: cloudflareConfig["sshHostname"] as? String,
      supervisorEnabled: supervisor["enabled"] as? Bool,
      supervisorMaxConcurrentJobs: supervisor["maxConcurrentJobs"] as? Int,
      supervisorLogsMaxBytes: supervisor["logsMaxBytes"] as? Int,
      preferencesTheme: appearancePreferences["theme"] as? String,
      preferencesTerminalApp: terminalPreferences["defaultApp"] as? String,
      preferencesEditorApp: editorPreferences["defaultApp"] as? String,
      preferencesCodingAgentApp: agentPreferences["defaultApp"] as? String,
      preferencesSessionProvider: sessionPreferences["provider"] as? String,
      preferencesSessionBinaryPath: sessionPreferences["binaryPath"] as? String,
      preferencesContainerProvider: containerPreferences["provider"] as? String,
      preferencesContainerBinaryPath: containerPreferences["binaryPath"] as? String,
      preferencesCodingAgentBinaryPath: agentPreferences["binaryPath"] as? String
    )
  }

  static var empty: Self {
    Self(
      daemonLaunchdRunAtLoad: nil,
      linearExtensionEnabled: nil,
      githubExtensionEnabled: nil,
      cloudflareExtensionEnabled: nil,
      railwayExtensionEnabled: nil,
      tailscaleExtensionEnabled: nil,
      linearDefaultProfile: nil,
      linearSyncLabels: nil,
      linearSyncStatuses: nil,
      linearSyncDependencies: nil,
      linearSyncProjects: nil,
      githubDefaultProfile: nil,
      railwayProject: nil,
      railwayService: nil,
      railwayEnvironment: nil,
      railwayWorkspace: nil,
      railwayNodeName: nil,
      railwayLabelsCsv: nil,
      railwayEndpoint: nil,
      railwayCreateService: nil,
      railwayImage: nil,
      railwayPrivate: nil,
      railwayTailscaleAuthKey: nil,
      railwayTailscaleTagsCsv: nil,
      tailscaleAuthKey: nil,
      gatewayBind: nil,
      cloudflareHostname: nil,
      cloudflareSSHHostname: nil,
      supervisorEnabled: nil,
      supervisorMaxConcurrentJobs: nil,
      supervisorLogsMaxBytes: nil,
      preferencesTheme: nil,
      preferencesTerminalApp: nil,
      preferencesEditorApp: nil,
      preferencesCodingAgentApp: nil,
      preferencesSessionProvider: nil,
      preferencesSessionBinaryPath: nil,
      preferencesContainerProvider: nil,
      preferencesContainerBinaryPath: nil,
      preferencesCodingAgentBinaryPath: nil
    )
  }

  private static func dictionary(_ source: [String: Any], key: String) -> [String: Any] {
    source[key] as? [String: Any] ?? [:]
  }
}

func openGlobalCommandInTerminalPanel(command: String, title: String) {
  NotificationCenter.default.post(
    name: .hackTerminalOpenRequested,
    object: nil,
    userInfo: [
      TerminalOpenRequest.projectIdKey: "global-shell",
      TerminalOpenRequest.kindKey: TerminalDrawerModel.Kind.shell.rawValue,
      TerminalOpenRequest.commandKey: command,
      TerminalOpenRequest.titleKey: title
    ]
  )
}

private func resolveExecutablePath(candidates: [String]) -> String? {
  let fileManager = FileManager.default
  let envPath = ProcessInfo.processInfo.environment["PATH"] ?? ""
  for entry in envPath.split(separator: ":") {
    for candidate in candidates {
      let path = "\(entry)/\(candidate)"
      if fileManager.isExecutableFile(atPath: path) {
        return path
      }
    }
  }

  let fallbackDirectories = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
  for directory in fallbackDirectories {
    for candidate in candidates {
      let path = "\(directory)/\(candidate)"
      if fileManager.isExecutableFile(atPath: path) {
        return path
      }
    }
  }

  return nil
}

private func resolveInstalledApplicationPath(
  bundleIdentifiers: [String],
  fallbackPaths: [String]
) -> String? {
  let workspace = NSWorkspace.shared
  for bundleIdentifier in bundleIdentifiers {
    if let url = workspace.urlForApplication(withBundleIdentifier: bundleIdentifier) {
      return url.path
    }
  }
  for path in fallbackPaths where FileManager.default.fileExists(atPath: path) {
    return path
  }
  return nil
}

private func openExecutablePanel() -> String? {
  let panel = NSOpenPanel()
  panel.canChooseFiles = true
  panel.canChooseDirectories = false
  panel.allowsMultipleSelection = false
  panel.canCreateDirectories = false
  panel.prompt = "Select"
  panel.title = "Choose executable"

  guard panel.runModal() == .OK else { return nil }
  return panel.url?.path
}
