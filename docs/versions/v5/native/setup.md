# Prepare the native runtime

Use the candidate frontend's `native setup` command. Setup success does not
establish real-VM or application acceptance. Use an Apple Silicon Mac, a
disposable project and synthetic data. Read [the limits](limits.md) first.

After [installing the candidate](../install.md), use the same frontend for setup
and project commands. Its launcher selects the version's private native home:

```sh
CANDIDATE="$HOME/.hack-next/bin/hack-next"
unset HACK_RUNTIME_BACKEND HACK_NATIVE_HOME
"$CANDIDATE" native setup
```

Setup lists the pinned files, exact compressed sizes, source hosts, hashes and
destinations before asking once for consent. It downloads and verifies the
provider, engine and guest network tools, prepares them in staging, and ends
with the development-profile probe. Noninteractive `up` refuses until setup is
complete. Interactive `up` can offer the same consent and continue after success.
Setup needs no administrator password or keychain access and ignores proxy
settings; use the offline form below on networks that require a proxy.

For scripts, run `"$CANDIDATE" native setup --accept-downloads --json`; JSON
never prompts and passes the setup result through unchanged. A noninteractive run
needing preparation refuses with `E_INTERACTIVE_REQUIRED` without that consent.
A complete matching installation is verified and reused without prompting or
downloading. An incomplete, changed or differently pinned provider directory is
preserved and refused; do not delete its state to force setup to proceed.

Interrupted downloads can be resumed or restarted by rerunning setup. A
`setup_pin_unavailable` refusal means a pinned URL returned 404 or 410; use the
exact offline inputs or a reviewed newer release. Setup does not upgrade a
home's provider pin in place.

## Offline inputs

Supply all three inputs from the matching pinned release:

```sh
"$CANDIDATE" native setup \
  --archive /absolute/smolvm.tar.gz \
  --engine-archive /absolute/docker.tgz \
  --network-tools-directory /absolute/network-tools
```

Do not combine offline inputs with `--accept-downloads`. The network-tools
directory must contain the four pinned Alpine packages. Setup verifies the same
sizes and hashes and never falls back to downloading missing offline inputs. See
the [complete setup contract](full-reference.md#manual-candidate-upgrade-and-rollback)
for filenames and recovery details.

## Older setup-only homes

If you ran next.16's `runtime setup` and never started a project, finish setup,
run `up` then `down` with that same next.16 launcher, and confirm its runtime is
`stopped` before upgrading. Older executors cannot prove setup-only quiescence;
do not delete receipts to bypass an upgrade refusal. See the
[home and upgrade workaround](../../guides/candidate-install.md#prepare-the-native-runtime-once).

The frontend command above is intended for next.17; installed next.16 retains
the [older setup procedure](https://github.com/hack-dance/hack/blob/b21c3b189841c1a3cbb8af2b76414fa347dc7057/docs/native/try-it.md).

After preparation, continue with [Check before starting](start.md#check-before-starting).
Setup success is not proof that the project starts, retains data or switches
back to Compose correctly.
