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

Logs, Env and Activity tabs, CPU and memory, Doctor view, onboarding, and
upgrades come in later units. The design and the CLI/daemon
requests they need are in `DESIGN.md` (PR #800).

## Daemon and always-on preview (DESIGN §5–6)

The daemon card observes `hack daemon status --json`, retaining a valid raw report
on exit 1. Missing or malformed status is **unknown**; an omitted
`service.installed` is not evidence that the login service is absent. Version
mismatch comes from the read-only socket `/v1/status`, compared with the CLI.
Explicit R8 `service.unit_stale: true` shows an outdated login service; missing
R8 metadata never triggers that diagnosis.

Start, Restart and Install login service run today's `hack daemon
start|restart|install --no-interactive` as the current user. They require no
terminal adapter and never request a password. Only one daemon action runs at a
time, including its fresh read after command exit. Exit 0 alone does not mean
running or installed. Failure keeps observed state and an error; timeout shows
unknown until another read. Missing CLI disables actions. Reads have deadlines;
actions have a two-minute deadline. The app never edits units, signals a daemon,
or starts one during observation. Only the CLI owns those effects.

Always-on consumes proposed project `autostart` and global `autostart_global`
fields when present, including manual-stop pause, failure count/limit/services,
global pause and login progress. Missing fields remain unknown. All always-on
switches are read-only: live R12a command capability is not established, and
current payloads lack R12b metadata. No proposed autostart command, local policy,
persistence or retry loop is implemented. No login service additionally explains
`hack daemon install`; missing `service_ready` never enables a switch.

Additional fixtures: `daemon-not-installed`, `daemon-stopped`, `daemon-starting`,
`daemon-incompatible`, `daemon-stale`, `daemon-stale-unit`, `daemon-unknown`,
`always-off`, `always-on`, `always-paused`, `always-attention`,
`always-global-paused`, `always-login`, `always-no-login`,
`always-command-failed` (failure presentation only; no command runs).
Fixture buttons never mutate a live system. To capture one fixture in both themes:

```sh
cargo run -p hack-desktop --features screenshots -- \
  --fixtures daemon-stale-unit --screenshots /tmp/daemon-shots
```

The daemon card is independent of project reads, so a project error does not
hide its observed status. Automatic daemon reads run at most every ten seconds;
post-action reads are immediate. Existing project polling remains unchanged.
R8 and R12 remain CLI/daemon work outside this desktop-only slice. This Linux
preview does not qualify native macOS service behavior or a shipped artifact.
