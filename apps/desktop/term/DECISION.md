# Terminal surface: decision and spike (HACK-2252)

Status: spike, unsupported preview. Researched and written 2026-11-15.

## Decision

Use **libghostty-vt 1.0.1** for terminal emulation, through the
`ghostty-vt` / `ghostty-vt-sys` crates (`=0.9.0+ghostty-vt.1.0.1`), and
**draw the cells ourselves with GPUI**. Keep the emulator behind this
crate's plain `Frame` model, so the renderer and the Logs/Exec views do not
depend on libghostty types.

We do not host Ghostty's own renderer in a child surface.

## What was checked (primary sources)

| Claim in the brief | Finding | Source |
|---|---|---|
| libghostty-vt 1.0 released Nov 6 2026 | Confirmed: "The 1.0 release means both the library itself and the C ABI are now stable." | mitchellh.com/writing/libghostty-1-0 |
| Stable C ABI | Confirmed: semver, opaque handles, int-pinned enums, libabigail checks in CI, versioned ELF symbols | same |
| MIT | Confirmed: MIT, "no copyleft code in the dependency tree" | same; `LICENSE` in the release tarball |
| Current 1.0.1 | Confirmed: "The latest version of libghostty-vt is 1.0.1." | lib.ghostty.org/vt |
| Emulation core, not a renderer | Confirmed: it provides terminal state, a render-state API (dirty rows, cells, colours, cursor), formatter, key/mouse encoders, selection, search. It does not draw | lib.ghostty.org/vt; the crate's `render` module |
| Zig needed | Confirmed for source builds: `build.zig.zon` has `.minimum_zig_version = "0.17.0"`; `ghostty-vt-sys` requires Zig 0.17.x. Official prebuilt libraries exist only for Apple (XCFramework), Windows (GNU zip) and WASM, **not Linux** | release tarball; `ghostty-vt-sys` README and build script |
| Release integrity | `release.files.ghostty.org/libghostty-vt/1.0.1/SHA256SUMS` matches `ghostty-vt-sys`'s `GHOSTTY.lock` for the source tarball, deps tarball and XCFramework. A minisign signature is also published (not verified here) | release server |

Third-party code linked into libghostty-vt 1.0.1, from the release's
`deps/libghostty-vt-third-party.json`: highway 1.2.0 (Apache-2.0 OR
BSD-3-Clause), simdutf 9.0.0 (Apache-2.0 OR MIT), translate_c 2.0.0 (MIT),
uucode 0.2.0 (MIT AND Unicode-3.0), wuffs 0.4.0-alpha.10 (Apache-2.0 OR
MIT). Build-only: aro (MIT AND Unicode-3.0).

## Options compared

(a) **Host Ghostty's renderer** in a child surface: `gpui-libghostty`
(github.com/behzade/gpui-libghostty, crate 0.4.1-rc.1, MIT, alpha).
(b) **libghostty-vt + GPUI-drawn cells**: `gpui-ghostty`
(github.com/Xuanwo/gpui-ghostty, Apache-2.0), `chda` (github.com/magicsih/chda,
MIT), `janjibar` (github.com/mrprofessor/janjibar, Apache-2.0, its `term`
crate), and the `ghostty-vt` crates from `gpui-cn` (Apache-2.0), which this
spike uses.
(c) Control: **alacritty_terminal** 0.26.0 (Apache-2.0, pure Rust; Zed's
terminal uses it) with GPUI-drawn cells.

