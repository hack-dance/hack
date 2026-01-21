import SwiftUI

private let terminalCornerRadius: CGFloat = 16

struct TerminalSurface: ViewModifier {
  func body(content: Content) -> some View {
    content
      .background(
        RoundedRectangle(cornerRadius: terminalCornerRadius, style: .continuous)
          .fill(.ultraThinMaterial)
          .overlay(
            RoundedRectangle(cornerRadius: terminalCornerRadius, style: .continuous)
              .fill(Color.black.opacity(0.97))
          )
      )
      .overlay(
        RoundedRectangle(cornerRadius: terminalCornerRadius, style: .continuous)
          .stroke(Color.white.opacity(0.08), lineWidth: 1)
      )
  }
}

extension View {
  func terminalSurface() -> some View {
    modifier(TerminalSurface())
  }
}
