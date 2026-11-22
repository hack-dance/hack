# Hack documentation

Hack runs your whole project from one folder committed with the code: the
services, the settings and encrypted secrets, and the helpers around them.
Branches run side by side, each at its own HTTPS address, and a git worktree on
a branch gets its own running copy by default. The same folder starts the
project on another machine with Docker. Nothing is hosted.

That folder is `.hack/`. One command, `hack up`, starts the project's services,
loads its settings and secrets, and gives it a local web address with working
HTTPS. Teammates, coding agents and other worktrees all run it the same way, and
each gets its own running copy, which these pages call an instance. The public
site is [hack.foo](https://hack.foo).

## Run your first project

Start with [Getting started](guides/getting-started.md). You install Hack, set up
local addresses once per machine, add Hack to a repository, and start it with
`hack up --detach`. Hack runs services with Docker Compose by default. You do not
need an account.

Already have a project? Follow [Project setup](guides/init-project.md), or use
[Agent setup](guides/agent-first-setup.md) to let an agent configure it.

## Work on a project

- [Core concepts](core.md) — projects, services, instances and local URLs.
- [Environment and secrets](env.md) — committed configuration with encrypted values.
- [Lifecycle](lifecycle.md) — hooks, tunnels and host helpers that start with the project.
- [Sessions](sessions.md) — persistent terminal workspaces per project.
- [Worktrees and watchers](guides/development-runtime-safety.md) — run branches side by side.
- [Side-by-side development](dev.md) — `hack dev` runs a repository's declared dev command.
- [Another machine or a cloud agent](versions/v5/guides/cloud-environments.md) — start the project on another machine with Docker; the page says where that has been run.
- [Managed environments](guides/codex-managed-environments.md) — settings and host commands on another machine, without containers.
- [Agent integrations](integrations.md) — the optional `hack` plugin and the separate MCP server.
- [Recipes](recipes/README.md) — step-by-step setups for other tools and everyday workflows, and [copy-paste config examples](recipes/config-examples.md).

## Find a command or fix setup

- [CLI overview](cli.md) explains which command to use; the [command reference](reference/cli.md) lists every flag.
- [Global settings](guides/global-settings.md) covers machine-wide configuration.
- [macOS connectivity](guides/macos-browser-network.md) and [certificate trust](guides/macos-certificate-trust.md) explain local URL problems.
- [Linux certificate trust](guides/linux-certificate-trust.md) covers the distribution trust store and browsers on Linux.
- [Linux host setup](guides/linux-setup.md) covers DNS, trust and the daemon on Linux.
- [Architecture](architecture.md) explains how the pieces fit together.

If something is wrong, run `hack doctor` and follow the diagnosis. Review what a
repair touches before `hack doctor --fix`.

## Native backend (beta)

The native backend (beta, Apple Silicon macOS) is a second way to run the same
project: Hack starts its own Linux virtual machine instead of using a Docker
app. It ships only through the `hack-next` prerelease channel, not in stable
Hack. Stable Hack runs Compose. `hack-next` runs native on an Apple Silicon Mac
unless you select Compose, and Compose on Linux.

- [Overview](native/README.md) — what it is, what it is not, and why to try it.
- [Try it](native/try-it.md) — install, run one project on native, switch back.
- [What works and known limits](native/limits.md)
- [Reference](native/reference.md) — the detailed pages, by topic.

## v5

v5 keeps the v4 project model and commands. Stable Hack runs Compose; with no
backend selected, the `hack-next` prerelease picks native on Apple Silicon macOS
and Compose on Linux.

- [What's new in v5](guides/v5-release-notes.md) — the 5.0.0 release notes.
- [Upgrade to v5](guides/upgrade-to-v5.md) — what changed, what was retired, how to try it.
- [Prerelease channel](guides/prereleases.md) — versions, platforms and publication.
- [Install a prerelease](guides/candidate-install.md) — `hack-next` beside stable Hack.
- [Qualify a project on v5](guides/v5-dogfooding.md) — a staged, reversible rollout.

## Contribute

Read [AGENTS.md](../AGENTS.md) for contributor workflows and
[Agent guidance](agent-guidance.md) for how generated client guidance is maintained.
The [reference index](reference.md) links to deeper contracts. Public docs describe
supported behavior; internal plans and evidence stay out of the public site.
