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
  but existing layers keep their modes. Keep local layers owner-only and do
  not assume an upgrade tightened old files.
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
keys, config and YAML inputs are not cleanup targets, and cleanup refuses a
request that names one. It cannot recover a key already removed by an older
build. Back up original keys and env state before migration on any version.

The broader Doctor secrets-hygiene report and repairs (HACK-2165, #764) are a
separate change; check the chosen release's availability. next.16 already
reports `env-key-weak-permissions` and suggests `chmod 600` for an old loose key.

See [Env and secrets](../env.md#legacy-repos-and-migration) and the
[threat model](../security/env-secrets-threat-model.md). These are manual checks,
not evidence that the real-machine upgrade or rollback has passed.

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
