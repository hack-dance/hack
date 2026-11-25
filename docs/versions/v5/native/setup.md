# Prepare the native runtime

Use the prerelease frontend's `native setup` command. Setup success does not
establish real-VM or application acceptance. Use an Apple Silicon Mac, a
disposable project and synthetic data. Read [the limits](limits.md) first.

After [installing the prerelease](../install.md), use the same frontend for setup
and project commands. Its launcher selects the version's private native home:

```sh
CANDIDATE="$HOME/.hack-next/bin/hack-next"
unset HACK_RUNTIME_BACKEND HACK_NATIVE_HOME
"$CANDIDATE" native setup
```

Setup lists the pinned files, exact compressed sizes, source hosts, hashes and
destinations before asking once for consent. It downloads and verifies the
provider, engine, guest network tools and [image builder](#the-image-builder).
It prepares the first three in staging and publishes them together, then adds
the image builder, and ends with the development-profile probe. Noninteractive
`up` refuses until setup is complete. Interactive `up` can offer the same
consent and continue after success.
Setup needs no administrator password or keychain access and ignores proxy
settings; use the offline form below on networks that require a proxy.

For scripts, run `"$CANDIDATE" native setup --accept-downloads --json`; JSON
never prompts and passes the setup result through unchanged. A noninteractive run
needing preparation refuses with `E_INTERACTIVE_REQUIRED` without that consent.
A complete matching installation is verified and reused without prompting or
downloading. An incomplete, changed or differently pinned provider directory is
preserved and refused; do not delete its state to force setup to proceed.

After verified provider setup, Hack removes its two recorded provider downloads.
It keeps the archives needed for repair, caller-supplied offline inputs, and
older downloads whose ownership it cannot prove.

Interrupted downloads can be resumed or restarted by rerunning setup. A
`setup_pin_unavailable` refusal means a pinned URL returned 404 or 410; use the
exact offline inputs or a reviewed newer release. Setup does not upgrade a
home's provider pin in place.

## The image builder

Native `up` builds a Compose `build:` service with a pinned build client, the
image builder. Setup installs it with the rest of the runtime. It is in the list
you consent to, and the JSON result reports it in `builder`: `installed`,
`reused`, `not_prepared` or `changed`.

A home that an earlier build set up is complete without the image builder, so
setup leaves it as it is. Plain `native setup` still succeeds there, downloads
nothing and prints one line saying that the image builder is not installed. To
add it, give the download consent:

```sh
"$CANDIDATE" native setup --accept-downloads
```

On such a home this downloads the image builder only. The provider, engine and
network tools are verified and left in place, so a running native runtime is not
disturbed. Offline, use `--builder` as shown below.

Until the image builder is there, everything except image builds works. A
project that builds an image is refused with "the image builder is not installed
in this native home" and the command above. `hack doctor` on the native backend
reports the same thing first, as a `native image builder` warning, for a project
with a `build:` service, unless `HACK_NATIVE_BUILDS=0` turns native builds off.
Doctor only reports it: `doctor --fix` downloads nothing.

If the image builder in a home no longer matches the pinned release, setup still
succeeds and reports `builder: "changed"`. It prints one warning and leaves the
builder exactly as it is, with or without `--accept-downloads` or `--builder`:
setup never deletes or overwrites it. Image builds are refused until you replace
it. The warning names the two paths to remove, relative to the native home (the
builder's directory `.hack-local/providers/buildx-<version>-darwin-arm64` and its
record `.hack-local/providers/buildx.json`). Remove them, then run
`native setup --accept-downloads`.

## Offline inputs

Supply all three inputs from the matching pinned release:

```sh
"$CANDIDATE" native setup \
  --archive /absolute/smolvm.tar.gz \
  --engine-archive /absolute/docker.tgz \
  --network-tools-directory /absolute/network-tools
```

To prepare the image builder too, add the pinned `buildx` release file that
`provider-pins.json` names:

```sh
"$CANDIDATE" native setup \
  --archive /absolute/smolvm.tar.gz \
  --engine-archive /absolute/docker.tgz \
  --network-tools-directory /absolute/network-tools \
  --builder /absolute/docker-buildx
```

Without `--builder`, offline setup works as before and reports
`builder: "not_prepared"`. To add the image builder to a home that is already set
up, run the command with `--builder`; the three other inputs are not read again.
`--builder` is accepted only together with them.

Do not combine offline inputs with `--accept-downloads`. The network-tools
directory must contain the four pinned Alpine packages. Setup verifies the same
sizes and hashes and never falls back to downloading missing offline inputs. See
the [complete setup contract](full-reference.md#manual-candidate-upgrade-and-rollback)
for filenames and recovery details.

## Manual homes

Manual bundle users run the adjacent `hack-v5 native setup`. Its default home is
`$HACK_HOME/native-runtime` or `~/.hack/native-runtime`; an absolute
`HACK_NATIVE_HOME` overrides that default. Managed `hack-next` instead keeps its
version's receipt-owned home and refuses a differing override.

To move a manual home, stop its projects and runtime with the old home and
matching executor, preserve that home for retained data, then select a fresh
absolute `HACK_NATIVE_HOME` and run `hack-v5 native setup` again. Setup does not
move receipts, disks or project data. Keep each home with its matching executor.

## Older setup-only homes

If you ran next.16's `runtime setup` and never started a project, finish setup,
run `up` then `down` with that same next.16 launcher, and confirm its runtime is
`stopped` before upgrading or uninstalling. Older executors cannot prove
setup-only quiescence; do not delete receipts to bypass a refusal. See the
[upgrade and recovery reference](full-reference.md#manual-candidate-upgrade-and-rollback).

The frontend command above needs next.17 or later; an installed next.16 keeps
the [older setup procedure](https://github.com/hack-dance/hack/blob/b21c3b189841c1a3cbb8af2b76414fa347dc7057/docs/native/try-it.md).

After preparation, continue with [Check before starting](start.md#check-before-starting).
Setup success is not proof that the project starts, retains data or switches
back to Compose correctly.
