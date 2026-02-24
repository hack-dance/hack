import SwiftUI

struct InlineCalloutAction: Identifiable {
  let id: String
  let label: String
  let systemImage: String?
  let action: () -> Void

  init(id: String? = nil, label: String, systemImage: String? = nil, action: @escaping () -> Void) {
    self.id = id ?? label
    self.label = label
    self.systemImage = systemImage
    self.action = action
  }
}

struct InlineCallout: View {
  let tone: StatusTone
  let title: String
  let message: String
  let actions: [InlineCalloutAction]

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .center, spacing: 8) {
        Image(systemName: iconName)
          .foregroundStyle(iconColor)
        Text(title)
          .font(.mono(.subheadline, weight: .semibold))
        Spacer()
      }
      Text(message)
        .font(.mono(.caption))
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)

      if !actions.isEmpty {
        HStack(spacing: 10) {
          ForEach(actions) { action in
            Button {
              action.action()
            } label: {
              if let systemImage = action.systemImage {
                Label(action.label, systemImage: systemImage)
              } else {
                Text(action.label)
              }
            }
            .adaptiveToolbarButton()
          }
          Spacer()
        }
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .fill(.ultraThinMaterial)
        .overlay(
          RoundedRectangle(cornerRadius: 14, style: .continuous)
            .stroke(borderColor, lineWidth: 1)
        )
    )
  }

  private var iconName: String {
    switch tone {
    case .good:
      return "checkmark.circle.fill"
    case .warn:
      return "exclamationmark.triangle.fill"
    case .neutral:
      return "info.circle.fill"
    }
  }

  private var iconColor: Color {
    switch tone {
    case .good:
      return .green
    case .warn:
      return .orange
    case .neutral:
      return .blue
    }
  }

  private var borderColor: Color {
    switch tone {
    case .good:
      return Color.green.opacity(0.18)
    case .warn:
      return Color.orange.opacity(0.18)
    case .neutral:
      return Color.blue.opacity(0.18)
    }
  }
}

