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
            .font(.headline)
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
            .fill(.regularMaterial)
        )
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .glassEffect(.regular)
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
