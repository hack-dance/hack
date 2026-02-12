import AppKit
import SwiftUI

/// A borderless toolbar button that avoids the default SwiftUI toolbar "pill" background,
/// while still providing a subtle hover/pressed affordance.
struct ToolbarIconButton: NSViewRepresentable {
  final class HoverButton: NSButton {
    static let hitTargetSize = NSSize(width: 32, height: 32)
    static let hitTargetCornerRadius: CGFloat = 9

    var onPress: (() -> Void)?
    var normalSystemImage = ""
    var hoverSystemImage: String?
    var normalSymbolTint: NSColor?
    var hoverSymbolTint: NSColor?
    var symbolPointSize: CGFloat = 12
    var symbolWeight: NSFont.Weight = .regular
    var accessibilityText = ""

    private var isHovered = false {
      didSet { updateAppearance() }
    }

    private var isPressed = false {
      didSet { updateAppearance() }
    }

    private var trackingArea: NSTrackingArea?

    override var intrinsicContentSize: NSSize {
      Self.hitTargetSize
    }

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
      layer?.cornerRadius = Self.hitTargetCornerRadius
      layer?.cornerCurve = .continuous
      layer?.masksToBounds = true

      isBordered = false
      bezelStyle = .regularSquare
      imagePosition = .imageOnly
      imageScaling = .scaleProportionallyDown
      setButtonType(.momentaryChange)
      focusRingType = .none
      setFrameSize(Self.hitTargetSize)
      frame.size = Self.hitTargetSize
      setContentHuggingPriority(.required, for: .horizontal)
      setContentHuggingPriority(.required, for: .vertical)
      setContentCompressionResistancePriority(.required, for: .horizontal)
      setContentCompressionResistancePriority(.required, for: .vertical)

      target = self
      action = #selector(handlePress)

      updateAppearance()
    }

    func refreshAppearance() {
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
      let isDarkAppearance = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
      let hover = isDarkAppearance
        ? NSColor.white.withAlphaComponent(0.14)
        : NSColor.black.withAlphaComponent(0.08)
      let pressed = isDarkAppearance
        ? NSColor.white.withAlphaComponent(0.22)
        : NSColor.black.withAlphaComponent(0.14)
      let stroke = isDarkAppearance
        ? NSColor.white.withAlphaComponent(0.18)
        : NSColor.black.withAlphaComponent(0.12)

      if isPressed {
        layer?.backgroundColor = pressed.cgColor
      } else if isHovered {
        layer?.backgroundColor = hover.cgColor
      } else {
        layer?.backgroundColor = NSColor.clear.cgColor
      }
      layer?.borderWidth = (isHovered || isPressed) ? 1 : 0
      layer?.borderColor = stroke.cgColor

      updateSymbolAppearance()
    }

    private func updateSymbolAppearance() {
      let symbolName = (isHovered ? hoverSystemImage : nil) ?? normalSystemImage
      let config = NSImage.SymbolConfiguration(pointSize: symbolPointSize, weight: symbolWeight)
      image = NSImage(systemSymbolName: symbolName, accessibilityDescription: accessibilityText)?
        .withSymbolConfiguration(config)
      if isHovered, let hoverSymbolTint {
        contentTintColor = hoverSymbolTint
      } else if let normalSymbolTint {
        contentTintColor = normalSymbolTint
      } else {
        contentTintColor = NSColor.labelColor.withAlphaComponent(isHovered ? 0.98 : 0.88)
      }
    }

    @objc private func handlePress() {
      onPress?()
    }
  }

  let systemImage: String
  var hoverSystemImage: String? = nil
  let help: String
  let accessibilityLabel: String
  var symbolTint: NSColor? = nil
  var hoverSymbolTint: NSColor? = nil
  let action: () -> Void

  func makeNSView(context: Context) -> HoverButton {
    let button = HoverButton(frame: .init(origin: .zero, size: HoverButton.hitTargetSize))
    button.onPress = action
    button.normalSystemImage = systemImage
    button.hoverSystemImage = hoverSystemImage
    button.normalSymbolTint = symbolTint
    button.hoverSymbolTint = hoverSymbolTint
    button.accessibilityText = accessibilityLabel
    button.toolTip = help
    button.setAccessibilityLabel(accessibilityLabel)
    button.refreshAppearance()
    return button
  }

  func updateNSView(_ nsView: HoverButton, context: Context) {
    nsView.onPress = action
    nsView.normalSystemImage = systemImage
    nsView.hoverSystemImage = hoverSystemImage
    nsView.normalSymbolTint = symbolTint
    nsView.hoverSymbolTint = hoverSymbolTint
    nsView.accessibilityText = accessibilityLabel
    nsView.toolTip = help
    nsView.setAccessibilityLabel(accessibilityLabel)
    nsView.refreshAppearance()
  }
}
