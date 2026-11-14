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

Cards group findings by area and offer one copied command or documentation link.
Project commands include the checkout path. The app never runs a Doctor fix:
one-click fixes remain blocked on the CLI's explicit safe-fix metadata (R7a/R7b).
The probes do not use `hack global status`, which can start Docker.
Offscreen Doctor evidence: [light](screenshots/doctor-light.png) and
[dark](screenshots/doctor-dark.png).

## What v0 does not do yet

Logs, Env and Activity tabs, CPU and memory, and
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

Fixture views: [daemon repair (light)](screenshots/daemon-stale-unit-light.png)
and [always-on needs attention (dark)](screenshots/always-attention-dark.png).

## Setup

![Setup evidence flow](diagrams/setup-evidence.svg) ([source](diagrams/setup-evidence.mmd))

On launch, fresh background checks determine whether setup is needed. The app
supports Hack CLI 5.x; the CLI card cannot be skipped. Doctor offers **Run setup
again**. Every card offers **Check again**. Skips last only until the next check
and never count as passed. Continue permits unresolved optional steps once the
CLI is available; the next launch checks everything again. No first-run flag,
setup results or command output are saved.

Cards cover CLI, Compose Docker, each native runtime, hackd, routing, trust and
the login service. An empty registry checks Compose prerequisites. A native-only
registry offers native documentation instead of global install/trust. Native DNS
stays Unknown when doctor did not receive a browser URL. Compose macOS DNS needs
all built-in resolver/dnsmasq pairs, any reported/custom host domain, port 53 and
CoreDNS forwarding. Linux requires `linux dns route`. Missing checks stay Unknown.
Only the explicit `local ca trust` check can prove Compose trust; `caddy local ca`
only proves export. Older CLIs without R16 leave trust Unknown.

Setup observes with a version-matched hackd snapshot, native `ps`, `daemon status
--json`, socket status and bounded Doctor reads. CLI project listing is refused
until R18 because it writes the registry; unavailable project coverage stays Unknown. It never observes through
`global status`. A setup refresh has a 120-second budget (plus the bounded socket
read); individual commands and Doctor cleanup also have deadlines. Native checks
not reached within the budget remain Unknown. `running` plus the socket version
matching the CLI proves hackd; bare status exit zero does not. `service.installed`
proves login installation separately.

Only the fixed `daemon start` and `daemon install` actions offer **Run**, with
bounded, memory-only output followed by fresh checks. Admin cards offer **Copy
command** and **Open Terminal**. The private one-use `.command` script quotes every
argument, prints the command and waits for Enter. macOS requests a new Terminal
window through `open -g -a Terminal`; Linux uses `xdg-terminal-exec` when available,
otherwise Copy. No existing pane is typed into and no password is requested by
the app. The script removes itself and its private directory after use or
cancellation; a terminal that never executes the script may leave that private
temp directory behind. Launching a terminal never proves a fix succeeded.
GPUI's window activation observer rechecks setup when the window becomes active;
visible setup also refreshes every ten minutes. Actual host focus and terminal
behavior still need macOS/Linux live qualification; tests use injected launchers.

Offline examples (no CLI, terminal or services):

```sh
cargo run -p hack-desktop -- --setup-fixture partial --theme dark
cargo run -p hack-desktop-core --bin hack-desktop-state -- --setup-fixture native-unknown
```

Other setup fixtures: `missing-cli`, `ready`. `--screenshots` renders all four
in light and dark offscreen. Evidence: [light](screenshots/setup-light.png),
[dark](screenshots/setup-dark.png).

Reusable terminal API (`core::terminal`): `CommandSpec { program, args }` provides
`display()` with shell quoting; `Script::create(temp_root, &spec)` owns the private
script; `open(Platform, linux_adapter, &dyn Launcher)` transfers cleanup to the
script after launch. `Launcher::launch(program, args)` is the injected boundary;
`SystemLauncher` is used only on explicit live clicks. `linux_adapter()` discovers
an absolute `xdg-terminal-exec`. Build upgrade commands from authored argv, never
from arbitrary CLI finding text.

The CLI setup card links to [v5 installation](../../docs/versions/v5/install.md),
not the stable v4 Homebrew command. A terminal shell function does not change the
app's executable. Select a prepared supported CLI explicitly when launching:

```sh
HACK_DESKTOP_CLI="$HOME/.hack-next/bin/hack-next" HACK_RUNTIME_BACKEND=compose hack-desktop
```

`HACK_DESKTOP_CLI` must be an absolute executable path. This selects the CLI for
checks, safe actions and terminal hand-offs; it does not install anything or
change PATH. Without it, each command rediscovers `hack` on absolute PATH entries,
so installing into an existing PATH directory can recover through **Check again**
without restarting. The app inherits PATH at launch; a changed PATH still needs a
relaunch. Follow the installation page's platform limits and existing-v4 migration
steps before using a candidate against a shared home.
On Linux, this preview requires a separately prepared source-built 5.x CLI; the
Apple Silicon prerelease download is not a Linux installer.
