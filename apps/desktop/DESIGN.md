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
| The CLI is the only writer | Every action is `hack <cmd> --json --no-interactive` run as the user, with `--path <repo_root>` or `--project <name>`. |
| No app state beyond window layout | Selected project, window size, sidebar width, theme override. Nothing else is stored. |
| No credentials, no passwords | The app never shows a password field and never runs `sudo`. Admin steps go to a terminal (see [Onboarding](#2-first-run-onboarding)). |
| No secret values | Env shows names and layers only. Log lines are shown as the CLI emits them, with a warning (see [Logs](#logs-tab)). |
| Unknown is not absent | A failed or timed-out read shows "could not read" with the error, never "stopped" or "0 projects". |
| Small | Target under 4,000 lines of Rust for v0.1. The old `apps/macos` grew to 13,800 lines through an embedded terminal, command palette, editor and agent integrations, tickets and remote features. None of those come back. |

Toolkit: Rust, `gpui-kit = "=0.9.1"` (GPUI through `gpui-pre =0.3.12` from crates.io),
edition 2024, Rust 1.92+ (the repo pins 1.97.1). Its own Cargo workspace in
`apps/desktop/`: `core` (no GUI dependency) and `app`.

## 1. Views and states

Window: sidebar (projects, then machine rows "Routing and DNS" and "Doctor"),
detail pane, status bar. Light and dark follow the system
(`Theme::sync_system_appearance` plus an appearance observer).

### Project list (sidebar)

| State | Trigger | Shown | Action |
|---|---|---|---|
| Loading | First read in flight (< 2 s) | Three skeleton rows | none |
| Loaded | `projects[]` non-empty | Groups Running / Stopped; dot per row (green running, amber degraded, grey stopped, red failed or needs attention); pin icon when always-on | Select row |
| Empty | Registry has no projects | "No projects yet" + `cd your-repo && hack init` (copy) | Copy command, open docs |
| Daemon not running | `/v1/status` unreachable | List still loads through the CLI fallback; thin banner "hackd is off: status refreshes slowly" | Start hackd |
| Daemon other version | `/v1/status.version` ≠ CLI version | Same fallback; banner "hackd vX, CLI vY" | Restart hackd |
| Engine not running | `runtime_ok: false` | Rows keep last known names, dots grey with "?"; banner with `runtime_error` | Open engine help |
| CLI missing or too old | `hack` not on PATH, or below the supported range | Full-pane card instead of the list | Copy install command |
| Error | CLI exit ≠ 0 or bad JSON | Banner with error `code` and `message`; last good list kept and marked stale with its age | Retry, copy error |

Machine rows: "Routing and DNS" (dot from `hack global status --json`
`summary.ok`), "Doctor" (badge = count of `warn` + `error`, red if any `error`).

### Project detail: header per state

Header: name, state pill (+ uptime), backend pill (`compose` / `native`), URL,
buttons, "Always on" switch. Tabs: Services · Logs · Env · Activity.

![Project states](diagrams/project-state.svg) ([source](diagrams/project-state.mmd))

| State | Derived from (until request R2 lands) | Pill | Buttons |
|---|---|---|---|
| Stopped | `status: stopped` | grey "Stopped" | **Start**, Open (disabled) |
| Starting | app's own `up` in flight, or native `phase: pending` | blue spinner "Starting…" + service progress when R6 exists | Stop (cancels) |
| Running | all `defined_services` have a running container | green "Running · 2h 14m" | Open, Restart, Stop |
| Degraded | some running, some defined service not running or unhealthy | amber "Degraded · api down" | Open, Restart, Stop |
| Stopping | app's own `down` in flight | grey spinner "Stopping…" | none |
| Failed start | last `up` envelope has `services.failed`, or a container exited ≠ 0 after start | red "Failed to start: api, worker" | Retry, Logs (filtered to failed services), Stop |
| Needs attention | always-on gave up (R12), `status: missing`, or `input_diagnostic` present | red outline "Needs attention" + one line why | the one fix (Retry / Open folder / Run doctor) |
| Unknown | runtime unreadable | grey "?" "Status unknown" + error | Retry |

Actions run one at a time per project; buttons disable while one runs. A finished
action re-reads the project at once instead of waiting for the next poll.

### Services tab

| State | Shown |
|---|---|
| Running / degraded | Table: service, state (dot + text), CPU %, memory, route (host link). Down services sort first. Short log tail (last 20 lines, all services) below. |
| Stopped | Table of `defined_services` with "—" for CPU and memory; no tail. |
| Usage unavailable | CPU and memory show "—" with a tooltip ("usage needs R3"). |
| Failed start | Failed rows red with exit code; tail is filtered to those services. |

### Logs tab

Source: `hack logs --json --path <root> [--services a,b] --tail 500` (ndjson, follow by default).

| State / control | Behaviour |
|---|---|
| Follow (default) | Newest at bottom; auto-scroll while at the bottom. |
| Pause | Stops auto-scroll; keeps reading into a 10,000-line ring buffer; shows "N new lines" chip. Scrolling up pauses. |
| Search | Filters the buffer in place (plain text, case-insensitive); shows match count. |
| Service filter | Chips per service; changing it restarts the stream with `--services`. |
| Very long lines | Cut at 4 KB on screen with "… (+N KB)"; click to expand; `entry.truncated` shown as "truncated by hack". |
| Secrets warning | Fixed one-line note: "Logs are shown as your services print them. Hack does not hide secrets in logs." No copy-all button in v0. |
| Stream ended / error | `end` or `error` event: banner with reason and Reconnect. Engine down: "Engine not running". |
| Stopped project | Last 200 lines (`--no-follow`), marked "project stopped". |

### Env tab (names only, never values)

Source: `hack env list --json --path <root>`.

| State | Shown |
|---|---|
| Normal | Table: name, layer (`layer` / `resolved_from`), scope, kind (secret or plain from `storage.kind`), set (`has_value` ✓/✗), required. |
| Missing required | Red rows from `missing_required`, top of table. |
| Locked | Key missing or unreadable: lock icon, "Env key not available: names are shown, values cannot be resolved", one action (copy `hack doctor` command). Needs R10 to detect reliably. |
| No env config | "This project has no env layers" + docs link. |

Editing is out of scope until "later". Never a "reveal" button.

### Activity tab

Needs R5. Until then the tab shows only actions this app ran in this session (kept
in memory, gone on quit) with the note "Full history needs a newer hack".

| Row kind | Fields |
|---|---|
| Start / stop / restart | time, who (`cli` / `app` / `autostart` / `agent`), duration, result |
| Failure | time, failed services, error code, link to logs at that time |
| Always-on | paused after manual stop, resumed, gave up after N tries |

### Status bar

Left: "3 running · 5 stopped". Middle: engine state (Docker or native, ok/down),
hackd (on / off / version mismatch). Right: CLI version, "Update available" chip.

## 2. First-run onboarding

Shown on first launch and from the Doctor row ("Run setup again"). One check per
step, in order; each step is a card with status, why it matters, exact command.

![Onboarding](diagrams/onboarding.svg) ([source](diagrams/onboarding.mmd))

| Step | Check (read-only) | Fix command | Admin | Skipped shows |
|---|---|---|---|---|
| CLI | `hack version --json` (R1) | `brew install hack-dance/tap/hack` | no (app only copies it) | Cannot skip: nothing works without it |
| Engine | `runtime_ok` from `/v1/projects` or `hack projects --json` | open Docker Desktop / docs; native: `hack native setup` style command (HACK-2193) | no | Banner on every project: "Engine not running" |
| hackd | `hack daemon status --json` | `hack daemon start` | no | Status bar "hackd off"; slower refresh |
| Routing and DNS | `hack global status --json` `summary.host_dns_ok`, `caddy_ok` | `hack global install` | **yes** (resolver files, dnsmasq or `resolvectl`) | URLs shown greyed with "DNS not set up"; Open uses `localhost` ports if known |
| Certificate trust | doctor check `caddy local ca` | `hack global trust` | **yes** (System keychain / system trust store) | Lock icon on URLs: "browser will warn" |
| Login service | `daemon status` `service.installed` | `hack daemon install` | no | Always-on switch disabled: "needs the login service" |

Every step: **Run** (non-admin, the app runs the command and streams its output),
**Open in Terminal** (admin), **Copy command**, **Skip**, **Check again**. Skips
are not remembered as decisions: the next check simply finds the step still open
and Doctor lists it. There is no hidden "don't ask again" state.

### Admin steps: system prompt vs terminal hand-off

![Admin hand-off](diagrams/admin-handoff.svg) ([source](diagrams/admin-handoff.mmd))

| | System prompt (macOS `do shell script … with administrator privileges`, Linux `pkexec`) | Terminal hand-off |
|---|---|---|
| What runs as root | A command the app built | The CLI's own command; the CLI calls `sudo` only where it needs it |
| Mixed user/root steps | Breaks: running `hack global trust` as root writes root-owned files into the user's Hack home | Works: the CLI already splits user and root steps |
| User can read what runs | Only what the app shows | Yes, typed in the terminal before Enter |
| Linux availability | `pkexec` needs a running polkit agent; varies by desktop | Any terminal (`xdg-terminal-exec`, `$TERMINAL`, fallbacks) |
| Polish | Native dialog, Touch ID | One extra window |

Recommendation: **terminal hand-off on both platforms for v0.** The app writes
nothing executable: it opens the terminal with the command typed and waiting for
Enter, then re-runs the check when the terminal process exits (or on "Check
again"). macOS system prompt can come later, only for single root-only commands
the CLI exposes as an argv plan (R11), never for whole `hack` commands.

## 3. Doctor

Source: `hack doctor --json` (today: `checks[{id,status,detail}]`), on open of the
Doctor row and every 10 minutes while the window is visible.

| Card part | Content |
|---|---|
| Group | Area: Engine, Routing and DNS, Certificates, Daemon, Env and secrets, Project files, Native |
| Severity | `error` red, `warn` amber; `ok` collapsed into "12 checks passed" |
| Affected | "Machine" or the project names it applies to |
| One action | Run safe fix (non-admin, `hack doctor --fix --only <id>`, R7) · Open in Terminal (admin) · Copy command · Open doc |

Machine-wide findings appear once under their area, never repeated on each
project. A project's own findings show as a "Needs attention" line in its header
that links to the Doctor card. Until R7 adds `area`, `scope` and `fix`, the app maps
known check `id`s to areas with a small table in `core` and shows unknown ids under
"Other" with only Copy and Open doc.

## 4. Upgrades

![Upgrade](diagrams/upgrade.svg) ([source](diagrams/upgrade.mmd))

| State | Source | Shown | Action |
|---|---|---|---|
| Up to date | `hack update --check --json` `updateAvailable: false` (daily) | nothing | none |
| Available | `updateAvailable: true`, `latest` | Status bar chip "Hack vX available" | Review |
| Checking | `hack upgrade check --json` (#790, read-only) | Spinner, then plan | none |
| Blocked | `ready: false`, `blockers[]` | One card per blocker with its `command` or `next_action` | Run / Copy, Re-check |
| Incomplete | `incomplete[]` | "Could not check: …" cards; treated like Blocked | Re-check |
| Ready | `ready: true`, `plan[]` | Ordered plan list (machine steps, then projects) | Upgrade |
| Snapshotting | `hack upgrade snapshot --json` | Progress; manifest path kept for rollback | none |
| Applying | Homebrew install: Terminal `brew upgrade hack` (formula and cask); then plan steps | Step list with ✓/✗ | none |
| Restarting daemon | `hack daemon restart` (HACK-2216), then `/v1/status.version` == CLI version | "Restarting hackd…" | none |
| Failed | any step exit ≠ 0, or versions still differ | Which step, its error, and "Your files were saved at snapshot …" | Roll back, Copy error |
| Rolling back | `hack upgrade rollback --rollback-manifest <path> --json` | Restored / could not restore list (`keptAs`, reasons) | none |

The app never upgrades itself separately: the cask and formula move together, and
the app restarts itself only after the user confirms ("Relaunch to finish").

## 5. Daemon

Source: `hack daemon status --json` + `GET /v1/status` (version).

| State | Detected by | Shown | One action |
|---|---|---|---|
| Not installed, not running | `running: false`, `service.installed: false` | Status bar "hackd off" | Start (`hack daemon start`); setup offers `hack daemon install` |
| Installed, stopped | `service.installed: true`, `running: false` | "hackd stopped (login service installed)" | Start (`hack daemon start`, goes through the service manager) |
| Running, other version | `/v1/status.version` ≠ `hack version` | "hackd vX, CLI vY" amber | Restart (`hack daemon restart`, HACK-2216) |
| Stale | `stale: true` (`stale_reason`), or unit points at a missing or other binary (R8) | "hackd unit is stale" + `next_step` | Repair (`hack daemon install`), else Copy `next_step` |
| Incompatible / starting | `status` | as given, with `issue` | Wait / Restart |
| Running | ok | green dot only | none |

The app never kills a daemon process or edits a unit itself.

## 6. Always-on (HACK-2213)

![Always-on](diagrams/always-on.svg) ([source](diagrams/always-on.mmd))

| State | Shown on the project | Action |
|---|---|---|
| Off | Switch off | Switch on → `hack autostart add --project <name>` |
| On | Switch on, pin in sidebar | Switch off → `hack autostart remove --project <name>` |
| Paused until you start it | After a manual Stop: switch on, label "Paused until you start it" | Start (resumes) |
| Needs attention | After N failed starts: red label "Always-on stopped trying after 3 failures" + failed services | Retry (`hack autostart resume --project`), Logs, Turn off |
| Globally paused | Banner "Always-on paused for all projects" + menu item | Resume all (`hack autostart resume`) |
| At login | While the login run is in progress: sidebar header "Starting 2 of 4…", each pending row in Starting | none; failures become Needs attention |
| No login service | Switch disabled, tooltip "needs `hack daemon install`" | Install login service |

Fields and commands the app needs from the CLI side (design contract for HACK-2213):

| Where | Field / command |
|---|---|
| per project in `hack status --json` / `/v1/projects` | `autostart.enabled: bool`, `autostart.state: "off" \| "on" \| "paused" \| "starting" \| "needs_attention"`, `autostart.paused_reason: "manual_stop" \| null`, `autostart.failures.count`, `autostart.failures.last_at`, `autostart.failures.failed_services[]`, `autostart.failures.last_error_code`, `autostart.max_failures` |
| global in the same payload | `autostart_global.paused: bool`, `autostart_global.login_run: { in_progress, started_at, pending[], started[], failed[] }`, `autostart_global.service_ready: bool` |
| commands (all `--json --no-interactive`) | `hack autostart add\|remove --project <name>`, `hack autostart list --json`, `hack autostart pause [--project <name>]`, `hack autostart resume [--project <name>]` (resume also clears the failure count) |
| behaviour | `hack down` on an always-on project sets `paused/manual_stop`; `hack up` clears it. The app relies on that, not on its own bookkeeping. |

## 7. Data contract

Polling stops when the window is hidden (menu bar popover later polls only while
open). Every CLI call has a timeout and is killed with its process group on expiry.

| Screen | Reads | How often | Timeout |
|---|---|---|---|
| Sidebar, header | `GET /v1/projects?summary=1` if `/v1/status.version` matches, else `hack projects --json --summary` | 2 s with hackd, 10 s without; and after every action | 3 s / 15 s |
| Detail (selected) | `GET /v1/projects?filter=<name>` (else `hack projects --json`), plus `hack ps --json --path` for native | 2 s while selected | 3 s / 15 s |
| Services CPU/memory | `hack usage --json --details` (until R3) | 5 s while Services is visible | 10 s |
| Logs | `hack logs --json --path <root> --tail 500` (one long-running child) | stream | none; killed on tab change |
| Env | `hack env list --json --path <root>` | on tab open, after env actions | 10 s |
| Activity | `hack activity --json --project <name> --limit 100` (R5) | on tab open, 10 s while open | 10 s |
| Doctor, onboarding | `hack doctor --json`, `hack global status --json`, `hack daemon status --json` | on open; every 10 min | 60 s |
| Daemon | `GET /v1/status` | every 10 s | 1 s |
| Upgrades | `hack update --check --json` daily; `hack upgrade check --json` on Review | daily / on demand | 30 s / 60 s |
| Actions | `hack up -d`, `down`, `restart`, `open --json`, `daemon start\|restart\|install`, `autostart …` | on click | 10 min for `up`, 2 min others |

### Requests to the CLI and daemon (one PR each, for other sessions)

1. **R1 `hack version --json`**: `{version, channel, install_kind, binary_path}`, so the app can check the supported range and say how to upgrade.
2. **R2 project `state` field** in `/v1/projects` and `hack projects --json`: `running | degraded | starting | stopping | stopped | failed | unknown`, plus `started_at` and `failed_services[]`. Moves state derivation out of the app.
3. **R3 per-service usage**: `hack usage --json --path <root> --by-service` with `cpuPercent`, `memUsedBytes` per service.
4. **R4 log stream guarantees**: document `hack logs --json` ndjson as a stable contract and add `--max-line-bytes <n>` so the CLI sets `entry.truncated`.
5. **R5 activity history**: append-only record written by `up`, `down`, `restart` and autostart (`ts, project, branch, action, origin, outcome, failed_services, duration_ms`), read with `hack activity --json [--project] [--limit]`.
6. **R6 action progress**: `hack up|down|restart --json --progress` emitting ndjson `{type:"progress", service, phase}` lines before the final envelope.
7. **R7 structured doctor findings**: add `area`, `scope: machine | project`, `projects[]`, `fix: {kind: safe | admin | manual, args[], doc_url}` per check (same shape as `UpgradeFinding` in #790), and `hack doctor --fix --only <id> --yes --json` for one safe fix without prompts.
8. **R8 daemon status version and unit staleness**: `version` and `cli_version` in `hack daemon status --json`, plus `service.unit_stale` and its reason.
9. **R9 push updates (optional)**: `GET /v1/projects?wait=<generated_at>` long-poll, so the app can stop 2-second polling.
10. **R10 env key state**: top-level `key_state: ok | missing | unreadable` in `hack env list --json` (no values).
11. **R11 admin argv plan**: `hack global install|trust --plan --json` listing the exact root-only argv lines, so the app can show them and later hand single lines to the macOS system prompt.
12. **R12 always-on fields and commands** as listed in [section 6](#6-always-on-hack-2213).

## 8. Scope

| Version | Contains |
|---|---|
| v0 | Window, sidebar, detail header, Services table, log tail, status bar, light/dark; Start, Stop, Restart, Open, follow logs; `--fixtures <state>` mode. |
| v0.1 | Logs tab, Doctor view, onboarding, Env tab (names), always-on and daemon states, upgrade flow; Homebrew cask; Linux tarball. |
| Later | Menu bar popover (open/start/stop, "Pause always-on"); activity charts; env editing through `hack env set`; branch instances; resource graphs. |
| Never | Edit Compose files or Hack config; show, copy or export secret values; install, start or manage Docker itself; ask for or store a password; an embedded terminal, editor or agent; remote/gateway/tickets; its own database. |

Menu bar: gpui-kit 0.9.1 and GPUI have no tray or status item API (only the app
menu, dock menu and in-window menus). The popover needs a separate crate such as
`tray-icon`, not yet checked against GPUI's event loop. That is why it is "later".

## 9. Distribution

| Item | Plan |
|---|---|
| macOS | Cask `hack-desktop` in `hack-dance/homebrew-tap` beside `Formula/hack.rb`, `depends_on formula: "hack"`; `brew install --cask hack-desktop`. The formula offers it in caveats only; the CLI install never pulls the app. |
| Signing | Developer ID Application certificate, hardened runtime, no App Sandbox (the app runs `hack` and reads the hackd socket). Notarize with `notarytool submit --wait`, then `stapler staple`. Certificate, its password and the notary API key live only in the owner's password manager and CI secrets; this design sets none of them up. |
| Release job | A separate, manual workflow later builds the universal `.app`, signs, notarizes, zips, and updates the cask with its sha256. It does not join the CLI release until the lead decides. |
| Auto-update | None. Homebrew owns updates (`brew upgrade`), and the app only shows "update available". gpui-kit ships no updater. |
| Linux | v0.1: tarball with binary, `.desktop` file and icon, plus an `install.sh` into `~/.local`. Later maybe `.deb`. No Flatpak/Snap: their sandboxes block running `hack` and reading the socket. |
| Minimums | macOS 15+. Linux: Wayland or X11 with Vulkan (software Vulkan works), glibc of Ubuntu 24.04 or newer. Windows: not planned. |
| Version match | The app reads `hack version --json` and supports a declared CLI range; outside it, it shows only the "update Hack" card. |

## Open questions for the lead

1. Cask name `hack-desktop` and install opt-in only (recommended), or offered by `hack setup`?
2. Who runs always-on at login: hackd at service start (recommended) or a separate unit?
3. Is terminal hand-off acceptable for v0 admin steps on macOS (recommended), or is the system prompt a v0 requirement?
