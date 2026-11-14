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
| Hack's secret values never appear | Env shows names and layers only, never a reveal. Logs are service output, shown as the CLI emits them, with a warning, never written to disk and with no copy-all (owner decision: the Logs tab is in scope). |
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
| Daemon not running | `/v1/status` unreachable | List loads through the CLI; banner "hackd is off: status refreshes slowly" | Start hackd |
| Daemon other version | `/v1/status.version` ≠ CLI version | CLI fallback; banner "hackd vX, CLI vY" | Restart hackd |
| Engine not running | `runtime_ok: false` | Rows keep names, dots "?"; banner with `runtime_error` | Open engine help |
| CLI missing or too old | `hack` not on PATH, or outside the supported range | Full-pane card instead of the list; status bar shows no engine/hackd state | Copy install command |
| Error | CLI exit ≠ 0 or bad JSON | Banner with `code` and `message`; last good list kept, marked stale with its age | Retry, copy error |

### Backends

| Backend | v0 | Source |
|---|---|---|
| Compose | Full detail | `/v1/projects` or `hack projects --json` (`runtime.services[].containers[]`) |
| Native (beta) | Row and state pill only; Services shows "native: details need R2" | `hack ps --json --path <root>` (`data.status`) |

Project views read legacy inputs; a canonical native project comes back with
`input_diagnostic`. The app recognises that code and asks `hack ps` instead
rather than showing "Needs attention". Native `data.status` maps as:
`not_started` → Stopped, `pending` → Starting, `observed` → Running or Degraded
from `items[].state`, `runtime_degraded` → Degraded, `runtime_not_running` and
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
| Running | every long-running service has a running container; one-shot services that exited 0 count as completed | green "Running · 2 hours" (from Docker status text) | Open, Restart, Stop |
| Degraded | some running; a long-running service down, exited ≠ 0, or `(unhealthy)` | amber "Degraded · worker down" | Open, Restart, Stop |
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
  structured fields are request R2. A one-shot service is one with `restart: "no"`
  semantics as Hack's startup state reports it; until R2 exposes that, an exit 0
  is treated as completed, never as down.

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
| Stream error | `error` event or exit ≠ 0: banner with reason and Reconnect. Engine down: "Engine not running". |
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
| Engine | `runtime_ok` from `/v1/projects` or `hack projects --json` | open Docker Desktop / engine docs; native setup command (HACK-2193) | no | "Engine not running" on every project |
| hackd | `hack daemon status --json` | `hack daemon start` | no | Status bar "hackd off"; slower refresh |
| Routing and DNS | macOS: doctor `dnsmasq:53` and `coredns forwarding`; native: `native host dns`. Linux: **unknown** until R13 (only `hack global status`, which can start Docker, reports it) | `hack global install` | **yes** | URLs greyed "DNS not set up"; "unknown" when no check reports |
| Certificate trust | **Unknown** today for Compose: doctor `caddy local ca` checks the exported CA, not system or browser trust (R16). Native: `native root trust` | `hack global trust` | **yes** | Lock icon on URLs: "browser may warn" |
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
| Blocked | `ready: false`. `blockers[]` / `incomplete[]` are `{scope,id,summary}`; the command or action comes from the matching finding (`machine[]` or `projects[].findings[]` by scope + id) | One card per blocker | Copy / Open Terminal; Run only with R7a's `kind: safe`; Re-check |
| Ready | `ready: true`, `plan[]` (`command` / `args` / `action`, `blocker`) | Ordered plan | Upgrade |
| Snapshotting | `hack upgrade snapshot --json` | Progress | none |
| Snapshot incomplete | `complete: false` or `gaps[]` | Gaps listed; Upgrade stays disabled | Re-check |
| Applying | Homebrew: `brew upgrade hack` **and** `brew upgrade --cask hack-desktop`, in a terminal, then plan steps | Steps with ✓/✗; partial success named ("CLI upgraded, app not") | none |
| Restarting daemon | `hack daemon restart` (exists), then `/v1/status.version` == CLI version. Doing this automatically after upgrade is HACK-2216 (proposed) | "Restarting hackd…" | none |
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
killed with its process group on expiry; a timeout makes the screen Unknown.

