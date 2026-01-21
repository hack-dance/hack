import Darwin
import Foundation

@frozen
public struct GhosttyRenderColor: Equatable {
  public let red: UInt8
  public let green: UInt8
  public let blue: UInt8
  public let alpha: UInt8

  public init(red: UInt8, green: UInt8, blue: UInt8, alpha: UInt8) {
    self.red = red
    self.green = green
    self.blue = blue
    self.alpha = alpha
  }
}

@frozen
public struct GhosttyRenderCell: Equatable {
  public let codepoint: UInt32
  public let foreground: GhosttyRenderColor
  public let background: GhosttyRenderColor
  public let wide: UInt8
  public let flags: UInt16

  public init(
    codepoint: UInt32,
    foreground: GhosttyRenderColor,
    background: GhosttyRenderColor,
    wide: UInt8,
    flags: UInt16
  ) {
    self.codepoint = codepoint
    self.foreground = foreground
    self.background = background
    self.wide = wide
    self.flags = flags
  }
}

public enum GhosttyCursorStyle: UInt8 {
  case bar = 0
  case block = 1
  case underline = 2
  case blockHollow = 3
}

@frozen
public struct GhosttyCursor {
  public let x: Int
  public let y: Int
  public let isVisible: Bool
  public let style: GhosttyCursorStyle
  public let wideTail: Bool

  public init(x: Int, y: Int, isVisible: Bool, style: GhosttyCursorStyle, wideTail: Bool) {
    self.x = x
    self.y = y
    self.isVisible = isVisible
    self.style = style
    self.wideTail = wideTail
  }
}

@frozen
public struct GhosttyRenderSnapshot {
  public let rows: Int
  public let cols: Int
  public let cursor: GhosttyCursor
  public let defaultForeground: GhosttyRenderColor
  public let defaultBackground: GhosttyRenderColor
  public let cursorColor: GhosttyRenderColor
  public let cells: [GhosttyRenderCell]

  public init(
    rows: Int,
    cols: Int,
    cursor: GhosttyCursor,
    defaultForeground: GhosttyRenderColor,
    defaultBackground: GhosttyRenderColor,
    cursorColor: GhosttyRenderColor,
    cells: [GhosttyRenderCell]
  ) {
    self.rows = rows
    self.cols = cols
    self.cursor = cursor
    self.defaultForeground = defaultForeground
    self.defaultBackground = defaultBackground
    self.cursorColor = cursorColor
    self.cells = cells
  }
}

public final class GhosttyVTRuntime {
  public static let shared = GhosttyVTRuntime()

  public let isAvailable: Bool
  public let loadMessage: String?

  private let libraryHandle: UnsafeMutableRawPointer?
  private let functions: Functions?

  private init() {
    let resolved = GhosttyVTRuntime.resolveLibraryPath()
    guard let path = resolved?.path else {
      isAvailable = false
      loadMessage = "Ghostty VT library not found"
      libraryHandle = nil
      functions = nil
      return
    }

    _ = dlerror()
    let handle = dlopen(path, RTLD_NOW)
    guard let handle else {
      let error = dlerror().map { String(cString: $0) }
      isAvailable = false
      if let error {
        loadMessage = "Failed to load Ghostty VT at \(path): \(error)"
      } else {
        loadMessage = "Failed to load Ghostty VT at \(path)"
      }
      libraryHandle = nil
      functions = nil
      return
    }

    guard let functions = Functions(handle: handle) else {
      isAvailable = false
      loadMessage = "Missing Ghostty VT symbols"
      dlclose(handle)
      libraryHandle = nil
      self.functions = nil
      return
    }

    isAvailable = true
    loadMessage = nil
    libraryHandle = handle
    self.functions = functions
  }

  deinit {
    if let libraryHandle {
      dlclose(libraryHandle)
    }
  }

  public func makeTerminal(cols: Int, rows: Int) -> GhosttyTerminal? {
    guard let functions, isAvailable else { return nil }
    return GhosttyTerminal(functions: functions, cols: cols, rows: rows)
  }

