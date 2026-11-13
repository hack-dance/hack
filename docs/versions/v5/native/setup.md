# Prepare the native runtime (under verification)

next.16 includes `runtime setup`. It is **under verification**: publishing the
command does not establish real-VM acceptance. Use an Apple Silicon Mac, a
disposable project and synthetic data. Read [the limits](limits.md) first.

After [installing next.16](../install.md), select that version's native program
and private home. `hack-next --manager status` shows the selected version.

```sh
V=5.0.0-next.16
NATIVE="$HOME/.hack-next/versions/$V/bundle/hack-native"
NATIVE_HOME="$HOME/.hack-next/versions/$V/native-home"
"$NATIVE" --candidate-root "$NATIVE_HOME" runtime setup
```

Setup lists the pinned files, exact compressed sizes, source hosts, hashes and
destinations before asking once for consent. It downloads and verifies the
provider, engine and guest network tools, prepares them in staging, and ends
with the development-profile probe. Ordinary `up` does not download these files.
Setup needs no administrator password or keychain access and ignores proxy
settings; use the [offline form](try-it.md#offline-or-older-builds) on networks
that require a proxy.

For scripts, add `--no-interactive --accept-downloads`. A noninteractive run
needing preparation refuses with `E_INTERACTIVE_REQUIRED` without that consent.
A complete matching installation is verified and reused without prompting or
downloading. An incomplete, changed or differently pinned provider directory is
preserved and refused; do not delete its state to force setup to proceed.

Interrupted downloads can be resumed or restarted by rerunning setup. A
`setup_pin_unavailable` refusal means a pinned URL returned 404 or 410; use the
exact offline inputs or a reviewed newer release. Setup does not upgrade a
home's provider pin in place.

After preparation, continue with [Try it](try-it.md#3-check-the-project).
Setup success is not proof that the project starts, retains data or switches
back to Compose correctly. Those results remain under verification.

Sources: [release setup procedure](https://github.com/hack-dance/hack/blob/b21c3b189841c1a3cbb8af2b76414fa347dc7057/docs/native/try-it.md),
[setup and recovery contract](https://github.com/hack-dance/hack/blob/b21c3b189841c1a3cbb8af2b76414fa347dc7057/docs/guides/native-candidate.md#manual-candidate-upgrade-and-rollback).
