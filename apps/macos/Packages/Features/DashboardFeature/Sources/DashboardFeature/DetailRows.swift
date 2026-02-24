import SwiftUI

struct DetailRowItem: Identifiable {
  let id = UUID()
  let label: String
  let value: String
}

struct DetailRows: View {
  let rows: [DetailRowItem]
  let labelWidth: CGFloat

  init(rows: [DetailRowItem], labelWidth: CGFloat = 140) {
    self.rows = rows
    self.labelWidth = labelWidth
  }

  var body: some View {
    Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
      ForEach(rows) { row in
        GridRow {
          Text(row.label)
            .font(.mono(.caption))
            .foregroundStyle(.secondary)
            .frame(width: labelWidth, alignment: .leading)
          Text(row.value)
            .font(.mono(.subheadline))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
    }
  }
}
