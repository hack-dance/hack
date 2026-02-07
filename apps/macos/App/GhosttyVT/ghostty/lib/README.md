This directory is populated during builds with `libhack_ghostty_vt.dylib`.

- Release CI builds a universal dylib and stages it here before `xcodebuild archive`.
- The app copies this folder into `Hack Desktop.app/Contents/Resources/ghostty/` during the build.

If you're building locally and want the embedded terminal to work, run:

`bun run macos:ghostty:bundle`

