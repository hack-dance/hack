import AppKit
import SwiftUI

import HackDesktopModels

enum SettingsSidebarItem: String, Hashable, Identifiable {
  case preferences
  case updates
  case runtime
  case global
  case permissions
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
    case .global:
      return "Global"
    case .permissions:
      return "Permissions"
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
    case .global:
      return "shippingbox"
    case .permissions:
      return "hand.raised.fill"
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
  @Environment(\.colorScheme) private var colorScheme
  @Binding var selection: SettingsSidebarItem
  let onClose: () -> Void

  private let supportedSections: [(title: String, items: [SettingsSidebarItem])] = [
    ("Preferences", [.preferences, .updates]),
    ("System", [.runtime]),
    ("Local Runtime", [.global, .permissions, .certificates, .logging])
  ]

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
      ForEach(supportedSections, id: \.title) { section in
        Section(section.title) {
          ForEach(section.items) { item in
            settingsRow(item)
          }
        }
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
      case .global:
        GlobalSettingsView()
      case .permissions:
        PermissionsSettingsView()
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

private struct PreferencesSettingsView: View {
  @AppStorage("hackDesktop.preferences.defaultTerminal") private var preferredTerminalRaw =
    TerminalIntegration.ExternalTerminalApp.terminal.rawValue
  @AppStorage("hackDesktop.sessions.preferredExternalTerminal") private var legacyPreferredTerminalRaw =
    TerminalIntegration.ExternalTerminalApp.terminal.rawValue
  @AppStorage("hackDesktop.preferences.defaultIDE") private var preferredEditorRaw =
    EditorIntegration.EditorApp.cursor.rawValue
  @AppStorage("hackDesktop.preferences.defaultCodingAgent") private var preferredCodingAgentRaw =
    CodingAgentIntegration.AgentApp.codex.rawValue
  @AppStorage("hackDesktop.preferences.defaultCodingAgentBinaryPath") private var preferredCodingAgentBinaryPathRaw = ""

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        SettingsSectionHeader(
          breadcrumb: "Settings / Preferences",
          title: "Preferences",
          subtitle: "Defaults for local editors, terminals, and coding agents"
        )

        GlassCard(title: "Workspace defaults", systemImage: "slider.horizontal.3") {
          VStack(alignment: .leading, spacing: 14) {
            settingsPicker(
              title: "Default terminal",
              subtitle: "Used when opening external shells or launching editor commands.",
              selection: $preferredTerminalRaw,
              options: terminalOptions.map { ($0.rawValue, $0.displayName) }
            )

            settingsPicker(
              title: "Default editor",
              subtitle: "Used when opening a project in an external editor.",
              selection: $preferredEditorRaw,
              options: editorOptions.map { ($0.rawValue, $0.displayName) }
            )

            settingsPicker(
              title: "Default coding agent",
              subtitle: "Used for quick-open agent actions from the dashboard.",
              selection: $preferredCodingAgentRaw,
              options: codingAgentOptions.map { ($0.rawValue, $0.displayName) }
            )

            VStack(alignment: .leading, spacing: 6) {
              Text("Custom coding agent binary")
                .font(.mono(.caption))
                .foregroundStyle(.secondary)
              TextField("/opt/homebrew/bin/codex", text: $preferredCodingAgentBinaryPathRaw)
                .textFieldStyle(.roundedBorder)
                .font(.mono(.caption))
              Text("Leave blank to auto-detect the preferred agent in PATH.")
                .font(.mono(.caption2))
                .foregroundStyle(.tertiary)
            }
          }
        }

        GlassCard(title: "Detected tools", systemImage: "magnifyingglass") {
          DetailRows(
            rows: [
              DetailRowItem(
                label: "Terminal",
                value: resolvedTerminalSummary
              ),
              DetailRowItem(
                label: "Editor",
                value: resolvedEditorSummary
              ),
              DetailRowItem(
                label: "Coding agent",
                value: resolvedCodingAgentSummary
              )
            ]
          )
        }
      }
      .padding(16)
    }
    .onChange(of: preferredTerminalRaw) { _, value in
      legacyPreferredTerminalRaw = value
    }
  }

  private var terminalOptions: [TerminalIntegration.ExternalTerminalApp] {
    let installed = TerminalIntegration.installedExternalTerminalApps()
    let base: [TerminalIntegration.ExternalTerminalApp] = [.terminal]
    return uniquePreservingOrder(base + installed)
  }

  private var editorOptions: [EditorIntegration.EditorApp] {
    let installed = EditorIntegration.installedEditors()
    return uniquePreservingOrder([.cursor, .vscode, .zed, .neovim] + installed)
  }

  private var codingAgentOptions: [CodingAgentIntegration.AgentApp] {
    let installed = CodingAgentIntegration.installedAgents()
    return uniquePreservingOrder([.codex, .cursor, .gemini, .opencode] + installed)
  }

  private var resolvedTerminalSummary: String {
    let terminal = resolvedTerminal
    let path = TerminalIntegration.resolvedExternalTerminalPath(for: terminal) ?? "PATH or AppleScript"
    return "\(terminal.displayName) • \(path)"
  }

  private var resolvedEditorSummary: String {
    let editor = resolvedEditor
    let path = EditorIntegration.resolvedLocation(for: editor) ?? "Not found"
    return "\(editor.displayName) • \(path)"
  }

  private var resolvedCodingAgentSummary: String {
    let agent = resolvedCodingAgent
    let path = CodingAgentIntegration.resolvedBinaryPath(
      for: agent,
      overridePath: preferredCodingAgentBinaryPathRaw
    ) ?? "Not found"
    return "\(agent.displayName) • \(path)"
  }

  private var resolvedTerminal: TerminalIntegration.ExternalTerminalApp {
    if let explicit = TerminalIntegration.ExternalTerminalApp(rawValue: preferredTerminalRaw) {
      return explicit
    }
    if let legacy = TerminalIntegration.ExternalTerminalApp(rawValue: legacyPreferredTerminalRaw) {
      return legacy
    }
    return .terminal
  }

  private var resolvedEditor: EditorIntegration.EditorApp {
    EditorIntegration.EditorApp(rawValue: preferredEditorRaw) ?? .cursor
  }

  private var resolvedCodingAgent: CodingAgentIntegration.AgentApp {
    CodingAgentIntegration.AgentApp(rawValue: preferredCodingAgentRaw) ?? .codex
  }

  private func settingsPicker(
    title: String,
    subtitle: String,
    selection: Binding<String>,
    options: [(id: String, label: String)]
  ) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title)
        .font(.mono(.caption))
        .foregroundStyle(.secondary)
      Picker(title, selection: selection) {
        ForEach(options, id: \.id) { option in
          Text(option.label)
            .tag(option.id)
        }
      }
      .labelsHidden()
      Text(subtitle)
        .font(.mono(.caption2))
        .foregroundStyle(.tertiary)
    }
  }

  private func uniquePreservingOrder<Value: Hashable>(_ values: [Value]) -> [Value] {
    var seen = Set<Value>()
    var ordered: [Value] = []
    for value in values where seen.insert(value).inserted {
      ordered.append(value)
    }
    return ordered
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
          DetailRows(
            rows: [
              DetailRowItem(label: "Version", value: appVersion),
              DetailRowItem(label: "Build", value: appBuild),
              DetailRowItem(label: "Status", value: updateAvailable ? "Update available" : "Up to date"),
              DetailRowItem(label: "Latest release", value: latestKnownReleaseVersion.isEmpty ? "Unknown" : latestKnownReleaseVersion),
              DetailRowItem(label: "Last checked", value: updateLastCheckedAt.isEmpty ? "Unknown" : formattedTimestamp(updateLastCheckedAt)),
              DetailRowItem(label: "Bundle ID", value: bundleIdentifier),
              DetailRowItem(label: "Appcast", value: appcastURL ?? "Not configured")
            ]
          )
        }

        GlassCard(title: "Update behavior", systemImage: "arrow.clockwise.circle") {
          Toggle("Automatically check for updates", isOn: $automaticallyCheckForUpdates)
            .font(.mono(.subheadline))

          Text("Automatic checks apply to signed release builds that include Sparkle.")
            .font(.mono(.caption2))
            .foregroundStyle(.tertiary)

          HStack(spacing: 10) {
            Button {
              NotificationCenter.default.post(name: .hackCheckForUpdatesRequested, object: nil)
            } label: {
              Label("Check now", systemImage: "arrow.triangle.2.circlepath")
            }
            .adaptiveToolbarButtonProminent()

            if let appcastURL, let url = URL(string: appcastURL) {
              Button {
                NSWorkspace.shared.open(url)
              } label: {
                Label("Open appcast", systemImage: "link")
              }
              .adaptiveToolbarButton()
            }
          }
        }
      }
      .padding(16)
    }
  }

  private var appVersion: String {
    Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Unknown"
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

  private func formattedTimestamp(_ value: String) -> String {
    guard let date = ISO8601DateFormatter().date(from: value) else {
      return value
    }
    return date.formatted(date: .abbreviated, time: .shortened)
  }
}

