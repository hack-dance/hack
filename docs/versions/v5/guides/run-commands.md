# Choose where a command runs

These examples use the Compose backend. Use the candidate launcher explicitly, and stop stable Hack processes before sharing its Compose home. Native commands have a separate preparation and support contract.

Use `exec` when the target service is already running. Use `run` for a one-off
command in a fresh service container. Use `host exec` for a command that must run
on the current host with resolved project environment.

```sh
HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" exec web -- node --version
HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" run web node --version
HACK_RUNTIME_BACKEND=compose "$HOME/.hack-next/bin/hack-next" host exec --scope web -- node --version
```

Replace `web` and the command with your project's actual service and tool. These
examples report the installed Node version in three different execution contexts;
they do not install Node. The host path needs Node on the host. Inspect service
prerequisites and the matching [reference](../../reference/cli.md) before running
migrations or other data-changing commands.

An agent uses the same execution model. Ask it to read project instructions, select
the intended host and instance, and inspect state before starting new work.
