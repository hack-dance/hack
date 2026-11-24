# Hack desktop app (preview)

Unsupported preview of a minimal native window for Hack: every
project, its state and services, and Start / Stop / Restart / Open. It is a view
over the `hack` CLI and the `hackd` socket; it keeps no state beyond window
layout and holds no credentials. Project actions run `hack` as you. Service
Stop uses Docker to target an individual Compose service. This app is outside
the release and onboarding workflows.

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
bash scripts/build.sh                   # provision libghostty-vt inputs, then build the app
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
cargo run -p hack-desktop-core --bin hack-desktop-state -- --reads 3 --compact  # cold read, then warm reads
```

`hack-desktop-state` reads exactly what the window reads: hackd when its version
matches the CLI, plus native `hack ps` for native projects. This app does not
use a CLI project-list fallback. Without a matching daemon the reader reports
Unknown, rather than writing or claiming no projects exist.
The window does not wait for native projects: a native project's `hack ps`
is a CLI start each (seconds, more for a prerelease channel), so it shows the
list and Compose state at once and fills each native project in as its
`hack ps` returns, at most 8 at a time, keeping the previous state meanwhile
("Reading native status…" on a first load). A kept state is not evidence: it
never clears a failed start. `read_steps` names when the window shows the
list (`list shown in the window after`) before the native reads. This lasts
until hackd reports native runtime itself (DESIGN.md R19).
The window retains stale names with Unknown states and disables project actions.
It offers **Start hackd** when unreachable or **Restart hackd** for a version
mismatch. Only a fresh matching snapshot restores observed states.
It applies that to the same view model and prints the list and
each project's detail as JSON. It runs no action, opens no window and writes
nothing.
It also prints which Hack CLI it used and the others found (`cli`), the hackd
socket it read, and how long each step of the read took (`read_steps`). Each run is a
new process, so its first read is cold: the CLI version, the hackd location
and the version-compatibility answer are not cached yet, and every step that
starts the CLI pays its start-up (about a second for a launcher that checks
its bundle on each start). `--reads <n>` reads `n` times in one process and
lists each read under `reads`, as the window's later reads are warm.

### Which CLI and which hackd

The app runs one Hack CLI and reads the hackd that CLI reports
(`hack daemon status --json` → `socket_path`), not a socket under `HACK_HOME`. A
prerelease channel keeps its hackd and registry in its own home
(`~/.hack-next/versions/<version>/cli-home`), so reading the default home showed
no projects while a healthy prerelease hackd was running. The socket is asked
for once per CLI and again when it stops answering. A CLI that does not report
one uses the home it inherits (`HACK_HOME`, else `~/.hack`).

Every `hack daemon` command the app runs on its own (the status reads that
find hackd and decide compatibility, and **Start / Restart hackd** in the
project pane) runs the selected CLI the way Setup runs its actions: pinned to
that executable, in the checked execution context (a clean environment with
only its allowlist, and a `PATH` of directories no other user can change),
with `HACK_MCP_COMMAND` naming the same executable. The CLI starts hackd by
invoking itself; without that it would use the first `hack` on `PATH`, which
on a machine with several installs can be another one. A failed Start or
Restart shows the CLI's stderr and stdout (both bounded).

hackd counts as running when the CLI says so (`running`), and also when its
API answers (`status: "running"` with `api_ok` or `api_reachable`) without a
tracked PID, so a hackd started outside the CLI's PID file is never offered
Start. The socket client connects without blocking and keeps one deadline
for the whole request, so a full listen backlog or a reply that trickles in
cannot hold a read past it. A `/v1/status` reply without a status or a
version is not a status.

One machine action runs at a time: Setup's Start / Install hackd and Start /
Restart hackd in the project pane share one gate; while one runs the others
are disabled. A Setup step handed to your terminal waits for that action but
does not hold the gate: the app cannot see the command finish there, and
checks again when you come back. Switching to another CLI
releases it, and a late completion from the previous CLI cannot release an
action started since.

The app finds stable `hack` on PATH and a prerelease `hack-next` (on PATH or
`~/.hack-next/bin/hack-next`), offering only installs no other user can change.
It uses the one chosen before, else stable, else the prerelease. The status bar
names it (`hack-next 5.0.0-next.19 · prerelease`) and offers the other with one
click (**Use hack (stable)**); the choice is saved in the app's settings
(`~/Library/Application Support/dance.hack.desktop/settings.json` on macOS,
`$XDG_CONFIG_HOME/hack-desktop/settings.json` elsewhere), never an environment
variable. `--drive` has `use-cli <name>` and `expect-cli <text>` for it.

Through a launcher such as `hack-next`, every CLI start re-verifies the
installed version first (receipt, bundle checksums, signatures), so each costs
on the order of a second. A read asks the CLI for its version at most every
30 s, and runs one `hack ps --json` per native project, up to 8 at once;
Compose projects come from hackd alone.

When another install's CLI reports the same hackd (both use one home, such as a
stable `hack` and a v5 build in `~/.hack`), a version mismatch names both
installs and offers neither Start nor Restart: the other install would replace
the app's hackd again. Use that install in the app, or give each its own home.

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

To capture the grouped sidebar and row menu in both themes, run
`hack-desktop --screenshots <dir> --fixtures grouped-sidebar` with the
screenshots build. This fixture drives the sidebar and menu through GPUI clicks.

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
- **Projects and copies.** The project tree shows `main`, registered
  worktrees and Hack branches. Only the selected copy expands to show its
  services. The Services tab lists Other copies and their routes, including
  copies with no running containers. hackd and the CLI report configuration
  in `branch_copies` and runtime observations in `branch_runtime`.
- **Service actions.** Hover a service to open its route or stop it. Its
  menu also opens filtered logs, opens the existing Ghostty drawer for a
  shell, restarts the service, and copies its route. Selection and Files
  navigation use the service pane's instance-scoped navigation target.
  Use the copy header's menu to inspect the full copies report.
- **Daemon match.** Equal version strings match. Otherwise the core asks the
  CLI (`hack daemon status --json`, `api_compatible`) once per version pair.
  When they do not match, the banner says which side to update: an older
  hackd offers Restart hackd, a newer one offers to copy `hack update`.
- **Clickable means it works.** Projects, branch instances, tabs (Services,
  Logs, Env), Start / Stop / Restart / Open with progress and errors, the copy
  buttons, the Doctor and Routing rows and the daemon recovery button. The
  Activity tab is gone until it has content.

### Terminal panel

On macOS the panel is always part of the app; there is no flag to turn it on.
It needs the pinned libghostty-vt inputs, which `scripts/build.sh` provisions
before it builds: it fetches only what is missing into `target/ghostty-inputs`
and checks each file against the sha256 committed in
`term/scripts/provision-ghostty.sh`. That is the only step that uses the
network; cargo then builds offline from that directory (`.cargo/config.toml`
names it, and an exported `GHOSTTY_RELEASE_DIR` wins). A build without the
inputs stops at once and says which file is missing and which script to run.
`scripts/test.sh` provisions them on macOS too.

```sh
bash scripts/build.sh                 # provision, then build with the panel
cargo run -p hack-desktop             # macOS: live, with the panel
```

On Linux the panel is the opt-in `terminal` feature (it also needs the
provisioned Zig): `bash scripts/build.sh` turns it on, or
`eval "$(bash term/scripts/provision-ghostty.sh)"` and then
`cargo run -p hack-desktop --features terminal`. Without it the window keeps
its Logs tab.

Each project and each branch instance has a panel docked under the detail
pane (DESIGN-V1.md, "Terminal panel"): a drag handle (drag to resize, to the
top to maximize, down to collapse; double-click to maximize), a tab strip and
the terminal. Its state is kept per instance. The app owns every PTY and runs
the CLI in it; it passes names only and never builds an environment. A CLI tab
gets what every CLI call from the app gets: the instance's backend and a `PATH`
with only absolute entries (a plain host shell keeps the user's `PATH`):

| Tab | Runs, in the instance's checkout |
|---|---|
| Logs (first, not closable) | `hack logs [--branch <b>] [--no-follow] --tail 500 --pretty`, read-only, on a PTY so the CLI's styling (coloured service names, dim timestamps, levels) and each service's own colours reach the grid |
| Shell in a service (+ menu) | `hack exec [--branch <b>] <service> -- bash`, then `sh` |
| Host shell (+ menu) | the user's login shell |
| Host shell with env (+ menu) | `hack host shell --env <overlay> --scope <scope>`, names from `hack env list --json` (`--env base` when no overlay is named); amber badge unless the overlay is the default |

The Logs tab passes `--pretty`: on a PTY, plain `hack logs` keeps only the
colours services print themselves, while `--pretty` adds the CLI's own
styling (levels, bold 256-colour service names, dim keys and brackets) through
the formatter every log path shares. Lines read `[LEVEL] [service] message
key=value`, plain text in the grid, so find and copy work as before. The 16
ANSI colours come from your Ghostty `palette` over the light or dark theme, and
the 256-colour codes from its overrides or the standard xterm palette.
[`--pretty` tail, light](screenshots/window/logs-pretty-light.png) (the CLI's
formatter over sample service lines, drawn by the app's terminal).

A Logs stream that ended (a stopped project that now runs) restarts when its
tab is clicked. Keys: Cmd-J (Ctrl-Shift-J) toggle, Cmd-T new tab menu,
Cmd-W close, Cmd-Shift-] / [ next and previous, Cmd-Shift-Return maximize,
Cmd-F find, Cmd-C / Cmd-V copy and paste in a terminal. On Linux, Ctrl-K focuses
the project search except in a terminal, where it goes to the shell. Without the feature
the window keeps its Logs tab. `term/scripts/check-ghostty.sh` builds and
tests the app with the feature too.

Input (keys and paste) is queued up to 1 MiB for the program in the tab. A
paste larger than that is refused whole, never cut, and the tab says so.

#### Drive the panel from the command line

`--drive <steps>` runs a steps file in the real window, quits the app the way
the user does, waits 5 s, and counts every process still alive in a session a
tab started, every leader a tab tried included (a container shell that fell
back from bash to sh started two). It exits 0 only when the app reported every
step done and nothing is left.
`--hidden` opens the window without showing it. Each step calls what the
matching click or key calls; tabs come from the panel's own new-tab menu.

```text
select <project> [<branch>]     select an instance; waits for live data
logs | host                     show the Logs tab | open "Host shell"
container <service>             open "Shell in <service>"
env <overlay> [<scope>]         open "Host shell with env…" for it
key <keystroke>                 e.g. key ctrl-c (through the keymap)
type <text>                     type it, one keystroke per character
                                (\r or \n is Enter, \t is Tab, \\)
