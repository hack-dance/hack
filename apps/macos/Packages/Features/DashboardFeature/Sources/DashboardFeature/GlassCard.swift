import SwiftUI

struct GlassCard<Content: View>: View {
  let title: String?
  let systemImage: String?
  @ViewBuilder let content: Content

  init(title: String? = nil, systemImage: String? = nil, @ViewBuilder content: () -> Content) {
    self.title = title
    self.systemImage = systemImage
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      if let title {
        HStack(spacing: 8) {
          if let systemImage {
            Image(systemName: systemImage)
              .foregroundStyle(.secondary)
          }
          Text(title)
            .font(.mono(.subheadline, weight: .semibold))
        }
      }
      content
    }
    .padding(16)
    .cardBackground()
  }
}

private extension View {
  @ViewBuilder
  func cardBackground() -> some View {
    if #available(macOS 26, *) {
      self
        .background(
          RoundedRectangle(cornerRadius: 16, style: .continuous)
            .fill(.thinMaterial)
        )
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .shadow(color: .black.opacity(0.04), radius: 8, y: 2)
    } else {
      self
        .background(
          RoundedRectangle(cornerRadius: 16, style: .continuous)
            .fill(.thinMaterial)
        )
        .overlay(
          RoundedRectangle(cornerRadius: 16, style: .continuous)
            .stroke(.primary.opacity(0.08), lineWidth: 1)
        )
    }
  }
}
