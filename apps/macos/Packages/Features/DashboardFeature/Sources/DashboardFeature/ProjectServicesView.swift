import SwiftUI

/// Split-view container for project services and service details.
///
/// The left pane renders the service list, while the right pane renders either
/// a selected service detail panel or a placeholder.
struct ProjectServicesView<
  ServicesList: View,
  DetailPanel: View
>: View {
  @Environment(\.colorScheme) private var colorScheme
  @State private var detailPanelWidth: CGFloat = 340
  @State private var detailPanelDragStartWidth: CGFloat?
  @State private var isResizeHandleHovered = false
  @GestureState private var isResizingDetailPanel = false

  let showOverviewSidebar: Bool
  let hasSelection: Bool
  let servicesList: () -> ServicesList
  let detailPanel: () -> DetailPanel

  init(
    showOverviewSidebar: Bool,
    hasSelection: Bool,
    @ViewBuilder servicesList: @escaping () -> ServicesList,
    @ViewBuilder detailPanel: @escaping () -> DetailPanel
  ) {
    self.showOverviewSidebar = showOverviewSidebar
    self.hasSelection = hasSelection
    self.servicesList = servicesList
    self.detailPanel = detailPanel
  }

  var body: some View {
    HStack(alignment: .top, spacing: 0) {
      ScrollView {
        servicesList()
          .frame(maxWidth: .infinity, alignment: .topLeading)
      }
      .scrollIndicators(.visible)

      if showOverviewSidebar && hasSelection {
        detailResizeHandle

        ScrollView {
          detailPanel()
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .scrollIndicators(.visible)
        .background(detailPanelFillColor)
        .frame(width: detailPanelWidth)
        .frame(maxHeight: .infinity, alignment: .topLeading)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  /// Interactive divider between the service list and details panel.
  /// Dragging horizontally resizes the details panel while preserving min/max bounds.
  private var detailResizeHandle: some View {
    Rectangle()
      .fill(Color.clear)
      .frame(width: 12)
      .background(alignment: .center) {
        Rectangle()
          .fill(detailResizeLineColor)
          .frame(width: 1.2)
      }
      .contentShape(Rectangle())
      .onHover { hovering in
        isResizeHandleHovered = hovering
      }
      .gesture(
        DragGesture(minimumDistance: 1)
          .updating($isResizingDetailPanel) { _, state, _ in
            state = true
          }
          .onChanged { value in
            if detailPanelDragStartWidth == nil {
              detailPanelDragStartWidth = detailPanelWidth
            }
            let startingWidth = detailPanelDragStartWidth ?? detailPanelWidth
            detailPanelWidth = clampedDetailPanelWidth(startingWidth - value.translation.width)
          }
          .onEnded { _ in
            detailPanelDragStartWidth = nil
          }
      )
  }

  private var detailResizeLineColor: Color {
    if isResizingDetailPanel {
      return Color.accentColor.opacity(0.75)
    }
    if isResizeHandleHovered {
      return detailPanelBorderColor.opacity(0.95)
    }
    return detailPanelBorderColor.opacity(0.6)
  }

  private var detailPanelFillColor: Color {
    if colorScheme == .dark {
      return Color.black.opacity(0.22)
    }
    return Color.black.opacity(0.03)
  }

  private var detailPanelBorderColor: Color {
    if colorScheme == .dark {
      return Color.white.opacity(0.2)
    }
    return Color.black.opacity(0.16)
  }

  private func clampedDetailPanelWidth(_ width: CGFloat) -> CGFloat {
    min(max(width, 280), 560)
  }
}
