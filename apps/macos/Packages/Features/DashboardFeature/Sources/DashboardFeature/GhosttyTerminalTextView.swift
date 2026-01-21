import AppKit
import CoreText
import GhosttyTerminal
import SwiftUI

/**
 * Terminal font configuration loaded from Ghostty config or defaults.
 */
struct TerminalFontConfig {
  let fontFamily: String
  let fontSize: CGFloat
  let fontThicken: Bool
  let lineHeightPadding: CGFloat

  static let `default` = TerminalFontConfig(
    fontFamily: "FantasqueSansM Nerd Font Mono",
    fontSize: 14,
    fontThicken: true,
    lineHeightPadding: 0
  )

  /**
   * Loads font configuration from Ghostty config file.
   * Falls back to defaults if config not found or parsing fails.
   */
  static func loadFromGhosttyConfig() -> TerminalFontConfig {
    let configPath = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".config/ghostty/config")

    guard let contents = try? String(contentsOf: configPath, encoding: .utf8) else {
      return .default
    }

    var fontFamily = TerminalFontConfig.default.fontFamily
    var fontSize = TerminalFontConfig.default.fontSize
    var fontThicken = TerminalFontConfig.default.fontThicken

    for line in contents.components(separatedBy: .newlines) {
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      guard !trimmed.hasPrefix("#"), !trimmed.isEmpty else { continue }

      let parts = trimmed.split(separator: "=", maxSplits: 1)
      guard parts.count == 2 else { continue }

      let key = parts[0].trimmingCharacters(in: .whitespaces)
      let value = parts[1].trimmingCharacters(in: .whitespaces)
        .trimmingCharacters(in: CharacterSet(charactersIn: "\""))

      switch key {
      case "font-family":
        fontFamily = value
      case "font-size":
        if let size = Double(value) {
          fontSize = CGFloat(size)
        }
      case "font-thicken":
        fontThicken = value == "true"
      default:
        break
      }
    }

    return TerminalFontConfig(
      fontFamily: fontFamily,
      fontSize: fontSize,
      fontThicken: fontThicken,
      lineHeightPadding: 2
    )
  }

  /**
   * Resolves the NSFont for this configuration.
   * Falls back through several options if the preferred font isn't available.
   */
  func resolveFont() -> NSFont {
    if let font = NSFont(name: fontFamily, size: fontSize) {
      return font
    }

    let fallbacks = [
      "FantasqueSansM Nerd Font Mono",
      "JetBrainsMono Nerd Font Mono",
      "FiraCode Nerd Font Mono",
      "Menlo",
      "Monaco"
    ]

    for fallback in fallbacks where fallback != fontFamily {
      if let font = NSFont(name: fallback, size: fontSize) {
        return font
      }
    }

    return NSFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
  }
}

struct GhosttyTerminalTextView: NSViewRepresentable {
  @Bindable var session: GhosttyTerminalSession

  func makeCoordinator() -> Coordinator {
    Coordinator()
  }

  func makeNSView(context: Context) -> TerminalRenderView {
    let view = TerminalRenderView()
    view.translatesAutoresizingMaskIntoConstraints = false
    view.setContentHuggingPriority(.defaultLow, for: .horizontal)
    view.setContentHuggingPriority(.defaultLow, for: .vertical)
    view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    view.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
    view.overrideBackgroundColor = NSColor.black.withAlphaComponent(0.96)
    view.backgroundAlpha = 1.0
    view.onKeyDown = { event in
      context.coordinator.handleKey(event)
    }
    view.onLayout = { _ in
      context.coordinator.updateSize(in: view)
    }
    context.coordinator.renderView = view
    return view
  }

  func updateNSView(_ nsView: TerminalRenderView, context: Context) {
    context.coordinator.session = session
    context.coordinator.ensureFocus(in: nsView)
    context.coordinator.updateSize(in: nsView)

    if context.coordinator.lastRenderVersion != session.renderVersion {
      context.coordinator.lastRenderVersion = session.renderVersion
      nsView.snapshot = session.snapshot
    }
  }

