# Core Docs

Core docs are the default path through `hack`.

This section stays focused on local project orchestration: initialize a repo, run it on an isolated
network, reach it on stable local hostnames, manage env and lifecycle, and keep working sessions
alive. You do not need gateway, remote nodes, or extension setup to use this path.

## Start here

- [Initialize a project](guides/init-project.md)
- [Architecture](architecture.md)
- [Env & secrets](env.md)
- [Lifecycle](lifecycle.md)
- [Sessions](sessions.md)

## Day-to-day core workflows

- Install + quick start: [root README](../README.md)
- Local runtime checks:
  - `hack up --detach`
  - `hack open`
  - `hack logs --pretty`
  - `hack status`

## When to leave core

Move to [Beta workflows](beta.md) only when you intentionally want unsupported experimental:

- gateway exposure
- remote nodes
- remote execution
- remote supervisor jobs

Move to [Extensions & reference](reference.md) when you need the full command table, extension
authoring details, or API-level reference material.