| Screen | Reads | How often | Timeout |
|---|---|---|---|
| Sidebar, header | `GET /v1/projects` if `/v1/status.version` matches the CLI, else `hack projects --json --no-daemon`; native rows add `hack ps --json --path` | 2 s with hackd, 10 s without; and after every action | 3 s / 15 s |
| Services CPU/memory | `hack usage --json --details` (until R3) | 5 s while visible | 10 s |
| Logs | `hack logs --json --path <root> [<service>] --tail 500` (one long-running child) | stream | killed on tab change |
| Env | `hack env list --json --path <root>` | on tab open, after env actions | 10 s |
| Activity | `hack activity --json --project <name> --limit 100` (R5b) | on open, 10 s while open | 10 s |
| Doctor, onboarding | `hack doctor --json` (per project and once outside), `hack daemon status --json` | on open; every 10 min | 60 s |
| Daemon | `GET /v1/status` | 10 s | 1 s |
| Upgrades | R14 daily; `hack upgrade check --json` on Review | daily / on demand | 30 s / 60 s |
| Actions | `hack up -d --json`, `down --json`, `restart --json`, `open --json`, `daemon start\|restart\|install` (exit code), `autostart …` | on click | 10 min for `up`, 2 min others |

### Requests to the CLI and daemon (one PR each, for other sessions)

1. **R1** `hack version --json`: `{version, channel, install_kind, binary_path}`.
2. **R2** Backend-aware project state in `/v1/projects` and `hack projects --json` (full and summary rows): `backend`, `state` (`running | degraded | starting | stopping | stopped | failed | unknown`), `started_at`, and per service `{state, ready, completed, health, exit_code, started_at}`; native projects included.
3. **R3** Per-service usage: `hack usage --json --path <root> --by-service` with `cpuPercent`, `memUsedBytes`.
4. **R4** Logs: document the `--json` ndjson as stable; `--services a,b` honoured by every backend; `--max-line-bytes <n>` setting `entry.truncated`.
5. **R5a** Activity writer: append-only `activity.jsonl` in the Hack home, one line per `up`/`down`/`restart`/autostart (`ts, project, branch, action, origin, outcome, failed_services, duration_ms`), `O_APPEND` writes under one line size limit, rotation at a size cap, `origin` from `HACK_ORIGIN` (the app sets `app`).
6. **R5b** Activity reader: `hack activity --json [--project] [--limit]`.
7. **R6** Action progress: `hack up|down|restart --json --progress` emitting ndjson `{type:"progress", service, phase}` before the final envelope.
8. **R7a** Doctor metadata: per check `area`, `scope: machine | project`, `fix: {kind: safe | admin | manual, args[], doc_url}` (same shape as #790's findings plus `kind`).
9. **R7b** One fix without prompts: `hack doctor --fix --only <id> --yes --json`, only for `kind: safe`.
10. **R7c** Machine-only doctor: `hack doctor --machine --json` (no project), so the app does not need to de-duplicate.
11. **R8** Daemon unit staleness: `service.unit_stale` and reason in `hack daemon status --json`, and `version` there.
12. **R9** (optional) Push updates: `GET /v1/projects?wait=<generated_at>` long-poll.
13. **R10** Env key state: `key_state: ok | missing | unreadable` in `hack env list --json` (no values).
14. **R11** Admin argv plan: `hack global install|trust --plan --json` listing the root-only argv lines.
15. **R12a** Always-on persistence and `hack autostart add|remove|list|pause|resume` ([section 6](#6-always-on-hack-2213-proposed-contract)).
16. **R12b** Always-on fields in project payloads and `autostart_global`.
17. **R12c** Login run: hackd starts always-on projects at service start, retries up to `max_failures`, and honours pause.
18. **R13** Observe-only `hack global status --json --observe` that never starts Docker; reports `host_dns_ok` on both platforms.
19. **R14** Read-only update check for any install kind: `hack update --check --json --observe` → `{current, latest, available, install_kind, upgrade_command}`.
20. **R15** `--json` for `hack daemon start|stop|restart|install`.
21. **R16** Trust status: a doctor check that reports whether the system trust store (and NSS on Linux) trusts the local CA, or `unknown`.
22. **R17** `kind: safe | admin | manual` on #790's findings and plan steps, so the app knows which to offer as Run.

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
3. Zip, `xcrun notarytool submit --wait` with the notary API key from CI secrets, `xcrun stapler staple`, `stapler validate`.
4. Upload the zip to the release; update the cask's `version` and `sha256` in the tap (as the formula job does today).
5. A separate, manual workflow does this until the lead folds it into the release.
