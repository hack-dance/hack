# Side-by-side development

Run `hack dev` inside a repository, or `hack dev --path /path/to/repo`.
This foreground command does not need Docker or a Compose declaration.

Commit `.hack/dev.json` in the project:

```json
{"version": 1, "command": ["bun", "scripts/dev.ts"]}
```

Hack discovers the nearest declaration from the current directory up to its Git
checkout root, validated by Git and owned by the current user on POSIX hosts.
An arbitrary `.git` marker grants no trust. Without a trusted Git checkout, only
the selected directory is searched. Declarations must be owned by the current user
on POSIX hosts.
Declarations that resolve outside that boundary are refused. Hack
runs the argv array from that root, inherits terminal I/O and returns the runner's
exit status. Arguments are literal; shell strings and interpolation are unsupported.
Ctrl-C, SIGTERM and SIGHUP are forwarded to the runner. Run declarations only from trusted
checkouts, just as you would a package script.

The project runner owns its separate app name, bundle ID, ports, data directories,
reload mechanism and child cleanup. It must never adopt or stop the installed app.
For example, a native app can rebuild/relaunch with a separate config/state home
and an example-only loopback service on a dev-specific port.
Native rebuilds restart the dev app, so save edits before changing its source.
Terminal Ctrl-C may also reach the runner directly; shutdown handlers must tolerate
repeated signals and wait for cleanup before exiting.