  @MainActor
  final class Coordinator {
    weak var session: GhosttyTerminalSession?
    weak var renderView: TerminalRenderView?
    var lastRenderVersion: Int = -1
    private var lastCols: Int = 0
    private var lastRows: Int = 0
    private let fontConfig = TerminalFontConfig.loadFromGhosttyConfig()
    private lazy var baseFont: NSFont = fontConfig.resolveFont()

    func handleKey(_ event: NSEvent) {
      guard let session else { return }

      let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
      if event.modifierFlags.contains(.command) {
        return
      }

      guard let data = encode(event: event) else { return }
      let isControlData = data.count == 1 && (data[0] < 0x20 || data[0] == 0x7F)
      if isControlData || flags.contains(.control) {
        session.sendControl(data)
        return
      }
      if session.allowsInput {
        session.send(data)
      }
    }

    private func encode(event: NSEvent) -> Data? {
      let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
      if flags.contains(.control), let chars = event.charactersIgnoringModifiers, let scalar = chars.unicodeScalars.first {
        let value = scalar.value
        if value < 0x20 {
          return Data([UInt8(value)])
        }
        if value == 0x20 {
          return Data([0x00])
        }
        if value >= 0x40 && value <= 0x5F {
          return Data([UInt8(value - 0x40)])
        }
        if value >= 0x61 && value <= 0x7A {
          return Data([UInt8(value - 0x60)])
        }
      }

      switch event.keyCode {
      case 36:
        return Data([0x0D])
      case 48:
        return Data([0x09])
      case 51:
        return Data([0x7F])
      case 53:
        return Data([0x1B])
      case 117:
        return Data("\u{1B}[3~".utf8)
      case 115:
        return Data("\u{1B}[H".utf8)
      case 119:
        return Data("\u{1B}[F".utf8)
      case 116:
        return Data("\u{1B}[5~".utf8)
      case 121:
        return Data("\u{1B}[6~".utf8)
      case 123:
        return Data("\u{1B}[D".utf8)
      case 124:
        return Data("\u{1B}[C".utf8)
      case 125:
        return Data("\u{1B}[B".utf8)
      case 126:
        return Data("\u{1B}[A".utf8)
      default:
        break
      }

      if let chars = event.characters, !chars.isEmpty {
        return Data(chars.utf8)
      }

      return nil
    }

    func updateSize(in view: TerminalRenderView) {
      guard let session else { return }
      let bounds = view.bounds
      guard bounds.width > 0, bounds.height > 0 else { return }

      let ctFont = baseFont as CTFont
      var glyph = CTFontGetGlyphWithName(ctFont, "W" as CFString)
      if glyph == 0 {
        var chars: [UniChar] = [UniChar(0x57)]
        var glyphs: [CGGlyph] = [0]
        _ = CTFontGetGlyphsForCharacters(ctFont, &chars, &glyphs, 1)
        glyph = glyphs[0]
      }
      var advance = CGSize.zero
      if glyph != 0 {
        _ = CTFontGetAdvancesForGlyphs(ctFont, .horizontal, &glyph, &advance, 1)
      }
      let fallbackSize = ("W" as NSString).size(withAttributes: [.font: baseFont])
      let maxAdvance = baseFont.maximumAdvancement.width
      let widthCandidate = max(maxAdvance, fallbackSize.width)
      // Use actual glyph advance to match what terminal programs expect
      let cellWidth = max(7.0, max(widthCandidate, advance.width))
      let rawLineHeight = ceil(baseFont.ascender - baseFont.descender + baseFont.leading)
      let lineHeight = max(1, rawLineHeight + fontConfig.lineHeightPadding)
      let baselineOffset = floor(baseFont.ascender) + (fontConfig.lineHeightPadding / 2)
      view.font = baseFont
      view.cellSize = CGSize(width: cellWidth, height: lineHeight)
      view.baselineOffset = baselineOffset

      let insets = view.contentInsets
      let usableWidth = max(1, bounds.width - insets.left - insets.right)
      let usableHeight = max(1, bounds.height - insets.top - insets.bottom)
      let cols = max(1, Int(floor(usableWidth / cellWidth)))
      let rows = max(1, Int(floor(usableHeight / lineHeight)))

      guard cols != lastCols || rows != lastRows else { return }
      lastCols = cols
      lastRows = rows
      session.resize(cols: cols, rows: rows)
    }

