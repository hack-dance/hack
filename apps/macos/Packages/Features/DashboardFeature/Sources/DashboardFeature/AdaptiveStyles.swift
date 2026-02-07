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
        // Keep the toolbar visible, but visually clear. We tune the underlying NSToolbar to avoid
        // per-item "pill" backplates (see WindowToolbarTuner).
        .toolbarBackground(.clear, for: .windowToolbar)
        .toolbarBackgroundVisibility(.visible, for: .windowToolbar)
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
        .background(.regularMaterial)
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
        .glassEffect(.regular)
    } else {
      self.background(.ultraThinMaterial)
    }
  }
}

struct PressableIconButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .padding(6)
      .background(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(configuration.isPressed ? Color.white.opacity(0.12) : .clear)
      )
      .scaleEffect(configuration.isPressed ? 0.96 : 1)
      .animation(.easeInOut(duration: 0.12), value: configuration.isPressed)
  }
}

struct PressableCircleButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .padding(6)
      .background(
        Circle()
          .fill(configuration.isPressed ? Color.white.opacity(0.12) : .clear)
      )
      .scaleEffect(configuration.isPressed ? 0.96 : 1)
      .animation(.easeInOut(duration: 0.12), value: configuration.isPressed)
  }
}

struct LinkHoverStyle: ViewModifier {
  @State private var isHovered = false

  func body(content: Content) -> some View {
    content
      .foregroundStyle(isHovered ? Color.white.opacity(0.9) : Color.secondary)
      .underline(isHovered, color: Color.white.opacity(0.5))
      .contentShape(Rectangle())
      .onHover { hovering in
        isHovered = hovering
      }
      .animation(.easeInOut(duration: 0.12), value: isHovered)
  }
}

extension View {
  func linkHover() -> some View {
    modifier(LinkHoverStyle())
  }
}

extension Font {
  static func mono(_ style: Font.TextStyle, weight: Font.Weight = .regular) -> Font {
    Font.system(style, design: .monospaced).weight(weight)
  }
}

struct InstrumentGrid: View {
  let minorStep: CGFloat
  let majorStep: CGFloat
  let minorOpacity: Double
  let majorOpacity: Double

  init(
    minorStep: CGFloat = 24,
    majorStep: CGFloat = 120,
    minorOpacity: Double = 0.06,
    majorOpacity: Double = 0.12
  ) {
    self.minorStep = minorStep
    self.majorStep = majorStep
    self.minorOpacity = minorOpacity
    self.majorOpacity = majorOpacity
  }

  var body: some View {
    GeometryReader { proxy in
      let size = proxy.size
      Canvas { context, _ in
        var minorPath = Path()
        var majorPath = Path()

        var x: CGFloat = 0
        while x <= size.width {
          minorPath.move(to: CGPoint(x: x, y: 0))
          minorPath.addLine(to: CGPoint(x: x, y: size.height))
          x += minorStep
        }

        var y: CGFloat = 0
        while y <= size.height {
          minorPath.move(to: CGPoint(x: 0, y: y))
          minorPath.addLine(to: CGPoint(x: size.width, y: y))
          y += minorStep
        }

        x = 0
        while x <= size.width {
          majorPath.move(to: CGPoint(x: x, y: 0))
          majorPath.addLine(to: CGPoint(x: x, y: size.height))
          x += majorStep
        }

        y = 0
        while y <= size.height {
          majorPath.move(to: CGPoint(x: 0, y: y))
          majorPath.addLine(to: CGPoint(x: size.width, y: y))
          y += majorStep
        }

        context.stroke(minorPath, with: .color(Color.white.opacity(minorOpacity)), lineWidth: 0.5)
        context.stroke(majorPath, with: .color(Color.white.opacity(majorOpacity)), lineWidth: 0.8)
      }
    }
    .allowsHitTesting(false)
  }
}

extension View {
  func instrumentLabel() -> some View {
    self
      .font(.system(.caption2, design: .monospaced).weight(.semibold))
      .textCase(.uppercase)
      .tracking(1.2)
      .foregroundStyle(.secondary)
  }
}
