# Hack desktop app: design (v0)

Status: proposal (HACK-2214). Optional, unsupported until the lead says otherwise.
Not part of the default gates, the release workflow or onboarding docs.

One small native window that shows every Hack project, what it is doing and what
is wrong, and runs `hack` for you. It is a view over the CLI and `hackd`, not a
second implementation of them.

![Data flow](diagrams/data-flow.svg) ([source](diagrams/data-flow.mmd))

## Principles

| Rule | Consequence |
|---|---|
| The CLI is the only writer | Every action is one `hack <cmd> --no-interactive` run as the user with `--path <repo_root>`. Commands without `--json` are judged by exit code, then a fresh read. |
| Reads observe only | A poll never starts Docker, hackd, a VM or anything else. A command that can start something (today: `hack global status`) is not polled until it has an observe-only mode (R13). |
| No app state beyond window layout | Selected project, window size, sidebar width, theme override. Nothing else is stored. |
| No credentials, no passwords | No password field, no `sudo` from the app. Admin steps go to the user's terminal ([Onboarding](#2-first-run-onboarding)). |
| No env-value reads or reveals | Env shows names and layers only, never a reveal. Exception: logs are unredacted service output (which can include values Hack injected), shown as the CLI emits them, with a warning, never written to disk and with no copy-all (owner decision: the Logs tab is in scope). |
| Unknown is not absent | A failed or timed-out read shows "could not read" with the error, never "stopped" or "0 projects". |
| Small | Target under 4,000 lines of Rust for v0.1. The old `apps/macos` grew to 13,800 lines through an embedded terminal, command palette, editor and agent integrations, tickets and remote features. None of those come back. |

Toolkit: Rust, `gpui-kit = "=0.9.1"` (GPUI through `gpui-pre =0.3.12` from crates.io),
edition 2024, Rust 1.92+ (the repo pins 1.97.1). Its own Cargo workspace in
`apps/desktop/`: `core` (no GUI dependency) and `app`.

Existing contracts are marked as such; `hack upgrade …` is PR #790 (open),
`hack autostart …` (HACK-2213) and the post-upgrade daemon restart (HACK-2216)
are **proposed** contracts this design asks for.

## 1. Views and states

Window: sidebar (projects, then machine rows "Routing and DNS" and "Doctor"),
detail pane, status bar. Light and dark follow the system
(`Theme::sync_system_appearance` plus an appearance observer).

### Project list (sidebar)

| State | Trigger | Shown | Action |
|---|---|---|---|
| Loading | First read in flight | Three skeleton rows | none |
| Loaded | `projects[]` non-empty | Groups Running / Stopped; dot per row (green running, amber degraded, grey stopped, red failed or needs attention, grey "?" unknown); "always on" mark | Select row |
| Empty | Registry has no projects | "No projects yet" + `cd your-repo && hack init` | Copy command, open docs |
| Daemon not running | `/v1/status` unreachable | Unknown; last good list kept stale. Fallback needs R18: today's CLI listing writes the registry. Retry every 10 s. | Start hackd |
| Daemon other version | `/v1/status.version` ≠ CLI version | Unknown; fallback needs R18. Last good list kept stale. Retry every 10 s. | Restart hackd |
| Docker not reachable | `runtime_ok: false` (Docker observation only) | Compose rows keep names, dots "?"; native rows keep their own state from native `ps`; banner with `runtime_error` | Open Docker help |
| CLI missing or too old | `hack` not on PATH, or outside the supported range | Full-pane card instead of the list; status bar shows no engine/hackd state | Copy install command |
| Error | CLI exit ≠ 0 or bad JSON | Banner with `code` and `message`; last good list kept, marked stale with its age | Retry, copy error |

### Backends

