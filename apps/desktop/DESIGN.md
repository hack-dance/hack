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
| Env values only by request | Env lists metadata. The eye reads one value through `hack env get KEY`. The value hides after 60 seconds or when focus or selection changes. The app delegates writes to the CLI. Logs separately show unredacted service output as the CLI emits it (see [Logs tab](#logs-tab)). |
| No credentials, no passwords | Explicit Run actions use an app-owned PTY. The CLI invokes `sudo` when needed and owns the prompt. The app has no password field. |
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
| Pause | Stops auto-scroll; keeps reading into a ring buffer bounded at 10,000 lines **and** 8 MB; "N new lines" chip. Scrolling up pauses; Resume returns to the bottom. No pause timeout or automatic resume at the bottom in this preview. |
| Search | Filters the buffer in place (plain text, case-insensitive), with match count. |
| Service filter | One service at a time: restarts the stream as `hack logs <service>`. `--services` is Loki-only and native rejects it (and `--compose`), so the app never passes either. Multi-select needs R4. |
| Very long lines | Cut at 4 KB on screen with "… (+N KB)", click to expand; `entry.truncated` shown as "truncated by hack". |
| Secrets warning | Fixed note: "Logs are shown as your services print them. Hack does not hide secrets in logs." No copy-all; buffer never written to disk; "Open in terminal" offered. |
| Finished | `end` event on a `--no-follow` read: "End of log" (normal). |
| Follow ended | while following, an `end` event (`eof` from Compose, `closed` from Loki) and exit 0: "Log stream ended" + Reconnect. Not an error. |
| Stream error | `error` event or exit ≠ 0: banner with reason and Reconnect. CLI failure envelopes and bounded diagnostic tails provide the reason. Docker failures retain the CLI's wording; a normalized "Docker not reachable" label is deferred. |
| Closed by the app | tab change or project change: the app kills the stream; nothing is shown. |
| Busy stream | The reader continuously consumes stdout. A full bounded event queue discards incoming events and reports a visible skipped-event count; it never waits for UI drain. This bounds app retention, not arbitrary producer-side CLI buffering. |
| Stopped project | Last 200 lines (`--no-follow`), marked "project stopped". |

### Env tab

Source: `hack env list --json --path <root> [--env <overlay>] [--service <scope>]`
for names, and `hack env get <KEY> [--env <overlay>] [--service <scope>]` on a
pipe for each value shown. Owner direction, Nov 17; mockup in the lead's brief.

| Part | Shown |
|---|---|
| Overlay tabs | Base (`--env default`), selected overlay metadata and every modern report entry in `overlays[].name`, once each. A running chip appears when known (R22). |
| Scope | Small pills on the right, from `scopes`; one listing per scope. |
| Key line | `key_state` only: "Secret key found", or, when missing, the two places the CLI looks (`.hack.secret.key`, `HACK_ENV_SECRET_KEY`). Which source the CLI used is R26. |
| Table | Name, value and actions. Values start masked. A scope chip identifies non-global scope and missing required names appear first. |
| Reveal | The eye reads that one name. It hides again after 60 s, and when the overlay, scope, detail tab or project changes, or the window is hidden or loses focus. |
| Copy | Copies a revealed value and clears the clipboard after 60 seconds or when the app quits, if it still holds that value. macOS marks the item concealed. |
| Edit, + Variable | The editor retains per-row overlay, scope and layer, and shows the command it runs with the value on stdin. An already revealed plaintext value can prefill the editor. Otherwise enter a replacement. Secrets start with an empty masked field. |
| Needs the CLI | Shown inactive with the request in a tooltip: + Overlay (R27, and R24 for every overlay as a tab); Choose key file and Use env var when the key is missing (R26). |

A value never reaches a log, `--drive` output, a test snapshot or an
error message: `Revealed` prints only its length, failures name the variable
and exit code, and fixtures use obviously fake values. The app does not yet offer overlay creation or key source controls (R26, R27). When R26 exists, the
key source will be stored per project in the app's machine-local settings
file (the same file as the CLI choice), as a path or a variable name, never
key bytes.

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

The welcome screen opens when the launch check finds something to do and the
user has not navigated elsewhere. Doctor also opens Setup on request.
Setup presents one step at a time, in this order:

| Step | Read-only evidence | Fix |
|---|---|---|
| Hack CLI | Supported `hack version --json` result | Install guide or choose another available install |
| Hack service | `hack daemon status --json` and matching socket observation | Start hackd, or follow the checked remedy for its version or shared home |
| Docker | Machine Doctor’s Docker reachability check, and native runtime observations where applicable | Docker guide or native runtime guide |
| Local domains | Machine Doctor’s DNS checks and each native project’s `native host dns` | `hack global install` for Compose, guide for native |
| HTTPS | Machine Doctor’s certificate trust check and each native project’s `native root trust` | `hack global trust` for Compose, guide for native |
| Start at login | Daemon service state and home ownership | `hack daemon install` if eligible |

Each arrival checks the current step and its prerequisites in the background.
Machine Doctor refreshes Docker, DNS, and trust evidence together. Only a full
refresh checks every step. A failed project registry read keeps known native
checks unresolved until a fresh observation. Passing evidence starts a
two-second advance that the user can pause or complete immediately. A failed
check can be retried. Passing and skipped steps remain available from the
progress list. The CLI is required by the other steps and cannot be skipped.
Other skips are session-only and do not satisfy checks. Before completion,
the wizard returns to the first unresolved step without a session skip.

Terminal builds use the shared command drawer for starting hackd and for
Compose DNS and trust commands. Enter passwords at the system prompt in the
drawer. The login service keeps its dedicated ownership and installation
checks. The drawer menu offers a terminal hand-off, which is also the default
for administrative setup commands on builds without the drawer.

| Platform | Open Terminal adapter | Otherwise |
|---|---|---|
| macOS | Terminal.app: a new window runs a one-time script from the app's private temp dir that prints the quoted command and waits for Enter before running it | Copy command |
| Linux | `xdg-terminal-exec` when present, same script | Copy command |

The script holds only the CLI's own command with each argument shell-quoted; it
is removed after use. The app never types into an existing terminal or pane.
The command carries the checked, non-secret context the setup checks used:
home and PATH, the backend, and the Docker selectors (`DOCKER_CONTEXT`,
`DOCKER_CONFIG`, `DOCKER_HOST`, and for a TLS engine `DOCKER_TLS_VERIFY` and an
absolute `DOCKER_CERT_PATH`). A selector the app cannot carry exactly refuses
the hand-off instead of fixing a different engine.

## 3. Doctor

### Shared command control

Setup, Doctor and machine views share `core::terminal::CommandControl` and the
desktop command drawer. Use a stable ID per action and target, a short command
label for display, and authored argv from the check that offered the command
(for example, `setup::Report::command`). Run, Copy and terminal hand-off use
this same spec. Pass blocked or version-mismatch copy in `CommandAvailability`
when the check cannot offer a command. These states do not start a terminal.

In the app crate, `command_control::render` accepts the props, a caller-busy
flag and an exit callback. The callback receives a run ID, a typed
`CommandExit` and an optional diagnosis. Start a fresh check on exit, then
call `HackApp::command_checked` with that run ID and its result. A zero exit
with a passing check closes the drawer after 1.5 seconds. A failed command
or check leaves its output available. Use `HackApp::run_drawer_command` for
an explicit run initiated outside a button pair, such as Doctor's Fix all.
Use `HackApp::show_command_output` with the control ID to reopen the latest
run from a banner. Use `command_control::render_history` when a passing check
removes its Run and Copy buttons. Closing the drawer retains the latest output until
the next command starts or the CLI changes.

Source: `hack doctor --json --path <root>` per registered project, plus
`hack doctor --machine --json` for machine findings, on open and every 10
minutes while visible. The project audit gives `{ok:true,data:{schema:1,checks,summary,counts}}`; the machine variant uses the same envelope with `data.schema: "hack.doctor.machine.v1"` (R7c). Checks include `id`, `status`, `detail`, `area`, `scope` and `fix` (R7a). Until the app switches to the machine variant, it still runs one plain `hack doctor --json` outside any project and de-duplicates machine checks.

Doctor shows checked time and groups rows as Machine, Projects and a collapsed
list of passed checks. The machine rows come from the Setup report. Each row
offers its observed repair, guide or recheck. The scoped Git ignore repair is
runnable only when Doctor reports the known safe recipe for an exact checkout.
Other project commands remain manual. Upgrade opens its review.

Fix all queues runnable repairs in display order. The shared drawer owns the
active command. After an exit, Doctor reads fresh evidence and advances only
after exit zero and a confirmed repair. A stop, failed command, or unconfirmed
repair leaves the terminal output available. The app skips a queued check that
already passes, and checks that a remaining action still matches before running
it.

The project pane shows one dismissible follow-up. A dismissal belongs to the
current condition and clears when that condition changes or resolves. Release
availability and offline update checks use the read-only R14 output. The
banner and error sheets use fixtures.

Browser observations and native hostname DNS/HTTPS route checks are project-scoped:
each describes the selected exact target and must not be de-duplicated across projects.

## 4. Upgrades

![Upgrade](diagrams/upgrade.svg) ([source](diagrams/upgrade.mmd))

| State | Source | Shown | Action |
|---|---|---|---|
| Update available | R14 via `hack update --check --json --observe` (read-only, any install kind) | Follow-up "Hack X is available" | Review in the Upgrade pane, with the target release and a copyable install command when R14 supplies one |
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
| Running, not usable | `/v1/status.version` ≠ CLI version and `hack daemon status --json` does not report `api_compatible: true` | "hackd X is older than this CLI (Y): restart hackd" or "hackd X is newer than this CLI (Y): update the CLI with hack update" amber | Restart (`hack daemon restart`) only when hackd is older; none when it is newer |
| Stale process files | `stale: true` (`stale_reason`: `pid_not_running` / `socket_only`) | "hackd stopped unexpectedly" | Start (cleans the stale files) |
| Stale unit | unit points at a missing or other binary (R8) | "Login service is out of date" + `service.next_step` | Repair (`hack daemon install`) |
| Starting / incompatible | `status` | as given, with `issue` | Wait / Restart |
| Running | ok | green dot only | none |

The app never kills a daemon process or edits a unit itself.

Compatibility rule (HACK-2263): equal version strings match without another
call. When they differ (for example a prerelease CLI against a stable hackd),
the app asks the CLI once per `(cli, daemon)` version pair with
`hack daemon status --json` and uses hackd when `api_compatible` is `true`.
A failed, unparsable or unreachable answer counts as not matching and is asked
again on the next read. When they do not match, the versions are compared as
semver (pre-releases order below their release): an older hackd is restarted
from this CLI; a newer hackd means the CLI needs `hack update`, and the app
does not offer Restart, which would downgrade hackd. Versions that do not
parse fall back to Restart.

## 6. Always-on (HACK-2213, proposed contract)

The CLI now emits this contract (docs/always-on-projects.md). The app shows it
read-only in the hackd pane and under each always-on project's header
(HACK-2288 item 6); the switch and the commands below stay HACK-2213.

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
| Env value | `hack env get <KEY> --path <root>` (pipe) | on explicit reveal | 10 s |
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
| Never | Edit Compose files or Hack config; export or bulk-reveal Hack's secret values, or read one except by name through the CLI when the user asks; install, start or manage Docker itself; ask for or store a password; an embedded terminal, editor or agent; remote/gateway/tickets; its own database. |

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

## 10. Resource use in the Services tab

Why: a machine can be slow because one project's services use it, or run
under emulation, and the window gave no sign of it (the CPU and Memory
columns showed a dash). Read-only; no new CLI flag is needed for Compose.

| Where | Shown | From |
|---|---|---|
| Services table, CPU | `3.2%` (one decimal; summed over replicas; can pass 100% on several cores) | `hack usage --json --by-service --path <root>`: `cpuPercent` for the row whose `composeProject` is this instance and whose `service` matches |
| Services table, Memory | `104 MiB` (binary units), the limit in the tooltip | `memUsedBytes`, `memLimitBytes` |
| Services table, name | an `emulated` pill, tooltip "image architecture differs from the engine's: runs under emulation, slower; see Doctor" | `hack ps --json --path <root>` (with `--branch <name>` for a branch instance): `items[].emulated: true` (#904), matched on `Service` |
| Header, after the state pill | instance total, `CPU 12.4% · 1.3 GiB` | the sum of this instance's rows |

- **When.** Only while the Services tab of a running Compose instance is
  shown: usage every 5 s (one `docker stats` sample takes about 1–2 s),
  single flight, and `hack ps` for the emulated flag when the instance is
  selected and when its services change, not every 5 s. A result for an
  instance or CLI no longer shown is dropped. Nothing reads while the
  window is hidden.
- **Unknown, not zero.** A `null` value, a service with no row (not
  running), a read that failed (`E_DOCKER_UNAVAILABLE`) or a native project
  shows a dash; the header total appears only when every running service has
  a value.
- **Native projects** are not covered by `usage --by-service` (Compose
  only): the columns keep a dash with the tooltip "not reported for native
  projects yet (R29)".

Requests (Appendix C): **R28** `emulated` (and the image and engine
architectures) on each `usage --by-service` row, so one read gives both;
**R29** native-backend usage per service; **R30** engine capacity (CPUs and
memory) in the same payload, so a total can read as a share of the machine.

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

1. **R1** Exists: `hack version --json`: `{version, channel, install_kind, binary_path}`; see [Version identity](../../docs/reference/version.md).
2. **R2** Exists (see [project state](../../docs/reference/project-state.md)): backend-aware project state in `/v1/projects` and `hack projects --json` (full and summary rows): `backend`, `state` (`running | degraded | starting | stopping | stopped | failed | unknown`), `started_at`, and per service `{state, ready, completed, health, exit_code, started_at}`; native projects included.
3. **R2b** Native lifecycle the app can drive: a `--json` contract for native `restart` and authored `down`/`restart`, and qualification of the existing detached `up --json` for app use.
4. **R3** Per-service usage: `hack usage --json --path <root> --by-service` with `cpuPercent`, `memUsedBytes`. Exists for Compose ([Usage by service](../../docs/reference/usage-by-service.md), `schema: "hack.usage.by-service.v1"`); native projects are not measured yet.
5. **R4** Logs: document the `--json` ndjson as stable; `--services a,b` honoured by every backend; `--max-line-bytes <n>` setting `entry.truncated`. Compose and Loki exist ([Logs JSON stream](../../docs/reference/logs-json.md): `schema: "hack.logs.v1"` on `start`, one closing `end`); native multi-service, native `--max-line-bytes` and native `--no-follow` as the stream are open.
6. **R5a** Activity writer: append-only `activity.jsonl` in the Hack home, one line per `up`/`down`/`restart`/autostart (`ts, project, branch, action, origin, outcome, failed_services, duration_ms`), `O_APPEND` writes under one line size limit, rotation at a size cap, `origin` from `HACK_ORIGIN` (the app sets `app`).
7. **R5b** Activity reader: `hack activity --json [--project] [--limit]`.
8. **R6** Action progress: `hack up|down|restart --json --progress` emitting ndjson `{type:"progress", service, phase}` before the final envelope. The Compose slice exists; see [Lifecycle progress stream](../../docs/reference/lifecycle-progress.md). Native backend support is open.
9. **R7a — exists.** Doctor audit schema 1 adds per-check `area`, `scope: machine | project` and `fix: {kind: safe | admin | manual, args[], doc_url}` inside the existing `{ok,data}` envelope. Unknown checks default to Other/manual with no executable args. A category is guidance, not permission to run it.
10. **R7b — exists.** `hack doctor --fix --only <id> --yes --json` executes one allowlisted safe fix and rechecks it. Initially only `hack gitignore` is safe; other IDs and mixed modes refuse before writes. Results use `{ok,data:{schema:1,checks,summary,counts,fix}}`; `fix` records `id`, `changed`, `confirmed`.
11. **R7c — exists.** `hack doctor --machine --json` skips project discovery even inside an invalid project. It reports only machine scopes for the selected backend plus global secrets hygiene, in the `{ok,data}` envelope with `data.schema: "hack.doctor.machine.v1"` (a schema-tagged flag variant in the machine-output inventory; plain `doctor --json` keeps `schema: 1`). Read-only engine/service probes may run; nothing is started or repaired. `--path`, project/browser flags and mutation modes refuse. For R7b project fixes, the app supplies its selected project cwd or appends `--path <root>` to the advertised argv.
12. **R8** Daemon unit staleness: `service.unit_stale` and reason in `hack daemon status --json`, and `version` there.
13. **R9 — exists** Push updates: `GET /v1/projects?wait=<state_token>&wait_timeout_ms=<ms>` long-poll ([waiting for changes](../../docs/reference/project-state.md#waiting-for-changes)). `generated_at` changes on every response, so the marker is the response's `state_token`, a digest that ignores per-response and refresh-timestamp fields. Answers on change, or at the timeout (default 25 s, max 55 s).
14. **R10 — exists** Env key state: `key_state: ok | missing | unreadable | not_checked` in `hack env list --json` (no values). `not_checked` is the legacy `hack.env.json` contract. The payload keeps its published bare-object shape; no envelope was added.
15. **R11** Admin argv plan: `hack global install|trust --plan --json` listing the root-only argv lines.
16. **R12a** Always-on persistence and `hack autostart add|remove|list|pause|resume` ([section 6](#6-always-on-hack-2213-proposed-contract)).
17. **R12b** Always-on fields in project payloads and `autostart_global`.
18. **R12c** Login run: hackd starts always-on projects at service start, retries up to `max_failures`, and honours pause.
19. **R13** Observe-only `hack global status --json --observe` that never starts Docker; reports `host_dns_ok` on both platforms.
20. **R14 — exists** Read-only update check for any install kind: `hack update --check --json --observe` → `{current, channel, latest, available, install_kind, upgrade_command, reason}` in the envelope with `schema: "hack.update-check.v1"` ([update check](../../docs/reference/update-check.md)). One bounded GitHub read; unknown is `null` with a closed `reason`; `install_kind` adds `candidate`; `upgrade_command` is argv or `null`.
21. **R15** `--json` for `hack daemon start|stop|restart|install`.
22. **R16** Trust status: a doctor check that reports whether the system trust store (and NSS on Linux) trusts the local CA, or `unknown`.
23. **R17 — exists** `kind: safe | admin | manual` on upgrade report findings and plan steps (additive version-2 fields), independent of severity. Only explicitly allowed diagnostic/snapshot commands and fully eligible guarded apply groups are safe; host routing/login-service changes are admin; decisions and unknown actions are manual. The supplied per-checkout command can remain manual while its guarded grouped apply step is safe. Consumers must treat absent or unrecognized kinds as manual and still require an executable command before offering Run. App adoption is separate.
24. **R18 — exists** `hack projects --json --observe` (also `--summary`, `--project`, `--all`): no auto-registration, `lastSeenAt` update, registry write, daemon contact or engine contact. Includes registered native rows. Compose state defaults to unknown; `--runtime` explicitly opts in to Docker reads that can start a socket-activated engine. Rows add the R2 field vocabulary with null/unknown for unavailable evidence; native state still comes from native `ps` until R2 integrates that observer. Always-on fields follow their persistence owner. Desktop fallback can use the default non-contact command when a matching hackd snapshot is unavailable; adopting it in the app is separate work. The daemon-off screen still offers Start hackd.
25. **R19** Native branch instances: `/v1/projects` `branch_runtime` covers Compose projects only (for native projects, branch observations remain a separate interface), so the app cannot list or show a native project's branch instances. Request the same per-branch runtime for native projects in the project payload.
26. **R20** Explicit branch identity: `branch_runtime[].branch` is the Compose project name suffix after `<project>--`, not necessarily the branch name the user passed to `--branch`. The app derives each instance's routes from the containers' `caddy` labels, its URL as `<branch>.<dev_host>` (the host `hack open --branch` opens with no target; never a service route), and its checkout from Compose's `working_dir` against the registered checkout and `worktrees` (the CLI's runtime ownership rule; with no match the app offers no actions for that instance). Request as explicit fields: the original branch name, the owning checkout, the instance's hosts per service, and its primary URL as `hack open` resolves it, including the OAuth alias when the project prefers it (`open.prefer`, `oauth.enabled`: the app cannot read that config, so today its base and branch URLs use the dev host). The app's Open action already runs `hack open --branch <b>` and opens the CLI's answer.
27. **R21** End an exec session's processes inside the container. The terminal panel's service-shell tab runs `hack exec [--branch <b>] <service> -- bash`. Closing the tab or quitting ends that process group on the host, but a job the shell started in the background inside the container keeps running (as with `docker exec -it`), and the app can neither see nor signal processes in a container. Request: an exec mode that ties the in-container session to the client, for example `hack exec --session-scoped` running the command under a small in-container supervisor that ends its whole session when the client's terminal hangs up or the client exits. An alternative is `hack exec --print-session` (reporting the in-container session id) plus `hack exec --end-session <id>` for the app to call on close and on quit. The first form also covers a crashed app. Until then the app documents the limit and its `--drive` check reports such processes as known open.
28. **R22** `hack exec` without `--env` on a Compose instance that is running a non-default overlay: today it resolves to the configured default overlay, and `resolveExecTargetReady` refuses the mismatch. `down` and `restart` already reuse the stored running overlay when `--env` is omitted (`resolveStoredRuntimeEnvName`). Request the same for `exec`, or expose the running overlay per instance in `/v1/projects` so the app can pass it explicitly. Until then a service-shell tab on such an instance shows the CLI's refusal, which names the overlay to use.
29. **R23** Routing evidence for every registered project domain. On macOS, `hack doctor` emits `resolver:<suffix>` and `dnsmasq.conf:<suffix>` checks only for the default domain (`appendCustomDomainDnsChecks` uses `resolveDefaultDomain()`). A registered Compose project whose `dev_host` uses another suffix has no evidence, so Setup's routing card stays unknown and says so, naming the host. Re-checking or running `hack global install` cannot change that. Request: Doctor checks the resolver and dnsmasq entries for each registered project's domain suffix (or reports them as unchecked by name).
30. **R24 — exists.** Modern `hack env list --json` includes `overlays[].name`.
31. **R25 — exists.** The CLI supports opt-in `--plaintext-values`. The desktop lists metadata and reads values individually on request.
32. **R26** Key source: report which source the CLI used for the project secret key (`file` with its path relative to the checkout, or `env` with the variable name), never the key; and accept an override for one run (a key file path or a variable name, for example `--key-file <path>` / `--key-env <NAME>`) so the app can offer "Choose key file" and "Use env var" without reading the key itself.
33. **R27** Overlay creation: `hack env overlay add <name>` (creates `.hack/hack.env.<name>.yaml` the CLI's way, refusing an existing name), for the Env tab's `+ Overlay`. Slice 2.
34. **R28** `emulated`, `image_arch` and `engine_arch` on each `hack usage --json --by-service` row (today only `hack ps --json` items carry `emulated`), so the Services tab needs one read. Section 10.
35. **R29** Native-backend usage: `hack usage --json --by-service` for a native project (CPU and memory per native service). Section 10.
36. **R30** Engine capacity in the same payload (`engine: {cpus, mem_total_bytes}`), so an instance total can be shown as a share of what Docker has. Section 10.
