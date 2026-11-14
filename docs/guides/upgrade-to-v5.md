# Upgrade to v5

For the summary of the release, read [What's new in Hack 5.0](v5-release-notes.md).

v5 keeps the v4 project model and commands. Your `.hack/` folder, encrypted env
values, branch instances, lifecycle processes and sessions carry over. What changes
is the runtime layer underneath and the product boundary around it.

## What stays the same

- Docker Compose is the ordinary CLI's default backend. Familiar command names
  remain, but env migration and value handling need review before upgrading.
- Project configuration stays in `.hack/`; legacy env files can be migrated.
- Shared local routing, `.hack.local` names and certificate trust are unchanged.

## What is new

- **Native backend (beta, Apple Silicon macOS).** Through the `hack-next` channel only,
  `HACK_RUNTIME_BACKEND=native` runs explicitly prepared projects without Docker. It
  supports a bounded command subset and is qualified project by project. See
  [the native backend overview](../native/README.md).
- **A config compiler.** `hack config validate`, `config plan`, `config import
  --dry-run` and `config adopt --dry-run` inspect and preview native configuration
  without starting workloads. See [Native config import](../reference/native-config-import.md).
- **`hack dev`.** Runs a repository's declared development command from a committed
  `.hack/dev.json`, without Docker. It first shipped in 4.3.0; if you are coming from
  an older v4, it is new to you. See [Side-by-side development](../dev.md).
- **A separate prerelease channel.** `hack-next` installs immutable `5.0.0-next.N`
  builds beside stable Hack. See [Install a prerelease](candidate-install.md).
- **Stricter command parsing.** Hack options go before the command tail. For
  `exec`, `run` and `host exec`, everything after the service or `--` is passed
  through unchanged.
- **Safer env handling.** `hack env hydrate` imports values from a file or stdin so
  secrets never appear in command arguments. The env migration preserves
  secret-store and legacy values.

## What was retired

| Retired | Use instead |
| --- | --- |
| Hosted accounts, organizations and teams | Nothing; Hack is local-only |
| The web dashboard | `hack status`, `hack ps`, `hack tui` |
| Hack Tickets | The tracker your project already uses |
| Built-in GitHub and Linear integrations | `git`, `gh` and the tracker's own CLI |
| Automatic agent instruction injection (`hack setup sync`, primer hooks, injected rules) | The opt-in `hack` plugin and `hack agent onboard`; see [Agent integrations](../integrations.md) |

Remote, gateway, node and dispatch commands and the macOS app remain in the
repository but are unsupported; see [unsupported retained surfaces](../extensions.md).

## Upgrade path

1. Keep stable v4 installed. Install the current prerelease with `hack-next` as
   described in [Install a prerelease](candidate-install.md).
2. Run one project on the prerelease using the Compose backend. Stop the stable
   daemon first; v4 and the prerelease must not run against the same home at once.
   The exact order is in
   [Stop stable hackd before a Compose run](candidate-install.md#stop-stable-hackd-before-a-compose-run).
3. Check the application itself: sign-in, data-backed pages, and anything written
   before a restart that must still be there after it.
4. Only then try the native backend on a disposable project, following
   [try the native backend](../native/try-it.md) and the staged plan in
   [Qualify a project on v5](v5-dogfooding.md).

When 5.0.0 ships, `brew upgrade hack` or the release installer moves the stable
executable to v5. Review env migration before the Compose trial.

## Secrets after upgrading

The next.17 env changes hide all values in ordinary `env list` output and add
`env protect` to encrypt selected plaintext YAML entries in place. Check that
the installed release contains those changes before using the new command.
For scripts, use `env list --json` and `has_value` for metadata, or an explicit
`env get KEY` with the same scope/overlay when a value is needed. `env get`
prints plaintext; keep it out of logs and reports. `--show-values` (also spelled
`--show-secrets`) requires terminal stdin/stdout and interaction enabled, so it
is not a bulk script interface.

Run `hack env protect` for a names-only inventory, then select the keys to
protect. This preserves their values, scopes and layers; it does not remove
legacy compatibility copies. Keep `--secret --value-stdin` on later secret
updates. See [the env command guidance](../env.md#common-commands).

Keep these manual checks too:

- Check ownership and permissions of `.hack/hack.env.local.yaml` and
  `.hack/hack.env.<name>.local.yaml`. New local layers are created mode 0600,
  but next.16 keeps existing modes. The merged #764 change, intended for
  next.17, tightens a local layer on a write and lets Doctor fix loose files
  without waiting for that write. Keep local layers owner-only.
- Check Git's tracked-file list for `.hack/.env.<name>` and
  `hack.env*.local.yaml`. next.16's managed ignore block omitted legacy overlay
  dotenv names; newer ignore rules still cannot untrack an existing file.
  Review and remove any tracked sensitive files from the index without
  deleting the local copy; treat earlier commits as a possible disclosure.
- Values migrated from v4 plaintext dotenv files remain plain until explicitly
  protected or re-added with `--secret`. next.16's `env list`, including JSON,
  prints plain values; hiding them in a newer listing is not encryption.
- Keep the project key and all backup copies private. Review logs, MCP results,
  multiplexer temporary files and retained background output as possible
  plaintext sinks; encryption at rest does not protect those outputs.

**On next.16 or an earlier prerelease, keep a private readable copy of
`.hack.secret.key` before `doctor --migrate-env-config`.** HACK-2172 lets
explicit cleanup delete that key when a legacy store's `keyPath` names it.
The live-input protection fix is merged for next.17: current project/shared
keys, config and YAML inputs are not cleanup targets, including filesystem
aliases, and cleanup refuses a request that names one. It cannot recover a key already removed by an older
build. Back up original keys and env state before migration on any version.

Merged #764 (HACK-2165), intended for next.17, adds the
[Doctor secrets-hygiene report and fixes](#after-upgrading-check-secrets-at-rest)
below. next.16 already reports `env-key-weak-permissions` with a `chmod 600`
remedy, but does not include the broader hygiene report.

See [Env and secrets](../env.md#legacy-repos-and-migration) and the
[threat model](../security/env-secrets-threat-model.md). These are manual checks,
not evidence that the real-machine upgrade or rollback has passed.

## Preview, resume and undo env migration

HACK-2191 follows next.17. In a build containing it, use `hack env migrate --json` to review names and
file paths before applying. `hack env migrate --apply` snapshots originals outside
the working tree and records resumable steps; repeat the same command after an
interruption. Add `--accept-tracked-env-changes` only when consenting to the
previewed shared edits. `doctor --migrate-env-config` still applies the migration,
alongside its existing hygiene repairs; the env journal covers migration writes,
not earlier doctor repairs. Use `hack env migrate --apply` for migration-only
preview and rollback. Snapshot storage and the target files must share a
filesystem; apply refuses before writing project files if rollback would cross one.
Every migrating route now retains all legacy copies, including untracked dotenv files and tracked
`hack.env.json`. Implicit migrations retain them too.

After checking a successful complete-project `hack up`, preview the separate
cleanup with `hack env migrate --cleanup --json`, then apply it explicitly with
`--cleanup --apply`. Cleanup rechecks delivery, live inputs and the original
snapshot. Restore with `hack env migrate --rollback-manifest <path>`; it refuses
later edits and preserves replaced data. Keep snapshot blobs and the migration
journal until the upgrade is accepted. See the [env migration
protocol](../reference/env-migration.md).
If later edits block rollback, `--rollback-manifest <path> --preserve-changes`
explicitly restores originals and keeps those edits privately for recovery.
Rollback retains project/shared keys and their required ignore entry because
another checkout may already depend on them.

## After upgrading, check secrets at rest

Earlier versions could leave env values and keys more exposed than v5 does:
machine-local env files created by hand or by an older release with mode 0644,
staging copies of `.hack/.env` or the project key under names git does not
ignore, env values staged for a terminal session that never ran, or an
encrypted secret store whose key file is gone. In a build containing #764, run this once
in each project, and once outside any project for the global Hack home:

```bash
hack doctor          # read the "secrets hygiene" section
hack doctor --fix    # apply the fixes after reviewing the report
```

The "secrets hygiene" section reports loose modes, links, tracked or unignored
secret-bearing files, staging leftovers and stale terminal-session payloads.
It names files and what they hold, never values. `hack doctor --fix` removes
group and other permission bits from eligible files owned by this user, adds
missing ignore entries inside the project, and removes Hack's staging leftovers
and terminal payloads older than ten minutes. It prints each change.

Removal never includes a live input: the configured store or key, project/shared
keys, config and env layers are protected by their paths and resolved paths.
Doctor rechecks the configuration before each removal and leaves the file when
it cannot prove removal is allowed. Retired stores are kept too. It never deletes
a store, a key or a file you wrote, and never untracks a file git already tracks.
Review any suggested `git rm --cached` and treat earlier shared copies as exposed.
For a store whose key is lost, use the restore-or-retire choices below, not hygiene
cleanup. Keep these repairs separate from `--migrate-env-config` and its backup step.

### An old global secret store whose key is gone

Merged #779, intended for next.17, makes an old store with a missing or wrong
key a Doctor error only where the project's runtime reads it. Other projects
receive a warning. Choose one: restore the original key from a private backup,
or retire the store if the key is gone for good. A new key cannot open the old
entries.

`hack secrets retire-store --path <project>` selects the store for that project
and moves it into a timestamped directory beside it. It deletes nothing, leaves
the key file alone and prints how to put the encrypted file back. Retirement
does not decrypt or print entries. Doctor then lists the retired file as
information.

Retiring requires `--allow-unchecked` because another shell may hold the key in
`HACK_SECRETS_FILE_KEY`, which Hack cannot check. Pass it only after confirming
that no shell for a project selecting the store has that key; it also acknowledges
registered projects Hack could not check. Without a terminal, add `--yes` to
confirm the move. A store that an available key opens is refused. See
[the recovery and retirement details](../env.md#compatibility-notes).

## The daemon after an upgrade

Installing 5.0.0 over a running 4.x does not replace the daemon. On Linux the old
`hackd` keeps running: `hack daemon status` reports `incompatible` and exits 1,
while `hack status` and `hack projects --json` still work. Replace it yourself:

```bash
hack daemon restart
```

`hack daemon start` does the same and prints `Replacing incompatible hackd (pid N)`.
This was checked on Linux x86_64, upgrading 4.3.0 to a 5.0.0 build. The macOS
behavior has not been checked yet.
