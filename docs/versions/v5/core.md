# Core concepts

Hack keeps the parts needed to run a project together: services, environment,
secrets, local URLs, startup helpers and logs. The setup lives in `.hack/` in the
repository, so teammates and agents use the same definition.

## Project, service and instance

A **project** is a repository with Hack configuration. A **service** is one part of
that project, such as a web app, API or database. An **instance** is a running copy
of the project. Branch instances let you run different versions side by side, each
at its own URL.

New projects get `https://<project>.hack.local` with per-service subdomains such as
`api.<project>.hack.local`. Existing `.hack` names, `.hack.gy` OAuth aliases and
custom domains keep working. Use `hack open` to find an instance's URL rather than
guessing a port or hostname.

## Backends

The **Compose backend** is the default. It runs services with Docker Compose behind
shared local routing. Every command on this site works there.

The **native backend** is beta and opt-in. On Apple Silicon macOS it runs an
explicitly prepared project without Docker, with a bounded command subset. Select it
with `HACK_RUNTIME_BACKEND=native`. Read [Try the native backend](../guides/native-candidate.md)
before using it; a Compose example does not imply native support for the same flag.

## Start, inspect and stop

```sh
hack up --detach
hack open
hack ps
hack logs --pretty
```

`hack up` starts the declared services and the project lifecycle. `hack ps` shows
service state, including stopped one-shot containers with their exit codes. `hack
logs` reads service output. When finished:

```sh
hack down
```

If startup fails, read the error and run `hack doctor`. Review what a repair
touches before applying it with `hack doctor --fix`.

## Keep configuration with the project

[Environment and secrets](../env.md) explains committed configuration and
per-value encryption. Keep the decryption key out of git. [Lifecycle](../lifecycle.md)
declares startup hooks and host helpers such as tunnels, so they start with the
project instead of in a spare terminal tab.

## Work on more than one branch

In a linked git worktree, `hack up` defaults to a branch instance named after the
branch. The secret key is inherited from the primary checkout. A detached worktree
needs an explicit `--branch <name>`. See [Work on another branch](guides/parallel-work.md)
and [Worktrees and watchers](../guides/development-runtime-safety.md).

## Use Hack from an agent or script

Agents use the same CLI. `--json` returns structured results with stable error codes
and `--no-interactive` prevents a command from waiting for input. No plugin, server
or account is required. [Agent handoff](agent-handoff.md) and
[Agent integrations](../integrations.md) cover the optional extras.
