import SwiftUI

struct SetupNudgeCard: View {
  let title: String
  let subtitle: String
  let primaryActionLabel: String
  let onPrimaryAction: () -> Void
  let onDismiss: () -> Void

  var body: some View {
    GlassCard(title: title, systemImage: "wand.and.stars") {
      VStack(alignment: .leading, spacing: 10) {
        Text(subtitle)
          .font(.mono(.caption))
          .foregroundStyle(.secondary)

        HStack(spacing: 10) {
          Button {
            onPrimaryAction()
          } label: {
            Label(primaryActionLabel, systemImage: "sparkles")
          }
          .adaptiveToolbarButtonProminent()

          Button {
            onDismiss()
          } label: {
            Label("Dismiss", systemImage: "xmark")
          }
          .adaptiveToolbarButton()

          Spacer()
        }
      }
    }
  }
}

