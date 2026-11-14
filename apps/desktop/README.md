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
bash scripts/test.sh                    # pinned nextest, separate process per test
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
previous log tail, including when Follow is off.

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

## What v0 does not do yet

Logs, Env and Activity tabs, CPU and memory, Doctor view, onboarding, always-on,
daemon actions and upgrades come in later units. The design and the CLI/daemon
requests they need are in `DESIGN.md` (PR #800).

The supported desktop test command uses the repository-pinned nextest release
(installed by `scripts/install-cargo-nextest.sh` at the repository root), with
zero retries and one process per test. Raw threaded `cargo test --workspace` is
not the macOS qualification command: fresh executable writes, concurrent process
creation, and short socket deadlines can interact across libtest threads.

On macOS, the CLI runner uses `posix_spawn` with `POSIX_SPAWN_CLOEXEC_DEFAULT`
and explicit stdin/stdout/stderr actions. This prevents a CLI child from holding
an unrelated descriptor during another thread's non-atomic close-on-exec setup.
The process group, selected environment, cwd, timeout and retirement contracts
are preserved. Linux retains the standard process implementation. This product
boundary is needed independently of test isolation; a mutex around runner calls
would not cover descriptors opened by other GUI/library threads.

For the macOS qualification loop, run
`HACK_DESKTOP_TEST_REPETITIONS=200 bash scripts/test.sh` from this directory.
Each iteration runs all workspace tests in separate processes with zero retries;
doctests run afterward. Both CI hosts use this same wrapper (one iteration per
job). Three consecutive green hosted macOS jobs and the lead's 200-run native
receipt are required for HACK-2243 acceptance; a Linux run or cross-check is not
that evidence. #843's independent generous retirement deadlines remain necessary
and should land before the final combined qualification.
