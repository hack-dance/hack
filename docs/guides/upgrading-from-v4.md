# Upgrading a v4 installation

Keep your existing home, registry, project checkout and Git worktrees. Install the
new CLI, then run the diagnostic and explicit env migration for each checkout:

```sh
hack doctor
hack doctor --migrate-env-config
```

Migration refuses to change tracked env files without explicit consent. Review
those files and rerun with `--accept-tracked-env-changes` when you want to proceed.
Machine-local values move into local YAML; secrets remain encrypted. Keep project
keys: the migrated values still need them. In particular, a legacy encrypted
store may reuse `.hack.secret.key`; that key remains a live input after migration.
See [env migration](../env.md#legacy-repos-and-migration) for scope and recovery details.

Verify your normal env-aware command after migration. A linked worktree has its
own declared env inputs; check it separately. Running migration again preserves
an already migrated project.

If Doctor reports a global encrypted store whose key is lost, recover the key
from your own backup if any project still needs its values. `hack secrets
retire-store` refuses healthy or still-needed stores. It previews the decision
and requires explicit confirmation to move an unused unreadable store aside.
An unchecked registry entry needs the additional `--allow-unchecked` consent.
Retirement retains ciphertext; it does not recover missing values. See the
[encrypted store guidance](../env.md) before confirming.

## Download and installation recovery

`hack update --check` is read-only. `hack update --yes` downloads the selected
stable release into private scratch before changing the installation. Downloads
have size, inactivity and total limits. Connection failures and HTTP 502/503/504
receive up to three fresh attempts within the same deadline. Rerunning starts
from byte zero; partial bytes are never trusted or adopted.

The stable updater checks the GitHub asset SHA-256 when supplied, every file in
the archive's `SHA256SUMS` and the archive layout. It checks the version on the
executable staged beside the installed CLI, before publication, so the download
directory can be on a `noexec` mount. These checks detect corruption and mismatched payloads. Publisher
identity continues to depend on the official GitHub HTTPS origin; an inner
checksum is not a cryptographic publisher signature.

The updater stages the complete asset tree, preserving existing extra assets,
and publishes the matching compiler before replacing the CLI last. A caught
publication failure restores previous files. A successful update prints a private
backup manifest with paths and hashes, alongside the previous CLI, compiler and
assets. Keep that backup until you have verified the new installation. A hard
kill or filesystem failure during the multi-directory swap may require restoring
those retained files; this is not a power-loss-atomic transaction.

The printed manifest lives at
`<assets-parent>/.hack-update-backup-XXXXXX/manifest.json`. Completed backups are
retained until you choose to remove them: after checking the new installation,
you can delete that whole backup directory to reclaim its disk space. They are
not automatically pruned. Abandoned executable stages with the updater's matching
private ownership receipt are reclaimed under its lock on the next update;
unrecognised directories are retained.

Offline download failure leaves the installation unchanged. Installers in older
v4 executables retain their old behavior: these updater improvements apply once
you run a build containing them. New release archives retain the v4 expected
`hack-VERSION-release/{hack,assets,binaries}` layout.

For standalone native prereleases, use the
[prerelease recovery and uninstall contract](prereleases.md). Native is optional;
Compose users use their existing stable installation and project state.

## Regression coverage

`tests/v4-upgrade.test.ts` compiles the current CLI with a test-only network fence
and uses historical bytes, synthetic values, private HOME, real temporary Git
repositories and a linked worktree. It checks Doctor's read-only path, tracked
consent, resolution before/after, every changed file, live keys, retirement,
repeat migration and value-free command output/journals. The generic fixture
also exposes command and snapshot helpers for future assistant flows.

The upgrade and installer files run in both normal Linux and macOS shard pools.
Installer tests use loopback servers and injected faults; they do not qualify
published downloads or native runtime applications.