    func ensureFocus(in view: TerminalRenderView) {
      guard view.window != nil else { return }
      guard view.window?.firstResponder !== view else { return }
      DispatchQueue.main.async {
        view.window?.makeFirstResponder(view)
      }
    }
  }
}

final class TerminalRenderView: NSView {
  private static let cornerRadius: CGFloat = 16

  var snapshot: GhosttyRenderSnapshot? {
    didSet {
      needsDisplay = true
    }
  }
  var font: NSFont = TerminalFontConfig.loadFromGhosttyConfig().resolveFont() {
    didSet {
      fontCache.removeAll()
      needsDisplay = true
    }
  }
  var cellSize: CGSize = CGSize(width: 8, height: 16) {
    didSet {
      needsDisplay = true
    }
  }
  var baselineOffset: CGFloat = 0 {
    didSet {
      needsDisplay = true
    }
  }
  var backgroundAlpha: CGFloat = 0.94 {
    didSet {
      needsDisplay = true
    }
  }
  var overrideBackgroundColor: NSColor? {
    didSet {
      needsDisplay = true
    }
  }
  var contentInsets: NSEdgeInsets = NSEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
  var onKeyDown: ((NSEvent) -> Void)?
  var onLayout: ((NSSize) -> Void)?

  private var fontCache: [UInt8: NSFont] = [:]

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    configureLayer()
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
    configureLayer()
  }

  override var acceptsFirstResponder: Bool { true }
  override var isFlipped: Bool { true }

  override func keyDown(with event: NSEvent) {
    onKeyDown?(event)
  }

  override func mouseDown(with event: NSEvent) {
    window?.makeFirstResponder(self)
    super.mouseDown(with: event)
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    window?.makeFirstResponder(self)
  }

  override func layout() {
    super.layout()
    onLayout?(bounds.size)
  }

  override func draw(_ dirtyRect: NSRect) {
    guard let snapshot else { return }
    let context = NSGraphicsContext.current?.cgContext
    context?.saveGState()
    defer { context?.restoreGState() }

    let baseBackground = nsColor(snapshot.defaultBackground)
    let baseForeground = nsColor(snapshot.defaultForeground)
    let effectiveBackground = overrideBackgroundColor ?? baseBackground
    let renderBackground = effectiveBackground.withAlphaComponent(
      min(effectiveBackground.alphaComponent, backgroundAlpha)
    )
    renderBackground.setFill()
    bounds.fill()
    let effectiveForeground = adjustedForeground(baseForeground, for: effectiveBackground)

    let startX = contentInsets.left
    let startY = contentInsets.top
    let maxCols = min(snapshot.cols, Int((bounds.width - contentInsets.left - contentInsets.right) / cellSize.width))
    let maxRows = min(snapshot.rows, Int((bounds.height - contentInsets.top - contentInsets.bottom) / cellSize.height))
    guard maxCols > 0, maxRows > 0 else { return }

    for row in 0..<maxRows {
      for col in 0..<maxCols {
        let index = row * snapshot.cols + col
        guard index < snapshot.cells.count else { continue }
        let cell = snapshot.cells[index]
        if cell.wide >= 2 {
          continue
        }

        let x = startX + CGFloat(col) * cellSize.width
        let y = startY + CGFloat(row) * cellSize.height
        let width = cell.wide == 1 ? cellSize.width * 2 : cellSize.width
        let cellRect = CGRect(x: x, y: y, width: width, height: cellSize.height)

        let inverse = (cell.flags & 0x8) != 0
        let fgIsDefault = isDefaultColor(cell.foreground, fallback: snapshot.defaultForeground)
        let bgIsDefault = isDefaultColor(cell.background, fallback: snapshot.defaultBackground)
        var fg = fgIsDefault ? effectiveForeground : nsColor(cell.foreground)
        var bg = bgIsDefault ? effectiveBackground : nsColor(cell.background)
        if inverse {
          swap(&fg, &bg)
        }
        if (cell.flags & 0x10) != 0 {
          fg = fg.withAlphaComponent(fg.alphaComponent * 0.6)
        }

        if !bgIsDefault || inverse {
          bg.setFill()
          cellRect.fill()
        }

        if cell.codepoint == 0 || (cell.flags & 0x80) != 0 {
          continue
        }

        guard let scalar = UnicodeScalar(cell.codepoint) else { continue }
        let string = String(scalar)
        let font = fontForCellFlags(cell.flags)

        let adjustedFg = adjustedForeground(fg, for: bgIsDefault ? effectiveBackground : bg)
        let attributes: [NSAttributedString.Key: Any] = [
          .font: font,
          .foregroundColor: adjustedFg,
          .underlineStyle: (cell.flags & 0x4) != 0 ? NSUnderlineStyle.single.rawValue : 0,
          .strikethroughStyle: (cell.flags & 0x20) != 0 ? NSUnderlineStyle.single.rawValue : 0
        ]

        let codepoint = cell.codepoint

        if codepoint >= 0x2500 && codepoint <= 0x257F {
          context?.saveGState()
          drawBoxDrawingCharacter(codepoint, in: cellRect, color: adjustedFg)
          context?.restoreGState()
        } else if codepoint >= 0x2580 && codepoint <= 0x259F {
          context?.saveGState()
          drawBlockElement(codepoint, in: cellRect, color: adjustedFg)
          context?.restoreGState()
        } else if let ctx = context {
          // Use Core Text for reliable text rendering in flipped view
          let attrString = NSAttributedString(string: string, attributes: attributes)
          let line = CTLineCreateWithAttributedString(attrString)

          // Get typographic bounds for proper positioning
          var ascent: CGFloat = 0
          var descent: CGFloat = 0
          var leading: CGFloat = 0
          CTLineGetTypographicBounds(line, &ascent, &descent, &leading)

          // In flipped view, position baseline correctly
          // The text origin should place the baseline at the right vertical position
          let textY = y + ascent + (cellSize.height - ascent - descent) / 2

          ctx.saveGState()
          ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
          ctx.textPosition = CGPoint(x: x, y: textY)
          CTLineDraw(line, ctx)
          ctx.restoreGState()
        }
      }
    }

    drawCursor(
      snapshot: snapshot,
      startX: startX,
      startY: startY,
      defaultBackground: effectiveBackground,
      defaultForeground: effectiveForeground
    )
  }

  private func drawCursor(
    snapshot: GhosttyRenderSnapshot,
    startX: CGFloat,
    startY: CGFloat,
    defaultBackground: NSColor,
    defaultForeground: NSColor
  ) {
    guard snapshot.cursor.isVisible else { return }
    let maxCols = Int((bounds.width - contentInsets.left - contentInsets.right) / cellSize.width)
    let maxRows = Int((bounds.height - contentInsets.top - contentInsets.bottom) / cellSize.height)
    var col = snapshot.cursor.x
    let row = min(snapshot.cursor.y, maxRows - 1)
    guard col >= 0, row >= 0 else { return }
    guard col < maxCols, row < maxRows else { return }

    if snapshot.cursor.wideTail, col > 0 {
      col -= 1
    }
    let x = startX + CGFloat(col) * cellSize.width
    let y = startY + CGFloat(row) * cellSize.height
    let width = cellSize.width * (snapshot.cursor.wideTail ? 2 : 1)
    let height = cellSize.height
    let rect = CGRect(x: x, y: y, width: width, height: height)

    let cursorRaw = snapshot.cursorColor
    var color = nsColor(cursorRaw)
    if cursorRaw.alpha == 0 || cursorRaw == snapshot.defaultBackground {
      color = defaultForeground.withAlphaComponent(0.85)
    }
    color.setFill()

    switch snapshot.cursor.style {
    case .bar:
      CGRect(x: rect.minX, y: rect.minY, width: max(1, rect.width * 0.15), height: rect.height).fill()
    case .underline:
      CGRect(x: rect.minX, y: rect.maxY - max(1, rect.height * 0.1), width: rect.width, height: max(1, rect.height * 0.1)).fill()
    case .block:
      NSBezierPath(rect: rect).fill()
    case .blockHollow:
      color.setStroke()
      NSBezierPath(rect: rect).stroke()
    }
  }

  private func configureLayer() {
    wantsLayer = true
    layer?.cornerRadius = Self.cornerRadius
    layer?.cornerCurve = .continuous
    layer?.masksToBounds = true
  }

  private func nsColor(_ color: GhosttyRenderColor) -> NSColor {
    let alpha = color.alpha == 0 ? UInt8(255) : color.alpha
    return NSColor(
      calibratedRed: CGFloat(color.red) / 255.0,
      green: CGFloat(color.green) / 255.0,
      blue: CGFloat(color.blue) / 255.0,
      alpha: CGFloat(alpha) / 255.0
    )
  }

  private func isDefaultColor(_ color: GhosttyRenderColor, fallback: GhosttyRenderColor) -> Bool {
    color.alpha == 0 || color == fallback
  }

  private func adjustedForeground(_ fg: NSColor, for bg: NSColor) -> NSColor {
    guard let fgRGB = fg.usingColorSpace(.deviceRGB), let bgRGB = bg.usingColorSpace(.deviceRGB) else {
      return fg
    }
    let fgLum = 0.2126 * fgRGB.redComponent + 0.7152 * fgRGB.greenComponent + 0.0722 * fgRGB.blueComponent
    let bgLum = 0.2126 * bgRGB.redComponent + 0.7152 * bgRGB.greenComponent + 0.0722 * bgRGB.blueComponent
    let contrast = abs(fgLum - bgLum)
    guard contrast < 0.25 else { return fg }
    if bgLum < 0.5 {
      return NSColor(white: 0.92, alpha: fgRGB.alphaComponent)
    }
    return NSColor(white: 0.08, alpha: fgRGB.alphaComponent)
  }

  private func fontForCellFlags(_ flags: UInt16) -> NSFont {
    var key: UInt8 = 0
    if (flags & 0x1) != 0 { key |= 0x1 }
    if (flags & 0x2) != 0 { key |= 0x2 }
    if let cached = fontCache[key] { return cached }

    // For regular text, return the base font directly
    // This avoids font family loss from withSymbolicTraits
    guard key != 0 else {
      fontCache[0] = font
      return font
    }

    // For bold/italic, use NSFontManager which preserves the font family better
    let manager = NSFontManager.shared
    var styled = font
    if (flags & 0x1) != 0 {
      styled = manager.convert(styled, toHaveTrait: .boldFontMask)
    }
    if (flags & 0x2) != 0 {
      styled = manager.convert(styled, toHaveTrait: .italicFontMask)
    }
    fontCache[key] = styled
    return styled
  }

  /**
   * Draws box-drawing characters (U+2500-U+257F) programmatically.
   * This ensures clean connections between adjacent cells regardless of font.
   */
  private func drawBoxDrawingCharacter(_ codepoint: UInt32, in rect: CGRect, color: NSColor) {
    guard let context = NSGraphicsContext.current?.cgContext else { return }

    let lineWidth: CGFloat = max(1, min(rect.width, rect.height) * 0.08)
    context.setStrokeColor(color.cgColor)
    context.setFillColor(color.cgColor)
    context.setLineWidth(lineWidth)
    context.setLineCap(.square)

    let midX = rect.midX
    let midY = rect.midY
    let minX = rect.minX
    let maxX = rect.maxX
    let minY = rect.minY
    let maxY = rect.maxY

    let index = Int(codepoint - 0x2500)
    let lines = boxDrawingLines[min(index, boxDrawingLines.count - 1)]

    if lines.left { context.move(to: CGPoint(x: minX, y: midY)); context.addLine(to: CGPoint(x: midX, y: midY)) }
    if lines.right { context.move(to: CGPoint(x: midX, y: midY)); context.addLine(to: CGPoint(x: maxX, y: midY)) }
    if lines.up { context.move(to: CGPoint(x: midX, y: minY)); context.addLine(to: CGPoint(x: midX, y: midY)) }
    if lines.down { context.move(to: CGPoint(x: midX, y: midY)); context.addLine(to: CGPoint(x: midX, y: maxY)) }

    context.strokePath()
  }

  /**
   * Draws block elements (U+2580-U+259F) programmatically.
   */
  private func drawBlockElement(_ codepoint: UInt32, in rect: CGRect, color: NSColor) {
    guard let context = NSGraphicsContext.current?.cgContext else { return }
    context.setFillColor(color.cgColor)

    let fillRect: CGRect
    switch codepoint {
    case 0x2580: // ▀ Upper half
      fillRect = CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height / 2)
    case 0x2584: // ▄ Lower half
      fillRect = CGRect(x: rect.minX, y: rect.midY, width: rect.width, height: rect.height / 2)
    case 0x2588: // █ Full block
      fillRect = rect
    case 0x258C: // ▌ Left half
      fillRect = CGRect(x: rect.minX, y: rect.minY, width: rect.width / 2, height: rect.height)
    case 0x2590: // ▐ Right half
      fillRect = CGRect(x: rect.midX, y: rect.minY, width: rect.width / 2, height: rect.height)
    case 0x2591: // ░ Light shade (25%)
      context.setFillColor(color.withAlphaComponent(0.25).cgColor)
      fillRect = rect
    case 0x2592: // ▒ Medium shade (50%)
      context.setFillColor(color.withAlphaComponent(0.5).cgColor)
      fillRect = rect
    case 0x2593: // ▓ Dark shade (75%)
      context.setFillColor(color.withAlphaComponent(0.75).cgColor)
      fillRect = rect
    default:
      fillRect = rect
    }
    context.fill(fillRect)
  }

  /// Lookup table for box-drawing character line segments
  private var boxDrawingLines: [(left: Bool, right: Bool, up: Bool, down: Bool)] {
    [
      // 2500-250F: Basic horizontal/vertical lines
      (true, true, false, false),   // ─ 2500
      (true, true, false, false),   // ━ 2501 (heavy)
      (false, false, true, true),   // │ 2502
      (false, false, true, true),   // ┃ 2503 (heavy)
      (true, true, false, false),   // ┄ 2504 (triple dash)
      (true, true, false, false),   // ┅ 2505
      (false, false, true, true),   // ┆ 2506
      (false, false, true, true),   // ┇ 2507
      (true, true, false, false),   // ┈ 2508 (quadruple dash)
      (true, true, false, false),   // ┉ 2509
      (false, false, true, true),   // ┊ 250A
      (false, false, true, true),   // ┋ 250B
      (false, true, false, true),   // ┌ 250C (down and right)
      (false, true, false, true),   // ┍ 250D
      (false, true, false, true),   // ┎ 250E
      (false, true, false, true),   // ┏ 250F

      // 2510-251F: More corners
      (true, false, false, true),   // ┐ 2510 (down and left)
      (true, false, false, true),   // ┑ 2511
      (true, false, false, true),   // ┒ 2512
      (true, false, false, true),   // ┓ 2513
      (false, true, true, false),   // └ 2514 (up and right)
      (false, true, true, false),   // ┕ 2515
      (false, true, true, false),   // ┖ 2516
      (false, true, true, false),   // ┗ 2517
      (true, false, true, false),   // ┘ 2518 (up and left)
      (true, false, true, false),   // ┙ 2519
      (true, false, true, false),   // ┚ 251A
      (true, false, true, false),   // ┛ 251B
      (false, true, true, true),    // ├ 251C (vertical and right)
      (false, true, true, true),    // ┝ 251D
      (false, true, true, true),    // ┞ 251E
      (false, true, true, true),    // ┟ 251F

      // 2520-252F: T-junctions
      (false, true, true, true),    // ┠ 2520
      (false, true, true, true),    // ┡ 2521
      (false, true, true, true),    // ┢ 2522
      (false, true, true, true),    // ┣ 2523
      (true, false, true, true),    // ┤ 2524 (vertical and left)
      (true, false, true, true),    // ┥ 2525
      (true, false, true, true),    // ┦ 2526
      (true, false, true, true),    // ┧ 2527
      (true, false, true, true),    // ┨ 2528
      (true, false, true, true),    // ┩ 2529
      (true, false, true, true),    // ┪ 252A
      (true, false, true, true),    // ┫ 252B
      (true, true, false, true),    // ┬ 252C (down and horizontal)
      (true, true, false, true),    // ┭ 252D
      (true, true, false, true),    // ┮ 252E
      (true, true, false, true),    // ┯ 252F

      // 2530-253F: More T-junctions
      (true, true, false, true),    // ┰ 2530
      (true, true, false, true),    // ┱ 2531
      (true, true, false, true),    // ┲ 2532
      (true, true, false, true),    // ┳ 2533
      (true, true, true, false),    // ┴ 2534 (up and horizontal)
      (true, true, true, false),    // ┵ 2535
      (true, true, true, false),    // ┶ 2536
      (true, true, true, false),    // ┷ 2537
      (true, true, true, false),    // ┸ 2538
      (true, true, true, false),    // ┹ 2539
      (true, true, true, false),    // ┺ 253A
      (true, true, true, false),    // ┻ 253B
      (true, true, true, true),     // ┼ 253C (cross)
      (true, true, true, true),     // ┽ 253D
      (true, true, true, true),     // ┾ 253E
      (true, true, true, true),     // ┿ 253F

      // 2540-254F: Cross variants
      (true, true, true, true),     // ╀ 2540
      (true, true, true, true),     // ╁ 2541
      (true, true, true, true),     // ╂ 2542
      (true, true, true, true),     // ╃ 2543
      (true, true, true, true),     // ╄ 2544
      (true, true, true, true),     // ╅ 2545
      (true, true, true, true),     // ╆ 2546
      (true, true, true, true),     // ╇ 2547
      (true, true, true, true),     // ╈ 2548
      (true, true, true, true),     // ╉ 2549
      (true, true, true, true),     // ╊ 254A
      (true, true, true, true),     // ╋ 254B
      (true, true, false, false),   // ╌ 254C (light double dash)
      (true, true, false, false),   // ╍ 254D
      (false, false, true, true),   // ╎ 254E
      (false, false, true, true),   // ╏ 254F

      // 2550-255F: Double lines
      (true, true, false, false),   // ═ 2550
      (false, false, true, true),   // ║ 2551
      (false, true, false, true),   // ╒ 2552
      (false, true, false, true),   // ╓ 2553
      (false, true, false, true),   // ╔ 2554
      (true, false, false, true),   // ╕ 2555
      (true, false, false, true),   // ╖ 2556
      (true, false, false, true),   // ╗ 2557
      (false, true, true, false),   // ╘ 2558
      (false, true, true, false),   // ╙ 2559
      (false, true, true, false),   // ╚ 255A
      (true, false, true, false),   // ╛ 255B
      (true, false, true, false),   // ╜ 255C
      (true, false, true, false),   // ╝ 255D
      (false, true, true, true),    // ╞ 255E
      (false, true, true, true),    // ╟ 255F

      // 2560-256F: More double line combinations
      (false, true, true, true),    // ╠ 2560
      (true, false, true, true),    // ╡ 2561
      (true, false, true, true),    // ╢ 2562
      (true, false, true, true),    // ╣ 2563
      (true, true, false, true),    // ╤ 2564
      (true, true, false, true),    // ╥ 2565
      (true, true, false, true),    // ╦ 2566
      (true, true, true, false),    // ╧ 2567
      (true, true, true, false),    // ╨ 2568
      (true, true, true, false),    // ╩ 2569
      (true, true, true, true),     // ╪ 256A
      (true, true, true, true),     // ╫ 256B
      (true, true, true, true),     // ╬ 256C
      (false, false, false, true),  // ╭ 256D (arc down and right)
      (false, false, false, true),  // ╮ 256E (arc down and left)
      (false, false, true, false),  // ╯ 256F (arc up and left)

      // 2570-257F: Arcs and diagonals
      (false, false, true, false),  // ╰ 2570 (arc up and right)
      (true, true, true, true),     // ╱ 2571 (diagonal)
      (true, true, true, true),     // ╲ 2572 (diagonal)
      (true, true, true, true),     // ╳ 2573 (diagonal cross)
      (true, false, false, false),  // ╴ 2574 (left)
      (false, false, true, false),  // ╵ 2575 (up)
      (false, true, false, false),  // ╶ 2576 (right)
      (false, false, false, true),  // ╷ 2577 (down)
      (true, false, false, false),  // ╸ 2578 (heavy left)
      (false, false, true, false),  // ╹ 2579 (heavy up)
      (false, true, false, false),  // ╺ 257A (heavy right)
      (false, false, false, true),  // ╻ 257B (heavy down)
      (true, true, false, false),   // ╼ 257C (light left heavy right)
      (false, false, true, true),   // ╽ 257D (light up heavy down)
      (true, true, false, false),   // ╾ 257E (heavy left light right)
      (false, false, true, true),   // ╿ 257F (heavy up light down)
    ]
  }
}
