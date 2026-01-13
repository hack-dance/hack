# Hack Desktop (macOS)

Native macOS app for managing local hack projects and daemon status.

## Requirements

- macOS 14+
- Xcode 15.1+
- XcodeGen (`brew install xcodegen`)

## Generate the Xcode project

```bash
xcodegen -c project.yml
```

This generates `HackDesktop.xcodeproj`. Do not edit the generated project directly.

## Build (CLI)

From `apps/macos`:

```bash
swift build
swift test
```

## Run

Open `HackDesktop.xcodeproj` in Xcode and run the app. The app uses the `hack` CLI
(via your PATH) to fetch status and run actions.

If `hack` is not in PATH for GUI apps, ensure it lives in `/opt/homebrew/bin` or
`/usr/local/bin` (both are added to PATH by the app).