| | (a) Ghostty renderer in a child surface | (b) libghostty-vt + GPUI cells (chosen) | (c) alacritty_terminal + GPUI cells |
|---|---|---|---|
| Text quality | Ghostty's own font stack and shaping; best-in-class, but a second font system beside GPUI's | GPUI's text system (CoreText / cosmic-text), the same as the rest of the app; per-cell grid with forced advances. Ligatures off by design | Same as (b) |
| Scrolling, selection | Ghostty's, complete | libghostty scrollback, viewport, selection snapshots, word/line selection, gesture state machine; the view wires drag-select, select-all, wheel/keys | Alacritty's grid and selection; comparable |
| Resize / reflow | Ghostty's | libghostty reflows soft-wrapped lines (tested) | Alacritty reflows |
| Copy | Ghostty clipboard via an adapter (plain text only) | `format_selection` (plain, VT or HTML), unwrap and trim | Selection to string |
| Links | Ghostty's link handling | OSC 8 URIs per cell (tested); plain-URL detection not yet written | Regex URL hints exist in Alacritty, not in the crate |
| Search | Ghostty's search UI | libghostty incremental search over scrollback (byte-exact, ASCII case-insensitive), match snapshots and scroll-to-match (tested) | Regex search in the crate |
| Theme following | `update_theme` API | Default fg/bg/cursor and 16-colour palette set from the GPUI theme each render; OSC overrides still work (tested) | Same approach |
| GPU / memory | A second renderer and GPU context per terminal (Metal; OpenGL 4.3 on Linux) | One GPUI scene; libghostty's page-based scrollback with a line or byte cap | One GPUI scene; Alacritty grid |
| macOS | Metal layer; supported by the project | libghostty prebuilt XCFramework (no Zig); GPUI Metal | Pure Rust |
| Linux Wayland | Wayland subsurface, EGL, libc++ 22 | GPUI (Vulkan) | GPUI |
| Linux X11 | **Not supported** ("Supports macOS and Linux with Wayland") | GPUI | GPUI |
| Composition in a GPUI layout | A native child surface: clipping inside scroll containers, z-order of GPUI overlays (search bar, menus, toasts) above it, and focus hand-off all cross a toolkit boundary. On Wayland a subsurface sits above or below the whole parent surface, not between GPUI layers (architectural inference, not tested here) | Plain GPUI element: clips, stacks, focuses and overlays like any other (the spike draws the search bar over the grid) | Same as (b) |
| Build | Zig 0.17, full Ghostty source **plus local patches** to Ghostty's app runtime and renderers (`patches/ghostty/*.patch`); not the stable C ABI | Zig 0.17.x on Linux from a pinned, sha256-checked source + deps tarball (offline capable); prebuilt checksummed static lib on macOS; stable C ABI | Cargo only, no C or Zig |
| GPUI coupling | `bind_gpui!` macro; checked against a Zed revision and gpui-pre 0.3.4 | None in the binding; our renderer targets gpui-kit 0.9.1 directly | None |
| Maturity / bus factor | Alpha, about 2 contributors, 10 stars | libghostty: Ghostty org, used by JetBrains IDEs, 1.0 with ABI promise. The Rust crates: one maintainer (gpui-cn, 1 active contributor); upstream of them, `libghostty-rs` (Uzaaft, MIT OR Apache-2.0, ~400 stars) still pins a pre-1.0 commit | Alacritty project, mature, widely used (Zed) |
| Licence | MIT | MIT (lib), Apache-2.0 (crates) | Apache-2.0 |

Why (b): it is the only option that is both Ghostty-grade emulation with a
stable ABI and a normal GPUI element. "Feels native, smooth and crisp" in
this app mostly means the terminal behaves like the rest of the window:
same fonts, same theme, overlays and focus that just work, X11 too. Option
(a) gives Ghostty's pixels but makes every one of those a cross-toolkit
problem, ships patches against Ghostty's non-stable app runtime, and has no
X11.

Why not (c): it removes the Zig step, which is real cost (below), but it
would trade away the owner's stated direction (libghostty) and libghostty's
richer state API (render-state dirty tracking, search, selection gestures,
kitty keyboard and graphics, shell-integration semantics). It stays the
fallback: because the view consumes `emulator::Frame`, swapping the
emulator is a contained change.

### What would change this recommendation

- The `ghostty-vt` crates going unmaintained. Mitigation: they are thin
  over a stable C ABI; we can vendor or fork them, or move to
  `libghostty-rs` once it pins 1.x.
- Zig-on-Linux builds proving unworkable in CI or packaging, with no
  upstream Linux prebuilt. Then (c) or a self-hosted prebuilt static lib.
- Measured GPUI text rendering of large, fast output (for example a
  full-screen TUI at 120 Hz) falling short where Ghostty's renderer does
  not. Not measured in this spike.
- (a) gaining X11, the stable ABI, and solved overlay/clipping composition.

## Build and CI

- libghostty-vt is built by `ghostty-vt-sys`'s build script:
  - **macOS**: links the official prebuilt static library from the
    1.0.1 XCFramework, checked against its pinned sha256. No Zig.
  - **Linux**: builds the official 1.0.1 source tarball with **Zig 0.17.x**,
    resolving Zig packages from the release's deps tarball
    (`zig build --system`), so Zig fetches nothing. Both tarballs are
    checked against pinned sha256s. A cold debug build of the crate,
    GPUI included, took about 4.5 minutes on the Linux host; the libghostty
    step was not timed separately.
  - Inputs come from `GHOSTTY_RELEASE_DIR` when set (fully offline), else
    from `https://release.files.ghostty.org/libghostty-vt/1.0.1/` with the
    same checksum check. A tampered tarball fails the build with a sha256
    mismatch; a missing Zig fails with a clear error (both checked).
- **Default chosen for this PR (flagged):** the libghostty emulator and the
  GPUI view are behind the crate feature **`ghostty`, off by default**, so
  the existing desktop CI (which has no Zig) stays green without a workflow
  change. The PTY, session teardown and stream code, and their tests, build
  and run by default on both hosts.
