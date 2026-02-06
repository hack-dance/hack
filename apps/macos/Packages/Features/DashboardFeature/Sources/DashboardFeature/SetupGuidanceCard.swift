import SwiftUI

struct SetupGuidanceCard: View {
  let title: String
  let subtitle: String
  let steps: [SetupStep]

  var body: some View {
    GlassCard(title: title, systemImage: "wand.and.stars") {
      VStack(alignment: .leading, spacing: 10) {
        Text(subtitle)
          .font(.mono(.caption))
          .foregroundStyle(.secondary)

        ForEach(steps) { step in
          SetupStepRow(step: step)
        }
      }
    }
  }
}

struct SetupStep: Identifiable {
  let id: String
  let label: String
  let command: String
  let detail: String?

  init(id: String, label: String, command: String, detail: String? = nil) {
    self.id = id
    self.label = label
    self.command = command
    self.detail = detail
  }
}

private struct SetupStepRow: View {
  let step: SetupStep

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .center, spacing: 10) {
        VStack(alignment: .leading, spacing: 2) {
          Text(step.label)
            .font(.mono(.subheadline, weight: .semibold))
          Text(step.command)
            .font(.mono(.caption))
            .foregroundStyle(.secondary)
            .textSelection(.enabled)
        }
        Spacer()
        Button("Copy") {
          TerminalIntegration.copyToClipboard(step.command)
        }
        .adaptiveToolbarButton()
        Button("Open Terminal") {
          TerminalIntegration.openTerminalWithCommand(step.command)
        }
        .adaptiveToolbarButtonProminent()
      }
      if let detail = step.detail, !detail.isEmpty {
        Text(detail)
          .font(.mono(.caption2))
          .foregroundStyle(.tertiary)
      }
    }
    .padding(.vertical, 2)
  }
}