| Backend | v0 | Source |
|---|---|---|
| Compose | Full detail | `/v1/projects` or `hack projects --json` (`runtime.services[].containers[]`) |
| Native (beta) | State pill and services from native `ps`; no actions and no log tail in the app (see below) | `HACK_RUNTIME_BACKEND=native hack ps --json --path <root>` (`data.status`) |

Project views read legacy inputs; a canonical native project comes back with
`input_diagnostic`. The app recognises that code and asks `hack ps` instead
rather than showing "Needs attention". Every command for a native project runs with
`HACK_RUNTIME_BACKEND=native`, which is how the CLI selects that backend today.
Native `up --json` already starts a detached owner and returns a JSON
result, but native `restart` (and authored `down`/`restart`) stay in the
foreground and refuse `--json`. v0 keeps native projects view-only as a scope
choice: the header shows the terminal commands instead (R2b below). Native finite logs are a one-service snapshot,
so the combined tail is replaced by a note until the Logs tab reads them per service. Docker's `runtime_ok` never changes a native row. Native `data.status` maps as:
`not_started` → Stopped, `pending` → Starting, `observed` → Running or Degraded
from `items[].state` and `items[].health` (`readiness` is not in ordinary `ps` output; until R2 an exited service with exit 0 is "exited (0), role unknown" and any other exit is down), `runtime_degraded` → Degraded, `runtime_not_running` and
`runtime_busy` and `owner_unconfirmed` → Unknown (with the status as reason),
`provider_pin_changed` → Needs attention.

### Project detail: header per state

Header: name, state pill (+ uptime when known), backend pill, URL, buttons,
"Always on" switch. Tabs: Services · Logs · Env · Activity.

![Project states](diagrams/project-state.svg) ([source](diagrams/project-state.mmd))

| State | Derived from (until R2 lands) | Pill | Buttons |
|---|---|---|---|
| Unknown | runtime unreadable, read failed, or an action timed out or was interrupted | grey "Status unknown" + reason | Start (disabled while engine down) |
| Stopped | no running container and no failed one | grey "Stopped" | Start |
| Starting | this app's `up` in flight, or native `pending` | blue "Starting…" | none (no cancel in v0) |
| Running | every defined service has a running container | green "Running · 2 hours" (from Docker status text) | Open, Restart, Stop |
| Running, some exited (0) | the rest run; some exited 0 and their completion role is unknown | green "Running · migrate exited (0)" with tooltip "completion role unknown" | Open, Restart, Stop |
| Degraded | some running; a service with a container that is down, exited ≠ 0, or `(unhealthy)`. A defined service with no container is not counted: it may be in an inactive Compose profile (expected services need R2) | amber "Degraded · worker down" | Open, Restart, Stop |
| Stopping | this app's `down` in flight | grey "Stopping…" | none |
| Failed start | last `up` reported `services.failed`, or nothing runs and a service exited ≠ 0 | red "Failed to start: api, worker" | Start (retry), Stop, logs filtered to those services |
| Needs attention | always-on gave up (R12b), `status: missing`, or an `input_diagnostic` that is not the native one | red "Needs attention" + one line why | the one fix |

Rules:
- One action per project at a time; all action buttons disable while it runs.
  Cancel is not offered in v0 (`hack up` has no cancel contract).
- A finished action re-reads at once. Success is what the next read observes,
  not the command's exit: `down` exiting 0 shows Stopping until a read shows it stopped.
- A failed Stop or Restart keeps the last observed state and adds "Last action
  failed: <code>: <message>" under the header.
- An action that times out or loses its process → Unknown until the next read.
- Exit codes and uptime come from Docker's status text (`Exited (1) …`, `Up 2 hours`);
  structured fields are request R2. Hack decides completion from a known role,
  not exit 0 alone; until R2 exposes that role, an exit-0 service is shown as
  "exited (0), completion role unknown": not down, and not claimed as fully running.
- External changes (a `hack up` in a terminal) show up on the next read.

### Services tab

