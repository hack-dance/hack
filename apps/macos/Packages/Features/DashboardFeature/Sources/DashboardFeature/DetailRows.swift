import SwiftUI

struct DetailRowItem: Identifiable {
  let id = UUID()
  let label: String
  let value: String
}

struct DetailRows: View {
  let rows: [DetailRowItem]

  var body: some View {
    Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
      ForEach(rows) { row in
        GridRow {
          Text(row.label)
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(width: 120, alignment: .leading)
          Text(row.value)
            .font(.subheadline)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
    }
  }
}
