import SwiftUI

import GhosttyTerminal
import HackDesktopModels

enum SetupAssistantSection: String, CaseIterable, Identifiable {
  case runtime
  case gateway

  var id: String { rawValue }
}

struct SetupAssistantView: View {
  @Environment(DashboardModel.self) private var model
  @Environment(\.dismiss) private var dismiss

  let initialSection: SetupAssistantSection
  @State private var section: SetupAssistantSection

  @State private var showEmbeddedTerminal = false
  @State private var embeddedCommand: String? = nil

  init(initialSection: SetupAssistantSection) {
    self.initialSection = initialSection
    _section = State(initialValue: initialSection)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      header
      Picker("Section", selection: $section) {
        Text("Runtime").tag(SetupAssistantSection.runtime)
        Text("Gateway").tag(SetupAssistantSection.gateway)
      }
      .pickerStyle(.segmented)

      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          if section == .runtime {
            runtimeSteps
          } else {
            gatewaySteps
          }
        }
        .padding(.vertical, 4)
      }
    }
    .padding(18)
    .frame(minWidth: 560, idealWidth: 720, minHeight: 460, idealHeight: 560, alignment: .topLeading)
    .sheet(isPresented: $showEmbeddedTerminal) {
      embeddedTerminalSheet
    }
  }

  private var header: some View {
    HStack(alignment: .center) {
      VStack(alignment: .leading, spacing: 6) {
        Text("Setup")
          .font(.mono(.title2, weight: .bold))
        Text("Guided setup commands. Some steps may prompt for sudo in Terminal.")
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
      }
      Spacer()
      Button("Close") { dismiss() }
        .adaptiveToolbarButton()
    }
  }

  private var supportsEmbeddedTerminal: Bool {
    GhosttyVTRuntime.shared.isAvailable
  }

  @ViewBuilder
  private var runtimeSteps: some View {
    SetupAssistantStepCard(
      tone: model.globalStatus == nil ? .warn : .good,
      title: "Install global services",
      detail: "Bootstraps ~/.hack, starts Caddy + logging, and prepares networks.",
      command: "hack global install",
      canRunInApp: false,
      onRunInApp: nil,
      onRunInEmbeddedTerminal: supportsEmbeddedTerminal ? runInEmbeddedTerminalIfAvailable : nil,
      onOpenTerminal: TerminalIntegration.openTerminalWithCommand,
      onCopy: TerminalIntegration.copyToClipboard
    )

    SetupAssistantStepCard(
      tone: .neutral,
      title: "Trust local HTTPS certs (macOS)",
      detail: "Adds the local CA to Keychain so https://*.hack is trusted.",
      command: "hack global trust",
      canRunInApp: false,
      onRunInApp: nil,
      onRunInEmbeddedTerminal: supportsEmbeddedTerminal ? runInEmbeddedTerminalIfAvailable : nil,
      onOpenTerminal: TerminalIntegration.openTerminalWithCommand,
      onCopy: TerminalIntegration.copyToClipboard
    )

    SetupAssistantStepCard(
      tone: daemonIsRunning ? .good : .warn,
      title: "Start the daemon",
      detail: "Required for the app to show runtime + global status.",
      command: "hack daemon start",
      canRunInApp: !daemonIsRunning,
      onRunInApp: {
        Task { await model.startDaemon() }
      },
      onRunInEmbeddedTerminal: supportsEmbeddedTerminal ? runInEmbeddedTerminalIfAvailable : nil,
      onOpenTerminal: TerminalIntegration.openTerminalWithCommand,
      onCopy: TerminalIntegration.copyToClipboard
    )
  }

  @ViewBuilder
  private var gatewaySteps: some View {
    SetupAssistantStepCard(
      tone: model.globalStatus == nil ? .warn : .neutral,
      title: "Install global services",
      detail: "Gateway depends on the global runtime. Do this once per machine.",
      command: "hack global install",
      canRunInApp: false,
      onRunInApp: nil,
      onRunInEmbeddedTerminal: supportsEmbeddedTerminal ? runInEmbeddedTerminalIfAvailable : nil,
      onOpenTerminal: TerminalIntegration.openTerminalWithCommand,
      onCopy: TerminalIntegration.copyToClipboard
    )

    SetupAssistantStepCard(
      tone: .neutral,
      title: "Start the daemon",
      detail: "The gateway status UI requires hackd.",
      command: "hack daemon start",
      canRunInApp: !daemonIsRunning,
      onRunInApp: {
        Task { await model.startDaemon() }
      },
      onRunInEmbeddedTerminal: supportsEmbeddedTerminal ? runInEmbeddedTerminalIfAvailable : nil,
      onOpenTerminal: TerminalIntegration.openTerminalWithCommand,
      onCopy: TerminalIntegration.copyToClipboard
    )

    SetupAssistantStepCard(
      tone: gatewayIsConfigured ? .good : .warn,
      title: "Guided gateway setup",
      detail: "Enables gateway and helps you generate a token.",
      command: "hack gateway setup",
      canRunInApp: false,
      onRunInApp: nil,
      onRunInEmbeddedTerminal: supportsEmbeddedTerminal ? runInEmbeddedTerminalIfAvailable : nil,
      onOpenTerminal: TerminalIntegration.openTerminalWithCommand,
      onCopy: TerminalIntegration.copyToClipboard
    )

    if shouldShowLanExposureHint {
      InlineCallout(
        tone: .neutral,
        title: "LAN exposure is blocked by loopback bind",
        message: "If you want other devices on your LAN to reach the gateway, set the bind to 0.0.0.0 and restart hackd. This is optional and increases your attack surface on local networks.",
        actions: [
          InlineCalloutAction(label: "Copy fix", systemImage: "doc.on.doc") {
            TerminalIntegration.copyToClipboard("""
            hack config set --global controlPlane.gateway.bind 0.0.0.0
            hack daemon restart
            """)
          },
          InlineCalloutAction(label: "Open Terminal", systemImage: "terminal") {
            TerminalIntegration.openTerminalWithCommand("""
            hack config set --global controlPlane.gateway.bind 0.0.0.0
            hack daemon restart
            """)
          }
        ]
      )
    }
  }

  private var daemonIsRunning: Bool {
    model.daemonStatus?.resolvedLabel == .running
  }

  private var gatewayIsConfigured: Bool {
    model.globalStatus?.summary.gatewayEnabled == true || model.gatewaySummaryState != nil
  }

  private var shouldShowLanExposureHint: Bool {
    guard let exposures = model.gatewayExposures as [GatewayExposure]? else { return false }
    guard let lan = exposures.first(where: { $0.id == "lan" }) else { return false }
    return lan.resolvedState == .blocked && (lan.detail ?? "").lowercased().contains("loopback")
  }

  private func runInEmbeddedTerminalIfAvailable(_ command: String) {
    embeddedCommand = command
    showEmbeddedTerminal = true
  }

  private var embeddedTerminalSheet: some View {
    let project = ProjectSummary(
      projectId: "setup",
      name: "Setup",
      devHost: nil,
      repoRoot: FileManager.default.homeDirectoryForCurrentUser.path,
      projectDir: nil,
      definedServices: nil,
      extensionsEnabled: nil,
      features: nil,
      serviceHosts: nil,
      runtimeConfigured: nil,
      runtimeStatus: nil,
      runtime: nil,
      meta: nil,
      kind: .unregistered,
      status: .unknown
    )
    return VStack(alignment: .leading, spacing: 0) {
      ShellView(project: project, embedded: true, initialCommand: embeddedCommand)
    }
    .frame(minWidth: 760, minHeight: 480)
  }
}