| State | Shown |
|---|---|
| Running / degraded | Table: service, state (dot + Docker status text), CPU %, memory, route. Down services first. Short log tail (last 20 lines) below. |
| Stopped | `defined_services` with "not created"; no tail. |
| Usage unavailable | CPU and memory "—" with tooltip (needs R3). |
| Failed start | Failed rows red with exit code; tail filtered to them. |

### Logs tab

Source: `hack logs --json --path <root> --tail 500` (ndjson, follows by default).

| State / control | Behaviour |
|---|---|
| Follow (default) | Newest at bottom; auto-scroll while at the bottom. |
| Pause | Stops auto-scroll; keeps reading into a ring buffer bounded at 10,000 lines **and** 8 MB; "N new lines" chip. Scrolling up pauses. |
| Search | Filters the buffer in place (plain text, case-insensitive), with match count. |
| Service filter | One service at a time: restarts the stream as `hack logs <service>`. `--services` is Loki-only and native rejects it (and `--compose`), so the app never passes either. Multi-select needs R4. |
| Very long lines | Cut at 4 KB on screen with "… (+N KB)", click to expand; `entry.truncated` shown as "truncated by hack". |
| Secrets warning | Fixed note: "Logs are shown as your services print them. Hack does not hide secrets in logs." No copy-all; buffer never written to disk; "Open in terminal" offered. |
| Finished | `end` event on a `--no-follow` read: "End of log" (normal). |
| Follow ended | while following, an `end` event (`eof` from Compose, `closed` from Loki) and exit 0: "Log stream ended" + Reconnect. Not an error. |
| Stream error | `error` event or exit ≠ 0: banner with reason and Reconnect. Docker down: "Docker not reachable". |
| Closed by the app | tab change, project change or pause timeout: the app kills the stream; nothing is shown. |
| Stopped project | Last 200 lines (`--no-follow`), marked "project stopped". |

### Env tab (names only, never values)

Source: `hack env list --json --path <root>`.

| State | Shown |
|---|---|
| Normal | Table: name, layer (`layer` / `resolved_from`), scope, kind (`storage.kind`), set (`has_value` ✓/✗), required. |
| Missing required | Red rows from `missing_required`, first. |
| Locked | Env key missing or unreadable: lock icon, "Names are shown; values cannot be resolved", Copy `hack doctor`. Needs R10. |
| No env config | "This project has no env layers" + docs link. |

Editing is "later". Never a reveal button.

### Activity tab

Needs R5. Until then it shows only actions this app ran in this session (memory
only) with "Full history needs a newer hack".

| Row kind | Fields |
|---|---|
| Start / stop / restart | time, origin (`cli` / `app` / `autostart` / `agent`), duration, result |
| Failure | time, failed services, error code, link to logs at that time |
| Always-on | paused after manual stop, resumed, gave up after N tries |

### Status bar

Left: "3 running · 5 stopped". Middle: engine (ok / down / unknown), hackd (on /
off / version mismatch). Right: CLI version, "Update available" chip. With no
snapshot, only counts and nothing else.

## 2. First-run onboarding

Shown on first launch and from the Doctor row ("Run setup again"). One card per
check, in order. Every check is read-only; every card offers **Check again**.

![Onboarding](diagrams/onboarding.svg) ([source](diagrams/onboarding.mmd))

