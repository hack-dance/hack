# Getting started

Complete [Install](install.md) and [Native preparation](../guides/native-candidate.md)
first. This version documents the published next.5 native candidate. For Compose,
choose v4 in Docs version; this launcher's backend cannot be overridden to Compose.

## Prepare one project

Use the provider pool, image, private native home and explicit source-sharing
contract from Native preparation. Review the supported authored project subset in
[Authored commands](../reference/native-authored-commands.md). A Compose repository
is not automatically adopted, and installing the CLI does not migrate data.

Work from the explicitly prepared repository. Do not run the following commands
against an unprepared application or infer that every Compose feature is supported.

## Start and observe

```sh
"$HOME/.hack-next/bin/hack-next" --path /absolute/prepared-project up
```

This is foreground startup: keep the terminal open. In another terminal, inspect
the same saved project and read a finite log snapshot (replace `web` with its real
service name):

```sh
"$HOME/.hack-next/bin/hack-next" --path /absolute/prepared-project ps
"$HOME/.hack-next/bin/hack-next" --path /absolute/prepared-project logs web --no-follow --tail 100
```

Expected: current service state and finite service output from the selected native
run. Visit the endpoint established during routing preparation and run the app's
own health checks. CLI status does not prove application compatibility.

## Stop

Ctrl-C in the foreground terminal requests owned shutdown. Alternatively:

```sh
"$HOME/.hack-next/bin/hack-next" --path /absolute/prepared-project down
```

Inspect failures before retrying. `--detach`, following logs, service subsets and
other unsupported forms must not be borrowed from v4 Compose examples. See the
version's support matrix for the exact admitted commands and recovery boundaries.
