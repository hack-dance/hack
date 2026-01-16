import SwiftUI

struct GhosttyTerminalView: View {
  @Bindable var session: GhosttyTerminalSession

  var body: some View {
    GhosttyTerminalTextView(session: session)
  }
}
