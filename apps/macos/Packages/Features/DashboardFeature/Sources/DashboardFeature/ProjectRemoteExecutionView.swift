import SwiftUI

/// Layout container for the project remote-execution pane.
///
/// This keeps scrolling/padding behavior isolated from `ProjectDetailView`
/// so remote execution UX can evolve independently.
struct ProjectRemoteExecutionView<RuntimeCard: View, SectionContent: View, InfoPanel: View>: View {
  let showsRuntimeNotConfigured: Bool
  let showsInfoPanel: Bool
  let runtimeCard: () -> RuntimeCard
  let sectionContent: () -> SectionContent
  let infoPanel: () -> InfoPanel

  init(
    showsRuntimeNotConfigured: Bool,
    showsInfoPanel: Bool,
    @ViewBuilder runtimeCard: @escaping () -> RuntimeCard,
    @ViewBuilder sectionContent: @escaping () -> SectionContent,
    @ViewBuilder infoPanel: @escaping () -> InfoPanel
  ) {
    self.showsRuntimeNotConfigured = showsRuntimeNotConfigured
    self.showsInfoPanel = showsInfoPanel
    self.runtimeCard = runtimeCard
    self.sectionContent = sectionContent
    self.infoPanel = infoPanel
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        if showsRuntimeNotConfigured {
          runtimeCard()
        }

        sectionContent()

        if showsInfoPanel {
          infoPanel()
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
      }
      .padding(20)
      .frame(maxWidth: .infinity, alignment: .topLeading)
    }
  }
}
