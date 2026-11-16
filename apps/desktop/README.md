# Hack desktop app (preview)

Unsupported preview of a minimal native window for Hack: every
project, its state and services, and Start / Stop / Restart / Open. It is a view
over the `hack` CLI and the `hackd` socket; it keeps no state beyond window
layout, holds no credentials and runs `hack` as you for every action. Not part
of the release or onboarding yet.

| Crate | What |
|---|---|
| `core` (`hack-desktop-core`) | Models, CLI runner with timeouts, read-only hackd client, project state, list/detail view models, fixtures. No GUI dependency. |
| `app` (`hack-desktop`) | The window, built with [gpui-kit](https://gpui-kit.com/) `=0.9.1`. |
| `ui` (`hack-desktop-ui`) | Design v1 tokens and components, used by the window, and the `hack-desktop-gallery` fixture gallery. Spec and renders: [DESIGN-V1.md](DESIGN-V1.md). |

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

The core reads version identity through `hack version --json` and validates its
`hack.version.v1` schema inside the success envelope. New schema-tagged commands
use the strict parser; daemon and published legacy payloads keep their existing
parsers. Shared boundary fixtures are checked against the CLI producers.

Dropping a log stream retries killing its owned process group for up to two
seconds before detaching a reader still waiting for EOF. A descendant that
leaves that group cannot be retired by group signals; it no longer blocks the
dropping thread, and its reader exits when the descendant closes stdout.

## Check the live data path without a window

```sh
cargo run -p hack-desktop-core --bin hack-desktop-state            # all projects
cargo run -p hack-desktop-core --bin hack-desktop-state -- --project <name>
```

`hack-desktop-state` reads exactly what the window reads: hackd when its version
matches the CLI, plus native `hack ps` for native projects. This app does not
use a CLI project-list fallback. Without a matching daemon the reader reports
Unknown, rather than writing or claiming no projects exist.
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
of the window's fixtures, alphabetical, four per row:
[light](screenshots/fixtures-light.png), [dark](screenshots/fixtures-dark.png).

```sh
cargo run -p hack-desktop --features screenshots -- --sequence /tmp/seq
```

renders the window after each step of a short click-through on fixtures
(search, select, Start, branch instances, tabs, Doctor). Each step calls the
method its click handler calls; it is not a synthetic mouse event.
[Click-through](screenshots/window/click-through.png).

## Window

The window follows [DESIGN-V1.md](DESIGN-V1.md).

- **One title bar.** The app's header row is the title bar. On macOS the
  window has a transparent, full-size-content title bar and the system traffic
  lights sit inside the header (gpui-kit `TitleBar` moves the window and
  handles double clicks). On Linux it asks for client-side decorations and
  gpui-kit draws the window controls; a compositor that keeps server-side
  decorations draws its own title bar above the header instead.
- **Search** in the header filters the project list by project or branch
  name; Cmd-K (Ctrl-K on Linux) focuses it.
- **Live data only.** Without `--fixtures` everything comes from hackd and the
  CLI. What the CLI does not report is not invented: CPU and memory are a dash
  with a tooltip; the always-on switch is disabled with its reason (HACK-2213).
- **Branch instances** (`hack up --branch <name>`) are listed under their
  project from `/v1/projects` `branch_runtime`, with their own state,
  services and routes (from each container's `caddy` label). Its URL is
  `<branch>.<dev host>`, the host `hack open --branch` opens, never a service
  route. Selecting one runs Start, Stop, Restart, Open and Logs with
  `--branch <name>` in the checkout that started it (a registered linked
  worktree or the main checkout, from Compose's `working_dir`, compared as
  canonical paths so a checkout reached through a link still matches); when
  that checkout is not one the project registered, the app offers no actions. A project
  whose only running instances are branches is in the Running group. Native
  branch instances are not in that read yet (DESIGN.md R19).
- **Daemon match.** Equal version strings match. Otherwise the core asks the
  CLI (`hack daemon status --json`, `api_compatible`) once per version pair.
  When they do not match, the banner says which side to update: an older
  hackd offers Restart hackd, a newer one offers to copy `hack update`.
- **Clickable means it works.** Projects, branch instances, tabs (Services,
  Logs, Env), Start / Stop / Restart / Open with progress and errors, the copy
  buttons, the Doctor and Routing rows and the daemon recovery button. The
  Activity tab is gone until it has content.

Renders: [running, dark](screenshots/window/running-dark.png),
[running, light](screenshots/window/running-light.png),
[branch instances](screenshots/window/branches-dark.png),
[daemon mismatch](screenshots/window/daemon-mismatch-light.png),
[failed start](screenshots/window/failed-start-light.png),
[Doctor](screenshots/window/doctor-light.png).

## Doctor

The sidebar Doctor row reads `hack doctor --json` once outside all projects and
once per registered checkout. Machine checks are deduplicated by check id;
project findings link from the project header. Unknown statuses, failed reads
and projects not reached within the 90-second refresh budget remain unchecked.
Each read's time limit counts from before the CLI is started and includes
its stop: a check that ignores SIGTERM is killed when the budget's share for
it runs out. One limit: if starting the CLI itself blocks past the budget
(the operating system has not yet let the program start), the refresh ends
when the start returns.
Checks refresh on opening the pane and every ten minutes while it is visible.
Stale results cannot show an all-clear message or green Doctor indicator.
Missing registry rows remain unchecked and are never probed. Compose coverage
requires a report identifying that exact checkout's Hack directory; native
coverage requires exact root selection and unchanged marker identity before and
after the read, plus a known project-only check. A machine-only or ancestor-project
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
every intermediate symlink target and canonical ancestor must be owned by this user
or root, with no group/other-write bits. A root-owned sticky ancestor such as
`/tmp` is allowed above a private entry; a shared writable PATH entry itself is
not. An unsafe executable is excluded individually, so it does not hide safe
siblings such as Git. Foreign-owned executable targets are excluded too. A
script tool's `#!` interpreter must pass the same rules (recursively); a script
whose interpreter lives in a shared writable directory is excluded and its
checks become Unknown. Only two `#!` forms are accepted: a trusted interpreter
with no arguments, or exactly `#!/usr/bin/env <name>` (env identified by its
real path), whose name resolves only through the private wrapper PATH. Any
other form, including shell flags such as `-e`, makes that tool Unknown. A tool
this user cannot read is not used either: its `#!` line cannot be checked, yet
the kernel would still follow it. macOS ACL mutation grants
(write/append/delete, child deletion, attributes, security or owner changes) are
refused for any principal; deny/read-only entries remain supported. Linux access
ACLs are conservatively refused. Unreadable ACL metadata is untrusted. The same
ACL policy covers Docker discovery/config paths and their link targets. This
may refuse owner-only ACL grants; it never attempts to infer group membership
or effective ACL ordering. Native ACL fixtures need hosted macOS qualification. Darwin ACL inspection does not require executable read access. NULL/ENOENT
counts as absent ACL only when pre/post link and target metadata show the path
still exists unchanged; missing, changed or unreadable metadata remains
untrusted. These observations cannot lock out same-user/root ABA changes.
Doctor checks each tool's executable and its `#!` interpreter chain, not the
shared libraries a compiled tool loads. Library search paths embedded in a binary
(ELF `RUNPATH`/`RPATH`, Mach-O `LC_RPATH` and `@rpath`/`@loader_path` load
commands), the system loader configuration and the dyld shared cache are not
validated; inherited loader variables are removed, but a library in another
user's writable directory named by the binary itself would still load.

Each refresh creates one private temporary PATH of wrappers that exec the checked
absolute tool paths, preserving normal shim script locations and nested lookup.
Wrappers contain checked tool paths only, not credentials or injected context
values, and their temporary files are removed afterward.
Scans deduplicate absolute directories (including canonical aliases) before the
64-directory bound and inspect at most 8,192 entries. Reaching either bound
keeps already checked tools and runs Doctor with explicit incomplete coverage;
only checks dependent on filtered or unsearched Doctor tools become Unknown,
so those tools cannot look missing or healthy. One coverage card names the
unchecked tools; independently established checks keep their result. The fixed
[Doctor tool/dependency audit](DOCTOR_TOOLS.md) excludes unrelated executables
and documents actual read calls and file-only exclusions. For a scan cutoff
or unreadable directory, tools already checked remain available and only
unsearched Doctor tools receive incomplete coverage.
A root:admin group-writable `/Applications` or app-bundle target is refused too;
this preview does not widen trust for Docker Desktop or OrbStack. The lead's
Mac pass must qualify these layouts; a skip is not proof Docker is missing. This is an ownership/permission boundary,
not a sandbox or content/signature check: trusted tools, their plugins and
same-user/root updates remain trusted. Real macOS/Homebrew behavior still needs
the combined Mac pass; the layout and nested shims are tested with owned fixtures.
Those fixtures use only a temporary Homebrew-style tree and an owned symlink
alias; expected shim paths come from the fixture's canonical root, never from
the runner's real Homebrew installation or filesystem modes.

The fixed absolute Mutagen override (`HACK_MUTAGEN_PATH`) or managed
`HACK_HOME/bin/mutagen` candidate, an absolute `HACK_NATIVE_BINARY` (or, when it
is unset, the `hack-native` the CLI would take from beside its own executable)
and every discovered Docker plugin are checked before Doctor too, including the same `#!`
interpreter rule (the native runtime does not get the `env` form); Doctor's
runs also remove inherited interpreter startup and preload variables
(`BASH_ENV`, `ENV`, `SHELLOPTS`, `PS4`, exported Bash functions, Perl, Python,
Ruby and Node options and paths, the Bun runtime's `BUN_OPTIONS`, `BUN_BE_BUN`,
`BUN_CONFIG_*` and `BUN_INSPECT*` (the CLI is a Bun-compiled binary), and every
`LD_*` and `DYLD_*` loader variable), so a checked tool script cannot be made to load code from the
environment; missing candidates
require protected ancestry, and relative/unprovable selections are refused.
For a compiled CLI, the `hack-lifecycle-supervisor` companion beside it (which
Doctor's project checks run by absolute path for projects using the supervisor
runner, ignoring any selector) must pass the same rule; an unsafe one refuses
Doctor. When the CLI is a `#!` launcher, the supervisor it would finally run cannot
be located or checked by the app.
Doctor's runs pin the checked native runtime through `HACK_NATIVE_BINARY`. When the
CLI is a `#!` launcher, the executable it finally runs (and so its fallback
directory) cannot be known, so Doctor pins an absent path inside its private
wrapper directory and native checks report the runtime as unavailable; set
`HACK_NATIVE_BINARY` to check a bundled runtime in that layout.
Docker plugin preflight preserves HOME, DOCKER_CONFIG and DOCKER_CONTEXT. Doctor's
automatic checks only use a local Docker socket: a non-`unix://` `DOCKER_HOST`,
or a selected context whose endpoint is remote (for example `ssh://`) or cannot
be found, refuses the probe, because Docker would start programs such as `ssh`
and its configured helpers that Doctor does not inspect. It
checks the selected config/plugin directories, configured `cliPluginsExtraDirs`,
the four standard Unix system plugin directories and plugin executable/symlink
targets with the same owner/mode/ancestor rule. It streams only the public extra
directory list from config JSON; credentials and context contents are ignored,
never retained, logged, copied or rewritten. Config parsing is bounded to 1 MiB;
plugin inspection to 64 directories and 8,192 entries. Unsafe or unprovable
discovery produces CouldNotCheck with a reason before the Doctor CLI/Docker probe.

This supports the documented standard Unix Docker CLI discovery model, not
opaque/custom discovery. A nonempty `DOCKER_CLI_PLUGIN_EXTRA_DIRS`, relative
discovery path or unsupported/unreadable config is conservatively refused,
without switching to another context or home. Custom/bundled discovery and real
Mac behavior still require reviewer assessment and the combined Mac pass; this
is not a general Docker sandbox. Native pre/post marker witnesses are read-only
observations, not locks against concurrent same-user changes.

## What v0 does not do yet

The Activity tab, CPU and memory, onboarding, always-on, daemon actions and
upgrades come in later units. The design and the CLI/daemon requests they need
are in `DESIGN.md` (PR #800).

## Logs tab

`hack logs --json` for the selected project, following by default:
- Pause (reading continues, with an "N new" count), search, and a filter for one service (`hack logs <service>`).
- Click any line to show it in full below the list (long or width-clipped lines); lines over 4 KB show how much is hidden.
- "Log stream ended" and failures are shown distinctly, with Reconnect.
- CLI stderr is drained concurrently with an 8 KB retained tail. A separate 8 KB tail retains non-event stdout, including pretty JSON failure envelopes. Failed exits show the CLI error message or diagnostic tail and a human-readable exit status.
- The buffer holds at most 10,000 lines and 8 MB (service and timestamp included). Messages in valid records are capped at 64 KB; raw records over 1 MiB are replaced by a visible dropped-record marker instead. Memory only: nothing is written to disk and there is no copy-all.
- Scrolling up pauses following; Resume returns to the newest line. Each event's text fields are capped before queueing (log message 64 KB, notice 4 KB, other fields 256 bytes). The 1,024-event queue retains at most about 70 MiB of text. When full, the reader discards incoming events and keeps consuming stdout; the tab shows a cumulative skipped-event count. The CLI does not honor pipe backpressure, so blocking the reader would allow its own output buffer to grow. This bounds app retention, not the CLI's memory under an arbitrarily fast producer.
- Stderr output uses a muted style; only explicit error-level entries use the danger color. Services-tab tail polling stops while Logs is open.
- The app's limits do not bound allocations before the CLI emits a record: the current Compose reader accumulates a complete line before JSON formatting. A single oversized or unterminated service line can therefore grow CLI memory. Bounding that upstream chunk reader is a separate CLI fix; this preview does not claim end-to-end memory safety against arbitrary service output.
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
export is offered. The locked state shows `hack doctor` with **Copy command**.
Missing/unreadable `key_state` shows a lock. Absent key state means readability
is unknown, never inferred healthy from `has_value`: Set indicates storage,
not whether a value can be read.

Fixtures: `env-loading`, `env-error`, `env-normal`, `env-missing`, `env-locked`,
`env-empty`. Each renders offscreen in both themes through `--screenshots`.
To bound rendering to one state, combine `--fixtures env-normal` with
`--screenshots <output-dir>`.
Screenshots for this slice: [normal light](screenshots/env-normal-light.png),
[normal dark](screenshots/env-normal-dark.png),
[missing](screenshots/env-missing-light.png), [locked](screenshots/env-locked-dark.png).

This Env change is stacked on `feat/desktop-app-core` for focused review;
the completed desktop stack ultimately targets `next`.

Env reads refuse missing project markers and nested `.dev` targets shadowed by
an ancestor `.hack` project, using the CLI's discovery precedence. The adapter
canonicalizes the selected root and checks markers before and after the read;
concurrent filesystem edits are not an atomic fence. Empty legacy scope arrays
are shown as `global`. macOS keychain prompting remains unverified. Rapid tab
changes may launch overlapping bounded reads; stale results are discarded, but
in-flight reads are not deduplicated.

## Process-cleanup tests

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
that evidence. The generous retirement deadlines from #843 are integrated in
this tree for the combined qualification.

Process-cleanup regression tests use a generous 60-second scheduling deadline,
then check process retirement rather than enforcing a short wall-clock latency.
The stream-drop test also proves the reader was waiting before Drop and that
Drop's reader join completes. These test allowances do not change CLI timeouts.
