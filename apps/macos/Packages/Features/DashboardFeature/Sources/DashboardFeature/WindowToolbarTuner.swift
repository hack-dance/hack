import AppKit
import SwiftUI

/// SwiftUI does not currently expose enough hooks to style the system-provided sidebar toggle
/// (and other titlebar toolbar items) on macOS 26+. This view modifier tunes the underlying
/// `NSWindow` / `NSToolbar` to keep toolbar items borderless and compact, avoiding the default
/// per-item "pill" backgrounds.
extension View {
  func tuneWindowToolbar() -> some View {
    background(WindowToolbarTuner())
  }
}

private struct WindowToolbarTuner: NSViewRepresentable {
  final class HookView: NSView {
    private weak var lastWindow: NSWindow?

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()

      guard let window else { return }
      guard lastWindow !== window else { return }
      lastWindow = window

      DispatchQueue.main.async {
        tune(window: window)
      }
    }
  }

  func makeNSView(context: Context) -> HookView {
    HookView(frame: .zero)
  }

  func updateNSView(_ nsView: HookView, context: Context) {}
}

private func tune(window: NSWindow) {
  window.titleVisibility = .hidden
  window.titlebarAppearsTransparent = true

  guard let toolbar = window.toolbar else { return }
  toolbar.showsBaselineSeparator = false
  toolbar.sizeMode = .small

  for item in toolbar.items {
    // Prefer borderless toolbar items (works for most custom items).
    item.isBordered = false

    // Only tune the *system* sidebar toggle view tree. Mutating arbitrary SwiftUI-hosted toolbar
    // views can break layout/rendering for our principal titlebar strip (menus, chevrons, etc.).
    if item.itemIdentifier == .toggleSidebar, let view = item.view {
      tuneToolbarViewTree(view)
    }
  }
}

private func tuneToolbarViewTree(_ view: NSView) {
  if let button = view as? NSButton {
    button.isBordered = false
    button.bezelStyle = .regularSquare
    button.focusRingType = .none
    button.controlSize = .small
    button.wantsLayer = true
    button.layer?.backgroundColor = NSColor.clear.cgColor
  }

  if let segmented = view as? NSSegmentedControl {
    segmented.segmentStyle = .texturedSquare
    segmented.controlSize = .small
  }

  for subview in view.subviews {
    tuneToolbarViewTree(subview)
  }
}
