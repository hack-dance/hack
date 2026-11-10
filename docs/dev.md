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
POSIX declaration files and launch directories must not grant shared write access;
directory ancestry must prevent another user from renaming the checked paths.
The declaration is opened without following a final symlink, then validated and
parsed through that same handle.
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

The POSIX policy is conservative: it also rejects `775` directories and `664`
declarations made with `umask 002`, even when the group is a private primary group.
The error identifies the exact path and mode. If you own the path and group write
is unnecessary, remove that bit with `chmod g-w PATH`. Otherwise use a private
checkout created under `umask 022` instead of changing a shared team's permissions.
World-writable paths also require removing other-write access. Git worktrees and
native projects follow the same policy.
