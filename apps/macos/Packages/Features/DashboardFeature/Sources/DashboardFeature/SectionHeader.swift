import SwiftUI

struct SectionHeader<StatusContent: View, ActionsContent: View>: View {
  let breadcrumb: String
  let title: String
  let subtitle: String?
  @ViewBuilder let status: StatusContent
  @ViewBuilder let actions: ActionsContent

  init(
    breadcrumb: String,
    title: String,
    subtitle: String? = nil,
    @ViewBuilder status: () -> StatusContent,
    @ViewBuilder actions: () -> ActionsContent
  ) {
    self.breadcrumb = breadcrumb
    self.title = title
    self.subtitle = subtitle
    self.status = status()
    self.actions = actions()
  }

  var body: some View {
    let trimmed = breadcrumb.trimmingCharacters(in: .whitespacesAndNewlines)
    VStack(alignment: .leading, spacing: 4) {
      if !trimmed.isEmpty {
        Text(trimmed)
          .font(.mono(.caption2))
          .foregroundStyle(.secondary)
      }
      HStack(alignment: .center, spacing: 8) {
        Text(title)
          .font(.mono(.headline, weight: .semibold))
        status
        Spacer()
        actions
      }
      if let subtitle {
        Text(subtitle)
          .font(.mono(.caption2))
          .foregroundStyle(.secondary)
      }
    }
  }
}
