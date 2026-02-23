import SwiftUI

struct DetailRowItem {
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
      ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
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