private struct GlobalSettingsView: View {
  @Environment(DashboardModel.self) private var model

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        SettingsSectionHeader(
          breadcrumb: "Settings / Global",
          title: "Global runtime",
          subtitle: "Control shared local services and inspect machine-wide runtime state"
        )

        GlassCard(title: "Global services", systemImage: "network") {
          HStack(spacing: 8) {
            StatusPill(text: globalStatusText, tone: globalStatusTone)
            Spacer()
          }

          DetailRows(rows: globalRows)

          HStack(spacing: 10) {
            Button {
              Task { await model.toggleGlobalInfrastructure() }
            } label: {
              Label(globalActionTitle, systemImage: model.globalInfraRunning ? "stop.fill" : "play.fill")
            }
            .adaptiveToolbarButtonProminent()

            Button {
              Task { await model.refresh() }
            } label: {
              Label("Refresh", systemImage: "arrow.clockwise")
            }
            .adaptiveToolbarButton()

            Button {
              TerminalIntegration.openTerminalWithCommand("hack global status")
            } label: {
              Label("Open CLI status", systemImage: "terminal")
            }
            .adaptiveToolbarButton()
          }
        }

        GlassCard(title: "Daemon quick actions", systemImage: "bolt.horizontal.circle") {
          DetailRows(rows: daemonRows)

          HStack(spacing: 10) {
            Button {
              Task { await model.startDaemon() }
            } label: {
              Label("Start hackd", systemImage: "play.fill")
            }
            .adaptiveToolbarButtonProminent()
            .disabled(model.daemonStatus?.running == true)

            Button {
              Task { await model.restartDaemon() }
            } label: {
              Label("Restart", systemImage: "arrow.triangle.2.circlepath")
            }
            .adaptiveToolbarButton()

            Button {
              Task { await model.clearDaemon() }
            } label: {
              Label("Clear state", systemImage: "trash")
            }
            .adaptiveToolbarButton()
          }
        }
      }
      .padding(16)
    }
  }

  private var globalStatusText: String {
    if model.globalInfraRunning {
      return "Running"
    }
    if model.globalInfraDown {
      return "Stopped"
    }
    return "Unknown"
  }

  private var globalStatusTone: StatusTone {
    if model.globalInfraRunning {
      return .good
    }
    if model.globalInfraDown {
      return .warn
    }
    return .neutral
  }

  private var globalActionTitle: String {
    model.globalInfraRunning ? "Stop global services" : "Start global services"
  }

  private var globalRows: [DetailRowItem] {
    [
      DetailRowItem(label: "Runtime", value: runtimeValue),
      DetailRowItem(label: "Generated", value: model.globalStatus?.generatedAt ?? "Unknown"),
      DetailRowItem(label: "Caddy", value: serviceState(ok: model.globalStatus?.summary.caddyOk)),
      DetailRowItem(label: "Logging", value: serviceState(ok: model.globalStatus?.summary.loggingOk)),
      DetailRowItem(label: "Networks", value: serviceState(ok: model.globalStatus?.summary.networksOk))
    ]
  }

  private var daemonRows: [DetailRowItem] {
    [
      DetailRowItem(label: "hackd", value: model.daemonStatus?.status?.rawValue ?? daemonStatusFallback),
      DetailRowItem(label: "PID", value: model.daemonStatus?.pid.map(String.init) ?? "Unknown"),
      DetailRowItem(label: "Socket", value: model.daemonStatus?.socketPath ?? "Unknown"),
      DetailRowItem(label: "Log path", value: model.daemonStatus?.logPath ?? "Unknown")
    ]
  }

  private var runtimeValue: String {
    if model.runtimeOverallOk == true {
      return "Healthy"
    }
    if model.runtimeOverallOk == false {
      return "Degraded"
    }
    return "Unknown"
  }

  private var daemonStatusFallback: String {
    if model.daemonStatus?.running == true {
      return "running"
    }
    if model.daemonStatus?.running == false {
      return "stopped"
    }
    return "unknown"
  }

  private func serviceState(ok: Bool?) -> String {
    guard let ok else {
      return "Unknown"
    }
    return ok ? "Ready" : "Needs attention"
  }
}