- **Recommended CI default (flagged, needs a workflow change this PR does
  not make):** build from the pinned, checksummed source rather than
  vendoring prebuilt binaries into the repo. Steps for the desktop jobs:
  1. Linux: download Zig **0.17.1**
     `https://ziglang.org/download/0.17.1/zig-x86_64-linux-0.17.1.tar.xz`,
     sha256 `3581863e3cbcfd0fce0efc682ce7e9e93da96668a977791d356a26d2a7e9b17a`
     (from ziglang.org's `index.json`), and export `ZIG`.
  2. Both: fetch `libghostty-vt-1.0.1.tar.gz`
     (`333dfce97641ef9b536bb9e08907ad86abaaada50e8f7417b70d9284adef37aa`),
     `libghostty-vt-1.0.1-deps.tar.gz`
     (`91a4e10960a52bf5bf4b15aa2a2cddaff8a89d6cd903d3055bda4fd17de3356d`) and,
     for macOS, `ghostty-vt-1.0.1.xcframework.zip`
     (`c0f9631277f726154c8f521954d17cdc41aac4626fc0df8cf925a19ee58e829b`)
     into a directory, verify with `sha256sum -c`/`shasum -a 256 -c`, cache
     it keyed on those hashes, and export `GHOSTTY_RELEASE_DIR`.
  3. Run clippy and `bash scripts/test.sh` again with
     `--features hack-desktop-term/ghostty` (and clippy with
     `hack-desktop-term/screenshots`).
  Cargo then builds with no network. Turning the feature on by default (or
  making the app depend on it) should wait for that change.
- Locally: `mise install zig@0.17.1` (the repo root pins Zig 0.15.2 for
  other tooling, so set `ZIG` explicitly), or set `GHOSTTY_RELEASE_DIR` to
  pre-fetched files for an offline build.

## The spike

```sh
cd apps/desktop
export ZIG="$(mise where zig@0.17.1)/bin/zig"   # Linux only
cargo run -p hack-desktop-term --features ghostty --example term_spike
cargo run -p hack-desktop-term --features ghostty --example term_spike -- --file some.log
cargo run -p hack-desktop-term --features ghostty --example term_spike -- --cmd /bin/sh -c 'ls --color=always /'
cargo run -p hack-desktop-term --features screenshots --example term_spike -- --theme dark --screenshot /tmp/term.png
bash scripts/test.sh --features hack-desktop-term/ghostty
```

Left pane: a read-only stream (a generated 10,000-line ANSI log by default,
or `--file` / `--cmd`), 10,000-line scrollback cap, follow on/off (`f`,
End, scrolling up pauses), PageUp/PageDown/Home, search (Ctrl-Shift-F or
Cmd-F; Enter older, Shift-Enter newer, Esc). Right pane: your `$SHELL` on an
app-owned PTY, resized with the pane, drag selection, triple-click select
all, Ctrl-Shift-C / Cmd-C copy, Ctrl-Shift-V / Cmd-V paste (bracketed when
the program asks), Ctrl/Cmd-click opens OSC 8 links. Closing the window
quits and ends the shell's session.

Renders (offscreen, 2560×1520):
[dark](screenshots/spike-dark.png), [light](screenshots/spike-light.png).

### PTY ownership

`pty::Pty` starts the child with `setsid()` and `TIOCSCTTY` (its own
session and process group, the PTY as controlling terminal), marks every
inherited descriptor above stderr close-on-exec in the child, and owns the
master. Drop sends SIGHUP and SIGCONT to the process group **and to every
live process in the session** (an interactive shell puts each job in its
own group), closes the master, then a reaper thread escalates to SIGKILL
after 300 ms and reaps. Drop never blocks the UI thread;
`terminate_blocking` is used on app quit. A descendant that calls
`setsid()` itself is out of reach without cgroups/job objects.
Session members come from `/proc` on Linux and `proc_listallpids` +
`getsid` on macOS (type-checked for `aarch64-apple-darwin`, not run).

`stream::ByteStream` runs a process in its own process group with stdin
closed and stdout+stderr on one pipe; Drop sends SIGTERM, then SIGKILL.

### Tests (hermetic)

`tests/process_cleanup.rs` (default build): a shell with a same-group
sleeper, a SIGHUP/SIGTERM-ignoring sleeper and a `set -m` job in another
group; all must be gone after Drop within a 60 s scheduling deadline, after
proving they were alive and that the job really is in another group.
Removing the session scan makes it fail (checked). Also: blocking
terminate, resize reaching the child (`stty size`), session leadership with
a controlling tty, process-stream group teardown, 10,000-line file stream.

`tests/emulator.rs` (feature `ghostty`): ANSI 16/256/truecolour and
attributes, LNM for bare-LF logs, bounded scrollback with 30,000 lines,
follow off keeps the viewport still under 10,000+ lines, search across
scrollback with newest-first stepping and scroll-to-match, selection and
plain-text copy, reflow on resize, wide characters, OSC 8 links, query
replies, key encoding (including application cursor mode), paste hardening,
theme palette.

## Uses

**Logs tab.** Replace the text panel with a read-only `TerminalView` fed by
core's existing log stream reader; core's ndjson parser stays and decides
what bytes to render (for structured entries, the app formats one line per
entry with its own ANSI colours; raw lines pass through). LNM is on so bare
`\n` lines render correctly. Follow, the scrollback cap and the search hook
(`TerminalView::search`, `search_step`) back the tab's Follow toggle and
Find field. The view is fed through `Emulator::feed`; core keeps owning the
process.

**Exec on a running service.** An action on a running service opens a
`TerminalView::new_pty` running `hack exec <service> -- <shell>` on the
app-owned PTY, in the project root, as the user. Closing the tab or window,
or quitting the app, ends that PTY's session (and with it the `hack exec`
client). Which shell to request is a product choice; default to `sh`.

