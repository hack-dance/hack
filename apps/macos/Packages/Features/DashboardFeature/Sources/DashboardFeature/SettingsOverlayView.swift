import AppKit
import Darwin
import SwiftUI

import GhosttyTerminal
import HackDesktopModels

enum SettingsSidebarItem: String, Hashable, Identifiable {
  case preferences
  case updates
  case runtime
  case gateway
  case global
  case supervisor
  case permissions
  case extensions
  case cloudflare
  case tailscale
  case certificates
  case logging

  var id: String { rawValue }

  var title: String {
    switch self {
    case .preferences:
      return "Preferences"
    case .updates:
      return "Updates"
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
    case .extensions:
      return "Extensions"
    case .cloudflare:
      return "Cloudflare"
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
    case .preferences:
      return "slider.horizontal.3"
    case .updates:
      return "arrow.triangle.2.circlepath"
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
    case .extensions:
      return "puzzlepiece.extension"
    case .cloudflare:
      return "cloud"
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
      Section("Preferences") {
        settingsRow(.preferences)
        settingsRow(.updates)
      }
      Section("System") {
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
      Section("Extensions") {
        settingsRow(.extensions)
        settingsRow(.cloudflare)
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
      case .preferences:
        PreferencesSettingsView()
      case .updates:
        UpdatesSettingsView()
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
      case .extensions:
        ExtensionsSettingsView(selection: $selection)
      case .cloudflare:
        CloudflareExtensionSettingsView()
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
}

private struct SettingsSectionHeader: View {
  let breadcrumb: String
  let title: String
  let subtitle: String

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(breadcrumb)
        .font(.mono(.caption2))
        .foregroundStyle(.secondary)
      Text(title)
        .font(.mono(.headline, weight: .semibold))
      Text(subtitle)
        .font(.mono(.caption))
        .foregroundStyle(.secondary)
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
          message: "Cloudflare, Tailscale, and Supervisor settings now live on their dedicated pages so each extension has focused setup and diagnostics.",
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
          breadcrumb: "Settings / Extensions / Cloudflare",
          title: "Cloudflare Extension",
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

private struct TailscaleExtensionSettingsView: View {
  @Environment(DashboardModel.self) private var model
  @State private var isLoadingConfig = false
  @State private var isSavingToggle = false
  @State private var isLoadingDiagnostics = false
  @State private var suppressEnabledToggleChange = false
  @State private var enabled = false
  @State private var diagnostics: TailscaleInspectResponse? = nil
  @State private var selectedExitNodeId = ""
  @State private var lastDiagnosticsRefreshAt: Date? = nil

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        SettingsSectionHeader(
          breadcrumb: "Settings / Extensions / Tailscale",
          title: "Tailscale Extension",
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
        GlassCard(title: "Tailnet controls", systemImage: "slider.horizontal.3") {
          VStack(alignment: .leading, spacing: 12) {
            Text("The extension controls gateway exposure behavior, while Tailscale runtime state is shown here regardless of extension enablement.")
              .font(.mono(.caption))
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

            if !exitNodes.isEmpty {
              Divider()
                .opacity(0.2)

              HStack(alignment: .center, spacing: 10) {
                Picker("Exit node", selection: $selectedExitNodeId) {
                  Text("No exit node").tag("")
                  ForEach(exitNodes, id: \.id) { peer in
                    Text(peer.hostname).tag(peer.id)
                  }
                }
                .pickerStyle(.menu)
                .frame(minWidth: 220, alignment: .leading)

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

        VStack(alignment: .leading, spacing: 6) {
          Text("Exit nodes")
            .font(.mono(.caption, weight: .semibold))
            .foregroundStyle(.secondary)
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

        if !taggedPeers.isEmpty {
          Divider()
            .opacity(0.2)

          VStack(alignment: .leading, spacing: 6) {
            Text("Tagged devices (\(taggedPeers.filter(\.online).count)/\(taggedPeers.count) online)")
              .font(.mono(.caption, weight: .semibold))
              .foregroundStyle(.secondary)
            ForEach(Array(taggedPeers.prefix(12)), id: \.id) { peer in
              tailscalePeerRow(peer)
            }
          }
        }

        Divider()
          .opacity(0.2)

        VStack(alignment: .leading, spacing: 6) {
          Text("Devices (\(diagnostics?.onlinePeerCount ?? 0)/\(diagnostics?.peers.count ?? 0) online)")
            .font(.mono(.caption, weight: .semibold))
            .foregroundStyle(.secondary)
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

  private func loadConfigFromDisk() async {
    isLoadingConfig = true
    let snapshot = GlobalConfigSnapshot.load()
    suppressEnabledToggleChange = true
    enabled = snapshot.tailscaleExtensionEnabled ?? false
    suppressEnabledToggleChange = false
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

private struct ExtensionsSettingsView: View {
  @Environment(DashboardModel.self) private var model
  @Binding var selection: SettingsSidebarItem
  @State private var isLoading = false
  @State private var suppressToggleChange = false
  @State private var cloudflareEnabled = false
  @State private var tailscaleEnabled = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        SettingsSectionHeader(
          breadcrumb: "Settings / Extensions",
          title: "Extensions",
          subtitle: "External connectivity integrations available in this workspace"
        )
        InlineCallout(
          tone: .neutral,
          title: "Built-ins are hidden",
          message: "Internal components like gateway, tickets, and supervisor are configured on dedicated system pages and are intentionally omitted from the extension list.",
          actions: []
        )
        GlassCard(title: "Managed extensions", systemImage: "puzzlepiece.extension") {
          VStack(alignment: .leading, spacing: 12) {
            extensionSummaryRow(
              item: .cloudflare,
              name: "Cloudflare",
              description: "Public HTTPS + SSH tunnel exposure via cloudflared.",
              projectCount: projectCount(for: "dance.hack.cloudflare"),
              exposure: extensionExposure(id: "cloudflare"),
              isOn: $cloudflareEnabled
            )
            Divider()
              .opacity(0.2)
            extensionSummaryRow(
              item: .tailscale,
              name: "Tailscale",
              description: "Tailnet exposure and secure remote access.",
              projectCount: projectCount(for: "dance.hack.tailscale"),
              exposure: extensionExposure(id: "tailscale"),
              isOn: $tailscaleEnabled
            )
            if isLoading {
              HStack(spacing: 8) {
                ProgressView()
                  .controlSize(.small)
                Text("Saving extension settings…")
                  .font(.mono(.caption))
                  .foregroundStyle(.secondary)
              }
            }
          }
        }
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

  private func extensionSummaryRow(
    item: SettingsSidebarItem,
    name: String,
    description: String,
    projectCount: Int,
    exposure: GatewayExposure?,
    isOn: Binding<Bool>
  ) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 8) {
        Text(name)
          .font(.mono(.subheadline, weight: .semibold))
        Spacer()
        Toggle("", isOn: isOn)
          .toggleStyle(.switch)
          .labelsHidden()
          .onTapGesture {
            // Prevent row navigation tap when toggling inline.
          }
          .onChange(of: isOn.wrappedValue) { _, newValue in
            guard !suppressToggleChange else { return }
            Task {
              await setExtensionEnabled(item: item, enabled: newValue)
            }
          }
        if let exposure {
          StatusPill(text: exposure.statusLabel, tone: exposure.statusTone)
        } else {
          StatusPill(text: "Unknown", tone: .neutral)
        }
        Image(systemName: "chevron.right")
          .font(.mono(.caption))
          .foregroundStyle(.tertiary)
      }
      Text(description)
        .font(.mono(.caption))
        .foregroundStyle(.secondary)
      Text("\(projectCount) project\(projectCount == 1 ? "" : "s") enabled")
        .font(.mono(.caption2))
        .foregroundStyle(.tertiary)
      if let detail = exposure?.detail, !detail.isEmpty {
        Text(detail)
          .font(.mono(.caption2))
          .foregroundStyle(.secondary)
      }
    }
    .contentShape(Rectangle())
    .onTapGesture {
      selection = item
    }
  }

  private func projectCount(for extensionId: String) -> Int {
    model.projects.filter { project in
      canonicalExtensionIds(for: project).contains(extensionId)
    }.count
  }

  private func canonicalExtensionIds(for project: ProjectSummary) -> Set<String> {
    var ids: Set<String> = []
    for value in (project.extensionsEnabled ?? []) + (project.features ?? []) {
      let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      switch normalized {
      case "cloudflare", "dance.hack.cloudflare":
        ids.insert("dance.hack.cloudflare")
      case "tailscale", "dance.hack.tailscale":
        ids.insert("dance.hack.tailscale")
      default:
        continue
      }
    }
    return ids
  }

  private func extensionExposure(id: String) -> GatewayExposure? {
    model.globalStatus?.gateway?.exposures?.first(where: { $0.id == id })
  }

  private func loadConfigFromDisk() async {
    let snapshot = GlobalConfigSnapshot.load()
    suppressToggleChange = true
    cloudflareEnabled = snapshot.cloudflareExtensionEnabled ?? false
    tailscaleEnabled = snapshot.tailscaleExtensionEnabled ?? false
    suppressToggleChange = false
  }

  private func setExtensionEnabled(
    item: SettingsSidebarItem,
    enabled: Bool
  ) async {
    isLoading = true
    defer { isLoading = false }

    let key: String
    switch item {
    case .cloudflare:
      key = "controlPlane.extensions[\"dance.hack.cloudflare\"].enabled"
    case .tailscale:
      key = "controlPlane.extensions[\"dance.hack.tailscale\"].enabled"
    default:
      return
    }

    let didUpdate = await model.setGlobalConfig(
      key: key,
      value: enabled ? "true" : "false"
    )
    guard didUpdate else {
      await loadConfigFromDisk()
      return
    }
    await loadConfigFromDisk()
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
  let cloudflareExtensionEnabled: Bool?
  let tailscaleExtensionEnabled: Bool?
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
    let cloudflareExt = dictionary(extensions, key: "dance.hack.cloudflare")
    let tailscaleExt = dictionary(extensions, key: "dance.hack.tailscale")
    let cloudflareConfig = dictionary(cloudflareExt, key: "config")

    return Self(
      daemonLaunchdRunAtLoad: launchd["runAtLoad"] as? Bool,
      cloudflareExtensionEnabled: cloudflareExt["enabled"] as? Bool,
      tailscaleExtensionEnabled: tailscaleExt["enabled"] as? Bool,
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
      cloudflareExtensionEnabled: nil,
      tailscaleExtensionEnabled: nil,
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
