# Core concepts

Hack keeps the parts needed to run a project together: services, environment,
secrets, local URLs, startup helpers and logs. The setup lives in `.hack/` in the
repository, so teammates and agents use the same definition.

Use `hack resources list --json` or the desktop **Resources** pane to
inspect observed containers and attachments. The report includes Docker's
disk-size estimates, the native home's allocated bytes, and retained native
volume observations where available. A detached row has a missing checkout.

Use `hack resources remove volume:<name> --dry-run --json` to review removal,
then pass its token with `--confirm`. Interactive removal prompts before
deleting. The desktop presents the same preview and requires explicit
confirmation. Cleanup requires a matching launch receipt and fresh engine
evidence, so growing the inventory alone never grants cleanup permission.
A named Compose volume needs a deleted checkout and zero container references.
Native persistent data remains protected for graph restore.

## Project, instance and branch instance

- A **project** is a repository with a `.hack/` folder. It has a name, which Hack
  uses for its instances, logs and helpers. By default its address starts with
  that name too.
- An **instance** is one running copy of a project: its containers, its
  addresses, its logs.
- A **branch instance** is a second instance of the same project, named after a
  branch. `hack up` in a linked git worktree starts one, named after its branch.

A **service** is one part of a project, such as a web app, API or database. Each
instance runs its own copy of every service.

New projects get `https://<project>.hack.local` with per-service subdomains such as
`api.<project>.hack.local`. Existing `.hack` names, `.hack.gy` OAuth aliases and
custom domains keep working. Use `hack open` to find an instance's URL rather than
guessing a port or hostname.

## Backends

A **backend** runs the containers. Stable `hack` uses the Compose backend with
shared local routing. The general project examples here also use Compose.

Native is the planned default for stable v5. The current `hack-next` prerelease
defaults to native on Apple Silicon macOS and uses Compose on supported Linux.
On macOS, set `HACK_RUNTIME_BACKEND=compose` for the Compose examples. Set
`HACK_RUNTIME_BACKEND=native` to select the native backend explicitly on Apple
Silicon. The beta runs prepared projects without Docker Desktop or OrbStack.
Read [the native backend overview](native/overview.md)
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
needs an explicit `--branch <name>` unless you set `worktree.auto_branch=false` to select the base instance. See [Run a branch or worktree beside main](guides/parallel-work.md)
and [Worktrees and watchers](../guides/development-runtime-safety.md).

## Use Hack from an agent or script

Agents use the same CLI. `--json` returns structured results with stable error codes
and `--no-interactive` prevents a command from waiting for input. On the Compose
backend, `hack up|down|restart --json --progress` streams ndjson progress lines
before the final envelope. No plugin, server
or account is required. [Agent handoff](agent-handoff.md) and
[Agent integrations](../integrations.md) cover the optional extras.

## Interactive workspaces

A [session](../sessions.md) is a named tmux session that Hack starts in a project's repository, with the project's env loaded. Use `hack session start <project>` for a terminal that survives a closed window or a lost SSH connection, and that a person or a coding agent can come back to by name. It is not a sandbox. v5 requires tmux; `sessions.mux=auto` detects tmux only. If upgrading from zellij, install tmux and unset `sessions.mux` or set it to `tmux`. See the [upgrade checklist](guides/upgrade-from-v4.md#breaking-change-zellij-workspaces-removed).
