# Run and inspect a project

Complete [Getting started](../getting-started.md). The published next.6 launcher
selects native execution. Choose v4 in Docs version for Compose recipes.

```sh
"$HOME/.hack-next/bin/hack-next" --path /absolute/prepared-project up
```

Keep the foreground owner running. In another terminal:

```sh
"$HOME/.hack-next/bin/hack-next" --path /absolute/prepared-project ps --json
"$HOME/.hack-next/bin/hack-next" --path /absolute/prepared-project logs web --no-follow --tail 100
```

Replace `web` with a service from the saved project. Logs are finite and
service-specific; following output, Loki queries and pretty formatting are not
part of this native slice. Current service state and the app's health check are
separate observations.

```sh
"$HOME/.hack-next/bin/hack-next" --path /absolute/prepared-project down
```

Use [the authored command matrix](../../reference/native-authored-commands.md)
for exact admitted options. Do not infer detached startup, `run` or `restart`
parity from an overview or a v4 flag list.
