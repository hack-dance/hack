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
  CI runs of the default-feature tests show. On macOS a job in another
  process group that ignores SIGHUP survives a closed tab and is reported,
  not ended (see "PTY ownership").
- **Polish we have to build ourselves**: cursor blink, IME, mouse
  reporting to programs, plain-URL detection, ligature policy, per-row
  caching keyed on libghostty's row ids, waking on output instead of the
  spike's timer. Done so far: cursor shapes, and prompt glyphs (see
  "Glyphs").

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
   environment to export (`GHOSTTY_RELEASE_DIR`, `HACK_TERM_SYMBOLS_FONT`,
   and `ZIG` on Linux).
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
| `NerdFontsSymbolsOnly.tar.xz` (Nerd Fonts v3.5.1) | `01172f37db8543edb102e5cb5c64101c9f4686630804d49b419aa07b23a69996` |
| `SymbolsNerdFontMono-Regular.ttf`, from that archive | `fe471e538392f51910faab985fa8e192a39dd3426125edd15b71b3680df0e749` |

Sources: `release.files.ghostty.org/libghostty-vt/1.0.1/SHA256SUMS`,
`ziglang.org/download/index.json`, and the Nerd Fonts release's
`SHA-256.txt`. The font file's checksum is pinned in the provisioning
script and in `term/build.rs`, which refuses to embed any other file.

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

## The terminal panel

Owner decision (Nov 15 2026): the terminal is a per-project bottom panel
with tabs. The panel's design is specified in `DESIGN-V1.md`; this crate
supplies the component, the session kinds, the tab identity and the
actions.

```sh
cd apps/desktop
eval "$(bash term/scripts/provision-ghostty.sh)"
cargo run -p hack-desktop-term --features ghostty --example term_spike
cargo run -p hack-desktop-term --features ghostty --example term_spike -- --file some.log
# Real CLI sessions, in a real Hack project with a running service (manual):
cargo run -p hack-desktop-term --features ghostty --example term_spike -- \
    --project /path/to/project --hack "$(command -v hack)" --service api --env staging --scope api
cargo run -p hack-desktop-term --features screenshots --example term_spike -- --screenshots /tmp/shots
cargo run --release -p hack-desktop-term --features screenshots --example term_bench
bash scripts/test.sh --features hack-desktop-term/screenshots
```

The example opens four tabs in one panel: `logs`, a container shell, the
host login shell, and a host shell with an env overlay. Without `--hack`
and `--service` the two CLI-backed tabs run a stand-in script that checks
the argv the app would pass to `hack` and then starts a plain shell.

### Sessions

The app owns the PTY and runs the CLI in it. It never builds an environment
and never sees a value. The only variables it sets are the terminal's own
identity (`TERM=xterm-256color`, `COLORTERM=truecolor`,
`TERM_PROGRAM=hack`); everything else is inherited, or injected by the CLI
inside the PTY. The only strings it puts in argv are the CLI's subcommands,
validated names and a shell name. (`launch.rs`.)

| Tab | What runs, in the project root |
|---|---|
| Logs | Nothing here: a read-only stream fed by the app's log reader |
| Shell in a service | `hack exec <service> -- bash`, then `hack exec <service> -- sh` if the image has no bash |
| Host shell | The user's login shell (`$SHELL`, else the passwd entry, else `/bin/sh`), started as a login shell by the `argv[0]` convention (`-zsh`). On a PTY that makes it interactive, so profile and rc files load as in the user's own terminal |
| Host shell with env | `hack host shell --env <overlay> --scope <scope>`. The CLI resolves and injects the values and starts `$SHELL -l` |

Details that were checked against the CLI source on `next` and, for the
last two rows, by running it:

- **`hack exec`** takes `<service>` then the command after an optional
  `--`, with `--path`, `--project`, `--env`, `--branch`, `--workdir` and
  `--profile`. The compose backend runs `docker compose exec` and allocates
  a TTY exactly when its own stdin and stdout are terminals, which they are
  on our PTY. The native backend has its own interactive exec path and
  refuses `--env` and `--profile`; we pass neither. *Not run against a real
  container here (no Docker in this work).*
- **bash, then sh.** There is no flag for "first shell that exists", and
  probing first would be a second exec. The session starts `bash`; if that
  attempt ends with exit status 126 or 127 within 10 s and before the user
  has typed anything, the terminal is reset and `sh` is started in the same
  tab, and the tab's label changes from `api · bash` to `api · sh`. An exit
  with those codes after the user has typed is their session ending and is
  not retried. *The exit status for a missing program comes from the
  container engine; see CLI request 3.*
