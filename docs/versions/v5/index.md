# Documentation

Hack runs the whole project on your machine: services, environment, secrets,
local HTTPS URLs, startup helpers and logs, all from a small `.hack/` folder
committed with the repository. One command starts a repo. Projects and branches
run side by side without colliding. Nothing is hosted.

v5 is the same CLI and project model as v4 with a new runtime layer underneath.
Docker Compose stays the default backend. The native backend (beta, Apple Silicon
macOS) is opt-in and ships only through the `hack-next` channel, not in the stable
archives or the Homebrew formula. Read [Upgrade from v4](upgrade.md) for what
changed and what was retired.

Start with [Install](install.md), then [Getting started](getting-started.md).

## Understand the project

- [Core concepts](../core.md): projects, services, instances and local URLs.
- [Environment and secrets](../env.md): committed configuration with encrypted values.
- [Lifecycle](../lifecycle.md): hooks, tunnels and host helpers that start with the project.
- [Sessions](../sessions.md): persistent terminal workspaces per project.

## Do a task

- [Run and inspect a project](guides/run-project.md)
- [Choose where a command runs](guides/run-commands.md)
- [Work on another branch](guides/parallel-work.md)
- [Share environment and secrets](guides/share-environment.md)
- [Manage helpers and tunnels](guides/project-helpers.md)
- [Use a cloud agent or another host](guides/cloud-environments.md)
- [Try the native backend (beta)](../guides/native-candidate.md)

## Native backend (beta)

A second way to run the same project on an Apple Silicon Mac. Hack starts its own
small Linux virtual machine instead of using a Docker app. It is opt-in, and Compose
stays the default.

- [Overview](native/overview.md): what it is, what it is not, and why to try it.
- [Try it](native/try-it.md): install, run one project on native, switch back.
- [What works and known limits](native/limits.md)

## Work with an agent

[Agent handoff](agent-handoff.md) gives an agent this version's documentation
exports and a short brief. [Agent integrations](../integrations.md) covers the
optional `hack` plugin, its skills and the separate MCP server.

## Find details or diagnose a problem

Use the [CLI overview](../cli.md) to choose a command, the
[command reference](../reference/cli.md) for flags, the
[reference index](reference/overview.md) for schemas and agent interfaces, and
[Architecture](../architecture.md) for the runtime model. When something looks
wrong, run `hack doctor` on the machine running Hack and follow its diagnosis.
