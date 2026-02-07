import AppKit
import SwiftUI

struct TitlebarIconButton: View {
  let systemImage: String
  let help: String
  let accessibilityLabel: String
  let action: () -> Void

  @State private var isHovered = false
  @State private var isPressed = false

  var body: some View {
    Button {
      action()
    } label: {
      Image(systemName: systemImage)
        .font(.system(size: 14, weight: .regular))
        .foregroundStyle(.primary.opacity(isHovered ? 0.95 : 0.82))
        .frame(width: 22, height: 22)
        .background(interactionBackground)
        .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
    .buttonStyle(.plain)
    .help(help)
    .accessibilityLabel(accessibilityLabel)
    .onHover { hovering in
      isHovered = hovering
    }
    .pressEvents { pressed in
      isPressed = pressed
    }
  }

  @ViewBuilder
  private var interactionBackground: some View {
    // Avoid keeping a Material in the view tree at opacity 0; it can still read as a
    // persistent "pill" in some macOS toolbar/titlebar contexts.
    if isHovered || isPressed {
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .fill(.ultraThinMaterial)
        .overlay(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .strokeBorder(Color.primary.opacity(isHovered ? 0.10 : 0), lineWidth: 1)
        )
        .overlay(
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(isPressed ? Color.primary.opacity(0.06) : .clear)
        )
        .transition(.opacity)
        .animation(.easeInOut(duration: 0.12), value: isHovered)
        .animation(.easeInOut(duration: 0.08), value: isPressed)
    } else {
      Color.clear
    }
  }
}

private struct PressEventsModifier: ViewModifier {
  let onChange: (Bool) -> Void

  func body(content: Content) -> some View {
    content
      .simultaneousGesture(
        DragGesture(minimumDistance: 0)
          .onChanged { _ in onChange(true) }
          .onEnded { _ in onChange(false) }
      )
  }
}

private extension View {
  func pressEvents(_ onChange: @escaping (Bool) -> Void) -> some View {
    modifier(PressEventsModifier(onChange: onChange))
  }
}
