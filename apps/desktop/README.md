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
Ruby and Node options and paths, and every `LD_*` and `DYLD_*` loader
variable), so a checked tool script cannot be made to load code from the
environment; missing candidates
require protected ancestry, and relative/unprovable selections are refused.
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

Logs and Activity tabs, CPU and memory, always-on, broader
daemon controls come in later units. The design and the CLI/daemon
requests they need are in `DESIGN.md` (PR #800).

## Setup

![Setup evidence flow](diagrams/setup-evidence.svg) ([source](diagrams/setup-evidence.mmd))

On launch, fresh background checks determine whether setup is needed. The app
supports Hack CLI 5.x; the CLI card cannot be skipped. Doctor offers **Run setup
again**. Every card offers **Check again**. Skips last for this app session, survive rechecks,
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
proves installation only; known disabled/drifted/failed service metadata stays
Needs attention. Missing service-manager availability never permits Install.

Start and Install pass the checked CLI as the CLI's self-invocation selector
(`HACK_MCP_COMMAND`), so the daemon they start or install runs that CLI, not
whatever `hack` is first on PATH. Only the fixed `daemon start` and supported `daemon install` actions offer **Run**, with
bounded, memory-only output followed by fresh checks. Install requires explicit
`service.available: true`, an ordinary home, and no launchd/systemd-disable guard;
otherwise the card explains why and links to documentation. Availability is checked
again immediately before install; an unavailable or unconfirmed manager is refused
before an install command is submitted. Admin cards offer **Copy
command** and **Open Terminal**. Both run later, outside the app, so the bound
command's PATH keeps only directories no other user can change (owner- or
root-owned, not group- or other-writable, with Doctor's ancestry and ACL rule;
`/usr/bin:/bin` when none remain). The private one-use `.command` script quotes every
argument, prints the command and waits for Enter. Afterward it shows the exit code
and waits for Enter to close, preserving output and the command’s exit code. macOS requests a new window
of the system Terminal through `open -g -a /System/Applications/Utilities/Terminal.app`
(by path, not by application name; the bundle and every directory above it must be
root-owned and not group- or other-writable, otherwise Copy only); Linux uses `xdg-terminal-exec` when available,
otherwise Copy. The adapter must pass the same ownership, write and `#!` rules
as the CLI before it runs. The script's temporary directory must not be changeable by
another user (owned by this user, or by root and sticky like `/tmp`, with the
same rule for every directory above it); otherwise the hand-off is refused. No existing pane is typed into and no password is requested by
the app. The script removes itself and its private directory after use or
cancellation; a terminal that never executes the script may leave that private
temp directory behind. Launching a terminal never proves a fix succeeded.
GPUI's window activation observer rechecks only when Setup is shown or an explicit
fix is pending;
visible setup also refreshes every ten minutes. Actual host focus and terminal
behavior still need macOS/Linux live qualification; tests use injected launchers.

Offline examples (no CLI, terminal or services):

```sh
cargo run -p hack-desktop -- --setup-fixture partial --theme dark
cargo run -p hack-desktop-core --bin hack-desktop-state -- --setup-fixture native-unknown
```

Other setup fixtures: `missing-cli`, `ready`, `service-unavailable`. `--screenshots` renders all five
in light and dark offscreen. Evidence: [light](screenshots/setup-light.png),
[dark](screenshots/setup-dark.png).

Reusable terminal API (`core::terminal`): `CommandSpec { program, args }` provides
`display()` with shell quoting; `Script::create(temp_root, &spec)` owns the private
script; `open(Platform, linux_adapter, &dyn Launcher)` transfers cleanup to the
script after launch. `Launcher::launch(program, args)` is the injected boundary;
`SystemLauncher` is used only on explicit live clicks. `linux_adapter()` discovers
an absolute `xdg-terminal-exec`. Build upgrade commands from authored argv, never
from arbitrary CLI finding text. `Report::command(args)` uses the checked absolute
CLI and its captured context. It never rediscovers PATH at click time.

The CLI setup card links to [v5 installation](../../docs/versions/v5/install.md),
not the stable v4 Homebrew command. A terminal shell function does not change the
app's executable. Select a prepared supported CLI explicitly when launching:

```sh
HACK_DESKTOP_CLI="$HOME/.hack-next/bin/hack-next" HACK_RUNTIME_BACKEND=compose hack-desktop
```

`HACK_DESKTOP_CLI` must be an absolute executable path. This selects the CLI for
checks, safe actions and terminal hand-offs; it does not install anything or
change PATH. Without it, the app finds `hack` on absolute PATH entries once and
pins that executable for every later read and action; only setup checks
(startup and **Check again**) search PATH again, so installing into an existing
PATH directory recovers through **Check again** without restarting. A `hack`
whose file or any directory above it is writable by group or others, or owned
by another user, is refused before it runs. An explicit `HACK_DESKTOP_CLI` selection gets the same
check before every use; a missing one is a missing CLI. A script CLI's `#!` interpreter must
pass the same rule with no arguments (`#!/usr/bin/env` is refused here because
the CLI uses the ordinary PATH). The app inherits PATH at launch; a changed PATH still needs a
relaunch. Follow the installation page's platform limits and existing-v4 migration
steps before using a candidate against a shared home.
On Linux, this preview requires a separately prepared source-built 5.x CLI; the
Apple Silicon prerelease download is not a Linux installer.