  private static func resolveLibraryPath() -> URL? {
    if let envPath = ProcessInfo.processInfo.environment["HACK_GHOSTTY_VT_LIB"] {
      let envURL = URL(fileURLWithPath: envPath)
      if FileManager.default.fileExists(atPath: envURL.path) {
        return envURL
      }
    }

    let home = FileManager.default.homeDirectoryForCurrentUser
    let defaultPath = home
      .appendingPathComponent("Library/Application Support/Hack/ghostty/lib")
      .appendingPathComponent("libhack_ghostty_vt.dylib")
    if FileManager.default.fileExists(atPath: defaultPath.path) {
      return defaultPath
    }

    return nil
  }

  fileprivate struct Functions {
    typealias Create = @convention(c) (UInt32, UInt32) -> UnsafeMutableRawPointer?
    typealias Destroy = @convention(c) (UnsafeMutableRawPointer?) -> Void
    typealias Resize = @convention(c) (UnsafeMutableRawPointer?, UInt32, UInt32) -> Void
    typealias Feed = @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<UInt8>?, Int) -> Void
    typealias PlainString = @convention(c) (UnsafeMutableRawPointer?, UnsafeMutablePointer<Int>?) -> UnsafeMutablePointer<UInt8>?
    typealias HtmlString = @convention(c) (UnsafeMutableRawPointer?, UnsafeMutablePointer<Int>?) -> UnsafeMutablePointer<UInt8>?
    typealias FreeString = @convention(c) (UnsafeMutablePointer<UInt8>?, Int) -> Void
    typealias RenderSnapshot = @convention(c) (UnsafeMutableRawPointer?) -> UnsafeMutableRawPointer?
    typealias RenderSnapshotFree = @convention(c) (UnsafeMutableRawPointer?) -> Void

    let create: Create
    let destroy: Destroy
    let resize: Resize
    let feed: Feed
    let plainString: PlainString
    let htmlString: HtmlString?
    let freeString: FreeString
    let renderSnapshot: RenderSnapshot
    let renderSnapshotFree: RenderSnapshotFree

    init?(handle: UnsafeMutableRawPointer) {
      guard
        let create = dlsym(handle, "hack_ghostty_vt_create"),
        let destroy = dlsym(handle, "hack_ghostty_vt_destroy"),
        let resize = dlsym(handle, "hack_ghostty_vt_resize"),
        let feed = dlsym(handle, "hack_ghostty_vt_feed"),
        let plainString = dlsym(handle, "hack_ghostty_vt_plain_string"),
        let freeString = dlsym(handle, "hack_ghostty_vt_free_string"),
        let renderSnapshot = dlsym(handle, "hack_ghostty_vt_render_snapshot"),
        let renderSnapshotFree = dlsym(handle, "hack_ghostty_vt_render_snapshot_free")
      else {
        return nil
      }

      let htmlString = dlsym(handle, "hack_ghostty_vt_html_string")

      self.create = unsafeBitCast(create, to: Create.self)
      self.destroy = unsafeBitCast(destroy, to: Destroy.self)
      self.resize = unsafeBitCast(resize, to: Resize.self)
      self.feed = unsafeBitCast(feed, to: Feed.self)
      self.plainString = unsafeBitCast(plainString, to: PlainString.self)
      self.htmlString = htmlString.map { unsafeBitCast($0, to: HtmlString.self) }
      self.freeString = unsafeBitCast(freeString, to: FreeString.self)
      self.renderSnapshot = unsafeBitCast(renderSnapshot, to: RenderSnapshot.self)
      self.renderSnapshotFree = unsafeBitCast(renderSnapshotFree, to: RenderSnapshotFree.self)
    }
  }
}

public final class GhosttyTerminal {
  private let functions: GhosttyVTRuntime.Functions
  private let handle: UnsafeMutableRawPointer

  fileprivate init?(functions: GhosttyVTRuntime.Functions, cols: Int, rows: Int) {
    guard let handle = functions.create(UInt32(cols), UInt32(rows)) else {
      return nil
    }
    self.functions = functions
    self.handle = handle
  }

