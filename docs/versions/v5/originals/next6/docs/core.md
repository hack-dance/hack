# Core concepts

Hack keeps the parts needed to run a project together: services, environment,
secrets, local URLs, startup helpers and logs. The setup lives in `.hack/` in the
repository, so teammates and agents can use the same definition.

## Project, service and instance

A **project** is a repository with Hack configuration. A **service** is one part of
that project, such as a web app, API or database. An **instance** is a running copy
of the project. Branch instances let you run different versions side by side.

The supported runtime uses Docker Compose for services and shared local routing
for HTTPS. New projects use `.hack.local` names. Existing `.hack` names and custom
domains keep working. Use `hack open` to find the URL for your instance rather than
guessing a port or hostname.

## Start, inspect and stop

Follow [Getting started](guides/getting-started.md) for installation and routing,
then [Project setup](guides/init-project.md) to configure a repository.
From a configured project:

```sh
hack up --detach
hack open
hack ps
hack logs --pretty
```

`hack up` starts the declared services and project lifecycle. Use `hack ps` to
inspect them and `hack logs` to read their output. When finished:

```sh
hack down
```

If startup fails, read the reported error and run `hack doctor`. Apply a repair
only after checking which resources or settings it affects.

## Keep configuration with the project

[Environment and secrets](env.md) explains committed configuration and encrypted
values. Keep the decryption key separate from git. [Lifecycle](lifecycle.md)
explains how to declare startup hooks and host helpers, such as tunnels, so they
start with the project instead of relying on an extra terminal tab.

## Work on more than one branch

In a linked git worktree, `hack up` defaults to a branch instance named after the
git branch. The secret key is inherited from the primary checkout through the
shared git directory. A detached worktree needs an explicit `--branch <name>`.
See [Worktrees and watchers](guides/development-runtime-safety.md) for shared files,
watchers and dependency caches, and [Sessions](sessions.md) for persistent project
workspaces.

## Use Hack from an agent or script

Agents can use the same CLI. `--json` returns structured results and
`--no-interactive` prevents a command from waiting for terminal input. Optional
[agent setup](guides/agent-first-setup.md) helps configure a project; no agent plugin
or hosted account is required for the core workflow.

Use the [CLI overview](cli.md) to choose a command and the
[command reference](reference/cli.md) to find its flags. The native v5 runtime has
separate [experimental guidance](guides/v5-dogfooding.md).