| Step | Read-only check | Fix | Admin | Skipped / unknown shows |
|---|---|---|---|---|
| CLI | `hack --version` (text; R1 for JSON) | `brew install hack-dance/tap/hack` (copy) | no | Cannot skip |
| Docker (Compose projects) | `runtime_ok` from `/v1/projects` or `hack projects --json` (Docker only) | open Docker Desktop / Docker docs | no | "Docker not reachable" on Compose projects only |
| Native runtime (native projects) | native `ps` `data.status` per native project (`runtime_not_running` etc.) | native setup doc (HACK-2193) | no | that native project shows Unknown; Compose projects unaffected |
| hackd | `hack daemon status --json` | `hack daemon start` | no | Status bar "hackd off"; slower refresh |
| Routing and DNS (Compose) | macOS: doctor `resolver:<tld>`, `dnsmasq.conf:<tld>`, `dnsmasq:53` and `coredns forwarding` (all must pass). Linux: doctor `linux dns route`. Never `hack global status` (can start Docker) | `hack global install` | **yes** | URLs greyed "DNS not set up"; "unknown" when a check is missing |
| Routing and DNS (native) | `hack doctor --browser-url <project URL>` → `native host dns` (absent without `--browser-url`) | none from the app: `hack global install` refuses native; link to the native setup doc (HACK-2193) | — | "unknown" |
| Certificate trust (Compose) | **Unknown** today: doctor `caddy local ca` checks the exported CA, not system or browser trust (R16) | `hack global trust` | **yes** | Lock icon on URLs: "browser may warn" |
| Certificate trust (native) | doctor `native root trust` | none from the app: `hack global trust` refuses native; doc link | — | "unknown" |
| Login service | `daemon status` `service.installed` | `hack daemon install` | no | Always-on switch disabled |

Skips are not stored: the next check finds the step still open and Doctor lists
it. Non-admin **Run** executes the command and shows its output, then re-checks.
Admin steps offer **Copy command** and **Open Terminal**; neither is assumed to
have succeeded until **Check again** (also run when the window regains focus).

![Admin hand-off](diagrams/admin-handoff.svg) ([source](diagrams/admin-handoff.mmd))

