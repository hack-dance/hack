import SwiftUI

struct BadgePill: View {
  let label: String
  let tint: Color

  var body: some View {
    if #available(macOS 26, *) {
      Text(label)
        .font(.mono(.caption2, weight: .semibold))
        .lineLimit(1)
        .truncationMode(.tail)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .foregroundStyle(tint)
        .background(
          Capsule(style: .continuous)
            .fill(.regularMaterial)
        )
        .glassEffect(.regular.tint(tint.opacity(0.15)))
    } else {
      Text(label)
        .font(.mono(.caption2, weight: .semibold))
        .lineLimit(1)
        .truncationMode(.tail)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .foregroundStyle(tint)
        .background(
          Capsule(style: .continuous)
            .fill(.thinMaterial)
            .overlay(
              Capsule(style: .continuous)
                .stroke(tint.opacity(0.35), lineWidth: 1)
            )
        )
    }
  }
}

struct LabelBadge: View {
  let label: String
  let color: Color

  var body: some View {
    BadgePill(label: label, tint: color)
  }
}
