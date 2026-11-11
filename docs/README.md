# Hack documentation

Hack runs a project's services, environment, secrets, local HTTPS and logs from
configuration kept in the repository. Teammates, agents and parallel worktrees all
use the same project definition. The public site is [hack.foo](https://hack.foo).

## Run your first project

Start with [Getting started](guides/getting-started.md): install the CLI, set up
local routing once, initialize a repository and run it with `hack up --detach`.
The default runtime is Docker Compose. No account is required.

Already have a project? Follow [Project setup](guides/init-project.md), or use
[Agent setup](guides/agent-first-setup.md) to let an agent configure it.

## Work on a project

- [Core concepts](core.md) — projects, services, instances and local URLs.
- [Environment and secrets](env.md) — committed configuration with encrypted values.
- [Lifecycle](lifecycle.md) — hooks, tunnels and host helpers that start with the project.
- [Sessions](sessions.md) — persistent terminal workspaces per project.
- [Worktrees and watchers](guides/development-runtime-safety.md) — run branches side by side.
- [Side-by-side development](dev.md) — `hack dev` runs a repository's declared dev command.
- [Managed environments](guides/codex-managed-environments.md) — reuse a project on another machine or in a cloud agent.
- [Agent integrations](integrations.md) — the optional `hack` plugin and the separate MCP server.

## Find a command or fix setup

- [CLI overview](cli.md) explains which command to use; the [command reference](reference/cli.md) lists every flag.
- [Global settings](guides/global-settings.md) covers machine-wide configuration.
- [macOS connectivity](guides/macos-browser-network.md) and [certificate trust](guides/macos-certificate-trust.md) explain local URL problems.
- [Architecture](architecture.md) explains how the pieces fit together.

If something is wrong, run `hack doctor` and follow the diagnosis. Review what a
repair touches before `hack doctor --fix`.

## v5

v5 keeps the v4 project model and commands, and Compose stays the default backend.
The native backend for Apple Silicon macOS is beta: it is opt-in and available only
through the `hack-next` channel.

- [What's new in v5](guides/v5-release-notes.md) — the 5.0.0 release notes.
- [Upgrade to v5](guides/upgrade-to-v5.md) — what changed, what was retired, how to try it.
- [Prerelease channel](guides/prereleases.md) — versions, platforms and publication.
- [Install a prerelease](guides/candidate-install.md) — `hack-next` beside stable Hack.
- [Native backend (beta)](guides/native-candidate.md) — preparation, limits and verification.
- [Native config import](reference/native-config-import.md) — preview and adopt existing configuration.
- [Qualify a project on v5](guides/v5-dogfooding.md) — a staged, reversible rollout.

## Contribute

Read [AGENTS.md](../AGENTS.md) for contributor workflows and
[Agent guidance](agent-guidance.md) for how generated client guidance is maintained.
The [reference index](reference.md) links to deeper contracts. Public docs describe
supported behavior; internal plans and evidence stay out of the public site.