- **`hack host shell`** exists, with `--path`, `--project`, `--env`,
  `--scope` and `--target`. It runs `[$SHELL or /bin/sh, "-l"]` in the
  project root with the process environment plus the injected values and
  inherited stdio. *Run for real* on a pseudo-terminal in a throwaway
  project with a temporary home: the profile loaded, the profile's prompt
  showed, the shell was interactive, global and service-scoped overlay
  values were present, `TERM_PROGRAM` and `COLORTERM` came through, and the
  working directory was the project root. So it can start the user's
  interactive login shell with their rc files, as long as `SHELL` is set.
- **`hack env list --json`** exists. *Run for real* on the same project: it
  returns `env_selection` (`requested`, `default`, `effective`,
  `overlay_path`, `overlay_exists`), `scopes` (for example `["api",
  "global"]`), `selected_scope`, `files`, and `vars` with names and
  metadata and no `value` field unless `--show-values` is given. `is_default`
  for the badge is `overlay == env_selection.default`. It does **not** list
  the overlays that exist (request 1).
- **`TERM`.** `xterm-256color` everywhere by default: containers rarely
  have other terminfo entries, and `xterm-ghostty` breaks ssh to hosts that
  lack it. `TermChoice::GhosttyIfPresent` switches host shells to
  `xterm-ghostty` only when its terminfo entry is installed (first-letter
  and macOS hex layouts are both checked). This default is flagged.
- **Names are validated** before they reach argv: letters, digits, `_`, `-`
  and `.`, not starting with `-` or `.`. A service called `--env` cannot
  become an option.

### CLI requests

These are the smallest CLI changes that would close gaps. The app does not
work around them.

1. **`hack env list --json`: add `overlays`, the names of the overlays that
   exist.** Today the payload carries the selection and the scopes but only
   the files of the selected overlay, so the app cannot offer a list of
   overlays to open a shell with. The library already has
   `listProjectEnvOverlayNames`. Names only.
2. **`hack host shell`: when `SHELL` is unset or empty, use the user's
   passwd shell before falling back to `/bin/sh`.** Run for real with
   `SHELL` unset, it started `/bin/sh`. A GUI-launched app usually has
   `SHELL`, but not always. Until this changes, the tab is labelled by the
   same rule the CLI uses.
3. **`hack exec`: document, and test, that a command that cannot be started
   in the container exits 127 (or 126) on both backends.** The bash-to-sh
   fallback depends on it, and it is currently the engine's behaviour, not
   the CLI's contract.

Not a request, but worth knowing: `env_selection.default` is `null` for a
project with no default overlay. Any named overlay is then "not the
default" and its badge has the warning tone.

### Why this and not attaching to tmux

- **One mechanism.** The same PTY, emulator and teardown serve logs,
  container shells and host shells. Attaching to tmux would add a second
  terminal emulator between the program and ours, with its own scrollback,
  key table, copy mode and resize rules to reconcile.
- **It works without tmux.** tmux is not installed on every machine, and
  never inside most service containers.
- **The CLI stays the only thing that touches env values.** With `hack host
  shell` the values go from the CLI straight into the child's environment
  inside the PTY. A tmux route would need the app or a wrapper to place
  values into a tmux server's environment or command line, where they
  outlive the tab and are visible to every other pane and client of that
  server.
- **Ownership.** We end what we start: the session is ours, and closing a
  tab ends it. A tmux server is a long-lived process the user owns; ending
  "our" part of it safely is a harder and different problem.

Nothing stops a user from running `tmux` inside a host shell tab.

### Tab identity and badge

`SessionKind` is what a tab is, with names only:

| Kind | Label | Badge |
|---|---|---|
| `Logs` | `logs` | none |
| `ContainerShell { service, shell }` | `api · sh` | none |
| `HostShell { shell }` | `host · zsh` | none |
| `HostShellWithEnv { shell, overlay, scope, is_default }` | `host · zsh` | `env staging · api`, warning tone when the overlay is not the default one |

`TerminalView::kind()` and `TerminalPanel::kinds()` expose it; `label()`
and `badge()` produce the strings and the tone. A container shell's kind
changes if `bash` was missing.

### Look: the user's Ghostty config

`ghostty_config::GhosttyLook::load` reads the user's Ghostty config so the
terminal matches their own: `font-family` (the first is the font, later
ones are fallbacks), `font-size`, `background`, `foreground`, `palette`,
`cursor-style`, `window-padding-x` and `window-padding-y`. Whatever is not
set falls back to the app's tokens.

