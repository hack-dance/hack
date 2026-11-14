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

Logs and Activity tabs, CPU and memory, Doctor view, onboarding, always-on,
daemon actions and upgrades come in later units. The design and the CLI/daemon
requests they need are in `DESIGN.md` (PR #800).

## Env tab (names only)

Env reads `hack env list --json --path <root>` on tab open, project selection,
and **Check again**, with a 10-second deadline. Native projects select
`HACK_RUNTIME_BACKEND=native`. There is no polling or disk state for Env.
A bare report on exit 1 is still a report. Missing required names appear first
in red; both legacy scope arrays and canonical scope strings are supported.
An explicit empty `vars` array shows “This project has no env layers” only
when the report has no configured files/scopes or selected scope. Canonical
reports label the selected scope (global by default); an empty scope is not
project-wide absence. Other service scopes are not included in this listing.
Malformed output shows “Could not read environment metadata”.

The model retains only name, layer/source, scope, storage kind, set and required
metadata. It discards unknown fields, including values/materialized data, and
never includes raw output in errors. No editing, value reads, reveal, copy or
export is offered. The locked state offers only **Copy hack doctor**.
Missing/unreadable `key_state` shows a lock. Absent key state is unknown:
**needs R10**, never inferred healthy from `has_value`.

Fixtures: `env-loading`, `env-error`, `env-normal`, `env-missing`, `env-locked`,
`env-empty`. Each renders offscreen in both themes through `--screenshots`.
To bound rendering to one state, combine `--fixtures env-normal` with
`--screenshots <output-dir>`.
Screenshots for this slice: [normal light](screenshots/env-normal-light.png),
[normal dark](screenshots/env-normal-dark.png),
[missing](screenshots/env-missing-light.png), [locked](screenshots/env-locked-dark.png).

This Env change is stacked on `feat/desktop-app-core` for focused review;
the completed desktop stack ultimately targets `next`.