Execution context (`core::execution::ExecutionContext`) reads only the allowlisted
non-secret HOME, HACK_HOME, PATH, backend, launchd/systemd-disable guards,
daemon-autostart guard, optional XDG_RUNTIME_DIR and an absolute XDG_CONFIG_HOME
(which selects the systemd user unit; a relative one is ignored, as the CLI does). Docker
selectors are kept when supported (`DOCKER_CONTEXT` as a plain name, an absolute
`DOCKER_CONFIG`, and a `unix://` absolute, `tcp://` or `ssh://` `DOCKER_HOST`);
any other value refuses the checked context rather than silently addressing a
different Docker engine. Absolute `HACK_NATIVE_HOME`, `HACK_NATIVE_BINARY` and `HACK_GLOBAL_CONFIG_PATH` are kept
the same way (relative values refuse), so native reads and actions address one
runtime. An absent HACK_HOME stays
absent so a candidate launcher can keep its own private-home default. Context is
captured before version checking. `runner(checked_program)` pins that absolute
executable, clears the child environment and applies the context for all reads
and actions. `bind(&CommandSpec)` wraps authored argv in `/usr/bin/env -i` with
individually quoted assignments, so a macOS Terminal login environment cannot
select another home/backend or weaken a guard. Unknown keys, invalid paths,
control characters and unsupported backends are refused. Wrapper-specific or
credential environment is never forwarded; such integrations need an explicitly
supported context or a manual documented workflow. `CommandSpec` and the
single-command `Script::create` API remain compatible; a sequence consumer can
bind each authored spec before composing it. The launcher also clears its inherited environment, carrying only fixed non-secret
desktop routing metadata needed to open a terminal. Both the script and private directory
are 0700 because the launch adapter executes the script.

Machine effects share `HackApp::action_busy()` (including
`AppModel::has_in_flight()` for every project); project effects check
`machine_action_busy()`. New daemon/upgrade controls must extend that shared gate.
Checks clear an older action receipt; the immediate post-action check retains its
receipt once. A transient version timeout remains Unknown and does not force a
project pane back into setup as though the CLI were missing.

Remaining evidence limits: an installed unit without newer operational metadata
proves installation, not enabled/healthy service operation. Native DNS remains
Unknown without a checked browser URL. macOS custom/localhost suffixes without
matching Doctor resolver evidence remain Unknown, even if OS routing works;
setup does not infer trust or routing success from absence. These conservative
limits do not justify offering an unsupported in-app fix. Live macOS Terminal,
focus, trust and service effects still require host qualification.

The offscreen generator writes every `setup-<fixture>-<theme>.png` and also writes
`setup-light.png`/`setup-dark.png` aliases for the partial fixture used above.

Unavailable login-manager fixture (no Run offered):
[light](screenshots/setup-service-unavailable-light.png),
[dark](screenshots/setup-service-unavailable-dark.png).

Daemon socket discovery uses the selected CLI’s bounded, read-only bare
`daemon status --json` response. Its absolute `socket_path` is authoritative,
including candidate launchers with a private default home. Missing or invalid
paths leave daemon evidence unavailable; the app never falls back to a guessed
parent-home socket or a registry-writing project listing. Socket version and
project reads still have to succeed before project state is accepted.
Compose routing/trust observations and their fixed `global install`/`global trust`
remedies explicitly select Compose while retaining the checked executable and
home. Daemon remedies retain the original backend. Login-service installation
alone does not pass when available evidence says inactive, unloaded, or failed
launchd exit status; these states need attention even if hackd runs separately.

## Upgrade review (preview)

![Upgrade evidence flow](diagrams/upgrade.svg) ([source](diagrams/upgrade.mmd))

**Upgrade Hack** opens without probing for updates. **Review readiness** runs the
selected CLI's read-only `upgrade check --json` on a background worker, keeping
valid reports from exit 1. Only `report_version` 2 is read: every plan step must
carry its `count` and `targets`, and a step covers the machine (no targets), one
checkout (its name) or several (`projects`). A target must name a live checkout,
by name and root, with exactly one finding for that step; any other report stays
Unknown. Grouped cards list each checkout with its own instruction and, when it
has one, its own quoted command. The hackd version comes from the socket named in the
CLI's own read-only `daemon status --json` answer.

