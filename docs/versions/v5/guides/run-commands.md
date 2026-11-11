# Choose where a command runs

Use `exec` when the target service is already running. Use `run` for a one-off
command in a fresh service container. Use `host exec` for a command that must run
on the current host with the project's resolved environment.

```sh
hack exec web -- node --version
hack run web node --version
hack host exec --scope web -- node --version
```

Replace `web` and the command with your project's actual service and tool. The
three examples report the installed Node version in three execution contexts; they
install nothing. The host path needs Node on the host.

Hack options go before the command tail. After the service name or `--`, everything
is passed through unchanged, so a child's `--json` or `--help` is never read as a
Hack flag.

An agent uses the same model. Ask it to read project instructions, select the
intended host and instance, and inspect state before running data-changing
commands such as migrations, which need their own project-specific checks.

On the native backend, `exec` requires a noninteractive command with closed stdin,
and one-off `run` is bounded. See
[Native authored commands](../../reference/native-authored-commands.md).
