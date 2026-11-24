# Desktop app (preview)

The Hack desktop app is a window over the `hack` CLI. It shows every project on
your machine, its state and its services, and it gives you buttons for the
commands you run most.

It is an **unsupported preview**. No release or installer ships it yet, and you
do not need it to use Hack. To try it, build it from the repository; see
[the app's README](https://github.com/hack-dance/hack/blob/next/apps/desktop/README.md).
It needs macOS 15 or newer, or Linux with Wayland or X11 and Vulkan.

## What it is

The app keeps no state of its own except its window layout and which CLI you
chose. It holds no credentials. For every action it runs `hack` as you, exactly
as you would in a terminal.

```mermaid
---
title: The app runs the CLI for you
---
flowchart LR
  App["Desktop app"] -->|"runs commands"| Cli["hack CLI you chose"]
  App -->|"reads projects and status"| Daemon["hackd"]
  Cli --> Daemon
  Cli --> Runtime["Compose or native"]
  Cli --> Files[".hack/ env files"]
```

So anything the app shows, you can also get from the CLI, and anything the CLI
refuses, the app cannot do.

## What it shows

| Where | What you see | CLI behind it |
| --- | --- | --- |
| Project list | Every registered project and its branch instances, grouped by state. Search with Cmd-K (Ctrl-K on Linux). | `hackd` (`/v1/projects`); `hack ps --json` for native projects |
| Project header | Start, Stop, Restart and Open, with live phases for local Compose lifecycle actions. Native projects can start when the project is stopped or the native runtime is off. Failed actions show the CLI code, diagnostic and any recovery guidance. | `hack up`, `down`, `restart`, `open`; Compose progress uses `--json --progress` |
| Resources | Registered project containers and observed attachments, plus allocated and logical host file totals for the selected native home. Partial scans are labeled. | `hackd`; `hack ps --json`; `hack native disk-usage --json` |
| Services tab | Each service, its state and its routes. For a running Compose project, also CPU and memory per service, and an **emulated** mark on a service whose image runs under CPU emulation. | `hackd`; `hack ps --json`; `hack usage --json --by-service` |
| Logs tab | Live logs with pause, search and a filter for one service. | `hack logs --json` |
| Env tab | Variable names and values per overlay and scope. See below. | `hack env list`, `get`, `add` |
| Terminal panel | Log and shell tabs inside the window. On Linux, only in a build with the `terminal` feature. | `hack logs --pretty`, shells |
| Setup | One card per setup step: the CLI, the runtime, `hackd`, routing and DNS, certificate trust, the login service. | read-only checks |
| Doctor | Machine checks once, and project checks for each registered checkout. | `hack doctor --json` |
| hackd | Whether `hackd` runs and matches the CLI, and a summary of always-on projects. | `hack daemon status --json` |
| Upgrade | The upgrade review pane. See below. | `hack upgrade check`, `review`, `snapshot`, `rollback` |

When the CLI does not report something, the app shows a dash and says why. It
does not invent a value.

## How it finds the CLI

The app looks for two installs:

- stable `hack` on your `PATH`;
- the prerelease `hack-next`, on your `PATH` or at `~/.hack-next/bin/hack-next`.

It offers only an install that no other user on the machine can change. It uses
the one you chose last time; otherwise stable; otherwise the prerelease. The
status bar names the CLI in use, for example
`hack-next 5.0.0-next.19 · prerelease`, and one click switches to the other.

The app then asks that CLI where its `hackd` is (`hack daemon status --json`)
and reads that one. This matters with a prerelease: `hack-next` keeps its own
`hackd` and its own project list, apart from stable. If the app shows no
projects, check which CLI the status bar names.

Your choice is saved in the app's settings file
(`~/Library/Application Support/dance.hack.desktop/settings.json` on macOS,
`$XDG_CONFIG_HOME/hack-desktop/settings.json` elsewhere, by default under
`~/.config`). No environment
variable selects the CLI.

## The Env tab

The Env tab shows one overlay at a time. Tabs across the top choose the
overlay (`base`, then each overlay the project has). Pills on the right choose
the scope. [Overlay and scope](run-commands.md#overlay-and-scope) explains the two words.

- **Plaintext values** load with the list.
- **A secret shows dots** until you press its eye, for that one name. It hides
  again after 60 seconds, and when you change overlay, scope, tab or project, or
  the window is hidden or loses focus.
- **Copy** puts one value on the clipboard and clears it after 60 seconds, or
  when the app quits sooner, if it is still there. On macOS the copied item is marked concealed, so clipboard
  managers that follow that convention do not record it. Linux has no such
  convention.
- **Edit** and **+ Variable** open an editor that shows the exact command Save
  runs, for example
  `hack env add API_TOKEN --secret --value-stdin --env staging --service api`.
  The value goes to the CLI on standard input. It is never a command argument.
- **A missing key** is named on its own line. Without the key, secrets cannot be
  revealed, copied or edited.

Some things still need the CLI: creating an overlay
(`hack env overlay add <name>`) and, when the key is missing, choosing another
key for one run (`--key-file`, `--key-env`). The app shows these as inactive
buttons that name the command. See [Share environment and secrets](share-environment.md).

## The upgrade review pane

The **Upgrade** row opens the same review the CLI gives you before a v4 to v5
upgrade.

- **Check** is read-only. It shows the CLI's verdict, each blocker, each check
  that could not run, and the plan, one row per step. You copy a step's command
  and run it yourself.
- **Save snapshot** keeps a private copy of the files an upgrade changes.
- **Review findings** is read-only. It lists what cannot be applied safely, and
  why.
- **Restore** lists the snapshots and asks before it restores one. It never
  overwrites a file that changed since the snapshot.

The app does not apply the upgrade. Run `hack upgrade apply` in a terminal. See
[Upgrade from v4](../upgrade.md).

## What it never does

- It never runs `hack upgrade apply`, and it never installs a new version.
- It never runs a Doctor fix. It shows the finding and the command.
- It never changes always-on projects. Use `hack autostart`.
- Its setup checks only read. The only `hackd` actions it runs itself are
  `hack daemon start`, `hack daemon install`, and `hack daemon restart` for a
  `hackd` older than the CLI, each when you press its button.
- It never asks for an administrator password. A step that needs one, such as
  `hack global install` or `hack global trust`, opens in your own terminal.
- It never puts a secret value in a command argument, a log or an error
  message.
- It never uses a `hack` that another user on the machine could change.
