# Upgrade to v5

For the summary of the release, read [What's new in Hack 5.0](v5-release-notes.md).

v5 keeps the v4 project model and commands. Your `.hack/` folder, encrypted env
values, branch instances, lifecycle processes and sessions carry over. What changes
is the runtime layer underneath and the product boundary around it.

## What stays the same

- Docker Compose is the default backend. `hack up`, `hack down`, `hack logs`,
  `hack env`, `hack host exec` and the rest behave as in v4.
- Project configuration stays in `.hack/`. No config rewrite is required.
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
executable to v5. Projects need no changes to keep running on Compose.

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