paste <file>                    paste a file's text as the Paste action
                                does (into find while it is open)
expect <text> [<seconds>]       wait for text on the active tab's screen
expect-styled <count> [<seconds>]
                                wait for at least <count> styled cells
                                (colour, bold, faint…) on the active tab
expect-notice <text> [<seconds>]
                                wait for the active tab's notice (a refused
                                paste) to contain text
tab <services|logs|env>        show that detail tab
expect-env <NAME> [<seconds>]   wait for NAME in the Env listing
env-set <NAME> <value>          edit a row as the pencil and Save do
env-add [--secret] <NAME> <value>
                                add a variable as + Variable and Save do
                                (both write through the CLI: use them only
                                on a throwaway project, see "Env writes
                                against the real CLI"; the report prints a
                                value's length, never the value)
wait <milliseconds>
check-container <service> <pattern>
                                after the app has quit, count processes in
                                the service whose command line contains
                                <pattern> (read through `hack exec`); a count
                                above 0 is reported as known open (below)
                                and does not fail the run
quit                            implied at the end
```

The by-hand list as one file. Replace the `<…>` names; the paste files are
comment lines, so a shell that receives one runs nothing. Each `expect` looks
for the result of arithmetic the shell does, never for text that is on the
typed command line, so the echoed command cannot satisfy it:

```sh
# From apps/desktop. Paste paths in the steps file are relative to it.
mkdir -p /tmp/panel
yes '# paste check' | head -c 2097152 > /tmp/panel/big.txt   # 2 MiB: refused whole, limit named
yes '# paste check' | head -c 921600 > /tmp/panel/mid.txt    # 900 KiB: delivered
cat > /tmp/panel/panel.steps <<'STEPS'
# Logs and a host shell
select <project>
logs
expect <a line the logs show> 30
host
type echo host-$((40+2))\r
expect host-42 15
# Ctrl-C through the keymap ends a foreground job. Wait until the command
# is running first: a shell with a prompt framework (zsh with a theme) can
# take a second or two to start it, and a Ctrl-C sent before that only
# clears the prompt line.
type sleep 30\r
wait 2500
key ctrl-c
type echo after-ctrl-c-$((1+1))\r
expect after-ctrl-c-2 10
# Pastes: 2 MiB is refused with the limit named, 900 KiB is delivered
paste big.txt
expect-notice more than the 1 MiB input limit 5
paste mid.txt
# The shell's line editor takes a moment to read 900 KiB
wait 2000
key ctrl-c
type echo after-paste-$((2+2))\r
expect after-paste-4 60
type sleep 86399 &\r
# A shell in a service, typed into at once (input waits for the shell
# that starts, sh on an image without bash), and what it leaves inside
# the container
container <service>
type echo in-$((1+1))-container\r
expect in-2-container 30
type sleep 86398 &\r
check-container <service> 86398
# A host shell with an env overlay: the step line shows the label and
# badge; check that a variable is set without printing it
env <overlay> <scope>
type [ -n "$<VARIABLE>" ] && echo env-set-$((3+3))\r
expect env-set-6 30
# The same on a branch instance started from a linked worktree
select <project> <branch>
logs
host
type echo branch-$((2+3))\r
expect branch-5 15
container <service>
type echo branch-in-$((4+4))\r
expect branch-in-8 30
STEPS
cargo run -p hack-desktop --features terminal -- --drive /tmp/panel/panel.steps  # the flag is only needed on Linux
```

### Env writes against the real CLI

`scripts/env-drive/run.sh <hack-desktop binary> [passes]` checks Env editing
end to end without touching a real project. Each pass makes a temp project,
`HOME` and `HACK_HOME` under `/tmp`, seeds one plaintext value with this
checkout's CLI (`bun index.ts`), and drives the app with
`scripts/env-drive/edit.steps`:
- select the project and open Env;
- edit that value;
- add a plaintext variable and a secret variable.

It then reads the values back with the same CLI and checks that the secret's
value is in no plaintext YAML. A fake hackd (`fakehackd.py`) serves the
project list, so no daemon runs; every `hack env` command the app runs is the
real CLI. Needs `bun` (set `BUN` to choose one) and `python3`.

```sh
bash scripts/build.sh
scripts/env-drive/run.sh target/debug/hack-desktop 10
```

The report gives each step's result (a paste step names the notice it got), each
tab's session leader, `after quit + 5s: N process(es) alive in the M
session(s) the tabs started`, the container counts and `result pass|fail`.

The host-side count covers every process in a tab's session (the shell, its
jobs, `hack`, the `docker exec` client). A process that starts its own session
(`setsid`) leaves both the panel's teardown and this count. Processes inside a
container are not host processes; `check-container` counts them through the CLI.

**Known limit:** closing a service-shell tab, or quitting, ends the `hack exec`
session on the host but not a job that shell started in the background inside
the container (`sleep 600 &`), as with `docker exec -it`. The app has no way
to find or signal processes in a container; that needs the CLI (DESIGN.md,
R21). Until then `check-container` reports such a process as known open.

A shell in a service that falls back from `bash` to `sh` keeps what is typed
while it opens: input waits until the shell that starts has printed something
and kept running for half a second (or for 10 s, for a shell with no prompt),
so it reaches only that shell and never runs twice. However slow `docker exec`
is to fail, typing straight after opening the tab never cancels the fallback.

The new-tab menu offers a shell in each service the last good read reported
running. While a refresh is slow or failing, it keeps that list, marked
"(last known)"; only a good read that reports a service stopped removes it.

Renders: [running, dark](screenshots/window/running-dark.png),
[running, light](screenshots/window/running-light.png),
[branch instances](screenshots/window/branches-dark.png),
[daemon mismatch](screenshots/window/daemon-mismatch-light.png),
[failed start](screenshots/window/failed-start-light.png),
[Doctor](screenshots/window/doctor-light.png).

## Setup

![When Setup checks run](diagrams/setup-evidence.svg)
([source](diagrams/setup-evidence.mmd))

A live launch checks setup (DESIGN.md section 2) and opens **Set up Hack** when
something needs attention, unless you have already selected an instance,
opened Doctor or opened a terminal tab: the check can take seconds and never
pulls the window away from what you opened. A missing CLI still opens it.
Doctor's **Run setup again** opens it any time. One
card per step, in order: the Hack CLI (required), the Compose or native
runtime, hackd, routing and DNS, certificate trust, and the login service.

- When another installed CLI shares this home and runs hackd at another
  version, the hackd card names that install and offers no restart, as the
  project list does.
- Checks only read; they never start a service. Unknown and skipped steps stay
  unresolved; a skip lasts for this session and never satisfies a check. The
  CLI cannot be skipped, and **Continue** needs it.
- The app runs only the fixed `hack daemon start` and `hack daemon install`,
  each followed by fresh checks. Install needs a confirmed login-service
  manager and an ordinary Hack home.
- Admin steps (`hack global install`, `hack global trust`) call `sudo`, so they
  go to your own terminal (**Open in terminal**: Terminal.app, or
  `xdg-terminal-exec` on Linux). It shows the command and waits for Enter; no
  password passes through the app. **Copy command** works everywhere.
- Checks and fixes run the CLI that was checked, by absolute path, refused
  when another user can change it, with a clean environment of named,
  non-secret variables only.
- Setup checks again on **Check again**, after each fix it runs, when the
  window regains focus while Setup is shown or a fix is outstanding (back
  from an admin step in the terminal), when you switch CLI, and once its
  result is 10 minutes old while the pane stays open in a visible window. It never checks while a check or a fix runs.

Renders: [setup, light](screenshots/window/setup-light.png),
[no CLI, dark](screenshots/window/setup-missing-cli-dark.png).

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

Doctor groups machine and project findings and folds the passed checks. The
project pane shows one follow-up at a time. Dismissing it hides that finding
for the session until its evidence changes.

**Fix all** runs the available repairs in row order in the shared terminal
drawer. It checks again after each command exits. A failed command or a check
that cannot confirm the repair stops the queue and keeps the terminal output.
**Stop** interrupts the current command and cancels the remaining queue. Some
machine repairs ask for your password inside the terminal. Project repairs
require the CLI's scoped safe-fix metadata and exact checkout evidence. Guide
links, manual commands and upgrades stay outside the queue.

The probes do not use `hack global status`, which can start Docker. The update
banner and Doctor's **Upgrade** row open the Upgrade pane for an available
release. The pane shows the target version and the CLI's install command for
copying, when available, alongside its readiness check.
If hackd is newer than the selected CLI, the banner and Doctor's hackd row
offer Run and Copy for the CLI update command, or installation guidance. This works
while release checks are offline.
The wrong-CLI banner accepts version and replacement evidence as inputs. Its
examples are fixtures until HACK-2597 supplies that evidence for live checks.
The fixtures `h17-app-banner-dns`, `h18-banners-sheet`, `h19-doctor`,
`h20-doctor-fix-all` and `h25-errors-sheet` render both themes.

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

## hackd and always-on

The **hackd** row in the sidebar's Machine group opens a pane with what hackd
and the CLI report (DESIGN.md sections 5 and 6, HACK-2288 item 6):

- **The hackd card** reads `hack daemon status --json` from the selected CLI
  in its checked context (when the pane opens, on Check again and after
  Start / Restart hackd), with the version from `/v1/status` while hackd
  runs. Each state has at most one action: **Start hackd** (off, stopped,
  stopped unexpectedly), **Restart hackd** only for a hackd older than the CLI
  (a newer one says to `hack update`), or **Open Setup** for a login service
  the CLI names a next step for (its program is gone, it drifted or is
  disabled; Setup checks before it installs). The status flags launchd reports
  as `null` (`enabled`) read as false rather than dropping the report. Start and
  Restart go through the same machine gate as Setup. A hackd whose API
  answers without a tracked PID is running. The daemon banner is not repeated
  on this pane.
- **Always on** summarises the documented `autostart` / `autostart_global`
  contract (docs/always-on-projects.md): how many projects are always on,
  paused, starting or need attention, the login run's progress, a global
  pause, a missing login-service file, and one line per always-on project
  (paused until you start it, starting at login, the last automatic start
  skipped or failed with its reason code, stopped trying after N failures,
  an invalid marker). An always-on project's header shows its line too.
  Read-only: the app runs no `hack autostart` command, and the switch in the
  header stays off-limits; change always-on with `hack autostart`.

Fixtures `hackd` and `hackd-off`; renders:
[running, light](screenshots/window/hackd-light.png),
[off with a stale login service, dark](screenshots/window/hackd-off-dark.png).
`scripts/hackd-drive/hackd.steps` drives the pane on the fixture
(`hack-desktop --fixtures hackd --drive scripts/hackd-drive/hackd.steps
--hidden`), and the env drive ends by reading it live through the stand-in
CLI and fake hackd.

## Upgrade

The **Upgrade** row in the Machine group opens the upgrade review flow
(HACK-2289), on `hack upgrade check | review | snapshot | rollback --json`,
each run by the selected CLI in its checked context:

- **Check** (read-only; when the pane opens and on Check again): the CLI's own
  verdict (`ready`: no blockers and nothing incomplete), each blocker and
  each check that could not run, and the plan with one row per step. **Run**
  opens the selected command in the shared terminal drawer and refreshes the
  plan on exit. **Copy** is available for running it in another terminal.
  Reports without structured arguments can still supply copy text.
- **Save snapshot** keeps a private copy of the files an upgrade changes,
  under the CLI's home, and says what it did not cover.
- **Review findings** (read-only) lists the findings that cannot be applied
  safely and why.
- **Restore** lists the CLI's snapshots, newest first. Restore… asks first;
  only a snapshot the CLI listed, at `…/upgrade/snapshots/<id>/manifest.json`,
  is restored, and never with `--overwrite`: a file changed since the
  snapshot (or since the apply step that recorded it) stays as it is, and
  whatever a restore replaces is kept in the snapshot. Its real use is
  undoing `hack upgrade apply`.

Snapshot and Restore go through the same machine gate as Setup and hackd.
The CLI reports refusals and a not-ready check as an `ok: true` envelope
with exit 1, so the app reads stdout whatever the exit code.

Fixtures `upgrade` and `upgrade-blocked`; renders:
[ready, light](screenshots/window/upgrade-light.png),
[blocked, dark](screenshots/window/upgrade-blocked-dark.png).
`scripts/upgrade-drive/run.sh <binary> [passes]` drives it against the real
CLI in a temp HOME, HACK_HOME and registered git project: the app saves a
snapshot; the harness runs `hack upgrade apply --only ignore-rules`; the app
restores apply's snapshot and `.hack/.gitignore` must come back byte for
byte; the harness edits it; a second restore must leave the edit.

## Resource use in the Services tab

The Services tab of a running Compose instance shows each service's CPU and
memory, an **emulated** pill on a service whose image runs under emulation,
and the instance total in the header (DESIGN.md section 10). Read-only:

- CPU and memory come from `hack usage --json --by-service --path <root>`,
  read every 5 seconds, one read at a time, only while that tab is shown in
  a visible window. Rows are matched by the instance's Compose project, so a
  branch instance shows its own. Memory has the limit in its tooltip when
  Docker reports one.
- The emulated flag comes from `hack ps --json --path <root> [--branch <name>]`,
  read again when the instance or its running services change, and every
  60 seconds (a recreated container keeps its name). Both reads run with the
  Compose backend whatever the app inherited, and values are shown only for
  the checkout and Compose project they were read for.
- A value the CLI did not report is a dash, never 0, and the tooltip says
  why: not running, not read yet, Docker reported no value, or the read
  failed (Docker not running, say). The total appears only when every
  running service has both values.
- A native instance shows a dash: the CLI does not report native usage yet
  (DESIGN.md R29).

Fixture `usage`; renders:
[light](screenshots/window/usage-light.png),
[dark](screenshots/window/usage-dark.png).
`scripts/usage-drive/run.sh <binary> [passes]` drives it live in a temp HOME
and HACK_HOME: a fake hackd lists one running project, a stand-in `hack`
answers `usage` and `ps` with canned JSON, the drive's `expect-usage` steps
check the rows, the marker and the total, and the harness checks the app ran
only read commands.

## What v0 does not do yet

The Activity tab, per-process CPU and memory for native projects, onboarding, changing always-on and
running an upgrade (`hack upgrade apply`, installing a new version) come in
later units. The design and the CLI/daemon requests they need
are in `DESIGN.md` (PR #800).

## Files tab

Choose a running Compose service to browse its working directory. Use the
parent row, open a directory, or type a path into **Go to file** and press
Enter. **Show hidden** includes dotfiles.

Worktree files open in the host's text editor. Container and named-volume
files have read-only previews. **Copy path** copies the path inside the
container. The app calls `hack files ls|cat --json` for the selected service
and branch instance and reads the `hack.files.v1` response.

On Linux, **Open in editor** uses the default `text/plain` handler through
`xdg-mime` and `gtk-launch`. Both tools are needed for this action.

Use `--fixtures files --screenshots <dir>` with the screenshots build to
render the Files tab in both themes.

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

## Env tab

Overlay tabs across the top show base and every overlay named in the modern
`hack env list --json` report. Choose a scope on the right. Each value starts
masked. Press the eye to read just that name through `hack env get <KEY>`.
The value hides after 60 seconds or when the overlay, scope, tab or project
changes, or the window loses focus. Copy a revealed value with the copy
button. The clipboard clears after 60 seconds or when the app quits, if it
still holds that value. A missing required name is
listed first with a `required · missing` chip. With the key missing, the line
says where the CLI looks and secrets cannot be revealed or copied.

On macOS the copied item is also marked concealed
(`org.nspasteboard.ConcealedType`), so clipboard managers that follow that
convention do not record it. Linux has no such convention: there the 60 s
clear (or the clear on quit) is the only protection.

**Edit** (the pencil on a row) and **+ Variable** open an editor: the name (new
variables only), the value, **Secret** (new variables only), and the exact
command Save runs, for example
`hack env add API_TOKEN --secret --value-stdin --env staging --service api`.
The value goes to the CLI on stdin, never in argv or the environment, and the
command names the overlay and scope explicitly. An existing row is written in
its own scope (a global variable shown in a service listing stays global) and
its own layer (a row from `hack.env[.<overlay>].local.yaml`, or a legacy
`.env` / `.env.<overlay>`, with `--local`, so a value kept out of the
repository never lands in the shared YAML); a
new one goes to the scope listed, in the shared file. An already revealed plaintext value can prefill the editor. Otherwise type a
new value to replace it. A secret starts with an empty masked field. A secret cannot be edited while
the key is missing, and a legacy variable limited to several services cannot
be edited in the app (one write cannot cover them): the editor says to use the
CLI per service or `hack env migrate`. Nor can a value held outside the env
files (`portable_backend`, a legacy project's mirror in its encrypted
backend, or `keychain` and `process`): Save would copy it into a YAML file
instead, so the editor names the layer and says to use the CLI. The editor closes on another overlay, scope, tab or
project. After Save the tab says "Saved NAME" and lists again.

What needs the CLI is shown, not hidden: **+ Overlay** (create an overlay,
R27), and, when the key is missing, **Choose key
file** and **Use env var** (choose the key source for a run, R26). Each is
inactive, and its tooltip names the request.

Values stay out of logs, `--drive` output and error messages. Offscreen render
fixtures use obviously fake values. A failed write shows the command and its exit code,
never the CLI's output (an echoed value could be trimmed, escaped or cut, so
no check on it is safe): run the command shown in a terminal to see why. A
write started before a CLI switch runs through the CLI chosen when Save was
pressed, and its result is not shown over the new CLI's listing.

Dependencies (macOS only, for the concealed clipboard; all three were already
in `Cargo.lock` through GPUI): `objc2 =0.6.5` (MIT), `objc2-app-kit =0.3.2`
(Zlib OR Apache-2.0 OR MIT), `objc2-foundation =0.3.2` (MIT).

Fixtures: `env-loading`, `env-error`, `env-normal`, `env-overlays`,
`env-running`, `env-missing`, `env-locked`, `env-long`, `env-edit`, `env-revealed`,
`env-empty`. Each
renders offscreen in both themes through `--screenshots`.
Screenshots: [overlays, running](screenshots/env-running-light.png),
[key missing](screenshots/env-locked-dark.png),
[required missing](screenshots/env-missing-light.png),
[long](screenshots/env-long-dark.png).

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

## Service details

Select a service from the sidebar or Services table to open its detail pane. The pane opens
on **Logs**. Use ⌘1–⌘5 on macOS or Ctrl+1–Ctrl+5 elsewhere to switch between
Info, Stats, Logs, Terminal and Files. Stats shows a placeholder.

- **Info** shows copyable route, health, image, mount, container name and
  startup information reported for the selected service. A Compose ownership
  label identifies Docker Compose. The daemon does not report who invoked
  Compose or the exact start command.
- **Logs** uses the selected copy’s Hack JSON stream. Switch to any service in
  that copy or show all services there. Search highlights matching rows. Use
  **Only matching lines** to hide the rest. The menu also controls wrap and
  JSON key highlighting and opens the same scope in the terminal drawer.
- **Terminal** docks the instance’s existing Ghostty drawer in the pane. It
  reselects a running shell in the chosen service or starts a new one after
  the last shell exits. The ended tab retains its scrollback. Terminal tabs
  stay open when you switch detail tabs, and the drawer keeps Ghostty’s
  configured appearance.
- **Files** opens the existing file browser on the selected service.
- **Restart** and **Stop** call Hack with the selected checkout, Compose
  project and service. Hack checks checkout ownership and stops containers by
  full ID. The project’s **Stop** still runs instance-wide `hack down`.

With the screenshots feature enabled, run `hack-desktop --service-screenshots
<dir>` to render the pane’s light and dark fixtures and exercise its tab
shortcuts through the app keymap. The dark window chrome and service pane
use the HTP design system's Merino Dark palette. The terminal captures include
the ended shell and the fresh session opened from it.
