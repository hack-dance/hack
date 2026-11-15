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
  not. See "Performance" for the first numbers.
- (a) gaining X11, the stable ABI, and solved overlay/clipping composition.

## Why not (a), even though it matches Ghostty's pixels

Option (a) would give exactly Ghostty's rendering. It still loses for this
app, for five reasons:

1. **The stable ABI does not cover it.** The 1.0 stability promise is for
   libghostty-vt, the emulation core. Option (a) builds Ghostty's whole app
   runtime and its Metal and OpenGL renderers, which have no such promise.
2. **It patches Ghostty internals and is alpha.** `gpui-libghostty` carries
   its own patches to Ghostty's embedded runtime, font and renderer sources,
   says "expect bugs and instability", and has about two contributors. Any
   Ghostty update can break it.
3. **No X11, and more system requirements.** It supports macOS and Linux on
   Wayland only, and on Linux needs EGL, desktop OpenGL 4.3 and libc++ 22,
   which Ubuntu 24.04 does not ship by default.
4. **A native child surface fights the rest of the window.** The Logs tab
   needs a search bar over the terminal, menus and toasts above it,
   clipping inside a scrolling panel, and focus moving between it and other
   controls. With a separate native surface each of these crosses a toolkit
   boundary; on Wayland a subsurface sits wholly above or below the parent,
   not between GPUI layers. *This is reasoning from how such surfaces work.
   It was not tested here.*
5. **Ghostty's runtime would own the shell.** Its API starts the process
   itself. The guarantees in "PTY ownership" below (we hold the session,
   end every member on close, never leave a process or zombie, never block
   the UI) would move into code we do not control.

### What (b) still has to prove

- **Throughput and smoothness** with full-screen programs (`vim`, `top`)
  and log floods, in the real window. The numbers under "Performance"
  below are a first measurement of emulation and CPU-side paint cost on one
  Linux machine; they are not display latency and not a Mac.
- **macOS.** Nothing in this crate has been run on a Mac except what hosted
  CI runs of the default-feature tests show.
- **Polish we have to build ourselves**: cursor shapes and blink, IME,
  mouse reporting to programs, plain-URL detection, ligature policy,
  per-row caching keyed on libghostty's row ids, waking on output instead
  of the spike's timer.

### Optional: a spike of (a)

If the owner wants evidence rather than reasoning for point 4, a short
spike of `gpui-libghostty` on Linux (Wayland) and macOS would answer:

1. Does a GPUI overlay (search bar, menu, tooltip) draw above the terminal
   surface, on both platforms?
2. Is the surface clipped correctly inside a scrolling or resizing panel,
   and does it track the layout without lag or tearing during resize?
3. Does keyboard focus move correctly between the surface and GPUI
   controls, including IME?
4. Can it show a byte stream we feed it (logs), or only a process it
   spawns?
5. Who owns the child: can we get the session id and enforce our teardown,
   and what is left running when the surface is dropped or the app quits?
6. Does it build offline from pinned inputs with the system packages our
   CI has, and how does it behave on X11 (expected: not at all)?

A "yes" to 1 to 5 on both platforms, plus an X11 answer we can live with,
would reopen the decision.

## Build and CI

libghostty-vt is built by the `ghostty-vt-sys` build script:

- **macOS**: links the official prebuilt static library from the 1.0.1
  XCFramework. No Zig.
- **Linux**: builds the official 1.0.1 source tarball with **Zig 0.17.x**
  (we pin **0.17.1**), resolving Zig packages from the release's deps
  tarball (`zig build --system`), so Zig fetches nothing.

**The build never downloads.** Left alone, that build script fetches its
release archives when `GHOSTTY_RELEASE_DIR` is unset. Three things stop it:

1. `term/scripts/provision-ghostty.sh` is the one step that uses the
   network. It fetches the pinned inputs into a cache directory, verifies
   each against a sha256 committed in the script, and prints the
   environment to export (`GHOSTTY_RELEASE_DIR`, and `ZIG` on Linux).
   Re-running it verifies the cache; `--offline` only verifies.
2. `apps/desktop/.cargo/config.toml` sets the build script's download base
   (`GHOSTTY_RELEASE_URL`) to a URL with a scheme that cannot be fetched.
   Without provisioned inputs the dependency fails at once with "unknown
   scheme", before any network use. `GHOSTTY_RELEASE_DIR` takes precedence
   when set. This applies to cargo run from `apps/desktop` or below, which
   is how the scripts, CI and README run it.
3. `term/build.rs` fails with instructions when the `ghostty` feature is on
   and the inputs or `ZIG` are missing. (Cargo may run the dependency's
   script first; either way the build stops and names the script.)

The dependency's build script also verifies each archive's sha256 against
its own lock file, so a file changed after provisioning fails the build.

