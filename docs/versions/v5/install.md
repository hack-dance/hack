# Install

## Prerequisites

The native prerelease needs Apple Silicon macOS, Python 3.9 or newer, and macOS codesign. Provider installation, routing and project adoption are separate steps. Compose execution additionally needs a running Docker-compatible engine with Compose. A cloud sandbox must supply its own supported runtime; installing the CLI alone does not provide one.

Download and inspect the installer from the selected published source tag:

```sh
curl --fail --location --proto '=https' --tlsv1.2 \
  https://raw.githubusercontent.com/hack-dance/hack/v5.0.0-next.5/scripts/install-prerelease.py \
  --output hack-next-install.py
# Inspect the downloaded script before executing it.
python3 hack-next-install.py install --version 5.0.0-next.5
```

Read [candidate installation](../guides/candidate-install.md) for verification,
retained versions and provider preparation. This installs the selected bundle;
it does not create an application environment.

The candidate is invoked explicitly:

```sh
"$HOME/.hack-next/bin/hack-next" --version
```

It uses the native backend by default. It leaves the stable Homebrew executable in place. Follow [Getting started](getting-started.md) to choose a runtime path.

## Prepare the native runtime

The published next.5 launcher enforces native selection. Setting
`HACK_RUNTIME_BACKEND=compose` before this launcher does not select Compose.
Choose v4 in Docs version for stable Compose installation and local routing.

For native use, follow [Native preparation](../guides/native-candidate.md) for the
provider, pinned image, source sharing and routing. Confirm the supported project
subset before adoption. DNS, trust and source-sharing changes require the native
approvals described there. Installation alone does not perform that preparation.
