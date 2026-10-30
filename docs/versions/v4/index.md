# Documentation

Hack keeps the parts needed to run a project together: services, environment,
secrets, local URLs, startup helpers and logs. The setup lives with your repository.

Start with [Install](install.md), then [Getting started](getting-started.md).

## Understand the project

- [Core concepts](../core.md): projects, services and running instances.
- [Environment and secrets](../env.md): share configuration and keep keys separate.
- [Lifecycle](../lifecycle.md): start helpers with the project.
- [Sessions](../sessions.md): persistent workspaces.

## Do a task

- [Run and inspect a project](guides/run-project.md)
- [Choose where a command runs](guides/run-commands.md)
- [Work on another branch](guides/parallel-work.md)
- [Share environment and secrets](guides/share-environment.md)
- [Manage helpers and tunnels](guides/project-helpers.md)
- [Use a cloud agent or another host](guides/cloud-environments.md)

## Work with an agent

[Agent handoff](agent-handoff.md) supplies this version's documentation exports
and setup instructions. [Agent integrations](../integrations.md) describes the
matching optional client setup.

## Find details or diagnose a problem

Use the [CLI overview](../cli.md) to choose a command, the
[command reference](../reference/cli.md) for flags, [contracts](reference/overview.md) for schemas and agent interfaces, and
[Architecture](../architecture.md) for the runtime model.
Run `hack doctor` on the machine running Hack and follow the specific diagnosis.
