import SwiftUI

/// Layout container for project lifecycle hooks and status output.
struct ProjectLifecycleView<LifecycleSection: View>: View {
  let hasEntries: Bool
  let lifecycleSection: () -> LifecycleSection

  init(
    hasEntries: Bool,
    @ViewBuilder lifecycleSection: @escaping () -> LifecycleSection
  ) {
    self.hasEntries = hasEntries
    self.lifecycleSection = lifecycleSection
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        if hasEntries {
          lifecycleSection()
        } else {
          ContentUnavailableView(
            "No lifecycle hooks",
            systemImage: "bolt.horizontal",
            description: Text("No startup, shutdown, or persistent lifecycle commands are configured for this project.")
          )
          .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
      .padding(20)
      .frame(maxWidth: .infinity, alignment: .topLeading)
    }
  }
}
