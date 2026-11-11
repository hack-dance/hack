# What's new in Hack 5.0

> Draft for the 5.0.0 release. Until 5.0.0 is published, v5 ships as
> `5.0.0-next.N` prereleases through the separate `hack-next` channel; see
> [Install a prerelease](candidate-install.md).

Hack 5 keeps the v4 project model and commands. Your `.hack/` folder, encrypted env
values, branch instances, lifecycle processes and sessions carry over, and Docker
Compose stays the default backend. The release tightens how Hack handles commands
and env, makes agent integrations opt-in, and introduces a native backend as a
beta. `hack dev`, added in 4.3.0, is part of the core.

This page is the readable summary. The generated
[CHANGELOG](../../CHANGELOG.md) lists every change by commit.

## Highlights

- **Same projects, same commands.** A v4 project runs on v5 without a config
  rewrite.
- **Safer env.** Secrets can be entered without appearing in command arguments, and
  the env migration never rewrites a tracked file without your consent.
- **`hack dev`.** One command runs a repository's own side-by-side development
  build. It first shipped in 4.3.0 and is part of the v5 core.
- **Agent integrations are opt-in.** Hack no longer writes agent files on its own.
- **Native backend (beta, Apple Silicon macOS).** Prepared projects can run without
  Docker. It ships through the `hack-next` channel, not in stable Hack.
- **A smaller product.** Hosted accounts, the dashboard, Hack Tickets and the
  built-in GitHub and Linear integrations are gone.

## Upgrading from 4.x

1. Upgrade the CLI the way you installed it: `brew upgrade hack-dance/tap/hack`, or
   rerun the release installer.
2. Run `hack doctor` in each project and follow its diagnosis.
3. If a 4.x `hackd` was running during the upgrade, replace it with
   `hack daemon restart`. See [the daemon after an upgrade](upgrade-to-v5.md#the-daemon-after-an-upgrade).
4. Start the project with `hack up` and check the application itself: sign-in,
   data-backed pages, and anything that must survive a restart.

Projects need no changes to keep running on Compose. Three behavior changes can
affect an existing project:

- **Managed env values that contain `$`.** v4 let Compose interpolate `$VAR` inside
  a managed value. v5 delivers the value exactly as stored. A value that relied on
  interpolation, or escaped `$` as `$$`, reaches the container differently, and the
  next `hack up` recreates that service's containers. See
  [managed values that contain `$`](../env.md#upgrading-managed-values-that-contain-).
- **Option placement.** For `hack exec`, `hack run`, `hack host exec` and
  `hack env exec`, Hack options go before your command. From the command's first
  word on, every argument belongs to it, including flags Hack also defines. An
  option a command does not declare is refused with `E_USAGE`. See
  [option parsing](../cli.md#option-parsing).
- **Retired commands refuse.** `hack setup sync`, `hack setup cursor|claude|agents`
  and `hack agent prime` print a retirement notice instead of writing files.

To try v5 before 5.0.0 is published, keep stable v4 installed and follow
[Upgrade to v5](upgrade-to-v5.md), which covers the prerelease channel and the order
for running both versions on one machine.

## Env migration safety

Projects that still use the legacy `.hack/hack.env.json` and `.hack/.env` files
move to the layered YAML format with:

```bash
hack doctor --migrate-env-config
```

The migration is built to be safe to run on a real project:

- Tracked layers receive encrypted values, never legacy plaintext. Plain values go
  to gitignored local layers.
- It never deletes or edits a git-tracked file without your consent. Interactively,
  `hack doctor` lists the tracked files that may change and asks before each kind of
  removal. A run that cannot prompt refuses with `E_INTERACTIVE_REQUIRED` and names
  the files, unless you pass `--accept-tracked-env-changes`.
- Values held in a secret store or in legacy files are preserved through the
  migration.
- When the result would change what a service receives, such as a migrated value
  overriding a Compose `environment` entry, the migration refuses with a one-line
  error, writes nothing and keeps the legacy files.
- It changes project files only, so it runs the same way on either backend.

`hack env hydrate` imports many values from a file or stdin, and `hack env add`
reads a piped value or a hidden prompt, so a secret never has to appear in a command
line. See [Env and secrets](../env.md#legacy-repos-and-migration).

## `hack dev`

`hack dev` arrived late in the v4 line (4.3.0), so many projects meet it for the
first time with v5. It runs the development command a repository declares in a
committed `.hack/dev.json`:

```json
{"version": 1, "command": ["bun", "scripts/dev.ts"]}
```

It runs in the foreground, needs no Docker and forwards Ctrl-C and termination
signals to the command. The project's runner owns its own app name, ports and data
directories, so the development build runs beside the installed one instead of
replacing it. Hack only runs a declaration from a checkout you own that is not
writable by other users. See [Side-by-side development](../dev.md).

## Agent integrations are now opt-in

v4 could inject instructions into `AGENTS.md` and `CLAUDE.md`, write Cursor rules
and install session hooks. v5 does none of that. Ordinary commands, `hack update`
and `hack doctor --fix` never write agent files, and existing customized files are
left alone.

What you can choose to add:

- The `hack` plugin: eight skills for Codex, Claude Code and Cursor, installed and
  updated by the client's own plugin manager. It ships no hooks, rules or MCP
  server.
- The separate `hack-mcp` plugin, or `hack mcp install`, for a client without shell
  access.
- `hack agent onboard` and `hack init --with claude|codex`, which hand project setup
  to an agent.

An agent with shell access needs none of these: every command supports `--json` and
`--no-interactive`. If you used the standalone skill and rule files, `hack setup
migrate` previews and applies a move to the plugin. See
[Agent integrations](../integrations.md).

## Native backend (beta)

The native backend runs explicitly prepared projects on Apple Silicon macOS without
Docker. It is a beta:

- It ships only through the `hack-next` channel, which installs beside stable Hack
  and leaves the stable executable and its state untouched. The stable release
  archives and the Homebrew formula do not contain it; stable `hack` asked for the
  native backend refuses and points at [the install guide](candidate-install.md).
- Docker Compose remains the default. Nothing selects the native backend for an
  existing project automatically.
- It supports a bounded command subset and is qualified project by project. It does
  not claim parity with Compose, lower resource use, or compatibility with every
  project.
- `hack config validate`, `hack config plan`, `hack config import --dry-run` and
  `hack config adopt --dry-run` preview native configuration without starting
  anything.

Start with a disposable project. See
[candidate capability limits](prereleases.md#candidate-capability-limits),
[the native backend guide](native-candidate.md),
[Native config import](../reference/native-config-import.md) and the staged plan in
[Qualify a project on v5](v5-dogfooding.md).

## Retired and unsupported

| Retired in v5 | Use instead |
| --- | --- |
| Hosted accounts, organizations and teams | Nothing; Hack is local-only |
| The web dashboard | `hack status`, `hack ps`, `hack tui` |
| Hack Tickets | The tracker your project already uses |
| Built-in GitHub and Linear integrations | `git`, `gh` and the tracker's own CLI |
| Automatic agent instruction injection | The opt-in `hack` plugin |

Remote, gateway, node and dispatch commands and the macOS app remain in the
repository but are unsupported. See
[unsupported retained surfaces](../extensions.md).
