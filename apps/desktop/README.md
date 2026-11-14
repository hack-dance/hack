# Hack desktop app (preview)

Unsupported preview of a minimal native window for Hack (HACK-2214): every
project, its state and services, and Start / Stop / Restart / Open. It is a view
over the `hack` CLI and the `hackd` socket; it keeps no state beyond window
layout, holds no credentials and runs `hack` as you for every action. Not part
of the release or onboarding yet.

| Crate | What |
|---|---|
| `core` (`hack-desktop-core`) | Models, CLI runner with timeouts, read-only hackd client, project state, list/detail view models, fixtures. No GUI dependency. |
| `app` (`hack-desktop`) | The window, built with [gpui-kit](https://gpui-kit.com/) `=0.9.1`. |

This is its own Cargo workspace with its own lockfile and target directory; it
does not touch `packages/runtime-core`.

## Build and run

Rust **1.98.1**, pinned for this workspace only by `rust-toolchain.toml` (rustup)
and `mise.toml` (mise); the repo root keeps its own pin. macOS needs at least
1.98 (`gpui-pre-macos` uses `Option::map_or_default`). macOS 15+, or Linux with
Wayland or X11 and Vulkan. Linux build packages: `clang libfontconfig-dev
libwayland-dev libxkbcommon-x11-dev libx11-xcb-dev libssl-dev libzstd-dev
libvulkan-dev`.

```sh
cd apps/desktop
cargo test -p hack-desktop-core          # no daemon, Docker or Hack home needed
cargo run -p hack-desktop                # live: matching hackd; otherwise needs R18
cargo run -p hack-desktop -- --list-fixtures
cargo run -p hack-desktop -- --fixtures failed-start --theme dark
```

## Check the live data path without a window

```sh
cargo run -p hack-desktop-core --bin hack-desktop-state            # all projects
cargo run -p hack-desktop-core --bin hack-desktop-state -- --project <name>
```

`hack-desktop-state` reads exactly what the window reads: hackd when its version
matches the CLI, plus native `hack ps` for native projects. Today's CLI listing
auto-registers runtime projects and writes the registry, so it is never used as
a fallback. Without a matching daemon the reader reports Unknown / needs R18
(observe-only projects), rather than writing or claiming no projects exist.
The window retains stale names with Unknown states and disables project actions.
It offers **Start hackd** when unreachable or **Restart hackd** for a version
mismatch. Only a fresh matching snapshot restores observed states.
It applies that to the same view model and prints the list and
each project's detail as JSON. It runs no action, opens no window and writes
nothing.

An accepted refresh that changes the selected project root or backend clears the
previous log tail, including when Follow is off, and replaces any open Logs stream.

Live reads refresh every two seconds with a matching daemon and retry every ten
seconds when unavailable. Every request has an order token: a read started before
an action finishes cannot clear its failure, and an older result cannot replace a
newer one. Restarting/dead containers are failures; created/paused containers
without a running service remain Unknown, even when the CLI summary says stopped.

Every designed state has a fixture (`loading`, `empty`, `daemon-down`, `many-projects`,
`daemon-mismatch`, `engine-down`, `error`, `cli-missing`, `stopped`, `starting`,
`running`, `degraded`, `stopping`, `failed-start`, `needs-attention`).

## Screenshots without a display

```sh
cargo run -p hack-desktop --features screenshots -- --screenshots /tmp/shots
```

This renders every fixture in light and dark to PNG with GPUI's offscreen
renderer (WGPU on Linux, Metal on macOS). It opens no window. Current renders
(all 15 fixtures, row by row: loading, empty, daemon-down / daemon-mismatch,
engine-down, error / cli-missing, many-projects, stopped / starting, running,
degraded / stopping, failed-start, needs-attention):
[light](screenshots/fixtures-light.png), [dark](screenshots/fixtures-dark.png).

## Logs tab

`hack logs --json` for the selected project, following by default:
- Pause (reading continues, with an "N new" count), search, and a filter for one service (`hack logs <service>`).
- Click any line to show it in full below the list (long or width-clipped lines); lines over 4 KB show how much is hidden.
- "Log stream ended" and failures are shown distinctly, with Reconnect.
- CLI stderr is drained concurrently with an 8 KB retained tail. A separate 8 KB tail retains non-event stdout, including pretty JSON failure envelopes. Failed exits show the CLI error message or diagnostic tail and a human-readable exit status.
- The buffer holds at most 10,000 lines and 8 MB (service and timestamp included). Messages in valid records are capped at 64 KB; raw records over 1 MiB are replaced by a visible dropped-record marker instead. Memory only: nothing is written to disk and there is no copy-all.
- Scrolling up pauses following; Resume returns to the newest line. Each event's text fields are capped before queueing (log message 64 KB, notice 4 KB, other fields 256 bytes). The 1,024-event queue retains at most about 70 MiB of text. When full, the reader discards incoming events and keeps consuming stdout; the tab shows a cumulative skipped-event count. The CLI does not honor pipe backpressure, so blocking the reader would allow its own output buffer to grow. This bounds app retention, not the CLI's memory under an arbitrarily fast producer.
- Stderr output uses a muted style; only explicit error-level entries use the danger color. Services-tab tail polling stops while Logs is open.
- "Copy command" copies the equivalent `hack logs --path … [service]` for a terminal.
- Native projects show the terminal command instead, because native logs are a one-service snapshot.

Fixtures: `--logs-fixture <state>` (`--list-fixtures` lists them). Boards:
[light](screenshots/logs-light.png), [dark](screenshots/logs-dark.png). Row by row:
following / paused with search, long lines / service filter, follow ended /
failed, native / stopped.
The paused-search fixture shows its active query in the search field. Finite
reads for observed stopped projects include that state alongside the stream status.
The paused fixture also demonstrates the overflow count. Pause has no timeout;
following resumes through Resume, not automatically when scrolling to the bottom.

## Not yet

Env and Activity tabs, CPU and memory, onboarding, always-on, daemon actions
and upgrades come in later units. The design and the CLI/daemon requests they
need are in `DESIGN.md`.
