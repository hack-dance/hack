import SwiftUI

enum StatusTone {
  case good
  case warn
  case neutral
}

struct StatusPill: View {
  let text: String
  let tone: StatusTone

  var body: some View {
    BadgePill(label: text, tint: tint)
  }

  private var tint: Color {
    switch tone {
    case .good:
      return .green
    case .warn:
      return .orange
    case .neutral:
      return .secondary
    }
  }
}
