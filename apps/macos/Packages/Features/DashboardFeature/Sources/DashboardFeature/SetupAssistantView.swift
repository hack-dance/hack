import AppKit
import SwiftUI

import GhosttyTerminal

enum SetupAssistantSection {
  case runtime
}

struct SetupAssistantView: View {
  @Environment(DashboardModel.self) private var model
  @Environment(\.dismiss) private var dismiss

  @State private var terminalAutomationGranted: Bool? = nil

  init(initialSection _: SetupAssistantSection = .runtime) {}

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      header

      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          runtimeSteps
        }
        .padding(.vertical, 4)
      }
    }
    .padding(18)
    .frame(minWidth: 560, idealWidth: 720, minHeight: 460, idealHeight: 560, alignment: .topLeading)
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
    permissionsCallout

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

  private var daemonIsRunning: Bool {
    model.daemonStatus?.resolvedLabel == .running
  }

  private var permissionsCallout: some View {
    InlineCallout(
      tone: terminalAutomationTone,
      title: "Permissions",
      message: "Grant Terminal automation once so Hack Desktop can open Terminal to run setup commands that may require sudo.",
      actions: [
        InlineCalloutAction(label: "Request Terminal automation", systemImage: "terminal") {
          terminalAutomationGranted = TerminalIntegration.requestTerminalAutomationPermission()
        },
        InlineCalloutAction(label: "Open Automation privacy", systemImage: "gearshape") {
          guard
            let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation")
          else { return }
          NSWorkspace.shared.open(url)
        }
      ]
    )
  }

  private var terminalAutomationTone: StatusTone {
    guard let granted = terminalAutomationGranted else { return .neutral }
    return granted ? .good : .warn
  }

  private func runInEmbeddedTerminalIfAvailable(_ command: String) {
    let normalizedCommand = command.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedCommand.isEmpty else { return }
    openGlobalCommandInTerminalPanel(command: normalizedCommand, title: "Setup")
  }
}

#if DEBUG
import HackCLIService

#Preview("Setup Assistant") {
  let model = DashboardModel(client: HackCLIClient())
  return SetupAssistantView()
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
