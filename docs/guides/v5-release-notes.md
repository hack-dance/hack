# What's new in Hack 5.0

> Draft for the 5.0.0 release. Until 5.0.0 is published, v5 ships as
> `5.0.0-next.N` prereleases through the separate `hack-next` channel; see
> [Install a prerelease](candidate-install.md).

Hack 5 keeps the v4 project model and commands. Your `.hack/` folder, encrypted env
values, branch instances and lifecycle processes carry over; interactive
workspaces require tmux, with the zellij stop procedure below. Docker
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

### Breaking change: zellij workspaces removed

`hack session` now requires tmux. Zellij is removed; `auto` detects tmux only.
Project/global `sessions.mux=zellij` and `HACK_SESSIONS_MUX=zellij` refuse,
including during `hack global install`. Install tmux, remove the old setting
and environment override, or set `sessions.mux` to `tmux`. Existing zellij
workspaces are neither stopped nor migrated.

**Before upgrading a project with saved zellij lifecycle state**, keep zellij
installed and use the retained v4 CLI to run `hack down` for that project.
Confirm its lifecycle processes stopped and take a fresh private backup before
switching to v5. Keep the earlier copy too, but use the stopped-state backup for
rollback so it does not restore live zellij state. If already upgraded,
return to the retained v4 CLI for that stop. V5 start, restart and down refuse
saved zellij lifecycle state they cannot verify or stop. Changing the setting
alone does not clear it; do not delete or edit managed state to bypass the refusal.
See [the upgrade stop procedure](../versions/v5/guides/upgrade-from-v4.md#breaking-change-zellij-workspaces-removed)
and [sessions](../sessions.md).

### Env, native input and log changes

| Change | What to do |
| --- | --- |
| **Native accepts Compose service `env_file`.** Strings, ordered lists and long-form entries support optional missing files and `format: raw`; unsafe or unreadable active files refuse. Container precedence is managed env, explicit service environment, ordered files, then image defaults. | Keep files inside the project root and follow the [environment-file rules](../native/environment-files.md). Dotenv is an interpolation source, not automatic service injection. The Compose backend keeps its behavior. |
| **Native reads `.hack/.env` on every start and preflight, even with managed env.** Symlinks, other-owner or group/other-writable files and project ancestors refuse, as do `COMPOSE_*`/`HACK_*` keys and dotted/dashed identifiers. | Use an owned regular file, deliberately correct permissions, remove control entries and rename unsupported identifiers, or move values into managed env. A sibling `.env.state.json` also refuses possible materialized output; deliberately retire that output after moving to managed env. |
| **Native service-environment defaults take allowed shell values.** Shell presence can change normalized declarations and plan identity, without storing values in that identity. | Unset the exported name to retain the authored fallback. In projects with `env_file` or adjacent `.env`, public-field references to ambient values now refuse even with a default: unset the source or write a public literal. Authored fallbacks for newly file-backed names are frozen before private ownership; runtime-bound compounds refuse. Without those file sources, public defaults keep their previous behavior. |
| **An unresolved bare service-environment key is now unset instead of empty, including in projects without env files.** It removes an image default; an older runtime that cannot confirm the unset names refuses the review. Reserved runtime/adapter-owned names keep their existing behavior. | Use a matching current CLI/runtime bundle. Write `KEY: ""` when you intend an explicitly empty value instead of removing the key. |
| **Fresh native `hack exec` now delivers allowed caller-shell and selected-service file values privately.** Shell delivery also changes projects without env files; exec values may differ from those used at service startup. | Run exec from the intended shell and environment selection. Restart the service when changed inputs should also replace its startup environment; exec alone does not do that. |
| **Native removes `dotenv_without_managed_env`.** A project-root `.env` outside the Compose directory is now ignored with one names-only notice. | Move required inputs beside Compose (normally `.hack/.env`) or into managed env. Dotenv alone does not inject service variables. |
| **Native preflight reads the caller's allowed environment and decrypts managed env.** A missing key becomes a structured `managed_env_unreadable` blocker; the report remains usable. | Run from the intended shell and recover the existing project key when asked. Do not generate a replacement key for existing ciphertext. |
| **Native env-file paths must stay separate from build inputs.** Contexts, Dockerfiles and Dockerfile-specific ignore inputs may not overlap declared env files, adjacent `.env` or a present project-root `.env`, including optional and inactive paths. A root `.env` triggers this refusal even when there is no `env_file` or adjacent `.env`; ignored for interpolation does not exclude it from `COPY .`. Authored ignore rules do not lift this refusal. | Use disjoint build inputs or prebuilt images. The build-argument value guard stays limited to nonempty managed `secret: true` values, with no minimum length; plain file and shell values do not widen it. See [the full rules](../native/environment-files.md). |
| **Native plain `logs SERVICE --follow` output changes.** It now prints application-text lines, matching a finite snapshot, instead of adding a `SERVICE \| ` prefix. Both service streams go to stdout; Hack notices go to stderr. | Stop parsing the old plain prefix. Use `--json` and the log event's `entry.service`, `entry.stream` and `entry.message` when a script needs those fields. Use `--timestamps` to request Engine timestamps. |
| **Breaking: env listings hide values by default, including migrated plaintext.** Ordinary `env` / `env list` text and JSON output are metadata. JSON omits `value` and reports `has_value`. | Use `has_value` for availability checks. For a value a script actually needs, call `hack env get KEY` with the same `--env` and `--service`; that command prints plaintext. Bulk `--show-values` requires terminal stdin/stdout and interaction enabled; `--show-secrets` remains an alias. |
| **Migration cleanup preserves live keys (HACK-2172).** A legacy store's `keyPath` can no longer make the current project/shared key a cleanup target. Current config and YAML inputs are protected too, including filesystem aliases. | Keep key and env backups before migration. On next.16 or an earlier prerelease, do not run `doctor --migrate-env-config` without a private readable copy of `.hack.secret.key`. The fix does not recover a key already removed. |
| **Doctor fails when an env layer cannot be used by the runtime.** Unreadable, invalid or undecryptable layers no longer get an apparent all-clear. | Run `hack doctor` after upgrading. Fix the reported layer or recover the original key before starting; keep the encrypted file rather than generating a replacement key over it. |
| **Doctor reports secrets hygiene (#764).** The report covers loose modes, staging leftovers and stale terminal payloads, naming files rather than values. | Review `hack doctor`, then use `hack doctor --fix` to tighten eligible files, add missing project ignore entries and remove stale Hack artifacts. Removal excludes live inputs and retired stores; it rechecks configuration before each removal. |
| **An old global secret store with a lost key no longer fails Doctor in unrelated projects (HACK-2177).** It is an error where the runtime reads it and a warning elsewhere. | Restore the original key, or deliberately retire the store with `hack secrets retire-store --path <project>`. Retirement preserves the encrypted file and prints how to put it back; see the confirmation requirements below. |
| **Doctor checks the Compose proxy's loopback ports.** A reachable container address no longer hides a broken published loopback path. | Read the `proxy ports` warning, check competing listeners and DNS/bind settings, then retry. HTTP success on port 80 is not HTTPS success on 443; the check applies no automatic repair. |
| **Native route readiness can be inferred.** A complete standard Caddy route with no authored healthcheck gets a reviewed HTTP probe and 240 seconds of initial grace. A complete HTTP 200–499 response establishes endpoint readiness, not application correctness. | Review the route port and startup logs. Explicit healthchecks are not replaced, and inferred readiness does not satisfy `depends_on: condition: service_healthy`. The grace does not extend the whole graph's deadline. |
| **Native start waits for bridge sockets after a stopped pool resumes.** An immediate start no longer fails merely because provider readiness preceded the bridge listener. | Use normal native `up`; startup still requires a successful bridge connection within its deadline. Do not replace readiness checks with a fixed sleep. |

### Upgrade assistant: check, review, apply and recover

The assistant now covers checks and selected file repairs. It does not install
a release, hand over the daemon, migrate env formats or qualify application data.
Keep the [backup-first upgrade procedure](../versions/v5/upgrade.md), including
the original project key and application-aware data backups.

| Change | What to do |
| --- | --- |
| **`hack upgrade check` is read-only.** It checks the machine and registered checkouts, separates dead entries from unreadable live ones, and groups the plan by fix. Exit 1 means blockers or incomplete checks; optional native preflight is not a required upgrade gate. | Run the selected v5 CLI. Use `--verbose` (or `--all`) for every checkout and `--json` for full detail. Repair or investigate blockers and unchecked findings; an unknown result is not a pass. |
| **`hack upgrade review` batches decisions without applying them.** It runs a fresh read-only check and explains env/key/tracked-file findings across selected checkouts. | Use `--only env-secrets,env-format,env-key,tracked-files` and `--project NAME` to narrow the review. It executes neither fixes nor the commands it prints. |
| **`hack upgrade apply` snapshots and journals selected repairs.** It refreshes ignore rules, removes verified superseded standalone agent files, and removes group/other access from eligible existing keys while preserving owner bits. Blocked or unchecked checkouts are skipped. | Read `hack upgrade apply --dry-run` first; add `--verbose` for paths. Apply does not create/rotate keys, change ownership, untrack files, accept tracked env edits, migrate env or run broad Doctor fixes. Keep its printed recovery commands. |
| **Apply resumes only an explicit run.** `--resume` reuses the saved selection and snapshot; unexpected edits or damaged original blobs refuse. Targets on another filesystem are skipped before snapshot creation. | Use `hack upgrade apply --resume <manifest>`, optionally with `--dry-run`. Do not combine resume with new selection flags. For another volume, select one project with an owned private `--snapshot-root` outside Git on that volume. |
| **`hack upgrade snapshot` writes a private file backup.** Bytes, including selected keys, live in private blobs; the manifest contains metadata. Coverage gaps are reported. | Treat the snapshot as sensitive and retain it until recovery is checked. It does not back up containers, volumes, login services or installed versions. Snapshots do not expire automatically. |
| **`hack upgrade rollback` restores files, not the running system.** With `--rollback-manifest <manifest>`, it restores exact bytes/modes and keeps displaced copies. Without a manifest it only lists snapshots. | Review conflicts before `--overwrite`; it explicitly permits replacing later edits, whose copies are kept. Stop the candidate and restore the chosen executable, daemon and application data separately. |
| **Upgrade JSON findings and steps add `kind: safe`, `admin` or `manual`, separately from severity.** Grouped apply is safe only when all its targets are eligible; a broad Doctor repair stays manual. | Treat missing/unknown kinds as manual and require a command before offering Run. `admin` calls for terminal review, not necessarily sudo. The label grants no authority and bypasses no checks. |

See [assistant coverage and recovery](../versions/v5/guides/upgrade-from-v4.md#check-first)
for selection, snapshot coverage and cross-volume limits.

### Read-only status and administrator plans

These four new JSON contracts are **shape may change before 5.0.0**:
global observe status, project observe listing, version identity, and global
install/trust plans. At this candidate they return bare objects; HACK-2238 will
move them to the `{ ok, data }` envelope before they are declared stable.
Pin the candidate used by a script and review that migration before upgrading.

| Change | What to do |
| --- | --- |
| **`hack global status --json --observe` never starts Docker, services, hackd or a VM.** It runs bounded read-only probes; failed or timed-out evidence is unknown. Ordinary global status can start Docker. | Use observe mode for polling. `--observe` requires `--json`. Exit 0 means a report was printed: inspect the report's true/false/unknown fields. See [the contract](../reference/global-status-observe.md). |
| **`hack projects --json --observe` preserves the registry and avoids daemon/engine contact.** Live state is unknown by default. Ordinary listing keeps its discovery writes. | Use this for read-only registry polling. `--runtime` explicitly opts in to Docker reads, whose socket contact can start an on-demand engine. Native rows still need native `ps`; unknown is not stopped. `--meta` is refused. See [project listing](../cli.md#core-commands). |
| **`hack global install --plan --json` and `hack global trust --plan --json` preview administrator operations without running them.** Steps show privilege, guarded argv and stdin size/digest; bootstrap-dependent phases remain incomplete. | Review the plan, then run the real command in a terminal when intended. No permission is granted by a plan. Exit 0 means complete, 1 refused, 3 incomplete; omitting `--json` with `--plan` exits 2. See [admin plans](../reference/global-admin-plan.md). |
| **`hack version --json` identifies the running CLI.** It reports `version`, `channel`, `install_kind` and `binary_path`, without PATH lookup, network or runtime startup. Text output is unchanged. | Use it to record the build actually running. A source invocation reports Bun's path and `install_kind: source`, not another Hack found on PATH. See [version identity](../reference/version.md). |

### Lifecycle history, commands and recovery

| Change | What to do |
| --- | --- |
| **Lifecycle commands now write activity history.** Compose and native `up`, `down` and `restart` append to `~/.hack/activity.jsonl` (or the selected Hack home), including refused commands that reach the handler. Records are written when the command returns. | Read newest-first history with `hack activity --json`, optionally `--project NAME --limit 100`. Files are private and rotate to one kept generation. Records contain names/outcomes, not env values, argv or paths. This is best-effort history, not a complete audit: a killed command or failed append can leave no record. |
| **Ctrl-C waits for owned lifecycle commands to retire before wrappers and state are removed.** Each phase allows five seconds of TERM grace, then at most one SIGKILL. Transient census failures retry; a second Ctrl-C can request the forced command-group stop. Unknown retirement keeps ownership evidence. | Allow the first stop to finish. Inspect a refusal and use `hack down` or the documented `hack doctor --fix` recovery rather than deleting state. See [lifecycle](../lifecycle.md). |
| **Native terminal exec is interactive.** With foreground terminal stdin/stdout, `hack exec SERVICE -- /bin/sh` streams a sized, resizable terminal and preserves the exit status. Redirects, background shell jobs and `HACK_NO_INTERACTIVE=1` keep finite exec. | Use the same native home/version as the project. Old managed-env launchers need a restart with the matching bundle or finite exec. For an uncertain outcome, inspect `hack exec-sessions`, then use `--reconcile` or project `down` as directed; never replay an unknown command blindly. See [exec and recovery](native-candidate.md#normal-native-exec). |
| **Native `ps` no longer holds a mutation lease, and plain `down` can recover proved, settled failed starts, including before Ready was saved.** Changed journal evidence can still report `runtime_busy`. | Poll normally; retry busy reads. Try ordinary `down` first and follow retained-recovery instructions when proof is incomplete. Do not remove receipts or assume every failed start was cleaned up. |
| **Native followed logs can reattach after a project restart.** Re-admission is bounded to 30 seconds and 1,000 initial replacement-container lines. Session failures emit a named JSON `end`, a stderr diagnostic and exit 1, without an extra global error envelope. | Parse the session's named end; do not treat transport loss as success. Reattach failure and stopped-idle remain explicit failures. See [followed logs](../reference/native-authored-commands.md#followed-service-logs). |
| **Detached native startup names failed services.** It points to foreground output rather than returning only `engine_rejected`. | Rerun without `--detach` to inspect the failed services' last lines; keep sensitive output out of reports. |
| **Compose startup recognizes short successful one-shot services and briefly retries attaching network members.** Exit-zero initializers no longer cause false `E_STARTUP_INCOMPLETE`; persistent placeholders and foreign members still refuse. | Use ordinary `up --detach` or `restart`; inspect real nonzero jobs and ownership refusals. This does not relax ownership checks or every saved-command read. |
| **Native understands standard Hack networks and metadata, and preflight shares start admission.** Exact `hack-dev`/`hack-logging` networks become project-owned bridges; generated labels are inert. Private env with automatic restart and UDP publications can now block preflight instead of failing only at start. | Review preflight findings. These bridges provide neither Docker-global network membership nor cross-project DNS. Use Compose for unsupported topology; do not strip ownership checks to start. |
| **`hack open` warns about a definite DNS miss, or a missing managed resolver on macOS after an unknown lookup.** JSON keeps `url` and adds `dns`/`hint`; timeout alone is not a confirmed miss. `init --auto` warns when it wrote a placeholder instead of discovering a service. | Follow the same CLI's `hack global install` or `hack config set dev_host NAME` hint. Edit a generated placeholder's image/command before `up`. See [first project](../versions/v5/getting-started.md). |

### Background output, secret custody and host setup

| Change | What to do |
| --- | --- |
| **`hack exec --detach` and `hack run --detach` add retained background commands.** CLI and MCP share cursor reads, inspection and cancellation. Output capture has byte and retention limits; an unknown exit is not success. | Keep the returned ID/cursor. Use `hack commands read ID`, `hack commands show ID` and `hack commands cancel ID`; prefer this over a long foreground MCP call. Read [capture and ownership limits](background-commands.md). |
| **Background recovery drops unscanned orphan output when redaction values are lost.** Takeover/sweep truncates unannounced tails, and final sync failures are recorded. Scanning many redaction values now uses one pass. | Handle truncation/unknown outcomes in readers. Partial redaction still misses short, transformed or uninjected values; native output is unredacted. Choose `--capture metadata` when output may contain secrets. |
| **Hack decryption keys no longer pass to ordinary children; env parse errors no longer echo parser messages.** Local-layer writes refuse links, tracked destinations or ineffective ignore rules. Legacy dotenv reads refuse symlinks. | Pass only application env to hooks/host commands. Keep local layers untracked and ignored, correct file boundaries, and fix syntax at the named coordinates; do not expect a raw source excerpt. |
| **Secret stores and writes refuse unsafe or unreadable inputs instead of treating them as empty or replacing a needed key.** Key-file reads reject links, loose access and tracking; writes cannot silently mix project encryption keys. | Recover the existing key and repair the reported file. Explicit provisioning cannot overwrite a different key. Do not create a new key over ciphertext or remove an unreadable store to bypass the refusal. |
| **Lifecycle logs/FIFOs and staging are private; terminal payloads expire.** Local writes tighten loose modes; automatic stale-payload cleanup, like Doctor, preserves live and retired inputs and skips cleanup when configuration cannot be resolved. | Review Doctor hygiene findings. Logs, MCP results and retained argv/output can still contain plaintext or injected instructions; review before sending them to an agent or sharing them. |
| **MCP project selectors explain registration; foreground timeouts are explicit.** Timed-out results add `timedOut: true` and cannot report success. Codex MCP installation adds a 660-second client limit when no value is set; existing choices remain. | Register an explicit project with `hack status`, `hack projects` or `hack init`, or deliberately use the server's current directory. For long work, use background commands or raise `timeoutMs` within its limit. Run `hack mcp install --codex` to adopt the installer setting; it does not change an existing timeout. |
| **Native setup JSON reports files actually acquired.** Entries include byte accounting; supplied archives are `offline`, and complete installed-home reuse has `files: []`. | Do not require a file entry on reuse or count offline input as a download. See [setup](../native/try-it.md#2-prepare-the-runtime). |
| **Updater publication verifies inventory/version and keeps recovery files.** Downloads are bounded/retried; the compiler publishes before the CLI. A caught publication failure restores earlier files. Candidate uninstall moves the channel aside reversibly and retains user homes. | Keep printed recovery manifests until the new install is checked. A killed multi-directory swap may need manual restoration. These updater fixes require the newer updater; old v4 binaries retain old behavior. See [installation recovery](upgrading-from-v4.md#download-and-installation-recovery). |
| **Linux daemon stop proves the live process's Hack home; unavailable service-manager queries refuse instead of looking absent.** Candidate Compose Doctor treats a missing daemon as healthy/optional. | Follow printed manual service steps on refusal. Leave another home's daemon alone; do not use repeated stable daemon starts to repair a candidate trial. |
| **Doctor checks actual local-CA trust, separately from the exported CA file.** Failed reads are unknown. Linux NSS writes now refuse changed database identities, and privileged install cancellation no longer signals a saved reader PID. | Read `local ca trust` in `hack doctor --json` (`caTrust`), then review `hack global trust` if needed. Stop competing certificate-database writers before retrying a changed-file refusal. Host/browser verification remains separate. |

Detached native starts do not show per-key "unresolved input" notices because
the owner's stdio is ignored. Use a foreground start or native preflight to
inspect those notices; only forwarded shell names and the fixed ignored-root
dotenv notice reach the detached caller.

Native `.env` admission refuses **every** `COMPOSE_*` key, broader than Compose's
recognized control-variable set. Native reserves the whole prefix so new Compose
controls cannot silently become ordinary interpolation inputs: project, file and
profile selection stay explicit. Rename application-specific variables without
that prefix. This rule applies to the adjacent interpolation `.env`, not every
literal service `env_file` entry.

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
Reader summaries now group linked worktrees under their project, with a count
and up to three examples. Unchecked registry entries point to
`hack projects prune --dry-run`; preview before pruning.

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

### Prerelease behavior changes

Plain native `hack logs --follow` output omits the service prefix (such as `web | `)
and writes both service stdout and stderr to the CLI's stdout, so pipes receive both.

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
