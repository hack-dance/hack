# Integrations Overview

Hack keeps the core local-dev path small, then layers supporting workflows around it.

The easiest way to think about these integrations is:

- GitHub and Linear connect Hack to systems that already exist outside your repo
- Tickets, sessions, and env keep your daily workflow close to the repo itself
- None of these are required to get started with `hack init`, `hack up`, and `hack open`

## GitHub

GitHub integration is the capability layer for repo auth, pull-request workflows, and repo-aware
handoff between GitHub context and local Hack work.

Use it when you want Hack to:

- authenticate private repo or automation flows
- keep more than one GitHub identity or installation context available on the same machine
- create or update a PR as part of a run or release workflow
- make the first-class GitHub workflow set explicit before deeper review/comment/repo-handoff
  commands land

Main surface today:

- `hack x github connect`
- `hack x github status`
- `hack x github pr-upsert`

Defined workflow boundary for this milestone:

- review intake and review decision
- PR update and readiness management
- PR-level conversation comments
- PR-adjacent repo handoff actions

Reference:

- [Extensions & SDK reference](extensions.md)
- [GitHub first-class workflows design](plans/2026-03-13-github-first-class-workflows-design.md)

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

- declare what variables and overlays a project needs
- keep canonical env in committed `hack.env.*.yaml` files
- keep the decryption key local via `.hack.secret.key` or `HACK_ENV_SECRET_KEY`
- run host-side commands with injected env without hand-managing `.env` files

Main surface:

- `hack env list`
- `hack env add`
- `hack env exec`
- `hack env shell`
- `hack env unset`
- `hack env materialize`

Reference:

- [Env & secrets](env.md)

## Choosing the right surface

- Start with the core path if you just need a project running locally
- Add env when a repo needs repeatable configuration
- Add sessions when you want durable terminal workflows
- Add tickets when follow-up work should stay in git
- Add GitHub or Linear only when you need those external systems connected
