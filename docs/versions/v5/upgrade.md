# Upgrade from v4

For the summary of the release, read [What's new in 5.0](../guides/v5-release-notes.md).

v5 keeps the v4 project model and commands. Your `.hack/` folder, encrypted env
values, branch instances, lifecycle processes and sessions carry over. What changes
is the runtime layer underneath and the product boundary around it.

## What stays the same

- Docker Compose is still the default backend. `hack up`, `hack down`, `hack
  logs`, `hack env`, `hack host exec` and the rest behave as in v4.
- Project configuration stays in `.hack/`. Legacy env files may need migration;
  use the [machine upgrade checklist](guides/upgrade-from-v4.md) before running it.
- Shared local routing, `.hack.local` names and certificate trust are unchanged.

## What is new

- **Native backend (beta).** On Apple Silicon macOS, through the `hack-next`
  channel, `HACK_RUNTIME_BACKEND=native` runs explicitly prepared projects without
  Docker Desktop or OrbStack. It supports a bounded command
  subset and is qualified project by project. See
  [Native backend (beta)](native/overview.md).
- **A config compiler.** `hack config validate`, `config plan`, `config import
  --dry-run` and `config adopt --dry-run` inspect and preview native configuration
  without starting workloads. See [Native config import](../reference/native-config-import.md).
- **A separate prerelease channel.** `hack-next` installs immutable `5.0.0-next.N`
  builds beside stable Hack. See [Install](install.md).
- **Stricter command parsing.** Hack options go before the command tail. For
  `exec`, `run` and `host exec`, everything after the service or `--` is passed
  through unchanged, so a child's `--json` or `--help` is never read as a Hack flag.
- **Safer env handling.** `hack env hydrate` imports values from a file or stdin
  so secrets never appear in command arguments.

## What was retired

These shipped in earlier major versions and are gone from v5. Use ordinary tools
in their place.

| Retired | Use instead |
| --- | --- |
| Hosted accounts, organizations and teams | Nothing to replace; Hack is local-only |
| The web dashboard | `hack status`, `hack ps`, `hack tui` |
| Hack Tickets | The tracker your project already uses |
| Built-in GitHub and Linear integrations | `git`, `gh` and the tracker's own CLI |
| Automatic agent instruction injection (`hack setup sync`, primer hooks, injected rules) | The opt-in `hack` plugin and `hack agent onboard`; see [Agent integrations](../integrations.md) |

Remote, gateway, node and dispatch commands and the macOS app remain in the
repository but are unsupported. They are hidden from `hack help` and warn when
invoked.

## Upgrade path

1. Keep stable v4 installed. Install the current prerelease with `hack-next` as
   described in [Install](install.md).
2. Run one project on the prerelease using the Compose backend. Stop the stable
   daemon first; v4 and the prerelease must not run against the same home at once.
3. Check the application itself: sign-in, data-backed pages, and anything written
   before a restart that must still be there after it.
4. Only then try the native backend on a disposable project, following
   [Try the native backend](native/try-it.md).

When 5.0.0 ships, `brew upgrade hack` or the release installer moves the stable
executable to v5. Review legacy env migration before the Compose trial; the
[machine upgrade checklist](guides/upgrade-from-v4.md) records the steps and open checks.

## The daemon after an upgrade

Installing 5.0.0 over a running 4.x does not replace the daemon. On Linux the old
`hackd` keeps running: `hack daemon status` reports `incompatible` and exits 1,
while `hack status` and `hack projects --json` still work. Replace it yourself:

```bash
hack daemon restart
```

This was checked on Linux x86_64. The macOS behavior has not been checked yet.