private struct PermissionsSettingsView: View {
  @State private var terminalAutomationGranted = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        SettingsSectionHeader(
          breadcrumb: "Settings / Permissions",
          title: "Permissions",
          subtitle: "Local trust and automation access needed for the best desktop workflow"
        )

        GlassCard(title: "Terminal automation", systemImage: "terminal") {
          HStack(spacing: 8) {
            StatusPill(
              text: terminalAutomationGranted ? "Granted" : "Needs check",
              tone: terminalAutomationGranted ? .good : .warn
            )
            Spacer()
          }

          Text("Hack Desktop can open and seed commands into Terminal for setup and repair flows. macOS will prompt the first time you grant Automation access.")
            .font(.mono(.caption))
            .foregroundStyle(.secondary)

          HStack(spacing: 10) {
            Button {
              terminalAutomationGranted = TerminalIntegration.requestTerminalAutomationPermission()
            } label: {
              Label("Request access", systemImage: "hand.raised.fill")
            }
            .adaptiveToolbarButtonProminent()

            Button {
              if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation") {
                NSWorkspace.shared.open(url)
              }
            } label: {
              Label("Open Privacy settings", systemImage: "gearshape")
            }
            .adaptiveToolbarButton()
          }
        }

        GlassCard(title: "Local network and host trust", systemImage: "checkmark.shield") {
          Text("The supported local workflow relies on `hack global install`, `hack global trust`, and macOS prompts for local networking when needed. If routing or HTTPS trust looks wrong, run the doctor flow before manual repair.")
            .font(.mono(.caption))
            .foregroundStyle(.secondary)

          HStack(spacing: 10) {
            Button {
              TerminalIntegration.openTerminalWithCommand("hack doctor")
            } label: {
              Label("Run `hack doctor`", systemImage: "stethoscope")
            }
            .adaptiveToolbarButtonProminent()

            Button {
              TerminalIntegration.copyToClipboard("hack doctor --fix")
            } label: {
              Label("Copy repair command", systemImage: "doc.on.doc")
            }
            .adaptiveToolbarButton()
          }
        }
      }
      .padding(16)
    }
  }
}

