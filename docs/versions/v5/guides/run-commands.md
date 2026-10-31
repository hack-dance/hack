# Choose where a command runs

Use the explicit candidate launcher for this version. Installing it does not
replace the stable `hack` executable. Its native `exec` command runs a
noninteractive command in an existing selected service:

```sh
"$HOME/.hack-next/bin/hack-next" --path /absolute/prepared-project exec web -- node --version < /dev/null
```

This assumes a prepared native project, a running `web` service and Node installed
in that workload. It reports the workload's Node version; it does not install
anything. Closed stdin and no TTY are required by the native contract.

For one-off containers, Compose host commands or interactive sessions, choose v4
and follow its separate execution-context guide. Do not substitute bare `hack`
into a candidate recipe: it can select a different version and home.

An agent should identify the version, host, project and native generation before
executing a command. Data-changing commands such as migrations need their own
project-specific authorization and checks. See [native command support](../../reference/native-authored-commands.md).
