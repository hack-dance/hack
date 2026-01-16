import SwiftUI

/// Adaptive button style that uses Liquid Glass on macOS 26+
struct AdaptiveProminentButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    if #available(macOS 26, *) {
      configuration.label
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.accentColor)
        .foregroundStyle(.white)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .glassEffect(.regular.tint(Color.accentColor.opacity(0.2)))
        .opacity(configuration.isPressed ? 0.8 : 1.0)
    } else {
      configuration.label
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.accentColor)
        .foregroundStyle(.white)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .opacity(configuration.isPressed ? 0.8 : 1.0)
    }
  }
}

/// Adaptive secondary button style
struct AdaptiveSecondaryButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    if #available(macOS 26, *) {
      configuration.label
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .foregroundStyle(.primary)
        .glassEffect(.regular)
        .opacity(configuration.isPressed ? 0.8 : 1.0)
    } else {
      configuration.label
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .foregroundStyle(.primary)
        .background(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(.quaternary)
        )
        .opacity(configuration.isPressed ? 0.8 : 1.0)
    }
  }
}

/// Adaptive destructive button style for stop/delete actions
struct AdaptiveDestructiveButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    if #available(macOS 26, *) {
      configuration.label
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .foregroundStyle(.red)
        .glassEffect(.regular.tint(Color.red.opacity(0.15)))
        .opacity(configuration.isPressed ? 0.8 : 1.0)
    } else {
      configuration.label
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .foregroundStyle(.red)
        .background(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(Color.red.opacity(0.1))
        )
        .overlay(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .stroke(Color.red.opacity(0.3), lineWidth: 1)
        )
        .opacity(configuration.isPressed ? 0.8 : 1.0)
    }
  }
}

extension ButtonStyle where Self == AdaptiveProminentButtonStyle {
  static var adaptiveProminent: AdaptiveProminentButtonStyle { .init() }
}

extension ButtonStyle where Self == AdaptiveSecondaryButtonStyle {
  static var adaptiveSecondary: AdaptiveSecondaryButtonStyle { .init() }
}

extension ButtonStyle where Self == AdaptiveDestructiveButtonStyle {
  static var adaptiveDestructive: AdaptiveDestructiveButtonStyle { .init() }
}

extension View {
  /// Apply glass background effect on macOS 26+, material on older versions
  @ViewBuilder
  func adaptiveGlassBackground(cornerRadius: CGFloat = 12) -> some View {
    if #available(macOS 26, *) {
      self
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .glassEffect(.regular)
    } else {
      self
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    }
  }

  /// Apply subtle glass tint on macOS 26+
  @ViewBuilder
  func adaptiveGlassTint(_ color: Color, opacity: Double = 0.15) -> some View {
    if #available(macOS 26, *) {
      self.glassEffect(.regular.tint(color.opacity(opacity)))
    } else {
      self
    }
  }

  /// Adaptive window background - transparent on macOS 26+
  @ViewBuilder
  func adaptiveWindowBackground() -> some View {
    if #available(macOS 26, *) {
      self
        .background(.clear)
        .toolbarBackgroundVisibility(.hidden, for: .windowToolbar)
    } else {
      self
        .background(.ultraThinMaterial)
        .toolbarBackground(.ultraThinMaterial, for: .windowToolbar)
        .toolbarBackground(.visible, for: .windowToolbar)
    }
  }

  /// Adaptive detail view background
  @ViewBuilder
  func adaptiveDetailBackground() -> some View {
    if #available(macOS 26, *) {
      self.background(.regularMaterial)
    } else {
      self.background(.ultraThinMaterial)
    }
  }

  /// Adaptive sidebar background
  @ViewBuilder
  func adaptiveSidebarBackground() -> some View {
    if #available(macOS 26, *) {
      self
        .scrollContentBackground(.hidden)
        .background(.clear)
    } else {
      self
        .scrollContentBackground(.hidden)
        .background(.ultraThinMaterial)
    }
  }

  /// Adaptive toolbar button (secondary style)
  @ViewBuilder
  func adaptiveToolbarButton() -> some View {
    if #available(macOS 26, *) {
      self.buttonStyle(.glass)
    } else {
      self.buttonStyle(.bordered)
    }
  }

  /// Adaptive toolbar button (prominent style)
  @ViewBuilder
  func adaptiveToolbarButtonProminent() -> some View {
    if #available(macOS 26, *) {
      self.buttonStyle(.glassProminent)
    } else {
      self.buttonStyle(.borderedProminent)
    }
  }

  /// Adaptive footer background
  @ViewBuilder
  func adaptiveFooterBackground() -> some View {
    if #available(macOS 26, *) {
      self.background(.regularMaterial)
    } else {
      self.background(.ultraThinMaterial)
    }
  }
}
