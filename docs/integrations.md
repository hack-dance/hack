# Integrations Overview

Hack keeps the core local-dev path small, then layers supporting workflows around it.

The easiest way to think about these integrations is:

- GitHub and Linear connect Hack to systems that already exist outside your repo
- Tickets, sessions, and env keep your daily workflow close to the repo itself
- None of these are required to get started with `hack init`, `hack up`, and `hack open`

## GitHub

GitHub integration is for repo auth and pull-request workflows.

Use it when you want Hack to:

- authenticate private repo or automation flows
- create or update a PR as part of a run or release workflow
- keep more than one GitHub profile available on the same machine

Main surface:

- `hack x github connect`
- `hack x github status`
- `hack x github pr-upsert`

Reference:

- [Extensions & SDK reference](extensions.md)

## Linear

Linear integration is for syncing selected planning work into the repo, not for replacing your
whole Linear setup.

Use it when you want Hack to:

- connect a local Linear profile
- bind a Hack project to a Linear project
- sync a specific issue or project into repo-local workflow state

Main surface:

- `hack linear status`
- `hack linear connect`
- `hack linear sync-issue`
- `hack linear sync-project`

Reference:

- [Linear integration architecture](guides/linear-integration-architecture.md)
- [Extensions & SDK reference](extensions.md)

## Tickets

Tickets are a lightweight, git-backed work log that lives with the repo instead of in a separate
hosted tracker.

Use them when you want to:

- capture follow-up work during implementation
- keep agent-created tasks next to the code
- sync issue state through git refs instead of another service

Main surface:

- `hack tickets create`
- `hack tickets list`
- `hack tickets show`
- `hack tickets status`
- `hack tickets sync`

Reference:

- [Tickets guide](guides/tickets.md)

## Sessions

Sessions are durable terminal workspaces for humans and agents.

Use them when you want to:

- keep a project shell alive between reconnects
- give an agent its own long-lived workspace
- reattach to an existing terminal workflow instead of starting from scratch

Main surface:

- `hack session`
- `hack session start`
- `hack session attach`
- `hack session exec`

Reference:

- [Sessions](sessions.md)

## Env

Env support gives the repo a clear contract for configuration without committing the actual secret
values.

Use it when you want to:

- declare what variables a project needs
- keep plain values in `.hack/.env`
- keep sensitive values in a secret backend

Main surface:

- `hack env list`
- `hack env set`
- `hack env unset`
- `hack env backend status`

Reference:

- [Env & secrets](env.md)

## Choosing the right surface

- Start with the core path if you just need a project running locally
- Add env when a repo needs repeatable configuration
- Add sessions when you want durable terminal workflows
- Add tickets when follow-up work should stay in git
- Add GitHub or Linear only when you need those external systems connected