**Security rules.**

- The app never types secrets into a terminal: input is only what the user
  types or pastes. Paste is sanitised (no control characters except tab, CR and
  LF) so it cannot break out of bracketed paste.
- The app never logs terminal contents: no stream or PTY bytes go to logs,
  telemetry or crash reports. Copy goes to the clipboard only on user action.
- The app never passes values in argv: the only argv is `hack exec`, the
  service name, `--`, and the shell. Environment values are never
  constructed or logged by the view.
- What a service prints is shown as printed; the app does not redact,
  rewrite or interpret it beyond terminal emulation. Program-initiated
  clipboard writes (OSC 52) and notifications are not acted on by this
  view.

## Licences of new dependencies

Pinned in `Cargo.toml`: `ghostty-vt =0.9.0` (lock: `0.9.0+ghostty-vt.1.0.1`),
`libc =0.2.191`, `image =0.25.10` (screenshots feature only). Every package
this branch adds to `Cargo.lock`:

| Package | Version | Licence | Role |
|---|---|---|---|
| ghostty-vt | 0.9.0+ghostty-vt.1.0.1 | Apache-2.0 (bundled terminfo and shell-integration files MIT) | linked |
| ghostty-vt-sys | 0.9.0+ghostty-vt.1.0.1 | Apache-2.0; links libghostty-vt (MIT, third-party list above) | linked |
| int-enum | 1.3.0 | MIT OR Apache-2.0 | proc-macro |
| proc-macro2-diagnostics | 0.11.0 | MIT/Apache-2.0 | proc-macro |
| ureq | 3.5.2 | MIT OR Apache-2.0 | build script (download) |
| ureq-proto | 0.7.1 | MIT OR Apache-2.0 | build script |
| utf8-zero | 0.8.1 | MIT OR Apache-2.0 | build script |
| webpki-roots | 1.0.12 | CDLA-Permissive-2.0 | build script (TLS roots, Linux host) |
| webpki-root-certs | 1.0.12 | CDLA-Permissive-2.0 | build script |
| der | 0.8.3 | Apache-2.0 OR MIT | build script |
| pem-rfc7468 | 1.0.0 | Apache-2.0 OR MIT | build script |
| base64ct | 1.8.3 | Apache-2.0 OR MIT | build script |
| tar | 0.4.46 | MIT OR Apache-2.0 | build script |
| filetime | 0.2.29 | MIT/Apache-2.0 | build script |
| xattr | 1.7.0 | MIT OR Apache-2.0 | build script |
| zip | 9.6.0 | MIT | build script |
| typed-path | 0.13.0 | MIT OR Apache-2.0 | build script |
| constant_time_eq | 0.6.1 | CC0-1.0 OR MIT-0 OR Apache-2.0 | build script |
| nix | 0.32.0 | MIT | build script (zip) |
| native-tls | 0.2.18 | MIT OR Apache-2.0 | build script on macOS/Windows hosts |
| openssl | 0.10.82 | Apache-2.0 | lockfile only (native-tls on other hosts; not built) |
| openssl-sys | 0.9.118 | MIT | lockfile only |
| openssl-macros | 0.1.1 | MIT/Apache-2.0 | lockfile only |
| foreign-types | 0.3.2 | MIT/Apache-2.0 | lockfile only |
| foreign-types-shared | 0.1.1 | MIT/Apache-2.0 | lockfile only |
| vcpkg | 0.2.15 | MIT/Apache-2.0 | lockfile only |

Already in the lockfile and reused: bitflags, dirs 6 (MIT OR Apache-2.0)
with `option-ext` (MPL-2.0, already present through gpui), flate2, sha2,
rustls/ring (build script TLS). There is no cargo-deny or licence config
for this workspace. A shipped app must carry Ghostty's MIT notice and the
third-party notices above.