Terminal hand-off (recommended for both platforms; comparison in [Appendix A](#appendix-a-system-prompt-vs-terminal)):

| Platform | Open Terminal adapter | Otherwise |
|---|---|---|
| macOS | Terminal.app: a new window runs a one-time script from the app's private temp dir that prints the quoted command and waits for Enter before running it | Copy command |
| Linux | `xdg-terminal-exec` when present, same script | Copy command |

The script holds only the CLI's own command with each argument shell-quoted; it
is removed after use. The app never types into an existing terminal or pane.

## 3. Doctor

Source: `hack doctor --json --path <root>` per registered project, plus one run
outside any project for machine checks (until R7c), on open and every 10
minutes while visible. Today it gives `checks[{id,status,detail}]`.

| Card part | Content |
|---|---|
| Group | Area: Engine, Routing and DNS, Certificates, Daemon, Env and secrets, Project files, Native |
| Severity | `error` red, `warn` amber; `ok` collapsed into "12 checks passed" |
| Affected | "Machine" or the projects it applies to |
| One action | Run safe fix (R7b) · Open Terminal (admin) · Copy command · Open doc |

Machine findings are de-duplicated by check `id` and shown once; project
findings link from that project's header. Until R7a adds `area`, `scope` and
`fix`, `core` maps known `id`s to areas and shows unknown ones under "Other"
with only Copy and Open doc. No Run button appears without a `fix.kind: safe`.

## 4. Upgrades

![Upgrade](diagrams/upgrade.svg) ([source](diagrams/upgrade.mmd))

| State | Source | Shown | Action |
|---|---|---|---|
| Update available | R14 (read-only, any install kind). `hack update --check` rejects Homebrew installs and candidate launchers, so it is not used | Chip "Hack vX available" | Review |
| Checking | `hack upgrade check --json` (#790) | Spinner, then plan | none |
| Blocked | `ready: false`. `blockers[]` / `incomplete[]` are `{scope,id,summary}`; the command or action comes from the matching finding (`machine[]` or `projects[].findings[]` by scope + id) | One card per blocker | Copy / Open Terminal; Run only with R17's `kind: safe`; Re-check |
| Ready | `ready: true`, `plan[]` (`command` / `args` / `action`, `blocker`) | Ordered plan | Upgrade |
| Snapshotting | `hack upgrade snapshot --json` | Progress | none |
| Snapshot incomplete | `complete: false` or `gaps[]` | Gaps listed; Upgrade stays disabled | Re-check |
| Applying | Homebrew: `brew upgrade hack` **and** `brew upgrade --cask hack-desktop`, in a terminal, then plan steps | Each step ✓ only on fresh evidence: CLI = `hack --version` equals the target; app = the cask's installed version (`brew info --json=v2 --cask hack-desktop`) equals the target; a plan step = the same scope was checked successfully (a `live` project, not `unreadable`, not in `incomplete[]`) and its finding is now `ok`. A step that merely disappears, or whose scope is missing, unreadable or unchecked, stays Unknown. No evidence → that step stays Unknown (user confirmation or window focus is not evidence) | Check again |
| Restarting daemon | `hack daemon restart` (exists), then `/v1/status.version` == CLI version. Doing this automatically after upgrade is HACK-2216 (proposed) | "Restarting hackd…"; a mismatch after restart → Failed | none |
| Done | `ready: true` with an empty `plan[]`, CLI and app at the target, hackd version matches | "Hack vX is up to date" | none |
| Failed | a step exit ≠ 0, or versions still differ | Which step and its error; "Files were saved" only when a complete snapshot exists | Roll back (only with a complete snapshot), Copy error |
| Unknown | terminal step interrupted or not confirmed | "Could not confirm the upgrade" | Re-check |
| Rolling back | `hack upgrade rollback --rollback-manifest <path> --json` | Restored / not restored (`kept_as`, reasons) | none |
| Restored | files restored | "Files restored. Versions, containers and services were not changed." | Re-check |

The app does not update itself apart from Homebrew, and relaunches only after
the user confirms.

## 5. Daemon

Source: `hack daemon status --json` + `GET /v1/status` (version).
`start`, `restart`, `install` print no JSON today: the app uses the exit code and
then re-reads status (R15 would add `--json`).

| State | Detected by | Shown | One action |
|---|---|---|---|
| Not installed, not running | `running: false`, `service.installed: false` | "hackd off" | Start (`hack daemon start`); setup offers `hack daemon install` |
| Installed, stopped | `service.installed: true`, `running: false` | "hackd stopped (login service installed)" | Start |
| Running, other version | `/v1/status.version` ≠ CLI version | "hackd vX, CLI vY" amber | Restart (`hack daemon restart`) |
| Stale process files | `stale: true` (`stale_reason`: `pid_not_running` / `socket_only`) | "hackd stopped unexpectedly" | Start (cleans the stale files) |
| Stale unit | unit points at a missing or other binary (R8) | "Login service is out of date" + `service.next_step` | Repair (`hack daemon install`) |
| Starting / incompatible | `status` | as given, with `issue` | Wait / Restart |
| Running | ok | green dot only | none |

The app never kills a daemon process or edits a unit itself.

## 6. Always-on (HACK-2213, proposed contract)

![Always-on](diagrams/always-on.svg) ([source](diagrams/always-on.mmd))

| State | Shown on the project | Action |
|---|---|---|
| Off | Switch off | Switch on → `hack autostart add --project <name>` |
| On | Switch on, "always on" mark in sidebar | Switch off → `hack autostart remove --project <name>` |
| Paused until you start it | after a manual Stop: label "Paused until you start it" | Start (resumes); Switch off |
| Needs attention | after `max_failures` failed starts: "Always-on stopped trying after 3 failures" + failed services | Retry (`hack autostart resume --project`), Logs, Switch off |
| Globally paused | Banner "Always-on paused for all projects" | Resume all (`hack autostart resume`) |
| At login | while `login_run.in_progress`: "Starting 2 of 4…", pending rows Starting | none; failures become Needs attention |
| No login service | Switch disabled: "needs `hack daemon install`" | Install login service |
| Command failed | any `autostart` command exit ≠ 0 | Switch returns to its previous position; error under the header | Retry |

Fields and commands needed from the CLI side:

| Where | Field / command |
|---|---|
| per project in `hack projects --json` / `/v1/projects` | `autostart.enabled`, `autostart.state: "off" \| "on" \| "paused" \| "starting" \| "needs_attention"`, `autostart.paused_reason: "manual_stop" \| null`, `autostart.failures.{count,last_at,failed_services[],last_error_code}`, `autostart.max_failures` |
| global, same payload | `autostart_global.paused`, `autostart_global.login_run.{in_progress,started_at,pending[],started[],failed[]}`, `autostart_global.service_ready` |
| commands (`--json --no-interactive`) | `hack autostart add\|remove --project <name>`, `hack autostart list --json`, `hack autostart pause [--project <name>]`, `hack autostart resume [--project <name>]` (resume clears the failure count) |
| behaviour | `hack down` on an always-on project sets `paused/manual_stop`; `hack up` clears it. The app relies on that, not its own bookkeeping. |

## 7. Data contract

Polling stops while the window is hidden. Every CLI call has a timeout and is
stopped on expiry: SIGTERM to its process group (the CLI forwards it to the subprocesses it owns), then SIGKILL after 15 s; a timeout makes the screen Unknown.

Exit codes: a valid JSON payload is parsed even when the exit code is not 0,
because the unhealthy states live there.

| Read | Output | Non-zero exit means |
|---|---|---|
| `hack doctor --json` | envelope `{ok:true,data}` | exit 1 = some check is `error` (still a report) |
| `hack env list --json` | bare object | exit 1 = a required key is missing (still a report) |
| `hack upgrade check --json` (#790) | envelope `{ok:true,data:report}` | exit 1 = not `ready` (still a report) |
| `hack up\|down\|restart\|open --json`, native `ps --json` | envelope; `{ok:false,error}` on failure | failure, with `error.code` |
| `hack daemon status --json`, `hack usage --json` | bare object | exit 1 = unhealthy (daemon not running, usage unavailable): still a report, rendered as that state |
| `hack projects --json` | bare object | failure (no report) |
| `hack logs --json` | ndjson events | see Logs |

| Screen | Reads | How often | Timeout |
|---|---|---|---|
| Sidebar, header | `GET /v1/projects` if `/v1/status.version` matches the CLI; otherwise Unknown until R18 provides observe-only CLI listing. Native rows add `HACK_RUNTIME_BACKEND=native hack ps --json --path` | 2 s with hackd, 10 s without; and after every action | 3 s / 15 s |
| Services CPU/memory | `hack usage --json --details` (until R3) | 5 s while visible | 10 s |
| Logs | `hack logs --json --path <root> [<service>] --tail 500` (one long-running child) | stream | killed on tab change |
| Env | `hack env list --json --path <root>` | on tab open, after env actions | 10 s |
| Activity | `hack activity --json --project <name> --limit 100` (R5b) | on open, 10 s while open | 10 s |
| Doctor, onboarding | `hack doctor --json` (per project and once outside), `hack daemon status --json` | on open; every 10 min | 60 s |
| Daemon | `GET /v1/status` | 10 s | 1 s |
| Upgrades | R14 daily; `hack upgrade check --json` on Review | daily / on demand | 30 s / 60 s |
| Actions | `hack up -d --json`, `down --json`, `restart --json`, `open --json`, `daemon start\|restart\|install` (exit code), `autostart …` | on click | `up`/`down`/`restart`: none; the app waits for the CLI, which owns their timeouts (after 6 h it only shows a warning), 2 min others |

The 24 numbered requests (R1–R18) this design needs from the CLI and daemon are in
[Appendix C](#appendix-c-requests-to-the-cli-and-daemon).

## 8. Scope

| Version | Contains |
|---|---|
| v0 | Window, sidebar, detail header, Services table, log tail, status bar, light/dark; Start, Stop, Restart, Open, follow logs; `--fixtures <state>`. Compose detail; native row state only. |
| v0.1 | Logs tab, Doctor view, onboarding, Env tab (names), always-on and daemon states, upgrade flow; Homebrew cask; Linux tarball. |
| Later | Menu bar popover (open/start/stop, "Pause always-on"); activity charts; env editing through `hack env set`; branch instances; resource graphs. |
| Never | Edit Compose files or Hack config; show, copy or export Hack's secret values; install, start or manage Docker itself; ask for or store a password; an embedded terminal, editor or agent; remote/gateway/tickets; its own database. |

Menu bar: gpui-kit 0.9.1 and GPUI have no tray or status item API (only the app
menu, dock menu and in-window menus). The popover needs a separate crate such as
`tray-icon`, not yet checked against GPUI's event loop; hence "later".

## 9. Distribution

| Item | Plan |
|---|---|
| macOS | Cask `hack-desktop` in `hack-dance/homebrew-tap` beside `Formula/hack.rb`, `depends_on formula: "hack"`. Opt-in: the formula mentions it in caveats; the CLI install never pulls it. Upgrading needs both `brew upgrade hack` and `brew upgrade --cask hack-desktop`; they are not atomic. |
| Signing | Developer ID Application certificate, hardened runtime, no App Sandbox (the app runs `hack` and reads the hackd socket); notarize with `notarytool submit --wait`, then `stapler staple`. Keys live only in the owner's password manager and CI secrets; nothing is set up here. Steps: [Appendix B](#appendix-b-release-steps). |
| Auto-update | None. Homebrew owns updates; the app only shows "update available". gpui-kit ships no updater. |
| Linux | v0.1: tarball (binary, `.desktop`, icon, `install.sh` into `~/.local`). No Flatpak/Snap: their sandboxes block running `hack` and reading the socket. |
| Minimums | macOS 15+. Linux: Wayland or X11 with Vulkan (software Vulkan works), Ubuntu 24.04-era glibc or newer. Windows: not planned. |
| Version match | The app declares a supported CLI range; outside it, only the "update Hack" card shows. |

## Open questions for the lead

1. Cask name `hack-desktop`, opt-in only (recommended), or offered by `hack setup`?
2. Who runs always-on at login: hackd at service start (recommended, R12c) or a separate unit?
3. Terminal hand-off for v0 admin steps on macOS (recommended), or is the system prompt required?
4. Logs in the app with a warning (as briefed), or terminal-only logs?

## Appendix A: system prompt vs terminal

| | System prompt (macOS `do shell script … with administrator privileges`, Linux `pkexec`) | Terminal hand-off |
|---|---|---|
| What runs as root | A command the app built | The CLI's own command; the CLI calls `sudo` only where needed |
| Mixed user/root steps | Breaks: `hack global trust` as root writes root-owned files into the user's Hack home | Works: the CLI already splits user and root steps |
| User can read what runs | Only what the app shows | Yes, in the terminal before Enter |
| Linux availability | `pkexec` needs a running polkit agent; varies by desktop | Any terminal with an adapter, else Copy |
| Polish | Native dialog, Touch ID | One extra window |

A macOS system prompt could come later for single root-only lines from R11, never for whole `hack` commands.

## Appendix B: release steps

1. Build a universal `.app` (`aarch64` + `x86_64`) with `Info.plist` (`dance.hack.desktop`, minimum 15.0).
2. `codesign --options runtime --timestamp` with the Developer ID Application identity from CI secrets.
3. Zip a submission copy, `xcrun notarytool submit --wait` with the notary API key from CI secrets.
4. `xcrun stapler staple` the `.app`, `stapler validate`, then create the **distribution** zip from the stapled app.
5. Upload that zip; compute the cask `sha256` from it and update the cask in the tap (as the formula job does today).
6. A separate, manual workflow does this until the lead folds it into the release.

## Appendix C: requests to the CLI and daemon

Each is small enough for one PR.

1. **R1** `hack version --json`: `{version, channel, install_kind, binary_path}`.
2. **R2** Backend-aware project state in `/v1/projects` and `hack projects --json` (full and summary rows): `backend`, `state` (`running | degraded | starting | stopping | stopped | failed | unknown`), `started_at`, and per service `{state, ready, completed, health, exit_code, started_at}`; native projects included.
3. **R2b** Native lifecycle the app can drive: a `--json` contract for native `restart` and authored `down`/`restart`, and qualification of the existing detached `up --json` for app use.
4. **R3** Per-service usage: `hack usage --json --path <root> --by-service` with `cpuPercent`, `memUsedBytes`.
5. **R4** Logs: document the `--json` ndjson as stable; `--services a,b` honoured by every backend; `--max-line-bytes <n>` setting `entry.truncated`.
6. **R5a** Activity writer: append-only `activity.jsonl` in the Hack home, one line per `up`/`down`/`restart`/autostart (`ts, project, branch, action, origin, outcome, failed_services, duration_ms`), `O_APPEND` writes under one line size limit, rotation at a size cap, `origin` from `HACK_ORIGIN` (the app sets `app`).
7. **R5b** Activity reader: `hack activity --json [--project] [--limit]`.
8. **R6** Action progress: `hack up|down|restart --json --progress` emitting ndjson `{type:"progress", service, phase}` before the final envelope.
9. **R7a** Doctor metadata (a new doctor schema): per check `area`, `scope: machine | project`, `fix: {kind: safe | admin | manual, args[], doc_url}`.
10. **R7b** One fix without prompts: `hack doctor --fix --only <id> --yes --json`, only for `kind: safe`.
11. **R7c** Machine-only doctor: `hack doctor --machine --json` (no project), so the app does not need to de-duplicate.
12. **R8** Daemon unit staleness: `service.unit_stale` and reason in `hack daemon status --json`, and `version` there.
13. **R9** (optional) Push updates: `GET /v1/projects?wait=<generated_at>` long-poll.
14. **R10** Env key state: `key_state: ok | missing | unreadable` in `hack env list --json` (no values).
15. **R11** Admin argv plan: `hack global install|trust --plan --json` listing the root-only argv lines.
16. **R12a** Always-on persistence and `hack autostart add|remove|list|pause|resume` ([section 6](#6-always-on-hack-2213-proposed-contract)).
17. **R12b** Always-on fields in project payloads and `autostart_global`.
18. **R12c** Login run: hackd starts always-on projects at service start, retries up to `max_failures`, and honours pause.
19. **R13** Observe-only `hack global status --json --observe` that never starts Docker; reports `host_dns_ok` on both platforms.
20. **R14** Read-only update check for any install kind: `hack update --check --json --observe` → `{current, latest, available, install_kind, upgrade_command}`.
21. **R15** `--json` for `hack daemon start|stop|restart|install`.
22. **R16** Trust status: a doctor check that reports whether the system trust store (and NSS on Linux) trusts the local CA, or `unknown`.
23. **R17 — exists** `kind: safe | admin | manual` on upgrade report findings and plan steps (additive version-2 fields), independent of severity. Only explicitly allowed diagnostic/snapshot commands and fully eligible guarded apply groups are safe; host routing/login-service changes are admin; decisions and unknown actions are manual. The supplied per-checkout command can remain manual while its guarded grouped apply step is safe. Consumers must treat absent or unrecognized kinds as manual and still require an executable command before offering Run. App adoption is separate.
24. **R18** Observe-only project listing, including registered native projects: no auto-registration, `lastSeenAt` updates or registry writes. Until it exists, the desktop refuses CLI listing fallback and reports Unknown when a matching hackd snapshot is unavailable. The daemon-off screen names `hack daemon start` and offers Start hackd as its first recovery action.
