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
  func cardBackground() -> some View {
    modifier(AdaptiveCardBackgroundModifier())
  }
}

private struct AdaptiveCardBackgroundModifier: ViewModifier {
  @Environment(\.colorScheme) private var colorScheme

  func body(content: Content) -> some View {
    if #available(macOS 26, *) {
      content
        .background(cardBackground)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .shadow(color: .black.opacity(colorScheme == .dark ? 0.22 : 0.05), radius: 10, y: 3)
    } else {
      content
        .background(cardBackground)
        .overlay(
          RoundedRectangle(cornerRadius: 16, style: .continuous)
            .stroke(borderColor, lineWidth: 1)
        )
    }
  }

  private var cardBackground: some View {
    RoundedRectangle(cornerRadius: 16, style: .continuous)
      .fill(baseFill)
      .overlay(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .fill(materialFill)
          .opacity(materialOpacity)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .stroke(borderColor, lineWidth: 1)
      )
  }

  private var baseFill: Color {
    colorScheme == .dark ? Color.black.opacity(0.44) : Color.white.opacity(0.86)
  }

  private var materialFill: Material {
    colorScheme == .dark ? .ultraThinMaterial : .thinMaterial
  }

  private var materialOpacity: Double {
    colorScheme == .dark ? 0.42 : 0.62
  }

  private var borderColor: Color {
    colorScheme == .dark ? Color.white.opacity(0.16) : Color.black.opacity(0.08)
  }
}
