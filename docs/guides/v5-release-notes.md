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

## next.17: what changed and what to do

These are source changes intended for `5.0.0-next.17`, not a claim that the
release is published. Check the installed candidate's version and release notes
before using a new flag or changing a script. An installed next.16 bundle keeps
its original behavior.

| Change | What to do |
| --- | --- |
| **Native plain `logs SERVICE --follow` output changes.** It now prints application-text lines, matching a finite snapshot, instead of adding a `SERVICE \| ` prefix. Both service streams go to stdout; Hack notices go to stderr. | Stop parsing the old plain prefix. Use `--json` and the log event's `entry.service`, `entry.stream` and `entry.message` when a script needs those fields. Use `--timestamps` to request Engine timestamps. |
| **Env listings hide values by default, including migrated plaintext.** Ordinary `env` / `env list` text and JSON output are metadata. JSON omits `value` and reports `has_value`. | Use `has_value` for availability checks. For a value a script actually needs, call `hack env get KEY` with the same `--env` and `--service`; that command prints plaintext. Bulk `--show-values` requires interactive stdin and stdout; `--show-secrets` remains an alias. |
| **Migration cleanup preserves live keys (HACK-2172).** A legacy store's `keyPath` can no longer make the current project/shared key a cleanup target. Current config and YAML inputs are protected too, including filesystem aliases. | Keep key and env backups before migration. On next.16 or an earlier prerelease, do not run `doctor --migrate-env-config` without a private readable copy of `.hack.secret.key`. The fix does not recover a key already removed. |
| **Doctor fails when an env layer cannot be used by the runtime.** Unreadable, invalid or undecryptable layers no longer get an apparent all-clear. | Run `hack doctor` after upgrading. Fix the reported layer or recover the original key before starting; keep the encrypted file rather than generating a replacement key over it. |
| **An old global secret store with a lost key no longer fails Doctor in unrelated projects (HACK-2177).** It is an error where the runtime reads it and a warning elsewhere. | Restore the original key, or deliberately retire the store with `hack secrets retire-store --path <project>`. Retirement preserves the encrypted file and prints how to put it back; see the confirmation requirements below. |
| **Doctor checks the Compose proxy's loopback ports.** A reachable container address no longer hides a broken published loopback path. | Read the `proxy ports` warning, check competing listeners and DNS/bind settings, then retry. HTTP success on port 80 is not HTTPS success on 443; the check applies no automatic repair. |
| **Native route readiness can be inferred.** A complete standard Caddy route with no authored healthcheck gets a reviewed HTTP probe and 240 seconds of initial grace. A complete HTTP 200–499 response establishes endpoint readiness, not application correctness. | Review the route port and startup logs. Explicit healthchecks are not replaced, and inferred readiness does not satisfy `depends_on: condition: service_healthy`. The grace does not extend the whole graph's deadline. |
| **Native start waits for bridge sockets after a stopped pool resumes.** An immediate start no longer fails merely because provider readiness preceded the bridge listener. | Use normal native `up`; startup still requires a successful bridge connection within its deadline. Do not replace readiness checks with a fixed sleep. |

### Env scripts and migrated plaintext

Replace noninteractive bulk reveal with explicit single-key reads; do not log or
paste their output. `--json` is a format choice, not permission to reveal values.
The terminal reveal gate reduces accidental transcript exposure; it is not
access control against a local process with the same file and key access.

Use `hack env protect` for a names-only inventory of plaintext YAML entries,
then choose keys to encrypt in their original scopes and layers, for example
`hack env protect API_TOKEN --service api`. Omitted `--env` covers all overlays.
Keep the existing key and recover missing key material before trying to protect
values. Encrypting a YAML entry does not erase legacy dotenv or store copies.

Secret writes now use `--secret --value-stdin` or the hidden terminal prompt;
positional values with `--secret` are refused. Continue using `--secret` when
updating an encrypted entry. Review legacy lifecycle hooks and processes that
depended on a service's values: they now receive only global contract values.
Put only the values they need into global scope. For text parsers, prefer JSON metadata
or explicit single-key reads over the old tab column positions. YAML projects'
daemon `GET /v1/env` returns names-only metadata. Their legacy set/unset routes refuse with HTTP 409
`yaml_env_mutation_unsupported`; use the canonical CLI env commands.

See [the env command and script migration guidance](../env.md#common-commands)
and [legacy migration and cleanup](../env.md#legacy-repos-and-migration).
The merged env contract and its migration wording are also in
[`scripts/prerelease-plan.ts`](../../scripts/prerelease-plan.ts), alongside
[#767](https://github.com/hack-dance/hack/pull/767) and the live-key fix in
[#769](https://github.com/hack-dance/hack/pull/769).

### Cleanup can finish partially

Cleanup now keeps content and file-identity receipts and rechecks them under
the existing writer locks before removal. If a source or its delivery changed,
keep the remaining files and keys. Migration writes already completed are not
rolled back. Reconcile chosen values through `env set KEY --value-stdin`, keeping
the overlay and service scope, adding `--local` for machine-local values and
`--secret` for secrets. Check delivery before removing any remaining copy.

Explicit Doctor cleanup reports the failure and every confirmed removal.
Implicit cleanup warns and allows the original command to continue. If a legacy
store was removed before a later cleanup failure, Doctor reconciles its config
pointer for that confirmed removal. If the store remains, its pointer remains.
If the config cannot be updated, Doctor warns about that too; a failure is not
proof that nothing changed. See [cleanup and reconciliation](../env.md#legacy-repos-and-migration),
[#768](https://github.com/hack-dance/hack/pull/768) and
[#783](https://github.com/hack-dance/hack/pull/783).

### An old global store whose key is lost

Merged [#779](https://github.com/hack-dance/hack/pull/779), intended for next.17,
makes a missing or wrong store key a Doctor error only in projects whose runtime
reads that store. Other projects receive a warning. The finding names registered
projects that read it; without the key, entries cannot be counted or read.

Choose one: restore the original key, or, if it is gone for good, run
`hack secrets retire-store --path <project>` for a project that selects the store.
Retirement moves the encrypted file into a timestamped directory beside it,
deletes nothing, leaves the key file alone and prints the command to put it back.
It does not recover the values; a new key cannot decrypt them.

The command refuses a store that an available key opens. It also needs
`--allow-unchecked`: another shell may set `HACK_SECRETS_FILE_KEY` to the key,
and Hack cannot inspect that shell. Pass the flag only after confirming that no
shell for a project selecting the store has that key; it also acknowledges
registered projects Hack could not check. Without a terminal, add `--yes` for
the move confirmation. See [store recovery and retirement](../env.md#compatibility-notes).

## Highlights

- **Same project folder and default backend.** Compose remains the default;
  inspect legacy env migration before accepting project-file changes.
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

Existing Compose projects keep the same project model. Review env migration and
command behavior before upgrading; these changes can affect an existing project:

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

Back up the project, env files and original project key before migration. On
next.16 or earlier prereleases, explicit Doctor cleanup can remove the project
key when a legacy store's `keyPath` names it (HACK-2172). Use a build containing
the fix or preserve a readable key copy outside the working tree first. A new
key cannot decrypt values encrypted with a missing original key.

The migration has the following consent and delivery checks:

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
[the native backend overview](../native/README.md),
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
