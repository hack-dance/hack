# Retained macOS source

This app is unsupported and excluded from Hack's CLI release pipeline. Work here
only for an explicit native-app request. Read `README.md` in this directory for the
current source layout and local commands; do not restore signing or publishing gates
without an authorized product change.

- Preserve deployment targets from `project.yml` and `Config/Base.xcconfig`. Guard
  newer APIs and verify against the installed Xcode SDK; do not raise the target
  merely to follow a design example.
- Prefer the existing SwiftUI/AppKit structure. Use stable view identity, explicit
  ownership, main-actor UI updates, and cancellable async work.
- Verify keyboard access, VoiceOver, focus, appearance and reduced motion for changed
  flows. Provide shortcuts, contextual menus and undo where they fit the action;
  do not require every control to support every interaction.
- Use Apple's current Human Interface Guidelines and API documentation when a
  platform decision needs external grounding. Generic design examples are not a
  reason to broaden Hack's product scope or rewrite unaffected UI.
- Regenerate the Xcode project from source configuration. Verify changed behavior
  with the relevant Swift tests and local app observation; CLI CI does not prove it.
- Preserve the unsupported boundary for hosted auth, tickets, GitHub/Linear,
  remote/gateway management, and app distribution.