private struct CertificatesSettingsView: View {
  @Environment(DashboardModel.self) private var model

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        SettingsSectionHeader(
          breadcrumb: "Settings / Certificates",
          title: "Certificates",
          subtitle: "Trust the local Caddy CA used for HTTPS routes under your Hack projects"
        )

        GlassCard(title: "Local trust guidance", systemImage: "checkmark.shield") {
          HStack(spacing: 8) {
            StatusPill(
              text: model.runtimeOverallOk == true ? "Runtime reachable" : "Trust may need repair",
              tone: model.runtimeOverallOk == true ? .good : .warn
            )
            Spacer()
          }

          Text("Hack uses a local internal CA for HTTPS routing. On a fresh Mac, run `hack global trust` once after `hack global install`.")
            .font(.mono(.caption))
            .foregroundStyle(.secondary)

          DetailRows(
            rows: [
              DetailRowItem(label: "Recommended command", value: "hack global trust"),
              DetailRowItem(label: "Fallback repair", value: "hack doctor --fix")
            ]
          )

          HStack(spacing: 10) {
            Button {
              TerminalIntegration.openTerminalWithCommand("hack global trust")
            } label: {
              Label("Run trust", systemImage: "checkmark.shield")
            }
            .adaptiveToolbarButtonProminent()

            Button {
              TerminalIntegration.copyToClipboard("hack global trust")
            } label: {
              Label("Copy command", systemImage: "doc.on.doc")
            }
            .adaptiveToolbarButton()
          }
        }
      }
      .padding(16)
    }
  }
}

private struct LoggingSettingsView: View {
  @Environment(DashboardModel.self) private var model

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        SettingsSectionHeader(
          breadcrumb: "Settings / Logging",
          title: "Logging",
          subtitle: "Fast entry points for daemon and local runtime logs"
        )

        GlassCard(title: "Quick actions", systemImage: "text.alignleft") {
          HStack(spacing: 10) {
            Button {
              TerminalIntegration.openTerminalWithCommand("hack logs --pretty")
            } label: {
              Label("Project logs", systemImage: "doc.text.magnifyingglass")
            }
            .adaptiveToolbarButtonProminent()

            Button {
              TerminalIntegration.openTerminalWithCommand("hack global logs caddy --no-follow --tail 200")
            } label: {
              Label("Caddy logs", systemImage: "globe")
            }
            .adaptiveToolbarButton()

            Button {
              TerminalIntegration.openTerminalWithCommand("hack doctor")
            } label: {
              Label("Doctor", systemImage: "stethoscope")
            }
            .adaptiveToolbarButton()
          }
        }

        GlassCard(title: "Known paths", systemImage: "folder") {
          DetailRows(rows: logRows)
        }
      }
      .padding(16)
    }
  }

  private var logRows: [DetailRowItem] {
    [
      DetailRowItem(label: "Daemon log", value: model.daemonStatus?.logPath ?? "Unknown"),
      DetailRowItem(label: "Global logs", value: "hack global logs caddy --no-follow --tail 200"),
      DetailRowItem(label: "Project logs", value: "hack logs --pretty")
    ]
  }
}
