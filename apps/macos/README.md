# Hack Desktop (macOS)

Native macOS app for managing local hack projects and daemon status.

## Requirements

- macOS 14+
- Xcode 15.1+
- XcodeGen (`brew install xcodegen`)

## What it does

- Lists local hack projects with status and details.
- Actions: start/stop project, open URL, open logs (experimental).
- Shows hackd status with start/stop controls.
- Includes a fullscreen Settings overlay with sidebar navigation for runtime, gateway, Railway, Tailscale, and node topology.
- GitHub account connect now runs browser OAuth through the auth-broker endpoint surface and imports tokens into local profile keychain storage.
- GitHub connect now supports authorize+install flow hints from the broker and can keep polling in "install required" state until a GitHub App installation is selected.
- Browser callback pages can deep-link back to the app (`hack://auth/github/callback?...`) to immediately refocus and finalize active connect flows.
- Hack account browser sign-in can deep-link back to the app (`hack://auth/complete`) to refocus the account/settings UI after Better Auth finishes in the browser.
- Cloud OAuth remains separate from local gateway/daemon bearer-token auth (transport auth boundary).
- Node topology pane includes a controller-host mode toggle, interactive network graph canvas (node selection, typed edge labels, draggable node layout persisted per controller profile, auto-tidy reflow, expandable full map), primary/default node view, authorized node management, connectivity probes, and pairing request inbox approval actions.
- Tailscale settings now include a dedicated bootstrap auth-key panel; saving there writes the shared key used by private Railway bootstrap (`controlPlane.extensions["dance.hack.tailscale"].config.authKey`, mirrored to Railway compatibility key) with optional `HACK_TAILSCALE_AUTH_KEY` fallback.
- Project detail and topology screens use lazy stacked section rendering plus cancellable async refresh tasks to reduce unnecessary recomputation while navigating quickly.
- Project detail now includes an "Execution target" section for per-project routing: inherited default, fixed node, or provider profile.
- Menu bar item for quick status + actions.

## Quick commands (repo root)

```bash
bun run macos:project-gen
bun run macos:open
bun run macos:dev
bun run macos:build
bun run macos:test
bun run macos:ghostty:setup
```

## Generate the Xcode project

```bash
xcodegen -c
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

If `hack` is not in PATH for GUI apps, ensure it lives in `~/.hack/bin`,
`/opt/homebrew/bin`, or `/usr/local/bin` (all are added to PATH by the app). You
can also set `HACK_CLI_PATH` to an absolute path for the binary.

For GitHub browser OAuth, the app defaults to:

1. `https://auth.hack.broker`
2. `https://auth.hack.gy`
3. `https://auth.hack`
4. `http://127.0.0.1:7790`

Set `HACK_AUTH_BROKER_URL` to override and pin a custom broker endpoint.

The app registers URL scheme `hack` and handles `hack://auth/github/callback`
and `hack://auth/complete` deep links for browser return-to-app UX.

## Data source

The app shells out to `hack` for JSON data (projects + daemon status). It does not
talk to hackd directly yet.

## Ghostty VT (experimental)

The logs/shell views can stream PTY output through Ghostty's VT core and render
a snapshot of the terminal grid.

### Architecture

```
PTY bytes -> Ghostty VT (zig) -> formatter (HTML/plain) -> AppKit NSTextView
```

- VT parsing + grid state live in Zig (`apps/macos/Experiments/GhosttyVTBridge`).
- Swift feeds PTY bytes and asks for a formatted snapshot (HTML/plain).
- Rendering is AppKit-based (no Ghostty renderer yet).

### Docs

- `apps/macos/docs/ghostty-vt.md` — VT sequences, cursor behavior, colors, and renderer
  integration notes.

### Setup

```bash
bun run macos:ghostty:setup
```

This script:

- clones the Ghostty repo into `apps/macos/vendor/ghostty`
- builds the VT bridge via Zig
- installs `libhack_ghostty_vt.dylib` into:
  `~/Library/Application Support/Hack/ghostty/lib`
- ad-hoc signs the dylib for local loading

Zig version is validated against Ghostty's `minimum_zig_version` (currently
0.15.2.x). If you use mise: `mise install zig@0.15.2`.

You can override the library path with `HACK_GHOSTTY_VT_LIB`.

### Current limitations

- Snapshot rendering only (HTML/plain output). No GPU renderer yet.
- Cursor is represented by the NSTextView selection/caret, not Ghostty.
- Styling depends on Ghostty's formatter output + our base styles.
- External protocols (OSC 8 hyperlinks, OSC 21 Kitty colors) are only preserved
  insofar as Ghostty's formatter outputs them.

### Using the Ghostty renderer (future)

To render directly with Ghostty's renderer, we would need to:

- expose renderer APIs from Ghostty via the Zig bridge
- provide a Metal-backed surface (likely MTKView)
- feed Ghostty grid updates into the renderer each frame

That work is not wired up yet.

## Project ownership (what to edit)

- `project.yml`: target structure + dependencies. Regenerate Xcode project from this.
- `Config/Base.xcconfig`: versions, bundle id, product name, deployment target.
- `App/Info.plist`: Info.plist keys only (kept in repo as source of truth).
- Generated `.xcodeproj`: never edit manually.