| Input | sha256 |
|---|---|
| `libghostty-vt-1.0.1.tar.gz` | `333dfce97641ef9b536bb9e08907ad86abaaada50e8f7417b70d9284adef37aa` |
| `libghostty-vt-1.0.1-deps.tar.gz` | `91a4e10960a52bf5bf4b15aa2a2cddaff8a89d6cd903d3055bda4fd17de3356d` |
| `ghostty-vt-1.0.1.xcframework.zip` (macOS) | `c0f9631277f726154c8f521954d17cdc41aac4626fc0df8cf925a19ee58e829b` |
| `zig-x86_64-linux-0.17.1.tar.xz` | `3581863e3cbcfd0fce0efc682ce7e9e93da96668a977791d356a26d2a7e9b17a` |
| `zig-aarch64-linux-0.17.1.tar.xz` | `a1546d5646eb184437918d6635ca6b762a0e889eac09cef720ee7a1ed3fe7795` |

Sources: `release.files.ghostty.org/libghostty-vt/1.0.1/SHA256SUMS` and
`ziglang.org/download/index.json`.

```sh
cd apps/desktop
eval "$(bash term/scripts/provision-ghostty.sh)"     # network, checksummed
cargo fetch --locked                                  # network, crates
bash term/scripts/no-network.sh bash term/scripts/check-ghostty.sh   # Linux: build, clippy, tests with no network
bash term/scripts/check-ghostty.sh                    # macOS: same checks (cargo --offline; no namespace)
```

**CI.** `.github/workflows/desktop.yml` has a job, "Desktop terminal
surface (Linux, libghostty-vt, offline build)": provision (cached, keyed on
the script), fetch crates, then build, clippy and tests of
`hack-desktop-term --features ghostty` inside a network namespace whose
only interface is a down loopback. There is no macOS job for the feature
yet; the Mac commands are in the PR.

**Defaults chosen (flagged for the owner):**

- The `ghostty` feature stays **off by default**. The app does not depend
  on it yet, and the two existing desktop jobs are unchanged.
- Inputs are **provisioned from upstream and checksummed**, not vendored
  into the repository (about 67 MB with Zig) and not prebuilt by us.
- `ZIG` must be set explicitly for a Linux build of the feature; a Zig that
  happens to be on `PATH` is not used as the pinned one. The repo root
  pins Zig 0.15.2 for other tooling.
- `apps/desktop/.cargo/config.toml` is a new workspace file outside this
  crate's directory; it is the only place the download base can be set for
  every cargo invocation in the workspace.

## The spike

