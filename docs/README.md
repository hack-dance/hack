# Hack documentation

Hack runs a project's services, environment, secrets, local HTTPS and logs from
configuration kept in the repository. Use the same project setup across teammates,
agents and parallel worktrees.

## Run your first project

Start with [Getting started](guides/getting-started.md): install the stable CLI,
set up local routing, initialize a repository and run it with `hack up --detach`.
The supported setup uses Docker Compose. No hosted Hack account is required.

Already have a project? Follow [Project setup](guides/init-project.md), or use
[Agent setup](guides/agent-first-setup.md) to let an agent help configure it.

## Work on a project

- [Core concepts](core.md) — projects, services, instances and local URLs.
- [Environment and secrets](env.md) — share configuration and keep the decryption key separate.
- [Lifecycle](lifecycle.md) — start project helpers, tunnels and hooks with the project.
- [Sessions](sessions.md) — keep a project workspace available between terminal visits.
- [Worktrees and watchers](guides/development-runtime-safety.md) — run branches side by side.
- [Managed environments](guides/codex-managed-environments.md) — reuse project setup on another machine or in a managed container, with its required runtime and credentials.
- [Agent integrations](integrations.md) — optional client plugins and setup helpers.

## Find a command or fix setup

- [CLI overview](cli.md) explains which command to use; the [command reference](reference/cli.md) lists flags.
- [Global settings](guides/global-settings.md) covers shared configuration.
- [macOS connectivity](guides/macos-browser-network.md) and [certificate trust](guides/macos-certificate-trust.md) explain local URL problems.
- [Architecture](architecture.md) explains how the pieces fit together.

If something is wrong, start with `hack doctor` and follow the diagnosis for that
project. Review the effect of a repair before applying it.

## Try the experimental v5 runtime

[Run v5 alongside stable Hack](guides/v5-dogfooding.md). The native candidate uses
a separate installation and explicit project adoption. A successful installation
does not establish application compatibility or runtime parity. The guide links
to installation steps, current limits and verification commands.

## Contribute

Read [AGENTS.md](../AGENTS.md) for contributor workflows and
[Agent guidance](agent-guidance.md) for generated client instructions.
The [reference index](reference.md) links to deeper contracts in the repository.
Public docs describe supported behavior; internal plans and historical evidence
are not part of the public site.
