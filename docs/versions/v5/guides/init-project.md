# Project setup

Complete [Install](../install.md) and [Getting started](../getting-started.md).
This page covers an existing repository: an app that already has Compose files,
one that needs custom domains, or one you want an agent to configure.

## Initialize

```sh
cd your-project
hack init
```

`hack init` detects an existing `docker-compose.yml`, asks about services and
domains, and writes `.hack/`: the Compose file Hack manages, `hack.config.json`,
the default env YAML and a `.gitignore` for machine-local state. Review the files
and commit them. To hand setup to an agent instead, run
`hack init --with claude` or `hack init --with codex`.

For an existing project, `hack agent onboard` prints an onboarding prompt that
describes the services, env and routing a Hack setup should cover. See
[Explicit agent setup](agent-first-setup.md).

## Check the result

```sh
hack up --detach
hack open
hack doctor
```

`hack doctor` reports missing prerequisites, routing problems and configuration
drift. Review each repair before `hack doctor --fix`.

## Native backend

Native execution needs more than `hack init`: a prepared provider pool, an
explicitly adapted project and a private native home. Read
[Try the native backend](../native/try-it.md) first. `hack config validate`,
`config plan` and `config import --dry-run` preview native configuration without
starting anything; see [Native config import](../../reference/native-config-import.md).
Installing v5 does not convert a Compose project or move its data.