Every upgrade read and write (readiness, CLI version, daemon status, snapshot and
rollback) runs the CLI by its checked absolute path with the same non-secret
execution context as Setup (home, `HACK_HOME`, backend, service guards, the CLI's
`HACK_HOST_PROBES_DISABLE=1` hard deny when it is set, and Docker selectors;
nothing else from the app's environment) and Doctor's private tool
PATH: per-operation wrappers only for tools no other user can change, with
interpreter startup variables such as `BASH_ENV` removed. Like Doctor, every run
disables repository `core.fsmonitor` and hooks through command-line Git config,
because `upgrade check` reads Git in registered checkouts, and pins the native
runtime Doctor checked. Copied commands keep the host-probe hard deny too. They
run later, without the private wrapper PATH, so their PATH keeps only directories
no other user can change (owner- or root-owned, not group- or other-writable, with
the same ancestry and ACL rule as Doctor); with none left, it is `/usr/bin:/bin`. If that PATH cannot be
built, or a tool such as `docker` or `git` on PATH is in a location other users can
change, or PATH is too long to check fully, the operation is refused before the CLI
runs and the message names the tools. No `update --check` probe or daily check runs. The
CLI now has a read-only update check (R14), but this desktop adapter does not
consume it yet, so availability stays Unknown for every live install kind, including candidates and
Homebrew. Readiness is separate from update availability. Actual Upgrade stays
disabled until verified target and installation evidence exists; the current
live adapter never supplies that evidence. Doctor's
helper and Docker preflight also runs first, so a remote Docker endpoint (for
example `DOCKER_HOST=ssh://...`) refuses the operation as well.

**Save file snapshot** is an explicit CLI write, available after a complete ready
review. The app accepts a recovery point only for `status: created`, `complete:
true`, an empty `gaps` list and an absolute `manifest.json` path under the returned
snapshot id. Refused, malformed and incomplete receipts enable neither Upgrade
nor rollback. The app never opens the saved files or reads file values or keys.
The CLI remains responsible for private-manifest validation and file ownership.

With proposed R14 evidence, the fixture flow offers **Upgrade in Terminal** only
after a complete snapshot. The authored sequence is `brew upgrade hack` followed
by `brew upgrade --cask hack-desktop`, stopping on failure. The shared terminal
adapter quotes each argument, displays the sequence and waits for Enter. It never
runs finding `command` text. Plan argv may be displayed/copied only after quoting,
bound like Setup's commands to the reviewed CLI and context (`/usr/bin/env -i
HOME=… HACK_HOME=… <cli> …`), so a terminal run addresses the reviewed home,
backend and guards, plus `HACK_MCP_COMMAND` naming the reviewed CLI so a copied
daemon command restarts that CLI. A review without a checked context offers no copy;
R17 safe metadata and an authored allowlist are required before any plan fix can
be run in the app. Today those cards offer Copy and documentation only. No admin
action, password prompt, self update or relaunch happens in the app.

Terminal launch and window focus never confirm success. **Check again** requires
fresh CLI and Homebrew-installed app versions at the exact target, hackd matching
the CLI, and a live, fully readable ready report with no remaining plan. Every
previous step needs the same scope, checkout root and explicit `ok` finding;
a grouped step needs that for every checkout it covered, under the id of the
finding that put the checkout in the step (an `apply_fix` group may differ).
A disappeared step, missing scope, unreadable checkout or unchecked registry
entry stays Unknown. The snapshot plan entry is proven by its separate complete
receipt. A read adapter for `brew info --json=v2 --cask hack-desktop` uses the
installed version, never the catalog version; it stays unwired until the desktop adopts
R14's installation-ownership evidence. **Restart hackd** is explicit, shares the machine-action
gate with setup/recovery, and re-reads versions after the command. No poll starts
or restarts a service. Upgrade reads run only on demand, including while hidden;
there is no eager or background daily upgrade check.

**Restore files from snapshot** calls only `upgrade rollback --rollback-manifest
<exact snapshot path> --json`, without overwrite. Results list each path, status,
kept-as path and reason. Incomplete restores stay failed. A complete result says
**Files restored. Versions, containers and services were not changed.** Fresh
readiness is required again. All state and receipts stay in memory for this app
session. The desktop has no signing/cask distribution or production updater in
this unit (DESIGN sections 4 and 8).

Offline proposed-capability examples (no CLI, Homebrew or terminal effects):

```sh
cargo run -p hack-desktop -- --upgrade-fixture ready --theme dark
cargo run -p hack-desktop -- --upgrade-fixture availability-unknown
```

Fixture names: `availability-unknown`, `available`, `checking`, `blocked`, `ready`,
`snapshotting`, `incomplete`, `applying`, `unknown`, `restarting`, `done`, `failed`,
`rolling-back`, `restored`. `--screenshots` renders all fourteen in both themes
without a window. Evidence: [light](screenshots/upgrade-light.png),
[dark](screenshots/upgrade-dark.png). Core tests use only fake executables, isolated homes, disabled
autostart, injected launchers and pure evidence inputs. They do not qualify live
Homebrew, terminal, platform focus, a published app or a real upgrade.

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
are preserved. A clean-environment runner (setup's checked execution context)
passes that mode to the boundary explicitly, so its child starts from an empty
environment on macOS as on Linux. Linux retains the standard process
implementation. This product
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
