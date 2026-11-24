# Run and inspect a project

Use this after [Getting started](../getting-started.md). The examples use the
Compose backend.

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
Ctrl-C. Both read container logs, and so do `--since` and `--until`. Loki
history and queries (`--loki`, `--query`) need the global logging stack, which
is opt-in: turn it on once with `hack global up --logging`. Without it they
fail with `E_LOGGING_OFF`; they are unavailable in slim environments.

`--services api,worker` reads several services at once. For scripts,
`hack logs --json` is a stable line-per-event stream; `--max-line-bytes <n>`
bounds each line. The stream's fields are in the "Logs JSON stream" reference
page of the current source.

## Stop

Use `hack activity --json --project <name> --limit 50` to read recent lifecycle
actions, newest first. The private log records registered project, branch and
service names, origin, outcome and duration. It excludes environment values,
command lines and paths. Logging failures do not change the lifecycle command's
exit code.

```sh
hack down
```

Use ordinary shutdown after review. Inspect reported failures rather than issuing
broad cleanup commands. `hack projects prune --project <name>` scopes stale
registry and container cleanup to one project family.

## Back up volume data

After `hack down`, `hack data export` copies the project's own Compose named
volumes into verified tar files under `~/.hack/data-backups/` (or `--out <dir>`).
It refuses while the project runs and skips external and foreign volumes. It
works on Compose only and cannot restore yet. If a refusal reports a helper
container it could not confirm removing, run the `hack data cleanup --nonce …`
command it prints; see
[Data backup](https://github.com/hack-dance/hack/blob/next/docs/reference/data-backup.md).

## Native backend

Native starts and restarts the whole project. Use the [native command table and
startup limits](https://github.com/hack-dance/hack/blob/next/docs/native/limits.md) for the supported forms, refusal codes,
and the equivalent Compose capabilities. Live log following is
[under verification](../native/log-follow.md).
