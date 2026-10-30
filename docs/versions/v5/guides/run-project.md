# Run and inspect a project

Use this after [Getting started](../getting-started.md). These examples use the Compose backend. Use the candidate launcher explicitly, and stop stable Hack processes before sharing its Compose home. Native commands have a separate preparation and support contract.

## Start or restart

```sh
HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" up --detach
HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" ps
HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" open
HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" restart web
```

Replace `web` with a declared service. A selected-service operation differs from a
whole-project lifecycle; read the command reference before relying on hooks or
implicit dependencies. Inspect the app after restart.

## Read logs

```sh
HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" logs web --no-follow --tail 100
HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" logs web --compose
HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" logs --loki --since 2h --pretty
```

The first command is a finite snapshot. The second follows live Compose output;
interrupt it with Ctrl-C. Loki history needs the global logging stack running on
that host and is unavailable in slim environments. Read the matching
[command reference](../../reference/cli.md) for supported filters and formats.
Native authored logs have a narrower finite-command contract; these Compose
examples do not establish native flag parity.

```sh
HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" down
```

Use ordinary shutdown after review. Check reported failures rather than issuing
broad cleanup commands.
