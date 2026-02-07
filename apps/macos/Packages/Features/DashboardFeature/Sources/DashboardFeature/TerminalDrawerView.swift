import AppKit
import SwiftUI

import GhosttyTerminal
import HackDesktopModels

struct TerminalDrawerHeightPreferenceKey: PreferenceKey {
  static var defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    value = nextValue()
  }
}

struct TerminalDrawerView: View {
  let title: String
  let onClose: () -> Void

  @Bindable var model: TerminalDrawerModel

  init(
    title: String,
    model: TerminalDrawerModel,
    onClose: @escaping () -> Void
  ) {
    self.title = title
    self.onClose = onClose
    self.model = model
  }

  var body: some View {
    VStack(spacing: 0) {
      content
    }
    .frame(maxWidth: .infinity, alignment: .topLeading)
    .frame(minHeight: 0)
    .background(.regularMaterial)
    .overlay(
      Rectangle()
        .fill(Color.primary.opacity(0.10))
        .frame(height: 1),
      alignment: .top
    )
    .background(
      GeometryReader { proxy in
        Color.clear.preference(key: TerminalDrawerHeightPreferenceKey.self, value: proxy.size.height)
      }
    )
    .onAppear {
      model.setActive(true)
      model.startAll()
    }
    .onDisappear {
      model.setActive(false)
      model.stopAll()
    }
  }

  @ViewBuilder
  private var content: some View {
    if selectedSession?.isAvailable == true {
      VStack(spacing: 0) {
        tabsBar
          .padding(.horizontal, 10)
          .padding(.vertical, 6)

        if let selectedSession {
          GhosttyTerminalView(session: selectedSession)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
          .frame(minHeight: 0)
          .background(Color.black.opacity(0.97))
        }
      }
    } else {
      VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 8) {
          Image(systemName: "exclamationmark.triangle.fill")
            .foregroundStyle(.orange)
          Text("Embedded terminal unavailable")
            .font(.mono(.subheadline, weight: .medium))
        }
        Text(GhosttyVTRuntime.shared.loadMessage ?? "Ghostty VT unavailable")
          .font(.mono(.caption))
          .foregroundStyle(.secondary)
      }
      .padding(14)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
  }

  private var selectedSession: GhosttyTerminalSession? {
    model.selectedSession()
  }

  private var tabsBar: some View {
    HStack(spacing: 8) {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
          ForEach(model.tabs) { tab in
            TerminalTabButton(
              title: tab.title,
              isSelected: tab.id == model.selectedTabId,
              onSelect: { model.selectedTabId = tab.id },
              onClose: model.tabs.count > 1 ? { model.closeTab(id: tab.id) } : nil
            )
          }

          Button(action: model.addShellTab) {
            Image(systemName: "plus")
              .font(.system(size: 12, weight: .semibold))
              .foregroundStyle(.secondary)
              .frame(width: 22, height: 22)
              .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
          }
          .buttonStyle(.plain)
          .keyboardShortcut("t", modifiers: .command)
          .help("New tab")
          .accessibilityLabel("New tab")
        }
      }

      Spacer(minLength: 10)

      // When the terminal drawer is open, `cmd+w` should close the current tab
      // (or close the drawer if it's the last tab), not close the window.
      Button(action: closeSelectedTabOrDrawer) {
        EmptyView()
      }
      .keyboardShortcut("w", modifiers: .command)
      .opacity(0)
      .frame(width: 0, height: 0)
      .accessibilityHidden(true)

      Button(action: onClose) {
        Image(systemName: "xmark")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(.secondary)
          .frame(width: 20, height: 20)
          .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
      }
      .buttonStyle(.plain)
      .help("Close terminal")
      .accessibilityLabel("Close terminal")
    }
    .frame(height: 22)
  }

  private func closeSelectedTabOrDrawer() {
    if model.tabs.count <= 1 {
      onClose()
      return
    }
    model.closeTab(id: model.selectedTabId)
  }
}

extension TerminalDrawerView {
  static var heightPreferenceKey: TerminalDrawerHeightPreferenceKey.Type { TerminalDrawerHeightPreferenceKey.self }
}

private struct TerminalTabButton: View {
  let title: String
  let isSelected: Bool
  let onSelect: () -> Void
  let onClose: (() -> Void)?

  @State private var isHovered = false

  var body: some View {
    HStack(spacing: 6) {
      Text(title)
        .font(.mono(.caption, weight: .medium))
        .foregroundStyle(isSelected ? .primary : .secondary)
        .lineLimit(1)

      if let onClose, isHovered {
        Button(action: onClose) {
          Image(systemName: "xmark")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(.secondary)
            .frame(width: 16, height: 16)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .help("Close tab")
        .accessibilityLabel("Close tab")
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 6)
    .background(background)
    .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    .onTapGesture(perform: onSelect)
    .onHover { hovering in
      isHovered = hovering
    }
    .animation(.easeInOut(duration: 0.12), value: isHovered)
  }

  @ViewBuilder
  private var background: some View {
    let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)

    if isSelected {
      shape
        .fill(Color.white.opacity(0.65))
        .overlay(shape.strokeBorder(Color.black.opacity(0.08), lineWidth: 1))
    } else if isHovered {
      shape
        .fill(Color.primary.opacity(0.06))
        .overlay(shape.strokeBorder(Color.primary.opacity(0.08), lineWidth: 1))
    } else {
      shape.fill(Color.clear)
    }
  }
}
