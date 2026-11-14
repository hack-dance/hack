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

## Doctor

The sidebar Doctor row reads `hack doctor --json` once outside all projects and
once per registered checkout. Machine checks are deduplicated by check id;
project findings link from the project header. Unknown statuses, failed reads
and projects not reached within the 90-second refresh budget remain unchecked.
Checks refresh on opening the pane and every ten minutes while it is visible.
Stale results cannot show an all-clear message or green Doctor indicator.
Missing registry rows remain unchecked and are never probed. Compose coverage
requires a report identifying that exact checkout's Hack directory; native
coverage requires a known project-only check. A machine-only or ancestor-project
report cannot establish Compose project coverage.
Machine diagnostics remain visible even when a checkout cannot be verified.

Cards group findings by area and offer one copied command or documentation link.
Project commands include the checkout path. The app never runs a Doctor fix:
one-click fixes remain blocked on the CLI's explicit safe-fix metadata (R7a/R7b).
The probes do not use `hack global status`, which can start Docker.
Offscreen Doctor evidence: [light](screenshots/doctor-light.png) and
[dark](screenshots/doctor-dark.png).

For integrations, `Card.authored_remedy` exposes an `AuthoredRemedy`: `argv()`
returns authored arguments without an executable or environment, including each
project root as one lossless argument. Bind these arguments to the integration's
selected, checked CLI context and retain its action gates. Do not parse or execute
the copy display string. Standalone Doctor's copy display names `hack` from the
user's terminal PATH; it does not select a candidate CLI or home. A recipe grants
no permission to run a fix, and Doctor has no dependency on Setup's context types.

Doctor accepts owner-writable tool directories, including a normal user-owned
`/opt/homebrew/bin` with mode `0755`. A PATH directory, each selected executable,
its resolved symlink target and canonical ancestors must be owned by this user
or root, with no group/other-write bits. A root-owned sticky ancestor such as
`/tmp` is allowed above a private entry; a shared writable PATH entry itself is
not. An unsafe executable is excluded individually, so it does not hide safe
siblings such as Git. Foreign-owned executable targets are excluded too.

Each refresh creates one private temporary PATH of wrappers that exec the checked
absolute tool paths, preserving normal shim script locations and nested lookup.
It stores no environment values and removes its own temporary files afterward.
Scans are bounded to 64 PATH entries and 8,192 directory entries; excess or
unknown outcomes remain unchecked. This is an ownership/permission boundary,
not a sandbox or content/signature check: trusted tools, their plugins and
same-user/root updates remain trusted. Real macOS/Homebrew behavior still needs
the combined Mac pass; the layout and nested shims are tested with owned fixtures.
Those fixtures use only a temporary Homebrew-style tree and an owned symlink
alias; expected shim paths come from the fixture's canonical root, never from
the runner's real Homebrew installation or filesystem modes.

## What v0 does not do yet

Logs, Env and Activity tabs, CPU and memory, onboarding, always-on,
daemon actions and upgrades come in later units. The design and the CLI/daemon
requests they need are in `DESIGN.md` (PR #800).