  deinit {
    functions.destroy(handle)
  }

  public func resize(cols: Int, rows: Int) {
    functions.resize(handle, UInt32(cols), UInt32(rows))
  }

  public func feed(_ data: Data) {
    data.withUnsafeBytes { buffer in
      functions.feed(handle, buffer.bindMemory(to: UInt8.self).baseAddress, data.count)
    }
  }

  public func plainString() -> String {
    var length = 0
    guard let ptr = functions.plainString(handle, &length), length > 0 else {
      return ""
    }
    let buffer = UnsafeBufferPointer(start: ptr, count: length)
    let text = String(decoding: buffer, as: UTF8.self)
    functions.freeString(ptr, length)
    return text
  }

  public func htmlString() -> String? {
    guard let htmlString = functions.htmlString else { return nil }
    var length = 0
    guard let ptr = htmlString(handle, &length), length > 0 else {
      return ""
    }
    let buffer = UnsafeBufferPointer(start: ptr, count: length)
    let text = String(decoding: buffer, as: UTF8.self)
    functions.freeString(ptr, length)
    return text
  }

  public func renderSnapshot() -> GhosttyRenderSnapshot? {
    guard let snapshotPtr = functions.renderSnapshot(handle) else { return nil }
    defer { functions.renderSnapshotFree(snapshotPtr) }

    let raw = snapshotPtr.bindMemory(to: GhosttyRenderSnapshotRaw.self, capacity: 1).pointee
    let cellCount = Int(raw.cell_count)
    guard cellCount > 0 else { return nil }
    let cellBuffer = UnsafeBufferPointer<GhosttyRenderCellRaw>(start: raw.cells, count: cellCount)
    let cells = cellBuffer.map { GhosttyRenderCell(raw: $0) }

    let cursorStyle = GhosttyCursorStyle(rawValue: raw.cursor_style) ?? .block
    let cursor = GhosttyCursor(
      x: Int(raw.cursor_x),
      y: Int(raw.cursor_y),
      isVisible: raw.cursor_visible != 0,
      style: cursorStyle,
      wideTail: raw.cursor_wide_tail != 0
    )

    return GhosttyRenderSnapshot(
      rows: Int(raw.rows),
      cols: Int(raw.cols),
      cursor: cursor,
      defaultForeground: GhosttyRenderColor(raw.default_fg),
      defaultBackground: GhosttyRenderColor(raw.default_bg),
      cursorColor: GhosttyRenderColor(raw.cursor_color),
      cells: cells
    )
  }
}

struct GhosttyRenderColorRaw {
  var r: UInt8
  var g: UInt8
  var b: UInt8
  var a: UInt8
}

struct GhosttyRenderCellRaw {
  var codepoint: UInt32
  var fg: GhosttyRenderColorRaw
  var bg: GhosttyRenderColorRaw
  var wide: UInt8
  var flags: UInt16
  var _pad: UInt8
}

struct GhosttyRenderSnapshotRaw {
  var rows: UInt16
  var cols: UInt16
  var cursor_x: UInt16
  var cursor_y: UInt16
  var cursor_visible: UInt8
  var cursor_style: UInt8
  var cursor_wide_tail: UInt8
  var _pad0: UInt8
  var default_fg: GhosttyRenderColorRaw
  var default_bg: GhosttyRenderColorRaw
  var cursor_color: GhosttyRenderColorRaw
  var cell_count: Int
  var cells: UnsafeMutablePointer<GhosttyRenderCellRaw>
}

private extension GhosttyRenderColor {
  init(_ raw: GhosttyRenderColorRaw) {
    self.init(red: raw.r, green: raw.g, blue: raw.b, alpha: raw.a)
  }
}

private extension GhosttyRenderCell {
  init(raw: GhosttyRenderCellRaw) {
    self.init(
      codepoint: raw.codepoint,
      foreground: GhosttyRenderColor(raw.fg),
      background: GhosttyRenderColor(raw.bg),
      wide: raw.wide,
      flags: raw.flags
    )
  }
}
