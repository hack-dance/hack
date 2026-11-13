# Install

v5 is in prerelease. Stable Hack today is the v4 line, installed with Homebrew or
the release installer. v5 prereleases install beside it through a separate
channel, `hack-next`, so you can try v5 without touching your stable setup. When
5.0.0 ships, the Homebrew formula and release installer move to v5.

## Prerequisites

- A running Docker-compatible engine with Docker Compose for the default backend.
  Check it with `docker info` and `docker compose version`.
- For the native backend (beta): an Apple Silicon Mac. See
  [Native backend (beta)](native/overview.md).
- Local DNS and certificate trust are set up once per machine by `hack global
  install` and can ask for native approval.

v5 prerelease bundles are published for Apple Silicon macOS only. Other platforms
stay on stable v4 until 5.0.0.

## Install the current prerelease

Each prerelease has an immutable tag, `v5.0.0-next.N`. Download the bootstrap
from the release you want and run it:

```sh
curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
  https://github.com/hack-dance/hack/releases/download/v5.0.0-next.16/hack-next-install.sh \
  --output hack-next-install.sh
less hack-next-install.sh
sh hack-next-install.sh
"$HOME/.hack-next/bin/hack-next" --version
```

The bootstrap pins its manager checksum and release version. It installs into
`~/.hack-next`, does not edit your PATH or shell profile, and leaves the stable
`hack` executable and `~/.hack` untouched. Installing does not migrate projects,
start a VM, or change DNS or trust.

Newer prereleases are listed on the [releases page](https://github.com/hack-dance/hack/releases).
Replace the tag in the URL to install a different one. The
[prerelease channel guide](../guides/prereleases.md) explains versioning, platform
support and the installer in detail.

## Choose a backend

The `hack` CLI runs on Docker Compose unless you select native with
`HACK_RUNTIME_BACKEND=native`. The `hack-next` launcher is the exception: it
exists to test the native candidate, so it selects native by default and
version-private homes. To run the prerelease CLI on Compose against your
ordinary Hack home:

```sh
export HACK_RUNTIME_BACKEND=compose
"$HOME/.hack-next/bin/hack-next" --version
```

The export applies to every later `hack-next` command in that shell. A one-off
`HACK_RUNTIME_BACKEND=compose` prefix selects Compose for that command only; the
next command without it runs native again. Unset the variable before native testing.

On Compose, the prerelease shares project state with stable v4. Do not run both
against the same home at the same time, including their daemons. The
[prerelease install page](../guides/candidate-install.md#stop-stable-hackd-before-a-compose-run) gives
the exact order: stop the stable daemon first, then run the prerelease.

The rest of these docs write `hack` for the v5 CLI. During the prerelease, in the
shell where you exported the backend, run the examples through the launcher:

```sh
hack() { "$HOME/.hack-next/bin/hack-next" "$@"; }
```

This shell function lasts for the session and does not touch your PATH or the
stable `hack` executable in other shells.

## Set up local routing

Once per machine:

```sh
hack global install
```

This configures shared local routing, DNS and certificate trust. Read its prompts.
On Linux, see [Linux host setup](../guides/linux-setup.md) for DNS and daemon setup
and [Linux certificate trust](../guides/linux-certificate-trust.md) for distribution
and browser trust stores. These guides do not extend the prerelease bundle's
platform support described above.
Continue with [Getting started](getting-started.md).
