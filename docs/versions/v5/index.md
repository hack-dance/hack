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

## Start here

1. [Install v5](install.md): choose a channel and set up Compose routing.
2. [First project on Compose](getting-started.md): set up, start, open, read logs and stop.
3. [Upgrade from v4](upgrade.md): back up first, try one project and roll back.
4. [Try native on Apple Silicon](native/start.md): prepare, check, start and return to Compose.

[Troubleshooting](troubleshooting.md) maps common Doctor findings to their fixes.
[What's new in 5.0](../guides/v5-release-notes.md) summarizes the release.
v5 prerelease bundles are Apple Silicon macOS only; see
[Install](install.md#prerequisites) for platform support.

## Understand the project

- [Global settings](../guides/global-settings.md): machine-wide configuration and proxy bind addresses.
- [Core concepts](../core.md): projects, services, instances and local URLs.
- [Environment and secrets](../env.md): committed configuration with encrypted values.
- [Lifecycle](../lifecycle.md): hooks, tunnels and host helpers that start with the project.
- [Sessions](../sessions.md): persistent terminal workspaces per project.
- [Side-by-side development](../dev.md): `hack dev` runs a repository's declared dev command.

## Do a task

- [Start projects at login](https://github.com/hack-dance/hack/blob/next/docs/always-on-projects.md)
- [Set up a Linux host](../guides/linux-setup.md): local DNS, trust and the daemon.
- [Configure Linux certificate trust](../guides/linux-certificate-trust.md): distribution and browser trust stores.
- [Upgrade a v4 machine to v5](guides/upgrade-from-v4.md): preparation, rollback and checks awaiting the dogfood run.
- [Run and inspect a project](guides/run-project.md)
- [Choose where a command runs](guides/run-commands.md)
- [Work on another branch](guides/parallel-work.md)
- [Share environment and secrets](guides/share-environment.md)
- [Manage helpers and tunnels](guides/project-helpers.md)
- [Use a cloud agent or another host](guides/cloud-environments.md)
- [Try the native backend (beta)](../guides/native-candidate.md)

## Recipes

[Recipes](recipes/overview.md) has complete Compose projects for
[common app configurations](recipes/config-examples.md),
[environment overlays](recipes/environments.md), dependencies, migrations,
tunnels and cleanup. Their footers identify the example source revision, and
each page distinguishes the compatibility audit from its original execution notes.

## Native backend (beta)

A second way to run the same project on an Apple Silicon Mac. Hack starts its own
Linux virtual machine instead of using a Docker app. It is opt-in, and Compose
stays the default.

- [Overview](native/overview.md): what it is, what it is not, and why to try it.
- [Try it](native/try-it.md): install, run one project on native, switch back.
- [Native preflight](native/preflight.md): list blockers before starting a Compose project on native.
- [Prepare the runtime](native/setup.md): explicit setup, under verification.
- [Follow native service logs](native/log-follow.md): live observation, under verification.
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

[Repair the shared proxy network](guides/proxy-network-repair.md) when Doctor
finds a proxy container on the wrong network or address.