The grid is only ever drawn in a monospaced font. The view takes the first
family that is installed and has one advance for ASCII: the config's
families in order, then the theme's monospace family, then the platform's
terminal families (Menlo and the like on macOS, DejaVu Sans Mono and the
like elsewhere). When the configured family is missing or proportional,
the panel shows a non-fatal note naming it ("font \"X\" is not installed;
using Menlo"), and the session runs on. Before this, a missing family fell
back to the system UI font on macOS and drew letters with uneven gaps.

Rules follow Ghostty's documentation:

- Files, in load order: `$XDG_CONFIG_HOME/ghostty/config.ghostty`, then
  `config` (`~/.config` when the variable is unset); on macOS also
  `~/Library/Application Support/com.mitchellh.ghostty/` with the same two
  names, after the XDG ones. Later values win.
- `config-file` includes are processed at the end of the file that names
  them, relative to it; `?` marks one optional; cycles end.
- `theme = name`, an absolute path, or `light:A,dark:B` picked by the app's
  appearance. Names are looked up in the user's `themes` directory, then in
  Ghostty's resources. The user's own settings override the theme's. A
  theme cannot set `theme` or `config-file`, and a name containing a path
  separator is refused.

An empty value resets a key; `palette =` drops every palette entry set so
far, the theme's included, and entries after it apply.

Only those keys are parsed; every other line is skipped without being
kept, nothing from the file is logged, and a missing, oversized or
malformed file is treated as empty.

Reading is bounded end to end. A file is identified by its canonical path
before it is opened, and is never read twice, however often it is included.
It is opened once (without blocking on a FIFO or device, and only if the
opened handle is a regular file) and read through a 1 MiB limit on that
handle, so a file that grows or is replaced after any earlier look cannot
exceed it. One load reads at most 4 MiB and 64 files in total across the
config files, every include and the theme; includes nest at most 8 deep. Sizes are points as Ghostty counts
them: a logical pixel on macOS, 96/72 of one elsewhere. Colours accept hex;
X11 colour names are accepted when libghostty is linked in.

Not mapped yet: `cursor-color`, `selection-*`, `font-feature`, bold and
italic font overrides, `adjust-cell-height`, `background-opacity`.

### Keyboard actions

`actions.rs` defines the actions in the `hack_term` namespace and the
components handle them. **The crate binds no keys.** The only keys it
interprets itself are the ones it forwards to the program on the PTY
(encoded by libghostty for the program's modes) and text typed into the
find field while it is open. A key the app has bound to an action never
reaches the terminal.

| Action | Handled by | Effect |
|---|---|---|
| `TogglePanel` | panel | Show or hide; hidden tabs keep running |
| `NewTab` | panel | Emits `PanelEvent::NewTabRequested`; the app chooses the kind and calls `add_tab` |
| `CloseTab` | panel | Closes the active tab and ends its session |
| `NextTab` / `PrevTab` | panel | Move through the tabs, wrapping |
| `ToggleMaximize` | panel | Sets `is_maximized()`; the app's layout gives it the room |
| `Copy` / `Paste` | view | Selection to the clipboard; clipboard into the program (bracketed when it asked), or into the find query while find is open (one line, never sent to the program) |
| `Find` | view (and panel, for the active tab) | Opens find |
| `FindOlder` / `FindNewer` / `CloseFind` | view | Step through matches; close find |
| `ScrollPageUp` / `ScrollPageDown` / `ScrollToTop` / `ScrollToBottom` / `ToggleFollow` | view | Scrollback and follow |

Each action is also a public method, so the app can call it from its own
handlers for keys that must work when focus is elsewhere (toggling a hidden
panel). Key contexts for binding predicates: `Terminal` on every terminal,
`TerminalLogs` on a read-only stream, `TerminalFind` while the find field
is open, `TerminalPanel` on the panel.

The bindings live in the app's keymap and in `examples/term_spike.rs`, from
the app's design:

| Action | macOS | Linux |
|---|---|---|
| Toggle panel | ⌘J | Ctrl-Shift-J |
| New tab | ⌘T | Ctrl-Shift-T |
| Close tab | ⌘W | Ctrl-Shift-W |
| Next / previous tab | ⌘⇧] / ⌘⇧[ | Ctrl-Shift-PageDown / Ctrl-Shift-PageUp |
| Maximize | ⌘⇧↩ | Ctrl-Shift-Enter |
| Find | ⌘F | Ctrl-Shift-F |
| Copy / paste | ⌘C / ⌘V | Ctrl-Shift-C / Ctrl-Shift-V |

The example also binds keys the design does not list yet, as its own
choice: Enter, Shift-Enter and Escape in the find field (`FindOlder`,
`FindNewer`, `CloseFind`), Shift-PageUp and Shift-PageDown for scrollback,
and PageUp, PageDown, Home, End and `f` in a log view.

### Glyphs: prompt symbols, powerline and box drawing

The owner's goal is that starship and oh-my-zsh themes look right. Those
prompts print three kinds of glyph that an ordinary font does not have, or
does not draw to fit the cell. On a Mac with no Nerd Font installed, the
first Mac run of this crate drew them as boxed question marks.

**What libghostty-vt gives.** The code points and how many cells each one
takes. Nothing about drawing them: its headers export no font, glyph or
sprite API. That is Ghostty's renderer, which is not part of the library.

**What Ghostty does** (read from the source tarball that ships with
libghostty-vt 1.0.1; MIT):

- It embeds a symbols-only Nerd Font (`SymbolsNerdFont-Regular.ttf`, pinned
  at Nerd Fonts 3.4.0 in that source) as a fallback, with a generated table
  of per-glyph size and alignment rules.
- It draws box drawing, block elements, braille, the geometric powerline
  glyphs (U+E0B0..U+E0BF and two more) and some legacy-computing symbols
  itself, in `src/font/sprite/draw/*.zig`, so they meet the cell's edges.
  It does not draw the pictographs U+E0A0..U+E0A3 (branch, line, lock,
  column); those come from the symbols font.

That code is Zig inside the renderer and is not exported by libghostty-vt.
The licence would allow porting it with attribution. It was not ported:
the geometry here is written for this crate, and the box-drawing table is
derived from the Unicode character names.

**What this crate does.**

1. **Drawn as geometry** (`sprite.rs`): box drawing U+2500..U+257F (light,
   heavy, double, mixed, dashed, arcs, diagonals), block elements
   U+2580..U+259F, and the powerline separators U+E0B0..U+E0BF. Every
   rectangle is in whole device pixels and cell edges are snapped to the
   pixel grid, for backgrounds too, so lines continue across cells and
   prompt segments meet without seams at any font size, with any font.
2. **A bundled symbols font** (`glyphs.rs`): Symbols Nerd Font Mono from
   Nerd Fonts **v3.5.1**, for the rest of the Nerd Font ranges (about
   10,600 glyphs, the pictographs U+E0A0..U+E0A3 included). It is fetched
   by the provisioning script, checked against a pinned sha256 there and
   again by `build.rs`, and embedded in the binary: **2.6 MB**.

**Which font a symbol comes from.** A private-use code point the bundled
font has is drawn from the bundled font, unless the terminal's font is
itself a Nerd Font (by its family name) and has the glyph; then the user's
patched font is used, as in their own terminal. An ordinary Unicode
character the bundled font also has (the heavy angle bracket `❯`, the power
symbols) comes from it only when the terminal's font has no glyph for it.

**Departures from the suggested default, and why.**

- *The bundled font is not loaded with `add_fonts`; its outlines are drawn
  as vector paths.* GPUI's Linux text system refuses to load any family
  that has no glyph for the letter "m", as a font or as a fallback, so a
  symbols-only font can never be selected there. What gets drawn instead is
  whatever installed font happens to define that code point: on the
  development machine a system UI font has an unrelated glyph at U+E0A0,
  and the branch symbol came out as a small division-like sign. Reading the
  outlines with `ttf-parser` (already in the lockfile) and filling them as
  paths is the same on Linux and macOS and does not depend on installed
  fonts or on either platform's fallback rules.
- *U+E0A0..U+E0A3 come from the bundled font, not from hand-drawn paths.*
  They are pictographs, not cell geometry. Ghostty makes the same split.

**Room, size and clipping of a symbol.** A symbol's room is the cells it
may draw in. A double-width symbol (U+26A1, say) has the two cells the
emulator gave it. A narrow one has its own cell, and the next cell too when
that one is blank: each glyph in the bundled font sits in a box one em wide,
which fitted to one narrow cell is about 60% of the text's size, prompt
themes put a space after their icons, and Ghostty and other terminals treat
that space the same way. A double-width symbol is not widened into a third
cell: it already has the two cells the blank-cell rule exists to give.

In its room the glyph's em is made as wide as the room, never taller than
the cell, and its box is centred, so symbols of one size line up. The font's
metrics do not bound the ink, though: U+F0DC and U+F0DE rise to y = 1804
where the ascender is 1638, and other glyphs hang past their advance. So
the scale is then reduced until the glyph's ink box fits the room, and the
glyph is moved by as little as brings its ink inside
(`SymbolOutline::place`; a unit test places every glyph of the font in
eight room sizes and checks the ink is inside). Most glyphs are not moved
at all.

Everything self-drawn is also clipped to its room: a symbol to its one or
two cells, and box drawing, blocks and separators to their one cell. A
diagonal's stroke is wider than the cell at its corners and is cut off at
the cell's edges, so nothing self-drawn can land in a neighbouring cell.

`TermFont::symbols` can be set to `BundledSymbols::Always`: every symbol
the bundled font has is then drawn from it, whatever the terminal's font
has. The default is the rule above. The render test uses it to exercise a
double-width symbol on any machine, since many fonts have U+26A1.

**Licence and size.** The archive's licence file is MIT (Nerd Fonts). The
font is a collection, and the archive's README lists each icon set's own
licence:

| Icon set | Licence |
|---|---|
| Codicons, Font Awesome | CC BY 4.0 |
| Material Design | Apache 2.0 |
| Pomicons | OFL 1.1 (reserved font name) |
| Weather Icons | OFL 1.1 |
| Font Logos 1.3.0 | The Unlicense, a public-domain dedication ([LICENSE at v1.3.0](https://github.com/lukas-w/font-logos/blob/v1.3.0/LICENSE)); the archive's README writes this as "unlicensed" |
| Devicons, Octicons, Seti, Powerline, Powerline Extra, IEC power symbols, Font Awesome Extension, extra glyphs from Hack | MIT |

These are all permissive or public domain and none is copyleft, so
embedding is allowed. CC BY 4.0 and the OFL require attribution: a shipped
app must carry the Nerd Fonts licence and that list, as it must carry
Ghostty's notice. Ghostty ships the same collection. 2.6 MB in the binary
is acceptable for a desktop app (the window toolkit alone is far larger);
it is the same order as what Ghostty embeds.

**Limits.**

- Symbol outlines are tessellated as paths each frame and are not hinted.
  Fine for a prompt or a file listing; a screen full of thousands of icons
  has not been measured.
- Icons taken from a user's own Nerd Font are drawn by the text system at
  that font's natural width, not fitted to the cell.
- Braille and the legacy-computing symbols are not drawn as geometry.
- The app's default monospace font on the capture machine has no italic
  face, so italics show only with a font that has one.

**The render tests** (`tests/render.rs`). The first draws a row offscreen
with blank cells and blank rows around every glyph: the two solid powerline
arrows, branch U+E0A0, three icons (U+F418, U+E718, U+F07B), the two sort
arrows whose ink rises above the ascender (U+F0DC, U+F0DE), four
box-drawing characters, two diagonals (U+2571, U+2573) and two blocks, plus
U+E050, a private-use code point no font has, as this machine's
missing-glyph reference. It fails if:

- a glyph is blank, matches the missing-glyph rendering, is identical to
  another icon (missing-glyph boxes all look alike), or is a speck less
  than half the cell tall;
- the view did not take the symbols from the bundled font (without this
  the test passed on a machine whose own fonts cover the same code points);
- a symbol's ink box is not where the placement rule puts the bundled
  glyph, to a pixel and a half on each side: this catches a glyph cut off
  by the clip, or one of the wrong size or shape;
- **any pixel around a glyph's room differs from the background**: the
  rows above and below it and the blank cells before and after it;
- the geometry is off: the full block fills its cell, the half block fills
  exactly the lower half, lines reach the edges their arms point at and no
  others, and each arrow is flat and full height on one side and comes to
  a point on the other.

The second draws the double-width U+26A1 with an "x" straight after it and
fails unless the symbol is placed in both of its cells, is taller than it
would be in one, reaches into the second cell, and paints nothing above,
below or before them.

Each check was tried against the fault it is for: without the sprite clip
the diagonal paints 4 pixels outside its cell; with the old em-and-ascender
placement U+F0DC is cut off at the top of its room; with a one-cell room
the double-width symbol is half the size. The first version of the test
also caught the wrong-font branch glyph described above. The tests need an
offscreen renderer; CI installs Mesa's software Vulkan driver for them and
requires it there.

### What the renders and tests show

All in the same component, in the same panel:

| Item | Render | Test |
|---|---|---|
| Truecolour, 256 and 16 colours | [host](screenshots/panel-host-dark.png) | `ansi_colours_and_attributes_reach_the_frame`, `logs_keep_their_ansi_colours_and_prompt_glyphs_exactly` |
| Bold, italic, underline, strike, faint | host; real italics with a font that has them: [with a Ghostty look](screenshots/panel-host-ghostty-look-dark.png) | emulator tests |
| Wide glyphs | host | `wide_characters_take_two_cells` |
| Nerd Font prompt glyphs, a starship-style prompt | host | each private-use glyph is one cell holding that character |
| OSC 8 hyperlinks | host, [logs](screenshots/panel-logs-dark.png) | `osc8_hyperlinks_are_readable_and_queries_get_replies`, and in the logs test |
| Host login shell with prompt theming | host, [light](screenshots/panel-host-light.png) | a real `/bin/sh` login shell loads its profile, prompt and `ENV` file and is interactive; the same for zsh where it is installed |
| Container shell | [container](screenshots/panel-container-dark.png) (stand-in for `hack exec`) | stand-in CLI: argv checked, shell usable, bash-to-sh fallback and its label |
| Host shell with env, and the badge | [host with env](screenshots/panel-host-env-dark.png) (stand-in for `hack host shell`) | stand-in CLI: argv is names only; the real command was run by hand |
| Read-only log stream | logs | ANSI kept exactly as printed; input is never sent |
| The user's Ghostty look | [with a Ghostty look](screenshots/panel-host-ghostty-look-dark.png) | fixture config files in a temporary home |

The prompt in the renders is `/bin/sh` with a fixture profile that draws a
themed prompt, so the capture is deterministic. In the live example the tab
runs the user's own login shell.

In the renders, the prompt's separators are drawn as geometry and its
icons come from the bundled symbols font, except in the Ghostty-look
render, where the configured font is itself a Nerd Font and supplies them.
See "Glyphs" above for what is not fixed.

### PTY ownership

`pty::Pty` starts the child with `setsid()` and `TIOCSCTTY` (its own
session and process group, the PTY as controlling terminal) and marks
every inherited descriptor above stderr close-on-exec in the child.

**Teardown** (`session::OwnedSession`). The session leader is held
**unreaped** until the last signal has been sent. While it is unreaped its
pid cannot be reused, so neither can the group id or session id: `killpg`
on the leader's group reaches our group or nothing, and a process whose
session id is the leader is ours. Exit is observed with `waitid(WNOWAIT)`,
which does not reap.

**Signals fail closed.** A signal is sent only through a handle whose
identity cannot be recycled:

- The leader's process group, on every platform, by `killpg` under the
  anchor. Closing the PTY master also hangs up the controlling terminal: the
  kernel sends SIGHUP to the foreground group, and an interactive shell
  sends its own SIGHUP to its jobs.
- On Linux, members in other process groups (an interactive shell's jobs)
  through a **pidfd**: open it, re-read the session id, then
  `pidfd_send_signal`. The pidfd names one process for life.
- Where there is no such handle (macOS, and Linux kernels before 5.3),
  members outside the leader's group are **never signalled by number**. No
  `kill(pid)` after a check is used anywhere. Test helpers follow the same
  rule: an assertion that a process is gone only reports, and cleanup of a
  leftover goes through a pidfd held for that session.

The cost, on macOS: a process that is in another process group of the
session and ignores or never receives SIGHUP can outlive the tab, as it
would outlive any terminal app that is closed. It is found by a scan of the
session and returned in `Teardown::survivors` (`terminate_blocking`, or
`terminate_in_background` for a result without waiting); the panel shows
how many processes outlived closed tabs. Teardown stops as soon as nothing
more can be reached instead of waiting out its deadline.

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
  100 ms SIGKILL grace, inside GPUI's 200 ms shutdown window. This is
  registered for both kinds of backend, a PTY and a process-backed stream,
  and GPUI awaits it. A tab closed just before quitting is covered too:
  its teardown is already on a reaper thread waiting out the 300 ms close
  grace, which GPUI would not wait for, so the panel keeps the handle, and
  on quit it cuts the grace to the same 100 ms and awaits the result
  within the same window. The same holds for a backend the terminal ends
  by itself: a stream whose output ended while its process runs on, a
  session that ended, or a failed attempt replaced by the next. The core
  keeps those teardowns until they finish, and the count of processes a
  finished one left running, so the panel's "still running" note includes
  them; the view's quit handler cuts their grace and awaits them, and
  closing a tab hands both to the panel.
- Any input, and any change to the notice about undelivered input,
  notifies the view, so it is drawn in the next frame even when the child
  prints nothing.

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

- Session teardown: a same-group sleeper and one that ignores SIGHUP and
  SIGTERM are gone after Drop, and the leader is reaped.
- A job in another process group: ended on Linux; on macOS left alone and
  named in `survivors` (it then ends by itself).
- Fail closed, with a fake process table: a pid replaced by another
  process between verification and signalling receives nothing; without a
  handle no per-process signal is attempted at all.
- Fail closed, with real processes: a member that is killed and reaped at
  that boundary is not signalled by number (Linux); with handles disabled,
  a job in another group survives, is reported, is not signalled, and
  teardown returns in under three seconds.
- Identity: a scan that returns a pid from another session and a pid that
  does not exist; both are skipped, the other session is untouched.
- Anchor: after the shell exits, its pid still exists and its job is still
  found by session id.
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
- Sessions: labels and badges, argv and environment for each kind, name
  validation, login shell resolution, terminfo detection; a real login
  shell loading its profile; the CLI-backed kinds through a stand-in.
- Glyph geometry (`sprite.rs`), with a small rasteriser: every box-drawing
  character reaches exactly the edges its arms point at; an arm of each
  weight meets the cell edge the same way in every character, so neighbours
  join; corners are closed and double crossings hollow; dashes, blocks and
  shades have the right coverage; powerline separators span the cell.
- Ghostty config: fixture files in a temporary home (keys, malformed
  values, resets, load order, macOS location, includes and cycles, themes);
  a fanned-out include tree is read once per file and no byte twice; the
  limit holds on the open handle for a reader that never ends; a FIFO in
  place of the config is not read and does not block; the total byte and
  file budgets; `palette =` after earlier entries and after a theme's.
- Also: resize reaching the child, session leadership with a controlling
  tty, the child's environment, a 10,000-line file stream.

Checked to fail when the fix they cover is removed (mutations run by hand,
sources restored): the identity, anchor, queue-bound, final-output-in-grid,
thread-spawn-failure, notice, stream-quit, include fan-out, read-limit,
budget and palette-reset tests. The spawn-failure tests
only fail when both cleanup layers are removed, because either one alone
still kills and reaps the child.

Feature `ghostty`: `tests/emulator.rs` (colours and attributes, LNM,
bounded scrollback at 80 and 200 columns, follow, search, one search run
per change and none for an unchanged redraw, selection and
copy, reflow, wide characters, OSC 8, query replies, key encoding, paste
hardening, theme, the user's palette and cursor style), `tests/terminal.rs`
(a real child's final output is in the grid and scrollback; a descendant
holding the terminal does not keep it open; a stream's last line; the
bash-to-sh fallback and its label; an exit 127 after input is not a
fallback; logs keep ANSI and prompt glyphs) and the panel's tab logic.

Feature `ghostty`, `glyphs.rs`: the embedded font is the pinned file; the
table of its code points matches the font; outlines are closed contours
inside the font's box; Nerd Font family names are recognised.

Feature `screenshots`, `tests/render.rs`: the pixel tests described under
"Glyphs", and the monospaced font fallback (a missing or proportional
configured family draws the grid in a monospaced one, with a note). They
need GPUI's real platform and an offscreen renderer (a GPU, or software
Vulkan). macOS creates that platform only on the process's main thread, and
libtest and nextest run tests on worker threads, so this target has
`harness = false`: its own `main` runs each case on the main thread and
speaks the part of the libtest command line nextest uses (`--list`,
`--exact <name>`), so nextest still lists and runs each case in its own
process. The hosted macOS desktop job runs every `hack-desktop-term` test,
these included, with `HACK_TERM_REQUIRE_RENDERER=1`. `check-ghostty.sh`
passes arguments after `--` to nextest (`-- --no-fail-fast`).

Feature `screenshots` (GPUI test support; no display or GPU needed),
`tests/view.rs`: a rejected paste to a quiet child shows its notice in
exactly one new frame with no other event; with find open, output that
adds matches and then stops leaves the count shown equal to the number of
highlighted matches, with no further frame; redrawing an unchanged view
with find open runs no search; quitting the app ends a stream
process that ignores SIGTERM, with its descendant, and a PTY session that
ignores SIGHUP, and the processes of a tab closed just before quitting
that ignore SIGHUP and SIGTERM, of a stream that closed its output and
runs on, and of a closed tab whose session had ended and left a job;
with no bindings the usual chords are not shortcuts, the
`Find`, `CloseFind`, `Paste` and `Copy` actions do their work, and a chord
becomes a shortcut only once the app binds it.

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

**Find with many matches.** A libghostty search learns about new output
and viewport moves only when it is run, and each run checks every match it
holds. The emulator therefore keeps a revision counter (output, a resize,
a viewport move, the needle, the selected match) and runs the search at
most once per revision; the find count and a frame's highlights come from
that one pass, and redrawing an unchanged terminal runs nothing. Timed in
a dev build with a 10,000-line scrollback and 390,000 matches, medians of
30:

| Unchanged terminal | Before | After |
|---|---|---|
| Count, then frame (what a redraw does) | 19.4 to 20.5 ms | 1.8 ms |
| Frame alone | 11.2 to 11.6 ms | 1.8 ms |

A frame after one new line of output takes 12.4 ms in the same case: one
run, where it was two. That run is libghostty's cost for this many
matches; making it incremental (driving `tick` and `feed` across frames)
is not done.

One thing the benchmark caught: libghostty's default 10 MB scrollback byte
limit applies before the line limit, and on a 200-column grid kept only
about 5,500 lines. The emulator now sets its own byte ceiling (256 MiB) so
the 10,000-line bound is the one that applies; a test covers it.

What the scrollback promises: **at most 10,000 lines, and once full never
fewer than 10,000 minus one page.** libghostty frees scrollback a whole
page at a time, so just after a prune it holds less than the limit. A page
is about 1,100 lines at 40 columns and about 230 at 200 columns on Linux,
and pages are larger on Apple silicon (the first Mac run held 8,931 lines
at 40 columns). The tests measure the page as the largest single drop and
check both bounds after every line.

## Uses

**Logs tab.** A read-only `TerminalView` fed by core's existing log stream
reader; core's ndjson parser stays and decides what bytes to render (for
structured entries, the app formats one line per entry with its own ANSI
colours; raw lines pass through). ANSI printed by a service is kept exactly
as printed. LNM is on so bare `\n` lines render correctly. Follow, the
scrollback cap and the search hook (`TerminalView::search`, `search_step`)
back the tab's Follow toggle and Find field.

**Shells.** The three interactive kinds under "Sessions" above: a shell in
a service, the host shell, and a host shell with env. Each is a
`SessionPlan` from `launch.rs`; `TerminalCore::session(plan)` starts it and
`TerminalView::from_core` shows it. Closing the tab or window, or quitting
the app, ends that PTY's session (and with it the `hack` client). Processes
inside the container are ended by `hack exec` and the engine, not by this
crate.

**Security rules.**

- The app never types secrets into a terminal: input is only what the user
  types or pastes. Paste is sanitised (no control characters except tab, CR and
  LF) so it cannot break out of bracketed paste.
- The app never logs terminal contents: no stream or PTY bytes go to logs,
  telemetry or crash reports. Copy goes to the clipboard only on user action.
- The app never passes values in argv: argv holds only the CLI's
  subcommands, validated service, overlay and scope names, and a shell
  name. The app sets three fixed variables that say what terminal this is,
  and nothing else; env values are resolved and injected by the CLI inside
  the PTY and never pass through the app.
- The user's Ghostty config is read for a fixed list of keys; nothing else
  in it is kept, and nothing from it is logged.
- What a service prints is shown as printed; the app does not redact,
  rewrite or interpret it beyond terminal emulation. Program-initiated
  clipboard writes (OSC 52) and notifications are not acted on by this
  view.

## Licences of new dependencies

Pinned in `Cargo.toml`: `ghostty-vt =0.9.0` (lock: `0.9.0+ghostty-vt.1.0.1`),
`libc =0.2.191`, `image =0.25.10` (screenshots feature only),
`ttf-parser =0.25.1` (MIT OR Apache-2.0; reads the symbols font's outlines)
and, for the build script, `sha2 =0.10.9` (MIT OR Apache-2.0; verifies the
embedded font). The last two were already in the lockfile through GPUI and
`ghostty-vt-sys`; they are now direct dependencies of this crate.

Embedded, not a crate: **Symbols Nerd Font Mono**, Nerd Fonts v3.5.1,
2.6 MB. MIT for the collection, with the icon-set licences listed under
"Glyphs" (CC BY 4.0, Apache 2.0, OFL 1.1, MIT, and the Unlicense).

Every package this branch adds to `Cargo.lock`:

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
for this workspace. A shipped app must carry Ghostty's MIT notice, the
third-party notices above, and the Nerd Fonts licence with its icon-set
attributions.
