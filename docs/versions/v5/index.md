# Documentation

Hack runs your whole project from one folder committed with the code: the
services, the settings and encrypted secrets, and the helpers around them.
Branches run side by side, each at its own HTTPS address, and a git worktree on
a branch gets its own running copy by default. The same folder starts the
project on another machine with Docker. Nothing is hosted.

That folder is `.hack/`. One command, `hack up`, starts the services, loads the
settings and secrets, gives the project its local HTTPS addresses and starts its
helpers. People and coding agents can each run and test their own running copy,
which these pages call an instance.

## Start here

1. [Install v5](install.md): choose a channel and set up Compose routing.
2. [First project on Compose](getting-started.md): set up, start, open, read logs and stop.
3. [Upgrade from v4](upgrade.md): back up first, try one project and roll back.
4. [Try native on Apple Silicon](native/start.md): prepare, check, start and return to Compose.

[Troubleshooting](troubleshooting.md) maps common Doctor findings to their fixes.
[What's new in 5.0](../guides/v5-release-notes.md) summarizes the release.

v5 is the same CLI and project model as v4, with a new way to run services
underneath.
Which backend runs depends on the channel. Stable Hack runs Docker Compose. In
the `hack-next` prerelease, with no backend selected, the launcher picks the
native backend (beta) on Apple Silicon macOS and Compose on Linux;
`HACK_RUNTIME_BACKEND=compose` selects Compose on a Mac. The native backend ships
only through the `hack-next` channel, not in the stable archives or the Homebrew
formula. Read [Upgrade from v4](upgrade.md) for what
changed and what was retired.
The v5 prerelease installs on Apple Silicon macOS and, with the Compose backend
only, on Linux x86_64 and arm64; see [Install](install.md#prerequisites) for
platform support.

## Understand the project

- [Global settings](../guides/global-settings.md): machine-wide configuration and proxy bind addresses.
- [Core concepts](../core.md): projects, services, instances and local URLs.
- [Environment and secrets](../env.md): committed configuration with encrypted values.
- [Lifecycle](../lifecycle.md): hooks, tunnels and host helpers that start with the project.
- [Sessions](../sessions.md): persistent terminal workspaces per project.
- [Side-by-side development](../dev.md): `hack dev` runs a repository's declared dev command.

## Do a task

- [Run and inspect a project](guides/run-project.md)
- [Run a branch or worktree beside main](guides/parallel-work.md)
- [Share environment and secrets](guides/share-environment.md)
- [Choose where a command runs](guides/run-commands.md)
- [Manage helpers and tunnels](guides/project-helpers.md)
- [Scripts and JSON output](guides/machine-output.md): what `--json` prints, and where hook output goes.
- [Use a cloud agent or another host](guides/cloud-environments.md)
- [My Mac is slow](guides/slow-mac.md): start from the symptom, then let `hack doctor` name the cause.
- [Start projects at login](https://github.com/hack-dance/hack/blob/next/docs/always-on-projects.md)
- [Breaking changes from v4](guides/breaking-changes.md): one list, with the reason for each and how to go back.
- [Upgrade a v4 machine to v5](guides/upgrade-from-v4.md): preparation, rollback and checks awaiting the dogfood run.
- [Set up a Linux host](../guides/linux-setup.md): local DNS, trust and the daemon.
- [Configure Linux certificate trust](../guides/linux-certificate-trust.md): distribution and browser trust stores.
- [Desktop app (preview)](guides/desktop-app.md): what the window shows, how it finds the CLI, and what it never does.
- [Try the native backend (beta)](../guides/native-candidate.md)

## Recipes

[Recipes](recipes/overview.md) has complete Compose projects for
[common app configurations](recipes/config-examples.md),
[environment overlays](recipes/environments.md), dependencies, migrations,
tunnels and cleanup. Their footers identify the example source revision, and
each page distinguishes the compatibility audit from its original execution notes.

## Native backend (beta)

A second backend for the same project on an Apple Silicon Mac. It runs the same
Compose file in a lightweight Linux VM that Hack manages, without a Docker app.
It ships only through `hack-next`, where it is what runs on a Mac unless you
select Compose. It is not a sandbox, and we make no speed, memory or battery
claim for it.

- [Overview](native/overview.md): what it is, what it is not, and why to try it.
- [Try it](native/try-it.md): install, run one project on native, switch back.
- [Native preflight](native/preflight.md): list blockers before starting a Compose project on native.
- [Run an existing Compose project on native](native/existing-compose-project.md): the settings file, opt-ins, HTTPS beside the Compose proxy and the native CA.
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
