# Run and inspect a project

Use this after [Getting started](../getting-started.md). These examples use the Compose runtime in v4.2.4. Verify `hack version` before using the archived command reference.

## Start or restart

```sh
hack up --detach
hack ps
hack open
hack restart web
```

Replace `web` with a declared service. A selected-service operation differs from a
whole-project lifecycle; read the command reference before relying on hooks or
implicit dependencies. Inspect the app after restart.

## Read logs

```sh
hack logs web --no-follow --tail 100
hack logs web --compose
hack logs --loki --since 2h --pretty
```

The first command is a finite snapshot. The second follows live Compose output;
interrupt it with Ctrl-C. Loki history needs the global logging stack running on
that host and is unavailable in slim environments. Read the matching
[command reference](../../reference/cli.md) for supported filters and formats.
Native authored logs have a narrower finite-command contract; these Compose
examples do not establish native flag parity.

```sh
hack down
```

Use ordinary shutdown after review. Check reported failures rather than issuing
broad cleanup commands.
