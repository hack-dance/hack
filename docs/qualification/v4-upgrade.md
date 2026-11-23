# Qualify the stable v4.3.0 upgrade

Use disposable login users on macOS and Linux for the service tests. Preserve a
VM snapshot before installing. Leave `HACK_HOME` unset and use each test user's
normal home so the service manager can exercise its real ownership rules. Use
the published v4.3.0 installation and the stable candidate built from the exact
source revision being qualified. Record the artifact digests and the reported
versions.

## Direct daemon and login services

Run each case from a separate copy of the clean baseline. Verify the v4.3.0
daemon is serving before replacing its binary. For the direct case on either
host, use `hack daemon start` in a session without an installed Hack service.
For the macOS managed case, run the v4.3.0 `hack daemon install` in a GUI login.
Capture `hack daemon status` and, for launchd, the service PID and program:

```sh
launchctl print "gui/$(id -u)/dance.hack.hackd"
```

Install the candidate over the same installed path while v4.3.0 is still
running. Exercise the candidate's in-place update route as well when its release
artifact is available through the update channel. Use `hack daemon start --json`
and `hack daemon status --json` to confirm the daemon version matches the new CLI
and the stale process is retired. Repeat start and verify that the healthy daemon
keeps its PID. For launchd, repeat the inspection and verify that the manager
owns the live PID at the new executable.
A working direct fallback does not count as a managed-service pass. Restart the
login session and check status again before uninstalling the test service.

### Linux systemd

The published v4.3.0 CLI has no Linux service-install command. Use two separate
Linux snapshots with a working user manager:

1. **Candidate service installation.** Install the candidate in its durable
   location with no running daemon. Run `hack daemon install`, then
   `hack daemon status --json` and the service inspection below. Verify the
   candidate version, an active user unit and matching daemon and manager PIDs.
   Log out and back in, check the service again, then run `hack daemon uninstall`.
2. **Legacy service replacement.** With the published v4.3.0 installed, use
   `systemctl --user edit --force --full hackd.service` to provision a fixture
   unit. Give it a `[Service]` section with
   `ExecStart=/absolute/v4/install/path/hack daemon start --foreground` using the
   actual durable install path, and `Environment=PATH=/usr/bin:/bin`. Use an
   unmarked unit and the normal login home. Run
   `systemctl --user daemon-reload` and `systemctl --user start hackd.service`.
   Record the v4.3.0 version, unit contents and PID. Replace the installed
   binary at the same path with the candidate and run `hack daemon start --json`.
   Verify the unit now owns the candidate PID, the prior PID is gone, the unit
   file is byte-identical, and a second start keeps the candidate PID. Retire
   the fixture with `systemctl --user stop hackd.service` and restore the VM snapshot.

```sh
systemctl --user show hackd.service -p ActiveState -p MainPID -p ExecStart
```

### Source regression tests

Run the source regressions on both hosts before the real upgrade:

```sh
bun test tests/upgrade-installer.test.ts
bun test tests/daemon-reconcile.test.ts
bun test tests/daemon-candidate-launch.test.ts
bun test tests/daemon-start-wait.test.ts
```

On macOS also run `bun test tests/launchd.test.ts` and
`bun test tests/launchd-isolation.test.ts`. The tests use private fixtures or
manager stand-ins. Save their results separately from the real launchd and
systemd observations.

## Migration and rollback

Run each of these files independently so the test fixtures and process state
belong to one test invocation:

```sh
bun test tests/v4-upgrade.test.ts
bun test tests/env-migration-journal.test.ts
bun test tests/env-migration-provider.test.ts
bun test tests/upgrade-apply.test.ts
bun test tests/upgrade-snapshot.test.ts
```

The journal and apply tests stop real child processes at published boundaries
and verify resume and rollback. The historical upgrade fixture exercises
compiled current source with synthetic v4 data. Save these results separately
from the macOS dogfood run.

For dogfood, follow the [Compose pilot](../versions/v5/guides/upgrade-from-v4.md#3-choose-the-version-and-installation-path)
on a disposable copy of a v4.3.0 project with a linked worktree, managed env and
data backed by a retained volume. Verify a synthetic application marker and the
expected env keys in the primary and worktree under v4.3.0. Take a private backup of the project
and its application data. Record pre-change file digests and modes privately.
Keep the stable daemon stopped during the candidate trial.

Run `hack upgrade check` and `hack upgrade apply --dry-run` with the candidate.
For a fixture with recognized standalone assistant artifacts, preview and run
`hack upgrade apply --only agent-integrations`. Confirm the applied action
and retain its snapshot manifest.
Run `hack env migrate --path "$project" --json` and
`hack env migrate --path "$project" --apply`, and retain the manifest path.
Check the same application marker, env availability and worktree selection after
candidate start and restart. Use the normal assistant client to verify that the
current project guidance loads. If qualifying cleanup, preview it separately
and run it only after the documented full-project delivery check.

Stop the candidate. Reverse the actions using the manifests in reverse order
with `hack env migrate --path "$project" --rollback-manifest "$env_manifest"`
and `hack upgrade rollback --rollback-manifest "$upgrade_manifest"`.
Compare the resulting files and modes with the private pre-change records,
including legacy env inputs and assistant files. Bring v4.3.0 and its original
login service back, then read the same application marker and check the same
env keys and worktree again. Retain value-free outcomes, manifest coverage,
and the exact commands used. Keep raw digests, env values and snapshot blobs
in the private test environment.
