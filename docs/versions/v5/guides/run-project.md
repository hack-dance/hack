# Run and inspect a project

Use this after [Getting started](../getting-started.md). The examples use the
default Compose backend.

## Start or restart

```sh
hack up --detach
hack ps
hack open
hack restart web
```

Replace `web` with a declared service. Restarting one service skips the project
lifecycle; read the [command reference](../../reference/cli.md) before relying on
hooks or implicit dependencies. Check the app after a restart.

## Read logs

```sh
hack logs web --no-follow --tail 100
hack logs web
hack logs --loki --since 2h --pretty
```

The first command is a finite snapshot. The second follows live output until
Ctrl-C. Loki history needs the global logging stack running on that host and is
unavailable in slim environments.

## Stop

```sh
hack down
```

Use ordinary shutdown after review. Inspect reported failures rather than issuing
broad cleanup commands. `hack projects prune --project <name>` scopes stale
registry and container cleanup to one project family.

## Native backend

On the native backend, `hack up` starts the whole project, in the foreground or in
the background with `--detach`. `hack restart` runs in the foreground only. Neither
accepts a subset of services. Logs are finite snapshots; following logs is not
available. See
[Native authored commands](../../reference/native-authored-commands.md) for the
exact supported forms.
