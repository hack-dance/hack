import AppKit
import SwiftUI

/// A borderless toolbar button that avoids the default SwiftUI toolbar "pill" background,
/// while still providing a subtle hover/pressed affordance.
struct ToolbarIconButton: NSViewRepresentable {
  final class HoverButton: NSButton {
    var onPress: (() -> Void)?

    private var isHovered = false {
      didSet { updateAppearance() }
    }

    private var isPressed = false {
      didSet { updateAppearance() }
    }

    private var trackingArea: NSTrackingArea?

    override init(frame frameRect: NSRect) {
      super.init(frame: frameRect)
      commonInit()
    }

    required init?(coder: NSCoder) {
      super.init(coder: coder)
      commonInit()
    }

    private func commonInit() {
      wantsLayer = true
      layer?.cornerRadius = 7
      layer?.masksToBounds = true

      isBordered = false
      bezelStyle = .regularSquare
      imagePosition = .imageOnly
      setButtonType(.momentaryChange)

      target = self
      action = #selector(handlePress)

      updateAppearance()
    }

    override func updateTrackingAreas() {
      super.updateTrackingAreas()
      if let trackingArea {
        removeTrackingArea(trackingArea)
      }
      let newTrackingArea = NSTrackingArea(
        rect: bounds,
        options: [.activeAlways, .mouseEnteredAndExited, .inVisibleRect],
        owner: self,
        userInfo: nil
      )
      addTrackingArea(newTrackingArea)
      trackingArea = newTrackingArea
    }

    override func mouseEntered(with event: NSEvent) {
      super.mouseEntered(with: event)
      isHovered = true
    }

    override func mouseExited(with event: NSEvent) {
      super.mouseExited(with: event)
      isHovered = false
      isPressed = false
    }

    override func mouseDown(with event: NSEvent) {
      isPressed = true
      super.mouseDown(with: event)
      isPressed = false
    }

    private func updateAppearance() {
      let base = NSColor.labelColor
      let hover = base.withAlphaComponent(0.06)
      let pressed = base.withAlphaComponent(0.10)

      if isPressed {
        layer?.backgroundColor = pressed.cgColor
      } else if isHovered {
        layer?.backgroundColor = hover.cgColor
      } else {
        layer?.backgroundColor = NSColor.clear.cgColor
      }
    }

    @objc private func handlePress() {
      onPress?()
    }
  }

  let systemImage: String
  let help: String
  let accessibilityLabel: String
  let action: () -> Void

  func makeNSView(context: Context) -> HoverButton {
    let button = HoverButton(frame: .init(x: 0, y: 0, width: 26, height: 26))
    button.onPress = action
    button.toolTip = help
    button.setAccessibilityLabel(accessibilityLabel)
    return button
  }

  func updateNSView(_ nsView: HoverButton, context: Context) {
    nsView.onPress = action
    nsView.toolTip = help
    nsView.setAccessibilityLabel(accessibilityLabel)

    let config = NSImage.SymbolConfiguration(pointSize: 11, weight: .regular)
    nsView.image = NSImage(systemSymbolName: systemImage, accessibilityDescription: accessibilityLabel)?
      .withSymbolConfiguration(config)
    nsView.contentTintColor = NSColor.labelColor.withAlphaComponent(0.85)
  }
}