#if DEBUG
import HackCLIService

#Preview("Setup Assistant") {
  let model = DashboardModel(client: HackCLIClient())
  return SetupAssistantView(initialSection: .runtime)
    .environment(model)
}
#endif

private struct SetupAssistantStepCard: View {
  let tone: StatusTone
  let title: String
  let detail: String
  let command: String

  let canRunInApp: Bool
  let onRunInApp: (() -> Void)?

  let onRunInEmbeddedTerminal: ((String) -> Void)?
  let onOpenTerminal: (String) -> Void
  let onCopy: (String) -> Void

  var body: some View {
    GlassCard(title: title, systemImage: iconName) {
      VStack(alignment: .leading, spacing: 10) {
        Text(detail)
          .font(.mono(.caption))
          .foregroundStyle(.secondary)

        Text(command)
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
          .textSelection(.enabled)

        HStack(spacing: 10) {
          Button {
            onCopy(command)
          } label: {
            Label("Copy", systemImage: "doc.on.doc")
          }
          .adaptiveToolbarButton()

          Button {
            onOpenTerminal(command)
          } label: {
            Label("Open Terminal", systemImage: "terminal")
          }
          .adaptiveToolbarButton()

          if let onRunInEmbeddedTerminal {
            Button {
              onRunInEmbeddedTerminal(command)
            } label: {
              Label("Run here", systemImage: "play.fill")
            }
            .adaptiveToolbarButton()
          }

          if canRunInApp, let onRunInApp {
            Button {
              onRunInApp()
            } label: {
              Label("Run in app", systemImage: "bolt.fill")
            }
            .adaptiveToolbarButtonProminent()
          }

          Spacer()
        }
      }
    }
  }

  private var iconName: String {
    switch tone {
    case .good:
      return "checkmark.seal.fill"
    case .warn:
      return "exclamationmark.triangle.fill"
    case .neutral:
      return "info.circle.fill"
    }
  }
}