```sh
cd apps/desktop
eval "$(bash term/scripts/provision-ghostty.sh)"
cargo run -p hack-desktop-term --features ghostty --example term_spike
cargo run -p hack-desktop-term --features ghostty --example term_spike -- --file some.log
cargo run -p hack-desktop-term --features ghostty --example term_spike -- --cmd /bin/sh -c 'ls --color=always /'
cargo run -p hack-desktop-term --features screenshots --example term_spike -- --theme dark --screenshot /tmp/term.png
cargo run --release -p hack-desktop-term --features screenshots --example term_bench
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
session and process group, the PTY as controlling terminal) and marks
every inherited descriptor above stderr close-on-exec in the child.

**Teardown** (`session::OwnedSession`). The session leader is held
**unreaped** until the last signal has been sent. While it is unreaped its
pid cannot be reused, so neither can the group id or session id: `killpg`
on the leader's group reaches our group or nothing, and a process whose
session id is the leader is ours. Exit is observed with `waitid(WNOWAIT)`,
which does not reap. Members in other process groups (an interactive
shell's jobs) are found by scanning the process table and re-verified at
the moment of signalling:

- Linux: `pidfd_open`, re-read `/proc/<pid>/stat` and require the session
  id to still match, then `pidfd_send_signal`. The pidfd names one process
  for life, so the signal reaches the verified process or nobody.
- macOS: no pidfd. `getsid` and the process status are re-checked
  immediately before `kill`. A residual race remains (exit, reap and pid
  reuse between those two calls); it is documented in `session.rs`.

Drop sends SIGHUP and SIGCONT, then a reaper thread sends SIGKILL after
300 ms, re-sends it every 50 ms to catch late forks, and reaps the leader
last. A descendant that calls `setsid()` itself is out of reach without
cgroups or job objects.

**No blocking on the UI thread.**

- Output: a worker reads the terminal into a queue bounded at 1 MiB of
  pending bytes. When the consumer stalls the worker stops reading and the
  child blocks on its own write (backpressure). Closing cancels the worker.
- Input: `Pty::write` only queues (bound 1 MiB). A second worker delivers
  with non-blocking writes and handles partial writes. Input that does not
  fit is refused **whole** (a truncated paste could run half a command)
  and the view shows a notice.
- Quit: the view ends the session on GPUI's background executor with a
  100 ms SIGKILL grace, inside GPUI's 200 ms shutdown window.

**End of output is not child exit.** The terminal core keeps pumping until
the terminal reports end of file. If the child has exited but something
still holds the terminal (a background job), it waits 500 ms without
output, at most 5 s, then closes.

**Thread-spawn failure.** If a worker cannot be started the child is
killed and reaped before the error returns. If the reaper cannot be
started, Drop kills the session and reaps on the calling thread. A session
dropped on any other path is killed and reaped by its own Drop.

`stream::ByteStream` runs a process in its own session (no controlling
terminal) with stdin closed and stdout+stderr on one pipe, through the same
bounded queue and the same teardown (SIGTERM first).

### Tests (hermetic)

Children run `/bin/sh` and POSIX tools with an emptied environment, a fixed
`PATH` and a private temporary `HOME`. Tests signal only pids they
recorded; nothing matches processes by name. Deadlines are 60 s scheduling
bounds.

Default build (both CI hosts run these):

- Session teardown: a same-group sleeper, a SIGHUP/SIGTERM-ignoring one and
  a `set -m` job in another group are all gone after Drop, and the leader
  is reaped.
- Identity: a scan that returns a pid from another session and a pid that
  does not exist; both are skipped, the other session is untouched.
- Anchor: after the shell exits, its pid still exists and its job is still
  found by session id; after teardown both are gone.
- Escalation: SIGKILL is reported only for a session that ignores SIGHUP,
  and only after the grace period.
- Writes: 16 MiB offered to a child in raw mode that never reads returns
  at once, the queue stays within its bound, the excess is reported as
  dropped, and teardown cancels the parked writer.
- Queues: a fast producer with a stalled consumer stops at the bound
  (unit test, and end to end with `yes` through a stream).
- Final output: a tiny and a 300,000-line output followed by exit arrive
  complete, with end of file after the last byte.
- Thread-spawn failure, injected for the reader, the writer and the reaper,
  for PTY and stream: no running child and no zombie.
- Also: resize reaching the child, session leadership with a controlling
  tty, the child's environment, a 10,000-line file stream.

The identity, anchor, queue-bound, final-output-in-grid and
thread-spawn-failure tests were each checked to fail when the fix they
cover is removed (mutations run by hand, sources restored). The
spawn-failure tests only fail when both cleanup layers are removed, because
either one alone still kills and reaps the child.

Feature `ghostty`: `tests/emulator.rs` (colours and attributes, LNM,
bounded scrollback at 80 and 200 columns, follow, search, selection and
copy, reflow, wide characters, OSC 8, query replies, key encoding, paste hardening, theme)
and `tests/terminal.rs` (a real child's final output is in the grid and
scrollback; a descendant holding the terminal does not keep it open; a
stream's last line).

### Performance

A first measurement, from `term_bench` (three runs, release build without
LTO, Linux, a 10-core desktop Intel CPU with a discrete GPU). It is a
sanity check on one machine, not a qualification.

| What | Result |
|---|---|
| Emulation, coloured log flood (64 MiB) | 217 to 223 MiB/s |
| Emulation, full-screen 200×60 repaints | 230 to 253 MiB/s, about 10,000 repaints/s |
| Building a `Frame` for 200×60, every row changed | 0.84 to 0.89 ms mean, 1.4 ms worst |
| One offscreen GPUI frame of a 208×60 grid, every row changed | 3.0 ms mean, 5.1 ms worst |
| The same with nothing changed | 2.9 to 3.0 ms mean, 4.7 ms worst |

Reading: emulation is far faster than any program prints. Frame building
plus paint is about 4 ms of CPU for a full-screen change on this machine,
inside one 120 Hz frame (8.3 ms).

What this does **not** show: GPU time, presentation latency, key-to-screen
latency, a laptop, or anything on macOS. "Paint" is the CPU side of a GPUI
frame (layout, text shaping, scene building, submission) with the offscreen
renderer.

Known costs still on the table, none optimised yet:

- An unchanged frame costs as much as a changed one. libghostty reports
  dirty rows and stable row ids; the view rebuilds and repaints every row.
- `Emulator::frame` allocates a `String` per cell.
- The view polls for output on a timer (8 ms when busy, 33 ms idle), which
  adds up to one tick of latency. It should wake on output.

One thing the benchmark caught: libghostty's default 10 MB scrollback byte
limit applies before the line limit, and on a 200-column grid kept only
about 5,500 lines. The emulator now sets its own byte ceiling (256 MiB) so
the 10,000-line bound is the one that applies; a test covers it.

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
client). Processes inside the container are ended by `hack exec` and the
engine, not by this crate. Which shell to request is a product choice; default to `sh`.

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
